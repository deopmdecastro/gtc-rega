#pragma once
/**
 * GTC Rega — MCP23017-E/SS (expansor I/O via I2C)
 * ------------------------------------------------------------------
 * Camada única de acesso ao MCP23017. Nenhuma outra parte do firmware
 * fala I2C diretamente: toda a leitura/escrita de campo passa por aqui.
 *
 *   ESP32-S3 ── I2C ──► MCP23017 (GPA0-7 = entradas, GPB0-7 = saídas)
 *                             ▲
 *                             └── optoacopladores ── 24 VDC
 *
 * Inicialização fail-safe: se o MCP23017 não responder no barramento,
 * `begin()` devolve false e todas as leituras retornam o valor seguro
 * (alarme térmico ativo => bomba bloqueada), para nunca operar às cegas.
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
    // GPA (0-7) = entradas; GPB (8-15) = saídas
    _writeReg(MCP_IODIRA, 0xFF);
    _writeReg(MCP_IODIRB, 0x00);
    // Polaridade: mantém lógica normal (configurada em config.h na leitura)
    _writeReg(MCP_IPOLA, 0x00);
    _writeReg(MCP_IPOLB, 0x00);
    // Pull-ups desativados (as entradas vêm de optoacopladores com nível definido)
    _writeReg(MCP_GPPUA, 0x00);
    _writeReg(MCP_GPPUB, 0x00);
    // Saídas em repouso: tudo desligado (polaridade em config.h)
    _writeReg(MCP_GPIOB, _idleOutputValue());
    Serial.printf("[MCP23017] detetado em 0x%02X — entradas GPA=%02X saidas GPB=%02X\n",
                  MCP23017_ADDRESS, _readReg(MCP_GPIOA), _readReg(MCP_GPIOB));
    return true;
  }

  bool present() const { return _present; }

  // Lê um pino lógico (0..15). PINO_KM1/THERMAL usam optoacopladores.
  // Devolve o valor de segurança quando o MCP não está presente.
  bool read(uint8_t pin, bool safeValue = false) {
    if (!_present) return safeValue;
    uint8_t bankA = _readReg(MCP_GPIOA);
    uint8_t bankB = _readReg(MCP_GPIOB);
    if (pin < 8) return (bankA >> pin) & 0x01;
    return (bankB >> (pin - 8)) & 0x01;
  }

  // Escreve num pino lógico de saída (8..15).
  void write(uint8_t pin, bool on) {
    if (!_present) return;
    uint8_t b = _readReg(MCP_GPIOB);
    if (RELAY_ACTIVE_LOW) {
      if (on) b &= ~(1u << (pin - 8));
      else    b |=  (1u << (pin - 8));
    } else {
      if (on) b |=  (1u << (pin - 8));
      else    b &= ~(1u << (pin - 8));
    }
    _writeReg(MCP_GPIOB, b);
  }

  // Desliga todas as saídas (política de repouso — usado no boot e em emergência).
  void allOff() {
    if (!_present) return;
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
