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
engine.onStateChange = (ctrlState) => {
  io.emit('controller:state', ctrlState);
  persistState();
};

engine.onLog = (entry) => {
  io.emit('controller:event', entry);
  // Save to persistent event log
  if (!appState.eventLog) appState.eventLog = [];
  appState.eventLog.unshift(entry);
  if (appState.eventLog.length > 500) appState.eventLog.length = 500;
  persistState();
};

engine.onGpioChange = (pin, value) => {
  io.emit('controller:gpio', { pin, value });
};

engine.onSensorUpdate = (sensorId, moisture) => {
  io.emit('controller:sensor', { sensorId, moisture });
};

engine.onSensorHealthChange = (health) => {
  io.emit('controller:sensor-health', health);
};

// ── Device tracking ──
let deviceOnline = false;
let lastDeviceContact = 0;
let deviceInfo = null; // info from /api/device/hello

function broadcastDeviceStatus() {
  io.emit('controller:device', { online: deviceOnline, info: deviceInfo });
}

// Sensor simulation loop (every 3 seconds) — only runs when device is offline
let sensorInterval = null;
function startSensorSim() {
  if (sensorInterval) clearInterval(sensorInterval);
  sensorInterval = setInterval(() => {
    // Only simulate if no real device is connected
    if (!deviceOnline || Date.now() - lastDeviceContact > DEVICE_OFFLINE_TIMEOUT) {
      if (deviceOnline) {
        console.log('[DEVICE] ESP32 offline — switching to simulation');
        deviceOnline = false;
        engine._log('device_offline', 'ESP32-S3',
          `Dispositivo ${deviceInfo?.deviceId || 'desconhecido'} perdeu contacto — a simular sensores até reconectar`,
          'critical', { deviceId: deviceInfo?.deviceId || null });
        broadcastDeviceStatus();
      }
      engine.updateSensors();
      engine.checkAutoCycle();
    } else {
      // Dispositivo real online — verificar se algum sensor deixou de reportar
      engine.checkSensorHealth(15000);
    }
  }, 3000);
}
startSensorSim();

// ── Persistent state helpers ──
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

// ── Device token middleware ──
function checkDeviceToken(req, res, next) {
  if (!DEVICE_TOKEN) return next(); // no token configured → allow all
  const token = req.headers['x-device-token'];
  if (token === DEVICE_TOKEN) return next();
  return res.status(401).json({ error: 'Invalid or missing device token' });
}

// Load persisted state and restore engine
const persisted = loadPersistedState();
if (persisted) {
  appState = { eventLog: persisted.eventLog || [] };
  // Restore engine state from last session
  if (persisted.controlState && persisted.controlState.zones && persisted.controlState.zones.length > 0) {
    engine.restoreState(persisted);
    console.log(`Engine restored: ${engine.zones.length} zones, state=${engine.state}`);
  }
}

// ── API Routes ──

// Health
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

// Get full controller state
app.get('/api/control/state', (_req, res) => {
  res.json(engine.getState());
});

// ── Control commands ──
app.post('/api/control/start', (req, res) => {
  const { pumpDelay } = req.body || {};
  const ok = engine.start(pumpDelay || 5);
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

// Update zones config (setpoints, waterDuration)
app.post('/api/control/zones', (req, res) => {
  const { zones } = req.body || {};
  if (zones && Array.isArray(zones)) {
    engine.updateZones(zones);
  }
  res.json({ ok: true, state: engine.getState() });
});

// ── Device API (ESP32-S3 firmware endpoints) ──
// POST /api/device/hello — handshake / registo do dispositivo
app.post('/api/device/hello', checkDeviceToken, (req, res) => {
  const { deviceId, firmware, ip, rssi } = req.body || {};
  
  const wasOnline = deviceOnline;
  deviceOnline = true;
  lastDeviceContact = Date.now();
  deviceInfo = { deviceId, firmware, ip, rssi, connectedAt: new Date().toISOString() };
  
  console.log(`[DEVICE] Hello from ${deviceId || 'unknown'} — fw ${firmware || '?'} @ ${ip || '?'}`);
  
  engine._log('device_connected', 'ESP32-S3',
    `Dispositivo ${deviceId || 'desconhecido'} reconhecido — controlador ligado (fw ${firmware || '?'})`, 'info',
    { deviceId, firmware, ip, rssi });
  broadcastDeviceStatus();
  
  res.json({
    ok: true,
    serverTime: new Date().toISOString(),
    message: 'Handshake OK — GTC Rega backend pronto',
  });
});

// POST /api/device/telemetry — recebe sensores e devolve saídas desejadas
app.post('/api/device/telemetry', checkDeviceToken, (req, res) => {
  const { deviceId, firmware, ip, rssi, uptime, emergency, sensors } = req.body || {};
  
  const wasOnline = deviceOnline;
  deviceOnline = true;
  lastDeviceContact = Date.now();
  deviceInfo = { ...deviceInfo, deviceId, firmware, ip, rssi, uptime, lastTelemetry: new Date().toISOString() };

  if (!wasOnline) {
    engine._log('device_reconnected', 'ESP32-S3',
      `Dispositivo ${deviceId || 'desconhecido'} voltou a comunicar`, 'info', { deviceId, firmware, ip, rssi });
    broadcastDeviceStatus();
  }
  
  // Update sensor readings from real device
  if (sensors && Array.isArray(sensors)) {
    sensors.forEach(s => {
      if (s.sensorId && typeof s.moisture === 'number') {
        engine.updateDeviceSensor(s.sensorId, Math.round(s.moisture));
      }
    });
  }
  
  // Handle emergency signal from device
  if (emergency && engine.state !== 'emergency') {
    engine.emergencyStop();
    console.log('[DEVICE] Emergency stop received from ESP32');
  }
  
  // Build outputs response for the device
  const outputs = {
    emergency: engine.state === 'emergency',
    pump: engine.pumpOn,
    zones: engine.zones.map((z, i) => ({
      name: z.name,
      on: z.on,
      duration: z.waterDuration || 30,
    })),
  };
  
  res.json({
    ok: true,
    outputs,
    serverTime: new Date().toISOString(),
  });
});

// GET /api/device/outputs — ESP32 consulta as saídas desejadas
app.get('/api/device/outputs', checkDeviceToken, (req, res) => {
  const wasOnline = deviceOnline;
  lastDeviceContact = Date.now();
  deviceOnline = true;
  if (!wasOnline) broadcastDeviceStatus();
  
  res.json({
    emergency: engine.state === 'emergency',
    pump: engine.pumpOn,
    zones: engine.zones.map((z, i) => ({
      name: z.name,
      on: z.on,
      duration: z.waterDuration || 30,
    })),
  });
});

// GET /api/device/status — estado completo do dispositivo (para debug/UI)
app.get('/api/device/status', checkDeviceToken, (req, res) => {
  res.json({
    deviceOnline,
    lastContact: lastDeviceContact ? new Date(lastDeviceContact).toISOString() : null,
    deviceInfo,
    sensors: engine.getSensorHealth(),
    engine: {
      state: engine.state,
      pumpOn: engine.pumpOn,
      autoMode: engine.autoMode,
      cycleActive: engine.cycleActive,
      testCycleActive: engine.testCycleActive,
      currentZoneIndex: engine.currentZoneIndex,
      zones: engine.zones.length,
    },
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
app.get('/api/layout', (_req, res) => {
  res.json(loadLayout() || {});
});

app.post('/api/layout', (req, res) => {
  saveLayoutToFile(req.body);
  res.json({ ok: true, saved: new Date().toISOString() });
});

// Deprecated state endpoints (keep for backward compat)
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
  if (pump !== undefined && pump && !engine.pumpOn) engine.togglePump();
  if (pump !== undefined && !pump && engine.pumpOn) engine.togglePump();
  res.json({ ok: true });
});

// Legacy command endpoint
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
  try {
    if (fs.existsSync(GPIO_CONFIG_FILE)) return JSON.parse(fs.readFileSync(GPIO_CONFIG_FILE, 'utf-8'));
  } catch (e) { /* ignore */ }
  return null;
}

function saveGpioConfigFile(config) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(GPIO_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) { console.error('Failed to save GPIO config:', e.message); }
}

app.get('/api/gpio-config', (_req, res) => {
  res.json(loadGpioConfigFile() || { config: [] });
});

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

// ── WebSocket ──
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  socket.emit('controller:state', engine.getState());
  socket.emit('controller:gpio', engine.gpio);
  // Send device status
  socket.emit('controller:device', { online: deviceOnline, info: deviceInfo });
  // Send current sensor health snapshot
  engine.getSensorHealth().forEach((health) => socket.emit('controller:sensor-health', health));

  socket.on('control:start', (data) => engine.start(data?.pumpDelay || 5));
  socket.on('control:stop', () => engine.stop());
  socket.on('control:emergency', () => engine.emergencyStop());
  socket.on('control:reset', () => engine.reset());
  socket.on('control:test-cycle', () => engine.testCycle());
  socket.on('control:toggle-zone', (data) => engine.toggleZone(data?.zoneId));
  socket.on('control:toggle-pump', () => engine.togglePump());
  socket.on('control:mode', (data) => engine.setAutoMode(!!data?.auto));
});

// ── Start ──
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`GTC Rega API + Engine listening on port ${port}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`Device token: ${DEVICE_TOKEN ? 'configured' : 'disabled (no token)'}`);
  console.log(`Device API endpoints:`);
  console.log(`  POST /api/device/hello      — handshake`);
  console.log(`  POST /api/device/telemetry  — sensors + outputs`);
  console.log(`  GET  /api/device/outputs    — desired outputs`);
  console.log(`  GET  /api/device/status     — device + engine status`);
});
