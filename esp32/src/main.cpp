#include <Arduino.h>
#include <Wire.h>
#include <RTClib.h>
#include <WiFi.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <ArduinoJson.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <Adafruit_NeoPixel.h>
#include <time.h>

// --- Configurações Gerais ---
#define TEMPO_POR_ML 700
#define BOMBA1_PIN 4
#define BOMBA2_PIN 5
#define BOMBA3_PIN 6
#define BOMBA4_PIN 7
#define LED_PIN 48
#define LED_COUNT 1
#define I2C_SDA 21
#define I2C_SCL 20

#define BOMBA_COUNT 4
#define SCHEDULE_COUNT 3
#define MAX_PUMP_QUEUE 14
#define CONFIG_DOC_SIZE 10240
#define LOG_LIMIT 300
#define LOG_FILE "/logs.jsonl"
#define LOG_TEMP_FILE "/logs.tmp"

// --- Relés ---
#define RELE1_PIN 8
#define RELE2_PIN 9
#define RELE3_PIN 10
#define RELE4_PIN 11
#define RELAY_COUNT 4
#define MAX_RULES 6
// Módulo ativo-baixo + equipamento no contato NC:
//   equipamento LIGADO    = relé desenergizado = GPIO HIGH
//   equipamento DESLIGADO = relé energizado    = GPIO LOW
// Se na bancada o comportamento sair invertido, troque apenas estas duas linhas.
#define RELAY_LEVEL_EQUIP_ON HIGH
#define RELAY_LEVEL_EQUIP_OFF LOW

const uint8_t PUMP_PINS[BOMBA_COUNT] = {BOMBA1_PIN, BOMBA2_PIN, BOMBA3_PIN, BOMBA4_PIN};

// --- Wi-Fi ---
const char *AP_SSID = "AquaBalancePro";
const char *AP_PASSWORD = "12345678";

// Preencha com seus dados (não publique credenciais em repositório)
const char *STA_SSID = "<SEU_SSID>";
const char *STA_PASSWORD = "<SUA_SENHA>";
constexpr bool kApOnlyMode = false;

bool isStaConfigured()
{
  return !kApOnlyMode &&
         strcmp(STA_SSID, "<SEU_SSID>") != 0 &&
         strlen(STA_SSID) > 0;
}

// --- Objetos Globais ---
RTC_DS3231 rtc;
Preferences preferences;
AsyncWebServer server(80);
Adafruit_NeoPixel statusLed(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

// --- Variáveis de Controle ---
unsigned long lastWifiAttempt = 0;
const unsigned long wifiReconnectInterval = 15000;

volatile uint8_t apClientCount = 0;
bool staEnabled = false;

unsigned long lastTimeSyncAttempt = 0;
const unsigned long timeSyncInterval = 60000;
bool timeSynced = false;
const long gmtOffsetSec = -3 * 3600;
const int daylightOffsetSec = 0;

// --- Estruturas ---
struct Schedule
{
  int hour;
  int minute;
  float dosagem;
  bool status;
  bool diasSemana[7];
  long lastRunMinute;

  Schedule()
  {
    hour = 0;
    minute = 0;
    dosagem = 0;
    status = false;
    lastRunMinute = -1;
    for (int i = 0; i < 7; i++)
      diasSemana[i] = false;
  }
};

struct Bomb
{
  String name;
  float calibrCoef;
  float quantidadeEstoque;
  Schedule schedules[SCHEDULE_COUNT];

  Bomb()
  {
    name = "";
    calibrCoef = 1.0f;
    quantidadeEstoque = 0.0f;
  }
};

Bomb bombas[BOMBA_COUNT];

struct PumpJob
{
  int bombaIndex;
  float dosagem;
  String origem;
  DateTime timestamp;
};

struct RuleAction
{
  uint8_t targetRelay;       // 0-3 interno
  bool turnOff;              // true = desliga o equipamento ao disparar
  unsigned long durationSec; // 0 = sem timer (permanente)
};

struct RelayRule
{
  uint8_t triggerPumpId; // 0-3 interno
  RuleAction actions[4];
  uint8_t actionCount;
  bool enabled;
  String name;
};

PumpJob pumpQueue[MAX_PUMP_QUEUE];
volatile int pumpHead = 0;
volatile int pumpTail = 0;
bool pumpActive = false;
PumpJob activeJob;
unsigned long pumpStartTime = 0;
unsigned long pumpDuration = 0;
portMUX_TYPE pumpQueueMux = portMUX_INITIALIZER_UNLOCKED;

RelayRule rules[MAX_RULES];
uint8_t ruleCount = 0;
bool relayStates[RELAY_COUNT] = {true, true, true, true}; // estado do EQUIPAMENTO (true = ligado)
unsigned long relayTimers[RELAY_COUNT] = {0, 0, 0, 0};
const char *relayNames[RELAY_COUNT] = {"Rele 1", "Rele 2", "Rele 3", "Rele 4"};
Preferences relayPrefs;

bool rtcReady = false;
bool prefsReady = false;
bool fsReady = false;
bool systemReady = false;
size_t logCount = 0;

enum LedMode
{
  LED_MODE_BOOT,
  LED_MODE_READY,
  LED_MODE_NO_NET,
  LED_MODE_DOSING
};

LedMode ledMode = LED_MODE_BOOT;
unsigned long ledLastToggle = 0;
bool ledBlinkOn = true;
unsigned long noNetBlinkStart = 0;
unsigned long lastNoNetBlink = 0;
bool noNetBlinkActive = false;
uint32_t currentLedColor = 0;

// =========================================================
// Forward declarations
// =========================================================
String formatTimestamp(const DateTime &now);
const char *wifiStatusToString(wl_status_t status);
const char *httpMethodToString(WebRequestMethodComposite method);

// WiFi / sistema
void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info);
bool shouldPauseForAp();
void applyApPriority();
void enableSta();
void disableSta();
void setupWifi();
void ensureStaWifi();
void ensureApIsUp();

// Tempo / NTP
void ensureTimeSynced();

// Server
void setupServer();
void handleStatus(AsyncWebServerRequest *request);
void handleGetConfig(AsyncWebServerRequest *request);
void handlePostConfig(AsyncWebServerRequest *request);
void handlePostTime(AsyncWebServerRequest *request);
void handlePostDose(AsyncWebServerRequest *request);
void handleGetLogs(AsyncWebServerRequest *request);
void handleDeleteLogs(AsyncWebServerRequest *request);
void storeRequestBody(AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total);
bool readRequestBody(AsyncWebServerRequest *request, String &body);

// Relés / Regras
void inicializarRele();
int relayPinForIndex(int i);
void writeRelay(int i, bool equipOn);
void handleGetRelays(AsyncWebServerRequest *request);
void handlePostRelay(AsyncWebServerRequest *request);
void handleGetRules(AsyncWebServerRequest *request);
void handlePostRules(AsyncWebServerRequest *request);
void applyRulesForPump(int bombaIndex);
void checkRelayTimers();
void saveRelayConfig();
void loadRelayConfig();
String buildRulesJson();
bool applyRulesJson(const String &json);

// Config / JSON
void inicializarBombas();
void saveBombasConfig();
void loadBombasConfig();
void initDefaultBombasConfig();
String buildConfigJson();
bool applyConfigJson(const String &json);
void parseBombData(int i, JsonObject bomba);
bool parseDateTime(const String &value, DateTime &output);
void resetSchedule(Schedule &schedule);

// Logs locais
bool initLogStorage();
size_t countLogLines(File &file);
bool trimLogFile(size_t removeCount);
void appendLocalLog(int bombaIndex, float dosagem, const String &origem, const DateTime &timestamp);

// Scheduler
void checkSchedules();

// Pump queue
bool enqueuePumpJob(int bombaIndex, float dosagem, const String &origem);
int pumpPinForIndex(int bombaIndex);
void processPumpQueue();
void startNextPumpJob();
void finishPumpJob();

// LED
void setLedColor(uint8_t red, uint8_t green, uint8_t blue);
void updateLedMode(LedMode mode);
void updateStatusLed();
void logWifiStatusChange();

// =========================================================
// Helpers
// =========================================================
String formatTimestamp(const DateTime &now)
{
  char buffer[20];
  snprintf(buffer, sizeof(buffer), "%02d/%02d/%04d %02d:%02d",
           now.day(), now.month(), now.year(), now.hour(), now.minute());
  return String(buffer);
}

const char *wifiStatusToString(wl_status_t status)
{
  switch (status)
  {
  case WL_IDLE_STATUS:      return "idle";
  case WL_NO_SSID_AVAIL:    return "no ssid";
  case WL_SCAN_COMPLETED:   return "scan completed";
  case WL_CONNECTED:        return "connected";
  case WL_CONNECT_FAILED:   return "connect failed";
  case WL_CONNECTION_LOST:  return "connection lost";
  case WL_DISCONNECTED:     return "disconnected";
  default:                  return "unknown";
  }
}

const char *httpMethodToString(WebRequestMethodComposite method)
{
  if (method & HTTP_GET) return "GET";
  if (method & HTTP_POST) return "POST";
  if (method & HTTP_PUT) return "PUT";
  if (method & HTTP_DELETE) return "DELETE";
  if (method & HTTP_OPTIONS) return "OPTIONS";
  return "OTHER";
}

// =========================================================
// Estado do sistema
// =========================================================
bool shouldPauseForAp()
{
  return kApOnlyMode || apClientCount > 0;
}

// =========================================================
// Wi-Fi
// =========================================================
void onWiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info)
{
  switch (event)
  {
  case ARDUINO_EVENT_WIFI_STA_START:
    Serial.println("[wifi] Evento: STA Start");
    break;

  case ARDUINO_EVENT_WIFI_STA_CONNECTED:
    Serial.println("[wifi] Evento: STA Conectado ao AP");
    break;

  case ARDUINO_EVENT_WIFI_STA_GOT_IP:
  {
    IPAddress ip(info.got_ip.ip_info.ip.addr);
    Serial.printf("[wifi] Evento: STA Ganhou IP: %s\n", ip.toString().c_str());
    break;
  }

  case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
    Serial.printf("[wifi] Evento: STA Desconectado. Motivo: %d\n",
                  info.wifi_sta_disconnected.reason);
    break;

  case ARDUINO_EVENT_WIFI_AP_STACONNECTED:
    apClientCount++;
    Serial.printf("[wifi] Evento: Cliente conectou no AP Proprio (Total: %u)\n", apClientCount);
    break;

  case ARDUINO_EVENT_WIFI_AP_STADISCONNECTED:
    if (apClientCount > 0) apClientCount--;
    Serial.printf("[wifi] Evento: Cliente desconectou do AP Proprio (Total: %u)\n", apClientCount);
    break;

  default:
    break;
  }
}

void setupWifi()
{
  WiFi.onEvent(onWiFiEvent);
  WiFi.mode(isStaConfigured() ? WIFI_AP_STA : WIFI_AP);
  WiFi.setSleep(false);

  WiFi.softAPConfig(IPAddress(192, 168, 4, 1),
                    IPAddress(192, 168, 4, 1),
                    IPAddress(255, 255, 255, 0));

  WiFi.softAP(AP_SSID, AP_PASSWORD);
  Serial.printf("[wifi] AP Iniciado: %s (%s)\n", AP_SSID, WiFi.softAPIP().toString().c_str());

  staEnabled = false;
}

void enableSta()
{
  if (staEnabled) return;
  if (!isStaConfigured()) return;
  WiFi.persistent(false);
  WiFi.begin(STA_SSID, STA_PASSWORD);
  Serial.printf("[wifi] STA Habilitado. Tentando: %s\n", STA_SSID);
  staEnabled = true;
}

void disableSta()
{
  if (!staEnabled) return;
  if (!isStaConfigured()) return;
  Serial.println("[wifi] STA Pausado (Cliente AP detectado)");
  WiFi.setAutoReconnect(false);
  WiFi.disconnect();
  staEnabled = false;
}

void applyApPriority()
{
  if (shouldPauseForAp())
  {
    disableSta();
    return;
  }
  enableSta();
}

void ensureStaWifi()
{
  if (!isStaConfigured()) return;
  if (shouldPauseForAp()) return;
  if (!staEnabled) return;
  if (WiFi.status() == WL_CONNECTED) return;
  if (apClientCount > 0) return;

  if (millis() - lastWifiAttempt < wifiReconnectInterval) return;

  lastWifiAttempt = millis();
  Serial.printf("[wifi] Tentando reconectar STA: %s...\n", STA_SSID);
  WiFi.reconnect();
}

void ensureApIsUp()
{
  if (WiFi.softAPIP().toString() == "0.0.0.0")
  {
    Serial.println("[wifi] AP caiu! Reiniciando AP...");
    WiFi.softAPConfig(IPAddress(192, 168, 4, 1),
                      IPAddress(192, 168, 4, 1),
                      IPAddress(255, 255, 255, 0));
    WiFi.softAP(AP_SSID, AP_PASSWORD);
  }
}

void logWifiStatusChange()
{
  static wl_status_t lastStatus = (wl_status_t)-1;
  wl_status_t status = WiFi.status();
  if (status == lastStatus) return;

  lastStatus = status;
  Serial.printf("[wifi] Status alterado: %s\n", wifiStatusToString(status));

  if (status == WL_CONNECTED)
  {
    Serial.printf("[wifi] CONECTADO! IP: %s, RSSI: %d dBm\n",
                  WiFi.localIP().toString().c_str(),
                  WiFi.RSSI());
  }
}

// =========================================================
// Tempo / NTP
// =========================================================
void ensureTimeSynced()
{
  if (timeSynced || WiFi.status() != WL_CONNECTED) return;
  if (!isStaConfigured()) return;
  if (shouldPauseForAp()) return;
  if (millis() - lastTimeSyncAttempt < timeSyncInterval) return;

  lastTimeSyncAttempt = millis();
  Serial.println("[time] Tentando sincronizar via NTP...");
  configTime(gmtOffsetSec, daylightOffsetSec, "pool.ntp.org", "time.nist.gov");

  struct tm timeinfo;
  if (getLocalTime(&timeinfo, 5000))
  {
    timeSynced = true;
    Serial.printf("[time] Sincronizado com sucesso! Data: %02d/%02d/%04d %02d:%02d:%02d\n",
                  timeinfo.tm_mday, timeinfo.tm_mon + 1, timeinfo.tm_year + 1900,
                  timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
  }
  else
  {
    Serial.println("[time] Falha na sincronizacao NTP");
  }
}

// =========================================================
// WebServer
// =========================================================
void handleStatus(AsyncWebServerRequest *request)
{
  Serial.println("[http] Recebido: GET /status");
  JsonDocument doc;

  DateTime now = rtc.now();
  doc["time"] = formatTimestamp(now);

  JsonObject wifi = doc["wifi"].to<JsonObject>();
  wifi["connected"] = (WiFi.status() == WL_CONNECTED);
  wifi["rssi"] = (WiFi.status() == WL_CONNECTED) ? WiFi.RSSI() : 0;
  wifi["ip"] = (WiFi.status() == WL_CONNECTED) ? WiFi.localIP().toString() : "";

  JsonObject ap = doc["ap"].to<JsonObject>();
  ap["ssid"] = AP_SSID;
  ap["ip"] = WiFi.softAPIP().toString();

  String payload;
  serializeJson(doc, payload);
  request->send(200, "application/json", payload);
}

void handleGetConfig(AsyncWebServerRequest *request)
{
  Serial.println("[http] Recebido: GET /config");
  request->send(200, "application/json", buildConfigJson());
}

void handlePostConfig(AsyncWebServerRequest *request)
{
  Serial.println("[http] Recebido: POST /config");

  String body;
  if (!readRequestBody(request, body))
  {
    Serial.println("[http] ERRO: Body ausente em /config");
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"body ausente\"}");
    return;
  }

  Serial.printf("[http] Body recebido: %s\n", body.c_str());

  bool ok = applyConfigJson(body);
  if (ok)
  {
    Serial.println("[http] Config aplicada com sucesso.");
    request->send(200, "application/json", "{\"ok\":true}");
  }
  else
  {
    Serial.println("[http] Falha ao aplicar config.");
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"json invalido\"}");
  }
}

void handlePostTime(AsyncWebServerRequest *request)
{
  Serial.println("[http] Recebido: POST /time");
  String body;

  if (!readRequestBody(request, body))
  {
    Serial.println("[http] ERRO: Body ausente em /time");
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"body ausente\"}");
    return;
  }

  Serial.printf("[http] Body recebido: %s\n", body.c_str());

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, body);
  if (error)
  {
    Serial.println("[http] JSON Invalido em /time");
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"json invalido\"}");
    return;
  }

  String timeString = doc["time"].as<String>();
  Serial.printf("[http] String de tempo recebida: %s\n", timeString.c_str());

  DateTime parsed;
  if (!parseDateTime(timeString, parsed))
  {
    Serial.println("[http] Formato de data invalido");
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"formato de data invalido\"}");
    return;
  }

  rtc.adjust(parsed);
  Serial.println("[http] Horario do RTC atualizado com sucesso.");
  request->send(200, "application/json", "{\"ok\":true}");
}

void handlePostDose(AsyncWebServerRequest *request)
{
  Serial.println("[http] Recebido: POST /dose");
  String body;

  if (!readRequestBody(request, body))
  {
    Serial.println("[http] ERRO: Body ausente em /dose");
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"body ausente\"}");
    return;
  }

  Serial.printf("[http] Body recebido: %s\n", body.c_str());

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, body);
  if (error)
  {
    Serial.println("[http] JSON Invalido em /dose");
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"json invalido\"}");
    return;
  }

  int bomba = doc["bomb"] | 0;
  float dosagem = doc["dosagem"] | 0.0f;
  String origem = doc["origem"] | "Teste";

  if (bomba < 1 || bomba > BOMBA_COUNT || dosagem <= 0)
  {
    Serial.println("[http] Dados invalidos para dosagem");
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"dados invalidos\"}");
    return;
  }

  Serial.printf("[http] Solicitacao valida: Bomba %d, %.2f ml\n", bomba, dosagem);

  bool queued = enqueuePumpJob(bomba - 1, dosagem, origem);
  if (!queued)
  {
    request->send(409, "application/json", "{\"ok\":false,\"message\":\"fila cheia\"}");
    return;
  }

  request->send(200, "application/json", "{\"ok\":true}");
}

void handleGetLogs(AsyncWebServerRequest *request)
{
  Serial.println("[http] Recebido: GET /logs");
  if (!fsReady)
  {
    request->send(503, "application/json", "{\"ok\":false,\"message\":\"filesystem indisponivel\"}");
    return;
  }

  if (!LittleFS.exists(LOG_FILE))
  {
    request->send(200, "application/json", "[]");
    return;
  }

  File file = LittleFS.open(LOG_FILE, FILE_READ);
  if (!file)
  {
    request->send(500, "application/json", "{\"ok\":false,\"message\":\"falha ao abrir logs\"}");
    return;
  }

  AsyncResponseStream *response = request->beginResponseStream("application/json");
  response->print("[");
  bool first = true;

  while (file.available())
  {
    String line = file.readStringUntil('\n');
    line.trim();
    if (line.isEmpty()) continue;
    if (!first) response->print(",");
    response->print(line);
    first = false;
  }

  response->print("]");
  file.close();
  request->send(response);
}

void handleDeleteLogs(AsyncWebServerRequest *request)
{
  Serial.println("[http] Recebido: DELETE /logs");
  if (!fsReady)
  {
    request->send(503, "application/json", "{\"ok\":false,\"message\":\"filesystem indisponivel\"}");
    return;
  }

  if (LittleFS.exists(LOG_FILE))
    LittleFS.remove(LOG_FILE);

  logCount = 0;
  request->send(200, "application/json", "{\"ok\":true}");
}

// =========================================================
// Relés / Regras — JSON, persistência, endpoints e motor
// =========================================================
String buildRulesJson()
{
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  for (int r = 0; r < ruleCount; r++)
  {
    JsonObject ro = arr.add<JsonObject>();
    ro["name"] = rules[r].name;
    ro["triggerPumpId"] = rules[r].triggerPumpId + 1; // 1-based na API
    ro["enabled"] = rules[r].enabled;

    JsonArray acts = ro["actions"].to<JsonArray>();
    for (int a = 0; a < rules[r].actionCount; a++)
    {
      JsonObject ao = acts.add<JsonObject>();
      ao["targetRelay"] = rules[r].actions[a].targetRelay + 1; // 1-based
      ao["turnOff"] = rules[r].actions[a].turnOff;
      ao["durationSec"] = rules[r].actions[a].durationSec;
    }
  }
  String out;
  serializeJson(doc, out);
  return out;
}

bool applyRulesJson(const String &json)
{
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, json);
  if (error || !doc.is<JsonArray>()) return false;

  uint8_t count = 0;
  for (JsonObject ro : doc.as<JsonArray>())
  {
    if (count >= MAX_RULES) break;
    RelayRule &rule = rules[count];

    rule.name = ro["name"] | "";

    int trig = (int)(ro["triggerPumpId"] | 1) - 1; // 1-based -> 0-based
    if (trig < 0) trig = 0;
    if (trig >= BOMBA_COUNT) trig = BOMBA_COUNT - 1;
    rule.triggerPumpId = (uint8_t)trig;

    rule.enabled = ro["enabled"] | true;
    rule.actionCount = 0;

    if (ro["actions"].is<JsonArray>())
    {
      for (JsonObject ao : ro["actions"].as<JsonArray>())
      {
        if (rule.actionCount >= 4) break;
        RuleAction &act = rule.actions[rule.actionCount];

        int tgt = (int)(ao["targetRelay"] | 1) - 1; // 1-based -> 0-based
        if (tgt < 0) tgt = 0;
        if (tgt >= RELAY_COUNT) tgt = RELAY_COUNT - 1;
        act.targetRelay = (uint8_t)tgt;

        act.turnOff = ao["turnOff"] | true;
        act.durationSec = ao["durationSec"] | 0UL;
        rule.actionCount++;
      }
    }
    count++;
  }
  ruleCount = count;
  return true;
}

void saveRelayConfig()
{
  Serial.println("[relay] Salvando regras (Preferences)...");
  relayPrefs.putString("rules", buildRulesJson());
}

void loadRelayConfig()
{
  String json = relayPrefs.getString("rules", "");
  if (json.isEmpty())
  {
    ruleCount = 0;
    Serial.println("[relay] Nenhuma regra salva.");
    return;
  }
  if (!applyRulesJson(json))
  {
    ruleCount = 0;
    Serial.println("[relay] ERRO ao ler regras salvas.");
  }
  else
  {
    Serial.printf("[relay] %d regra(s) carregada(s).\n", ruleCount);
  }
}

void handleGetRelays(AsyncWebServerRequest *request)
{
  Serial.println("[http] Recebido: GET /relays");
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  unsigned long now = millis();

  for (int i = 0; i < RELAY_COUNT; i++)
  {
    JsonObject o = arr.add<JsonObject>();
    o["id"] = i + 1;
    o["name"] = relayNames[i];
    o["state"] = relayStates[i];

    unsigned long remaining = 0;
    if (relayTimers[i] != 0 && relayTimers[i] > now)
      remaining = (relayTimers[i] - now) / 1000UL;
    o["timerRemaining"] = remaining;
  }

  String payload;
  serializeJson(doc, payload);
  request->send(200, "application/json", payload);
}

void handlePostRelay(AsyncWebServerRequest *request)
{
  Serial.println("[http] Recebido: POST /relay");
  String body;
  if (!readRequestBody(request, body))
  {
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"body ausente\"}");
    return;
  }

  JsonDocument doc;
  if (deserializeJson(doc, body))
  {
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"json invalido\"}");
    return;
  }

  int id = doc["id"] | 0;
  bool state = doc["state"] | false;
  if (id < 1 || id > RELAY_COUNT)
  {
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"id invalido\"}");
    return;
  }

  int idx = id - 1;
  writeRelay(idx, state);
  relayTimers[idx] = 0; // manual vence o timer
  Serial.printf("[relay] Manual: rele %d -> %s\n", id, state ? "LIGADO" : "DESLIGADO");
  request->send(200, "application/json", "{\"ok\":true}");
}

void handleGetRules(AsyncWebServerRequest *request)
{
  Serial.println("[http] Recebido: GET /rules");
  request->send(200, "application/json", buildRulesJson());
}

void handlePostRules(AsyncWebServerRequest *request)
{
  Serial.println("[http] Recebido: POST /rules");
  String body;
  if (!readRequestBody(request, body))
  {
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"body ausente\"}");
    return;
  }

  if (!applyRulesJson(body))
  {
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"json invalido\"}");
    return;
  }

  saveRelayConfig();
  request->send(200, "application/json", "{\"ok\":true}");
}

// Disparado ao iniciar uma dosagem: aplica as ações das regras da bomba.
void applyRulesForPump(int bombaIndex)
{
  for (int r = 0; r < ruleCount; r++)
  {
    if (!rules[r].enabled || rules[r].triggerPumpId != bombaIndex) continue;

    for (int a = 0; a < rules[r].actionCount; a++)
    {
      RuleAction &act = rules[r].actions[a];
      writeRelay(act.targetRelay, !act.turnOff); // turnOff=true => equipamento OFF
      relayTimers[act.targetRelay] =
          act.durationSec > 0 ? millis() + act.durationSec * 1000UL : 0;

      Serial.printf("[relay] Regra '%s': rele %d -> %s%s\n",
                    rules[r].name.c_str(), act.targetRelay + 1,
                    act.turnOff ? "DESLIGADO" : "LIGADO",
                    act.durationSec > 0 ? " (com timer)" : "");
    }
  }
}

// Religa o equipamento quando o timer da ação expira (sempre religar).
void checkRelayTimers()
{
  unsigned long now = millis();
  for (int i = 0; i < RELAY_COUNT; i++)
  {
    if (relayTimers[i] != 0 && now >= relayTimers[i])
    {
      writeRelay(i, true); // expira => equipamento LIGADO
      relayTimers[i] = 0;
      Serial.printf("[relay] Timer expirou: rele %d religado.\n", i + 1);
    }
  }
}

void setupServer()
{
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "Content-Type");

  server.on("/ping", HTTP_GET, [](AsyncWebServerRequest *request) {
    Serial.println("[http] GET /ping");
    request->send(200, "text/plain", "pong");
  });

  server.on("/status", HTTP_GET, handleStatus);
  server.on("/config", HTTP_GET, handleGetConfig);
  server.on("/config", HTTP_POST, handlePostConfig, nullptr, storeRequestBody);
  server.on("/time", HTTP_POST, handlePostTime, nullptr, storeRequestBody);
  server.on("/dose", HTTP_POST, handlePostDose, nullptr, storeRequestBody);
  server.on("/logs", HTTP_GET, handleGetLogs);
  server.on("/logs", HTTP_DELETE, handleDeleteLogs);

  server.on("/relays", HTTP_GET, handleGetRelays);
  server.on("/relay", HTTP_POST, handlePostRelay, nullptr, storeRequestBody);
  server.on("/rules", HTTP_GET, handleGetRules);
  server.on("/rules", HTTP_POST, handlePostRules, nullptr, storeRequestBody);

  server.onNotFound([](AsyncWebServerRequest *request) {
    Serial.printf("[http] 404/Options: %s %s\n",
                  httpMethodToString((WebRequestMethodComposite)request->method()),
                  request->url().c_str());
    if (request->method() == HTTP_OPTIONS)
    {
      request->send(200);
      return;
    }
    request->send(404, "application/json", "{\"ok\":false,\"message\":\"rota nao encontrada\"}");
  });

  server.begin();
  Serial.printf("[http] Servidor HTTP iniciado em %s\n", WiFi.softAPIP().toString().c_str());
}

bool readRequestBody(AsyncWebServerRequest *request, String &body)
{
  if (request->hasParam("plain", true))
  {
    body = request->getParam("plain", true)->value();
    return true;
  }
  if (request->_tempObject != nullptr)
  {
    body = String(static_cast<char *>(request->_tempObject));
    free(request->_tempObject);
    request->_tempObject = nullptr;
    return true;
  }
  return false;
}

void storeRequestBody(AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total)
{
  if (total == 0) return;

  if (request->_tempObject == nullptr)
  {
    request->_tempObject = malloc(total + 1);
    if (request->_tempObject == nullptr)
    {
      Serial.println("[http] ERRO: Falha ao alocar memoria para body");
      return;
    }
    static_cast<char *>(request->_tempObject)[0] = '\0';
  }

  memcpy(static_cast<uint8_t *>(request->_tempObject) + index, data, len);
  if (index + len >= total)
  {
    static_cast<char *>(request->_tempObject)[total] = '\0';
  }
}

// =========================================================
// Logs locais (LittleFS)
// =========================================================
size_t countLogLines(File &file)
{
  size_t count = 0;
  while (file.available())
  {
    String line = file.readStringUntil('\n');
    line.trim();
    if (!line.isEmpty()) count++;
  }
  return count;
}

bool trimLogFile(size_t removeCount)
{
  if (removeCount == 0) return true;
  if (!LittleFS.exists(LOG_FILE)) return true;

  File input = LittleFS.open(LOG_FILE, FILE_READ);
  if (!input)
  {
    Serial.println("[log] ERRO: Falha ao abrir arquivo de logs para trim");
    return false;
  }

  File output = LittleFS.open(LOG_TEMP_FILE, FILE_WRITE);
  if (!output)
  {
    Serial.println("[log] ERRO: Falha ao criar arquivo temporario de logs");
    input.close();
    return false;
  }

  size_t skipped = 0;
  while (input.available())
  {
    String line = input.readStringUntil('\n');
    line.trim();
    if (line.isEmpty()) continue;
    if (skipped < removeCount)
    {
      skipped++;
      continue;
    }
    output.println(line);
  }

  input.close();
  output.close();

  LittleFS.remove(LOG_FILE);
  if (!LittleFS.rename(LOG_TEMP_FILE, LOG_FILE))
  {
    Serial.println("[log] ERRO: Falha ao substituir arquivo de logs");
    return false;
  }

  return true;
}

bool initLogStorage()
{
  fsReady = LittleFS.begin(true);
  if (!fsReady)
  {
    Serial.println("[log] ERRO: Falha ao iniciar LittleFS");
    return false;
  }

  if (!LittleFS.exists(LOG_FILE))
  {
    File file = LittleFS.open(LOG_FILE, FILE_WRITE);
    if (!file)
    {
      Serial.println("[log] ERRO: Falha ao criar arquivo de logs");
      return false;
    }
    file.close();
    logCount = 0;
    return true;
  }

  File file = LittleFS.open(LOG_FILE, FILE_READ);
  if (!file)
  {
    Serial.println("[log] ERRO: Falha ao abrir arquivo de logs");
    return false;
  }

  logCount = countLogLines(file);
  file.close();

  if (logCount > LOG_LIMIT)
  {
    size_t removeCount = logCount - LOG_LIMIT;
    if (trimLogFile(removeCount))
      logCount = LOG_LIMIT;
  }

  Serial.printf("[log] Logs carregados: %u\n", static_cast<unsigned int>(logCount));
  return true;
}

void appendLocalLog(int bombaIndex, float dosagem, const String &origem, const DateTime &timestamp)
{
  if (!fsReady) return;
  if (bombaIndex < 0 || bombaIndex >= BOMBA_COUNT) return;
  if (dosagem <= 0) return;

  if (logCount >= LOG_LIMIT)
  {
    size_t removeCount = (logCount - LOG_LIMIT) + 1;
    if (!trimLogFile(removeCount))
    {
      Serial.println("[log] ERRO: Falha ao limpar logs antigos");
      return;
    }
    logCount = (logCount > removeCount) ? (logCount - removeCount) : 0;
  }

  File file = LittleFS.open(LOG_FILE, FILE_APPEND);
  if (!file)
  {
    Serial.println("[log] ERRO: Falha ao abrir arquivo de logs para escrita");
    return;
  }

  StaticJsonDocument<256> doc;
  doc["bombaId"] = bombaIndex + 1;
  doc["timestamp"] = formatTimestamp(timestamp);
  doc["bomba"] = bombas[bombaIndex].name;
  doc["dosagem"] = dosagem;
  doc["origem"] = origem;

  serializeJson(doc, file);
  file.println();
  file.close();

  logCount++;
}

// =========================================================
// Config / JSON
// =========================================================
void inicializarBombas()
{
  for (int i = 0; i < BOMBA_COUNT; i++)
  {
    pinMode(PUMP_PINS[i], OUTPUT);
    digitalWrite(PUMP_PINS[i], LOW);
  }

  Serial.printf("[system] %d bombas inicializadas.\n", BOMBA_COUNT);
}

// =========================================================
// Relés (helpers)
// =========================================================
int relayPinForIndex(int i)
{
  static const uint8_t pins[RELAY_COUNT] = {RELE1_PIN, RELE2_PIN, RELE3_PIN, RELE4_PIN};
  if (i < 0 || i >= RELAY_COUNT) return pins[0];
  return pins[i];
}

void writeRelay(int i, bool equipOn)
{
  if (i < 0 || i >= RELAY_COUNT) return;
  digitalWrite(relayPinForIndex(i), equipOn ? RELAY_LEVEL_EQUIP_ON : RELAY_LEVEL_EQUIP_OFF);
  relayStates[i] = equipOn;
}

void inicializarRele()
{
  for (int i = 0; i < RELAY_COUNT; i++)
  {
    pinMode(relayPinForIndex(i), OUTPUT);
    writeRelay(i, true); // boot = equipamento LIGADO (fail-safe com fiação NC)
    relayTimers[i] = 0;
  }
  Serial.printf("[system] %d reles inicializados (equipamentos ligados).\n", RELAY_COUNT);
}

void resetSchedule(Schedule &schedule)
{
  schedule = Schedule();
}

void saveBombasConfig()
{
  if (!prefsReady) return;
  Serial.println("[config] Salvando configuracoes na memoria (Preferences)...");
  String json = buildConfigJson();
  preferences.putString("bombas", json);
}

String buildConfigJson()
{
  JsonDocument doc;

  for (int i = 0; i < BOMBA_COUNT; i++)
  {
    String bombaKey = "bomb" + String(i + 1);
    JsonObject bomba = doc[bombaKey].to<JsonObject>();

    bomba["name"] = bombas[i].name;
    bomba["calibrCoef"] = bombas[i].calibrCoef;
    bomba["quantidadeEstoque"] = bombas[i].quantidadeEstoque;

    JsonArray schedules = bomba["schedules"].to<JsonArray>();
    for (int j = 0; j < SCHEDULE_COUNT; j++)
    {
      JsonObject schedule = schedules.add<JsonObject>();
      schedule["id"] = j + 1;

      JsonObject timeObj = schedule["time"].to<JsonObject>();
      timeObj["hour"] = bombas[i].schedules[j].hour;
      timeObj["minute"] = bombas[i].schedules[j].minute;

      schedule["dosagem"] = bombas[i].schedules[j].dosagem;
      schedule["status"] = bombas[i].schedules[j].status;

      JsonArray dias = schedule["diasSemanaSelecionados"].to<JsonArray>();
      for (int d = 0; d < 7; d++)
        dias.add(bombas[i].schedules[j].diasSemana[d]);
    }
  }

  String json;
  serializeJson(doc, json);
  return json;
}

void initDefaultBombasConfig()
{
  Serial.println("[config] Inicializando configuracao padrao de bombas...");
  for (int i = 0; i < BOMBA_COUNT; i++)
  {
    bombas[i].name = "Bomba " + String(i + 1);
    bombas[i].calibrCoef = 1.0f;
    bombas[i].quantidadeEstoque = 1000.0f;
    for (int j = 0; j < SCHEDULE_COUNT; j++)
      resetSchedule(bombas[i].schedules[j]);
  }
  saveBombasConfig();
  Serial.println("[config] Configuracao padrao salva e aplicada.");
}

void parseBombData(int i, JsonObject bomba)
{
  if (bomba["name"].is<const char *>())
    bombas[i].name = bomba["name"].as<String>();
  else
    bombas[i].name = "Bomba " + String(i + 1);

  bombas[i].calibrCoef = bomba["calibrCoef"] | 1.0f;
  bombas[i].quantidadeEstoque = bomba["quantidadeEstoque"] | 0.0f;

  if (bomba["schedules"])
  {
    JsonArray schedules = bomba["schedules"].as<JsonArray>();
    for (int j = 0; j < SCHEDULE_COUNT; j++)
    {
      JsonObject schedule = schedules[j];
      resetSchedule(bombas[i].schedules[j]);

      if (schedule.isNull())
        continue;

      JsonObject timeObj = schedule["time"].as<JsonObject>();
      bombas[i].schedules[j].hour = timeObj["hour"] | 0;
      bombas[i].schedules[j].minute = timeObj["minute"] | 0;
      bombas[i].schedules[j].dosagem = schedule["dosagem"] | 0.0f;
      bombas[i].schedules[j].status = schedule["status"] | false;

      if (schedule["diasSemanaSelecionados"])
      {
        JsonArray dias = schedule["diasSemanaSelecionados"].as<JsonArray>();
        for (int d = 0; d < 7; d++)
          bombas[i].schedules[j].diasSemana[d] = dias[d] | false;
      }
      else
      {
        for (int d = 0; d < 7; d++)
          bombas[i].schedules[j].diasSemana[d] = false;
      }
    }
  }
  else
  {
    // Caso legado: sem "schedules"
    for (int j = 0; j < SCHEDULE_COUNT; j++)
      resetSchedule(bombas[i].schedules[j]);
  }

  for (int j = 0; j < SCHEDULE_COUNT; j++)
    bombas[i].schedules[j].lastRunMinute = -1;
}

void loadBombasConfig()
{
  Serial.println("[config] Lendo configuracoes salvas...");
  String configJson = preferences.getString("bombas", "");

  if (configJson.isEmpty())
  {
    Serial.println("[config] Nenhuma config encontrada. Usando padrao.");
    initDefaultBombasConfig();
    return;
  }

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, configJson);
  if (error)
  {
    Serial.println("[config] ERRO critico ao ler JSON salvo.");
    initDefaultBombasConfig();
    return;
  }

  for (int i = 0; i < BOMBA_COUNT; i++)
  {
    String bombaKey = "bomb" + String(i + 1);
    JsonObject bomba = doc[bombaKey];
    if (bomba.isNull()) continue;
    parseBombData(i, bomba);
  }

  // Migração NVS: preencher bombas que não existiam na config salva (ex: upgrade de 3→4)
  for (int i = 0; i < BOMBA_COUNT; i++)
  {
    if (bombas[i].name.isEmpty())
    {
      Serial.printf("[config] Slot %d vazio, preenchendo com valores padrao (upgrade).\n", i + 1);
      bombas[i].name = "Bomba " + String(i + 1);
      bombas[i].calibrCoef = 1.0f;
      bombas[i].quantidadeEstoque = 1000.0f;
      for (int j = 0; j < SCHEDULE_COUNT; j++)
        resetSchedule(bombas[i].schedules[j]);
    }
  }

  saveBombasConfig();
  Serial.println("[config] Configuracoes carregadas com sucesso.");
}

bool applyConfigJson(const String &json)
{
  Serial.println("[config] Aplicando novo JSON recebido...");
  JsonDocument doc;

  DeserializationError error = deserializeJson(doc, json);
  if (error)
  {
    Serial.println("[config] JSON invalido recebido via HTTP.");
    return false;
  }

  for (int i = 0; i < BOMBA_COUNT; i++)
  {
    String bombaKey = "bomb" + String(i + 1);
    JsonObject bomba = doc[bombaKey];
    if (bomba.isNull()) continue;
    parseBombData(i, bomba);
  }

  saveBombasConfig();
  return true;
}

bool parseDateTime(const String &value, DateTime &output)
{
  int dia, mes, ano, hora, minuto, segundo;

  int parsed = sscanf(value.c_str(), "%d/%d/%d %d:%d:%d",
                      &dia, &mes, &ano, &hora, &minuto, &segundo);
  if (parsed == 6)
  {
    output = DateTime(ano, mes, dia, hora, minuto, segundo);
    return true;
  }

  parsed = sscanf(value.c_str(), "%d/%d/%d %d:%d",
                  &dia, &mes, &ano, &hora, &minuto);
  if (parsed == 5)
  {
    output = DateTime(ano, mes, dia, hora, minuto, 0);
    return true;
  }

  return false;
}

// =========================================================
// Scheduler
// =========================================================
void checkSchedules()
{
  static long lastCheckedMinuteKey = -1;
  static unsigned long lastCheckTime = 0;

  unsigned long nowMs = millis();
  if (nowMs - lastCheckTime < 1000) return;
  lastCheckTime = nowMs;

  if (!rtcReady)
  {
    Serial.println("[scheduler] RTC nao pronto, pulando verificacao");
    return;
  }

  DateTime rtcNow = rtc.now();
  long minuteKey = rtcNow.unixtime() / 60;

  // Só processa uma vez por minuto real (não por "minute()")
  if (minuteKey == lastCheckedMinuteKey) return;
  lastCheckedMinuteKey = minuteKey;

  Serial.println("\n----------------------------------------");
  Serial.printf("[scheduler] Verificando agendamentos para: %02d:%02d\n",
                rtcNow.hour(), rtcNow.minute());

  int diaSemana = rtcNow.dayOfTheWeek();
  bool encontrouAlgumaCoisa = false;

  Serial.printf("[scheduler] Dia da semana: %d, Chave de minuto: %ld\n", diaSemana, minuteKey);

  for (int i = 0; i < BOMBA_COUNT; i++)
  {
    for (int j = 0; j < SCHEDULE_COUNT; j++)
    {
      Schedule &schedule = bombas[i].schedules[j];

      if (!schedule.status) continue;
      if (schedule.lastRunMinute == minuteKey) continue;
      if (!schedule.diasSemana[diaSemana]) continue;

      if (schedule.hour == rtcNow.hour() && schedule.minute == rtcNow.minute())
      {
        Serial.printf("[scheduler] >>> HORARIO ATINGIDO! Bomba %d (Schedule %d) <<<\n", i + 1, j + 1);
        encontrouAlgumaCoisa = true;
        schedule.lastRunMinute = minuteKey;
        enqueuePumpJob(i, schedule.dosagem, "Programado");
      }
    }
  }

  if (!encontrouAlgumaCoisa)
    Serial.println("[scheduler] Nenhum horario programado para este minuto.");

  Serial.println("----------------------------------------\n");
}

// =========================================================
// Pump Queue
// =========================================================
bool enqueuePumpJob(int bombaIndex, float dosagem, const String &origem)
{
  if (bombaIndex < 0 || bombaIndex >= BOMBA_COUNT || dosagem <= 0)
  {
    Serial.printf("[queue] ERRO: Tentativa invalida de dosagem. Bomba: %d, Dose: %.2f\n",
                  bombaIndex, dosagem);
    return false;
  }

  DateTime now = rtc.now();
  bool queued = false;

  portENTER_CRITICAL(&pumpQueueMux);
  int nextTail = (pumpTail + 1) % MAX_PUMP_QUEUE;
  if (nextTail != pumpHead)
  {
    pumpQueue[pumpTail] = {bombaIndex, dosagem, origem, now};
    pumpTail = nextTail;
    queued = true;
  }
  portEXIT_CRITICAL(&pumpQueueMux);

  if (queued)
  {
    Serial.printf("[queue] Job ADICIONADO: Bomba %d, %.2f ml, Origem: %s\n",
                  bombaIndex + 1, dosagem, origem.c_str());
  }
  else
  {
    Serial.println("[queue] ERRO: Fila de bombas cheia! Ignorando comando.");
  }

  return queued;
}

int pumpPinForIndex(int bombaIndex)
{
  if (bombaIndex < 0 || bombaIndex >= BOMBA_COUNT) return PUMP_PINS[0];
  return PUMP_PINS[bombaIndex];
}

void finishPumpJob()
{
  int bombaIndex = activeJob.bombaIndex;
  int pin = pumpPinForIndex(bombaIndex);

  digitalWrite(pin, LOW);
  pumpActive = false;

  Serial.printf("[pump] BOMBA %d DESLIGADA. Fim da dosagem.\n", bombaIndex + 1);

  if (bombas[bombaIndex].quantidadeEstoque > 0)
  {
    float anterior = bombas[bombaIndex].quantidadeEstoque;
    bombas[bombaIndex].quantidadeEstoque -= activeJob.dosagem;
    if (bombas[bombaIndex].quantidadeEstoque < 0) bombas[bombaIndex].quantidadeEstoque = 0;

    Serial.printf("[stock] Estoque Bomba %d atualizado: %.2f -> %.2f\n",
                  bombaIndex + 1, anterior, bombas[bombaIndex].quantidadeEstoque);
  }

  saveBombasConfig();
  appendLocalLog(bombaIndex, activeJob.dosagem, activeJob.origem, activeJob.timestamp);
}

void startNextPumpJob()
{
  if (pumpActive) return;

  PumpJob nextJob;
  bool hasJob = false;

  portENTER_CRITICAL(&pumpQueueMux);
  if (pumpHead != pumpTail)
  {
    nextJob = pumpQueue[pumpHead];
    pumpHead = (pumpHead + 1) % MAX_PUMP_QUEUE;
    hasJob = true;
  }
  portEXIT_CRITICAL(&pumpQueueMux);

  if (!hasJob) return;

  activeJob = nextJob;
  float coef = bombas[activeJob.bombaIndex].calibrCoef;
  pumpDuration = (unsigned long)(activeJob.dosagem * TEMPO_POR_ML * coef);
  pumpStartTime = millis();
  pumpActive = true;

  Serial.println("------------------------------------------------");
  Serial.printf("[pump] INICIANDO DOSAGEM!\n");
  Serial.printf("[pump] Bomba: %d\n", activeJob.bombaIndex + 1);
  Serial.printf("[pump] Origem: %s\n", activeJob.origem.c_str());
  Serial.printf("[pump] Volume: %.2f ml\n", activeJob.dosagem);
  Serial.printf("[pump] Tempo Calculado: %lu ms\n", pumpDuration);
  Serial.println("------------------------------------------------");

  int pin = pumpPinForIndex(activeJob.bombaIndex);
  digitalWrite(pin, HIGH);

  applyRulesForPump(activeJob.bombaIndex);
}

void processPumpQueue()
{
  if (pumpActive)
  {
    if (millis() - pumpStartTime >= pumpDuration)
      finishPumpJob();
    return;
  }
  startNextPumpJob();
}

// =========================================================
// LED
// =========================================================
void setLedColor(uint8_t red, uint8_t green, uint8_t blue)
{
  uint32_t color = statusLed.Color(red, green, blue);
  if (color == currentLedColor) return;
  statusLed.setPixelColor(0, color);
  statusLed.show();
  currentLedColor = color;
}

void updateLedMode(LedMode mode)
{
  if (ledMode == mode) return;

  ledMode = mode;
  ledLastToggle = millis();
  ledBlinkOn = true;

  noNetBlinkActive = false;
  lastNoNetBlink = millis();

  if (mode == LED_MODE_READY)
  {
    setLedColor(128, 0, 255);
    ledBlinkOn = false;
  }
  else if (mode == LED_MODE_NO_NET)
  {
    setLedColor(128, 0, 255);
    ledBlinkOn = false;
  }
  else if (mode == LED_MODE_BOOT)
  {
    setLedColor(255, 0, 0);
  }
  else if (mode == LED_MODE_DOSING)
  {
    setLedColor(0, 0, 255);
  }
}

void updateStatusLed()
{
  if (pumpActive)
    updateLedMode(LED_MODE_DOSING);
  else if (!systemReady)
    updateLedMode(LED_MODE_BOOT);
  else if (WiFi.status() != WL_CONNECTED)
    updateLedMode(LED_MODE_NO_NET);
  else
    updateLedMode(LED_MODE_READY);

  unsigned long now = millis();

  switch (ledMode)
  {
  case LED_MODE_BOOT:
    if (now - ledLastToggle >= 500)
    {
      ledLastToggle = now;
      ledBlinkOn = !ledBlinkOn;
      setLedColor(ledBlinkOn ? 255 : 0, 0, 0);
    }
    break;

  case LED_MODE_DOSING:
    if (now - ledLastToggle >= 300)
    {
      ledLastToggle = now;
      ledBlinkOn = !ledBlinkOn;
      setLedColor(0, 0, ledBlinkOn ? 255 : 0);
    }
    break;

  case LED_MODE_NO_NET:
    if (!noNetBlinkActive && now - lastNoNetBlink >= 5000)
    {
      noNetBlinkActive = true;
      noNetBlinkStart = now;
      setLedColor(0, 0, 0);
    }
    else if (noNetBlinkActive && now - noNetBlinkStart >= 150)
    {
      noNetBlinkActive = false;
      lastNoNetBlink = now;
      setLedColor(128, 0, 255);
    }
    else if (!noNetBlinkActive)
    {
      setLedColor(128, 0, 255);
    }
    break;

  case LED_MODE_READY:
  default:
    setLedColor(128, 0, 255);
    break;
  }
}

// =========================================================
// Setup / Loop (APENAS UMA VEZ)
// =========================================================
void setup()
{
  Serial.begin(115200);
  Serial.println("\n\n--- INICIANDO FIRE DOSER SYSTEM ---");

  inicializarBombas();
  inicializarRele();

  Wire.begin(I2C_SDA, I2C_SCL);

  rtcReady = rtc.begin();
  if (!rtcReady)
  {
    Serial.println("[rtc] ERRO FATAL: Falha ao iniciar RTC!");
  }
  else
  {
    DateTime now = rtc.now();
    Serial.printf("[rtc] RTC Iniciado. Hora atual: %02d:%02d:%02d\n", now.hour(), now.minute(), now.second());
  }

  prefsReady = preferences.begin("bomb-config", false);
  if (prefsReady)
    loadBombasConfig();
  else
    Serial.println("[config] ERRO: Falha ao iniciar Preferences.");

  if (relayPrefs.begin("relay-config", false))
    loadRelayConfig();
  else
    Serial.println("[relay] ERRO: Falha ao iniciar Preferences de reles.");

  initLogStorage();

  systemReady = rtcReady && prefsReady;

  statusLed.begin();
  statusLed.setBrightness(30);
  statusLed.setPixelColor(0, statusLed.Color(255, 0, 0));
  statusLed.show();
  Serial.println("[led] LED deve estar VERMELHO agora");

  setupWifi();
  setupServer();

  applyApPriority();

  Serial.println("[system] Setup concluido. Entrando no loop principal...");
}

void loop()
{
  applyApPriority();
  ensureStaWifi();
  ensureTimeSynced();
  ensureApIsUp();

  checkSchedules();
  processPumpQueue();
  checkRelayTimers();

  updateStatusLed();
  logWifiStatusChange();

  delay(100);
}
