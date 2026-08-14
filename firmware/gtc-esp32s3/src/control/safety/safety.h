#pragma once
/**
 * GTC Rega — Segurança / fail-safe
 * ------------------------------------------------------------------
 * Regras de segurança independentes da lógica de rega:
 *   - Alarme térmico ativo  => bloquear/impedir a bomba.
 *   - MCP23017 ausente      => nunca comandar saídas (estado seguro).
 *   - KM1 (feedback)        => deteção de discrepância bomba real vs comando.
 *
 * Estas verificações NÃO dependem da rede nem do backend: correm local,
 * em ciclo, e têm prioridade sobre qualquer comando.
 */

#include <Arduino.h>
#include "hardware/signals/signals.h"

namespace safety {

struct SafetyStatus {
  bool mcpPresent;
  bool thermalAlarm;   // relé térmico disparado
  bool km1Running;     // bomba em funcionamento (feedback físico)
  bool pumpBlocked;    // bomba deve ficar bloqueada
  bool commandedPump;  // último comando de bomba emitido
};

// O controlo da bomba chama este método em vez de escrever diretamente.
inline bool pumpAllowed() {
  const auto s = signals24v::snapshot();
  return s.mcpPresent && !s.thermal;
}

// Discrepância: comandámos a bomba mas o contacto KM1 não confirma.
inline bool pumpMismatch(bool commandedPump) {
  const auto s = signals24v::snapshot();
  if (!commandedPump) return false;
  return !s.km1; // pediu ON mas bomba não arrancou
}

} // namespace safety
