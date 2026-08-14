#pragma once
/**
 * GTC Rega — ES3N28P (plataforma física do controlador)
 * ------------------------------------------------------------------
 * Define a identidade da placa ES3N28P (ESP32-S3 integrado):
 *   - LCD 2.8" 240x320 touch capacitivo
 *   - speaker, microfone, I2C, UART/serial, MicroSD, USB-C, bateria
 *   - botões RESET e BOOT
 *
 * Na v1 do firmware a HMI é servida pela interface web (não pelo LCD
 * local), mas a plataforma fica identificada e preparada para a HMI
 * local futura. Os periféricos on-board são declarados em config.h.
 */

#include <Arduino.h>
#include "config.h"

namespace es3n28p {

struct BoardInfo {
  const char* model       = "ES3N28P";
  const char* mcu         = "ESP32-S3";
  uint16_t displayWidth   = DISPLAY_WIDTH;   // 240
  uint16_t displayHeight  = DISPLAY_HEIGHT;  // 320
  bool hasTouch           = true;
  bool hasSpeaker         = true;
  bool hasMicrophone      = true;
  bool hasMicroSD         = true;
  bool hasBattery         = true;
  bool hasUsbC            = true;
};

inline BoardInfo info() { return BoardInfo(); }

// Marca de arranque (consola) — identifica a plataforma real.
inline void logIdentity() {
  BoardInfo b = info();
  Serial.printf("[BOARD] %s (%s) ldc %ux%u touch=%d audio=%d mic=%d sd=%d\n",
                b.model, b.mcu, b.displayWidth, b.displayHeight,
                b.hasTouch, b.hasSpeaker, b.hasMicrophone, b.hasMicroSD);
}

} // namespace es3n28p
