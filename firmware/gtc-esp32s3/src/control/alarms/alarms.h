#pragma once
/**
 * GTC Rega — Alarmes
 * ------------------------------------------------------------------
 * Representa o estado de alarme do sistema, em particular:
 *   NORMAL          — sem alarme
 *   ALARME TERMICO  — relé térmico de 24 V ON (PB7 do MCP, via opto)
 *
 * O reset do alarme térmico segue a lógica definida: só é permitido
 * quando o sinal do relé térmico regressa ao estado normal (o
 * operador rearma o relé fisicamente). O firmware não "limpa" um
 * alarme térmico ativo por software.
 */

#include <Arduino.h>
#include "hardware/signals/signals.h"

namespace alarms {

enum class Kind : uint8_t {
  None,
  Thermal,     // alarme térmico
  PumpMismatch,// bomba comandada mas KM1 (PB6 via opto) não confirma
};

struct AlarmState {
  bool thermalActive;
  bool pumpMismatch;
  uint32_t thermalSinceMs;   // quando disparou (0 = nunca)
  uint32_t resetAtMs;        // instante do último reset
};

// true se há alarme térmico ativo (PB7 via opto a conduzir).
inline bool thermalActive() {
  return signals24v::releTempOn();
}

// Reset só é válido depois de o relé térmico ter sido rearmado fisicamente
// (sinal regressou ao normal). Se ainda estiver ON, o reset é rejeitado.
inline bool tryResetThermal() {
  if (signals24v::releTempOn()) return false;
  return true;
}

} // namespace alarms
