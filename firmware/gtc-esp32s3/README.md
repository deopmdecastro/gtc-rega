# GTC Rega — Firmware (ES3N28P + ESP32-S3 + MCP23017)

Firmware PlatformIO do controlador físico GTC Rega.

## Plataforma física

| Elemento | Descrição |
|---|---|
| **Placa** | ES3N28P (controlador físico real) |
| **MCU** | ESP32-S3 (integrado na ES3N28P) |
| **Display** | LCD 2.8" 240×320 touch capacitivo |
| **Áudio** | speaker + microfone (preparado, v1 em stub) |
| **Armazenamento** | slot MicroSD (preparado, v1 em stub) |
| **Expansão I/O** | MCP23017-E/SS via I²C |
| **Isolamento** | optoacopladores em todos os sinais de campo de 24 VDC |

```
        ES3N28P (ESP32-S3)
              │
             I²C
              │
        MCP23017-E/SS  (16 GPIO)
              │
      optoacopladores
              │
          campo 24 VDC
```

## Arquitetura do firmware (`src/`)

```
src/
├── main.cpp                     — boot, loop, telecomunicações, watchdog
├── config.h                     — TODOS os pinos/mapas centralizados aqui
├── webui.h                      — interface web local + API JSON
├── hardware/
│   ├── es3n28p/                 — identidade da placa ES3N28P
│   ├── mcp23017/                — driver do expansor I/O (fail-safe)
│   ├── io/                      — camada de abstração de I/O (única que toca hardware)
│   ├── signals/                 — sinais de campo 24 V (KM1 + térmico)
│   ├── display/                 — LCD (stub, HMI via web na v1)
│   ├── touch/                   — touch (stub)
│   └── audio/                   — speaker/mic (stub)
├── control/
│   ├── pump/                    — controlo da bomba (feedback KM1)
│   ├── irrigation/              — zonas + relés de comando
│   ├── alarms/                  — alarme térmico / NORMAL
│   └── safety/                  — bloqueios de segurança (térmico, MCP ausente)
└── communication/
    ├── i2c/                     — fronteira do barramento I²C
    └── web/                     — estado de campo p/ interface web/local
```

### Separação hardware/lógica

A lógica **nunca** usa `digitalRead()`/`digitalWrite()` diretos para os sinais
de campo. Tudo passa pela camada `io::`:

```cpp
bool pumpRunning = io::readKm1();     // feedback físico (KM1)
bool thermal     = io::readThermalAlarm();
io::writePump(true);
io::writeZone(0, true);
```

Assim, mudar o hardware futuro exige alterar apenas `hardware/io/io.h` e
`config.h`, não a lógica da aplicação.

## Sinais de campo (24 VDC isolados)

| Sinal | Contacto | Via | Significado |
|---|---|---|---|
| KM1 | auxiliar do contactor | opto + MCP GPA0 | bomba em **funcionamento** (feedback real) |
| Relé térmico | 95-96 (NF) / 97-98 (NA) | opto + MCP GPA1 | **alarme térmico** |

O contacto KM1 é tratado como **feedback real** do contactor/bomba — o
comando enviado pelo ESP32-S3 **não** é assumido como bomba a funcionar.

Quando o relé térmico dispara, o firmware:
- reconhece o alarme;
- reporta-o na telemetria e na interface local;
- **bloqueia a bomba** (a segurança local prevalece sobre qualquer comando);
- permite reset apenas depois de o relé ter sido rearmado fisicamente.

## Mapa de I/O (MCP23017) — centralizado em `config.h`

> Valores de exemplo — alinhar ao esquema elétrico real do quadro.

| Pino lógico | Símbolo | Direção |
|---|---|---|
| 0 (GPA0) | `MCP_INPUT_KM1` | entrada — KM1 |
| 1 (GPA1) | `MCP_INPUT_THERMAL` | entrada — relé térmico |
| 2…7 | reserva | entrada |
| 8 (GPB0) | `MCP_OUTPUT_RELAY_PUMP` | saída — bomba (K5) |
| 9 (GPB1) | `MCP_OUTPUT_RELAY_STOP` | saída — paragem (K6) |
| 10 (GPB2) | `MCP_OUTPUT_RELAY_AUTO` | saída — automático (K7) |
| 11…14 | `MCP_OUTPUT_ZONE_PINS[]` | saída — válvulas de zona |

### Fail-safe do MCP23017

Se o MCP23017 não responder no barramento I²C, `begin()` devolve `false` e:
- todas as leituras retornam o valor **seguro** (alarme térmico ativo);
- a bomba fica **bloqueada** (nunca se opera às cegas).

## I²C

- `I2C_SDA_PIN` / `I2C_SCL_PIN` / `I2C_CLOCK_HZ` em `config.h`.
- O ESP32-S3 usa GPIO Matrix, pelo que SDA/SCL podem ser reajustados sem
  alterar o esquema. **Confirmar o pinout real da ES3N28P**: os pinos do
  LCD/touch/MicroSD/áudio podem conflituar com os escolhidos por omissão.
- Se o touchscreen for I²C, partilhará o barramento com o MCP23017.

## O que faz (comportamento preservado)

- Configuração WiFi por portal (`WiFiManager`).
- Sensores capacitivos B1/B2 (ADC do ESP32-S3).
- Telemetria para o backend + saídas desejadas (bomba + válvulas).
- BLE (provisionamento/monitorização local).
- Interface web local (webui.h) + mDNS `gtc-rega.local`.
- Paragem de emergência local (botão) e fail-safe em perda de rede/servidor.
- Watchdog de hardware.

## Telemetria / estado (novos campos)

```json
{
  "platform": "ES3N28P",
  "pumpRunning":  true,
  "thermalAlarm": false,
  "mcpPresent":   true
}
```

Os campos existentes (`emergency`, `pump`, `sensors[]`, `gpio{}`) mantêm-se.

## Instalar e compilar

```bash
pip install -U platformio
cd firmware/gtc-esp32s3
pio run                 # compila
pio run -t upload       # grava
pio device monitor      # consola série 115200
```

## Configurar

Edite `src/config.h`. Em particular:

```c
#define GTC_SERVER_HOST  "192.168.1.50"
#define I2C_SDA_PIN      8
#define I2C_SCL_PIN      9
#define MCP23017_ADDRESS 0x20
```

## API usada no backend

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/device/hello` | handshake |
| POST | `/api/device/telemetry` | sensores + estado + KM1/térmico; devolve saídas |
| GET | `/api/device/outputs` | saídas desejadas |
| GET | `/api/device/status` | estado (UI) |
