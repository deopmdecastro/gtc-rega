#pragma once
/**
 * GTC Rega — Touchscreen capacitivo da ES3N28P
 * ------------------------------------------------------------------
 * Reservado para a HMI local. Interface (I2C ou SPI) a confirmar no
 * pinout da ES3N28P. Se I2C, partilhará o barramento com o MCP23017.
 */

#include <Arduino.h>
#include "config.h"

namespace touch {

inline void init() {
  if (TOUCH_I2C_ADDR != 0x00) {
    Serial.printf("[TOUCH] capacitivo I2C @0x%02X (partilha barramento com MCP23017)\n", TOUCH_I2C_ADDR);
  } else {
    Serial.println("[TOUCH] capacitivo — interface a confirmar no pinout da ES3N28P (stub)");
  }
}

} // namespace touch
