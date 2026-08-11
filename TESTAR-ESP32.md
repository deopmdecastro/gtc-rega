# 🧪 Como testar se a interface está a consumir dados reais do ESP32-S3

## 1. Verificar no browser (sem ESP32 ligado)

Abre o painel GTC Rega no browser. Se **não** tiveres o ESP32 ligado:

- O banner no topo da página **Resumo** mostra:
  > ⚫ **Controlador não detetado — a simular**

- Os pills dos sensores mostram:
  > 📡 B1 · sim.   📡 B2 · sim.

- Na página **Estado**, o Controlador central mostra:
  > ESP32-S3 · Wi-Fi · Simulação

Isto confirma que estás em **modo simulação**.

---

## 2. Ligar o ESP32-S3

### 2a. Configura o firmware

Edita `firmware/gtc-esp32s3/src/config.h`:

```c
// Substitui pelo IP do teu computador onde corre o backend
#define GTC_SERVER_HOST   "192.168.1.100"   // ⚠️ IP da tua máquina

// (Opcional) Define um token se quiseres segurança
#define GTC_DEVICE_TOKEN  "meu-token-seguro"
```

### 2b. Configura o backend

Cria o ficheiro `.env` em `dc-rega-sistema-web/backend/`:

```bash
cd dc-rega-sistema-web/backend
cp ../.env.example .env
```

Se definiste token no firmware, mete o mesmo no `.env`:
```
DEVICE_TOKEN=meu-token-seguro
```

### 2c. Faz upload do firmware

```bash
cd firmware/gtc-esp32s3
pio run --target upload --target monitor
```

### 2d. Inicia o backend

```bash
cd dc-rega-sistema-web/backend
npm start
```

### 2e. Inicia o frontend (dev)

```bash
cd dc-rega-sistema-web
npm run dev
```

---

## 3. Verificar a conexão

Quando o ESP32 arrancar, vais ver no terminal do backend:

```
[DEVICE] Hello from gtc-esp32s3-01 — fw 2.15.0 @ 192.168.1.X
```

E NO PAINEL (browser), em menos de 3 segundos:

| Indicador | Antes (simulação) | Depois (ESP32 real) |
|---|---|---|
| Banner Resumo | ⚫ Controlador não detetado | 🟢 **Controlador reconhecido** + IP + firmware |
| Pills sensores | B1 · sim. | **B1 · ok 65%** |
| Estado → Controlador | Simulação | **gtc-esp32s3-01 · fw 2.15.0 · 192.168.1.X** |
| Estado → Uptime | "Modo simulação" | **"online há 5m30s"** |
| Alarme sensor stale | Não aparece | Aparece se sensor parar de reportar >15s |
| Histórico → Eventos | Só eventos manuais | **device_connected**, **sensor_stale**, **schedule_trigger** |

---

## 4. Testar a API diretamente (diagnóstico)

Com o backend a correr, podes verificar o estado real:

```bash
# Ver saúde geral
curl http://localhost:3000/api/health | jq .

# Ver estado do dispositivo
curl http://localhost:3000/api/device/status | jq .

# Ver eventos registados
curl http://localhost:3000/api/events?limit=10 | jq .

# Ver estado completo do controlador
curl http://localhost:3000/api/control/state | jq .
```

### O que procurar:

- `deviceOnline: true` → ESP32 está ligado
- `deviceInfo.deviceId: "gtc-esp32s3-01"` → teu dispositivo específico
- `sensors[0].stale: false` → sensor B1 a reportar
- Eventos com `device_connected`, `sensor_stale` → eventos reais gerados

---

## 5. Simular um alarme real

Para confirmar que os alarmes funcionam com dados reais:

1. Com o ESP32 ligado e a reportar, **desliga o ESP32**
2. Após ~30 segundos, o backend deteta perda de contacto e gera:
   - Evento `device_offline` (critical) → aparece nos **Alarmes** como CRÍTICO
   - Sensores passam a `stale` → pills mudam para "sem sinal"
3. Volta a ligar o ESP32 → evento `device_reconnected` + sensores recuperam

---

## 6. Resumo visual no painel

| Página | O que mostra com ESP32 real |
|---|---|
| **Resumo** | Banner verde "Controlador reconhecido" + IP/firmware + sensores com % real |
| **Estado** | Uptime real, versão do firmware, IP, sensores OK ou sem sinal |
| **Setpoints** | Humidade atual de cada zona vem do sensor real |
| **Histórico** | Eventos reais: device_connected, sensor_stale, schedule_trigger, etc. |
| **Alarmes** | Alarmes gerados pelo backend: perda de dispositivo, sensor sem resposta, watchdog |
