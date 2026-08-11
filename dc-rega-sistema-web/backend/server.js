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

// Sensor simulation loop (every 3 seconds)
let sensorInterval = null;
function startSensorSim() {
  if (sensorInterval) clearInterval(sensorInterval);
  sensorInterval = setInterval(() => {
    engine.updateSensors();
    engine.checkAutoCycle();
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

// Load persisted state and restore engine
const persisted = loadPersistedState();
if (persisted) {
  appState = { eventLog: persisted.eventLog || [] };
}

// ── API Routes ──

// Health
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    engineState: engine.state,
    zones: engine.zones.length,
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

// ── WebSocket ──
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);
  socket.emit('controller:state', engine.getState());
  socket.emit('controller:gpio', engine.gpio);

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
});
