#pragma once
/**
 * GTC Rega — Camada de I/O (abstração de hardware)
 * ------------------------------------------------------------------
 * A lógica de controlo NÃO conhece GPIOs físicos nem barramento I2C.
 * Usa esta interface:
 *
 *   io::writeMotorOn(true);
 *   bool running = io::readBombaOn();
 *
 * Internamente encaminha para o MCP23017 (campo isolado) ou para
 * GPIOs diretas do ESP32-S3 (sensores DHT22, botão emergência, LED).
 * Alterar hardware futuro = alterar só esta camada, nunca a lógica
 * da aplicação.
 */

#include <Arduino.h>
#include <Wire.h>
#include <DHT.h>
#include "config.h"
#include "hardware/mcp23017/mcp23017.h"

namespace io {

#ifdef WOKWI_SIM
// Wokwi não simula o MCP23017 nativo usado no quadro. Nesta variante,
// os sinais do expansor são espelhados em GPIOs livres do ESP32-S3 para
// que LEDs, relés e switches do diagram.json exercitem a mesma lógica.
inline constexpr int SIM_OUT_PINS[9] = { 4, 5, 6, 7, 8, 9, 10, 11, 12 };
inline constexpr int SIM_IN_PINS[2]  = { 13, 15 };
inline void simWrite(uint8_t pin, bool on) {
  if (pin < 9) digitalWrite(SIM_OUT_PINS[pin], on ? HIGH : LOW);
}
inline bool simRead(uint8_t pin) {
  if (pin == MCP_INPUT_BOMBA_ON) return digitalRead(SIM_IN_PINS[0]) == HIGH;
  if (pin == MCP_INPUT_RELE_TEMP_ON) return digitalRead(SIM_IN_PINS[1]) == HIGH;
  return false;
}
#endif

// Singleton do MCP23017 (instância única, criada na primeira utilização).
inline io::Mcp23017& mcp() {
  static io::Mcp23017 instance;
  return instance;
}

// Instâncias dos sensores DHT22 (criadas em begin()).
inline DHT& dht1() { static DHT instance(PIN_DHT22_1, DHT_TYPE); return instance; }
inline DHT& dht2() { static DHT instance(PIN_DHT22_2, DHT_TYPE); return instance; }

// ── Inicialização (única) ──
// Inicia o barramento I2C, deteta o MCP23017, configura GPIOs e DHT22.
inline bool begin() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, I2C_CLOCK_HZ);
  mcp().setBus(Wire);
  bool ok = mcp().begin();

  // DHT22 — 1-wire proprietário em IO21 / IO14.
  dht1().begin();
  dht2().begin();

  pinMode(PIN_EMERGENCY_BTN, INPUT_PULLUP);
  pinMode(PIN_STATUS_LED, OUTPUT);

#ifdef WOKWI_SIM
  // O simulador usa GPIOs livres para espelhar as saídas do MCP23017.
  for (int pin : SIM_OUT_PINS) { pinMode(pin, OUTPUT); digitalWrite(pin, LOW); }
  for (int pin : SIM_IN_PINS) pinMode(pin, INPUT_PULLDOWN);
  ok = true; // mantém a lógica de segurança testável no Wokwi.
#endif

  return ok;
}

inline bool mcpPresent() {
#ifdef WOKWI_SIM
  return true;
#else
  return mcp().present();
#endif
}

// ── Leituras DHT22 (ESP32-S3, IO21 / IO14) ──
struct DhtReading {
  float temperature;   // °C — NaN se falhou a leitura
  float humidity;      // %  — NaN se falhou a leitura
  bool  ok;
};

inline DhtReading readDht1() {
  DhtReading r = { NAN, NAN, false };
  float h = dht1().readHumidity();
  float t = dht1().readTemperature();
  if (isnan(h) || isnan(t)) return r;
  r.humidity = h; r.temperature = t; r.ok = true;
  return r;
}

inline DhtReading readDht2() {
  DhtReading r = { NAN, NAN, false };
  float h = dht2().readHumidity();
  float t = dht2().readTemperature();
  if (isnan(h) || isnan(t)) return r;
  r.humidity = h; r.temperature = t; r.ok = true;
  return r;
}

// ── Entradas via MCP23017 (PB6, PB7 — optoacopladores) ──
// PB6 — "Sinal da bomba ON" (24 V isolado por optoacoplador).
inline bool readBombaOn() {
#ifdef WOKWI_SIM
  return simRead(MCP_INPUT_BOMBA_ON);
#else
  return mcp().read(MCP_INPUT_BOMBA_ON, false);
#endif
}

// PB7 — "Sinal da Relé Temp ON" (24 V isolado por optoacoplador).
inline bool readReleTempOn() {
#ifdef WOKWI_SIM
  return simRead(MCP_INPUT_RELE_TEMP_ON);
#else
  return mcp().read(MCP_INPUT_RELE_TEMP_ON, false);
#endif
}

// ── Saídas via MCP23017 (Porto A — PA0..PA7 e PB0) ──
inline void writeMotorOn(bool on)      {
#ifdef WOKWI_SIM
  simWrite(MCP_OUTPUT_MOTOR_ON, on);
#else
  mcp().write(MCP_OUTPUT_MOTOR_ON, on);
#endif
}
inline void writeAutoGtc(bool on)      {
#ifdef WOKWI_SIM
  simWrite(MCP_OUTPUT_AUTO_GTC, on);
#else
  mcp().write(MCP_OUTPUT_AUTO_GTC, on);
#endif
}
inline void writeStoEmergGtc(bool on)  {
#ifdef WOKWI_SIM
  simWrite(MCP_OUTPUT_STO_EMERG_GTC, on);
#else
  mcp().write(MCP_OUTPUT_STO_EMERG_GTC, on);
#endif
}
inline void writeOnGtc(bool on)        {
#ifdef WOKWI_SIM
  simWrite(MCP_OUTPUT_ON_GTC, on);
#else
  mcp().write(MCP_OUTPUT_ON_GTC, on);
#endif
}
inline void writeTimeReg(bool on)      {
#ifdef WOKWI_SIM
  simWrite(MCP_OUTPUT_TIME_REG, on);
#else
  mcp().write(MCP_OUTPUT_TIME_REG, on);
#endif
}
inline void writeTimeDelay(bool on)    {
#ifdef WOKWI_SIM
  simWrite(MCP_OUTPUT_TIME_DELAY, on);
#else
  mcp().write(MCP_OUTPUT_TIME_DELAY, on);
#endif
}
inline void writeOutSensor1(bool on)   {
#ifdef WOKWI_SIM
  simWrite(MCP_OUTPUT_SENSOR_1, on);
#else
  mcp().write(MCP_OUTPUT_SENSOR_1, on);
#endif
}
inline void writeOutSensor2(bool on)   {
#ifdef WOKWI_SIM
  simWrite(MCP_OUTPUT_SENSOR_2, on);
#else
  mcp().write(MCP_OUTPUT_SENSOR_2, on);
#endif
}
inline void writeZone(uint8_t zone, bool on) {
  if (zone == 0) writeOutSensor1(on);
  else if (zone == 1) writeOutSensor2(on);
}
inline void writeAuto(bool on) { writeAutoGtc(on); }
inline void writeStop(bool on) { writeStoEmergGtc(on); }

inline void writeReleTempOn(bool on)   {
#ifdef WOKWI_SIM
  simWrite(MCP_OUTPUT_RELE_TEMP_ON, on);
#else
  mcp().write(MCP_OUTPUT_RELE_TEMP_ON, on);
#endif
}

inline void allOutputsOff() {
#ifdef WOKWI_SIM
  for (int pin : SIM_OUT_PINS) digitalWrite(pin, LOW);
#else
  mcp().allOff();
#endif
}

// ── Botão de emergência físico (ESP32-S3, GPIO 0 = BOOT) ──
inline bool emergencyPressed() { return digitalRead(PIN_EMERGENCY_BTN) == LOW; }

// ── LED de estado ──
inline void setStatusLed(bool on) { digitalWrite(PIN_STATUS_LED, on ? HIGH : LOW); }

} // namespace io
