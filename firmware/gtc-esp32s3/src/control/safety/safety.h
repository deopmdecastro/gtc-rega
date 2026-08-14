#pragma once
/**
 * GTC Rega — Segurança / fail-safe
 * ------------------------------------------------------------------
 * Regras de segurança independentes da lógica de rega, baseadas no
 * pinout real do quadro GTC Rega:
 *   - PB7 (via opto) — Relé térmico de 24 V ON  => bloquear/impedir o motor.
 *   - MCP23017 ausente                              => nunca comandar saídas.
 *   - PB6 (via opto) — "Bomba ON" (24 V)          => deteção de discrepância
 *                                                    motor comandado vs motor real.
 *
 * Estas verificações NÃO dependem da rede nem do backend: correm local,
 * em ciclo, e têm prioridade sobre qualquer comando.
 */

#include <Arduino.h>
#include "hardware/signals/signals.h"

namespace safety {

struct SafetyStatus {
  bool mcpPresent;
  bool releTempOn;     // PB7 via opto — relé térmico de 24 V
  bool bombaRunning;   // PB6 via opto — feedback "bomba ON" (24 V)
  bool pumpBlocked;    // motor deve ficar bloqueado
  bool commandedMotor; // último comando de motor emitido
};

// O controlo do motor chama este método em vez de escrever diretamente.
inline bool pumpAllowed() {
  const auto s = signals24v::snapshot();
  return s.mcpPresent && !s.releTemp;
}

// Discrepância: comandámos o motor mas o sinal PB6 (24 V) não confirma.
inline bool pumpMismatch(bool commandedMotor) {
  const auto s = signals24v::snapshot();
  if (!commandedMotor) return false;
  return !s.bomba; // pediu ON mas o "Sinal da bomba ON" não aparece
}

} // namespace safety
