#pragma once
/**
 * GTC Rega — Alarmes
 * ------------------------------------------------------------------
 * Representa o estado de alarme do sistema, em particular:
 *   NORMAL          — sem alarme
 *   ALARME TERMICO  — relé térmico disparado
 *
 * O reset do alarme térmico segue a lógica definida: só é permitido
 * quando o contacto do relé térmico regressa ao estado normal (o
 * operador rearma o relé fisicamente). O firmware não "limpa" um
 * alarme térmico ativo por software.
 */

#include <Arduino.h>
#include "hardware/signals/signals.h"

namespace alarms {

enum class Kind : uint8_t {
  None,
  Thermal,     // alarme térmico
  PumpMismatch,// KM1 não confirma a bomba
};

struct AlarmState {
  bool thermalActive;
  bool pumpMismatch;
  uint32_t thermalSinceMs;   // quando disparou (0 = nunca)
  uint32_t resetAtMs;        // instante do último reset
};

// true se há alarme térmico ativo (relé disparado).
inline bool thermalActive() {
  return signals24v::thermalAlarm();
}

// Reset só é válido depois de o relé térmico ter sido rearmado fisicamente
// (contacto regressou ao normal). Se ainda estiver disparado, o reset é rejeitado.
inline bool tryResetThermal() {
  if (signals24v::thermalAlarm()) return false; // continua disparado
  return true;
}

} // namespace alarms
