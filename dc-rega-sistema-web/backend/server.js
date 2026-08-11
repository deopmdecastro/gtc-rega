const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ── Persistent state file ──
const DATA_DIR = process.env.DATA_DIR || '/data';
const STATE_FILE = path.join(DATA_DIR, 'gtc-state.json');

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Failed to load state:', e.message);
  }
  return null;
}

function saveState(s) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save state:', e.message);
  }
}

// ── Default state ──
const DEFAULT_STATE = {
  mode: 'automatic',
  pump: false,
  zones: [
    { id: 'Y1', sensorId: 'B1', name: 'Zona 1', moisture: 64, target: 55, lastWatered: '—', on: false, waterDuration: 60 },
    { id: 'Y2', sensorId: 'B2', name: 'Zona 2', moisture: 57, target: 52, lastWatered: '—', on: false, waterDuration: 45 },
  ],
  errors: [
    { id: 'E001', time: '', source: 'Sensor B2', message: 'Leitura recebida dentro do intervalo esperado.', severity: 'info', resolved: true },
    { id: 'E002', time: '', source: 'Bomba K1', message: 'Sobrecorrente detetada no relé K1.', severity: 'warning', resolved: true },
    { id: 'E003', time: '', source: 'Comunicação', message: 'Timeout Modbus RS485 — sensor B1.', severity: 'critical', resolved: true },
  ],
  eventLog: [],
};

let state = loadState() || { ...DEFAULT_STATE, errors: [...DEFAULT_STATE.errors] };

// Ensure zones array is present
if (!state.zones) state.zones = DEFAULT_STATE.zones;
if (!state.eventLog) state.eventLog = [];
if (!state.errors) state.errors = [];

// ── Layout persistence ──
const LAYOUT_FILE = path.join(DATA_DIR, 'gtc-layout.json');

function loadLayout() {
  try {
    if (fs.existsSync(LAYOUT_FILE)) {
      return JSON.parse(fs.readFileSync(LAYOUT_FILE, 'utf-8'));
    }
  } catch (e) { /* ignore */ }
  return null;
}

function saveLayoutToFile(layout) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LAYOUT_FILE, JSON.stringify(layout, null, 2), 'utf-8');
  } catch (e) {
    console.error('Failed to save layout:', e.message);
  }
}

// ── API Routes ──

// Full state
app.get('/api/status', (_req, res) => {
  res.json(state);
});

// Get all state (zones, errors, eventLog)
app.get('/api/state', (_req, res) => {
  res.json(state);
});

// Save full state (zones, errors, eventLog)
app.post('/api/state', (req, res) => {
  const { zones, errors, eventLog, mode, pump } = req.body || {};
  if (zones !== undefined) state.zones = zones;
  if (errors !== undefined) state.errors = errors;
  if (eventLog !== undefined) state.eventLog = eventLog;
  if (mode !== undefined) state.mode = mode;
  if (pump !== undefined) state.pump = pump;
  saveState(state);
  io.emit('update', state);
  res.json({ ok: true });
});

// Layout persistence (map editor)
app.get('/api/layout', (_req, res) => {
  res.json(loadLayout() || {});
});

app.post('/api/layout', (req, res) => {
  saveLayoutToFile(req.body);
  res.json({ ok: true, saved: new Date().toISOString() });
});

// Event log
app.post('/api/events', (req, res) => {
  const entry = req.body;
  if (!entry) return res.status(400).json({ error: 'missing body' });
  state.eventLog.unshift({
    ...entry,
    id: entry.id || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    created_at: entry.created_at || new Date().toISOString(),
  });
  if (state.eventLog.length > 500) state.eventLog.length = 500;
  saveState(state);
  res.json({ ok: true });
});

app.get('/api/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  res.json(state.eventLog.slice(0, limit));
});

// Legacy command endpoint (mantido para compatibilidade)
app.post('/api/command', (req, res) => {
  const { command, zoneId } = req.body || {};
  if (command === 'START') {
    state.pump = true;
    state.zones.forEach(z => { z.on = true; });
  } else if (command === 'STOP') {
    state.pump = false;
    state.zones.forEach(z => { z.on = false; });
  } else if (command === 'RESET') {
    state.pump = false;
    state.zones.forEach(z => { z.on = false; });
  } else if (command === 'TOGGLE_ZONE' && zoneId) {
    const zone = state.zones.find(z => z.id === zoneId);
    if (zone) zone.on = !zone.on;
  } else if (command === 'TOGGLE_PUMP') {
    state.pump = !state.pump;
  }
  saveState(state);
  io.emit('update', state);
  res.json(state);
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// ── WebSocket ──
io.on('connection', (socket) => {
  socket.emit('update', state);
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`GTC Rega API listening on port ${port}`);
  console.log(`Data dir: ${DATA_DIR}`);
  console.log(`State file: ${STATE_FILE}`);
});
