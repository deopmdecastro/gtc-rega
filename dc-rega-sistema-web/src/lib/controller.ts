/**
 * GTC Rega — Frontend Controller Client
 * Comunicação bidirecional com o backend real (Socket.IO + REST).
 *
 * Tudo o que a UI mostra vem daqui: estado do motor de controlo, telemetria
 * dos sensores, saúde de cada sensor, presença do controlador ESP32-S3 e
 * registo de eventos/alarmes. Não há dados simulados no frontend.
 */

import { io, type Socket } from 'socket.io-client';

type ControllerState = {
  state: string;
  pump: boolean;
  autoMode: boolean;
  zones: ZoneState[];
  gpio: Record<number, number | boolean>;
  currentZoneIndex: number;
  cycleActive: boolean;
  testCycleActive: boolean;
  startTime: number | null;
};

type ZoneState = {
  id: string;
  sensorId: string;
  name: string;
  moisture: number;
  target: number;
  lastWatered: string;
  on: boolean;
  waterDuration: number;
  schedules?: Record<string, { enabled: boolean; hour: number; minute: number }>;
};

type ControllerEvent = {
  id: string;
  event_type: string;
  source: string;
  message: string;
  severity: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type DeviceStatus = {
  deviceOnline: boolean;
  lastContact: string | null;
  deviceInfo: { deviceId?: string; firmware?: string; ip?: string; rssi?: number; uptime?: number; platform?: string; pumpRunning?: boolean; thermalAlarm?: boolean; mcpPresent?: boolean } | null;
  sensors: { sensorId: string; lastSeen: number | null; stale: boolean }[];
  engine?: {
    state: string;
    pumpOn: boolean;
    autoMode: boolean;
    cycleActive: boolean;
    testCycleActive: boolean;
    currentZoneIndex: number;
    zones: number;
  };
};

export type HealthStatus = {
  ok: boolean;
  uptime: number;
  engineUptime: number;
  engineState: string;
  zones: number;
  watchdogActive: boolean;
  deviceOnline: boolean;
  deviceInfo: Record<string, unknown> | null;
};

const API_BASE = import.meta.env.VITE_API_URL || '';

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function createControllerClient() {
  let socket: Socket | null = null;
  const listeners: Map<string, Set<Function>> = new Map();
  /** true = backend alcançável (socket ligado ou REST a responder) */
  let connected = false;
  /** true = a receber por Socket.IO; false = a usar polling REST */
  let realtime = false;

  function on(event: string, callback: Function) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(callback);
    return () => { listeners.get(event)?.delete(callback); };
  }

  function emit(event: string, data: unknown) {
    listeners.get(event)?.forEach((cb) => cb(data));
  }

  function setConnected(next: boolean) {
    if (connected === next) return;
    connected = next;
    emit(next ? 'connected' : 'disconnected', null);
  }

  function connect() {
    if (socket) return;

    socket = io(API_BASE || undefined, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15000,
      timeout: 8000,
    });

    socket.on('connect', () => {
      realtime = true;
      setConnected(true);
      stopPolling();
      // Snapshot imediato por REST — garante dados reais no primeiro render
      void refreshAll();
    });

    socket.on('disconnect', () => {
      realtime = false;
      // Continuamos a servir dados reais por REST enquanto o socket recupera
      startPolling();
    });

    socket.on('connect_error', () => {
      realtime = false;
      startPolling();
    });

    socket.on('controller:state', (payload: ControllerState) => emit('state', payload));
    socket.on('controller:event', (payload: ControllerEvent) => emit('event', payload));
    socket.on('controller:gpio', (payload: unknown) => emit('gpio', payload));
    socket.on('controller:sensor', (payload: unknown) => emit('sensor', payload));
    socket.on('controller:device', (payload: unknown) => emit('controller:device', payload));
    socket.on('controller:sensor-health', (payload: unknown) => emit('sensor-health', payload));
    socket.on('gpio:config', (payload: unknown) => emit('gpio:config', payload));
    socket.on('wifi:config', (payload: unknown) => emit('wifi:config', payload));
    socket.on('wifi:scan-results', (payload: unknown) => emit('wifi:scan-results', payload));

    // Polling de segurança: mesmo com socket ligado, sincronizamos device/health
    startStatusPolling();
  }

  function disconnect() {
    stopPolling();
    stopStatusPolling();
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socket = null;
    }
    connected = false;
    realtime = false;
  }

  // ── Fallback REST (estado) ──
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => { void pollState(); }, 3000);
    void pollState();
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  async function pollState() {
    const st = await fetchState();
    if (st) {
      setConnected(true);
      emit('state', st);
    } else {
      setConnected(false);
    }
  }

  // ── Polling de estado do dispositivo/sensores (sempre ativo) ──
  let statusTimer: ReturnType<typeof setInterval> | null = null;

  function startStatusPolling() {
    if (statusTimer) return;
    statusTimer = setInterval(() => { void refreshDevice(); }, 5000);
  }

  function stopStatusPolling() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = null;
  }

  async function refreshDevice() {
    const status = await fetchDeviceStatus();
    if (!status) {
      setConnected(false);
      return;
    }
    setConnected(true);
    emit('controller:device', { online: status.deviceOnline, info: status.deviceInfo, lastContact: status.lastContact });
    status.sensors?.forEach((s) => emit('sensor-health', s));
    emit('device-status', status);
  }

  async function refreshAll() {
    await Promise.all([pollState(), refreshDevice()]);
  }

  // ── REST helpers ──
  async function get<T>(path: string): Promise<T | null> {
    try {
      const res = await fetch(apiUrl(path));
      if (res.ok) return (await res.json()) as T;
    } catch { /* backend inacessível */ }
    return null;
  }

  async function post(path: string, body?: unknown): Promise<boolean> {
    try {
      const res = await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  const fetchState = () => get<ControllerState>('/api/control/state');
  const fetchDeviceStatus = () => get<DeviceStatus>('/api/device/status');

  function sendCommand(cmd: string, data?: unknown) {
    if (socket && socket.connected) {
      socket.emit(`control:${cmd}`, data || {});
      return;
    }
    void post(`/api/control/${cmd}`, data);
  }

  return {
    on,
    connect,
    disconnect,
    refreshAll,
    get connected() { return connected; },
    get realtime() { return realtime; },
    // ── Comandos ──
    start: (pumpDelay?: number) => sendCommand('start', { pumpDelay }),
    stop: () => sendCommand('stop'),
    emergency: () => sendCommand('emergency'),
    reset: () => sendCommand('reset'),
    testCycle: () => sendCommand('test-cycle'),
    toggleZone: (zoneId: string) => sendCommand('toggle-zone', { zoneId }),
    togglePump: () => sendCommand('toggle-pump'),
    setMode: (auto: boolean) => sendCommand('mode', { auto }),
    updateZones: (zones: ZoneState[]) => { void post('/api/control/zones', { zones }); },
    // ── Leituras REST ──
    fetchState,
    fetchDeviceStatus,
    fetchHealth: () => get<HealthStatus>('/api/health'),
    fetchEvents: async (limit = 100): Promise<ControllerEvent[]> => {
      const events = await get<ControllerEvent[]>(`/api/events?limit=${limit}`);
      return events || [];
    },
  };
}

// Singleton
let clientInstance: ReturnType<typeof createControllerClient> | null = null;
export function getControllerClient() {
  if (!clientInstance) clientInstance = createControllerClient();
  return clientInstance;
}
