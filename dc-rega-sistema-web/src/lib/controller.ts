/**
 * GTC Rega — Frontend Controller Client
 * Comunicação bidirecional com o backend via WebSocket + REST.
 * Exponential backoff, heartbeat, fallback robusto.
 */

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

const API_BASE = import.meta.env.VITE_API_URL || '';

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

export function createControllerClient() {
  let socket: WebSocket | null = null;
  const listeners: Map<string, Set<Function>> = new Map();
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let lastStateTime = 0;
  let connected = false;

  function on(event: string, callback: Function) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(callback);
    return () => { listeners.get(event)?.delete(callback); };
  }

  function emit(event: string, data: unknown) {
    const cbs = listeners.get(event);
    if (cbs) cbs.forEach(cb => cb(data));
  }

  // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
  function getBackoffDelay(): number {
    const base = Math.min(30, Math.pow(2, reconnectAttempts));
    const jitter = Math.random() * 1000; // 0-1000ms jitter
    return base * 1000 + jitter;
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      // If no state update in 15 seconds, assume connection lost
      if (Date.now() - lastStateTime > 15000 && connected) {
        console.warn('[GTC] Heartbeat timeout — reconnecting');
        reconnect();
      }
      // Send ping via REST as lightweight check
      fetch(apiUrl('/api/health')).catch(() => {});
    }, 10000);
  }

  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function connect() {
    if (socket && socket.readyState === WebSocket.OPEN) return;

    const wsUrl = API_BASE 
      ? API_BASE.replace(/^http/, 'ws') 
      : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;

    try {
      socket = new WebSocket(`${wsUrl}/socket.io/?EIO=4&transport=websocket`);
    } catch {
      console.warn('[GTC] WebSocket unavailable — using REST polling');
      startPolling();
      return;
    }

    socket.onopen = () => {
      console.log('[GTC] WebSocket connected');
      connected = true;
      reconnectAttempts = 0;
      lastStateTime = Date.now();
      stopPolling();
      startHeartbeat();
      emit('connected', null);
    };

    socket.onmessage = (event) => {
      lastStateTime = Date.now();
      try {
        const data = JSON.parse(event.data);
        if (typeof data === 'string') return; // Socket.IO ping

        if (Array.isArray(data)) {
          const [eventName, payload] = data;
          switch (eventName) {
            case 'controller:state':
              emit('state', payload);
              break;
            case 'controller:event':
              emit('event', payload);
              break;
            case 'controller:gpio':
              emit('gpio', payload);
              break;
            case 'controller:sensor':
              emit('sensor', payload);
              break;
            case 'controller:device':
              emit('controller:device', payload);
              break;
            case 'controller:sensor-health':
              emit('sensor-health', payload);
              break;
          }
        }
      } catch { /* ignore parse errors */ }
    };

    socket.onclose = (ev) => {
      console.log(`[GTC] WebSocket closed (code=${ev.code})`);
      connected = false;
      socket = null;
      stopHeartbeat();
      emit('disconnected', null);
      scheduleReconnect();
    };

    socket.onerror = () => {
      socket?.close();
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    const delay = getBackoffDelay();
    reconnectAttempts++;
    console.log(`[GTC] Reconnecting in ${Math.round(delay/1000)}s (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(() => {
      connect();
      // If WS fails, fall back to polling
      setTimeout(() => {
        if (!connected) startPolling();
      }, 5000);
    }, delay);
  }

  function reconnect() {
    if (socket) {
      socket.close();
      socket = null;
    }
    connected = false;
    scheduleReconnect();
  }

  function disconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    stopHeartbeat();
    stopPolling();
    if (socket) socket.close();
    socket = null;
    connected = false;
    reconnectAttempts = 0;
  }

  // ── REST Polling Fallback ──
  let polling = false;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;

  function startPolling() {
    if (polling) return;
    polling = true;
    console.log('[GTC] Starting REST polling');
    poll();
  }

  function stopPolling() {
    polling = false;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = null;
  }

  async function poll() {
    if (!polling) return;
    try {
      const res = await fetch(apiUrl('/api/control/state'));
      if (res.ok) {
        const st: ControllerState = await res.json();
        lastStateTime = Date.now();
        emit('state', st);
      }
    } catch { /* ignore */ }
    pollTimer = setTimeout(poll, 2000);
  }

  // ── REST Commands ──
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

  function sendCommand(cmd: string, data?: unknown) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify([`control:${cmd}`, data || {}]));
      return;
    }
    // Fallback to REST
    post(`/api/control/${cmd}`, data);
  }

  return {
    on,
    connect,
    disconnect,
    get connected() { return connected; },
    // ── Commands ──
    start: (pumpDelay?: number) => sendCommand('start', { pumpDelay }),
    stop: () => sendCommand('stop'),
    emergency: () => sendCommand('emergency'),
    reset: () => sendCommand('reset'),
    testCycle: () => sendCommand('test-cycle'),
    toggleZone: (zoneId: string) => sendCommand('toggle-zone', { zoneId }),
    togglePump: () => sendCommand('toggle-pump'),
    setMode: (auto: boolean) => sendCommand('mode', { auto }),
    updateZones: (zones: ZoneState[]) => { post('/api/control/zones', { zones }); },
    // ── REST helpers ──
    fetchState: async (): Promise<ControllerState | null> => {
      try {
        const res = await fetch(apiUrl('/api/control/state'));
        if (res.ok) return res.json();
      } catch { /* ignore */ }
      return null;
    },
    fetchEvents: async (limit = 100): Promise<ControllerEvent[]> => {
      try {
        const res = await fetch(apiUrl(`/api/events?limit=${limit}`));
        if (res.ok) return res.json();
      } catch { /* ignore */ }
      return [];
    },
    fetchDeviceStatus: async (): Promise<{
      deviceOnline: boolean;
      lastContact: string | null;
      deviceInfo: { deviceId?: string; firmware?: string; ip?: string; rssi?: number } | null;
      sensors: { sensorId: string; lastSeen: number | null; stale: boolean }[];
    } | null> => {
      try {
        const res = await fetch(apiUrl('/api/device/status'));
        if (res.ok) return res.json();
      } catch { /* ignore */ }
      return null;
    },
  };
}

// Singleton
let clientInstance: ReturnType<typeof createControllerClient> | null = null;
export function getControllerClient() {
  if (!clientInstance) clientInstance = createControllerClient();
  return clientInstance;
}
