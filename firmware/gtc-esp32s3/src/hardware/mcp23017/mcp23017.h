#pragma once
/**
 * GTC Rega — MCP23017-E/SS (expansor I/O via I2C)
 * ------------------------------------------------------------------
 * Camada única de acesso ao MCP23017. Nenhuma outra parte do firmware
 * fala I2C diretamente: toda a leitura/escrita de campo passa por aqui.
 *
 *   ESP32-S3 ── I2C ──► MCP23017 (GPA0-7 = saídas, GPB0 = saída, PB6/PB7 = entradas opto)
 *                             ▲
 *                             └── optoacopladores ── 24 VDC
 *
 * Pinout do quadro GTC Rega:
 *   PA0 (GPA0) — 9-E6  MOTOR ON                (saída)
 *   PA1 (GPA1) — 9-D6  AUTO GTC                (saída)
 *   PA2 (GPA2) — 8-E6  STO/EMERG GTC           (saída)
 *   PA3 (GPA3) — 8-E6  ON GTC                  (saída)
 *   PA4 (GPA4) — 8-E6  Temp. Tempo de Rega     (saída)
 *   PA5 (GPA5) — 8-D6  Temp. Delay Bom/Val     (saída)
 *   PA6 (GPA6) — 8-D6  Out Sensor 2            (saída)
 *   PA7 (GPA7) —      Out Sensor 1             (saída)
 *   PB0 (GPB0) — 9-E6  RELE TEMP-ON            (saída)
 *   PB6 (GPB6) —      Sinal bomba ON           (entrada via opto)
 *   PB7 (GPB7) —      Sinal Relé Temp ON       (entrada via opto)
 *
 * Inicialização fail-safe: se o MCP23017 não responder no barramento,
 * `begin()` devolve false e todas as leituras retornam o valor seguro.
 */

#include <Arduino.h>
#include <Wire.h>
#include "config.h"

namespace io {

// Registos do MCP23017 (Bank=0)
enum : uint8_t {
  MCP_IODIRA = 0x00, MCP_IODIRB = 0x01,
  MCP_IPOLA  = 0x02, MCP_IPOLB  = 0x03,
  MCP_GPINTENA = 0x04, MCP_GPINTENB = 0x05,
  MCP_DEFVALA  = 0x06, MCP_DEFVALB  = 0x07,
  MCP_INTCONA  = 0x08, MCP_INTCONB  = 0x09,
  MCP_IOCONA   = 0x0A, MCP_IOCONB   = 0x0B,
  MCP_GPPUA    = 0x0C, MCP_GPPUB    = 0x0D,
  MCP_GPIOA    = 0x12, MCP_GPIOB    = 0x13,
  MCP_OLATA    = 0x14, MCP_OLATB    = 0x15,
};

class Mcp23017 {
public:
  void setBus(TwoWire& wire) { _wire = &wire; _present = false; }

  // Devolve true se o MCP23017 responder no barramento.
  bool begin() {
    _present = _ping();
    if (!_present) {
      Serial.println("[MCP23017] NAO DETETADO no barramento I2C — modo fail-safe");
      return false;
    }
    // Conforme pinout real do quadro:
    //   GPA (0-7) = TODAS saídas
    //   GPB (0-7) = PB0 saída, PB1..PB5 reserva saída, PB6/PB7 entradas (opto)
    _writeReg(MCP_IODIRA, 0x00);   // porto A: tudo saídas
    _writeReg(MCP_IODIRB, 0xC0);   // porto B: 0b1100_0000 -> PB6/PB7 entradas, resto saída
    // Polaridade: normal
    _writeReg(MCP_IPOLA, 0x00);
    _writeReg(MCP_IPOLB, 0x00);
    // Pull-ups internos desativados nas duas portas — entradas opto têm
    // pull-up externo no quadro.
    _writeReg(MCP_GPPUA, 0x00);
    _writeReg(MCP_GPPUB, 0x00);
    // Saídas em repouso: tudo desligado (polaridade em config.h)
    _writeReg(MCP_GPIOB, _idleOutputValue());
    Serial.printf("[MCP23017] detetado em 0x%02X — GPA=0x%02X GPB=0x%02X\n",
                  MCP23017_ADDRESS, _readReg(MCP_GPIOA), _readReg(MCP_GPIOB));
    return true;
  }

  bool present() const { return _present; }

  // Lê um pino lógico (0..15). PB6/PB7 vêm dos optocopladores.
  // Devolve o valor de segurança quando o MCP não está presente.
  bool read(uint8_t pin, bool safeValue = false) {
    if (!_present) return safeValue;
    uint8_t bankA = _readReg(MCP_GPIOA);
    uint8_t bankB = _readReg(MCP_GPIOB);
    if (pin < 8) return (bankA >> pin) & 0x01;
    return (bankB >> (pin - 8)) & 0x01;
  }

  // Escreve num pino lógico (0..15).
  void write(uint8_t pin, bool on) {
    if (!_present) return;
    if (pin < 8) {
      uint8_t a = _readReg(MCP_GPIOA);
      if (RELAY_ACTIVE_LOW) {
        if (on) a &= ~(1u << pin);
        else    a |=  (1u << pin);
      } else {
        if (on) a |=  (1u << pin);
        else    a &= ~(1u << pin);
      }
      _writeReg(MCP_GPIOA, a);
    } else {
      uint8_t b = _readReg(MCP_GPIOB);
      uint8_t p = pin - 8;
      if (RELAY_ACTIVE_LOW) {
        if (on) b &= ~(1u << p);
        else    b |=  (1u << p);
      } else {
        if (on) b |=  (1u << p);
        else    b &= ~(1u << p);
      }
      _writeReg(MCP_GPIOB, b);
    }
  }

  // Desliga todas as saídas (política de repouso — usado no boot e em emergência).
  void allOff() {
    if (!_present) return;
    _writeReg(MCP_GPIOA, _idleOutputValue());
    _writeReg(MCP_GPIOB, _idleOutputValue());
  }

private:
  TwoWire* _wire = &Wire;
  bool _present = false;

  uint8_t _idleOutputValue() const { return RELAY_ACTIVE_LOW ? 0xFF : 0x00; }

  bool _ping() {
    _wire->beginTransmission(MCP23017_ADDRESS);
    return _wire->endTransmission() == 0;
  }

  void _writeReg(uint8_t reg, uint8_t val) {
    _wire->beginTransmission(MCP23017_ADDRESS);
    _wire->write(reg);
    _wire->write(val);
    _wire->endTransmission();
  }

  uint8_t _readReg(uint8_t reg) const {
    _wire->beginTransmission(MCP23017_ADDRESS);
    _wire->write(reg);
    if (_wire->endTransmission() != 0) return 0;
    _wire->requestFrom((uint16_t)MCP23017_ADDRESS, (uint8_t)1);
    return _wire->available() ? _wire->read() : 0;
  }
};

} // namespace io
