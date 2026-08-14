#pragma once
/**
 * GTC Rega — Controlo da bomba
 * ------------------------------------------------------------------
 * A bomba só é acionada se a segurança permitir (sem alarme térmico e
 * com MCP23017 presente). O estado "em funcionamento" que conta para a
 * lógica é o FEEDBACK REAL do contacto KM1, não o comando emitido.
 */

#include <Arduino.h>
#include "control/safety/safety.h"
#include "hardware/io/io.h"
#include "hardware/signals/signals.h"

namespace pump {

// Emite o comando de bomba respeitando a segurança.
// Devolve true se o comando foi efetivamente aplicado.
inline bool set(bool on) {
  if (on && !safety::pumpAllowed()) {
    // Segurança impede: garante que a bomba fica desligada.
    io::writePump(false);
    return false;
  }
  io::writePump(on);
  return true;
}

// Estado REAL da bomba (feedback físico do contactor via KM1).
inline bool running() {
  return signals24v::km1Running();
}

} // namespace pump
