#pragma once
/**
 * GTC Rega — Sinais industriais de 24 VDC (isolamento por optoacoplador)
 * ------------------------------------------------------------------
 * Modela a cadeia de entrada de campo:
 *
 *   24 VDC ─► contacto de campo ─► resistor ─► optoacoplador
 *                  ▲                              │ (lógica 3v3)
 *        KM1 / relé térmico                      ▼
 *                                           MCP23017 ─ I2C ─► ESP32-S3
 *
 * Os contactos de 24 V NUNCA tocam o ESP32-S3 nem o MCP23017: ficam
 * galvanicamente isolados pelo optoacoplador. Esta camada apenas lê o
 * nível lógico já isolado (entregue pela camada io/).
 *
 * Pinout real do quadro GTC Rega:
 *   PB6 (MCP) <- opto <- 24 V "Sinal da bomba ON"
 *   PB7 (MCP) <- opto <- 24 V "Sinal da Relé Temp ON"
 */

#include <Arduino.h>
#include "config.h"
#include "hardware/io/io.h"

namespace signals24v {

// Feedback real: contacto auxiliar de 24 V detetado via optoacoplador
// no pino PB6 do MCP23017. true = bomba efetivamente em funcionamento.
inline bool bombaRunning() {
  bool raw = io::readBombaOn();
  return FIELD_BOMBA_ON_ACTIVE_HIGH ? raw : !raw;
}

// Feedback real: sinal do relé térmico de 24 V detetado via optoacoplador
// no pino PB7 do MCP23017. true = relé térmico em estado ON (alarme).
inline bool releTempOn() {
  bool raw = io::readReleTempOn();
  return FIELD_RELE_TEMP_ON_ACTIVE_HIGH ? raw : !raw;
}

// Diagnóstico do estado dos sinais de campo (para telemetria/HMI).
struct FieldSignals {
  bool mcpPresent;
  bool bomba;      // bomba em funcionamento (feedback real, PB6 via opto)
  bool releTemp;   // relé térmico de 24 V ON (PB7 via opto)
};

inline FieldSignals snapshot() {
  FieldSignals s;
  s.mcpPresent = io::mcpPresent();
  s.bomba      = bombaRunning();
  s.releTemp   = releTempOn();
  return s;
}

} // namespace signals24v
