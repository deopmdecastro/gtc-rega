# GTC Rega — Firmware ESP32-S3

Firmware PlatformIO que liga o controlador físico ao backend GTC Rega.

## O que faz

- Configuração WiFi por portal (`WiFiManager`) — AP `GTC-Rega-Setup` / `gtcrega123`.
- Lê sensores capacitivos de humidade **B1** e **B2** (ADC1, filtro exponencial).
- Envia telemetria para o backend e recebe as saídas desejadas (bomba + válvulas).
- Aciona relés de bomba e de cada zona.
- Paragem de emergência local (botão BOOT) e fail-safe: sem rede ou sem servidor
  durante 15 s, todas as saídas desligam.
- Watchdog de hardware (30 s).

## Ligações (ajustáveis em `src/config.h`)

| Função | GPIO |
|---|---|
| Sensor humidade B1 | 4 |
| Sensor humidade B2 | 5 |
| Válvula zona 1..6 | 6, 7, 11, 12, 13, 14 |
| Relé bomba (K5) | 8 |
| Relé stop (K6) | 9 |
| Relé auto (K7) | 10 |
| Botão emergência | 0 (BOOT) |
| LED estado | 48 |

Módulos de relé comuns são **ativos a LOW** (`RELAY_ACTIVE_LOW 1`).

## Instalar e compilar

```bash
# instalar o PlatformIO CLI (uma vez)
pip install -U platformio

cd firmware/gtc-esp32s3
pio run                 # compila (descarrega toolchain ESP32-S3 + libs)
pio run -t upload       # grava na placa
pio device monitor      # consola série a 115200
```

Dependências instaladas automaticamente pelo PlatformIO: `espressif32` (Arduino
core para ESP32-S3), `ArduinoJson` 7 e `WiFiManager` 2.

## Configurar

Edite `src/config.h`:

```c
#define GTC_SERVER_HOST  "192.168.1.50"  // IP do backend
#define GTC_SERVER_PORT  3000
#define GTC_DEVICE_TOKEN ""              // igual a DEVICE_TOKEN no backend
```

Calibre os sensores com `SENSOR_DRY_RAW` (ao ar) e `SENSOR_WET_RAW` (em água),
lendo os valores brutos na consola série.

## API usada no backend

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/device/hello` | handshake/registo |
| POST | `/api/device/telemetry` | sensores + estado; devolve saídas |
| GET | `/api/device/outputs` | saídas desejadas (bomba/zonas/relés) |
| GET | `/api/device/status` | estado do dispositivo (para a UI) |

Se `DEVICE_TOKEN` estiver definido no backend, o firmware envia o cabeçalho
`x-device-token`. Enquanto houver telemetria real, o motor deixa de simular
sensores e volta à simulação se o dispositivo ficar 30 s offline.
