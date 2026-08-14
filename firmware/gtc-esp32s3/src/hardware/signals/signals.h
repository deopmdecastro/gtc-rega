#pragma once
/**
 * GTC Rega — Sinais industriais de 24 VDC (isolamento por optoacoplador)
 * ------------------------------------------------------------------
 * Modela a cadeia de entrada de campo:
 *
 *   24 VDC ─► contacto de campo ─► resistor ─► optoacoplador
 *                  ▲                              │ (lógica 3v3)
 *             KM1 / relé térmico                  ▼
 *                                           MCP23017 ─ I2C ─► ESP32-S3
 *
 * Os contactos de 24 V NUNCA tocam o ESP32-S3 nem o MCP23017: ficam
 * galvanicamente isolados pelo optoacoplador. Esta camada apenas lê o
 * nível lógico já isolado (entregue pela camada io/).
 */

#include <Arduino.h>
#include "config.h"
#include "hardware/io/io.h"

namespace signals24v {

// Estado do contacto auxiliar KM1 (contactor da bomba).
// true = bomba realmente em funcionamento (feedback físico, não o comando).
inline bool km1Running() {
  return io::readKm1();
}

// Alarme térmico (contacto 95-96 NF, ou 97-98 NA consoante o esquema).
// true = relé térmico disparado.
inline bool thermalAlarm() {
  return io::readThermalAlarm();
}

// Diagnóstico do estado dos sinais de campo (para telemetria/HMI).
struct FieldSignals {
  bool mcpPresent;
  bool km1;        // bomba em funcionamento (feedback real)
  bool thermal;    // alarme térmico
};

inline FieldSignals snapshot() {
  FieldSignals s;
  s.mcpPresent = io::mcpPresent();
  s.km1        = km1Running();
  s.thermal    = thermalAlarm();
  return s;
}

} // namespace signals24v
