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

### Roteamento (7 rotas lazy-loaded)

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

**Não há biblioteca de estado** (sem NgRx, NgXs, Akita, Signals). Cada página mantém seu estado localmente e recarrega dados do ESP32 ao entrar (`ionViewWillEnter`). O único dado persistente entre sessões é a cor personalizada das bombas, armazenada em `localStorage` (chave `abp-bomb-colores`). As cores default são: Bomba 1 = `#2DD4BF` (teal), Bomba 2 = `#F472B6` (pink), Bomba 3 = `#A855F7` (purple), Bomba 4 = `#3B82F6` (blue), Bomba 5 = `#F59E0B` (amber).

## Páginas

### 1. HomePage — Dashboard

**Arquivos:** `home/`

**Função:** Resumo do dia, avisos e navegação.

**Blocos (de cima para baixo):**
1. **Dispositivo** — Conectado / Conectando… / Desconectado, hora do ESP32 comparada à do celular
   ("Relógio sincronizado" ou "N min atrasado") e botão de atualizar. Polling de `/status` a cada 15 s.
2. **Atenção** — só aparece com avisos: regras de nível "aviso" (`dosing-rules.ts`: teste vencido, estoque,
   relógio, KH↔Ca, dose concentrada) e doses programadas sem registro (`dose-check.ts`). Cada aviso tem
   ação (Abrir Ajuste, Configurar, Sincronizar relógio) ou "Ok".
3. **Hoje** (`services/today-summary.ts`) — por bomba, as doses de hoje como feitas (casadas com o log em
   ±30 min), sem registro ou pendentes; dias de estoque; "N de M doses feitas" e a próxima dose com contagem
   regressiva (ou a primeira de amanhã).
4. **Menu** — Configurar e Ajuste de Dosagem (com selo "Hora de medir") em destaque; Analytics e Logs; atalhos
   menores para Calibração e Produtos. "Configurar" sincroniza a hora (`setTime()`) antes de navegar.
5. **Como conectar** — só quando desconectado, com rede e senha do AP.

Com firmware sem `/dosing`, as regras usam um perfil padrão (sem notificações) e o resto da Home funciona.

### 2. ConfiguracaoPage — Configuração de Bombas

**Arquivos:** `configuracao/`

**Função:** Configurar até 5 bombas, cada uma com 3 horários de dosagem.

**Estado local:**
- `bombs: BombForm[]` — bombas com schedules e cores
- `dosingData` — documento do `GET /dosing` (null com firmware antigo: o seletor de tipo some)
- `suggestions` — regras de agenda recalculadas a cada alteração (cache pelo snapshot)
- `savedSnapshot` / `isDirty` — detecta alterações não salvas

**Modelo interno `BombForm`:**
```typescript
interface BombForm extends BombConfig {
  editingIndex: number | null;  // Horário aberto para edição
  identidade: PumpIdentity;     // Tipo de produto (KH, Cálcio, Iodo…)
  color: string;                // Cor hex personalizada
  colorBg: string;              // Cor com alpha para background
  schedules: (ScheduleConfig & { timeValue: string })[];
}
```

**Fluxo:**
1. Ao entrar, carrega a configuração (`getConfig()`) e, se houver, o tipo de cada bomba (`getDosingData()`)
2. Card fechado: nome, tipo, dose média/dia, próxima dose e quantidade de horários ativos
3. Card aberto: nome + cor, **tipo de produto** (seletor agrupado: macro, micro, nutrientes, carbono e
   alimentação, outros) e **produto do catálogo** (traz a potência do fabricante), **estoque** (ml, com botão "Reabasteci" que lembra o tamanho do frasco) e a lista
   dos 3 horários (hora, dose, dias, toggle). Toque numa linha abre o editor: horário, dose (passo 0,5 ml,
   0,5–15 ml, atalhos) e dias com atalhos Todos / Seg–Sex / Fim de semana
4. Com alterações pendentes aparece uma barra fixa "Alterações não salvas" (Descartar / Salvar); sair da tela
   nesse estado pede confirmação (guard `canDeactivate` em `app.routes.ts`)
5. **Avisos ao vivo:** enquanto edita, as regras de agenda (`espaco-`, `dose-concentrada-`, `teto-diario-`,
   `kh-noite-`) marcam o card e a linha do horário com um ícone amarelo; o editor e o card "Sugestões para esta
   agenda" mostram a mensagem e o botão de correção ("Mover KH para 09:30"), que muda só o formulário
6. **Horário automático** (`services/auto-schedule.ts`): espalha as doses de cada bomba igualmente no dia (passo
   15 min), afasta os pares incompatíveis o máximo possível (até 4 h), evita duas bombas no mesmo horário
   (≥ 30 min), prefere KH com as luzes apagadas se houver fotoperíodo e, entre opções iguais, a mais próxima da
   agenda atual. Mostra antes → depois num alerta; Aplicar só muda o formulário (Salvar envia)
7. Salvar envia `POST /config` (inclui `quantidadeEstoque`), `POST /dosing` se algum tipo mudou, e reagenda
   notificações
8. Cores e tamanho do último frasco ficam no `localStorage`

### 3. CalibracaoPage — Calibração

**Arquivos:** `calibracao/`

**Função:** Calibração guiada da vazão (`calibrCoef`) e dose manual avulsa.

**Calibração guiada** (`step`: setup → running → measure → result → verified):
1. **Escolher:** lista das bombas com vazão estimada (`60000 / (700 × coef)` ml/min) e coeficiente; volume de
   5, 10 ou 20 ml (padrão 10; 20 é o mais preciso). Dica de proveta ou balança (1 g ≈ 1 ml)
2. **Dosando:** `POST /dose` com `origem: "Calibracao"` e cronômetro com o tempo estimado
   (`ml × 700 ms × coef` + 1,5 s). O campo do volume medido só aparece no fim (ou em "A bomba já parou")
3. **Medir:** aceita vírgula ou ponto. Se o medido ficar mais de 40% longe do pedido, pede confirmação
4. **Resultado:** pedido × medido, erro em %, coeficiente e vazão antes → depois.
   `novoCoef = coefAtual × pedido / medido` (3 casas). Salvar envia `POST /config`
5. **Conferir (opcional):** dosa de novo com o coeficiente salvo; dentro de ±3% mostra "Bomba calibrada",
   senão oferece "Ajustar de novo" a partir dessa medição

**Acionamento manual:** `POST /dose` com `origem: "Manual"`, botão mostra a duração estimada; doses acima de
10 ml pedem confirmação. O firmware também usa "Manual" quando a origem não vem no pedido.

### 4. LogsPage — Histórico

**Arquivos:** `logs/`

**Função:** Histórico de doses agrupado por dia.

- Cabeçalho de cada dia ("Hoje", "Ontem", "Qua, 28/10") com nº de doses, total em ml e doses sem registro.
- Linhas compactas (hora, bomba com nome atual e cor, dose, origem quando não é programada), em ordem cronológica
  junto com as doses **não executadas** dos últimos 7 dias (`findMissedDoses`, em âmbar).
- Filtros por bomba e por origem (Programado / Dose manual / Calibração).
- Mostra 7 dias por vez ("Mostrar mais dias"); atualizar arrastando para baixo (`ion-refresher`).
- Menu ⋯: Atualizar, **Exportar CSV** (`;` e vírgula decimal; no Android grava em cache e abre o compartilhar via
  `@capacitor/filesystem` + `@capacitor/share`, no navegador baixa o arquivo) e **Apagar todos os logs** com
  confirmação (opção "Exportar e apagar").
- Funções puras em `services/log-analytics.ts` (`parseLogs`, `groupByDay`, `toCsv`).

### 5. AnalyticsPage — Gráficos

**Arquivos:** `analytics/`

- **Período:** Dia / 7 dias / 30 dias. Resumo: ml dosados, % de doses executadas e ml de doses manuais. Quando os
  logs não cobrem o período inteiro, avisa a data do registro mais antigo.
- **Dia:** timeline (Chart.js scatter) com o nome das bombas no eixo, setas para dias anteriores e estados:
  executada (losango), programada (círculo claro), sem registro (círculo vazado âmbar) e manual (triângulo). A
  linha da hora atual e os rótulos de dose vêm de um plugin aplicado só neste gráfico.
- **7/30 dias:** barras empilhadas de ml por dia e por bomba (`dailySeries`).
- **Por bomba:** total, média ml/dia, % executadas (agenda atual × registros "Programado") e previsão de fim do
  estoque pelo consumo real dos últimos 7 dias (`stockForecast`).
- **Parâmetros:** KH, Ca ou Mg ao longo das sessões do Ajuste de Dosagem (`paramSeries`), com linha do alvo e
  losango laranja nas datas em que as doses foram ajustadas.

### 6. AjustePage — Ajuste de Dosagem (`/ajuste`)

Ciclo semanal: o usuário mede KH e Ca (Mg opcional), escolhe o período (3/5/7/10/14 dias), mede de novo e o app
calcula a nova dose diária de cada bomba.
- Cálculo em `services/dosing-advisor.ts`: potência efetiva (`eleva × porLitros / volume / doseMl`), consumo
  (`doseInício × potência − variação/dia`), correção rumo ao alvo limitada por subida máxima/dia e trava de ±30 %
  por ciclo. A dose é repartida nos horários ativos em passos de 0,5 ml (maior resto), sem furar a trava.
- Bombas sem teste (K, carbono) seguem outra bomba por um fator (`vinculo`).
- Card de sugestões (`services/dosing-rules.ts`): KH e Ca a menos de N min, dose de KH concentrada, teto diário,
  KH com luz acesa (se houver fotoperíodo), estoque baixo, Mg/Ca, teste vencido, cadastro incompleto e relógio do
  ESP32 fora de sincronia. Correções (mover horário, sincronizar relógio) só com confirmação.
- **Aplicar** grava as doses (`POST /config`), fecha a sessão no histórico e abre a próxima com as medidas finais.

### 7. ProdutosPage — Produtos (`/produtos`)

Volume e alvos do aquário, fotoperíodo, e por bomba: tipo (KH, Cálcio, Magnésio, Reef salt, Kalkwasser, Potássio, Iodo, Ferro, Estrôncio, elementos-traço,
Nitrato, Fosfato, Carbono, Bactérias, Aminoácidos, Alimento líquido, Outro; também escolhido na Configuração), produto, potência do
rótulo, vínculo com outra bomba, limites e regras. Tudo salvo no ESP32 via `GET/POST /dosing`.

**Catálogo de produtos** (`services/product-catalog.ts`): cerca de 80 suplementos líquidos (Aquaforest, Red Sea,
Tropic Marin, Fauna Marin, Brightwell, Seachem, Veromar, OceanTech) com a potência publicada pelo fabricante e o link
da fonte. Ao escolher o tipo, o seletor "Produto" lista só os daquele tipo; escolher um preenche nome e potência
(o perfil guarda `catalogoId`), e "Outro" libera o campo de texto. Produtos em pó (Balling Aquaforest, Red Sea, Veromar)
guardam a potência por grama (`po.elevaPorGrama`): em Produtos o usuário informa a concentração da solução que
preparou (g/L, padrão = receita do fabricante) e a potência é recalculada (`powderPotency`, salvo em `gramasPorLitro`). Ficaram de fora os que não publicam número (All-For-Reef, Trace-Colors D, ESV B-Ionic…).
Para adicionar um produto, inclua uma linha no array com `fonte` oficial; `product-catalog.spec.ts` confere ids,
tipos e potências.

### Notificações locais (`services/dose-notifications.service.ts`)

Só no Android (`@capacitor/local-notifications`). O celular agenda sozinho, sem falar com o ESP32:
- uma notificação semanal por horário ativo × dia ("Dosagem programada — Cálcio (Bomba 2): 4,0 ml");
- o lembrete de fim do teste.
Reagenda ao abrir Home/Ajuste, salvar Configuração/Produtos e aplicar ajustes. Usa `SCHEDULE_EXACT_ALARM`
(Android 12+). A Home também confere os logs (`services/dose-check.ts`) e lista doses programadas sem registro.

## Serviços

### DoserService (`services/doser.service.ts`)

**Singleton** global (`providedIn: 'root'`). Injeta `HttpClient` e `WifiBindingService`.

**Base URL:** `http://192.168.4.1`

**Métodos:**

| Método | HTTP | Descrição |
|---|---|---|
| `getStatus()` | `GET /status` | Status do dispositivo. Mapeia `RawStatus` → `DeviceStatus`. |
| `getConfig()` | `GET /config` | Config das bombas. Mapeia `RawConfig` (objeto chaveado) → `BombConfig[]`; a quantidade vem do maior `bombN` retornado pelo firmware (`bombCount = 5` é só fallback). Suporta legacy (schedule único) e novo formato (array). |
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
  origem: string;          // "Programado" | "Manual" | "Calibracao" ("Teste" em logs antigos)
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
| `home.page.spec.ts` | Deve criar a página (falha hoje: falta `HttpClient` no TestBed) |
| `services/dosing-advisor.spec.ts` | Cálculo do ajuste e repartição em 0,5 ml |
| `services/dosing-rules.spec.ts` | Regras e sugestões |
| `services/auto-schedule.spec.ts` | Horário automático |
| `services/product-catalog.spec.ts` | Consistência do catálogo de produtos |
| `services/dose-check.spec.ts` | Conferência de doses no log |
| `services/today-summary.spec.ts` | Resumo do dia da Home |
| `services/log-analytics.spec.ts` | Agrupamento, estatísticas, séries e CSV dos logs |

**Não há testes** para: `DoserService`, `WifiBindingService`, demais páginas, pipes, diretivas, ou integração HTTP.

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
→ seleciona bomba + volume (5/10/20 ml) → POST /dose (origem: Calibracao)
→ cronômetro do tempo estimado → digita o volume medido → recalcula calibrCoef
→ POST /config com novo coeficiente → (opcional) conferir com nova dose
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
