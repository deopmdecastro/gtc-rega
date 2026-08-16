# Testes GTC Rega — Wokwi ↔ Backend ↔ Frontend

Guia passo-a-passo para validar a comunicação completa entre o simulador
Wokwi (ESP32-S3), o backend Node.js e o frontend React.

---

## 1. Arquitetura de comunicação

```
┌──────────────────────┐        ┌────────────────────────────┐
│  Wokwi (browser/VS)  │  HTTP  │  Backend Node.js  :3000    │
│  ESP32-S3 firmware   │───────►│  /api/device/hello         │
│  ─ WiFi: Wokwi-GUEST │        │  /api/device/telemetry     │
│  ─ Host alvo:        │        │  /api/device/outputs       │
│    host.wokwi.internal        │  /api/device/status        │
└──────────┬───────────┘        └──────────────┬─────────────┘
           │                                    │ Socket.IO
           │ Private Wokwi IoT Gateway          │
           │ (necessário p/ o ESP32 alcançar    ▼
           │  o teu backend na tua LAN)         ┌────────────────────┐
           │                                    │  Frontend Vite     │
           └───────────────────────────────────►│  http://localhost  │
                                                │       :5173        │
                                                │  (proxy /api +     │
                                                │   /socket.io ->    │
                                                │   backend:3000)    │
                                                └────────────────────┘
```

> Nota importante: o Wokwi corre num contentor no browser, **não** vê o teu
> `localhost` diretamente. Para o ESP32 alcançar o backend usa-se o *Private
> Wokwi IoT Gateway* (extensão Wokwi para VS Code) que expõe
> `host.wokwi.internal:3000` como sendo a tua máquina local.

---

## 2. O que foi corrigido nesta iteração

| # | Problema | Causa | Correção |
|---|----------|-------|----------|
| 1 | ESP32 não alcançava o backend | Host `10.0.0.2` inacessível no Wokwi | `firmware/src/config.h` → `host.wokwi.internal` em modo `WOKWI_SIM` |
| 2 | Frontend sem proxy em dev | Vite não redirecionava `/api` nem `/socket.io` | `dc-rega-sistema-web/vite.config.ts` com proxy para `localhost:3000` |
| 3 | Switches "motor ligado" / "relé temporizador" pareciam desconectados | Terminais 1/3 ligados ao contacto NO do relé (feedback indireto) | Ligados diretamente a **3V3** (UP) e **GND** (DOWN) → override manual óbvio |
| 4 | Falta de botões manuais no diagrama | Diagrama não tinha START/STOP/RESET/AUTO | 4 push-buttons em GPIO **38/39/40/41** |
| 5 | Botões sem handler no firmware | GPIO 38..41 não eram lidos | `firmware/src/main.cpp` faz `digitalRead` com debounce em `WOKWI_SIM` |
| 6 | **Simulador Wokwi cinzento / não renderizava** | GPIO 34..37 são reservados para OSPI PSRAM na S3 N8R8/N16R8V → boot-loop | Botões movidos para GPIO 38..41 (safe pins em TODAS as variantes) |
| 7 | Logs obsoletos versionados | `frontend.log` / `frontend.err.log` no repositório | Removidos e adicionados ao `.gitignore` |

---

## 3. Como arrancar tudo (Windows / macOS / Linux)

### 3.1 Backend (terminal 1)

```bash
cd dc-rega-sistema-web/backend
npm install
node server.js
# → GTC Rega API + Engine listening on port 3000
```

Verifica que ficou online:

```bash
curl http://localhost:3000/api/health
# Deve devolver JSON com { "ok": true, ... }
```

### 3.2 Frontend (terminal 2)

```bash
cd dc-rega-sistema-web
npm install
cp .env.example .env    # deixa VITE_API_URL vazio; o proxy Vite trata do resto
npm run dev
# → http://localhost:5173
```

Abre `http://localhost:5173` no browser. A barra superior deve mostrar
"Backend Online". Enquanto o ESP32 não estiver ligado aparece
"ESP32 Offline".

### 3.3 Wokwi (VS Code — recomendado)

1. Instala a extensão **Wokwi Simulator** no VS Code.
2. Abre `firmware/gtc-esp32s3/` no VS Code.
3. Instala PlatformIO e compila:
   ```bash
   pip install -U platformio
   cd firmware/gtc-esp32s3
   pio run                # gera .pio/build/esp32-s3-devkitc-1/firmware.bin
   ```
4. Ativa o **Private Wokwi IoT Gateway** (Command Palette →
   "Wokwi: Start Private IoT Gateway").
5. Abre `diagram.json` e carrega no botão ▶ *Start Simulation*.
6. No painel Serial do Wokwi deves ver:
   ```
   GTC Rega — ES3N28P (ESP32-S3) 3.1.0
   [WIFI] Wokwi-GUEST conectado → modo simulação ativado
   [WIFI] IP: 10.0.0.1
   [GTC] handshake ok
   [BTN] Botões manuais inicializados (GPIO 38/39/40/41)
   ```
7. No frontend (`localhost:5173`) o estado do dispositivo passa a
   **online** e os LEDs do MCP23017 atualizam em tempo real.

### 3.4 Alternativa Docker (produção-like)

```bash
cd dc-rega-sistema-web
cp .env.example .env
docker-compose up --build
# Backend:  http://localhost:3000
# Frontend: http://localhost:8080
```

Continua a ser necessário o Private Wokwi IoT Gateway para o ESP32
alcançar `host.wokwi.internal:3000`.

---

## 4. Testes manuais no simulador

### 4.1 Botões físicos

| Botão | GPIO | Ação esperada no ESP32 e no frontend |
|-------|------|--------------------------------------|
| 🟢 START | 38 | `pump=true`, `auto=true` → LED `led_motor` (vermelho) + `led_auto` (amarelo) acendem; frontend mostra motor ON |
| 🔴 STOP | 39 | Emergência local: todas as saídas OFF, `emergencyLatched=true` |
| 🔵 RESET | 40 | Limpa o latch de emergência (`emergencyLatched=false`) |
| 🟡 AUTO | 41 | Toggle do modo automático → LED `led_auto` alterna |
| 🔴 EMERG | 0 (BOOT) | Igual ao STOP mas força imediato + telemetria |

### 4.2 Switches de feedback (override manual)

Cada switch é agora um **override manual** claro:

| Switch | GPIO | Posição UP (3V3) | Posição DOWN (GND) |
|--------|------|------------------|--------------------|
| `sw_bomba_fb` (MOTOR LIGADO) | 13 | Força `pumpRunning=true` na telemetria → LED verde `led_fb_bomba` acende | Força `pumpRunning=false` → LED verde apagado |
| `sw_temp_fb` (RELÉ TEMPORIZADOR) | 15 | Força `thermalAlarm=true` → LED vermelho `led_fb_temp` acende + **motor desliga** por segurança | `thermalAlarm=false` |

> ⚠️ **Teste do relé térmico**: com o motor a correr, empurra `sw_temp_fb`
> para cima → o firmware deteta o alarme térmico e desliga a bomba
> automaticamente. No frontend aparece o alarme.

---

## 5. Testes via HTTP (curl)

```bash
# Estado do backend + do device
curl http://localhost:3000/api/health
curl http://localhost:3000/api/device/status

# Simular um handshake do ESP32 (sem Wokwi)
curl -X POST http://localhost:3000/api/device/hello \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"gtc-es3n28p-01","firmware":"3.1.0","ip":"10.0.0.1"}'

# Simular telemetria (motor ligado, sem alarme, DHT22 a 24°C 55%)
curl -X POST http://localhost:3000/api/device/telemetry \
  -H "Content-Type: application/json" \
  -d '{
        "deviceId":"gtc-es3n28p-01",
        "firmware":"3.1.0",
        "platform":"ES3N28P",
        "uptime":123,
        "emergency":false,
        "pumpRunning":true,
        "thermalAlarm":false,
        "mcpPresent":true,
        "dhts":[
          {"id":"DHT1","temperature":24,"humidity":55,"ok":true},
          {"id":"DHT2","temperature":25,"humidity":60,"ok":true}
        ],
        "gpio":{"4":1,"5":1,"7":1}
      }'

# Comandos de controlo (o backend guarda desired state; o ESP32 lê em /outputs)
curl -X POST http://localhost:3000/api/control/start   -H "Content-Type: application/json" -d '{"pumpDelay":2}'
curl -X POST http://localhost:3000/api/control/stop
curl -X POST http://localhost:3000/api/control/reset
curl -X POST http://localhost:3000/api/control/emergency

# Estado desejado (o firmware faz GET desta URL a cada segundo)
curl http://localhost:3000/api/device/outputs

# Eventos / log
curl 'http://localhost:3000/api/events?limit=20'
```

---

## 6. Diagnóstico rápido

| Sintoma | Verificar |
|---------|-----------|
| **Simulador Wokwi todo cinzento / não renderiza os componentes** | Falta o `firmware.bin`. Corra `pio run` em `firmware/gtc-esp32s3/` ANTES de iniciar a simulação. A extensão Wokwi só desenha os pinos e cores depois de conseguir carregar um binário válido em `.pio/build/esp32-s3-devkitc-1/firmware.bin`. Confirme também que os pinos dos botões (GPIO 38..41) não colidem com PSRAM — na versão anterior estavam em 34..37 e provocavam boot-loop em ESP32-S3 N8R8/N16R8V. |
| Frontend mostra "Backend Offline" | O `node server.js` está a correr? `curl http://localhost:3000/api/health` responde? |
| Frontend online mas "ESP32 Offline" | O Private Wokwi IoT Gateway está ativo? O Serial do Wokwi mostra "[GTC] handshake ok"? |
| "Wokwi-GUEST não encontrada" | Compilar com `pio run` (não com `-e esp32-s3-wokwi`). O env `esp32-s3-devkitc-1` já define `-D WOKWI_SIM=1` |
| Motor não arranca ao pressionar START | Confirmar que `sw_temp_fb` está em DOWN (sem alarme térmico). Ver o Serial: `[BTN] START pressionado` |
| Erro `EADDRINUSE :3000` | Já há um processo na porta 3000. `lsof -i :3000` e mata-o (ou usa `PORT=3001` no `.env` do backend + `VITE_API_URL=http://localhost:3001` no frontend) |

---

## 7. Ficheiros-chave desta iteração

- `firmware/gtc-esp32s3/diagram.json` — botões START/STOP/RESET/AUTO, switches como override 3V3/GND direto.
- `firmware/gtc-esp32s3/src/main.cpp` — leitura debounced dos GPIO 34..37 sob `#ifdef WOKWI_SIM`.
- `firmware/gtc-esp32s3/src/config.h` — `GTC_SERVER_HOST = "host.wokwi.internal"` no modo simulador.
- `dc-rega-sistema-web/vite.config.ts` — proxy `/api` + `/socket.io` para `localhost:3000`.
- `dc-rega-sistema-web/backend/server.js` — endpoints `/api/device/*` + Socket.IO.
- `dc-rega-sistema-web/.env.example` — modelo do ambiente frontend/backend.
