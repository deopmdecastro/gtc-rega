#pragma once
/**
 * GTC Rega — Camada de I/O (abstração de hardware)
 * ------------------------------------------------------------------
 * A lógica de controlo NÃO conhece GPIOs físicos nem barramento I2C.
 * Usa esta interface:
 *
 *   io::writeMotorOn(true);
 *   bool running = io::readBombaOn();
 *
 * Internamente encaminha para o MCP23017 (campo isolado) ou para
 * GPIOs diretas do ESP32-S3 (sensores DHT22, botão emergência, LED).
 * Alterar hardware futuro = alterar só esta camada, nunca a lógica
 * da aplicação.
 *
 * ── MODO WOKWI ─────────────────────────────────────────────────
 * No simulador Wokwi a placa ES3N28P real não existe, поэтому o MCP23017
 * foi espelhado em GPIOs livres do ESP32-S3 DevKitC-1 para que LEDs,
 * relés e switches do diagram.json exercitem a MESMA lógica:
 *
 *   MCP_OUT (9 pinos) → GPIO 4..12   (outputs)
 *   MCP_IN  (2 pinos) → GPIO 13, 15  (inputs feedback isolado)
 *
 * A detecção é automática em runtime: setup() tenta ligar-se à rede
 * "Wokwi-GUEST" (SSID virtual do simulador). Se conseguir em <5s o
 * modo simulação é ativado — caso contrário usa-se WiFiManager.
 * Não há #define de compilação, o que torna a firmware única e
 * executável em hardware real ou no Wokwi.
 */

#include <Arduino.h>
#include <Wire.h>
#include <DHT.h>
#include "config.h"
#include "hardware/mcp23017/mcp23017.h"

namespace io {

#ifdef WOKWI_SIM
static const int SIM_OUT_PINS[9] = { 4, 5, 6, 7, 8, 9, 10, 11, 12 };
static const int SIM_IN_PINS[2]  = { 13, 15 };
#endif

inline io::Mcp23017& mcp() {
  static io::Mcp23017 instance;
  return instance;
}

inline DHT& dht1() { static DHT instance(PIN_DHT22_1, DHT_TYPE); return instance; }
inline DHT& dht2() { static DHT instance(PIN_DHT22_2, DHT_TYPE); return instance; }

// ── Flag de modo simulação (definida em runtime por main.cpp) ──
inline bool& isWokwiSim() { static bool v = false; return v; }

// ── Inicialização (única) ──
inline bool begin() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, I2C_CLOCK_HZ);
  mcp().setBus(Wire);
  bool ok = mcp().begin();

  dht1().begin();
  dht2().begin();

  pinMode(PIN_EMERGENCY_BTN, INPUT_PULLUP);
  pinMode(PIN_STATUS_LED, OUTPUT);

#ifdef WOKWI_SIM
  if (isWokwiSim()) {
    for (int pin : SIM_OUT_PINS) { pinMode(pin, OUTPUT); digitalWrite(pin, LOW); }
    for (int pin : SIM_IN_PINS)  pinMode(pin, INPUT_PULLDOWN);
    ok = true; // mantém a lógica de segurança testável no Wokwi
  }
#endif

  return ok;
}

inline bool mcpPresent() {
#ifdef WOKWI_SIM
  if (isWokwiSim()) return true;
#endif
  return mcp().present();
}

struct DhtReading {
  float temperature;
  float humidity;
  bool  ok;
};

inline DhtReading readDht1() {
  DhtReading r = { NAN, NAN, false };
  float h = dht1().readHumidity();
  float t = dht1().readTemperature();
  if (isnan(h) || isnan(t)) return r;
  r.humidity = h; r.temperature = t; r.ok = true;
  return r;
}

inline DhtReading readDht2() {
  DhtReading r = { NAN, NAN, false };
  float h = dht2().readHumidity();
  float t = dht2().readTemperature();
  if (isnan(h) || isnan(t)) return r;
  r.humidity = h; r.temperature = t; r.ok = true;
  return r;
}

// ── Entradas via MCP23017 (PB6, PB7 — optoacopladores) ──
inline bool readBombaOn() {
#ifdef WOKWI_SIM
  if (isWokwiSim()) return digitalRead(SIM_IN_PINS[0]) == HIGH;
#endif
  return mcp().read(MCP_INPUT_BOMBA_ON, false);
}

inline bool readReleTempOn() {
#ifdef WOKWI_SIM
  if (isWokwiSim()) return digitalRead(SIM_IN_PINS[1]) == HIGH;
#endif
  return mcp().read(MCP_INPUT_RELE_TEMP_ON, false);
}

// ── Saídas via MCP23017 (Porto A — PA0..PA7 e PB0) ──
inline void _writePin(uint8_t pin, bool on) {
#ifdef WOKWI_SIM
  if (isWokwiSim()) {
    if (pin < 9) digitalWrite(SIM_OUT_PINS[pin], on ? HIGH : LOW);
    return;
  }
#endif
  mcp().write(pin, on);
}

inline void writeMotorOn(bool on)     { _writePin(MCP_OUTPUT_MOTOR_ON, on); }
inline void writeAutoGtc(bool on)     { _writePin(MCP_OUTPUT_AUTO_GTC, on); }
inline void writeStoEmergGtc(bool on) { _writePin(MCP_OUTPUT_STO_EMERG_GTC, on); }
inline void writeOnGtc(bool on)       { _writePin(MCP_OUTPUT_ON_GTC, on); }
inline void writeTimeReg(bool on)     { _writePin(MCP_OUTPUT_TIME_REG, on); }
inline void writeTimeDelay(bool on)   { _writePin(MCP_OUTPUT_TIME_DELAY, on); }
inline void writeOutSensor1(bool on)  { _writePin(MCP_OUTPUT_SENSOR_1, on); }
inline void writeOutSensor2(bool on)  { _writePin(MCP_OUTPUT_SENSOR_2, on); }
inline void writeZone(uint8_t zone, bool on) {
  if (zone == 0) writeOutSensor1(on);
  else if (zone == 1) writeOutSensor2(on);
}
inline void writeAuto(bool on) { writeAutoGtc(on); }
inline void writeStop(bool on) { writeStoEmergGtc(on); }
inline void writeReleTempOn(bool on)  { _writePin(MCP_OUTPUT_RELE_TEMP_ON, on); }

inline void allOutputsOff() {
#ifdef WOKWI_SIM
  if (isWokwiSim()) {
    for (int pin : SIM_OUT_PINS) digitalWrite(pin, LOW);
    return;
  }
#endif
  mcp().allOff();
}

inline bool emergencyPressed() { return digitalRead(PIN_EMERGENCY_BTN) == LOW; }
inline void setStatusLed(bool on) { digitalWrite(PIN_STATUS_LED, on ? HIGH : LOW); }

} // namespace io
