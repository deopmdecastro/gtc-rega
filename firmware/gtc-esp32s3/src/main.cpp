/**
 * GTC Rega — Firmware ESP32-S3
 * ---------------------------------------------------------------
 * Liga-se ao WiFi (portal de configuração via WiFiManager) e anuncia um
 * serviço Bluetooth Low Energy (BLE) para monitorização/comando local,
 * sincroniza com o backend GTC Rega e:
 *   - lê sensores capacitivos de humidade (B1/B2) e envia telemetria
 *   - aplica as saídas desejadas (bomba + válvulas por zona) nos relés
 *   - envia paragem de emergência quando o botão é premido (ou via BLE)
 *   - protege-se com watchdog de hardware e fail-safe em perda de rede
 */

#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <WiFiManager.h>
#include <esp_task_wdt.h>
#include <NimBLEDevice.h>

#include "config.h"
#include "webui.h"

// ── Estado ──
static String baseUrl;
static uint32_t lastPoll = 0, lastTelemetry = 0, lastSample = 0, lastOkContact = 0, lastBleNotify = 0;
static bool pumpOn = false;
static bool autoModeOn = false;
static bool zoneOn[ZONE_COUNT] = { false };
static float moistureB1 = 0, moistureB2 = 0;
static bool emergencyLatched = false;
static bool serverOnline = false;

// ── Bluetooth (BLE) ──
static NimBLEServer* bleServer = nullptr;
static NimBLECharacteristic* bleStatusChar = nullptr;
static NimBLECharacteristic* bleCommandChar = nullptr;
static bool blePeerConnected = false;

// ── Relés ──
static inline void writeRelay(int pin, bool on) {
#if RELAY_ACTIVE_LOW
  digitalWrite(pin, on ? LOW : HIGH);
#else
  digitalWrite(pin, on ? HIGH : LOW);
#endif
}

static void allOutputsOff() {
  writeRelay(PIN_RELAY_PUMP, false);
  writeRelay(PIN_RELAY_AUTO, false);
  autoModeOn = false;
  for (size_t i = 0; i < ZONE_COUNT; i++) {
    writeRelay(ZONE_RELAY_PINS[i], false);
    zoneOn[i] = false;
  }
  pumpOn = false;
}

// ── Sensores ──
static float rawToMoisture(int raw) {
  float pct = 100.0f * (SENSOR_DRY_RAW - raw) / float(SENSOR_DRY_RAW - SENSOR_WET_RAW);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

static float readSensor(int pin) {
  uint32_t acc = 0;
  for (int i = 0; i < 8; i++) { acc += analogRead(pin); delayMicroseconds(200); }
  return rawToMoisture(acc / 8);
}

static void sampleSensors() {
  // filtro exponencial para estabilizar a leitura
  float b1 = readSensor(PIN_SENSOR_B1);
  float b2 = readSensor(PIN_SENSOR_B2);
  moistureB1 = moistureB1 == 0 ? b1 : (moistureB1 * 0.8f + b1 * 0.2f);
  moistureB2 = moistureB2 == 0 ? b2 : (moistureB2 * 0.8f + b2 * 0.2f);
}

// ── Estado elétrico real dos pinos ──
// INPUT: valor lido no pino (1 = a receber sinal)
// OUTPUT: 1 quando o pino está a emitir sinal para o relé
static void gpioSnapshot(JsonObject out) {
  out[String(PIN_SENSOR_B1)] = analogRead(PIN_SENSOR_B1) > SENSOR_SIGNAL_RAW_MIN ? 1 : 0;
  out[String(PIN_SENSOR_B2)] = analogRead(PIN_SENSOR_B2) > SENSOR_SIGNAL_RAW_MIN ? 1 : 0;
  out[String(PIN_EMERGENCY_BTN)] = digitalRead(PIN_EMERGENCY_BTN) == LOW ? 1 : 0;
  out[String(PIN_RELAY_PUMP)] = pumpOn ? 1 : 0;
  out[String(PIN_RELAY_STOP)] = emergencyLatched ? 1 : 0;
  out[String(PIN_RELAY_AUTO)] = autoModeOn ? 1 : 0;
  for (size_t i = 0; i < ZONE_COUNT; i++) out[String(ZONE_RELAY_PINS[i])] = zoneOn[i] ? 1 : 0;
}

// Estado real exposto pela interface local (webui.h)
String gtcStatusJson() {
  JsonDocument doc;
  doc["deviceId"] = GTC_DEVICE_ID;
  doc["firmware"] = GTC_FIRMWARE;
  doc["online"] = WiFi.status() == WL_CONNECTED;
  doc["serverOnline"] = serverOnline;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["uptime"] = millis() / 1000;
  doc["emergency"] = emergencyLatched;
  doc["pump"] = pumpOn;
  JsonArray sensors = doc["sensors"].to<JsonArray>();
  JsonObject s1 = sensors.add<JsonObject>();
  s1["sensorId"] = "B1"; s1["moisture"] = (int)roundf(moistureB1);
  s1["ok"] = analogRead(PIN_SENSOR_B1) > SENSOR_SIGNAL_RAW_MIN;
  JsonObject s2 = sensors.add<JsonObject>();
  s2["sensorId"] = "B2"; s2["moisture"] = (int)roundf(moistureB2);
  s2["ok"] = analogRead(PIN_SENSOR_B2) > SENSOR_SIGNAL_RAW_MIN;
  gpioSnapshot(doc["gpio"].to<JsonObject>());
  String out;
  serializeJson(doc, out);
  return out;
}

void gtcLocalEmergency() {
  emergencyLatched = true;
  allOutputsOff();
  Serial.println("[EMERGENCY] paragem pela interface local");
}

// ── Bluetooth (BLE) ──
static bool httpJson(const char* method, const String& path, const String& body, JsonDocument& out); // fwd decl

// Serviço BLE simples de provisionamento/monitorização local:
//   - Característica de ESTADO (notify): replica o JSON de gtcStatusJson()
//   - Característica de COMANDO (write): aceita comandos de texto simples
//       "STOP"  -> paragem de emergência local (mesmo caminho do botão físico)
//       "RESET" -> limpa o latch de emergência
class GtcBleServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server, NimBLEConnInfo& connInfo) override {
    blePeerConnected = true;
    String addr = connInfo.getAddress().toString().c_str();
    Serial.printf("[BLE] dispositivo ligado: %s\n", addr.c_str());
    JsonDocument body, res;
    body["address"] = addr;
    body["paired"] = true;
    String payload;
    serializeJson(body, payload);
    httpJson("POST", "/api/device/bluetooth-status", payload, res); // best-effort
  }

  void onDisconnect(NimBLEServer* server, NimBLEConnInfo& connInfo, int reason) override {
    blePeerConnected = false;
    String addr = connInfo.getAddress().toString().c_str();
    Serial.println("[BLE] dispositivo desligado — a reiniciar advertising");
    JsonDocument body, res;
    body["address"] = addr;
    body["paired"] = false;
    String payload;
    serializeJson(body, payload);
    httpJson("POST", "/api/device/bluetooth-status", payload, res); // best-effort
    NimBLEDevice::startAdvertising();
  }
};

class GtcBleCommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic, NimBLEConnInfo& connInfo) override {
    String cmd = characteristic->getValue().c_str();
    cmd.trim();
    cmd.toUpperCase();
    Serial.printf("[BLE] comando recebido: %s\n", cmd.c_str());
    if (cmd == "STOP") {
      gtcLocalEmergency();
    } else if (cmd == "RESET") {
      emergencyLatched = false;
      Serial.println("[BLE] latch de emergência limpo");
    }
  }
};

static GtcBleServerCallbacks bleServerCallbacks;
static GtcBleCommandCallbacks bleCommandCallbacks;

static void bleBegin() {
  NimBLEDevice::init(GTC_BLE_NAME);
#if defined(GTC_BLE_PIN) && (GTC_BLE_PIN > 0)
  // Exige "Passkey Entry" — a app introduz o PIN definido em config.h
  NimBLEDevice::setSecurityAuth(true, true, true);
  NimBLEDevice::setSecurityPasskey(GTC_BLE_PIN);
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_DISPLAY_ONLY);
#endif

  bleServer = NimBLEDevice::createServer();
  bleServer->setCallbacks(&bleServerCallbacks);

  NimBLEService* service = bleServer->createService(GTC_BLE_SERVICE_UUID);

  bleStatusChar = service->createCharacteristic(
    GTC_BLE_STATUS_CHAR_UUID,
    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY
  );

  bleCommandChar = service->createCharacteristic(
    GTC_BLE_COMMAND_CHAR_UUID,
    NIMBLE_PROPERTY::WRITE
  );
  bleCommandChar->setCallbacks(&bleCommandCallbacks);

  service->start();

  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  advertising->addServiceUUID(GTC_BLE_SERVICE_UUID);
  advertising->setName(GTC_BLE_NAME);
  advertising->start();

  Serial.printf("[BLE] a anunciar como \"%s\"\n", GTC_BLE_NAME);
}

// ── HTTP ──
static bool httpJson(const char* method, const String& path, const String& body, JsonDocument& out) {
  if (WiFi.status() != WL_CONNECTED) return false;

  HTTPClient http;
  http.setConnectTimeout(4000);
  http.setTimeout(5000);
  if (!http.begin(baseUrl + path)) return false;
  http.addHeader("Content-Type", "application/json");
  if (strlen(GTC_DEVICE_TOKEN) > 0) http.addHeader("x-device-token", GTC_DEVICE_TOKEN);

  int code = (strcmp(method, "GET") == 0) ? http.GET() : http.POST(body);
  bool ok = false;
  if (code == 200) {
    ok = deserializeJson(out, http.getStream()) == DeserializationError::Ok;
  } else {
    Serial.printf("[HTTP] %s %s -> %d\n", method, path.c_str(), code);
  }
  http.end();
  return ok;
}

// ── Aplicar saídas vindas do servidor ──
static void applyOutputs(JsonDocument& doc) {
  bool emergency = doc["emergency"] | false;
  bool wantPump = doc["pump"] | false;
  bool wantAuto = doc["auto"] | false;

  if (emergency) {
    allOutputsOff();
    return;
  }

  if (wantAuto != autoModeOn) {
    autoModeOn = wantAuto;
    writeRelay(PIN_RELAY_AUTO, wantAuto);
    Serial.printf("[AUTO] %s\n", wantAuto ? "ON" : "OFF");
  }

  JsonArray zones = doc["zones"].as<JsonArray>();
  size_t i = 0;
  for (JsonObject z : zones) {
    if (i >= ZONE_COUNT) break;
    bool on = z["on"] | false;
    if (on != zoneOn[i]) {
      zoneOn[i] = on;
      writeRelay(ZONE_RELAY_PINS[i], on);
      Serial.printf("[ZONE] %s -> %s\n", (const char*)(z["name"] | "zona"), on ? "ON" : "OFF");
    }
    i++;
  }
  for (; i < ZONE_COUNT; i++) {
    if (zoneOn[i]) { zoneOn[i] = false; writeRelay(ZONE_RELAY_PINS[i], false); }
  }

  if (wantPump != pumpOn) {
    pumpOn = wantPump;
    writeRelay(PIN_RELAY_PUMP, wantPump);
    Serial.printf("[PUMP] %s\n", wantPump ? "ON" : "OFF");
  }
}

static void sendTelemetry() {
  JsonDocument body;
  body["deviceId"] = GTC_DEVICE_ID;
  body["firmware"] = GTC_FIRMWARE;
  body["ip"] = WiFi.localIP().toString();
  body["rssi"] = WiFi.RSSI();
  body["uptime"] = millis() / 1000;
  body["emergency"] = emergencyLatched;

  JsonArray sensors = body["sensors"].to<JsonArray>();
  JsonObject s1 = sensors.add<JsonObject>();
  s1["sensorId"] = "B1";
  s1["moisture"] = (int)roundf(moistureB1);
  JsonObject s2 = sensors.add<JsonObject>();
  s2["sensorId"] = "B2";
  s2["moisture"] = (int)roundf(moistureB2);

  // Sinal real de cada pino (entradas e saídas) para a vista HARDWARE
  gpioSnapshot(body["gpio"].to<JsonObject>());

  String payload;
  serializeJson(body, payload);

  JsonDocument res;
  if (httpJson("POST", "/api/device/telemetry", payload, res)) {
    lastOkContact = millis();
    serverOnline = true;
    if (!res["outputs"].isNull()) {
      JsonDocument outs;
      outs.set(res["outputs"]);
      applyOutputs(outs);
    }
    if (emergencyLatched) emergencyLatched = false;
  } else {
    serverOnline = false;
  }
}

static void pollOutputs() {
  JsonDocument res;
  if (httpJson("GET", "/api/device/outputs", "", res)) {
    lastOkContact = millis();
    serverOnline = true;
    applyOutputs(res);
  } else {
    serverOnline = false;
  }
}

// ── Setup ──
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\nGTC Rega — ESP32-S3 " GTC_FIRMWARE);

  pinMode(PIN_RELAY_PUMP, OUTPUT);
  pinMode(PIN_RELAY_STOP, OUTPUT);
  pinMode(PIN_RELAY_AUTO, OUTPUT);
  for (size_t i = 0; i < ZONE_COUNT; i++) pinMode(ZONE_RELAY_PINS[i], OUTPUT);
  allOutputsOff();

  pinMode(PIN_EMERGENCY_BTN, INPUT_PULLUP);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_SENSOR_B1, ADC_11db);
  analogSetPinAttenuation(PIN_SENSOR_B2, ADC_11db);

  WiFiManager wm;
  wm.setConfigPortalTimeout(180);
  if (!wm.autoConnect(GTC_AP_SSID, GTC_AP_PASS)) {
    Serial.println("[WIFI] Portal expirou — reiniciar");
    ESP.restart();
  }
  Serial.printf("[WIFI] ligado: %s\n", WiFi.localIP().toString().c_str());

  webuiBegin();
  bleBegin();

  baseUrl = String("http://") + GTC_SERVER_HOST + ":" + GTC_SERVER_PORT;

#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t wdt = { .timeout_ms = HW_WDT_TIMEOUT_S * 1000, .idle_core_mask = 0, .trigger_panic = true };
  esp_task_wdt_reconfigure(&wdt);
#else
  esp_task_wdt_init(HW_WDT_TIMEOUT_S, true);
#endif
  esp_task_wdt_add(NULL);

  JsonDocument hello, res;
  hello["deviceId"] = GTC_DEVICE_ID;
  hello["firmware"] = GTC_FIRMWARE;
  hello["ip"] = WiFi.localIP().toString();
  hello["rssi"] = WiFi.RSSI();
  String payload;
  serializeJson(hello, payload);
  if (httpJson("POST", "/api/device/hello", payload, res)) {
    Serial.println("[GTC] handshake ok");
    serverOnline = true;
    lastOkContact = millis();
  }
}

// ── Loop ──
void loop() {
  esp_task_wdt_reset();
  uint32_t now = millis();

  // Paragem de emergência local (fail-safe imediato)
  if (digitalRead(PIN_EMERGENCY_BTN) == LOW) {
    if (!emergencyLatched) {
      emergencyLatched = true;
      allOutputsOff();
      Serial.println("[EMERGENCY] paragem local");
      sendTelemetry();
    }
  }

  // Notifica o estado via BLE a quem estiver ligado (independente do Wi-Fi)
  if (blePeerConnected && bleStatusChar && now - lastBleNotify >= TELEMETRY_INTERVAL_MS) {
    lastBleNotify = now;
    bleStatusChar->setValue(gtcStatusJson());
    bleStatusChar->notify();
  }

  if (WiFi.status() != WL_CONNECTED) {
    allOutputsOff();  // fail-safe: sem rede, tudo desligado
    WiFi.reconnect();
    delay(1000);
    return;
  }

  // Fail-safe: sem contacto com o servidor há mais de 15s
  if (lastOkContact && now - lastOkContact > 15000 && (pumpOn || zoneOn[0])) {
    Serial.println("[SAFE] servidor inacessível — desligar saídas");
    allOutputsOff();
  }

  if (now - lastSample >= SENSOR_SAMPLE_MS) { lastSample = now; sampleSensors(); }
  if (now - lastPoll >= POLL_INTERVAL_MS) { lastPoll = now; pollOutputs(); }
  if (now - lastTelemetry >= TELEMETRY_INTERVAL_MS) { lastTelemetry = now; sendTelemetry(); }

  // LED de estado: aceso quando ligado ao servidor
  digitalWrite(PIN_STATUS_LED, serverOnline ? HIGH : LOW);

  delay(20);
}
