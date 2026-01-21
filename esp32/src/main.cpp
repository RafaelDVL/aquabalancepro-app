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
#include <time.h>

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
const char *AP_SSID = "AquaBalancePro";
const char *AP_PASSWORD = "12345678";

// Preencha com seus dados (não publique credenciais em repositório)
const char *STA_SSID = "<SEU_SSID>";
const char *STA_PASSWORD = "<SUA_SENHA>";
constexpr bool kApOnlyMode = false;
constexpr bool kFirebaseEnabled = false;  // NOVO: Desabilita Firebase

// --- Firebase ---
#define API_KEY "<SUA_FIREBASE_API_KEY>"
#define DATABASE_URL "<SUA_DATABASE_URL>"

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
const unsigned long firebaseStatusLogInterval = 10000;

unsigned long lastWifiAttempt = 0;
const unsigned long wifiReconnectInterval = 15000;

volatile uint8_t apClientCount = 0;
bool staEnabled = false;
bool firebaseInitialized = false;

unsigned long lastTimeSyncAttempt = 0;
const unsigned long timeSyncInterval = 60000;
bool timeSynced = false;
const long gmtOffsetSec = -3 * 3600;
const int daylightOffsetSec = 0;

// --- Estruturas ---
struct PendingLog
{
  int bombaIndex;
  float dosagem;
  String origem;
  DateTime timestamp;
};

PendingLog pendingLogs[MAX_PENDING_LOGS];
volatile int pendingHead = 0;
volatile int pendingTail = 0;
unsigned long lastLogAttempt = 0;

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
  Schedule schedules[3];

  Bomb()
  {
    name = "";
    calibrCoef = 1.0f;
    quantidadeEstoque = 0.0f;
  }
};

Bomb bombas[3];

struct PumpJob
{
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
// Forward declarations (PROTÓTIPOS) — corrigem “scope” em .cpp
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

// Firebase
void initFirebase();
bool isFirebaseReady();
void logFirebaseStatusChange();
void processPendingLogs();

// Tempo / NTP
void ensureTimeSynced();

// Server
void setupServer();
void handleStatus(AsyncWebServerRequest *request);
void handleGetConfig(AsyncWebServerRequest *request);
void handlePostConfig(AsyncWebServerRequest *request);
void handlePostTime(AsyncWebServerRequest *request);
void handlePostDose(AsyncWebServerRequest *request);
void storeRequestBody(AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total);
bool readRequestBody(AsyncWebServerRequest *request, String &body);

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

// Scheduler
void checkSchedules();

// Pump queue
bool enqueuePumpJob(int bombaIndex, float dosagem, const String &origem);
void enqueuePendingLog(int bombaIndex, float dosagem, const String &origem, const DateTime &timestamp);
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

bool isFirebaseReady()
{
  if (!kFirebaseEnabled) return true;  // Simula "pronto" para não bloquear
  return firebaseInitialized && Firebase.ready();
}

// =========================================================
// Firebase
// =========================================================
String getTokenType(TokenInfo info)
{
  switch (info.type)
  {
  case token_type_undefined:           return "undefined";
  case token_type_legacy_token:        return "legacy token";
  case token_type_id_token:            return "id token";
  case token_type_custom_token:        return "custom token";
  case token_type_oauth2_access_token: return "OAuth2.0 access token";
  default:                             return "unknown";
  }
}

String getTokenStatus(TokenInfo info)
{
  switch (info.status)
  {
  case token_status_uninitialized: return "uninitialized";
  case token_status_on_signing:    return "on signing";
  case token_status_on_request:    return "on request";
  case token_status_on_refresh:    return "on refreshing";
  case token_status_ready:         return "ready";
  case token_status_error:         return "error";
  default:                         return "unknown";
  }
}

void tokenStatusCallback(TokenInfo info)
{
  Serial.printf("[firebase] token: %s / %s\n",
                getTokenType(info).c_str(),
                getTokenStatus(info).c_str());
  if (info.status == token_status_error)
  {
    Serial.printf("[firebase] token error: %s (%d)\n",
                  info.error.message.c_str(),
                  info.error.code);
  }
}

void initFirebase()
{
  if (!kFirebaseEnabled) {
    Serial.println("[firebase] Firebase desabilitado (kFirebaseEnabled = false)");
    return;
  }
  config.api_key = API_KEY;
  config.database_url = DATABASE_URL;
  config.token_status_callback = tokenStatusCallback;

  // Preencha com seu usuário/senha (evite hardcode em produção)
  auth.user.email = "<SEU_EMAIL>";
  auth.user.password = "<SUA_SENHA>";

  Serial.println("[firebase] Inicializando Firebase...");
  Firebase.begin(&config, &auth);
}

void processPendingLogs()
{
  if (!kFirebaseEnabled) return;  // Pula processamento
  if (pendingHead == pendingTail) return;
  if (millis() - lastLogAttempt < LOG_INTERVAL) return;

  lastLogAttempt = millis();
  PendingLog &log = pendingLogs[pendingHead];

  Serial.printf("[log] Tentando enviar log p/ Firebase: %s, %.2fml\n",
                bombas[log.bombaIndex].name.c_str(), log.dosagem);

  String path = "/logs/" + String(log.timestamp.unixtime());
  FirebaseJson json;
  json.set("timestamp", formatTimestamp(log.timestamp));
  json.set("bomba", bombas[log.bombaIndex].name);
  json.set("dosagem", log.dosagem);
  json.set("origem", log.origem);

  if (!Firebase.ready() && millis() - lastFirebaseReconnectAttempt > firebaseReconnectInterval)
  {
    lastFirebaseReconnectAttempt = millis();
    Serial.println("[firebase] refresh token (log attempt)");
    Firebase.refreshToken(&config);
    Firebase.begin(&config, &auth);
  }

  if (Firebase.ready() && Firebase.RTDB.setJSON(&fbdo, path.c_str(), &json))
  {
    Serial.println("[log] Log enviado com sucesso!");
    pendingHead = (pendingHead + 1) % MAX_PENDING_LOGS;
  }
  else
  {
    Serial.printf("[log] Falha ao enviar log: %s\n", fbdo.errorReason().c_str());
  }
}

void logFirebaseStatusChange()
{
  if (!kFirebaseEnabled) return;  // Pula log
  if (!firebaseInitialized) return;

  static bool lastReady = false;
  static bool initialized = false;
  static unsigned long lastLog = 0;

  bool ready = Firebase.ready();
  unsigned long now = millis();

  bool shouldLog = !initialized || ready != lastReady || (now - lastLog >= firebaseStatusLogInterval);
  if (!shouldLog) return;

  initialized = true;
  lastReady = ready;
  lastLog = now;

  Serial.printf("[firebase] Status: %s\n", ready ? "Pronto (Ready)" : "Nao Pronto");
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
  WiFi.mode(kApOnlyMode ? WIFI_AP : WIFI_AP_STA);
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
  if (kApOnlyMode || staEnabled || !kFirebaseEnabled) return;  // Adiciona verificação
  WiFi.setAutoReconnect(true);
  WiFi.persistent(false);
  WiFi.begin(STA_SSID, STA_PASSWORD);
  Serial.printf("[wifi] STA Habilitado. Tentando: %s\n", STA_SSID);
  staEnabled = true;

  if (!firebaseInitialized)
  {
    initFirebase();
    firebaseInitialized = true;
  }
}

void disableSta()
{
  if (!staEnabled) return;
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
  if (!kFirebaseEnabled) return;  // Desabilita tentativa de STA se Firebase off
  if (shouldPauseForAp()) return;
  if (!staEnabled) return;
  if (WiFi.status() == WL_CONNECTED) return;
  if (apClientCount > 0) return;

  if (millis() - lastWifiAttempt < wifiReconnectInterval) return;

  lastWifiAttempt = millis();
  Serial.printf("[wifi] Tentando reconectar STA: %s...\n", STA_SSID);
  WiFi.disconnect();
  WiFi.begin(STA_SSID, STA_PASSWORD);
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

    Serial.println("[firebase] Refresh token apos sync de tempo");
    Firebase.refreshToken(&config);
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

  JsonObject firebase = doc["firebase"].to<JsonObject>();
  firebase["ready"] = !shouldPauseForAp() && isFirebaseReady();

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

  if (bomba < 1 || bomba > 3 || dosagem <= 0)
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
// Config / JSON
// =========================================================
void inicializarBombas()
{
  pinMode(BOMBA1_PIN, OUTPUT);
  pinMode(BOMBA2_PIN, OUTPUT);
  pinMode(BOMBA3_PIN, OUTPUT);

  digitalWrite(BOMBA1_PIN, LOW);
  digitalWrite(BOMBA2_PIN, LOW);
  digitalWrite(BOMBA3_PIN, LOW);

  Serial.println("[system] Pinos das bombas inicializados.");
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

  for (int i = 0; i < 3; i++)
  {
    String bombaKey = "bomb" + String(i + 1);
    JsonObject bomba = doc[bombaKey].to<JsonObject>();

    bomba["name"] = bombas[i].name;
    bomba["calibrCoef"] = bombas[i].calibrCoef;
    bomba["quantidadeEstoque"] = bombas[i].quantidadeEstoque;

    JsonArray schedules = bomba["schedules"].to<JsonArray>();
    for (int j = 0; j < 3; j++)
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
  for (int i = 0; i < 3; i++)
  {
    bombas[i].name = "Bomba " + String(i + 1);
    bombas[i].calibrCoef = 1.0f;
    bombas[i].quantidadeEstoque = 1000.0f;
    for (int j = 0; j < 3; j++)
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
    for (int j = 0; j < 3; j++)
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
    resetSchedule(bombas[i].schedules[0]);
    resetSchedule(bombas[i].schedules[1]);
    resetSchedule(bombas[i].schedules[2]);
  }

  for (int j = 0; j < 3; j++)
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

  for (int i = 0; i < 3; i++)
  {
    String bombaKey = "bomb" + String(i + 1);
    JsonObject bomba = doc[bombaKey];
    if (bomba.isNull()) continue;
    parseBombData(i, bomba);
  }

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

  for (int i = 0; i < 3; i++)
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
// Scheduler (CORRIGIDO: controle por minuteKey)
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

  for (int i = 0; i < 3; i++)
  {
    for (int j = 0; j < 3; j++)
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
  if (bombaIndex < 0 || bombaIndex >= 3 || dosagem <= 0)
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

void enqueuePendingLog(int bombaIndex, float dosagem, const String &origem, const DateTime &timestamp)
{
  int nextTail = (pendingTail + 1) % MAX_PENDING_LOGS;
  if (nextTail == pendingHead)
  {
    Serial.println("[log] Fila de logs cheia! Descartando registro.");
    return;
  }

  pendingLogs[pendingTail] = {bombaIndex, dosagem, origem, timestamp};
  pendingTail = nextTail;

  Serial.printf("[log] Log enfileirado para envio: Bomba %d, %.2f ml\n", bombaIndex + 1, dosagem);
}

int pumpPinForIndex(int bombaIndex)
{
  switch (bombaIndex)
  {
  case 0: return BOMBA1_PIN;
  case 1: return BOMBA2_PIN;
  case 2: return BOMBA3_PIN;
  default: return BOMBA1_PIN;
  }
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
  enqueuePendingLog(bombaIndex, activeJob.dosagem, activeJob.origem, activeJob.timestamp);
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

  if (mode == LED_MODE_READY || mode == LED_MODE_NO_NET)
  {
    setLedColor(0, 255, 0);
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
  else if (WiFi.status() != WL_CONNECTED || (!shouldPauseForAp() && !isFirebaseReady()))
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
    }
    setLedColor(ledBlinkOn ? 255 : 0, 0, 0);
    break;

  case LED_MODE_DOSING:
    if (now - ledLastToggle >= 300)
    {
      ledLastToggle = now;
      ledBlinkOn = !ledBlinkOn;
    }
    setLedColor(0, 0, ledBlinkOn ? 255 : 0);
    break;

  case LED_MODE_NO_NET:
    if (!noNetBlinkActive && now - lastNoNetBlink >= 5000)
    {
      noNetBlinkActive = true;
      noNetBlinkStart = now;
      setLedColor(0, 0, 0);
    }
    else if (noNetBlinkActive && now - noNetBlinkStart >= 150) // CORRIGIDO: noNetBlinkStart
    {
      noNetBlinkActive = false;
      lastNoNetBlink = now;
      setLedColor(0, 255, 0);
    }
    else if (!noNetBlinkActive)
    {
      setLedColor(0, 255, 0);
    }
    break;

  case LED_MODE_READY:
  default:
    setLedColor(0, 255, 0);
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

  systemReady = rtcReady && prefsReady;

  statusLed.begin();
  statusLed.setBrightness(30);
  statusLed.setPixelColor(0, statusLed.Color(255, 0, 0));
  statusLed.show();
  Serial.println("[led] LED deve estar VERMELHO agora");

  setupWifi();
  setupServer();

  applyApPriority();
  logWifiStatusChange();
  if (!kApOnlyMode && kFirebaseEnabled)  // Adiciona verificação
    logFirebaseStatusChange();

  Serial.println("[system] Setup concluido. Entrando no loop principal...");
}

void loop()
{
  const bool pauseForAp = shouldPauseForAp();

  applyApPriority();
  ensureStaWifi();

  if (!pauseForAp && kFirebaseEnabled)  // Adiciona verificação
  {
    ensureTimeSynced();
    processPendingLogs();
  }

  checkSchedules();
  processPumpQueue();

  updateStatusLed();
  logWifiStatusChange();

  if (!pauseForAp && kFirebaseEnabled)  // Adiciona verificação
    logFirebaseStatusChange();

  delay(100);
}
