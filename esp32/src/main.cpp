#include <Arduino.h>
#include <Wire.h>
#include <RTClib.h>
#include <WiFi.h>
#include <Preferences.h>
#include <Firebase_ESP_Client.h>
#include <ArduinoJson.h>
#include <AsyncTCP.h>
#include <ESPAsyncWebServer.h>
#include <Adafruit_NeoPixel.h>

// --- Configurações Gerais ---
#define TEMPO_POR_ML 700
#define BOMBA1_PIN 4
#define BOMBA2_PIN 5
#define BOMBA3_PIN 6
#define LED_PIN 48
#define LED_COUNT 1
#define I2C_SDA 21
#define I2C_SCL 20

#define MAX_PUMP_QUEUE 10
#define MAX_PENDING_LOGS 10
#define LOG_INTERVAL 500
#define CONFIG_DOC_SIZE 8192

// --- Wi-Fi ---
const char* AP_SSID = "AquaBalancePro";
const char* AP_PASSWORD = "12345678";

const char* STA_SSID = "ClaroRodrigues";
const char* STA_PASSWORD = "@RafaelDvl1707";

// --- Firebase ---
#define API_KEY "AIzaSyDnUQ4Y12V4R7YKjRJtrWI61FmR5-HGSZU"
#define DATABASE_URL "https://firedoser-default-rtdb.firebaseio.com/"

// --- Objetos Globais ---
RTC_DS3231 rtc;
Preferences preferences;
FirebaseData fbdo;
FirebaseAuth auth;
FirebaseConfig config;
AsyncWebServer server(80);
Adafruit_NeoPixel statusLed(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

// --- Variáveis de Controle ---
unsigned long lastFirebaseReconnectAttempt = 0;
const unsigned long firebaseReconnectInterval = 600000;
unsigned long lastWifiAttempt = 0;
const unsigned long wifiReconnectInterval = 15000;

// --- Estruturas ---
struct PendingLog {
  int bombaIndex;
  float dosagem;
  String origem;
  DateTime timestamp;
};

PendingLog pendingLogs[MAX_PENDING_LOGS];
volatile int pendingHead = 0;
volatile int pendingTail = 0;
unsigned long lastLogAttempt = 0;

struct Schedule {
  int hour;
  int minute;
  float dosagem;
  bool status;
  bool diasSemana[7];
  long lastRunMinute;

  Schedule() {
    hour = 0;
    minute = 0;
    dosagem = 0;
    status = false;
    lastRunMinute = -1;
    for (int i = 0; i < 7; i++) {
      diasSemana[i] = false;
    }
  }
};

struct Bomb {
  String name;
  float calibrCoef;
  float quantidadeEstoque;
  Schedule schedules[3];

  Bomb() {
    name = "";
    calibrCoef = 1.0f;
    quantidadeEstoque = 0.0f;
  }
};

Bomb bombas[3];

struct PumpJob {
  int bombaIndex;
  float dosagem;
  String origem;
  DateTime timestamp;
};

PumpJob pumpQueue[MAX_PUMP_QUEUE];
volatile int pumpHead = 0;
volatile int pumpTail = 0;
bool pumpActive = false;
PumpJob activeJob;
unsigned long pumpStartTime = 0;
unsigned long pumpDuration = 0;
portMUX_TYPE pumpQueueMux = portMUX_INITIALIZER_UNLOCKED;

bool rtcReady = false;
bool prefsReady = false;
bool systemReady = false;

enum LedMode {
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

// --- Funções Auxiliares ---

String formatTimestamp(const DateTime& now) {
  char buffer[20];
  snprintf(buffer, sizeof(buffer), "%02d/%02d/%04d %02d:%02d",
           now.day(), now.month(), now.year(), now.hour(), now.minute());
  return String(buffer);
}

const char* wifiStatusToString(wl_status_t status) {
  switch (status) {
    case WL_IDLE_STATUS: return "idle";
    case WL_NO_SSID_AVAIL: return "no ssid";
    case WL_SCAN_COMPLETED: return "scan completed";
    case WL_CONNECTED: return "connected";
    case WL_CONNECT_FAILED: return "connect failed";
    case WL_CONNECTION_LOST: return "connection lost";
    case WL_DISCONNECTED: return "disconnected";
    default: return "unknown";
  }
}

void logWifiStatusChange() {
  static wl_status_t lastStatus = (wl_status_t)-1;
  wl_status_t status = WiFi.status();
  if (status == lastStatus) {
    return;
  }

  lastStatus = status;
  Serial.printf("[wifi] status: %s\n", wifiStatusToString(status));
  if (status == WL_CONNECTED) {
    Serial.printf("[wifi] ip: %s, rssi: %d\n",
                  WiFi.localIP().toString().c_str(),
                  WiFi.RSSI());
  }
}

void logFirebaseStatusChange() {
  static bool lastReady = false;
  static bool initialized = false;
  bool ready = Firebase.ready();
  if (initialized && ready == lastReady) {
    return;
  }

  initialized = true;
  lastReady = ready;
  Serial.printf("[firebase] status: %s\n", ready ? "ready" : "not ready");
}

bool parseDateTime(const String& value, DateTime& output) {
  int dia, mes, ano, hora, minuto, segundo;
  int parsed = sscanf(value.c_str(), "%d/%d/%d %d:%d:%d",
                      &dia, &mes, &ano, &hora, &minuto, &segundo);
  if (parsed == 6) {
    output = DateTime(ano, mes, dia, hora, minuto, segundo);
    return true;
  }

  parsed = sscanf(value.c_str(), "%d/%d/%d %d:%d",
                  &dia, &mes, &ano, &hora, &minuto);
  if (parsed == 5) {
    output = DateTime(ano, mes, dia, hora, minuto, 0);
    return true;
  }

  return false;
}

void enqueuePendingLog(int bombaIndex, float dosagem, const String& origem, const DateTime& timestamp) {
  int nextTail = (pendingTail + 1) % MAX_PENDING_LOGS;
  if (nextTail == pendingHead) {
    Serial.println("[log] fila cheia, descartando log");
    return;
  }

  pendingLogs[pendingTail] = { bombaIndex, dosagem, origem, timestamp };
  pendingTail = nextTail;
}

bool enqueuePumpJob(int bombaIndex, float dosagem, const String& origem) {
  if (bombaIndex < 0 || bombaIndex >= 3 || dosagem <= 0) {
    return false;
  }

  DateTime now = rtc.now();
  bool queued = false;

  portENTER_CRITICAL(&pumpQueueMux);
  int nextTail = (pumpTail + 1) % MAX_PUMP_QUEUE;
  if (nextTail != pumpHead) {
    pumpQueue[pumpTail] = { bombaIndex, dosagem, origem, now };
    pumpTail = nextTail;
    queued = true;
  }
  portEXIT_CRITICAL(&pumpQueueMux);

  if (!queued) {
    Serial.println("[pump] fila cheia, descartando acionamento");
  }

  return queued;
}

int pumpPinForIndex(int bombaIndex) {
  switch (bombaIndex) {
    case 0: return BOMBA1_PIN;
    case 1: return BOMBA2_PIN;
    case 2: return BOMBA3_PIN;
    default: return BOMBA1_PIN;
  }
}

void resetSchedule(Schedule& schedule) {
  schedule = Schedule();
}

void saveBombasConfig(); // Prototipo

void initDefaultBombasConfig() {
  for (int i = 0; i < 3; i++) {
    bombas[i].name = "Bomba " + String(i + 1);
    bombas[i].calibrCoef = 1.0f;
    bombas[i].quantidadeEstoque = 1000.0f;

    for (int j = 0; j < 3; j++) {
      resetSchedule(bombas[i].schedules[j]);
    }
  }
  saveBombasConfig();
  Serial.println("[config] configuração padrão inicializada");
}

void setLedColor(uint8_t red, uint8_t green, uint8_t blue) {
  uint32_t color = statusLed.Color(red, green, blue);
  if (color == currentLedColor) {
    return;
  }
  statusLed.setPixelColor(0, color);
  statusLed.show();
  currentLedColor = color;
}

void updateLedMode(LedMode mode) {
  if (ledMode == mode) {
    return;
  }
  ledMode = mode;
  ledLastToggle = millis();
  ledBlinkOn = true;
  noNetBlinkActive = false;
  lastNoNetBlink = millis();

  if (mode == LED_MODE_READY || mode == LED_MODE_NO_NET) {
    setLedColor(0, 255, 0);
    ledBlinkOn = false;
  } else if (mode == LED_MODE_BOOT) {
    setLedColor(255, 0, 0);
  } else if (mode == LED_MODE_DOSING) {
    setLedColor(0, 0, 255);
  }
}

void updateStatusLed() {
  if (pumpActive) {
    updateLedMode(LED_MODE_DOSING);
  } else if (!systemReady) {
    updateLedMode(LED_MODE_BOOT);
  } else if (WiFi.status() != WL_CONNECTED || !Firebase.ready()) {
    updateLedMode(LED_MODE_NO_NET);
  } else {
    updateLedMode(LED_MODE_READY);
  }

  unsigned long now = millis();
  switch (ledMode) {
    case LED_MODE_BOOT: {
      if (now - ledLastToggle >= 500) {
        ledLastToggle = now;
        ledBlinkOn = !ledBlinkOn;
      }
      setLedColor(ledBlinkOn ? 255 : 0, 0, 0);
      break;
    }
    case LED_MODE_DOSING: {
      if (now - ledLastToggle >= 300) {
        ledLastToggle = now;
        ledBlinkOn = !ledBlinkOn;
      }
      setLedColor(0, 0, ledBlinkOn ? 255 : 0);
      break;
    }
    case LED_MODE_NO_NET: {
      if (!noNetBlinkActive && now - lastNoNetBlink >= 5000) {
        noNetBlinkActive = true;
        noNetBlinkStart = now;
        setLedColor(0, 0, 0);
      } else if (noNetBlinkActive && now - noNetBlinkStart >= 150) {
        noNetBlinkActive = false;
        lastNoNetBlink = now;
        setLedColor(0, 255, 0);
      } else if (!noNetBlinkActive) {
        setLedColor(0, 255, 0);
      }
      break;
    }
    case LED_MODE_READY:
    default:
      setLedColor(0, 255, 0);
      break;
  }
}

void finishPumpJob() {
  int bombaIndex = activeJob.bombaIndex;
  int pin = pumpPinForIndex(bombaIndex);
  digitalWrite(pin, LOW);
  pumpActive = false;

  if (bombas[bombaIndex].quantidadeEstoque > 0) {
    bombas[bombaIndex].quantidadeEstoque -= activeJob.dosagem;
    if (bombas[bombaIndex].quantidadeEstoque < 0) {
      bombas[bombaIndex].quantidadeEstoque = 0;
    }
  }

  saveBombasConfig();
  enqueuePendingLog(bombaIndex, activeJob.dosagem, activeJob.origem, activeJob.timestamp);
}

void startNextPumpJob() {
  if (pumpActive) {
    return;
  }

  PumpJob nextJob;
  bool hasJob = false;

  portENTER_CRITICAL(&pumpQueueMux);
  if (pumpHead != pumpTail) {
    nextJob = pumpQueue[pumpHead];
    pumpHead = (pumpHead + 1) % MAX_PUMP_QUEUE;
    hasJob = true;
  }
  portEXIT_CRITICAL(&pumpQueueMux);

  if (!hasJob) {
    return;
  }

  activeJob = nextJob;

  float coef = bombas[activeJob.bombaIndex].calibrCoef;
  pumpDuration = (unsigned long)(activeJob.dosagem * TEMPO_POR_ML * coef);
  pumpStartTime = millis();
  pumpActive = true;

  int pin = pumpPinForIndex(activeJob.bombaIndex);
  digitalWrite(pin, HIGH);
}

void processPumpQueue() {
  if (pumpActive) {
    if (millis() - pumpStartTime >= pumpDuration) {
      finishPumpJob();
    }
    return;
  }

  startNextPumpJob();
}

// --- JSON e Configuração ---

String buildConfigJson() {
  JsonDocument doc;

  for (int i = 0; i < 3; i++) {
    String bombaKey = "bomb" + String(i + 1);
    JsonObject bomba = doc[bombaKey].to<JsonObject>();

    bomba["name"] = bombas[i].name;
    bomba["calibrCoef"] = bombas[i].calibrCoef;
    bomba["quantidadeEstoque"] = bombas[i].quantidadeEstoque;

    JsonArray schedules = bomba["schedules"].to<JsonArray>();
    for (int j = 0; j < 3; j++) {
      JsonObject schedule = schedules.add<JsonObject>();
      schedule["id"] = j + 1;
      JsonObject timeObj = schedule["time"].to<JsonObject>();
      timeObj["hour"] = bombas[i].schedules[j].hour;
      timeObj["minute"] = bombas[i].schedules[j].minute;
      schedule["dosagem"] = bombas[i].schedules[j].dosagem;
      schedule["status"] = bombas[i].schedules[j].status;

      JsonArray dias = schedule["diasSemanaSelecionados"].to<JsonArray>();
      for (int d = 0; d < 7; d++) {
        dias.add(bombas[i].schedules[j].diasSemana[d]);
      }
    }
  }

  String json;
  serializeJson(doc, json);
  return json;
}

void saveBombasConfig() {
  String json = buildConfigJson();
  preferences.putString("bombas", json);
}

void loadScheduleFromLegacy(JsonObject bomba, Schedule& schedule) {
  resetSchedule(schedule);
  JsonObject timeObj = bomba["time"].as<JsonObject>();
  schedule.hour = timeObj["hour"] | 0;
  schedule.minute = timeObj["minute"] | 0;
  schedule.dosagem = bomba["dosagem"] | 0.0f;
  schedule.status = bomba["status"] | false;

  if (bomba["diasSemanaSelecionados"]) {
    JsonArray dias = bomba["diasSemanaSelecionados"].as<JsonArray>();
    for (int d = 0; d < 7; d++) {
      schedule.diasSemana[d] = dias[d] | false;
    }
  }
}

// Função Auxiliar para carregar dados de uma bomba do JSON
void parseBombData(int i, JsonObject bomba) {
    // Correção Clean para ArduinoJson v7:
    // Evita erro de StringSumHelper usando .is<String>() ou verificando nulidade
    if (bomba["name"].is<const char*>()) {
        bombas[i].name = bomba["name"].as<String>();
    } else {
        bombas[i].name = "Bomba " + String(i + 1);
    }

    bombas[i].calibrCoef = bomba["calibrCoef"] | 1.0f;
    bombas[i].quantidadeEstoque = bomba["quantidadeEstoque"] | 0.0f;

    if (bomba["schedules"]) {
      JsonArray schedules = bomba["schedules"].as<JsonArray>();
      for (int j = 0; j < 3; j++) {
        JsonObject schedule = schedules[j];
        if (schedule.isNull()) {
          resetSchedule(bombas[i].schedules[j]);
          continue;
        }

        resetSchedule(bombas[i].schedules[j]);
        JsonObject timeObj = schedule["time"].as<JsonObject>();
        bombas[i].schedules[j].hour = timeObj["hour"] | 0;
        bombas[i].schedules[j].minute = timeObj["minute"] | 0;
        bombas[i].schedules[j].dosagem = schedule["dosagem"] | 0.0f;
        bombas[i].schedules[j].status = schedule["status"] | false;

        if (schedule["diasSemanaSelecionados"]) {
          JsonArray dias = schedule["diasSemanaSelecionados"].as<JsonArray>();
          for (int d = 0; d < 7; d++) {
            bombas[i].schedules[j].diasSemana[d] = dias[d] | false;
          }
        } else {
          for (int d = 0; d < 7; d++) {
            bombas[i].schedules[j].diasSemana[d] = false;
          }
        }
      }
    } else {
      loadScheduleFromLegacy(bomba, bombas[i].schedules[0]);
      resetSchedule(bombas[i].schedules[1]);
      resetSchedule(bombas[i].schedules[2]);
    }

    for (int j = 0; j < 3; j++) {
      bombas[i].schedules[j].lastRunMinute = -1;
    }
}

void loadBombasConfig() {
  String configJson = preferences.getString("bombas", "");
  if (configJson.isEmpty()) {
    initDefaultBombasConfig();
    return;
  }

  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, configJson);
  if (error) {
    Serial.println("[config] erro ao ler JSON");
    return;
  }

  for (int i = 0; i < 3; i++) {
    String bombaKey = "bomb" + String(i + 1);
    JsonObject bomba = doc[bombaKey];
    if (bomba.isNull()) continue;
    parseBombData(i, bomba);
  }
}

bool applyConfigJson(const String& json) {
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, json);
  if (error) {
    Serial.println("[config] JSON invalido");
    return false;
  }

  for (int i = 0; i < 3; i++) {
    String bombaKey = "bomb" + String(i + 1);
    JsonObject bomba = doc[bombaKey];
    if (bomba.isNull()) continue;
    parseBombData(i, bomba);
  }

  saveBombasConfig();
  return true;
}

// --- Firebase Logs ---

void processPendingLogs() {
  if (pendingHead == pendingTail) {
    return;
  }

  if (millis() - lastLogAttempt < LOG_INTERVAL) {
    return;
  }

  lastLogAttempt = millis();
  PendingLog& log = pendingLogs[pendingHead];

  String path = "/logs/" + String(log.timestamp.unixtime());
  FirebaseJson json;
  json.set("timestamp", formatTimestamp(log.timestamp));
  json.set("bomba", bombas[log.bombaIndex].name);
  json.set("dosagem", log.dosagem);
  json.set("origem", log.origem);

  if (!Firebase.ready() && millis() - lastFirebaseReconnectAttempt > firebaseReconnectInterval) {
    lastFirebaseReconnectAttempt = millis();
    Serial.println("[firebase] refresh token");
    Firebase.refreshToken(&config);
    Firebase.begin(&config, &auth);
  }

  if (Firebase.ready() && Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json)) {
    pendingHead = (pendingHead + 1) % MAX_PENDING_LOGS;
  }
}

String getTokenType(TokenInfo info) {
  switch (info.type) {
    case token_type_undefined: return "undefined";
    case token_type_legacy_token: return "legacy token";
    case token_type_id_token: return "id token";
    case token_type_custom_token: return "custom token";
    case token_type_oauth2_access_token: return "OAuth2.0 access token";
    default: return "unknown";
  }
}

String getTokenStatus(TokenInfo info) {
  switch (info.status) {
    case token_status_uninitialized: return "uninitialized";
    case token_status_on_signing: return "on signing";
    case token_status_on_request: return "on request";
    case token_status_on_refresh: return "on refreshing";
    case token_status_ready: return "ready";
    case token_status_error: return "error";
    default: return "unknown";
  }
}

void tokenStatusCallback(TokenInfo info) {
  Serial.printf("[firebase] token: %s / %s\n",
                getTokenType(info).c_str(),
                getTokenStatus(info).c_str());
}

void initFirebase() {
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  config.token_status_callback = tokenStatusCallback;

  auth.user.email = "rafaelrodrigues.dsg3d@gmail.com";
  auth.user.password = "@FireDoser123";

  Serial.println("[firebase] init begin");
  Firebase.begin(&config, &auth);
  Firebase.reconnectWiFi(true);
}

// --- Setup e Handlers WebServer ---

void setupWifi() {
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAPConfig(IPAddress(192, 168, 4, 1), IPAddress(192, 168, 4, 1), IPAddress(255, 255, 255, 0));
  // IP padrão AP: 192.168.4.1
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  Serial.printf("[wifi] AP started: %s (%s)\n", AP_SSID, WiFi.softAPIP().toString().c_str());
  WiFi.begin(STA_SSID, STA_PASSWORD);
  Serial.printf("[wifi] STA begin: %s\n", STA_SSID);
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
}

void ensureStaWifi() {
  if (WiFi.status() == WL_CONNECTED) {
    return;
  }

  if (millis() - lastWifiAttempt < wifiReconnectInterval) {
    return;
  }

  lastWifiAttempt = millis();
  Serial.printf("[wifi] reconnecting to: %s\n", STA_SSID);
  WiFi.disconnect();
  WiFi.begin(STA_SSID, STA_PASSWORD);
}

void handleStatus(AsyncWebServerRequest* request) {
  JsonDocument doc; // v7
  DateTime now = rtc.now();

  doc["time"] = formatTimestamp(now);

  JsonObject wifi = doc["wifi"].to<JsonObject>();
  bool wifiConnected = (WiFi.status() == WL_CONNECTED);
  wifi["connected"] = wifiConnected;
  wifi["rssi"] = wifiConnected ? WiFi.RSSI() : 0;
  wifi["ip"] = wifiConnected ? WiFi.localIP().toString() : "";

  JsonObject ap = doc["ap"].to<JsonObject>();
  ap["ssid"] = AP_SSID;
  ap["ip"] = WiFi.softAPIP().toString();

  JsonObject firebase = doc["firebase"].to<JsonObject>();
  firebase["ready"] = Firebase.ready();

  String payload;
  serializeJson(doc, payload);
  request->send(200, "application/json", payload);
}

void handleGetConfig(AsyncWebServerRequest* request) {
  request->send(200, "application/json", buildConfigJson());
}

void handlePostConfig(AsyncWebServerRequest* request) {
  if (!request->hasParam("plain", true)) {
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"body ausente\"}");
    return;
  }

  String body = request->getParam("plain", true)->value();
  bool ok = applyConfigJson(body);
  if (ok) {
    request->send(200, "application/json", "{\"ok\":true}");
  } else {
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"json invalido\"}");
  }
}

void handlePostTime(AsyncWebServerRequest* request) {
  if (!request->hasParam("plain", true)) {
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"body ausente\"}");
    return;
  }

  String body = request->getParam("plain", true)->value();
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, body);
  if (error) {
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"json invalido\"}");
    return;
  }

  // Correção v7: Conversão explícita
  String timeString = doc["time"].as<String>();

  DateTime parsed;
  if (!parseDateTime(timeString, parsed)) {
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"formato de data invalido\"}");
    return;
  }

  rtc.adjust(parsed);
  request->send(200, "application/json", "{\"ok\":true}");
}

void handlePostDose(AsyncWebServerRequest* request) {
  if (!request->hasParam("plain", true)) {
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"body ausente\"}");
    return;
  }

  String body = request->getParam("plain", true)->value();
  JsonDocument doc;
  DeserializationError error = deserializeJson(doc, body);
  if (error) {
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"json invalido\"}");
    return;
  }

  int bomba = doc["bomb"] | 0;
  float dosagem = doc["dosagem"] | 0.0f;
  if (bomba < 1 || bomba > 3 || dosagem <= 0) {
    request->send(400, "application/json", "{\"ok\":false,\"message\":\"dados invalidos\"}");
    return;
  }

  bool queued = enqueuePumpJob(bomba - 1, dosagem, "Teste");
  if (!queued) {
    request->send(409, "application/json", "{\"ok\":false,\"message\":\"fila cheia\"}");
    return;
  }

  request->send(200, "application/json", "{\"ok\":true}");
}

void setupServer() {
  server.on("/status", HTTP_GET, handleStatus);
  server.on("/config", HTTP_GET, handleGetConfig);
  server.on("/config", HTTP_POST, handlePostConfig);
  server.on("/time", HTTP_POST, handlePostTime);
  server.on("/dose", HTTP_POST, handlePostDose);

  server.onNotFound([](AsyncWebServerRequest* request) {
    request->send(404, "application/json", "{\"ok\":false,\"message\":\"rota nao encontrada\"}");
  });

  server.begin();
}

void inicializarBombas() {
  pinMode(BOMBA1_PIN, OUTPUT);
  pinMode(BOMBA2_PIN, OUTPUT);
  pinMode(BOMBA3_PIN, OUTPUT);
  digitalWrite(BOMBA1_PIN, LOW);
  digitalWrite(BOMBA2_PIN, LOW);
  digitalWrite(BOMBA3_PIN, LOW);
}

void checkSchedules() {
  static int lastMinute = -1;
  static unsigned long lastCheck = 0;

  if (millis() - lastCheck < 1000) {
    return;
  }

  lastCheck = millis();
  DateTime now = rtc.now();
  if (now.minute() == lastMinute) {
    return;
  }

  lastMinute = now.minute();
  int diaSemana = now.dayOfTheWeek();
  long minuteKey = now.unixtime() / 60;

  for (int i = 0; i < 3; i++) {
    for (int j = 0; j < 3; j++) {
      Schedule& schedule = bombas[i].schedules[j];
      if (!schedule.status) {
        continue;
      }
      if (schedule.lastRunMinute == minuteKey) {
        continue;
      }
      if (!schedule.diasSemana[diaSemana]) {
        continue;
      }
      if (schedule.hour == now.hour() && schedule.minute == now.minute()) {
        schedule.lastRunMinute = minuteKey;
        enqueuePumpJob(i, schedule.dosagem, "Programado");
      }
    }
  }
}

// --- Loop Principal ---

void setup() {
  Serial.begin(115200);
  inicializarBombas();

  // Iniciar Wire com pinos específicos para ESP32-S3
  Wire.begin(I2C_SDA, I2C_SCL);

  rtcReady = rtc.begin();
  if (!rtcReady) {
    Serial.println("[rtc] erro ao iniciar");
    // Se quiser garantir que o RTC roda, pode descomentar:
    // rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));
  }

  prefsReady = preferences.begin("bomb-config", false);
  if (prefsReady) {
    loadBombasConfig();
  }
  systemReady = rtcReady && prefsReady;

  statusLed.begin();
  Serial.println("[led] iniciando LED RGB no GPIO 48");
  statusLed.setBrightness(30);
  statusLed.setPixelColor(0, statusLed.Color(255, 0, 0));
  statusLed.show();
  Serial.println("[led] LED deve estar VERMELHO agora");

  setupWifi();
  initFirebase();
  setupServer();
}

void loop() {
  ensureStaWifi();
  processPendingLogs();
  checkSchedules();
  processPumpQueue();
  updateStatusLed();
  logWifiStatusChange();
  logFirebaseStatusChange();
}
