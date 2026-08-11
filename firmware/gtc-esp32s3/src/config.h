#pragma once

// ─────────────────────────────────────────────────────────────
// GTC Rega — Configuração do hardware ESP32-S3
// Ajuste estes valores à sua instalação.
// ─────────────────────────────────────────────────────────────

// Servidor (backend Node/Express do GTC Rega)
#define GTC_SERVER_HOST   "192.168.1.50"   // IP ou hostname do backend
#define GTC_SERVER_PORT   3000
#define GTC_DEVICE_TOKEN  ""               // igual a DEVICE_TOKEN no backend ("" = sem token)
#define GTC_DEVICE_ID     "gtc-esp32s3-01"
#define GTC_FIRMWARE      "2.15.0"

// Portal WiFi (WiFiManager) — SSID do AP de configuração
#define GTC_AP_SSID       "GTC-Rega-Setup"
#define GTC_AP_PASS       "gtcrega123"

// Interface web local servida pelo ESP32 (LittleFS + ESPAsyncWebServer)
#define GTC_WEBUI_PORT    80
#define GTC_MDNS_HOST     "gtc-rega"

// Períodos (ms)
#define POLL_INTERVAL_MS        1000   // leitura de saídas desejadas
#define TELEMETRY_INTERVAL_MS   3000   // envio de sensores
#define SENSOR_SAMPLE_MS        500

// ── Relés (ativos a LOW nos módulos de relé comuns) ──
#define RELAY_ACTIVE_LOW  1

#define PIN_RELAY_PUMP    8    // K5 — bomba / arranque
#define PIN_RELAY_STOP    9    // K6 — paragem
#define PIN_RELAY_AUTO    10   // K7 — modo automático

// Válvulas por zona (até 6 zonas)
static const int ZONE_RELAY_PINS[] = { 6, 7, 11, 12, 13, 14 };
#define ZONE_COUNT (sizeof(ZONE_RELAY_PINS) / sizeof(ZONE_RELAY_PINS[0]))

// ── Sensores de humidade capacitivos (ADC1) ──
#define PIN_SENSOR_B1     4
#define PIN_SENSOR_B2     5

// Calibração ADC: valor em ar seco e submerso em água (12 bits, 0-4095)
#define SENSOR_DRY_RAW    3200
#define SENSOR_WET_RAW    1300

// Abaixo deste valor bruto considera-se que o sensor não está ligado
// (pino sem sinal) — usado para reportar entradas reais na vista HARDWARE
#define SENSOR_SIGNAL_RAW_MIN 60

// ── Entradas de segurança ──
#define PIN_EMERGENCY_BTN 0     // botão BOOT como paragem de emergência (INPUT_PULLUP)
#define PIN_STATUS_LED    48    // LED RGB on-board do DevKitC-1

// Watchdog de hardware (segundos) — reinicia se o loop bloquear
#define HW_WDT_TIMEOUT_S  30
