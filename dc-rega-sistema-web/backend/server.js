const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');
const { ControlEngine } = require('./engine');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingInterval: 5000, pingTimeout: 15000 });

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const DATA_DIR = process.env.DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, 'gtc-state.json');
const LAYOUT_FILE = path.join(DATA_DIR, 'gtc-layout.json');

// ── Device Token (igual ao GTC_DEVICE_TOKEN no config.h do firmware) ──
const DEVICE_TOKEN = process.env.DEVICE_TOKEN || '';
const DEVICE_OFFLINE_TIMEOUT = 30000; // 30s sem telemetria → voltar a simular

// ── Engine ──
const engine = new ControlEngine();

// Wire engine events → WebSocket + event log
engine.onStateChange = (state) => {
  io.emit('controller:state', state);
  persistState();
};

engine.onLog = (entry) => {
  io.emit('controller:event', entry);
  if (!appState.eventLog) appState.eventLog = [];
  appState.eventLog.unshift(entry);
  if (appState.eventLog.length > 500) appState.eventLog.length = 500;
  persistState();
};

engine.onGpioChange = (pin, value) => {
  io.emit('controller:gpio', { pin, value });
};

engine.onSensorUpdate = (sensorId, payload) => {
  io.emit('controller:sensor', { sensorId, payload });
};

// ── Device tracking ──
let deviceOnline = false;
let lastDeviceContact = 0;
let deviceInfo = null;
let everConnected = false;
let neverConnectedWarned = false;
const SERVER_BOOT_TIME = Date.now();
const NEVER_CONNECTED_GRACE_MS = 45000;

function broadcastDeviceStatus() {
  io.emit('controller:device', { online: deviceOnline, info: deviceInfo });
}

let monitorInterval = null;
function startMonitor() {
  if (monitorInterval) clearInterval(monitorInterval);
  monitorInterval = setInterval(() => {
    const silentFor = Date.now() - lastDeviceContact;
    if (deviceOnline && silentFor > DEVICE_OFFLINE_TIMEOUT) {
      deviceOnline = false;
      console.log('[DEVICE] ESP32-S3 offline — sem telemetria');
      engine._log('device_offline', 'ESP32-S3',
        `Controlador ${deviceInfo?.deviceId || 'ESP32-S3'} sem contacto há ${Math.round(silentFor / 1000)}s`,
        'critical', { deviceId: deviceInfo?.deviceId || null, silentFor });
      broadcastDeviceStatus();
    }

    if (!everConnected && !neverConnectedWarned && (Date.now() - SERVER_BOOT_TIME) > NEVER_CONNECTED_GRACE_MS) {
      neverConnectedWarned = true;
      engine._log('device_never_connected', 'ESP32-S3',
        'Nenhum controlador ESP32-S3 reconhecido desde o arranque do sistema',
        'critical');
    }

    engine.checkAutoCycle();
  }, 3000);
}
startMonitor();

let appState = { eventLog: [] };

function loadPersistedState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) { console.error('Failed to load state:', e.message); }
  return null;
}

function persistState() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const toSave = {
      ...appState,
      controlState: engine.getState(),
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(toSave, null, 2), 'utf-8');
  } catch (e) { console.error('Failed to save state:', e.message); }
}

function loadLayout() {
  try {
    if (fs.existsSync(LAYOUT_FILE)) return JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf-8'));
  } catch (e) { /* ignore */ }
  return null;
}

function saveLayoutToFile(layout) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LAYOUT_FILE, JSON.stringify(layout, null, 2), 'utf-8');
  } catch (e) { console.error('Failed to save layout:', e.message); }
}

let lastUnauthorizedWarnAt = 0;
const UNAUTHORIZED_WARN_THROTTLE_MS = 30000;

function checkDeviceToken(req, res, next) {
  if (!DEVICE_TOKEN) return next();
  const token = req.headers['x-device-token'];
  if (token === DEVICE_TOKEN) return next();
  const now = Date.now();
  if (now - lastUnauthorizedWarnAt > UNAUTHORIZED_WARN_THROTTLE_MS) {
    lastUnauthorizedWarnAt = now;
    engine._log('device_unauthorized', 'ESP32-S3',
      `Dispositivo não reconhecido — pedido a ${req.path} com token inválido ou em falta`,
      'critical', { path: req.path, ip: req.ip });
  }
  return res.status(401).json({ error: 'Invalid or missing device token' });
}

const persisted = loadPersistedState();
if (persisted) {
  appState = { eventLog: persisted.eventLog || [] };
  if (persisted.controlState && persisted.controlState.zones && persisted.controlState.zones.length > 0) {
    engine.restoreState(persisted);
    console.log(`Engine restored: ${engine.zones.length} zones, state=${engine.state}`);
  }
}

// ── API Routes ──

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    engineUptime: engine.uptime,
    engineState: engine.state,
    zones: engine.zones.length,
    cycleActive: engine.cycleActive,
    testCycleActive: engine.testCycleActive,
    currentZone: engine.currentZoneIndex,
    watchdogActive: !!engine.watchdogTimer,
    gpio: engine.gpio,
    deviceOnline,
    deviceInfo,
  });
});

app.get('/api/control/state', (_req, res) => {
  res.json(engine.getState());
});

app.post('/api/control/start', (req, res) => {
  const { pumpDelay } = req.body || {};
  const ok = engine.start(pumpDelay || engine.pumpDelay || 5);
  res.json({ ok, state: engine.getState() });
});

app.post('/api/control/stop', (_req, res) => {
  const ok = engine.stop();
  res.json({ ok, state: engine.getState() });
});

app.post('/api/control/emergency', (_req, res) => {
  const ok = engine.emergencyStop();
  res.json({ ok, state: engine.getState() });
});

app.post('/api/control/reset', (_req, res) => {
  const ok = engine.reset();
  res.json({ ok, state: engine.getState() });
});

app.post('/api/control/test-cycle', (_req, res) => {
  const ok = engine.testCycle();
  res.json({ ok, state: engine.getState() });
});

app.post('/api/control/toggle-zone', (req, res) => {
  const { zoneId } = req.body || {};
  if (!zoneId) return res.status(400).json({ error: 'zoneId required' });
  const ok = engine.toggleZone(zoneId);
  res.json({ ok, state: engine.getState() });
});

app.post('/api/control/toggle-pump', (_req, res) => {
  const ok = engine.togglePump();
  res.json({ ok, state: engine.getState() });
});

app.post('/api/control/mode', (req, res) => {
  const { auto } = req.body || {};
  engine.setAutoMode(!!auto);
  res.json({ ok: true, state: engine.getState() });
});

app.post('/api/control/zones', (req, res) => {
  const { zones } = req.body || {};
  if (zones && Array.isArray(zones)) engine.updateZones(zones);
  res.json({ ok: true, state: engine.getState() });
});

// ── Device API (ESP32-S3 firmware endpoints) ──
app.post('/api/device/hello', checkDeviceToken, (req, res) => {
  const { deviceId, firmware, ip, rssi } = req.body || {};
  const wasOnline = deviceOnline;
  deviceOnline = true;
  everConnected = true;
  lastDeviceContact = Date.now();
  deviceInfo = { deviceId, firmware, ip, rssi, connectedAt: new Date().toISOString() };
  console.log(`[DEVICE] Hello from ${deviceId || 'unknown'} — fw ${firmware || '?'} @ ${ip || '?'}`);
  engine._log('device_connected', 'ESP32-S3',
    `Dispositivo ${deviceId || 'desconhecido'} reconhecido (fw ${firmware || '?'})`, 'info',
    { deviceId, firmware, ip, rssi });
  broadcastDeviceStatus();
  res.json({ ok: true, serverTime: new Date().toISOString(), message: 'Handshake OK — GTC Rega backend pronto' });
});

// POST /api/device/telemetry — recebe sensores DHT22 + estados reais
app.post('/api/device/telemetry', checkDeviceToken, (req, res) => {
  const { deviceId, firmware, ip, rssi, uptime, emergency, motor,
          platform, pumpRunning, thermalAlarm, mcpPresent,
          dhts, gpio } = req.body || {};

  const wasOnline = deviceOnline;
  deviceOnline = true;
  everConnected = true;
  lastDeviceContact = Date.now();
  deviceInfo = {
    ...deviceInfo, deviceId, firmware, ip, rssi, uptime,
    platform, pumpRunning, thermalAlarm, mcpPresent,
    lastTelemetry: new Date().toISOString(),
  };

  if (!wasOnline) {
    engine._log('device_reconnected', 'ESP32-S3',
      `Dispositivo ${deviceId || 'desconhecido'} voltou a comunicar`, 'info', { deviceId, firmware, ip });
  }
  broadcastDeviceStatus();

  // DHT22 — telemetria de temperatura/humidade (substitui B1/B2)
  if (Array.isArray(dhts)) {
    dhts.forEach(d => engine.updateDeviceDht(d.id, {
      temperature: d.temperature,
      humidity: d.humidity,
      ok: d.ok,
    }));
  }

  // Feedback 24 V via optocopladores (PB6/PB7)
  engine.updateDeviceFeedback({
    bombaRunning: typeof pumpRunning === 'boolean' ? pumpRunning : undefined,
    releTempOn:   typeof thermalAlarm === 'boolean' ? thermalAlarm : undefined,
  });

  // Estado elétrico real dos pinos (firmware envia mapa { nome: valor })
  if (gpio && typeof gpio === 'object') {
    Object.entries(gpio).forEach(([pin, value]) => {
      const p = Number(pin);
      if (Number.isNaN(p)) return;
      const num = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
      if (Number.isNaN(num)) return;
      if (engine.gpio[p] !== num) {
        engine.gpio[p] = num;
        io.emit('controller:gpio', { pin: p, value: num });
      }
    });
  }

  if (emergency && engine.state !== 'emergency') {
    engine.emergencyStop();
    console.log('[DEVICE] Emergency stop received from ESP32');
  }

  // Saídas desejadas para o ESP32 (consumidas em /api/device/outputs também)
  const outputs = {
    emergency:   engine.state === 'emergency',
    pump:        engine.motorOn,
    auto:        engine.autoMode,
    on:          !!engine.gpio[3],   // ON GTC (PA3)
    timeReg:     !!engine.gpio[4],   // PA4
    timeDelay:   !!engine.gpio[5],   // PA5
    out1:        !!engine.gpio[7],   // PA7
    out2:        !!engine.gpio[6],   // PA6
    tempRelay:   !!engine.gpio[8],   // PB0
    stop:        !!engine.gpio[2],   // PA2 STO/EMERG
    zones: engine.zones.map((z, i) => ({
      name: z.name,
      on: z.on,
      duration: z.waterDuration || 30,
    })),
  };

  res.json({ ok: true, outputs, serverTime: new Date().toISOString() });
});

app.get('/api/device/outputs', checkDeviceToken, (req, res) => {
  const wasOnline = deviceOnline;
  lastDeviceContact = Date.now();
  deviceOnline = true;
  everConnected = true;
  if (!wasOnline) broadcastDeviceStatus();

  res.json({
    emergency: engine.state === 'emergency',
    pump:      engine.motorOn,
    auto:      engine.autoMode,
    on:        !!engine.gpio[3],
    timeReg:   !!engine.gpio[4],
    timeDelay: !!engine.gpio[5],
    out1:      !!engine.gpio[7],
    out2:      !!engine.gpio[6],
    tempRelay: !!engine.gpio[8],
    stop:      !!engine.gpio[2],
    zones: engine.zones.map((z, i) => ({
      name: z.name,
      on: z.on,
      duration: z.waterDuration || 30,
    })),
  });
});

app.get('/api/device/status', (req, res) => {
  res.json({
    deviceOnline,
    lastContact: lastDeviceContact ? new Date(lastDeviceContact).toISOString() : null,
    deviceInfo,
    dhts: [engine.dht1, engine.dht2],
    engine: {
      state: engine.state,
      motorOn: engine.motorOn,
      autoMode: engine.autoMode,
      cycleActive: engine.cycleActive,
      testCycleActive: engine.testCycleActive,
      currentZoneIndex: engine.currentZoneIndex,
      zones: engine.zones.length,
        pumpDelay: engine.pumpDelay,
    },
    gpio: engine.gpio,
  });
});

// ── Events ──
app.get('/api/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  res.json((appState.eventLog || []).slice(0, limit));
});

app.post('/api/events', (req, res) => {
  const entry = req.body;
  if (!entry) return res.status(400).json({ error: 'missing body' });
  if (!appState.eventLog) appState.eventLog = [];
  appState.eventLog.unshift({
    ...entry,
    id: entry.id || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    created_at: entry.created_at || new Date().toISOString(),
  });
  if (appState.eventLog.length > 500) appState.eventLog.length = 500;
  persistState();
  res.json({ ok: true });
});

// ── Layout ──
app.get('/api/layout', (_req, res) => res.json(loadLayout() || {}));
app.post('/api/layout', (req, res) => {
  saveLayoutToFile(req.body);
  res.json({ ok: true, saved: new Date().toISOString() });
});

// Deprecated state endpoints
app.get('/api/state', (_req, res) => {
  const cs = engine.getState();
  res.json({
    pump: cs.pump,
    mode: cs.autoMode ? 'automatic' : 'manual',
    zones: cs.zones,
    eventLog: appState.eventLog || [],
    errors: [],
    deviceOnline,
  });
});

app.post('/api/state', (req, res) => {
  const { zones, mode, pump } = req.body || {};
  if (zones) engine.updateZones(zones);
  if (mode) engine.setAutoMode(mode === 'automatic');
  if (pump !== undefined && pump && !engine.motorOn) engine.togglePump();
  if (pump !== undefined && !pump && engine.motorOn) engine.togglePump();
  res.json({ ok: true });
});

app.post('/api/command', (req, res) => {
  const { command, zoneId } = req.body || {};
  if (command === 'START') engine.start();
  else if (command === 'STOP') engine.stop();
  else if (command === 'RESET') engine.reset();
  else if (command === 'TOGGLE_ZONE' && zoneId) engine.toggleZone(zoneId);
  else if (command === 'TOGGLE_PUMP') engine.togglePump();
  res.json(engine.getState());
});

// ── GPIO Config persistence ──
const GPIO_CONFIG_FILE = path.join(DATA_DIR, 'gtc-gpio-config.json');
function loadGpioConfigFile() {
  try { if (fs.existsSync(GPIO_CONFIG_FILE)) return JSON.parse(fs.readFileSync(GPIO_CONFIG_FILE, 'utf-8')); }
  catch (e) { /* ignore */ }
  return null;
}
function saveGpioConfigFile(config) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(GPIO_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) { console.error('Failed to save GPIO config:', e.message); }
}
app.get('/api/gpio-config', (_req, res) => res.json(loadGpioConfigFile() || { config: [] }));
app.post('/api/gpio-config', (req, res) => {
  const { config } = req.body || {};
  if (config && Array.isArray(config)) {
    saveGpioConfigFile({ config, savedAt: new Date().toISOString() });
    io.emit('gpio:config', { config });
    res.json({ ok: true });
  } else {
    res.status(400).json({ error: 'Invalid config' });
  }
});

// ── WiFi Configuration ──
const WIFI_CONFIG_FILE = path.join(DATA_DIR, 'gtc-wifi-config.json');
function loadWifiConfig() {
  try { if (fs.existsSync(WIFI_CONFIG_FILE)) return JSON.parse(fs.readFileSync(WIFI_CONFIG_FILE, 'utf-8')); }
  catch (e) { /* ignore */ }
  return { networks: [] };
}
function saveWifiConfig(config) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(WIFI_CONFIG_FILE, JSON.stringify({ ...config, savedAt: new Date().toISOString() }, null, 2), 'utf-8');
  } catch (e) { console.error('Failed to save wifi:', e.message); }
}
app.get('/api/wifi/config', (_req, res) => res.json(loadWifiConfig()));
app.post('/api/wifi/config', (req, res) => {
  const { ssid, password, hostname } = req.body || {};
  const cfg = loadWifiConfig();
  if (ssid) {
    const existing = cfg.networks.find(n => n.ssid === ssid);
    if (existing) {
      existing.password = password || existing.password;
      existing.hostname = hostname || existing.hostname;
      existing.updatedAt = new Date().toISOString();
    } else {
      cfg.networks.push({ ssid, password: password || '', hostname: hostname || 'gtc-esp32s3', createdAt: new Date().toISOString() });
    }
  }
  saveWifiConfig(cfg);
  io.emit('wifi:config', cfg);
  if (deviceOnline) io.emit('wifi:apply', { ssid, password });
  res.json({ ok: true, config: cfg });
});
app.delete('/api/wifi/config', (req, res) => {
  const { ssid } = req.body || {};
  const cfg = loadWifiConfig();
  if (ssid) {
    cfg.networks = cfg.networks.filter(n => n.ssid !== ssid);
    saveWifiConfig(cfg);
    io.emit('wifi:config', cfg);
  }
  res.json({ ok: true, config: cfg });
});
app.post('/api/wifi/scan', (_req, res) => {
  if (deviceOnline) { io.emit('wifi:scan-request', { timestamp: Date.now() }); res.json({ ok: true, message: 'Scan request sent' }); }
  else { res.json({ ok: false, message: 'ESP32 offline' }); }
});
app.post('/api/device/wifi-scan-results', checkDeviceToken, (req, res) => {
  const { networks } = req.body || {};
  if (networks && Array.isArray(networks)) { io.emit('wifi:scan-results', { networks, timestamp: Date.now() }); res.json({ ok: true }); }
  else { res.status(400).json({ error: 'Missing networks array' }); }
});

// ── Bluetooth Configuration ──
const BLUETOOTH_CONFIG_FILE = path.join(DATA_DIR, 'gtc-bluetooth-config.json');
function loadBluetoothConfig() {
  try { if (fs.existsSync(BLUETOOTH_CONFIG_FILE)) return JSON.parse(fs.readFileSync(BLUETOOTH_CONFIG_FILE, 'utf-8')); }
  catch (e) { /* ignore */ }
  return { devices: [] };
}
function saveBluetoothConfig(config) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(BLUETOOTH_CONFIG_FILE, JSON.stringify({ ...config, savedAt: new Date().toISOString() }, null, 2), 'utf-8');
  } catch (e) { console.error('Failed to save bluetooth:', e.message); }
}
app.get('/api/bluetooth/config', (_req, res) => res.json(loadBluetoothConfig()));
app.post('/api/bluetooth/config', (req, res) => {
  const { address, name, pin } = req.body || {};
  const cfg = loadBluetoothConfig();
  if (address) {
    const existing = cfg.devices.find(d => d.address === address);
    if (existing) {
      existing.name = name || existing.name;
      existing.pin = pin !== undefined ? pin : existing.pin;
      existing.updatedAt = new Date().toISOString();
    } else {
      cfg.devices.push({ address, name: name || address, pin: pin || '', paired: false, createdAt: new Date().toISOString() });
    }
  }
  saveBluetoothConfig(cfg);
  io.emit('bluetooth:config', cfg);
  if (deviceOnline) io.emit('bluetooth:apply', { address, pin });
  res.json({ ok: true, config: cfg });
});
app.delete('/api/bluetooth/config', (req, res) => {
  const { address } = req.body || {};
  const cfg = loadBluetoothConfig();
  if (address) {
    cfg.devices = cfg.devices.filter(d => d.address !== address);
    saveBluetoothConfig(cfg);
    io.emit('bluetooth:config', cfg);
    if (deviceOnline) io.emit('bluetooth:forget', { address });
  }
  res.json({ ok: true, config: cfg });
});
app.post('/api/bluetooth/scan', (_req, res) => {
  if (deviceOnline) { io.emit('bluetooth:scan-request', { timestamp: Date.now() }); res.json({ ok: true, message: 'Scan request sent' }); }
  else { res.json({ ok: false, message: 'ESP32 offline' }); }
});
app.post('/api/device/bluetooth-scan-results', checkDeviceToken, (req, res) => {
  const { devices } = req.body || {};
  if (devices && Array.isArray(devices)) { io.emit('bluetooth:scan-results', { devices, timestamp: Date.now() }); res.json({ ok: true }); }
  else { res.status(400).json({ error: 'Missing devices array' }); }
});
app.post('/api/device/bluetooth-status', checkDeviceToken, (req, res) => {
  const { address, paired } = req.body || {};
  if (address) {
    const cfg = loadBluetoothConfig();
    const existing = cfg.devices.find(d => d.address === address);
    if (existing) {
      existing.paired = !!paired;
      existing.updatedAt = new Date().toISOString();
      saveBluetoothConfig(cfg);
      io.emit('bluetooth:config', cfg);
    }
    res.json({ ok: true });
  } else { res.status(400).json({ error: 'Missing address' }); }
});

// ── WebSocket ──
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  socket.emit('controller:state', engine.getState());
  socket.emit('controller:gpio', engine.gpio);
  socket.emit('controller:device', { online: deviceOnline, info: deviceInfo });
  socket.emit('controller:sensor', { sensorId: 'DHT1', payload: engine.dht1 });
  socket.emit('controller:sensor', { sensorId: 'DHT2', payload: engine.dht2 });

  socket.on('control:start', (data) => engine.start(data?.pumpDelay || engine.pumpDelay));
  socket.on('control:stop', () => engine.stop());
  socket.on('control:emergency', () => engine.emergencyStop());
  socket.on('control:reset', () => engine.reset());
  socket.on('control:test-cycle', () => engine.testCycle());
  socket.on('control:toggle-zone', (data) => engine.toggleZone(data?.zoneId));
  socket.on('control:toggle-pump', () => engine.togglePump());
  socket.on('control:mode', (data) => engine.setAutoMode(!!data?.auto));
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`GTC Rega API + Engine listening on port ${port}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Device token: ${DEVICE_TOKEN ? 'configured' : 'disabled (no token)'}`);
  console.log('Endpoints:');
  console.log('  POST /api/device/hello');
  console.log('  POST /api/device/telemetry');
  console.log('  GET  /api/device/outputs');
  console.log('  GET  /api/device/status');
});
