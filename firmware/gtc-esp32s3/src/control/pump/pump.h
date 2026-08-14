#pragma once
/**
 * GTC Rega — Controlo da bomba
 * ------------------------------------------------------------------
 * A bomba só é acionada se a segurança permitir (sem alarme térmico e
 * com MCP23017 presente). O estado "em funcionamento" que conta para a
 * lógica é o FEEDBACK REAL do sinal de 24 V em PB6 do MCP (via
 * optocoplador), não o comando emitido.
 */

#include <Arduino.h>
#include "control/safety/safety.h"
#include "hardware/io/io.h"
#include "hardware/signals/signals.h"

namespace pump {

// Emite o comando de MOTOR ON (PA0) respeitando a segurança.
// Devolve true se o comando foi efetivamente aplicado.
inline bool set(bool on) {
  if (on && !safety::pumpAllowed()) {
    // Segurança impede: garante que o motor fica desligado.
    io::writeMotorOn(false);
    return false;
  }
  io::writeMotorOn(on);
  return true;
}

// Estado REAL da bomba (feedback físico de 24 V em PB6 via optoacoplador).
inline bool running() {
  return signals24v::bombaRunning();
}

} // namespace pump
