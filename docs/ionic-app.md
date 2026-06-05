# App Mobile — AquaBalancePro

Documentação completa do aplicativo Ionic/Angular para controle e monitoramento do sistema de dosagem.

## Stack Tecnológica

| Tecnologia | Versão | Função |
|---|---|---|
| **Angular** | 20 | Framework SPA (Standalone Components) |
| **Ionic** | 8 | Componentes UI mobile + roteamento |
| **Tailwind CSS** | 4 | Estilização utilitária |
| **Capacitor** | 8 | Ponte nativa (Android + iOS) |
| **Chart.js** | — | Gráficos de timeline (scatter plot) |
| **Jasmine / Karma** | 5.1 / 6.4 | Testes unitários |

## Estrutura de Diretórios

```
src/
├── app/
│   ├── home/                 # Dashboard principal
│   │   ├── home.page.ts
│   │   ├── home.page.html
│   │   ├── home.page.scss
│   │   └── home.page.spec.ts
│   ├── configuracao/         # Configuração de bombas
│   │   ├── configuracao.page.ts
│   │   ├── configuracao.page.html
│   │   └── configuracao.page.scss
│   ├── calibracao/           # Calibração de bombas
│   │   ├── calibracao.page.ts
│   │   ├── calibracao.page.html
│   │   └── calibracao.page.scss
│   ├── logs/                 # Histórico de dosagens
│   │   ├── logs.page.ts
│   │   ├── logs.page.html
│   │   └── logs.page.scss
│   ├── analytics/            # Gráficos
│   │   ├── analytics.page.ts
│   │   ├── analytics.page.html
│   │   └── analytics.page.scss
│   ├── services/
│   │   ├── doser.service.ts      # API REST para o ESP32
│   │   └── wifi-binding.service.ts # Bind de rede Wi-Fi (Android)
│   ├── app.component.ts
│   ├── app.component.html
│   ├── app.component.scss
│   ├── app.routes.ts
│   └── app.component.spec.ts
├── assets/                   # Imagens do app
├── theme/
│   └── variables.scss        # Tema escuro "ocean"
├── types/
│   └── web-bluetooth.d.ts    # Tipos Bluetooth (não utilizado atualmente)
├── global.scss               # Estilos globais + Tailwind
├── index.html                # HTML raiz
├── main.ts                   # Bootstrap (bootstrapApplication)
├── manifest.webmanifest      # PWA manifest
└── environments/
    ├── environment.ts
    └── environment.prod.ts
```

## Arquitetura do App

### Standalone Components (sem NgModules)

O app usa Angular 20 **Standalone API**. Não há `NgModule`. O bootstrap é feito diretamente em `main.ts`:

```typescript
// main.ts
bootstrapApplication(AppComponent, {
  providers: [
    provideIonicAngular({ mode: 'md' }),
    provideRouter(routes, withPreloading(PreloadAllModules)),
    provideHttpClient(),
  ],
});
```

### Roteamento (5 rotas lazy-loaded)

Definido em `app.routes.ts`:

| Path | Componente | Carregamento |
|---|---|---|
| `''` | Redireciona → `/home` | — |
| `home` | `HomePage` | Lazy (`loadComponent`) |
| `configuracao` | `ConfiguracaoPage` | Lazy |
| `calibracao` | `CalibracaoPage` | Lazy |
| `logs` | `LogsPage` | Lazy |
| `analytics` | `AnalyticsPage` | Lazy |

Todas as rotas usam `PreloadAllModules` para pré-carregar após o bootstrap. Navegação via `Router.navigateByUrl()`.

### Gerenciamento de Estado

**Não há biblioteca de estado** (sem NgRx, NgXs, Akita, Signals). Cada página mantém seu estado localmente e recarrega dados do ESP32 ao entrar (`ionViewWillEnter`). O único dado persistente entre sessões é a cor personalizada das bombas, armazenada em `localStorage` (chave `abp-bomb-colores`). As cores default são: Bomba 1 = `#2DD4BF` (teal), Bomba 2 = `#F472B6` (pink), Bomba 3 = `#A855F7` (purple), Bomba 4 = `#3B82F6` (blue).

## Páginas

### 1. HomePage — Dashboard

**Arquivos:** `home/`

**Função:** Tela inicial com status do dispositivo e navegação para as demais funcionalidades.

**Estado local:**
- `deviceStatus: DeviceStatus` — dados do GET /status
- `isLoading, error` — flags de carregamento

**Fluxo:**
1. Ao entrar (`ionViewWillEnter`), chama `loadStatus()`
2. `loadStatus()` → `doserService.getStatus()` com bind de rede
3. Inicia polling automático a cada **15 segundos** via `setInterval`
4. Exibe: hora do dispositivo, nome do AP, IP, status Wi-Fi (conectado/RSSI/IP)
5. 5 botões de navegação: Atualizar, Configurar, Analytics, Logs, Calibração
6. O botão "Configurar" primeiro sincroniza a hora (`setTime()`) antes de navegar

**Template:**
- Cards com efeito glassmorphism
- Status Wi-Fi com indicador pulsante animado
- Botões com hover scale + brilho

### 2. ConfiguracaoPage — Configuração de Bombas

**Arquivos:** `configuracao/`

**Função:** Configurar até 4 bombas, cada uma com 3 horários de dosagem.

**Estado local:**
- `bombs: BombForm[]` — 4 bombas com schedules, cores, schedule ativo
- `expandedBombIndex: number` — accordion atual
- `isLoading, error` — flags

**Modelo interno `BombForm`:**
```typescript
interface BombForm extends BombConfig {
  activeScheduleIndex: number;  // Schedule selecionado no segment slider
  color: string;                // Cor hex personalizada
  colorBg: string;              // Cor com alpha para background
  schedules: (ScheduleConfig & { timeValue: string })[];
}
```

**Fluxo:**
1. Ao entrar, carrega configuração via `doserService.getConfig()`
2. Aplica cores salvas do `localStorage` ou usa as padrão
3. Usuário edita: nome, cor, dosagem (step 0.5ml, range 0.5–15ml), horário, dias da semana
4. Accordions: uma bomba expandida por vez
5. Segment slider para alternar entre os 3 schedules de cada bomba
6. Ao salvar (`saveConfig()`), envia array de `BombConfig` como JSON para `POST /config`
7. Cores são persistidas no `localStorage`

**Template:**
- Accordions com transição suave (max-height animado)
- Segment para navegação entre schedules
- Day-toggle com gradiente (ativo/inativo) para cada dia da semana
- Inputs de time nativos (`<input type="time">`)
- Botão de slide para valor de dosagem

### 3. CalibracaoPage — Calibração

**Arquivos:** `calibracao/`

**Função:** Calibrar bombas e acionamento manual para teste.

**Estado local:**
- `bombs: BombConfig[]`
- `isLoading, error`

**Fluxo:**
1. Carrega config atual via `doserService.getConfig()`
2. **Teste de Calibração:**
   - Usuário seleciona bomba e volume de teste (ml)
   - Envia `POST /dose` com `origem: "Calibracao"`
   - App exibe alert solicitando o volume REAL medido
   - Calcula novo coeficiente: `novoCoef = (volumeReal / volumeSolicitado) * coefAtual`
   - Salva configuração atualizada com o novo coeficiente
3. **Acionamento Manual:**
   - Usuário seleciona bomba e volume
   - Envia `POST /dose` com `origem: "Teste"`
   - Sem alteração de calibração

### 4. LogsPage — Histórico

**Arquivos:** `logs/`

**Função:** Visualizar histórico de dosagens.

**Estado local:**
- `logs: LogEntry[]`
- `bombColors: Record<number, string>`
- `isLoading, error`

**Fluxo:**
1. Carrega logs via `doserService.getLogs()`
2. Ordena por timestamp (mais recente primeiro)
3. Recupera cores das bombas do `localStorage`
4. Exibe cada log com: nome da bomba (com cor), dosagem (ml), timestamp, origem
5. Botão "Apagar todos Logs" → `doserService.clearLogs()`

### 5. AnalyticsPage — Gráficos

**Arquivos:** `analytics/`

**Função:** Gráfico scatter comparando dosagens programadas vs executadas ao longo do dia.

**Estado local:**
- `dailyData: DailyDataPoint[]` — merge de programados + executados do dia
- `selectedDate: string` — data selecionada (YYYY-MM-DD)
- `isLoading, error`

**Modelo interno:**
```typescript
interface DailyDataPoint {
  hour: number;
  minute: number;
  bombId: number;
  dosagem: number;
  origem: string;
  scheduled: boolean;
  isExecuted?: boolean;
  scheduledTime?: string;
}
```

**Fluxo:**
1. Carrega config (schedules programados) e logs (execuções) via `doserService`
2. Filtra logs do dia selecionado
3. Faz merge: para cada schedule programado, busca log correspondente (tolerância de 30min)
4. Renderiza gráfico scatter com Chart.js:
   - **Círculos verdes**: dosagens programadas
   - **X vermelhos**: dosagens executadas
   - **Linha pontilhada vertical**: hora atual (overlay customizado)
   - Anotações mostrando valor da dose ao lado de cada ponto
5. Segment para trocar entre bombas
6. Overlay customizado: linha de hora atual com plugin Chart.js

## Serviços

### DoserService (`services/doser.service.ts`)

**Singleton** global (`providedIn: 'root'`). Injeta `HttpClient` e `WifiBindingService`.

**Base URL:** `http://192.168.4.1`

**Métodos:**

| Método | HTTP | Descrição |
|---|---|---|
| `getStatus()` | `GET /status` | Status do dispositivo. Mapeia `RawStatus` → `DeviceStatus`. |
| `getConfig()` | `GET /config` | Config das 4 bombas. Mapeia `RawConfig` (objeto chaveado) → `BombConfig[]` via `Array.from({length: bombCount})`. Suporta legacy (schedule único) e novo formato (array). |
| `saveConfig(bombs)` | `POST /config` | Salva config. Body: JSON string. Header: `Content-Type: text/plain`. |
| `setTime(date)` | `POST /time` | Sincroniza RTC. Body: `{ "time": "DD/MM/AAAA HH:mm:ss" }`. |
| `testDose(bombId, dosagem, origem?)` | `POST /dose` | Dosagem manual. Body: `{ "bomb": id, "dosagem": ml, "origem": "..." }`. |
| `getLogs()` | `GET /logs` | Histórico. Aceita array direto ou `{ logs: [...] }`. |
| `clearLogs()` | `DELETE /logs` | Apaga todos os logs. |

**Mecanismo `withWifiBinding()`:** Cada chamada HTTP é embrulhada por um pipe que:
1. Invoca `wifiBinding.bindToWifi()` (bind do processo ao Wi-Fi no Android)
2. Ignora erros de bind (segue mesmo se falhar)
3. Executa a requisição HTTP

**Interfaces exportadas:**
```typescript
interface DeviceStatus {
  time?: string;
  wifiConnected?: boolean;
  wifiRssi?: number;
  wifiIp?: string;
  apSsid?: string;
  apIp?: string;
}

interface BombConfig {
  id: number;
  name: string;
  calibrCoef: number;
  quantidadeEstoque: number;
  schedules: ScheduleConfig[];
}

interface ScheduleConfig {
  id: number;
  hour: number;
  minute: number;
  dosagem: number;
  status: boolean;
  diasSemana: boolean[];  // [Dom, Seg, Ter, Qua, Qui, Sex, Sab]
}

interface LogEntry {
  bombaId: number;
  timestamp: string;       // "DD/MM/AAAA HH:mm:ss"
  bomba: string;
  dosagem: number;
  origem: string;          // "Programado" | "Teste" | "Calibracao"
}

interface ApiStatusResponse {
  ok: boolean;
  message?: string;
}
```

### WifiBindingService (`services/wifi-binding.service.ts`)

**Singleton** global. Abstrai o plugin Capacitor nativo `WifiBinding`.

| Método | Descrição |
|---|---|
| `bindToWifi(ssid?)` | Bind do processo Android à rede Wi-Fi. Throttle de 4s entre chamadas. Falhas silenciosas em não-Android. |
| `clearBinding()` | Remove bind de rede. |

**Plugin Capacitor declarado:**
```typescript
interface WifiBindingPlugin {
  bindToWifi(options?: { ssid?: string }): Promise<{ ok: boolean; ssid?: string }>;
  clearBinding(): Promise<{ ok: boolean }>;
}
```

## Plugin Nativo — WifiBinding (Android)

**Arquivo:** `android/app/src/main/java/com/aquabalancepro/app/WifiBindingPlugin.java`

Registrado no `MainActivity` como `WifiBinding`.

| Método | Ação |
|---|---|
| `bindToWifi({ssid?})` | `ConnectivityManager.bindProcessToNetwork()` — força tráfego HTTP pela interface Wi-Fi, ignorando dados móveis. Opcionalmente verifica SSID. |
| `clearBinding()` | `bindProcessToNetwork(null)` — remove o bind. |

**Permissões:** `INTERNET`, `ACCESS_NETWORK_STATE`, `ACCESS_WIFI_STATE`, `CHANGE_NETWORK_STATE`, `ACCESS_FINE_LOCATION`, `POST_NOTIFICATIONS`.

**Config:** `android:usesCleartextTraffic="true"` (permite HTTP).

## Tema e Estilo

### Dark Mode "Ocean"

Tema escuro fixo, definido em `theme/variables.scss`:

```scss
:root {
  --ion-color-primary: #0f969c;
  --ion-background-color: #05161a;
  --ion-text-color: #e0e0e0;
  --ion-item-background: #072e33;
  --ion-toolbar-background: #05161a;
  --abp-surface: #072e33;
  --abp-surface-alt: #294d61;
  --abp-ink: #e0e0e0;
  --abp-muted: #6da5c0;
  --abp-line: #294d61;
}
```

**Paleta:**
- `ocean-dark` (#05161A) — fundo principal
- `ocean-card` (#072E33) — fundo de cards
- `ocean-light` (#294D61) — bordas, elem. secundários
- `neon-cyan` (#0F969C) — cor de destaque
- `teal-dim` (#0C7075) — variação do destaque
- `text-main` (#E0E0E0) — texto principal
- `text-muted` (#6DA5C0) — texto secundário

**Fonte:** `Space Grotesk` (Google Fonts), fallback `Segoe UI`, sans-serif.

**Tailwind:** Configurado com paleta estendida, background gradients para as 4 bombas, animação `animate-shine`.

**Efeitos visuais:**
- Glassmorphism (backdrop-blur, bordas semi-transparentes)
- Overlays com gradiente sobre imagens de background
- Hover: scale + brilho em cards e botões
- Status Wi-Fi com pulsação animada
- Inputs com borda neon-cyan ao focar
- Botões com efeito shimmer

## Testes

### Setup
- **Framework:** Jasmine 5.1
- **Runner:** Karma 6.4
- **Browser:** ChromeHeadless
- **Coverage:** karma-coverage (html + text-summary)

### Cobertura Atual

| Arquivo | Teste |
|---|---|
| `app.component.spec.ts` | Deve criar o componente |
| `home.page.spec.ts` | Deve criar a página |

**Não há testes** para: serviços (`DoserService`, `WifiBindingService`), demais páginas, pipes, diretivas, ou integração HTTP.

## Fluxos de Usuário

### Conectar e Monitorar
```
App → bind Wi-Fi → GET /status (polling 15s) → exibir dashboard
```

### Configurar Schedules
```
Home → sincroniza hora (POST /time) → navega /configuracao
→ GET /config → carrega cores do localStorage
→ editar bombas/schedules → POST /config → salva cores
```

### Calibrar Bomba
```
Home → /calibracao → GET /config
→ seleciona bomba + volume → POST /dose (origem: Calibracao)
→ alert com volume real medido → recalcula calibrCoef
→ POST /config com novo coeficiente
```

### Visualizar Analytics
```
Home → /analytics → GET /config + GET /logs
→ merge schedules + execuções do dia → renderizar Chart.js scatter
```

## Configurações de Build

| Arquivo | Função |
|---|---|
| `angular.json` | Build system, assets, polyfills, style preprocessor |
| `capacitor.config.ts` | App ID (`com.aquabalancepro.app`), server URL, orientation |
| `ionic.config.json` | Tipo `angular-standalone` |
| `tailwind.config.js` | Paleta de cores extendida |
| `.postcssrc.json` | Plugin PostCSS do Tailwind |
| `tsconfig.json` | Paths, strict mode, decorators |
| `.eslintrc.json` | Regras Angular + TypeScript |
| `package.json` | Scripts: `serve`, `build`, `test`, `lint`, `cap:sync` |
