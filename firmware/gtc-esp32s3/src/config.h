#pragma once
/**
 * GTC Rega — Configuração de hardware
 * ------------------------------------------------------------------
 * Plataforma física: ES3N28P (ESP32-S3 integrado, LCD 2.8" 240x320,
 * touch capacitivo, speaker, microfone, I2C, MicroSD, USB-C).
 *
 *  ESP32-S3 (ES3N28P) ── I2C ──► MCP23017-E/SS ──► optoacopladores ──► campo 24 VDC
 *
 * NOTA SOBRE OS PINOS: os valores abaixo são o mapeamento central do
 * projeto. Ajuste-os à ES3N28P real antes de gravar — em particular os
 * pinos I2C (SDA/SCL) e os pinos do display/touch/audio, que dependem
 * da revisão da placa e das ligações da interface de expansão.
 * Nenhum pino deve ser assumido de um ESP32 DevKit genérico.
 */

// ─────────────────────────────────────────────────────────────
// Servidor (backend Node/Express do GTC Rega)
// ─────────────────────────────────────────────────────────────
#define GTC_SERVER_HOST   "192.168.1.50"   // IP ou hostname do backend
#define GTC_SERVER_PORT   3000
#define GTC_DEVICE_TOKEN  ""               // igual a DEVICE_TOKEN no backend ("" = sem token)
#define GTC_DEVICE_ID     "gtc-es3n28p-01"
#define GTC_FIRMWARE      "3.0.0"

// Portal WiFi (WiFiManager) — SSID do AP de configuração
#define GTC_AP_SSID       "GTC-Rega-Setup"
#define GTC_AP_PASS       "gtcrega123"

// ─────────────────────────────────────────────────────────────
// Bluetooth Low Energy (BLE)
// ─────────────────────────────────────────────────────────────
#define GTC_BLE_NAME          "GTC-Rega-BLE"
#define GTC_BLE_SERVICE_UUID       "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define GTC_BLE_STATUS_CHAR_UUID   "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define GTC_BLE_COMMAND_CHAR_UUID  "6e400003-b5a3-f393-e0a9-e50e24dcca9e"
#define GTC_BLE_PIN           123456

// Interface web local servida pelo ESP32 (LittleFS + ESPAsyncWebServer)
#define GTC_WEBUI_PORT    80
#define GTC_MDNS_HOST     "gtc-rega"

// Períodos (ms)
#define POLL_INTERVAL_MS        1000
#define TELEMETRY_INTERVAL_MS   3000
#define SENSOR_SAMPLE_MS        500

// ─────────────────────────────────────────────────────────────
// I²C — ES3N28P <-> MCP23017-E/SS
// ─────────────────────────────────────────────────────────────
// A ES3N28P expõe barramento I2C na interface de expansão. O MCP23017
// liga-se a esse barramento. Verificar o pinout real da placa para
// SDA/SCL — o ESP32-S3 permite mapear I2C por GPIO Matrix.
#define I2C_SDA_PIN           8
#define I2C_SCL_PIN           9
#define I2C_CLOCK_HZ          100000   // 100 kHz (seguro para cabos de campo)

// MCP23017
#define MCP23017_ADDRESS      0x20    // A0=A1=A2=GND

// ─────────────────────────────────────────────────────────────
// Mapeamento central de I/O — MCP23017-E/SS (16 GPIO: GPA0-7, GPB0-7)
// ------------------------------------------------------------------
// Entradas (GPA = lógica de baixa tensão, via optoacopladores):
//   GPA0 — KM1 (contacto auxiliar do contactor => bomba em funcionamento)
//   GPA1 — Relé térmico (alarme térmico)
//   GPA2..GPA7 — reserva
// Saídas (GPB = comando de relés de campo):
//   GPB0 — bomba/arranque (K5), GPB1 — paragem (K6), GPB2 — automático (K7),
//   GPB3..GPB6 — válvulas de zona
// ------------------------------------------------------------------
// ATENÇÃO: números de exemplo — alinhar com o esquema elétrico real.
#define MCP_INPUT_KM1         0    // GPA0
#define MCP_INPUT_THERMAL     1    // GPA1

#define MCP_OUTPUT_RELAY_PUMP 8    // GPB0 — bomba / arranque (K5)
#define MCP_OUTPUT_RELAY_STOP 9    // GPB1 — paragem / emergência (K6)
#define MCP_OUTPUT_RELAY_AUTO 10   // GPB2 — modo automático (K7)
// Válvulas por zona (até 6), a partir de GPB3
static const uint8_t MCP_OUTPUT_ZONE_PINS[] = { 11, 12, 13, 14, 15, 0xFF };
#define ZONE_COUNT (6)

// ─────────────────────────────────────────────────────────────
// Polaridade das saídas (relés ativos a LOW nos módulos comuns)
// ─────────────────────────────────────────────────────────────
#define RELAY_ACTIVE_LOW      1

// ─────────────────────────────────────────────────────────────
// Sinais de campo 24 VDC — isolamento por optoacoplador
// ------------------------------------------------------------------
// Os sinais de 24 VDC NUNCA ligam diretamente ao ESP32-S3 nem ao
// MCP23017. Passam por: 24VDC -> resistor -> optoacoplador -> lógica
// de baixa tensão -> MCP23017 -> I2C -> ESP32-S3.
//   - contactor fechado (KM1 ON)  => bomba em funcionamento
//   - relé térmico (95-96) aberto => alarme térmico
#define FIELD_KM1_ACTIVE_LOW       0   // 1 = lê LOW quando bomba ligada
#define FIELD_THERMAL_ACTIVE_LOW   0   // 1 = lê LOW quando em alarme
#define FIELD_THERMAL_NC           1   // contacto normalmente fechado (95-96)

// ─────────────────────────────────────────────────────────────
// GPIOs diretas do ESP32-S3 (periféricos integrados da ES3N28P)
// ─────────────────────────────────────────────────────────────
#define PIN_SENSOR_B1     4    // sensor humidade B1 (ADC1)
#define PIN_SENSOR_B2     5    // sensor humidade B2 (ADC1)

// Calibração ADC (12 bits, 0-4095)
#define SENSOR_DRY_RAW    3200
#define SENSOR_WET_RAW    1300
#define SENSOR_SIGNAL_RAW_MIN 60

// Entrada de segurança (botão físico de emergência)
#define PIN_EMERGENCY_BTN 0     // botão BOOT (INPUT_PULLUP)

// LED de estado (ajustar ao LED disponível na ES3N28P)
#define PIN_STATUS_LED    48

// ─────────────────────────────────────────────────────────────
// Display + Touch (LCD 2.8" 240x320 capacitivo — ES3N28P)
// ─────────────────────────────────────────────────────────────
// Reservado para a HMI. A v1 concentra a HMI na interface web; os pinos
// abaixo ficam documentados para a HMI local futura (evitar conflito
// com I2C/UART/SPI/MicroSD).
#define DISPLAY_WIDTH      240
#define DISPLAY_HEIGHT     320
#define DISPLAY_BACKLIGHT  -1      // -1 = desativado (sem controlo)
#define TOUCH_INT_PIN      -1
#define TOUCH_I2C_ADDR     0x00    // 0 = não configurado na v1

// ─────────────────────────────────────────────────────────────
// Áudio (speaker) e MicroSD — preparados, não usados na v1
// ─────────────────────────────────────────────────────────────
#define AUDIO_OUTPUT_PIN   -1      // DAC/GPIO do speaker (futuro)
#define SD_CS_PIN          -1      // chip-select do MicroSD (futuro, SPI)

// Watchdog de hardware (segundos)
#define HW_WDT_TIMEOUT_S  30
