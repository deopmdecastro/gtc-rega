/**
 * GTC Rega — Firmware ESP32-S3 (plataforma ES3N28P)
 * ---------------------------------------------------------------
 * Controlador físico: ES3N28P (ESP32-S3 integrado).
 * Expansão de I/O: MCP23017-E/SS via I2C (IO16=SCL, IO18=SDA),
 * com isolamento galvânico (optoacopladores) das entradas 24 VDC.
 *
 * Pinout real do quadro:
 *   ESP32-S3 IO16/IO18 ─── I2C ─── MCP23017 (endereço 0x20)
 *   ESP32-S3 IO21 ─── DHT22 #1 (T/H)
 *   ESP32-S3 IO14 ─── DHT22 #2 (T/H)
 *
 *   MCP23017 (saídas): PA0..PA7, PB0
 *   MCP23017 (entradas opto): PB6, PB7
 *
 * ── MODO WOKWI ─────────────────────────────────────────────────
 * O simulador Wokwi detecta-o automaticamente em runtime: se a
 * firmware conseguir ligar-se à rede virtual "Wokwi-GUEST" em <5s
 * ela ativa `io::isWokwiSim()` e os pinos MCP são espelhados em
 * GPIO 4..12 (saídas) e 13/15 (entradas). Em hardware real cai
 * no portal cativo WiFiManager.
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

// Setpoints (limiares) — ajustáveis via /api/local/setpoints ou backend.
// Modo auto desliga a bomba se T>Tmax OU T<Tmin OU H<Hmin.
static float setTempMax = 30.0f;  // °C — temperatura máxima na zona antes de parar
static float setTempMin = 5.0f;   // °C — temperatura mínima (anti-gelo)
static float setHumMin  = 35.0f;  // %  — humidade mínima aceitável
static uint32_t setIrrigationSeconds = 60;  // duração de rega por ciclo

// ── Bluetooth (BLE) ──
static NimBLEServer* bleServer = nullptr;
static NimBLECharacteristic* bleStatusChar = nullptr;
static NimBLECharacteristic* bleCommandChar = nullptr;
static bool blePeerConnected = false;

// ── Saídas ──
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

// ── Sensores DHT22 ──
static void sampleDht() {
  io::DhtReading a = io::readDht1();
  if (a.ok) { dht1Temp = a.temperature; dht1Hum = a.humidity; }
  io::DhtReading b = io::readDht2();
  if (b.ok) { dht2Temp = b.temperature; dht2Hum = b.humidity; }
}

// ── Snapshot GPIO (p/ interface HARDWARE) ──
static void gpioSnapshot(JsonObject out) {
  const auto s = signals24v::snapshot();
  out["DHT1_OK"] = io::readDht1().ok ? 1 : 0;
  out["DHT2_OK"] = io::readDht2().ok ? 1 : 0;
  out["EMERG_BTN"] = io::emergencyPressed() ? 1 : 0;
  out["KM1"]     = s.bomba ? 1 : 0;
  out["TH"]      = s.releTemp ? 1 : 0;
  out["MCP"]     = s.mcpPresent ? 1 : 0;
  out[String(MCP_OUTPUT_MOTOR_ON)]      = motorOn ? 1 : 0;
  out[String(MCP_OUTPUT_AUTO_GTC)]      = autoModeOn ? 1 : 0;
  out[String(MCP_OUTPUT_STO_EMERG_GTC)] = emergencyLatched ? 1 : 0;
  out[String(MCP_OUTPUT_ON_GTC)]        = 0;
  out[String(MCP_OUTPUT_TIME_REG)]      = 0;
  out[String(MCP_OUTPUT_TIME_DELAY)]    = 0;
  out[String(MCP_OUTPUT_SENSOR_1)]      = 0;
  out[String(MCP_OUTPUT_SENSOR_2)]      = 0;
  out[String(MCP_OUTPUT_RELE_TEMP_ON)]  = 0;
}

// Estado completo exposto pela interface local e pelo backend.
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
  doc["auto"] = autoModeOn;
  doc["pumpRunning"] = s.bomba;
  doc["thermalAlarm"] = s.releTemp;
  doc["mcpPresent"] = s.mcpPresent;
  doc["wokwiSim"]    = io::isWokwiSim();

  JsonObject sp = doc["setpoints"].to<JsonObject>();
  sp["tempMax"] = setTempMax;
  sp["tempMin"] = setTempMin;
  sp["humMin"]  = setHumMin;
  sp["irrigationSeconds"] = setIrrigationSeconds;

  JsonObject p = doc["pid"].to<JsonObject>();
  p["temp1"] = isnan(dht1Temp) ? 0.0f : dht1Temp;
  p["hum1"]  = isnan(dht1Hum)  ? 0.0f : dht1Hum;
  p["temp2"] = isnan(dht2Temp) ? 0.0f : dht2Temp;
  p["hum2"]  = isnan(dht2Hum)  ? 0.0f : dht2Hum;

  JsonArray dhts = doc["dhts"].to<JsonArray>();
  auto d1 = dhts.add<JsonObject>();
  d1["id"] = SENSOR_DHT_ID_1;
  d1["temperature"] = isnan(dht1Temp) ? 0.0f : dht1Temp;
  d1["humidity"]    = isnan(dht1Hum)  ? 0.0f : dht1Hum;
  d1["ok"] = io::readDht1().ok;
  auto d2 = dhts.add<JsonObject>();
  d2["id"] = SENSOR_DHT_ID_2;
  d2["temperature"] = isnan(dht2Temp) ? 0.0f : dht2Temp;
  d2["humidity"]    = isnan(dht2Hum)  ? 0.0f : dht2Hum;
  d2["ok"] = io::readDht2().ok;

  gpioSnapshot(doc["gpio"].to<JsonObject>());
  String out;
  serializeJson(doc, out);
  return out;
}

void gtcLocalEmergency() {
  emergencyLatched = true;
  allOutputsOff();
  Serial.println("[EMERGENCY] paragem local");
}

// ── Aplicar comando direto (simulação/teste) ──
// action: start, stop, reset, auto_on, auto_off, setpoint
static void applyLocalCommand(const String& body) {
  String b = body; b.trim(); b.toLowerCase();
  Serial.printf("[CMD] %s\n", b.c_str());

  if (b.indexOf("\"action\":\"stop\"") >= 0 || b.indexOf("\"stop\":true") >= 0 || b == "stop") {
    gtcLocalEmergency();
    return;
  }
  if (b.indexOf("\"action\":\"reset\"") >= 0 || b == "reset") {
    emergencyLatched = false;
    Serial.println("[CMD] reset de emergência");
    sendTelemetryNow();
    return;
  }
  if (b.indexOf("\"action\":\"start\"") >= 0 || b.indexOf("\"motor\":true") >= 0 || b == "start") {
    JsonDocument out;
    out["pump"] = true;
    out["auto"] = true;
    out["stop"] = false;
    applyOutputs(out);
    Serial.println("[CMD] motor ON, AUTO ON");
    sendTelemetryNow();
    return;
  }
  if (b == "auto_off" || b.indexOf("\"auto_off\"") >= 0) {
    irrigation::setAuto(false);
    autoModeOn = false;
    Serial.println("[CMD] auto OFF");
    sendTelemetryNow();
    return;
  }
  if (b.indexOf("setpoint") >= 0) {
    JsonDocument in;
    if (deserializeJson(in, body) == DeserializationError::Ok) {
      if (in["tempMax"].is<float>())   setTempMax            = in["tempMax"].as<float>();
      if (in["tempMin"].is<float>())   setTempMin            = in["tempMin"].as<float>();
      if (in["humMin"].is<float>())    setHumMin             = in["humMin"].as<float>();
      if (in["irrigationSeconds"].is<int>())
                                          setIrrigationSeconds = in["irrigationSeconds"].as<int>();
      Serial.printf("[CMD] setpoints atualizados: Tmax=%.1f Tmin=%.1f Hmin=%.1f Rega=%lus\n",
                    setTempMax, setTempMin, setHumMin, (unsigned long)setIrrigationSeconds);
      sendTelemetryNow();
      return;
    }
  }
  Serial.println("[CMD] ação desconhecida");
}

static bool httpJson(const char* method, const String& path, const String& body, JsonDocument& out);

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
    } else if (cmd == "START") {
      JsonDocument out;
      out["pump"] = true;
      out["auto"] = true;
      out["stop"] = false;
      applyOutputs(out);
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

static void applyOutputs(JsonDocument& doc) {
  bool emergency = doc["emergency"] | false;
  bool wantMotor = doc["pump"] | false;
  bool wantAuto  = doc["auto"] | false;

  if (emergency) { allOutputsOff(); return; }

  const bool blocked = alarms::thermalActive() || !signals24v::snapshot().mcpPresent;

  if (wantAuto != autoModeOn) {
    autoModeOn = wantAuto;
    irrigation::setAuto(wantAuto);
    Serial.printf("[AUTO] %s\n", wantAuto ? "ON" : "OFF");
  }

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
  body["pump"] = motorOn;
  body["auto"] = autoModeOn;
  body["pumpRunning"] = s.bomba;
  body["thermalAlarm"] = s.releTemp;
  body["mcpPresent"] = s.mcpPresent;

  JsonObject sp = body["setpoints"].to<JsonObject>();
  sp["tempMax"] = setTempMax;
  sp["tempMin"] = setTempMin;
  sp["humMin"]  = setHumMin;
  sp["irrigationSeconds"] = setIrrigationSeconds;

  JsonArray dhts = body["dhts"].to<JsonArray>();
  auto d1 = dhts.add<JsonObject>();
  d1["id"] = SENSOR_DHT_ID_1;
  d1["temperature"] = isnan(dht1Temp) ? 0.0f : dht1Temp;
  d1["humidity"]    = isnan(dht1Hum)  ? 0.0f : dht1Hum;
  d1["ok"] = io::readDht1().ok;
  auto d2 = dhts.add<JsonObject>();
  d2["id"] = SENSOR_DHT_ID_2;
  d2["temperature"] = isnan(dht2Temp) ? 0.0f : dht2Temp;
  d2["humidity"]    = isnan(dht2Hum)  ? 0.0f : dht2Hum;
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

// Variante "sendTelemetryNow" — invocada pelos comandos locais para forçar
// telemetría imediatamente em vez de esperar o TELEMETRY_INTERVAL_MS.
void sendTelemetryNow() { sendTelemetry(); }

static void pollOutputs() {
  // Variáveis dummy para evitar warning de "set mas não usado"
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

#if defined(WOKWI_SIM)
  // 1) Auto-detecção do simulador Wokwi: tenta ligar à rede virtual aberta
  //    "Wokwi-GUEST" (fornecida pelo simulador Wokwi, sem password). Em
  //    hardware real esta rede não existe → cai no WiFiManager.
  WiFi.mode(WIFI_STA);
  WiFi.begin("Wokwi-GUEST", "", 6);
  uint32_t wt0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - wt0 < 4000) {
    delay(200);
    Serial.print(".");
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    io::isWokwiSim() = true;
    Serial.println("[WIFI] Wokwi-GUEST conectado \u2192 modo simulação ativado");
    Serial.printf("[WIFI] IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    WiFi.disconnect();
    io::isWokwiSim() = false;
    Serial.println("[WIFI] Wokwi-GUEST não encontrada — a abrir portal WiFiManager");
    WiFiManager wm;
    wm.setConfigPortalTimeout(180);
    if (!wm.autoConnect(GTC_AP_SSID, GTC_AP_PASS)) {
      Serial.println("[WIFI] Portal expirou — reiniciar");
      ESP.restart();
    }
    Serial.printf("[WIFI] ligado: %s\n", WiFi.localIP().toString().c_str());
  }
#endif

  // Inicializa I/O. No modo Wokwi espelha MCP23017 em GPIO 4..12/13/15.
  if (!io::begin()) {
    Serial.println("[I/O] MCP23017 AUSENTE no barramento I2C — saídas bloqueadas (fail-safe)");
  }
  sampleDht();
  allOutputsOff();

  display::init();
  touch::init();
  audio::init();

  webuiBegin();
  bleBegin();

  baseUrl = String("http://") + GTC_SERVER_HOST + ":" + GTC_SERVER_PORT;

#if ESP_IDF_VERSION_MAJOR >= 5
  esp_task_wdt_config_t wdt;
  wdt.timeout_ms = HW_WDT_TIMEOUT_S * 1000;
  wdt.idle_core_mask = 0;
  wdt.trigger_panic = true;
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

  // Segurança: relé térmico ON => desligar motor imediatamente
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

  // BLE status (independente do Wi-Fi)
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
