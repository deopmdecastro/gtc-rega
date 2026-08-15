#pragma once
/**
 * GTC Rega — Comunicação com a aplicação web
 * ------------------------------------------------------------------
 * Define as rotas da API local (interface web servida pelo ESP32-S3) e
 * a ponte com o backend. A implementação do servidor assíncrono está em
 * webui.h (para preservar a estrutura existente); esta camada agrega a
 * informação de estado (incluindo os novos sinais KM1/térmico/MCP).
 */

#include "config.h"
#include "hardware/signals/signals.h"

namespace communication::web {

// Estado agregado exposto à interface local e ao backend.
struct FieldState {
  bool mcpPresent;
  bool km1;        // bomba em funcionamento (feedback)
  bool thermal;    // alarme térmico
};

inline FieldState fieldState() {
  const auto s = signals24v::snapshot();
  return { s.mcpPresent, s.bomba, s.releTemp };
}

} // namespace communication::web
