#pragma once
/**
 * GTC Rega — Configuração de hardware
 * ------------------------------------------------------------------
 * Plataforma física: ES3N28P (ESP32-S3 integrado, LCD 2.8" 240x320,
 * touch capacitivo, speaker, microfone, I2C, MicroSD, USB-C).
 *
 *   ESP32-S3 (ES3N28P) ── I2C ──► MCP23017-E/SS ──► optoacopladores ──► campo 24 VDC
 *
 * PINOUT REAL DO QUADRO GTC REGA (confirmado no esquema elétrico):
 *   ESP32-S3:
 *     3VCC  -> 3.3 V (alimentação de DHT22 + MCP23017 + pull-ups)
 *     GND   -> 0 V (massa comum)
 *     IO16  -> MCP23017 SCL  (relógio I2C)
 *     IO18  -> MCP23017 SDA  (dados I2C)
 *     IO21  -> DHT22 #1 SDA  (sensor de temperatura/humidade 1)
 *     IO14  -> DHT22 #2 SDA  (sensor de temperatura/humidade 2)
 *     IO02  -> LIVRE (evita pinos de boot)
 *     IO03  -> LIVRE (evita pinos de boot)
 *
 *   MCP23017 (endereço 0x20, A0=A1=A2=GND):
 *     SCL/SDA  -> barramento I2C do ESP32-S3
 *     VCC/GND  -> 3.3 V partilhada
 *     RST      -> 3VCC (reset mantido em HIGH para evitar resets indesejados)
 *
 *     Porto A (PA0..PA7) — SAÍDAS do processo (8 sinais):
 *       PA0 — 9-E6  MOTOR ON                (comando arrancar motor)
 *       PA1 — 9-D6  AUTO GTC                (seleção de modo automático GTC)
 *       PA2 — 8-E6  STO/EMERG GTC           (paragem / emergência GTC)
 *       PA3 — 8-E6  ON GTC                  (arranque / ativação GTC)
 *       PA4 — 8-E6  Temp. Tempo de Rega     (temporização duração de rega)
 *       PA5 — 8-D6  Temp. Delay Bom / Val   (atraso entre bomba e válvulas)
 *       PA6 — 8-D6  Out Sensor 2            (saída / atuador sensor 2)
 *       PA7 —       Out Sensor 1            (saída / atuador sensor 1)
 *
 *     Porto B (PB0..PB7) — saídas + entradas isoladas:
 *       PB0 — 9-E6  RELE TEMP-ON            (relé de temperatura)
 *       PB6 —       Sinal da bomba ON       (entrada via optocoplador — feedback 24 V)
 *       PB7 —       Sinal da Relé Temp ON   (entrada via optocoplador — feedback 24 V)
 *       PB1..PB5 —  reserva
 */

// ─────────────────────────────────────────────────────────────
// Servidor (backend Node/Express do GTC Rega)
// ─────────────────────────────────────────────────────────────
#define GTC_SERVER_HOST   "192.168.1.50"   // IP ou hostname do backend
#define GTC_SERVER_PORT   3000
#define GTC_DEVICE_TOKEN  ""               // igual a DEVICE_TOKEN no backend ("" = sem token)
#define GTC_DEVICE_ID     "gtc-es3n28p-01"
#define GTC_FIRMWARE      "3.1.0"

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
#define SENSOR_SAMPLE_MS        2000    // DHT22 lê a cada ~2 s (limite do sensor)

// ─────────────────────────────────────────────────────────────
// I²C — ES3N28P (ESP32-S3) <-> MCP23017-E/SS
// ─────────────────────────────────────────────────────────────
// Pinos I2C do ESP32-S3 (GPIO Matrix: qualquer par serve, mas mantemos
// os pinos confirmados no esquema elétrico real do quadro).
#define I2C_SDA_PIN          18    // ESP32-S3 IO18 -> MCP23017 SDA
#define I2C_SCL_PIN          16    // ESP32-S3 IO16 -> MCP23017 SCL
#define I2C_CLOCK_HZ         100000   // 100 kHz (seguro para cabos de campo)

// Reset externo do MCP23017 (RST): mantido em HIGH (3.3V) para evitar
// resets por ruído do barramento.
#define MCP_RESET_PIN        -1       // ligado externamente a 3VCC

// Endereço I²C do MCP23017 (A2:A1:A0 = 000 => 0x20).
#define MCP23017_ADDRESS      0x20    // A0=A1=A2=GND (confirmado)

// ─────────────────────────────────────────────────────────────
// Mapeamento central de I/O — MCP23017-E/SS
// ------------------------------------------------------------------
// Os números abaixo (0..15) são o ÍNDICE INTERNO do MCP23017:
//   GPA0..GPA7 = 0..7   (silkscreen PA0..PA7)
//   GPB0..GPB7 = 8..15  (silkscreen PB0..PB7)
// ------------------------------------------------------------------
//
// Porto A (PA0..PA7) — todas SAÍDAS (lógica LOW = ativo para relés comuns):
//   PA0 = índice 0  — MOTOR ON                  (9-E6)
//   PA1 = índice 1  — AUTO GTC                  (9-D6)
//   PA2 = índice 2  — STO/EMERG GTC             (8-E6)
//   PA3 = índice 3  — ON GTC                    (8-E6)
//   PA4 = índice 4  — Temp. Tempo de Rega       (8-E6)
//   PA5 = índice 5  — Temp. Delay Bom/Val       (8-D6)
//   PA6 = índice 6  — Out Sensor 2              (8-D6)
//   PA7 = índice 7  — Out Sensor 1
//
#define MCP_OUTPUT_MOTOR_ON       0   // PA0 — 9-E6  MOTOR ON
#define MCP_OUTPUT_AUTO_GTC       1   // PA1 — 9-D6  AUTO GTC
#define MCP_OUTPUT_STO_EMERG_GTC  2   // PA2 — 8-E6  STO/EMERG GTC
#define MCP_OUTPUT_ON_GTC         3   // PA3 — 8-E6  ON GTC
#define MCP_OUTPUT_TIME_REG       4   // PA4 — 8-E6  Temp. Tempo de Rega
#define MCP_OUTPUT_TIME_DELAY     5   // PA5 — 8-D6  Temp. Delay Bom/Val
#define MCP_OUTPUT_SENSOR_2       6   // PA6 — 8-D6  Out Sensor 2
#define MCP_OUTPUT_SENSOR_1       7   // PA7 —      Out Sensor 1

//
// Porto B (PB0..PB7) — mistura de saídas (PB0) e entradas via optocoplador (PB6, PB7):
//   PB0 = índice 8  — RELE TEMP-ON             (9-E6)  — saída
//   PB1..PB5 (índices 9..13) — reserva
//   PB6 = índice 14 — Sinal da bomba ON        — entrada isolada por opto
//   PB7 = índice 15 — Sinal da Relé Temp ON    — entrada isolada por opto
//
#define MCP_OUTPUT_RELE_TEMP_ON   8   // PB0 — 9-E6 RELE TEMP-ON
#define MCP_INPUT_BOMBA_ON        14  // PB6 — feedback "bomba ON" (24V via opto)
#define MCP_INPUT_RELE_TEMP_ON    15  // PB7 — feedback "relé temp ON" (24V via opto)

// ─────────────────────────────────────────────────────────────
// Polaridade das saídas (relés do quadro — confirmar no esquema
// elétrico se algum está ativo a HIGH).
// ─────────────────────────────────────────────────────────────
#define RELAY_ACTIVE_LOW      1

// ─────────────────────────────────────────────────────────────
// Polaridade das ENTRADAS isoladas (optocopladores)
// ------------------------------------------------------------------
// PB6 — "Sinal da bomba ON": nível lógico na presença de 24 V.
// PB7 — "Sinal da Relé Temp ON": idem.
// As leituras são feitas pela camada hardware/signals/signals.h.
// ─────────────────────────────────────────────────────────────
#define FIELD_BOMBA_ON_ACTIVE_HIGH   1   // opto conduz quando 24 V presente -> HIGH
#define FIELD_RELE_TEMP_ON_ACTIVE_HIGH 1

// ─────────────────────────────────────────────────────────────
// GPIOs diretas do ESP32-S3 — sensores DHT22 (temperatura + humidade)
// ------------------------------------------------------------------
// DHT22: 1-wire proprietário, biblioteca DHT sensor library.
// Pinos IO02 e IO03 ficam LIVRES (evitam interferir com o boot/USB).
// ------------------------------------------------------------------
#define PIN_DHT22_1        21   // ESP32-S3 IO21 -> DHT22 #1 (T/H 1)
#define PIN_DHT22_2        14   // ESP32-S3 IO14 -> DHT22 #2 (T/H 2)
#define DHT_TYPE           DHT22

// Tipos DHT (id semântico)
#define SENSOR_DHT_ID_1    "DHT1"
#define SENSOR_DHT_ID_2    "DHT2"

// Entrada de segurança (botão físico de emergência — botão BOOT)
#define PIN_EMERGENCY_BTN  0    // botão BOOT (INPUT_PULLUP)

// LED de estado (ajustar ao LED disponível na ES3N28P)
#define PIN_STATUS_LED     48

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
