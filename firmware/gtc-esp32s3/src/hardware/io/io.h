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
 */

#include <Arduino.h>
#include <Wire.h>
#include <DHT.h>
#include "config.h"
#include "hardware/mcp23017/mcp23017.h"

namespace io {

// Singleton do MCP23017 (instância única, criada na primeira utilização).
inline io::Mcp23017& mcp() {
  static io::Mcp23017 instance;
  return instance;
}

// Instâncias dos sensores DHT22 (criadas em begin()).
inline DHT& dht1() { static DHT instance; return instance; }
inline DHT& dht2() { static DHT instance; return instance; }

// ── Inicialização (única) ──
// Inicia o barramento I2C, deteta o MCP23017, configura GPIOs e DHT22.
inline bool begin() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, I2C_CLOCK_HZ);
  mcp().setBus(Wire);
  bool ok = mcp().begin();

  // DHT22 — 1-wire proprietário em IO21 / IO14.
  dht1().setup(PIN_DHT22_1, DHT_TYPE);
  dht2().setup(PIN_DHT22_2, DHT_TYPE);

  pinMode(PIN_EMERGENCY_BTN, INPUT_PULLUP);
  pinMode(PIN_STATUS_LED, OUTPUT);

  return ok;
}

inline bool mcpPresent() { return mcp().present(); }

// ── Leituras DHT22 (ESP32-S3, IO21 / IO14) ──
struct DhtReading {
  float temperature;   // °C — NaN se falhou a leitura
  float humidity;      // %  — NaN se falhou a leitura
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
// PB6 — "Sinal da bomba ON" (24 V isolado por optoacoplador).
inline bool readBombaOn() {
  return mcp().read(MCP_INPUT_BOMBA_ON, false);
}

// PB7 — "Sinal da Relé Temp ON" (24 V isolado por optoacoplador).
inline bool readReleTempOn() {
  return mcp().read(MCP_INPUT_RELE_TEMP_ON, false);
}

// ── Saídas via MCP23017 (Porto A — PA0..PA7 e PB0) ──
inline void writeMotorOn(bool on)      { mcp().write(MCP_OUTPUT_MOTOR_ON, on); }
inline void writeAutoGtc(bool on)      { mcp().write(MCP_OUTPUT_AUTO_GTC, on); }
inline void writeStoEmergGtc(bool on)  { mcp().write(MCP_OUTPUT_STO_EMERG_GTC, on); }
inline void writeOnGtc(bool on)        { mcp().write(MCP_OUTPUT_ON_GTC, on); }
inline void writeTimeReg(bool on)      { mcp().write(MCP_OUTPUT_TIME_REG, on); }
inline void writeTimeDelay(bool on)    { mcp().write(MCP_OUTPUT_TIME_DELAY, on); }
inline void writeOutSensor1(bool on)   { mcp().write(MCP_OUTPUT_SENSOR_1, on); }
inline void writeOutSensor2(bool on)   { mcp().write(MCP_OUTPUT_SENSOR_2, on); }
inline void writeReleTempOn(bool on)   { mcp().write(MCP_OUTPUT_RELE_TEMP_ON, on); }

inline void allOutputsOff() { mcp().allOff(); }

// ── Botão de emergência físico (ESP32-S3, GPIO 0 = BOOT) ──
inline bool emergencyPressed() { return digitalRead(PIN_EMERGENCY_BTN) == LOW; }

// ── LED de estado ──
inline void setStatusLed(bool on) { digitalWrite(PIN_STATUS_LED, on ? HIGH : LOW); }

} // namespace io
