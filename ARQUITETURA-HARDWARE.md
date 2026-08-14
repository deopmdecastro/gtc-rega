# GTC Rega — Arquitetura de hardware

Documento de referência da arquitetura física do controlador.

> Versão 3.0.0 — migração para **ES3N28P + ESP32-S3 + MCP23017-E/SS**.

## 1. Plataforma

O controlador físico é a placa **ES3N28P**, que integra um **ESP32-S3** como
microcontrolador principal. **Não** é um ESP32 DevKit genérico.

Periféricos integrados da ES3N28P:

- ESP32-S3 (MCU principal);
- display LCD 2.8" (240×320);
- touchscreen capacitivo;
- interface para speaker;
- microfone;
- interface I²C;
- pinos de expansão;
- interface UART/serial;
- slot MicroSD;
- interface de alimentação/bateria;
- USB Type-C;
- botões RESET e BOOT.

## 2. Responsabilidades do ESP32-S3

- lógica principal do sistema;
- controlo do sistema de rega;
- comunicação Wi-Fi;
- comunicação com a interface web;
- controlo da HMI (display + touchscreen);
- gestão de estados, alarmes e temporizações;
- comunicação I²C com o MCP23017;
- processamento dos sensores e comando dos atuadores;
- diagnóstico do sistema.

## 3. Expansão de I/O — MCP23017-E/SS

O MCP23017 é o expansor de entradas/saídas digitais via I²C:

```
ES3N28P (ESP32-S3) ── I²C ──► MCP23017 (16 GPIO)
                                   │
                              GPA0…GPA7  entradas
                              GPB0…GPB7  saídas
```

O firmware abstrai o MCP23017 numa camada própria (`hardware/mcp23017/`) e não
espalha chamadas I²C pela aplicação.

## 4. Sinais industriais de 24 VDC

Os sinais de 24 VDC **não** ligam diretamente ao ESP32-S3 nem ao MCP23017.
A interface usa optoacopladores:

```
Circuito industrial 24 VDC
        │
        ▼
Contacto / sensor
        │
        ▼
Resistor
        │
        ▼
Optoacoplador
        │
        ▼
Sinal lógico (3v3)
        │
        ▼
MCP23017 ── I²C ──► ESP32-S3
```

O objetivo é manter o circuito de 24 V galvanicamente isolado da eletrónica de
baixa tensão.

## 5. Monitorização de KM1 (bomba em funcionamento)

O contacto auxiliar de **KM1** determina se a bomba está realmente a funcionar:

```
24 VDC → contacto auxiliar KM1 → resistor → optoacoplador → MCP23017 → ESP32-S3
```

Interpretação:

| KM1 | Estado |
|---|---|
| OFF | bomba parada |
| ON | bomba em funcionamento |

O comando enviado pelo ESP32-S3 **não** é assumido como bomba a funcionar — o
contacto KM1 é **feedback real** do estado do contactor/bomba.

## 6. Monitorização do relé térmico

O relé térmico é monitorizado por optoacoplador, usando o contacto auxiliar
apropriado:

| Contactos | Tipo |
|---|---|
| 95-96 | normalmente fechado (NF) |
| 97-98 | normalmente aberto (NA) |

A escolha definitiva respeita o esquema elétrico real do quadro. A aplicação
representa claramente **NORMAL** vs **ALARME TÉRMICO**.

Quando o relé térmico dispara, o sistema:
- reconhece o alarme;
- indica-o na HMI e na interface web;
- **impede/limita** o funcionamento da bomba;
- guarda o evento no histórico (quando disponível);
- permite reset apenas segundo a lógica definida (rearme físico do relé).

## 7. Mapa de I/O do MCP23017 (centralizado em `config.h`)

> Números de exemplo — alinhar ao esquema elétrico real do GTC Rega.

```cpp
#define MCP23017_ADDRESS 0x20

#define MCP_INPUT_KM1        0   // GPA0 — bomba em funcionamento
#define MCP_INPUT_THERMAL    1   // GPA1 — relé térmico

#define MCP_OUTPUT_RELAY_PUMP 8  // GPB0 — bomba (K5)
#define MCP_OUTPUT_RELAY_STOP 9  // GPB1 — paragem (K6)
#define MCP_OUTPUT_RELAY_AUTO 10 // GPB2 — automático (K7)
// zonas: GPB3…GPB6 (MCP_OUTPUT_ZONE_PINS[])
```

Uso pela camada de I/O (sem pinos espalhados pelo código):

```cpp
bool b = io::readKm1();
io::writePump(true);
```

## 8. I²C na ES3N28P

Antes de fixar os GPIOs do I²C, verificar na documentação/pinout da ES3N28P:

- pinos disponíveis na interface de expansão;
- pinos usados pelo LCD;
- touchscreen;
- MicroSD;
- áudio;
- outros periféricos integrados.

**Não** assumir os GPIOs de um ESP32 DevKit genérico. O ESP32-S3 usa GPIO
Matrix, pelo que SDA/SCL podem ser reajustados em `config.h` sem alterar o
esquema.

### Pinout físico do MCP23017-E/SS (confirmado pelo silkscreen)

O MCP23017-E/SS expõe fisicamente os seguintes pinos:

| Pino | Função |
|---|---|
| `SCL` / `SDA` | barramento I²C (ligam ao ESP32-S3) |
| `PA0` … `PA7` | porto A — GPA0…GPA7 (entradas) |
| `PB0` … `PB7` | porto B — GPB0…GPB7 (saídas) |
| `RST` | reset externo (ativo LOW; opcional) |
| `VCC` / `GND` | alimentação (3V3 partilhada) |

Correspondência com o mapa de I/O do firmware:

- `PA0 (GPA0)` → `MCP_INPUT_KM1` (feedback da bomba);
- `PA1 (GPA1)` → `MCP_INPUT_THERMAL` (relé térmico);
- `PB0 (GPB0)` → `MCP_OUTPUT_RELAY_PUMP` (bomba K5);
- `PB1 (GPB1)` → `MCP_OUTPUT_RELAY_STOP` (paragem K6);
- `PB2 (GPB2)` → `MCP_OUTPUT_RELAY_AUTO` (automático K7);
- `PB3…PB6 (GPB3…GPB6)` → válvulas de zona.

Endereço I²C: **`0x20`** (A2:A1:A0 = 000) — **confirmado no hardware**
com os pinos de endereço A0/A1/A2 ligados a GND. Valor em
`MCP23017_ADDRESS` no `config.h`.

> **Em aberto**: o par de GPIOs **específico** do ESP32-S3 a usar para
> SDA/SCL ainda não está confirmado no pinout da ES3N28P. O firmware usa
> por omissão `I2C_SDA_PIN=8` / `I2C_SCL_PIN=9` (reajustáveis em `config.h`),
> ligando aos pinos `SDA`/`SCL` do MCP acima.

## 9. Display, touch, áudio, MicroSD

- **LCD 240×320 + touch**: a HMI local respeita a resolução física; na v1 a
  HMI é servida via web (`webui.h`), com o display/touch em stub.
- **Speaker**: arquitetura preparada para sons de alarme/confirmação/erro.
- **Microfone**: não usado na v1, sem arquitetura que o impeça no futuro.
- **MicroSD**: preparado para logs, histórico, configurações e exportação.

## 10. Segurança / fail-safe (firmware)

- `MCP23017` ausente no barramento → `begin()` devolve `false`, leituras
  retornam valor seguro e a bomba fica **bloqueada**.
- Alarme térmico ativo → bomba desligada imediatamente, independente da rede.
- Reset do alarme térmico só após rearme físico do relé.
