# Plano: Controle de 4 Relés + Regras Reativas

## Objetivo
Adicionar controle de 4 relés (GPIO 8-11) via app Ionic e um motor de regras reativas no firmware ESP32: quando uma bomba iniciar dosagem, executar ações configuráveis nos relés com timer automático.

---

## Arquitetura

```
App (Ionic)                     ESP32
┌─────────────────┐           ┌──────────────────────┐
│ Controle Manual  │─ POST ──▸│ GET/POST /relays      │
│ (4 toggle switch)│◂─ GET ───│ GPIO 8,9,10,11       │
├─────────────────┤           ├──────────────────────┤
│ Regras Visuais   │─ POST ──▸│ Motor de Reação       │
│ (blocos fluxo)   │◂─ GET ───│ (check ao iniciar     │
│                  │          │  pump job)           │
└─────────────────┘           └──────────────────────┘
```

---

## FASE 1 — Firmware ESP32 (main.cpp)

### A. Constantes (após linha 22)
```cpp
#define RELE1_PIN 8
#define RELE2_PIN 9
#define RELE3_PIN 10
#define RELE4_PIN 11
#define RELAY_COUNT 4
#define MAX_RULES 6
#define RELAY_CONFIG_DOC_SIZE 4096
```

### B. Novas structs (após struct PumpJob, ~linha 113)
```cpp
struct RuleAction {
  uint8_t targetRelay;        // 0-3
  bool turnOff;
  unsigned long durationSec;
};

struct RelayRule {
  uint8_t triggerPumpId;      // 0-3
  RuleAction actions[4];
  uint8_t actionCount;
  bool enabled;
  String name;
};
```

### C. Variáveis globais (após PumpJob queue[])
```cpp
RelayRule rules[MAX_RULES];
uint8_t ruleCount = 0;
bool relayStates[RELAY_COUNT] = {false, false, false, false};
unsigned long relayTimers[RELAY_COUNT] = {0, 0, 0, 0};
const String relayNames[RELAY_COUNT] = {"Rele 1", "Rele 2", "Rele 3", "Rele 4"};
```

### D. Nova função `inicializarRele()`
```cpp
void inicializarRele() {
  const uint8_t pins[RELAY_COUNT] = {RELE1_PIN, RELE2_PIN, RELE3_PIN, RELE4_PIN};
  for (int i = 0; i < RELAY_COUNT; i++) {
    pinMode(pins[i], OUTPUT);
    digitalWrite(pins[i], LOW);
    relayStates[i] = false;
    relayTimers[i] = 0;
  }
}
```

### E. Novos endpoints

| Método | Endpoint | Handler | Descrição |
|---|---|---|---|
| `GET` | `/relays` | `handleGetRelays` | Retorna `[{id, name, state, timerRemaining}]` |
| `POST` | `/relay` | `handlePostRelay` | Body `{"id":1,"state":true}` → seta GPIO, cancela timer |
| `GET` | `/rules` | `handleGetRules` | Retorna array de regras |
| `POST` | `/rules` | `handlePostRules` | Body = array de regras → salva NVS + RAM |

### F. Motor de reação
Modificar `startNextPumpJob()` (~linha 1185) para chamar ao final:
```cpp
void applyRulesForPump(int bombaId) {
  for (int r = 0; r < ruleCount; r++) {
    if (!rules[r].enabled) continue;
    if (rules[r].triggerPumpId != bombaId) continue;
    for (int a = 0; a < rules[r].actionCount; a++) {
      RuleAction &act = rules[r].actions[a];
      int pin = relayPin(act.targetRelay);
      bool newState = act.turnOff ? LOW : HIGH;
      digitalWrite(pin, newState);
      relayStates[act.targetRelay] = (newState == HIGH);
      relayTimers[act.targetRelay] = act.durationSec > 0
        ? millis() + act.durationSec * 1000
        : 0;
    }
  }
}
```

### G. Loop — checar timers
Adicionar em `loop()` (~linha 1381) após `processPumpQueue()`:
```cpp
void checkRelayTimers() {
  unsigned long now = millis();
  for (int i = 0; i < RELAY_COUNT; i++) {
    if (relayTimers[i] == 0) continue;
    if (now >= relayTimers[i]) {
      bool restore = !relayStates[i];
      digitalWrite(relayPin(i), restore ? HIGH : LOW);
      relayStates[i] = restore;
      relayTimers[i] = 0;
    }
  }
}
```

### H. Atualizar GET /status (~linha 419-439)
Adicionar ao JSON:
```json
"relays": [
  {"id": 1, "state": false, "timerRemaining": 600},
  {"id": 2, "state": true, "timerRemaining": 0}
]
```

### I. NVS — persistência
Funções `saveRelayConfig()` / `loadRelayConfig()`:
- Namespace: `relay-config`
- Chave: `"rules"` → JSON string do array de regras

---

## FASE 2 — App Mobile (Ionic/Angular)

### A. `doser.service.ts` — Novas interfaces + métodos

**Interfaces:**
```typescript
export interface RelayInfo {
  id: number;
  name: string;
  state: boolean;
  timerRemaining: number;
}

export interface RuleAction {
  targetRelay: number;
  turnOff: boolean;
  durationSec: number;
}

export interface RelayRule {
  name: string;
  triggerPumpId: number;
  actions: RuleAction[];
  enabled: boolean;
}
```

**Novos métodos:**
```typescript
getRelays(): Observable<RelayInfo[]>
setRelay(id: number, state: boolean): Observable<ApiStatusResponse>
getRules(): Observable<RelayRule[]>
saveRules(rules: RelayRule[]): Observable<ApiStatusResponse>
```

Atualizar `DeviceStatus` para incluir `relays?: RelayInfo[]`.

### B. `relays/relays.page.ts` + `.html` + `.scss`
- 4 cards com toggle switch grande
- Nome do relé, estado ON/OFF com cor
- Timer regressivo visível quando ativo
- Polling a cada 3s
- Botão no toolbar "⚡ Regras" que navega para `/rules`

### C. `rules/rules.page.ts` + `.html` + `.scss`
- Lista de regras como **blocos visuais**:

```
┌──────────────────────────────────────────┐
│ 🟢 Alimentação Corais                   │
│                                          │
│ [Bomba 4] ── inicia ──▸ [Relé 1: OFF 10min] │
│                          ▸ [Relé 3: OFF 40min] │
│                                          │
│ [Editar]  [Ativar/Desativar]  [Excluir]  │
└──────────────────────────────────────────┘
```

- Modal de criação/edição:
  - Nome da regra
  - Select: Quando `Bomba [1-4]` inicia dosagem
  - Lista de ações: `Relé [1-4]` → `[DESLIGAR / LIGAR]` por `[N]` min
  - `[+ Adicionar Ação]`
  - `[Salvar]` / `[Cancelar]`

### D. `app.routes.ts` — Novas rotas
```typescript
{
  path: 'relays',
  loadComponent: () => import('./relays/relays.page').then(m => m.RelaysPage),
},
{
  path: 'rules',
  loadComponent: () => import('./rules/rules.page').then(m => m.RulesPage),
},
```

### E. `home.page.html` — Botão "Relés" no grid
Adicionar entre Configurar e Analytics (~linha 98):
```html
<button *ngIf="canConfigure" (click)="openRelays()"
  class="...">
  <ion-icon name="flash-outline" ...></ion-icon>
  <span>Relés</span>
</button>
```

### F. `home.page.ts` — Método `openRelays()`
```typescript
openRelays(): void {
  void this.router.navigateByUrl('/relays');
}
```

Registrar ícone `flash` no `addIcons`.

---

## Comportamento dos Timers

- **Manual sempre vence**: toggle manual no app cancela qualquer timer ativo no relé
- **Timer expira → religa**: após `durationSec` segundos, o relé volta ao estado ligado
- **Reset do ESP32**: relés inicializam desligados (seguro para equipamentos de aquário)

---

## Riscos e Mitigações

| Risco | Gravidade | Mitigação |
|---|---|---|
| GPIO 8-11 conflitam? | 🟢 Baixo | Pinos seguros no ESP32-S3 (não strapping, não I2C) |
| NVS estoura | 🟡 Médio | Namespace separado `relay-config` + buffer 4096 bytes |
| Timer perdido no reset | 🟢 Baixo | Relés iniciam desligados (seguro) |
| Sobrescrição manual x timer | 🟢 Baixo | Manual cancela timer |
| App antigo sem suporte a relays | 🟢 Baixo | Tratar 404 no app; firmware novo ignora sem quebrar |

---

## Arquivos Afetados

| Arquivo | Tipo | Mudança |
|---|---|---|
| `esp32/src/main.cpp` | Firmware | ~270 linhas novas (structs, GPIOs, endpoints, motor regras, NVS) |
| `src/app/services/doser.service.ts` | App | ~50 linhas (interfaces + 4 métodos) |
| `src/app/relays/relays.page.ts` | App | **Novo** — ~100 linhas |
| `src/app/relays/relays.page.html` | App | **Novo** — ~80 linhas |
| `src/app/relays/relays.page.scss` | App | **Novo** — ~40 linhas |
| `src/app/rules/rules.page.ts` | App | **Novo** — ~200 linhas |
| `src/app/rules/rules.page.html` | App | **Novo** — ~150 linhas |
| `src/app/rules/rules.page.scss` | App | **Novo** — ~60 linhas |
| `src/app/app.routes.ts` | App | +2 rotas |
| `src/app/home/home.page.ts` | App | +1 método + ícone |
| `src/app/home/home.page.html` | App | +1 botão no grid |
