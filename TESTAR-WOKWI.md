# 🧪 Guia de Testes — Wokwi + Frontend GTC Rega

## 🔗 Arquitetura de Comunicação

```
[Wokwi Simulator]  ←──── rede virtual "Wokwi-GUEST" ────→  [Gateway 10.0.0.2]
  ESP32-S3 firmware                                              │
  POST /api/device/hello                                         │ porta 3000
  POST /api/device/telemetry                              [Backend Node.js]
  GET  /api/device/outputs                                       │
                                                                 │ Socket.IO
                                                          [Frontend React]
                                                           localhost:5173 (dev)
                                                           ou localhost:8080 (Docker)
```

---

## 🐛 Problemas Corrigidos

| # | Problema | Causa | Ficheiro |
|---|----------|-------|----------|
| 1 | ESP32 não alcançava o backend | IP hardcoded `192.168.1.50` em vez do gateway Wokwi `10.0.0.2` | `firmware/src/config.h` |
| 2 | Frontend não comunicava em dev | Sem proxy Vite para `/api` e `/socket.io` | `dc-rega-sistema-web/vite.config.ts` |
| 3 | Switches desconectados | `sw_bomba_fb` e `sw_temp_fb` não tinham ligação de feedback aos relés | `firmware/diagram.json` |
| 4 | Sem botões físicos | Diagrama não tinha botões START/STOP/RESET/AUTO | `firmware/diagram.json` |
| 5 | Botões sem handler | GPIO 34..37 não eram lidos no firmware | `firmware/src/main.cpp` |

---

## 🚀 Como Arrancar e Testar

### Opção A — Desenvolvimento Local (recomendado)

**Terminal 1 — Backend:**
```bash
cd dc-rega-sistema-web/backend
npm install
node server.js
# → GTC Rega API listening on port 3000
```

**Terminal 2 — Frontend:**
```bash
cd dc-rega-sistema-web
npm install
npm run dev
# → http://localhost:5173
```

**Wokwi (VS Code):**
1. Abre `firmware/gtc-esp32s3/` no VS Code com extensão Wokwi instalada
2. Compila: `pio run`
3. Clica ▶ no `diagram.json` → simulação arranca
4. O ESP32 liga à rede virtual `Wokwi-GUEST` e faz `POST http://10.0.0.2:3000/api/device/hello`
5. O frontend em `localhost:5173` recebe via Socket.IO o estado `deviceOnline: true`

---

### Opção B — Docker Completo

```bash
cd dc-rega-sistema-web
cp .env.example .env
docker-compose up --build
# Backend:  http://localhost:3000
# Frontend: http://localhost:8080
```

> ⚠️ No Wokwi com Docker: o backend corre em `localhost:3000` na tua máquina,
> logo o gateway Wokwi `10.0.0.2:3000` aponta corretamente para ele.

---

## 🎮 Testar com os Botões do Diagrama Wokwi

Com o simulador a correr, clica nos botões no `diagram.json`:

| Botão | GPIO | Ação Esperada |
|-------|------|---------------|
| 🟢 **START** | GPIO 34 | Motor ON + Modo AUTO ON → LED `led_motor` acende (vermelho) + LED `led_auto` acende (amarelo) |
| 🔴 **STOP** | GPIO 35 | Paragem de emergência → todos os LEDs apagam |
| 🔵 **RESET** | GPIO 36 | Limpa latch de emergência → sistema volta a IDLE |
| 🟡 **AUTO** | GPIO 37 | Toggle AUTO ON/OFF → LED `led_auto` acende/apaga |
| 🔴 **EMERGENCY** | GPIO 0 | Igual ao STOP mas físico (botão BOOT) |

### Switches de Feedback

| Switch | GPIO | Função |
|--------|------|--------|
| `sw_bomba_fb` | GPIO 13 | Simula contacto auxiliar KM1 (bomba a correr) → LED verde `led_fb_bomba` |
| `sw_temp_fb`  | GPIO 15 | Simula relé térmico ON (protecção disparada) → LED vermelho `led_fb_temp` |

> **Como testar o relé térmico:** Liga o `sw_temp_fb` enquanto o motor está ON.
> O motor deve desligar automaticamente (vês o LED vermelho `led_motor` apagar).

---

## 📡 Verificar Comunicação no Browser

Abre o frontend → **página "Estado"** ou **"Resumo"**:

- 🟢 **Backend Online** — canto superior direito mostra "Ligado"
- 🟢 **ESP32-S3 Online** — aparece o deviceId `gtc-es3n28p-01` com uptime a contar
- 📊 **GPIO ao vivo** — página "Estado" mostra os LEDs do MCP23017 a acender/apagar em tempo real

### Verificar via curl (terminal)
```bash
# Health do backend
curl http://localhost:3000/api/health

# Estado do device
curl http://localhost:3000/api/device/status

# Forçar START via API REST
curl -X POST http://localhost:3000/api/control/start \
     -H "Content-Type: application/json" \
     -d '{"pumpDelay": 2}'

# Forçar STOP
curl -X POST http://localhost:3000/api/control/stop

# Forçar RESET
curl -X POST http://localhost:3000/api/control/reset

# Ver eventos/log
curl http://localhost:3000/api/events?limit=20
```

---

## 🔍 Debug — Serial Monitor Wokwi

No simulador Wokwi o Serial Monitor mostra:
```
GTC Rega — ES3N28P (ESP32-S3) 3.1.0
[WIFI] Wokwi-GUEST conectado → modo simulação ativado
[WIFI] IP: 10.0.0.1
[GTC] handshake ok
[BTN] Botões manuais inicializados (GPIO 34/35/36/37)
...
[BTN] START pressionado
[MOTOR] ON
[BTN] AUTO ON
```

---

## ⚙️ Variáveis de Ambiente

Cria `dc-rega-sistema-web/.env` (copia de `.env.example`):

```env
# Desenvolvimento local — deixa vazio (proxy Vite redireciona para localhost:3000)
VITE_API_URL=

# Sem Supabase (usa backend Docker)
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=

# Token do device (deve ser igual ao GTC_DEVICE_TOKEN no config.h)
DEVICE_TOKEN=

# Diretório de dados (desenvolvimento)
DATA_DIR=./data
PORT=3000
```

