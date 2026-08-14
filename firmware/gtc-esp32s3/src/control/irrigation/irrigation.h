#pragma once
/**
 * GTC Rega — Controlo da rega (zonas + relés)
 * ------------------------------------------------------------------
 * Encapsula a escrita nas saídas de zona e dos relés de comando através
 * da camada io/ (que por sua vez fala com o MCP23017). A lógica de rega
 * (temporizações, ciclos, estados) continua no backend/engine; aqui fica
 * o mapeamento físico das saídas.
 */

#include <Arduino.h>
#include "config.h"
#include "hardware/io/io.h"

namespace irrigation {

// Aplica o estado de uma zona (válvula).
inline void setZone(uint8_t zone, bool on) {
  io::writeZone(zone, on);
}

// Relé de modo automático (K7).
inline void setAuto(bool on) {
  io::writeAuto(on);
}

// Relé de paragem/emergência (K6).
inline void setStop(bool on) {
  io::writeStop(on);
}

// Desliga todas as zonas.
inline void allZonesOff() {
  for (uint8_t z = 0; z < ZONE_COUNT; z++) io::writeZone(z, false);
}

} // namespace irrigation
