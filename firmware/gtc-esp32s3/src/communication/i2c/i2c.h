#pragma once
/**
 * GTC Rega — Comunicação I2C (ES3N28P <-> MCP23017-E/SS)
 * ------------------------------------------------------------------
 * A inicialização do barramento I2C e a deteção do MCP23017 estão
 * centralizadas na camada de I/O (hardware/io/io.h -> io::begin()),
 * que configura SDA/SCL e faz o ping do expansor de forma fail-safe.
 *
 * Esta unidade de comunicação I2C existe para documentar a fronteira
 * física: o barramento I2C da ES3N28P liga o ESP32-S3 ao MCP23017 e,
 * opcionalmente, ao touchscreen (se a interface for I2C).
 *
 * Parâmetros (config.h):
 *   I2C_SDA_PIN, I2C_SCL_PIN, I2C_CLOCK_HZ, MCP23017_ADDRESS
 *
 * Nenhuma outra parte do firmware fala I2C diretamente — usa io::.
 */

#include <Arduino.h>
#include "config.h"
#include "hardware/io/io.h"

namespace communication::i2c {

// Atalho para a inicialização do barramento (delega em io::begin()).
inline bool begin() {
  return io::begin();
}

} // namespace communication::i2c
