/**
 * GTC Rega — Firmware ESP32-S3 (plataforma ES3N28P)
 * ---------------------------------------------------------------
 * Controlador físico: ES3N28P (ESP32-S3 integrado).
 * Expansão de I/O: MCP23017-E/SS via I2C (IO16=SCL, IO18=SDA),
 * com isolamento galvânico (optoacopladores) das entradas 24 VDC.
 *
 *   ESP32-S3 (ES3N28P) ── I2C ──► MCP23017 ── optoacopladores ──► 24 VDC
 *
 * Pinout real do quadro:
 *   ESP32-S3 IO16/IO18 ─── I2C ─── MCP23017 (endereço 0x20)
 *   ESP32-S3 IO21 ─── DHT22 #1 (T/H)
 *   ESP32-S3 IO14 ─── DHT22 #2 (T/H)
 *
 *   MCP23017 (saídas): PA0..PA7 (MOTOR ON, AUTO GTC, STO/EMERG GTC,
 *                              ON GTC, Temp. Rega, Temp. Delay,
 *                              Out Sensor 2, Out Sensor 1) e PB0 (RELÉ TEMP-ON).
 *   MCP23017 (entradas opto): PB6 (Sinal bomba ON — 24 V) e
 *                              PB7 (Sinal Relé Temp ON — 24 V).
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
static bool motorOn = false;
static bool autoModeOn = false;
static bool emergencyLatched = false;
static bool serverOnline = false;

// Última leitura válida dos DHT22 (NaN = ainda nenhuma).
static float dht1Temp = NAN, dht1Hum = NAN;
static float dht2Temp = NAN, dht2Hum = NAN;

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
  irrigation::allZonesOff();
  io::writeOutSensor1(false);
  io::writeOutSensor2(false);
  io::writeTimeReg(false);
  io::writeTimeDelay(false);
  io::writeReleTempOn(false);
  autoModeOn = false;
  motorOn = false;
}

// ── Sensores DHT22 (IO21 / IO14) ──
static void sampleDht() {
  io::DhtReading a = io::readDht1();
  if (a.ok) { dht1Temp = a.temperature; dht1Hum = a.humidity; }
  io::DhtReading b = io::readDht2();
  if (b.ok) { dht2Temp = b.temperature; dht2Hum = b.humidity; }
}

// ── Estado elétrico real (para a vista HARDWARE da interface) ──
// Chaves por nome lógico em vez de GPIO — coerente com o frontend e o backend.
static void gpioSnapshot(JsonObject out) {
  const auto s = signals24v::snapshot();

  // DHT22 — leituras analógicas/digitais na entrada (valor 1 = sensor presente)
  out["DHT1_OK"] = io::readDht1().ok ? 1 : 0;
  out["DHT2_OK"] = io::readDht2().ok ? 1 : 0;
  out["EMERG_BTN"] = io::emergencyPressed() ? 1 : 0;

  // Pinos lógicos do MCP23017 (índices 0..15 conforme config.h).
  out["KM1"]     = s.bomba ? 1 : 0;         // PB6 via opto
  out["TH"]      = s.releTemp ? 1 : 0;      // PB7 via opto
  out["MCP"]     = s.mcpPresent ? 1 : 0;
  out[String(MCP_OUTPUT_MOTOR_ON)]      = motorOn ? 1 : 0;
  out[String(MCP_OUTPUT_AUTO_GTC)]      = autoModeOn ? 1 : 0;
  out[String(MCP_OUTPUT_STO_EMERG_GTC)] = emergencyLatched ? 1 : 0;
  out[String(MCP_OUTPUT_ON_GTC)]        = 0;     // controlado pelo backend
  out[String(MCP_OUTPUT_TIME_REG)]      = 0;
  out[String(MCP_OUTPUT_TIME_DELAY)]    = 0;
  out[String(MCP_OUTPUT_SENSOR_1)]      = 0;
  out[String(MCP_OUTPUT_SENSOR_2)]      = 0;
  out[String(MCP_OUTPUT_RELE_TEMP_ON)]  = 0;
}

// Estado real exposto pela interface local (webui.h) e pelo backend.
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
  doc["motor"] = motorOn;
  doc["pumpRunning"] = s.bomba;               // feedback real (PB6 via opto)
  doc["thermalAlarm"] = s.releTemp;           // relé térmico (PB7 via opto)
  doc["mcpPresent"] = s.mcpPresent;

  // DHT22 — telemetria de temperatura/humidade (e não mais sensores
  // capacitivos B1/B2 como na versão anterior).
  JsonArray dhts = doc["dhts"].to<JsonArray>();
  auto d1 = dhts.add<JsonObject>();
  d1["id"] = SENSOR_DHT_ID_1;
  d1["temperature"] = isnan(dht1Temp) ? (float)0.0f : dht1Temp;
  d1["humidity"]    = isnan(dht1Hum)  ? (float)0.0f : dht1Hum;
  d1["ok"] = io::readDht1().ok;
  auto d2 = dhts.add<JsonObject>();
  d2["id"] = SENSOR_DHT_ID_2;
  d2["temperature"] = isnan(dht2Temp) ? (float)0.0f : dht2Temp;
  d2["humidity"]    = isnan(dht2Hum)  ? (float)0.0f : dht2Hum;
  d2["ok"] = io::readDht2().ok;

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
  bool wantMotor = doc["pump"] | false;
  bool wantAuto  = doc["auto"] | false;

  if (emergency) { allOutputsOff(); return; }

  // Relé térmico ON => motor bloqueado (segurança local prevalece).
  const bool blocked = alarms::thermalActive() || !signals24v::snapshot().mcpPresent;

  if (wantAuto != autoModeOn) {
    autoModeOn = wantAuto;
    irrigation::setAuto(wantAuto);
    Serial.printf("[AUTO] %s\n", wantAuto ? "ON" : "OFF");
  }

  // Sinais de comando vindos do backend (mapeados 1:1 para PA3/PA4/PA5/...).
  bool onGtc    = doc["on"]      | false;
  bool timeReg  = doc["timeReg"] | false;
  bool timeDly  = doc["timeDelay"] | false;
  bool s1Out    = doc["out1"]    | false;
  bool s2Out    = doc["out2"]    | false;
  bool tempRel  = doc["tempRelay"] | false;
  bool stopRel  = doc["stop"]    | false;
  io::writeOnGtc(onGtc);
  io::writeTimeReg(timeReg);
  io::writeTimeDelay(timeDly);
  io::writeOutSensor1(s1Out);
  io::writeOutSensor2(s2Out);
  io::writeReleTempOn(tempRel);
  io::writeStoEmergGtc(stopRel);

  if (wantMotor != motorOn) {
    bool applied = pump::set(wantMotor && !blocked);
    if (applied) {
      motorOn = wantMotor && !blocked;
      Serial.printf("[MOTOR] %s%s\n", motorOn ? "ON" : "OFF", blocked ? " (bloqueado pelo rele termico)" : "");
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
  body["pumpRunning"] = s.bomba;
  body["thermalAlarm"] = s.releTemp;
  body["mcpPresent"] = s.mcpPresent;

  JsonArray dhts = body["dhts"].to<JsonArray>();
  auto d1 = dhts.add<JsonObject>();
  d1["id"] = SENSOR_DHT_ID_1;
  d1["temperature"] = isnan(dht1Temp) ? (float)0.0f : dht1Temp;
  d1["humidity"]    = isnan(dht1Hum)  ? (float)0.0f : dht1Hum;
  d1["ok"] = io::readDht1().ok;
  auto d2 = dhts.add<JsonObject>();
  d2["id"] = SENSOR_DHT_ID_2;
  d2["temperature"] = isnan(dht2Temp) ? (float)0.0f : dht2Temp;
  d2["humidity"]    = isnan(dht2Hum)  ? (float)0.0f : dht2Hum;
  d2["ok"] = io::readDht2().ok;

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
  // Leitura inicial dos DHT22 (vai estabilizar durante as primeiras leituras)
  sampleDht();
  allOutputsOff();

  // Periféricos on-board (stub na v1, HMI via web)
  display::init();
  touch::init();
  audio::init();

#ifdef WOKWI_SIM
  // Build de simulação: o portal cativo do WiFiManager não é alcançável
  // dentro do Wokwi, por isso ligamos diretamente à rede virtual aberta
  // "Wokwi-GUEST" (fornecida pelo simulador, sem password).
  Serial.println("[WIFI] WOKWI_SIM ativo — a ligar a Wokwi-GUEST");
  WiFi.mode(WIFI_STA);
  WiFi.begin("Wokwi-GUEST", "", 6);
  uint32_t wifiStart = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wifiStart < 15000) {
    delay(200);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] Falha a ligar a Wokwi-GUEST — a repetir em loop()");
  }
#else
  WiFiManager wm;
  wm.setConfigPortalTimeout(180);
  if (!wm.autoConnect(GTC_AP_SSID, GTC_AP_PASS)) {
    Serial.println("[WIFI] Portal expirou — reiniciar");
    ESP.restart();
  }
#endif
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

  // Segurança: relé térmico ON (PB7 via opto) => desligar motor imediatamente
  if (alarms::thermalActive()) {
    if (motorOn) {
      pump::set(false);
      motorOn = false;
      Serial.println("[SAFETY] rele termico ON — motor desligado");
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
  if (lastOkContact && now - lastOkContact > 15000 && motorOn) {
    Serial.println("[SAFE] servidor inacessivel — desligar saidas");
    allOutputsOff();
  }

  if (now - lastSample >= SENSOR_SAMPLE_MS) { lastSample = now; sampleDht(); }
  if (now - lastPoll >= POLL_INTERVAL_MS) { lastPoll = now; pollOutputs(); }
  if (now - lastTelemetry >= TELEMETRY_INTERVAL_MS) { lastTelemetry = now; sendTelemetry(); }

  io::setStatusLed(serverOnline);
  delay(20);
}
