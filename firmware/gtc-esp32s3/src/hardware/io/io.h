#pragma once
/**
 * GTC Rega — Camada de I/O (abstração de hardware)
 * ------------------------------------------------------------------
 * A lógica de controlo NÃO conhece GPIOs físicos nem barramento I2C.
 * Usa esta interface:
 *
 *   bool pumpRunning = io::readKm1();
 *   io::writePump(true);
 *
 * Internamente encaminha para o MCP23017 (campo isolado) ou para
 * GPIOs diretas do ESP32-S3 (periféricos on-board). Alterar hardware
 * futuro = alterar só esta camada, nunca a lógica da aplicação.
 */

#pragma once
#include <Arduino.h>
#include <Wire.h>
#include "config.h"
#include "hardware/mcp23017/mcp23017.h"

namespace io {

// Singleton do MCP23017 (instância única, criada na primeira utilização).
inline io::Mcp23017& mcp() {
  static io::Mcp23017 instance;
  return instance;
}

// ── Inicialização (única) ──
// Inicia o barramento I2C, deteta o MCP23017 e configura GPIOs + ADC.
// Devolve true se o MCP23017 responder no barramento.
inline bool begin() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, I2C_CLOCK_HZ);
  mcp().setBus(Wire);
  bool ok = mcp().begin();

  // Sensores analógicos (humidade) permanecem em GPIO diretas do ESP32-S3
  pinMode(PIN_SENSOR_B1, INPUT);
  pinMode(PIN_SENSOR_B2, INPUT);
  analogReadResolution(12);
  analogSetPinAttenuation(PIN_SENSOR_B1, ADC_11db);
  analogSetPinAttenuation(PIN_SENSOR_B2, ADC_11db);

  pinMode(PIN_EMERGENCY_BTN, INPUT_PULLUP);
  pinMode(PIN_STATUS_LED, OUTPUT);

  return ok;
}

inline bool mcpPresent() { return mcp().present(); }

// ── Entradas de campo (via MCP23017 + optoacopladores) ──
// KM1: contacto auxiliar do contactor => bomba realmente em funcionamento.
inline bool readKm1() {
  bool raw = mcp().read(MCP_INPUT_KM1, false);
  return FIELD_KM1_ACTIVE_LOW ? !raw : raw;
}

// Relé térmico: contacto 95-96 (NF). true = alarme térmico ativo.
inline bool readThermalAlarm() {
  bool raw = mcp().read(MCP_INPUT_THERMAL, true); // safe = alarme (bloqueia bomba)
  bool closed = FIELD_THERMAL_ACTIVE_LOW ? !raw : raw; // nível do contacto
  if (FIELD_THERMAL_NC) return !closed; // aberto => alarme
  return closed;                        // contacto NA fechado => alarme
}

// ── Saídas de campo ──
inline void writePump(bool on)   { mcp().write(MCP_OUTPUT_RELAY_PUMP, on); }
inline void writeStop(bool on)   { mcp().write(MCP_OUTPUT_RELAY_STOP, on); }
inline void writeAuto(bool on)   { mcp().write(MCP_OUTPUT_RELAY_AUTO, on); }

inline void writeZone(uint8_t zone, bool on) {
  if (zone < ZONE_COUNT && MCP_OUTPUT_ZONE_PINS[zone] != 0xFF)
    mcp().write(MCP_OUTPUT_ZONE_PINS[zone], on);
}

inline void allOutputsOff() { mcp().allOff(); }

// ── Sensores analógicos (ESP32-S3, ADC) ──
inline float readMoistureB1() { return analogRead(PIN_SENSOR_B1); }
inline float readMoistureB2() { return analogRead(PIN_SENSOR_B2); }

// ── Botão de emergência físico (ESP32-S3) ──
inline bool emergencyPressed() { return digitalRead(PIN_EMERGENCY_BTN) == LOW; }

// ── LED de estado ──
inline void setStatusLed(bool on) { digitalWrite(PIN_STATUS_LED, on ? HIGH : LOW); }

} // namespace io
