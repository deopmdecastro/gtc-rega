#pragma once
/**
 * GTC Rega — Áudio (speaker) e Microfone da ES3N28P
 * ------------------------------------------------------------------
 * A placa tem interface para speaker e microfone. Na v1 não são usados,
 * mas a arquitetura fica preparada para, no futuro:
 *   - sons de alarme;
 *   - confirmação de operação;
 *   - aviso de erro;
 *   - notificações sonoras.
 * Nenhuma dependência de áudio é criada agora; basta ativar o pino em
 * config.h (AUDIO_OUTPUT_PIN) e implementar os efeitos em audio.cpp.
 */

#include <Arduino.h>
#include "config.h"

namespace audio {

// IDs de eventos sonoros (futuro). Mantidos estáveis.
enum class Tone : uint8_t {
  Alarm,       // alarme crítico (ex.: térmico)
  Confirm,     // confirmação de operação
  Error,       // erro
  Notify,      // notificação genérica
};

// Stub — v1 não emite som. Preparado para a implementação futura.
inline void play(Tone) {
  if (AUDIO_OUTPUT_PIN < 0) return; // speaker não configurado
  // TODO: implementar envelope/efeitos no pino AUDIO_OUTPUT_PIN
}

inline void init() {
  Serial.println("[AUDIO] speaker ES3N28P em stub (AUDIO_OUTPUT_PIN) — notificacoes futuras");
}

} // namespace audio
