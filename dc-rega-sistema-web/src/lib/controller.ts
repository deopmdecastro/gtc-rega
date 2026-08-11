/**
 * GTC Rega — Frontend Controller Hook
 * 
 * Comunicação bidirecional com o backend via REST + WebSocket.
 * Fornece o estado do controlador em tempo real.
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
};

type GpioUpdate = { pin: number; value: number | boolean };
type SensorUpdate = { sensorId: string; moisture: number };
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
  let listeners: Map<string, Set<Function>> = new Map();
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function on(event: string, callback: Function) {
    if (!listeners.has(event)) listeners.set(event, new Set());
    listeners.get(event)!.add(callback);
    return () => { listeners.get(event)?.delete(callback); };
  }

  function emit(event: string, data: unknown) {
    const cbs = listeners.get(event);
    if (cbs) cbs.forEach(cb => cb(data));
  }

  function connect() {
    if (socket && socket.readyState === WebSocket.OPEN) return;

    const wsUrl = API_BASE 
      ? API_BASE.replace(/^http/, 'ws') 
      : `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;

    try {
      socket = new WebSocket(`${wsUrl}/socket.io/?EIO=4&transport=websocket`);
    } catch {
      // Fallback: poll REST API
      startPolling();
      return;
    }

    socket.onopen = () => {
      emit('connected', null);
    };

    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // Socket.IO protocol messages
        if (typeof data === 'string') return;

        if (Array.isArray(data)) {
          // Socket.IO event array: [eventName, payload]
          const [eventName, payload] = data;
          if (eventName === 'controller:state') {
            emit('state', payload);
          } else if (eventName === 'controller:event') {
            emit('event', payload);
          } else if (eventName === 'controller:gpio') {
            emit('gpio', payload);
          } else if (eventName === 'controller:sensor') {
            emit('sensor', payload);
          }
        }
      } catch { /* ignore parse errors */ }
    };

    socket.onclose = () => {
      emit('disconnected', null);
      socket = null;
      // Auto-reconnect after 3s
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 3000);
    };

    socket.onerror = () => {
      socket?.close();
    };
  }

  function disconnect() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (socket) socket.close();
    socket = null;
  }

  let polling = false;
  function startPolling() {
    if (polling) return;
    polling = true;
    const poll = async () => {
      if (!polling) return;
      try {
        const res = await fetch(apiUrl('/api/control/state'));
        if (res.ok) {
          const st: ControllerState = await res.json();
          emit('state', st);
        }
      } catch { /* ignore */ }
      setTimeout(poll, 2000);
    };
    poll();
  }

  function stopPolling() {
    polling = false;
  }

  // ── REST commands (fallback when WebSocket not available) ──
  async function post(path: string, body?: unknown) {
    try {
      const res = await fetch(apiUrl(path), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.ok;
    } catch { return false; }
  }

  function sendCommand(cmd: string, data?: unknown) {
    // Try WebSocket first
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
    // Commands
    start: (pumpDelay?: number) => sendCommand('start', { pumpDelay }),
    stop: () => sendCommand('stop'),
    emergency: () => sendCommand('emergency'),
    reset: () => sendCommand('reset'),
    testCycle: () => sendCommand('test-cycle'),
    toggleZone: (zoneId: string) => sendCommand('toggle-zone', { zoneId }),
    togglePump: () => sendCommand('toggle-pump'),
    setMode: (auto: boolean) => sendCommand('mode', { auto }),
    updateZones: (zones: ZoneState[]) => { post('/api/control/zones', { zones }); },
    // REST helpers
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
  };
}

// Singleton
let clientInstance: ReturnType<typeof createControllerClient> | null = null;
export function getControllerClient() {
  if (!clientInstance) clientInstance = createControllerClient();
  return clientInstance;
}
