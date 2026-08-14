/**
 * GTC Rega — Firmware ESP32-S3 (plataforma ES3N28P)
 * ---------------------------------------------------------------
 * Controlador físico: ES3N28P (ESP32-S3 integrado).
 * Expansão de I/O: MCP23017-E/SS via I2C, com isolamento galvânico
 * (optoacopladores) de todos os sinais de campo de 24 VDC.
 *
 *   ESP32-S3 (ES3N28P) ── I2C ──► MCP23017 ── optoacopladores ──► 24 VDC
 *
 * Liga-se ao WiFi (portal WiFiManager), anuncia BLE, serve a interface
 * web local (webui.h) e sincroniza com o backend GTC Rega:
 *   - lê sensores capacitivos de humidade (B1/B2) e envia telemetria
 *   - lê o estado REAL do campo: KM1 (bomba em funcionamento) e relé
 *     térmico (alarme), via MCP23017 + optoacopladores
 *   - aplica as saídas desejadas (bomba + válvulas por zona) com
 *     bloqueio de segurança (alarme térmico / MCP ausente)
 *   - paragem de emergência local (botão) e fail-safe em perda de rede
 *   - protege-se com watchdog de hardware
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

#include "hardware/es3n28p/es3n28p.h"
#include "hardware/mcp23017/mcp23017.h"
#include "hardware/io/io.h"
#include "hardware/signals/signals.h"
#include "hardware/display/display.h"
#include "hardware/touch/touch.h"
#include "hardware/audio/audio.h"

#include "control/safety/safety.h"
#include "control/pump/pump.h"
#include "control/irrigation/irrigation.h"
#include "control/alarms/alarms.h"

#include "communication/web/web.h"

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

// ── Saídas (via camada io::, que fala com o MCP23017) ──
static void allOutputsOff() {
  irrigation::setStop(false);
  irrigation::setAuto(false);
  pump::set(false);
  for (size_t i = 0; i < ZONE_COUNT; i++) irrigation::setZone(i, false);
  autoModeOn = false;
  for (auto& z : zoneOn) z = false;
  pumpOn = false;
}

// ── Sensores (ADC do ESP32-S3) ──
static float rawToMoisture(int raw) {
  float pct = 100.0f * (SENSOR_DRY_RAW - raw) / float(SENSOR_DRY_RAW - SENSOR_WET_RAW);
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return pct;
}

static float readSensor(uint8_t pin) {
  uint32_t acc = 0;
  for (int i = 0; i < 8; i++) { acc += analogRead(pin); delayMicroseconds(200); }
  return rawToMoisture(acc / 8);
}

static void sampleSensors() {
  float b1 = readSensor(PIN_SENSOR_B1);
  float b2 = readSensor(PIN_SENSOR_B2);
  moistureB1 = moistureB1 == 0 ? b1 : (moistureB1 * 0.8f + b1 * 0.2f);
  moistureB2 = moistureB2 == 0 ? b2 : (moistureB2 * 0.8f + b2 * 0.2f);
}

// ── Estado elétrico real (para a vista HARDWARE da interface) ──
static void gpioSnapshot(JsonObject out) {
  const auto s = signals24v::snapshot();
  out[String(PIN_SENSOR_B1)] = analogRead(PIN_SENSOR_B1) > SENSOR_SIGNAL_RAW_MIN ? 1 : 0;
  out[String(PIN_SENSOR_B2)] = analogRead(PIN_SENSOR_B2) > SENSOR_SIGNAL_RAW_MIN ? 1 : 0;
  out[String(PIN_EMERGENCY_BTN)] = io::emergencyPressed() ? 1 : 0;
  // GPIOs lógicos do MCP23017 (nomes simbólicos):
  out["KM1"] = s.km1 ? 1 : 0;             // contacto auxiliar do contactor
  out["TH"] = s.thermal ? 1 : 0;          // relé térmico
  out["MCP"] = s.mcpPresent ? 1 : 0;      // expansor presente no barramento
  out[String(MCP_OUTPUT_RELAY_PUMP)] = pumpOn ? 1 : 0;
  out[String(MCP_OUTPUT_RELAY_STOP)] = emergencyLatched ? 1 : 0;
  out[String(MCP_OUTPUT_RELAY_AUTO)] = autoModeOn ? 1 : 0;
  for (size_t i = 0; i < ZONE_COUNT; i++)
    out[String(MCP_OUTPUT_ZONE_PINS[i])] = zoneOn[i] ? 1 : 0;
}

// Estado real exposto pela interface local (webui.h)
String gtcStatusJson() {
  JsonDocument doc;
  const auto s = signals24v::snapshot();
  doc["deviceId"] = GTC_DEVICE_ID;
  doc["firmware"] = GTC_FIRMWARE;
  doc["platform"] = "ES3N28P";
  doc["online"] = WiFi.status() == WL_CONNECTED;
  doc["serverOnline"] = serverOnline;
  doc["ip"] = WiFi.localIP().toString();
  doc["rssi"] = WiFi.RSSI();
  doc["uptime"] = millis() / 1000;
  doc["emergency"] = emergencyLatched;
  doc["pump"] = pumpOn;
  doc["pumpRunning"] = s.km1;               // feedback real da bomba
  doc["thermalAlarm"] = s.thermal;          // alarme térmico
  doc["mcpPresent"] = s.mcpPresent;         // expansor I/O presente
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

class GtcBleServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server, ble_gap_conn_desc* desc) override {
    blePeerConnected = true;
    Serial.println("[BLE] dispositivo ligado");
  }
  void onDisconnect(NimBLEServer* server, ble_gap_conn_desc* desc) override {
    blePeerConnected = false;
    Serial.println("[BLE] dispositivo desligado — a reiniciar advertising");
    NimBLEDevice::startAdvertising();
  }
};

class GtcBleCommandCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic, ble_gap_conn_desc* desc) override {
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
  NimBLEDevice::setSecurityAuth(true, true, true);
  NimBLEDevice::setSecurityPasskey(GTC_BLE_PIN);
  NimBLEDevice::setSecurityIOCap(BLE_HS_IO_DISPLAY_ONLY);
#endif
  bleServer = NimBLEDevice::createServer();
  bleServer->setCallbacks(&bleServerCallbacks);

  NimBLEService* service = bleServer->createService(GTC_BLE_SERVICE_UUID);
  bleStatusChar = service->createCharacteristic(
    GTC_BLE_STATUS_CHAR_UUID, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  bleCommandChar = service->createCharacteristic(
    GTC_BLE_COMMAND_CHAR_UUID, NIMBLE_PROPERTY::WRITE);
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

// ── Aplicar saídas vindas do servidor (com bloqueio de segurança) ──
static void applyOutputs(JsonDocument& doc) {
  bool emergency = doc["emergency"] | false;
  bool wantPump = doc["pump"] | false;
  bool wantAuto = doc["auto"] | false;

  if (emergency) { allOutputsOff(); return; }

  // Alarme térmico => bomba bloqueada (segurança local prevalece).
  const bool blocked = alarms::thermalActive() || !signals24v::snapshot().mcpPresent;

  if (wantAuto != autoModeOn) {
    autoModeOn = wantAuto;
    irrigation::setAuto(wantAuto);
    Serial.printf("[AUTO] %s\n", wantAuto ? "ON" : "OFF");
  }

  JsonArray zones = doc["zones"].as<JsonArray>();
  size_t i = 0;
  for (JsonObject z : zones) {
    if (i >= ZONE_COUNT) break;
    bool on = z["on"] | false;
    if (on != zoneOn[i]) {
      zoneOn[i] = on;
      irrigation::setZone(i, on);
      Serial.printf("[ZONE] %s -> %s\n", (const char*)(z["name"] | "zona"), on ? "ON" : "OFF");
    }
    i++;
  }
  for (; i < ZONE_COUNT; i++) {
    if (zoneOn[i]) { zoneOn[i] = false; irrigation::setZone(i, false); }
  }

  if (wantPump != pumpOn) {
    bool applied = pump::set(wantPump && !blocked);
    if (applied) {
      pumpOn = wantPump && !blocked;
      Serial.printf("[PUMP] %s%s\n", pumpOn ? "ON" : "OFF", blocked ? " (bloqueado pelo alarme termico)" : "");
    }
  }
}

static void sendTelemetry() {
  JsonDocument body;
  const auto s = signals24v::snapshot();
  body["deviceId"] = GTC_DEVICE_ID;
  body["firmware"] = GTC_FIRMWARE;
  body["platform"] = "ES3N28P";
  body["ip"] = WiFi.localIP().toString();
  body["rssi"] = WiFi.RSSI();
  body["uptime"] = millis() / 1000;
  body["emergency"] = emergencyLatched;
  body["pumpRunning"] = s.km1;
  body["thermalAlarm"] = s.thermal;
  body["mcpPresent"] = s.mcpPresent;

  JsonArray sensors = body["sensors"].to<JsonArray>();
  JsonObject s1 = sensors.add<JsonObject>();
  s1["sensorId"] = "B1";
  s1["moisture"] = (int)roundf(moistureB1);
  JsonObject s2 = sensors.add<JsonObject>();
  s2["sensorId"] = "B2";
  s2["moisture"] = (int)roundf(moistureB2);

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
  Serial.println("\nGTC Rega — ES3N28P (ESP32-S3) " GTC_FIRMWARE);
  es3n28p::logIdentity();

  // I/O de campo: I2C + MCP23017 (expansor). Se ausente, entra em fail-safe.
  if (!io::begin()) {
    Serial.println("[I/O] MCP23017 AUSENTE no barramento I2C — saídas bloqueadas (fail-safe)");
  }
  allOutputsOff();

  // Periféricos on-board (stub na v1, HMI via web)
  display::init();
  touch::init();
  audio::init();

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
  hello["platform"] = "ES3N28P";
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

  // Segurança: alarme térmico => desligar bomba imediatamente (independente da rede)
  if (alarms::thermalActive()) {
    if (pumpOn) {
      pump::set(false);
      pumpOn = false;
      Serial.println("[SAFETY] alarme termico — bomba desligada");
    }
  }

  // Paragem de emergência local (fail-safe imediato)
  if (io::emergencyPressed()) {
    if (!emergencyLatched) {
      emergencyLatched = true;
      allOutputsOff();
      Serial.println("[EMERGENCY] paragem local");
      sendTelemetry();
    }
  }

  // Notifica o estado via BLE (independente do Wi-Fi)
  if (blePeerConnected && bleStatusChar && now - lastBleNotify >= TELEMETRY_INTERVAL_MS) {
    lastBleNotify = now;
    bleStatusChar->setValue(gtcStatusJson());
    bleStatusChar->notify();
  }

  if (WiFi.status() != WL_CONNECTED) {
    allOutputsOff();
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

  io::setStatusLed(serverOnline);
  delay(20);
}
