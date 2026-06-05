# Firmware ESP32 — AquaBalancePro

Documentação completa do firmware embarcado para controle de bombas peristálticas em aquários marinhos.

## Stack Tecnológica

| Tecnologia | Versão | Função |
|---|---|---|
| **PlatformIO** | — | Sistema de build e gerenciamento de dependências |
| **Arduino Framework** | — | Camada de abstração de hardware |
| **ESP32-S3** | — | Microcontrolador (Xtensa LX7 dual-core) |
| **ESPAsyncWebServer** | 1.2.3 | Servidor HTTP assíncrono |
| **AsyncTCP-esphome** | 2.1.4 | Camada TCP assíncrona |
| **RTClib** | 2.1.4 | Driver do DS3231 RTC |
| **ArduinoJson** | 7.3.1 | Serialização/deserialização JSON |
| **Adafruit NeoPixel** | 1.12.0 | Driver do LED de status WS2812B |
| **LittleFS** | — | Sistema de arquivos em flash (logs) |
| **Preferences (NVS)** | — | Armazenamento não-volátil (config) |

## Hardware

### Pinagem

| GPIO | Função | Componente |
|---|---|---|
| 4 | `BOMBA1_PIN` | Bomba peristáltica 1 (HIGH = ligada) |
| 5 | `BOMBA2_PIN` | Bomba peristáltica 2 |
| 6 | `BOMBA3_PIN` | Bomba peristáltica 3 |
| 7 | `BOMBA4_PIN` | Bomba peristáltica 4 |
| 21 | `I2C_SDA` | DS3231 RTC — dados I2C |
| 20 | `I2C_SCL` | DS3231 RTC — clock I2C |
| 48 | `LED_PIN` | NeoPixel WS2812B — LED de status RGB |

### Esquema de Ligação

```
ESP32-S3                  DS3231 RTC
GPIO21 (SDA) ──────────── SDA
GPIO20 (SCL) ──────────── SCL
3.3V         ──────────── VCC
GND          ──────────── GND

ESP32-S3                  Bombas (via relé/MOSFET)
GPIO4        ──────────── Sinal da Bomba 1
GPIO5        ──────────── Sinal da Bomba 2
GPIO6        ──────────── Sinal da Bomba 3
GPIO7        ──────────── Sinal da Bomba 4

ESP32-S3                  NeoPixel WS2812B
GPIO48       ──[300Ω]──── DATA IN
5V           ──────────── VCC
GND          ──────────── GND
```

## Estrutura do Código

O firmware é **monolítico** em um único arquivo: `esp32/src/main.cpp` (1360 linhas).

### Mapa do Arquivo

| Linhas | Seção | Descrição |
|---|---|---|
| 1–12 | **Includes** | WiFi.h, AsyncTCP.h, ESPAsyncWebServer.h, RTClib.h, ArduinoJson.h, Adafruit_NeoPixel.h, LittleFS.h, Preferences.h, time.h |
| 14–32 | **Config Geral** | `TEMPO_POR_ML = 700` (ms/ml base), `BOMBA_COUNT = 4`, `SCHEDULE_COUNT = 3`, `PUMP_PINS[4] = {4,5,6,7}`, `MAX_PUMP_QUEUE = 14`, `CONFIG_DOC_SIZE = 10240`, `LOG_LIMIT = 300` |
| 34–43 | **WiFi** | `AP_SSID = "AquaBalancePro"`, `AP_PASSWORD = "12345678"`, `STA_SSID` e `STA_PASSWORD` (placeholder), `isStaConfigured()` |
| 45–49 | **Objetos Globais** | `RTC_DS3231 rtc`, `Preferences preferences`, `AsyncWebServer server(80)`, `Adafruit_NeoPixel statusLed` |
| 51–62 | **Controle** | Timers de WiFi e NTP, flag `timeSynced` |
| 64–84 | **Struct Schedule** | `hour`, `minute`, `dosagem`, `status`, `diasSemana[7]`, `lastRunMinute` |
| 86–103 | **Struct Bomb** | `name`, `calibrCoef`, `quantidadeEstoque`, `schedules[SCHEDULE_COUNT]` |
| 105 | **Bombas** | `bombas[BOMBA_COUNT]` — array global com as 4 bombas |
| 97–112 | **Fila de Bombas** | `PumpJob` (bombId, duration, startTime, origem, active), buffer circular com `head`/`tail`, mutex `pumpQueueMux` |
| 114–134 | **Flags + LED** | `rtcReady`, `prefsReady`, `fsReady`, `systemReady`, estado/modo/PWM do LED |
| 136–199 | **Forward Declarations** | Protótipos de todas as funções |
| 200–235 | **Helpers** | `formatTimestamp()`, `wifiStatusToString()`, `httpMethodToString()` |
| 236–244 | **System** | `shouldPauseForAp()` — verifica clientes conectados ao AP |
| 245–361 | **WiFi** | `onWiFiEvent()`, `setupWifi()`, `enableSta()`, `disableSta()`, `applyApPriority()`, `ensureStaWifi()`, `logWifiStatusChange()` |
| 363–387 | **NTP** | `ensureTimeSynced()` — sincronia via `configTime()` com timeout de 3s |
| 389–659 | **WebServer** | Handlers de todos os endpoints + CORS + 404 |
| 661–802 | **Logs (LittleFS)** | `initLogStorage()`, `countLogLines()`, `trimLogFile()`, `appendLocalLog()` |
| 804–1014 | **Config/JSON** | `inicializarBombas()`, `saveBombasConfig()`, `loadBombasConfig()`, `initDefaultBombasConfig()`, `buildConfigJson()`, `applyConfigJson()`, `parseBombData()`, `parseDateTime()` |
| 1016–1074 | **Scheduler** | `checkSchedules()` — executa uma vez por minuto real |
| 1076–1194 | **Pump Queue** | `enqueuePumpJob()`, `pumpPinForIndex()`, `finishPumpJob()`, `startNextPumpJob()`, `processPumpQueue()` |
| 1196–1291 | **LED** | `setLedColor()`, `updateLedMode()`, `updateStatusLed()` |
| 1293–1360 | **setup() + loop()** | Ponto de entrada e ciclo principal |

## Setup e Loop

### `setup()` — Ordem de Inicialização

```
1. Serial.begin(115200)
2. inicializarBombas()        → LOOP sobre PUMP_PINS[4] = {4,5,6,7} como OUTPUT, LOW
3. Wire.begin(21, 20)         → I2C para RTC
4. rtc.begin()                → DS3231 (flag rtcReady)
5. preferences.begin("bomb-config", false) → NVS (flag prefsReady)
6. loadBombasConfig()         → carrega ou cria defaults
7. initLogStorage()           → LittleFS mount, cria logs.jsonl, trim se necessário (flag fsReady)
8. systemReady = rtcReady && prefsReady
9. statusLed.begin()          → NeoPixel, brightness 30, cor vermelha (boot)
10. setupWifi()               → AP + STA simultâneos
11. Registrar rotas HTTP      → server.on(...)
12. server.begin()
13. applyApPriority()         → AP ativo → STA pausado
```

### `loop()` — Ciclo Principal (~100ms)

```
1. shouldPauseForAp()         → verifica clientes no AP
2. applyApPriority()          → pausa STA se AP ativo, reativa se não
3. ensureStaWifi()            → reconecta STA se desconectado (cooldown 15s)
4. ensureTimeSynced()         → tenta NTP a cada 60s (se WiFi + não pausado)
5. checkSchedules()           → avalia agendas 1x por minuto real
6. processPumpQueue()         → inicia ou monitora bomba ativa
7. updateStatusLed()          → máquina de estados do LED
8. logWifiStatusChange()      → loga mudanças de WiFi
9. delay(100)
```

## Rede

### Modos de Operação

O ESP32 opera em **modo AP + STA simultâneo** (WiFi Modo 3):

- **AP (Access Point):** `SSID: AquaBalancePro`, `IP: 192.168.4.1`. Sempre ativo. Permite que o app mobile se conecte diretamente.
- **STA (Station):** Conecta-se a uma rede Wi-Fi externa para NTP. Credenciais definidas em constantes de compilação.

### Priorização AP > STA

```
AP com clientes conectados → STA é desligado (maximiza performance para o app)
AP sem clientes            → STA é ligado (tenta NTP)
```

Controlado por `applyApPriority()`:
- `WiFi.softAPgetStationNum() > 0` → `disableSta()` (desliga STA)
- `WiFi.softAPgetStationNum() == 0` → `enableSta()` (religa STA, se configurado)

### Reconexão STA

`ensureStaWifi()`: se STA desconectado e cooldown de 15s já passou, chama `WiFi.reconnect()`.

## API REST

### Visão Geral

Servidor HTTP assíncrono na porta 80. CORS habilitado (`Access-Control-Allow-Origin: *`). Respostas em JSON.

### Endpoints

#### `GET /ping`

Health check simples.

**Resposta (200):**
```
pong
```

---

#### `GET /status`

Status completo do dispositivo.

**Resposta (200):**
```json
{
  "time": "05/06/2026 14:30:00",
  "wifi": {
    "connected": true,
    "rssi": -65,
    "ip": "192.168.1.100"
  },
  "ap": {
    "ssid": "AquaBalancePro",
    "ip": "192.168.4.1"
  }
}
```

---

#### `GET /config`

Configuração completa das 4 bombas.

**Resposta (200):**
```json
{
  "bomb1": {
    "name": "Cálcio",
    "calibrCoef": 1.0,
    "quantidadeEstoque": 950.0,
    "schedules": [
      {
        "id": 1,
        "time": { "hour": 8, "minute": 0 },
        "dosagem": 5.0,
        "status": true,
        "diasSemanaSelecionados": [true, true, true, true, true, false, false]
      },
      { "id": 2, "time": { "hour": 20, "minute": 0 }, "dosagem": 5.0, "status": true, "diasSemanaSelecionados": [true, true, true, true, true, false, false] },
      { "id": 3, "time": { "hour": 0, "minute": 0 }, "dosagem": 0.0, "status": false, "diasSemanaSelecionados": [false, false, false, false, false, false, false] }
    ]
  },
  "bomb2": { "...": "..." },
  "bomb3": { "...": "..." },
  "bomb4": { "...": "..." }
}
```

---

#### `POST /config`

Atualiza configuração das bombas.

**Request body:** Mesmo formato do GET /config (objeto com `bomb1`, `bomb2`, `bomb3`, `bomb4`).

**Resposta (200):**
```json
{ "ok": true, "message": "configuracao salva" }
```

**Resposta (400 — JSON inválido):**
```json
{ "ok": false, "message": "json invalido" }
```

**Processamento:**
1. Parsing do JSON com `ArduinoJson`
2. Para cada bomba (1 a 3): extrai nome, coeficiente, estoque, schedules
3. Atualiza array global `bombas[BOMBA_COUNT]` (4 slots)
4. Persiste via `saveBombasConfig()` (NVS)
5. Retorna `{ ok: true }`

---

#### `POST /time`

Sincroniza o RTC com a hora do celular.

**Request body:**
```json
{ "time": "05/06/2026 14:30:00" }
```

**Formato aceito:** `DD/MM/AAAA HH:mm:ss` (segundos opcionais).

**Resposta (200):**
```json
{ "ok": true, "message": "hora ajustada" }
```

**Processamento:**
1. Parseia a string com `parseDateTime()`
2. Ajusta o RTC via `rtc.adjust(DateTime(ano, mes, dia, hora, min, seg))`
3. Atualiza flag `timeSynced = true`

---

#### `POST /dose`

Comanda dosagem manual imediata.

**Request body:**
```json
{
  "bomb": 1,
  "dosagem": 10.5,
  "origem": "App"
}
```

| Campo | Tipo | Descrição |
|---|---|---|
| `bomb` | int | Índice da bomba (1–3) |
| `dosagem` | float | Volume em ml |
| `origem` | string | Identificador da origem (ex: "Teste", "Calibracao", "Programado") |

**Respostas:**

| Código | Body | Condição |
|---|---|---|
| 200 | `{ "ok": true }` | Dose enfileirada com sucesso |
| 400 | `{ "ok": false, "message": "..." }` | Parâmetros inválidos |
| 409 | `{ "ok": false, "message": "fila cheia" }` | Fila de bombas cheia (max 10) |

**Processamento:**
1. Valida bomb (1–4), dosagem (> 0)
2. Calcula duração: `tempo = dosagem * TEMPO_POR_ML * bombas[bombId].calibrCoef` (em ms)
3. `enqueuePumpJob(bombId, tempo, origem)` — insere na fila circular

---

#### `GET /logs`

Retorna histórico de dosagens.

**Resposta (200):**
```json
[
  {
    "bombaId": 1,
    "timestamp": "05/06/2026 14:30:00",
    "bomba": "Cálcio",
    "dosagem": 5.0,
    "origem": "Programado"
  },
  { "...": "..." }
]
```

Ou, no formato alternativo:
```json
{
  "logs": [ "...array acima..." ]
}
```

**Resposta (503 — LittleFS não disponível):**
```json
{ "ok": false, "message": "logs indisponiveis" }
```

---

#### `DELETE /logs`

Limpa todo o histórico.

**Resposta (200):**
```json
{ "ok": true, "message": "logs apagados" }
```

### Tratamento de Erros Comum

| Situação | HTTP Status | Resposta |
|---|---|---|
| Rota inexistente | 404 | `{ "ok": false, "message": "not found" }` |
| Corpo não enviado em POST | 400 | `{ "ok": false, "message": "corpo vazio" }` |
| JSON inválido | 400 | `{ "ok": false, "message": "json invalido" }` |
| Erro interno | 500 | `{ "ok": false, "message": "erro interno" }` |

## Persistência

### NVS Preferences (Configuração das Bombas)

- **Namespace:** `"bomb-config"`
- **Chave:** `"bombas"`
- **Formato:** String JSON (~2KB)
- **Inicialização:** `preferences.begin("bomb-config", false)`
- **Save:** `saveBombasConfig()` — serializa `bombas[BOMBA_COUNT]` como JSON e grava
- **Load:** `loadBombasConfig()` — lê JSON do NVS, deserializa, popula array. Inclui **migração automática**: se algum slot estiver vazio (ex: upgrade de 3→4 bombas), preenche com valores default
- **Default:** Se NVS vazio, `initDefaultBombasConfig()` cria:
  - Nomes: "Bomba 1", "Bomba 2", "Bomba 3", "Bomba 4"
  - `calibrCoef = 1.0`
  - `quantidadeEstoque = 1000.0`
  - Todos os 3 schedules desabilitados
- **Persistência automática:** Após cada dose executada, `saveBombasConfig()` é chamado para atualizar o estoque

### LittleFS (Logs)

- **Arquivo:** `/logs.jsonl`
- **Formato:** JSONL (uma linha JSON por entrada)
- **Limite:** `LOG_LIMIT = 300` entradas
- **Inicialização:** `initLogStorage()`:
  1. Monta LittleFS (`LittleFS.begin(false)`)
  2. Se falhar, formata (`LittleFS.format()`)
  3. Abre/cria `logs.jsonl`
  4. Conta linhas com `countLogLines()`
  5. Se > 300, executa `trimLogFile()` — remove as linhas mais antigas
- **Escrita:** `appendLocalLog()` — abre em modo append, escreve linha JSON, fecha
- **Formato da linha:**
  ```json
  {"bombaId":1,"timestamp":"05/06/2026 14:30:00","bomba":"Cálcio","dosagem":5.0,"origem":"Programado"}
  ```
- **Trim automático:** Ao adicionar log, se contagem > `LOG_LIMIT`, chama `trimLogFile()` que:
  1. Abre `logs.jsonl` para leitura
  2. Abre `logs.tmp` para escrita
  3. Escreve apenas as últimas `LOG_LIMIT` linhas
  4. Remove original, renomeia `.tmp`

## Dosing Engine

### Cálculo de Tempo

```
duração_ms = dosagem_ml × TEMPO_POR_ML × calibrCoef
```

Onde:
- `TEMPO_POR_ML = 700` (700ms para dosar 1ml com calibração padrão)
- `calibrCoef` é um fator de correção por bomba (ex: 0.95 se dosa 5% mais rápido que o esperado)

### Fila Circular de Bombas

```cpp
struct PumpJob {
  int bombId;           // 0-2
  unsigned long duration;  // duração em ms
  unsigned long startTime; // timestamp de início (preenchido ao iniciar)
  String origem;        // "Programado", "Teste", "Calibracao"
  bool active;          // true se está executando agora
};

PumpJob pumpQueue[MAX_PUMP_QUEUE];  // 10 slots
int head = 0, tail = 0;
portMUX_TYPE pumpQueueMux = portMUX_INITIALIZER_UNLOCKED;
```

**Produtor-Consumidor com Spinlock:**

- `enqueuePumpJob()` — insere no tail com proteção `portENTER_CRITICAL`. Retorna `false` se fila cheia.
- `processPumpQueue()` — consumidor chamado no loop:
  1. Se job ativo: verifica se `millis() - startTime >= duration`. Se sim, chama `finishPumpJob()`.
  2. Se nenhum job ativo: chama `startNextPumpJob()` (head++).
- `finishPumpJob()`: desliga GPIO, atualiza estoque, salva config, registra log.
- `startNextPumpJob()`: liga GPIO, registra startTime, marca active=true, atualiza LED.

**Regras:**
- Apenas **1 bomba por vez** (execução sequencial)
- Se fila cheia → `POST /dose` retorna **409 Conflict**
- Jobs não podem ser cancelados após iniciados

### Scheduler

```cpp
void checkSchedules() {
  if (!rtcReady || !systemReady) return;

  DateTime now = rtc.now();
  long currentMinuteKey = now.unixtime() / 60;

  if (currentMinuteKey == lastSchedulerMinuteKey) return; // já executou este minuto
  lastSchedulerMinuteKey = currentMinuteKey;

  for (int b = 0; b < BOMBA_COUNT; b++) {
    for (int s = 0; s < SCHEDULE_COUNT; s++) {
      Schedule &sch = bombas[b].schedules[s];
      if (!sch.status) continue;
      if (!sch.diasSemana[now.dayOfTheWeek()]) continue;
      if (sch.hour != now.hour() || sch.minute != now.minute()) continue;

      enqueuePumpJob(b, sch.dosagem * TEMPO_POR_ML * bombas[b].calibrCoef, "Programado");
      sch.lastRunMinute = currentMinuteKey;
    }
  }
}
```

**Características:**
- Executa **1 vez por minuto real** (controlado por `lastSchedulerMinuteKey`)
- Previne disparo duplicado mesmo se `loop()` executar múltiplas vezes no mesmo minuto
- Verifica: schedule ativo → dia da semana → hora/minuto
- Origem do log: `"Programado"`
- Perde o disparo se o minuto for pulado (ESP32 reiniciou, por exemplo)

## LED de Status — NeoPixel WS2812B

### Estados

| Modo | Cor | Comportamento | Quando |
|---|---|---|---|
| `BOOT` | Vermelho | Fixo | `systemReady == false` (RTC ou NVS falhou) |
| `READY` | Roxo | Fixo | Sistema OK, WiFi STA conectado ou AP ocupado |
| `NO_NET` | Roxo | Piscando (5s aceso, 150ms apagado) | Sistema OK, mas sem WiFi externo e sem clientes no AP |
| `DOSING` | Azul | Fixo | Bomba em operação (volta ao estado anterior ao terminar) |

### Implementação

```cpp
enum LedMode { BOOT, READY, NO_NET, DOSING };
LedMode currentLedMode = BOOT;

void updateStatusLed() {
  switch (currentLedMode) {
    case BOOT:   setLedColor(255, 0, 0); break;           // Vermelho
    case READY:  setLedColor(128, 0, 255); break;         // Roxo
    case NO_NET: setLedColor(128 * blinkState, 0, 255 * blinkState); break; // Roxo piscando
    case DOSING: setLedColor(0, 0, 255); break;           // Azul
  }
}
```

`updateLedMode()` define o modo baseado nas flags do sistema e é chamado sempre que há mudança de estado (WiFi conecta/desconecta, job inicia/termina).

## Tratamento de Erros

| Cenário | Ação |
|---|---|
| **RTC não encontrado** (DS3231 ausente/falho) | `rtcReady = false`. Scheduler não executa. LED vermelho fixo. Sistema parcial. |
| **NVS falha** | `prefsReady = false`. Config default usada em RAM, não persiste. |
| **LittleFS não monta** | `fsReady = false`. Logs não são salvos. GET /logs retorna 503. |
| **POST sem corpo** | Handler retorna 400. |
| **JSON inválido** | `deserializeJson()` falha → 400 com mensagem. |
| **Fila de bombas cheia** | POST /dose retorna 409. |
| **WiFi STA desconecta** | Reconexão automática a cada 15s. AP nunca desliga. |
| **NTP falha** | Retenta a cada 60s. Timeout de 3s (não bloqueia o loop). |
| **Log > 300 linhas** | Trim automático (remove as mais antigas). |
| **Alocação de memória falha** | Request HTTP é ignorado, erro logado no serial. |

## Segurança

- **AP Password:** `"12345678"` — fraca, alterável em compilação
- **STA Credentials:** Placeholders em constantes de compilação
- **Autenticação:** Nenhuma nos endpoints REST
- **Criptografia:** Nenhuma (HTTP puro, sem HTTPS)
- **CORS:** `Access-Control-Allow-Origin: *` (permite qualquer origem)

## Configuração de Build

### `platformio.ini`

```ini
[env:upesy_wroom]
platform = espressif32
board = upesy_wroom
framework = arduino
board_build.partitions = huge_app.csv
monitor_speed = 115200
upload_speed = 921600
lib_deps =
    adafruit/RTClib @ ^2.1.4
    bblanchon/ArduinoJson @ ^7.3.1
    mobizt/Firebase Arduino Client Library for ESP8266 and ESP32 @ ^4.4.17
    zeed/ESP Async WebServer @ 1.2.3
    esphome/AsyncTCP-esphome @ ^2.1.4
    adafruit/Adafruit NeoPixel @ ^1.12.0
```

**Board:** `upesy_wroom` (ESP32-S3 devkit)
**Partition scheme:** `huge_app.csv` (máximo espaço para app, LittleFS em partição dedicada)

### Constantes Ajustáveis (`main.cpp`)

```cpp
constexpr int TEMPO_POR_ML = 700;         // ms para dosar 1ml (base)
constexpr int BOMBA_COUNT = 4;            // número de bombas
constexpr int SCHEDULE_COUNT = 3;         // schedules por bomba
constexpr int MAX_PUMP_QUEUE = 14;        // tamanho da fila circular
constexpr int LOG_LIMIT = 300;            // máximo de linhas no arquivo de log
constexpr unsigned long WIFI_COOLDOWN_MS = 15000;   // intervalo entre tentativas de reconexão STA
constexpr unsigned long NTP_INTERVAL_MS = 60000;    // intervalo entre tentativas NTP
constexpr int NTP_TIMEOUT_SEC = 3;        // timeout da chamada NTP
constexpr long GMT_OFFSET_SEC = -3 * 3600;          // UTC-3 (BRT)
```

## Dependências (Bibliotecas)

| Biblioteca | Versão | Propósito | Uso no código |
|---|---|---|---|
| `RTClib` | 2.1.4 | Driver DS3231 via I2C | `rtc.begin()`, `rtc.now()`, `rtc.adjust()` |
| `ArduinoJson` | 7.3.1 | Serialização JSON | `JsonDocument`, `serializeJson()`, `deserializeJson()` |
| `ESP Async WebServer` | 1.2.3 | Servidor HTTP assíncrono | `server.on()`, `request->send()`, handlers |
| `AsyncTCP-esphome` | 2.1.4 | TCP assíncrono para ESP32 | Dependência do WebServer |
| `Adafruit NeoPixel` | 1.12.0 | Driver WS2812B | `statusLed.setPixelColor()`, `statusLed.show()` |
| `Firebase...` | 4.4.17 | Firebase (NÃO USADO) | Apenas em `lib_deps`, sem include no código |
| `WiFi.h` | built-in | Conectividade Wi-Fi | `WiFi.mode()`, `WiFi.softAP()`, `WiFi.begin()` |
| `Preferences.h` | built-in | NVS storage | `preferences.getString()`, `preferences.putString()` |
| `LittleFS.h` | built-in | Sistema de arquivos | `LittleFS.open()`, `LittleFS.begin()`, `LittleFS.format()` |
| `Wire.h` | built-in | I2C | `Wire.begin()` (usado pelo RTClib) |
| `time.h` | built-in | POSIX time/NTP | `configTime()`, `getLocalTime()`, `time(nullptr)` |

## Não Implementado

| Funcionalidade | Observação |
|---|---|
| **OTA Update** | Código não inclui `ArduinoOTA.h` ou qualquer mecanismo de atualização over-the-air |
| **Firebase/Cloud** | Biblioteca incluída no `platformio.ini` mas sem nenhum `#include` ou uso no `main.cpp` |
| **Sensores** | Nenhum sensor analógico ou digital (fluxo, temperatura, nível, pH) |
| **Display** | Sem LCD/OLED |
| **Bluetooth/BLE** | Sem Bluetooth provisioning (WiFiManager, SmartConfig) |
| **Botões físicos** | Sem entrada do usuário via hardware |
| **Watchdog** | Sem `esp_task_wdt_init()` ou HW watchdog |
| **mDNS** | Biblioteca no include path mas não implementada |
| **Deep Sleep** | Sistema sempre ligado (mains-powered) |
| **Horário de Verão** | `daylightOffsetSec = 0` — sem ajuste sazonal |
| **Versão do Firmware** | Sem endpoint `/version` ou macro de versão |
| **Autenticação** | Nenhuma senha nos endpoints REST |

## Performance e Limitações

| Aspecto | Detalhe |
|---|---|
| **Ciclo do loop** | ~100ms (delay(100) no final) |
| **Consumo** | Sem deep sleep, esperado ~200-300mA com bombas desligadas |
| **WiFi Sleep** | Desabilitado (`WiFi.setSleep(false)`) — prioriza latência |
| **Fila de bombas** | Máximo 10 jobs simultâneos na fila |
| **Logs** | Máximo 300 entradas no LittleFS (~15KB) |
| **Config JSON** | Documento de até 8192 bytes (`CONFIG_DOC_SIZE`) |
| **NTP Timeout** | 3 segundos (não bloqueia loop) |
| **I2C Speed** | Padrão (100kHz) |
| **Precisão de dosagem** | Dependente da calibração e da bomba peristáltica |

## Offline First

O firmware é projetado para operação **100% offline** (sem dependência de internet ou cloud):

- RTC local mantém a hora (bateria CR2032 no DS3231)
- Scheduler executa baseado no RTC, independente de WiFi
- Logs são salvos localmente no LittleFS
- AP sempre ativo para controle local via app
- POST /dose funciona mesmo sem WiFi externo
- NTP é apenas para conveniência (ajuste inicial do RTC)

Consulte [`ROBUSTEZ_OFFLINE.md`](../esp32/ROBUSTEZ_OFFLINE.md) para detalhes completos sobre estratégias de resiliência.

## Guia de Desenvolvimento

### Primeira Compilação

```bash
cd esp32
platformio run --target upload    # Compilar e enviar via USB
platformio device monitor -b 115200  # Monitor serial
```

### Credenciais Wi-Fi (STA)

Editar em `src/main.cpp`:
```cpp
const char *STA_SSID = "MinhaRede";
const char *STA_PASSWORD = "MinhaSenha";
```

### Limpar NVS (Resetar Config)

Enviar comando via serial:
```
(Remover a bateria do RTC e apagar flash via PlatformIO)
platformio run --target erase
```

### Testar API

```bash
# Health check
curl http://192.168.4.1/ping

# Status
curl http://192.168.4.1/status

# Dose manual
curl -X POST http://192.168.4.1/dose \
  -H "Content-Type: application/json" \
  -d '{"bomb": 1, "dosagem": 5.0, "origem": "Teste"}'

# Sincronizar hora
curl -X POST http://192.168.4.1/time \
  -H "Content-Type: application/json" \
  -d '{"time": "05/06/2026 14:30:00"}'
```
