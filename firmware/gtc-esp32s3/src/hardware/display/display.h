#pragma once
/**
 * GTC Rega — Display LCD 2.8" (240x320) da ES3N28P
 * ------------------------------------------------------------------
 * Reservado para a HMI local. Na v1 a HMI é servida via web, pelo que
 * a implementação do driver gráfico fica em stub. Os pinos/interface
 * (SPI ou paralelo) devem ser confirmados na documentação da ES3N28P
 * antes de ativar — para não conflituar com I2C/UART/MicroSD/áudio.
 */

#include <Arduino.h>
#include "hardware/es3n28p/es3n28p.h"

namespace display {

inline void init() {
  // v1: sem driver do painel — HMI via web.
  Serial.printf("[DISPLAY] ES3N28P LCD %ux%u (touch capacitivo) — HMI local em stub (usa web)\n",
                DISPLAY_WIDTH, DISPLAY_HEIGHT);
}

} // namespace display
