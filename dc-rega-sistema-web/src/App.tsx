import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bell,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CloudSun,
  Copy,
  Cpu,
  Delete,
  Droplets,
  Gauge,
  Globe2,
  History,
  Home,
  Keyboard,
  Leaf,
  LockKeyhole,
  Map as MapIcon,
  Menu,
  Play,
  PlayCircle,
  Plus,
  Power,
  Radio,
  RefreshCw,
  RotateCcw,
  Save,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  TimerReset,
  Trash2,
  UserRound,
  Waves,
  X,
  MapPin,
  PencilLine,
  Spline,
  Minus,
  Eraser,
  CircuitBoard,
  Zap,
} from 'lucide-react';
import { fetchEvents, logEvent, type EventLogEntry, saveState, loadState, saveLayout, loadLayout } from '@/lib/supabase';
import { t } from '@/lang';
import { getControllerClient } from '@/lib/controller';

type Page = 'Resumo' | 'Estado' | 'Setpoints' | 'Mapa' | 'Histórico' | 'Comandos' | 'Alarmes';
type WeekDay = 'sun' | 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat';
type WaterSchedule = {
  enabled: boolean;
  hour: number;   // 0-23
  minute: number; // 0-59
};

type Zone = {
  id: string;
  sensorId: string;
  name: string;
  moisture: number;
  target: number;
  lastWatered: string;
  on: boolean;
  waterDuration: number;
  x: number;
  y: number;
  schedules: Record<WeekDay, WaterSchedule>;
};

type ErrorEvent = {
  id: string;
  time: string;
  source: string;
  message: string;
  severity: 'critical' | 'warning' | 'info';
  resolved: boolean;
};

type Language = 'PT' | 'EN';

const pages: { label: Page; icon: typeof Home }[] = [
  { label: 'Resumo', icon: Home },
  { label: 'Estado', icon: Activity },
  { label: 'Setpoints', icon: SlidersHorizontal },
  { label: 'Mapa', icon: MapIcon },
  { label: 'Histórico', icon: History },
  { label: 'Comandos', icon: PlayCircle },
  { label: 'Alarmes', icon: Bell },
];

const defaultSchedule = (enabled: boolean, hour: number, minute: number): WaterSchedule => ({ enabled, hour, minute });
const defaultSchedules = (enabled: boolean): Record<WeekDay, WaterSchedule> => ({
  sun: defaultSchedule(enabled, 6, 0),
  mon: defaultSchedule(enabled, 6, 0),
  tue: defaultSchedule(enabled, 6, 0),
  wed: defaultSchedule(enabled, 6, 0),
  thu: defaultSchedule(enabled, 6, 0),
  fri: defaultSchedule(enabled, 6, 0),
  sat: defaultSchedule(enabled, 6, 0),
});

const initialZones: Zone[] = [
  { id: 'Y1', sensorId: 'B1', name: 'Zona 1', moisture: 64, target: 55, lastWatered: 'Hoje, 18:12', on: false, waterDuration: 60, x: 26, y: 34, schedules: defaultSchedules(true) },
  { id: 'Y2', sensorId: 'B2', name: 'Zona 2', moisture: 57, target: 52, lastWatered: 'Hoje, 17:48', on: false, waterDuration: 45, x: 75, y: 34, schedules: defaultSchedules(true) },
];

// Sem dados de demonstração: os alarmes são derivados de eventos reais do
// backend (severidade 'warning'/'critical') — ver eventToErrorEvent() e o
// carregamento em loadEvents()/subscrição 'event'.
const initialErrors: ErrorEvent[] = [];

function eventToErrorEvent(ev: EventLogEntry): ErrorEvent {
  return {
    id: ev.id,
    time: formatDateTime(ev.created_at),
    source: ev.source,
    message: ev.message,
    severity: ev.severity === 'critical' ? 'critical' : ev.severity === 'warning' ? 'warning' : 'info',
    resolved: false,
  };
}

const SENSOR_GPIO_MAP: Record<string, number> = { B1: 4, B2: 5 };
// Novo esquema: sensores B1/B2 não têm relés dedicados.
// Os 8 relés (K3–K10) são todos funções do sistema:
// GPIO 6→K3(Timer1), 7→K4(Timer2), 8→K5(START), 9→K6(STOP), 10→K7(AUTO), 11→K8(Reserva), 12→K9, 13→K10
const VALVE_RELAY_MAP: Record<string, { relay: string; gpio: number; inChannel: string }> = {};
const SYSTEM_RELAYS = [
  { relay: 'K3', gpio: 6, inChannel: 'IN3', func: 'Temporizador 1' },
  { relay: 'K4', gpio: 7, inChannel: 'IN4', func: 'Temporizador 2' },
  { relay: 'K5', gpio: 8, inChannel: 'IN5', func: 'START GTC' },
  { relay: 'K6', gpio: 9, inChannel: 'IN6', func: 'STOP / Emergência' },
  { relay: 'K7', gpio: 10, inChannel: 'IN7', func: 'AUTOMÁTICO' },
  { relay: 'K8', gpio: 11, inChannel: 'IN8', func: 'Reserva' },
  { relay: 'K9', gpio: 12, inChannel: '', func: 'Reserva' },
  { relay: 'K10', gpio: 13, inChannel: '', func: 'Reserva' },
];

// Formata o uptime real do ESP32-S3 (segundos desde o último arranque, vindo da telemetria)
function formatUptime(seconds?: number): string | null {
  if (typeof seconds !== 'number' || seconds < 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

function StatusBadge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'success' | 'warning' | 'error' | 'neutral' | 'cyan' }) {
  return <span className={`status-badge status-${tone}`}><span className="status-dot" />{children}</span>;
}

function Panel({ children, className = '', style }: { children: React.ReactNode; className?: string; style?: React.CSSProperties }) {
  return <section className={`panel ${className}`} style={style}>{children}</section>;
}

let nextZoneId = 3;
let nextSensorId = 3;
function makeZoneId() {
  return `Y${nextZoneId++}`;
}
function makeSensorId() {
  return `B${nextSensorId++}`;
}

function sensorStatus(zone: Zone): 'ok' | 'warning' | 'offline' {
  if (zone.moisture >= zone.target) return 'ok';
  return 'warning';
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Hoje, ${time}`;
  if (isYesterday) return `Ontem, ${time}`;
  return `${d.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' })}, ${time}`;
}

function eventToHistoryItem(ev: EventLogEntry): { time: string; zone: string; duration: string; eventType: string } {
  const time = formatTime(ev.created_at);
  const meta = ev.metadata as Record<string, unknown> | null;
  const duration = meta?.duration ? `${meta.duration} min` : ev.event_type;
  return { time, zone: ev.source, duration, eventType: ev.event_type };
}

function App() {
  const [activePage, setActivePage] = useState<Page>('Resumo');
  const [zones, setZones] = useState(initialZones);
  const [pumpOn, setPumpOn] = useState(false);
  const [pumpDelay, setPumpDelay] = useState(5);
  const [autoMode, setAutoMode] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [errors, setErrors] = useState<ErrorEvent[]>(initialErrors);
  const [systemRunning, setSystemRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startStep, setStartStep] = useState('');
  const [engineState, setEngineState] = useState('idle');
  const [currentWateringZone, setCurrentWateringZone] = useState(-1);
  const [gpioConfig, setGpioConfig] = useState<{ gpio: number; direction: 'INPUT' | 'OUTPUT'; label: string; func: string; inChannel: string }[]>([
    { gpio: 4, direction: 'INPUT', label: 'B1', func: 'Sensor B1', inChannel: '' },
    { gpio: 5, direction: 'INPUT', label: 'B2', func: 'Sensor B2', inChannel: '' },
    { gpio: 6, direction: 'OUTPUT', label: 'K3', func: 'Temporizador 1', inChannel: 'IN3' },
    { gpio: 7, direction: 'OUTPUT', label: 'K4', func: 'Temporizador 2', inChannel: 'IN4' },
    { gpio: 8, direction: 'OUTPUT', label: 'K5', func: 'START GTC', inChannel: 'IN5' },
    { gpio: 9, direction: 'OUTPUT', label: 'K6', func: 'STOP / Emergência', inChannel: 'IN6' },
    { gpio: 10, direction: 'OUTPUT', label: 'K7', func: 'AUTOMÁTICO', inChannel: 'IN7' },
    { gpio: 11, direction: 'OUTPUT', label: 'K8', func: 'Reserva', inChannel: 'IN8' },
    { gpio: 12, direction: 'OUTPUT', label: 'K9', func: 'Reserva', inChannel: '' },
    { gpio: 13, direction: 'OUTPUT', label: 'K10', func: 'Reserva', inChannel: '' },
  ]);
  const [editingGpio, setEditingGpio] = useState<number | null>(null);
  const [zoneToDelete, setZoneToDelete] = useState<Zone | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [language, setLanguage] = useState<Language>('PT');
  const [username, setUsername] = useState('operador');
  const [password, setPassword] = useState('');
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [authChecked, setAuthChecked] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [loginReason, setLoginReason] = useState<'startup' | 'setpoints' | 'map'>('startup');
  const [pendingPage, setPendingPage] = useState<Page | null>(null);
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [eventLogLoading, setEventLogLoading] = useState(false);
  const startTimers = useRef<number[]>([]);

  // Weather state – real API
  const [weather, setWeather] = useState({ temp: 24, desc: 'Parcialmente nublado', city: 'Leiria', country: 'Portugal', icon: '⛅' });
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [deviceOnline, setDeviceOnline] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<{ deviceId?: string; firmware?: string; ip?: string; rssi?: number; uptime?: number } | null>(null);
  const [sensorHealth, setSensorHealth] = useState<Record<string, { stale: boolean; lastSeen: number | null }>>({});
  const [clock, setClock] = useState('');
  const [dateStr, setDateStr] = useState('');

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      setClock(now.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }));
      setDateStr(now.toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: 'numeric' }));
    };
    tick();
    const iv = setInterval(tick, 10000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    const fetchWeather = async () => {
      setWeatherLoading(true);
      try {
        const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=39.7437&longitude=-8.8071&current_weather=true&timezone=Europe/Lisbon');
        if (res.ok) {
          const data = await res.json();
          const cw = data.current_weather;
          const code = cw.weathercode;
          const iconMap: Record<number, string> = {
            0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️', 45: '🌫️', 48: '🌫️',
            51: '🌦️', 53: '🌦️', 55: '🌧️', 61: '🌧️', 63: '🌧️', 65: '🌧️',
            71: '🌨️', 73: '🌨️', 75: '🌨️', 80: '🌧️', 81: '🌧️', 82: '⛈️',
            95: '⛈️', 96: '⛈️', 99: '⛈️',
          };
          const descMap: Record<number, string> = {
            0: 'Céu limpo', 1: 'Pouco nublado', 2: 'Parcialmente nublado', 3: 'Nublado',
            45: 'Nevoeiro', 48: 'Nevoeiro', 51: 'Chuvisco', 53: 'Chuvisco', 55: 'Chuvisco',
            61: 'Chuva fraca', 63: 'Chuva moderada', 65: 'Chuva forte',
            71: 'Neve fraca', 73: 'Neve moderada', 75: 'Neve forte',
            80: 'Aguaceiros', 81: 'Aguaceiros', 82: 'Aguaceiros fortes',
            95: 'Trovoada', 96: 'Trovoada', 99: 'Trovoada',
          };
          setWeather({
            temp: Math.round(cw.temperature),
            desc: descMap[code] || 'Desconhecido',
            icon: iconMap[code] || '🌡️',
            city: 'Leiria',
            country: 'Portugal',
          });
        }
      } catch { /* keep fallback */ }
      setWeatherLoading(false);
    };
    fetchWeather();
    const iv = setInterval(fetchWeather, 600000); // refresh every 10 minutes
    return () => clearInterval(iv);
  }, []);

  useEffect(() => () => startTimers.current.forEach((t) => clearTimeout(t)), []);

  // Check auth session on mount
  useEffect(() => {
    const sess = sessionStorage.getItem('gtc-auth');
    if (sess === 'true') {
      setAuthenticated(true);
    }
    setAuthChecked(true);
    if (!sess) {
      setLoginReason('startup');
      setLoginOpen(true);
    }
  }, []);

  const loadEvents = useCallback(async () => {
    setEventLogLoading(true);
    const events = await fetchEvents(100);
    setEventLog(events);
    // Alarmes reais: derivados de eventos com severidade warning/critical
    const alarmEvents = events.filter((e) => e.severity === 'warning' || e.severity === 'critical');
    if (alarmEvents.length > 0) {
      setErrors((cur) => {
        const known = new Set(cur.map((e) => e.id));
        const fresh = alarmEvents.filter((e) => !known.has(e.id)).map(eventToErrorEvent);
        return [...fresh, ...cur];
      });
    }
    setEventLogLoading(false);
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  // Auto-save state to backend when zones/errors change
  useEffect(() => {
    const timer = setTimeout(() => {
      saveState({ zones, errors, pump: pumpOn, mode: autoMode ? 'automatic' : 'manual' });
    }, 2000); // debounce 2s
    return () => clearTimeout(timer);
  }, [zones, errors, pumpOn, autoMode]);

  // Load state from backend on initial mount
  useEffect(() => {
    const init = async () => {
      const saved = await loadState();
      if (saved && typeof saved === 'object') {
        const s = saved as Record<string, unknown>;
        if (s.zones && Array.isArray(s.zones) && (s.zones as Array<unknown>).length > 0) {
          setZones(s.zones as Zone[]);
        }
        if (s.errors && Array.isArray(s.errors)) {
          setErrors(s.errors as ErrorEvent[]);
        }
        if (typeof s.pump === 'boolean') setPumpOn(s.pump);
        if (s.mode === 'automatic' || s.mode === 'manual') setAutoMode(s.mode === 'automatic');
      }
    };
    init();
  }, []);

  // Listen for controller state updates via WebSocket
  useEffect(() => {
    const ctrl = getControllerClient();
    ctrl.connect();

    const unsubState = ctrl.on('state', (cs: Record<string, unknown>) => {
      if (cs.zones && Array.isArray(cs.zones)) {
        setZones(cs.zones as Zone[]);
      }
      if (typeof cs.pump === 'boolean') setPumpOn(cs.pump);
      if (typeof cs.autoMode === 'boolean') setAutoMode(cs.autoMode);
      if (typeof cs.state === 'string') {
        setEngineState(cs.state as string);
        setCurrentWateringZone((cs.currentZoneIndex as number) ?? -1);
        if (cs.state === 'idle' || cs.state === 'stopping') {
          setSystemRunning(false);
          setStarting(false);
          setStartStep('');
        } else if (cs.state === 'starting') {
          setSystemRunning(true);
          setStarting(true);
          setStartStep('A ligar bomba…');
        } else if (cs.state === 'watering') {
          setSystemRunning(true);
          setStarting(false);
          setStartStep(cs.cycleActive ? 'Ciclo de rega em curso' : '');
        } else if (cs.state === 'emergency') {
          setSystemRunning(false);
          setStarting(false);
          setStartStep('EMERGÊNCIA');
        }
      }
    });

    const unsubEvent = ctrl.on('event', (ev: Record<string, unknown>) => {
      if (ev.message) {
        showNotice(ev.message as string);
      }
      // Erros/alarmes reais: qualquer evento warning/critical vira alarme
      const severity = ev.severity as string | undefined;
      if (severity === 'warning' || severity === 'critical') {
        setErrors((cur) => {
          if (cur.some((e) => e.id === ev.id)) return cur;
          return [eventToErrorEvent(ev as unknown as EventLogEntry), ...cur];
        });
      }
    });

    const unsubDevice = ctrl.on('controller:device', (dev: Record<string, unknown>) => {
      if (dev.online !== undefined) setDeviceOnline(dev.online as boolean);
      if (dev.info) setDeviceInfo(dev.info as typeof deviceInfo);
    });

    const unsubSensorHealth = ctrl.on('sensor-health', (health: Record<string, unknown>) => {
      const sensorId = health.sensorId as string;
      if (!sensorId) return;
      setSensorHealth((cur) => ({ ...cur, [sensorId]: { stale: !!health.stale, lastSeen: (health.lastSeen as number) ?? null } }));
    });

    // Snapshot inicial do estado real do controlador e sensores (REST) —
    // garante que a UI mostra dados reais mesmo antes do primeiro evento WS
    ctrl.fetchDeviceStatus().then((status) => {
      if (!status) return;
      setDeviceOnline(status.deviceOnline);
      if (status.deviceInfo) setDeviceInfo(status.deviceInfo);
      if (Array.isArray(status.sensors)) {
        const map: Record<string, { stale: boolean; lastSeen: number | null }> = {};
        status.sensors.forEach((s) => { map[s.sensorId] = { stale: s.stale, lastSeen: s.lastSeen }; });
        setSensorHealth(map);
      }
    });

    return () => {
      unsubState();
      unsubEvent();
      unsubDevice();
      unsubSensorHealth();
      ctrl.disconnect();
    };
  }, []);
  const activeZones = useMemo(() => zones.filter((z) => z.on).length, [zones]);
  const alarmCount = useMemo(() => errors.filter((e) => !e.resolved).length, [errors]);

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 2800);
  };

  const toggleZone = useCallback((id: string) => {
    const ctrl = getControllerClient();
    ctrl.toggleZone(id);
    // Optimistic local update
    setZones((cur) => {
      const zone = cur.find((z) => z.id === id);
      if (!zone) return cur;
      const newState = !zone.on;
      return cur.map((z) => (z.id === id ? { ...z, on: newState } : z));
    });
  }, []);

  const togglePump = useCallback(() => {
    const ctrl = getControllerClient();
    ctrl.togglePump();
    setPumpOn((prev) => !prev);
  }, []);

  const addZone = () => {
    const id = makeZoneId();
    const sensorId = makeSensorId();
    const num = zones.length + 1;
    // Alterna entre os dois terrenos por defeito, com leve variação, para o
    // mapa começar organizado em vez de posições totalmente aleatórias.
    const inFieldB = zones.length % 2 === 1;
    const baseX = inFieldB ? 75 : 26;
    const x = Math.min(94, Math.max(6, baseX + (Math.random() * 10 - 5)));
    const y = Math.min(76, Math.max(14, 26 + Math.floor(zones.length / 2) * 14 + (Math.random() * 6 - 3)));
    const newZone: Zone = { id, sensorId, name: `Zona ${num}`, moisture: 50, target: 50, lastWatered: '—', on: false, waterDuration: 30, x, y, schedules: defaultSchedules(true) };
    setZones((cur) => [...cur, newZone]);
    logEvent('zone_add', `${newZone.name} · Sensor ${sensorId}`, `Sensor ${sensorId} e válvula ${id} adicionados`, 'info', { zone_id: id, sensor_id: sensorId });
    showNotice(`Sensor ${sensorId} adicionado`);
    // Sync with backend
    setTimeout(() => {
      const ctrl = getControllerClient();
      ctrl.updateZones([...zones, newZone]);
    }, 100);
  };

  // Auto-layout: snap zone into the nearest field
  const snapToField = (x: number, y: number): { x: number; y: number } => {
    return { x, y };
  };

  const addZoneFromMap = useCallback((x: number, y: number) => {
    const id = makeZoneId();
    const sensorId = makeSensorId();
    const num = zones.length + 1;
    const newZone: Zone = { id, sensorId, name: `Zona ${num}`, moisture: 50, target: 50, lastWatered: '—', on: false, waterDuration: 30, x, y, schedules: defaultSchedules(true) };
    setZones((cur) => [...cur, newZone]);
    logEvent('zone_add_map', `${newZone.name} · Sensor ${sensorId}`, `Local adicionado no mapa: válvula ${id}, sensor ${sensorId}`, 'info', { zone_id: id, sensor_id: sensorId, x, y });
    showNotice(`Local adicionado: ${newZone.name}`);
    setTimeout(() => {
      const ctrl = getControllerClient();
      ctrl.updateZones([...zones, newZone]);
    }, 100);
  }, [zones.length]);

  const duplicateZoneFromMap = useCallback((zone: Zone) => {
    const id = makeZoneId();
    const sensorId = makeSensorId();
    const num = zones.length + 1;
    const nextX = Math.max(6, Math.min(94, zone.x + 8));
    const nextY = Math.max(6, Math.min(76, zone.y + 8));
    const duplicate: Zone = {
      ...zone,
      id,
      sensorId,
      name: `Zona ${num}`,
      on: false,
      lastWatered: '—',
      x: nextX,
      y: nextY,
      schedules: { ...zone.schedules },
    };
    setZones((cur) => [...cur, duplicate]);
    logEvent('zone_duplicate', `${zone.name} → ${duplicate.name}`, `Sensor ${sensorId} e válvula ${id} duplicados a partir de ${zone.sensorId}/${zone.id}`, 'info', {
      source_zone_id: zone.id,
      zone_id: id,
      sensor_id: sensorId,
      x: nextX,
      y: nextY,
    });
    showNotice(`Sensor ${sensorId} duplicado com sucesso`);
  }, [zones.length]);

  const updateZonePosition = useCallback((id: string, x: number, y: number) => {
    setZones((cur) => cur.map((z) => (z.id === id ? { ...z, x, y } : z)));
  }, []);

  const renameZone = useCallback((id: string, newName: string) => {
    setZones((cur) => {
      const zone = cur.find((z) => z.id === id);
      if (zone) {
        logEvent('zone_rename', `${zone.name} → ${newName}`, `Nome alterado para ${newName}`, 'info', { zone_id: id, old_name: zone.name, new_name: newName });
      }
      return cur.map((z) => (z.id === id ? { ...z, name: newName } : z));
    });
  }, []);

  const handleStart = () => {
    const ctrl = getControllerClient();
    ctrl.start(pumpDelay);
    setSystemRunning(true);
    setStarting(true);
    setPumpOn(true);
    setStartStep('A ligar bomba…');
    showNotice('Start enviado ao controlador');
  };
  const handleStop = () => {
    const ctrl = getControllerClient();
    ctrl.stop();
    setSystemRunning(false);
    setStarting(false);
    setStartStep('');
    setPumpOn(false);
    setZones((cur) => cur.map((z) => ({ ...z, on: false })));
    showNotice('Stop enviado ao controlador');
  };
  const handleReset = () => {
    const ctrl = getControllerClient();
    ctrl.reset();
    setSystemRunning(false);
    setStarting(false);
    setStartStep('');
    setPumpOn(false);
    setZones((cur) => cur.map((z) => ({ ...z, on: false })));
    setErrors((cur) => cur.map((e) => ({ ...e, resolved: true })));
    showNotice('Reset enviado ao controlador');
  };

  const toggleAutoMode = () => {
    const next = !autoMode;
    setAutoMode(next);
    const ctrl = getControllerClient();
    ctrl.setMode(next);
    showNotice(next ? 'Modo automático ativado' : 'Modo manual ativado');
  };

  const handleEmergencyStop = () => {
    const ctrl = getControllerClient();
    ctrl.emergency();
    setZones((cur) => cur.map((z) => ({ ...z, on: false })));
    setPumpOn(false);
    setSystemRunning(false);
    showNotice('Paragem de emergência executada');
  };

  const handleTestCycle = () => {
    const ctrl = getControllerClient();
    ctrl.testCycle();
    showNotice('Ciclo de teste iniciado no controlador');
  };

  const clearAllZones = useCallback(() => {
    setZones((cur) => {
      if (cur.length > 0) {
        logEvent('zone_clear_all', 'Mapa', `Todos os sensores removidos (${cur.length})`, 'warning', { count: cur.length });
      }
      return [];
    });
    showNotice('Todos os sensores foram removidos do mapa');
  }, []);

  const confirmDeleteZone = () => {
    if (!zoneToDelete) return;
    setZones((cur) => cur.filter((z) => z.id !== zoneToDelete.id));
    logEvent('zone_remove', `${zoneToDelete.name} · Sensor ${zoneToDelete.sensorId}`, `Sensor ${zoneToDelete.sensorId} e válvula ${zoneToDelete.id} removidos`, 'warning', { zone_id: zoneToDelete.id, sensor_id: zoneToDelete.sensorId });
    showNotice(`Sensor ${zoneToDelete.sensorId} removido`);
    setZoneToDelete(null);
  };

  const handleLogout = () => {
    setAuthenticated(false);
    sessionStorage.removeItem('gtc-auth');
    setAuthChecked(false);
    setLoginOpen(true);
    setLoginReason('startup');
    showNotice(language === 'PT' ? 'Sessão terminada' : 'Signed out');
  };

  const handleLogin = (_user: string, pass: string) => {
    if (pass === '1234') {
      setAuthenticated(true);
      sessionStorage.setItem('gtc-auth', 'true');
      setLoginOpen(false);
      if (pendingPage) {
        setActivePage(pendingPage);
        setPendingPage(null);
      }
      showNotice('Autenticado com sucesso');
    }
  };

  const requireAuth = (page: Page) => {
    if (authenticated || sessionStorage.getItem('gtc-auth') === 'true') {
      if (!authenticated) setAuthenticated(true);
      setActivePage(page);
      return;
    }
    setPendingPage(page);
    setLoginReason(page === 'Setpoints' ? 'setpoints' : 'map');
    setLoginOpen(true);
  };

  const saveGpioConfig = () => {
    // Sync to backend
    const ctrl = getControllerClient();
    // Send as custom gpio config update
    fetch(`${import.meta.env.VITE_API_URL || ''}/api/gpio-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: gpioConfig }),
    }).catch(() => {});
    showNotice(language === 'PT' ? 'Configuração GPIO guardada' : 'GPIO configuration saved');
    persistGpioLocale();
  };

  const persistGpioLocale = () => {
    localStorage.setItem('gtc-gpio-config', JSON.stringify(gpioConfig));
  };

  const loadGpioLocale = () => {
    try {
      const raw = localStorage.getItem('gtc-gpio-config');
      if (raw) setGpioConfig(JSON.parse(raw));
    } catch {}
  };

  const handleGpioUpdate = (gpio: number, key: string, value: string) => {
    setGpioConfig(prev => prev.map(g => g.gpio === gpio ? { ...g, [key]: value } : g));
  };

  const saveSettings = () => {
    setSettingsSaved(true);
    showNotice('Definições guardadas');
    window.setTimeout(() => setSettingsSaved(false), 2200);
  };

  const renderPage = () => {
    if (activePage === 'Resumo') {
      return <Overview zones={zones} pumpOn={pumpOn} autoMode={autoMode} activeZones={activeZones} onToggleZone={toggleZone} onTogglePump={togglePump} onToggleMode={toggleAutoMode} onOpenMap={() => requireAuth('Mapa')} weather={weather} language={language} deviceOnline={deviceOnline} deviceInfo={deviceInfo} sensorHealth={sensorHealth} clock={clock} dateStr={dateStr} latestAlert={errors[0]} />;
    }
    if (activePage === 'Estado') return <StateView zones={zones} pumpOn={pumpOn} autoMode={autoMode} onToggleMode={toggleAutoMode} language={language} gpioConfig={gpioConfig} editingGpio={editingGpio} setEditingGpio={setEditingGpio} handleGpioUpdate={handleGpioUpdate} saveGpioConfig={saveGpioConfig} deviceOnline={deviceOnline} deviceInfo={deviceInfo} sensorHealth={sensorHealth} engineState={engineState} />;
    if (activePage === 'Setpoints') return <SetpointsView zones={zones} pumpDelay={pumpDelay} setPumpDelay={setPumpDelay} onChange={(id, target) => { setZones((cur) => { const next = cur.map((z) => (z.id === id ? { ...z, target } : z)); setTimeout(() => getControllerClient().updateZones(next), 200); return next; }); }} onUpdateZone={(id, patch) => { setZones((cur) => { const next = cur.map((z) => (z.id === id ? { ...z, ...patch } : z)); setTimeout(() => getControllerClient().updateZones(next), 200); return next; }); }} onAddZone={addZone} onRemoveZone={(z) => setZoneToDelete(z)} language={language} />;
    if (activePage === 'Mapa') return <MapView zones={zones} pumpOn={pumpOn} onAddZone={addZoneFromMap} onDuplicateZone={duplicateZoneFromMap} onDragZone={updateZonePosition} onRenameZone={renameZone} onRemoveZone={(z) => setZoneToDelete(z)} onClearAll={clearAllZones} onToggleZone={toggleZone} weather={weather} language={language} />;
    if (activePage === 'Histórico') return <HistoryView errors={errors} eventLog={eventLog} eventLogLoading={eventLogLoading} onRefresh={loadEvents} language={language} />;
    if (activePage === 'Comandos') return <CommandsView zones={zones} pumpOn={pumpOn} systemRunning={systemRunning} starting={starting} startStep={startStep} autoMode={autoMode} onToggleZone={toggleZone} onTogglePump={togglePump} onToggleMode={toggleAutoMode} onEmergencyStop={handleEmergencyStop} onTestCycle={handleTestCycle} onStart={handleStart} onStop={handleStop} onReset={handleReset} language={language} />;
    return <AlarmsView errors={errors} onResolve={(id) => setErrors((cur) => cur.map((e) => (e.id === id ? { ...e, resolved: true } : e)))} language={language} />;
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><Leaf size={22} /></div>
          <div><strong>GTC</strong><span>REGA</span></div>
          <button className="close-menu" onClick={() => setMobileOpen(false)} aria-label="Fechar menu"><X size={18} /></button>
        </div>
        <div className="sidebar-label">{t('sidebar.control', language)}</div>
        <nav className="side-nav" aria-label="Navegação principal">
          {pages.map(({ label, icon: Icon }) => (
            <button key={label} className={activePage === label ? 'nav-item active' : 'nav-item'} onClick={() => { if (label === 'Setpoints' || label === 'Mapa') { requireAuth(label); } else { setActivePage(label); } setMobileOpen(false); }}>
              <Icon size={19} strokeWidth={1.8} /><span>{t(`nav.${label.toLowerCase()}`, language)}</span>
              {label === 'Alarmes' && alarmCount > 0 && <span className="nav-count">{alarmCount}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <StatusBadge tone="success">{t('sidebar.system', language)}</StatusBadge>
          <div className="footer-reading"><TimerReset size={17} /><div><strong>{clock || '21:16'}</strong><span>{dateStr || '10/08/2026'}</span></div></div>
          <div className="footer-reading"><CloudSun size={19} /><div><strong>{weather.temp}°C</strong><span>{weather.city} · {weather.desc}</span></div></div>
          <div className="footer-reading"><Cpu size={17} /><div><strong>ESP32-S3</strong><span>{t('sidebar.controller', language)}</span></div></div>
        </div>
      </aside>
      {mobileOpen && <button className="scrim" onClick={() => setMobileOpen(false)} aria-label="Fechar menu" />}
      <main className="main-content">
        <header className="topbar">
          <div className="topbar-inner">
            <button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Abrir menu"><Menu size={22} /></button>
            <div className="topbar-title compact">
              <h1>GTC <span>—</span> {t('topbar.title', language)}</h1>
            </div>
            <div className="topbar-right">
              <button className="lang-toggle-btn" onClick={() => setLanguage(l => l === 'PT' ? 'EN' : 'PT')} aria-label="Trocar idioma" title={language === 'PT' ? 'Switch to English' : 'Mudar para Português'}>
                <Globe2 size={18} /><span className="lang-label">{language}</span>
              </button>
              <div className="weather"><CloudSun size={28} /><div><strong>{weather.temp}°C</strong><span>{weather.city}, {weather.country} · {weather.desc}</span></div></div>
              <button className="settings-btn" onClick={() => setSettingsOpen(true)} aria-label="Abrir definições"><Settings2 size={20} /></button>
            </div>
          </div>
        </header>
        <div className="content-wrap">
          <div className="page-heading">
            <div><span className="section-kicker">{t('heading.overview', language)}</span><h2>{t(`nav.${activePage.toLowerCase()}`, language)}</h2></div>
            <div className="connection"><Radio size={15} /> {deviceOnline ? 'ESP32 Online' : t('heading.connection', language)} <span className={`pulse ${deviceOnline ? 'pulse-device' : ''}`} /></div>
          </div>
          {renderPage()}
          <footer className="app-footer">
            <span>Desenvolvido por <strong>Deogracia de Castro</strong></span>
            <span className="footer-divider">·</span>
            <span>GTC Rega v2.8 · ESP32-S3 · Build 2026-08-11</span>
          </footer>
        </div>
      </main>
      {notice && <div className="toast"><CheckCircle2 size={18} />{notice}</div>}
      {zoneToDelete && <ConfirmDeleteModal zone={zoneToDelete} onCancel={() => setZoneToDelete(null)} onConfirm={confirmDeleteZone} />}
      {loginOpen && !authenticated && <LoginScreen language={language} onSubmit={handleLogin} />}
      {settingsOpen && <SettingsPanel language={language} setLanguage={setLanguage} username={username} setUsername={setUsername} password={password} setPassword={setPassword} saved={settingsSaved} onSave={saveSettings} onClose={() => setSettingsOpen(false)} onLogout={handleLogout} authenticated={authenticated} />}
    </div>
  );
}

/* ---------- Overview ---------- */
function Overview({ zones, pumpOn, autoMode, activeZones, onToggleZone, onTogglePump, onToggleMode, onOpenMap, weather, language, deviceOnline, deviceInfo, sensorHealth, clock, dateStr, latestAlert }: {
  zones: Zone[]; pumpOn: boolean; autoMode: boolean; activeZones: number; onToggleZone: (id: string) => void; onTogglePump: () => void; onToggleMode: () => void; onOpenMap: () => void; weather: { temp: number; desc: string; city: string; country: string; icon: string }; language: Language;
  deviceOnline: boolean;
  deviceInfo: { deviceId?: string; firmware?: string; ip?: string; rssi?: number; uptime?: number } | null;
  sensorHealth: Record<string, { stale: boolean; lastSeen: number | null }>;
  clock: string;
  dateStr: string;
  latestAlert?: ErrorEvent;
}) {
  const staleSensorCount = zones.filter((z) => sensorHealth[z.sensorId]?.stale).length;
  return (
    <div className="content-stack">
      <Panel className={`device-status-panel ${deviceOnline ? 'device-online' : 'device-offline'}`}>
        <div className="device-status-main">
          <span className={`device-status-dot ${deviceOnline ? 'on' : 'off'}`} />
          <div className="device-status-info">
            <strong>{deviceOnline ? (language === 'PT' ? 'Controlador reconhecido' : 'Controller recognized') : (language === 'PT' ? 'Controlador não detetado — a simular' : 'Controller not detected — simulating')}</strong>
            <span>
              {deviceOnline && deviceInfo
                ? `${deviceInfo.deviceId || 'ESP32-S3'} · fw ${deviceInfo.firmware || '—'} · ${deviceInfo.ip || '—'}${typeof deviceInfo.rssi === 'number' ? ` · ${deviceInfo.rssi} dBm` : ''}${formatUptime(deviceInfo.uptime) ? ` · online há ${formatUptime(deviceInfo.uptime)}` : ''}`
                : (language === 'PT' ? 'Ligue o firmware gtc-esp32s3 à rede para ativar dados reais' : 'Connect gtc-esp32s3 firmware to network to activate real data')}
            </span>
          </div>
          {deviceOnline && <StatusBadge tone="success">{language === 'PT' ? 'Online' : 'Online'}</StatusBadge>}
        </div>
        <div className="device-status-sensors">
          <span className="device-status-sensors-label">{language === 'PT' ? 'Sensores:' : 'Sensors:'}</span>
          {zones.length === 0 && <span className="sensor-health-pill sim">{language === 'PT' ? 'Nenhum sensor' : 'No sensors'}</span>}
          {zones.map((z) => {
            const health = sensorHealth[z.sensorId];
            const stale = !!health?.stale;
            return (
              <span key={z.id} className={`sensor-health-pill ${stale ? 'stale' : deviceOnline ? 'ok' : 'sim'}`} title={stale ? (language === 'PT' ? 'Sem resposta do sensor' : 'Sensor not responding') : deviceOnline ? (language === 'PT' ? 'Sensor reconhecido' : 'Sensor recognized') : (language === 'PT' ? 'Simulado (sem dispositivo real)' : 'Simulated (no real device)')}>
                <Radio size={12} /> {z.sensorId} {stale ? `· ${language === 'PT' ? 'sem sinal' : 'no signal'}` : deviceOnline ? '· ok' : `· ${language === 'PT' ? 'sim.' : 'sim.'}`}
                <span className="sensor-health-value">{z.moisture}%</span>
              </span>
            );
          })}
        </div>
      </Panel>
      <Panel className="hero-panel">
        <div className="hero-status">
          <div className="system-orbit"><div className="orbit-ring" /><div className="orbit-core"><Leaf size={39} /></div></div>
          <div>
            <span className="label">{t('overview.systemState', language)}</span>
            <h3>{autoMode ? t('overview.auto', language) : t('overview.manual', language)}</h3>
            <button className={`mode-toggle-btn ${autoMode ? 'mode-auto' : 'mode-manual'}`} onClick={onToggleMode}>
              <Settings2 size={14} />{autoMode ? 'Automático' : 'Manual'}<span className="mode-pulse" />
            </button>
          </div>
        </div>
        <div className="hero-divider" />
        <div className="actuator-list">
          <div className="panel-title-row"><span>{t('overview.actuators', language)}</span><small>{activeZones} {t('overview.active', language)}</small></div>
          <ActuatorRow icon={<Waves />} label="Bomba" on={pumpOn} onToggle={onTogglePump} />
          {zones.map((z) => <ActuatorRow key={z.id} icon={<Droplets />} label={`${z.name} · Válvula ${z.id}`} on={z.on} onToggle={() => onToggleZone(z.id)} />)}
        </div>
      </Panel>
      <div className="sensor-grid">{zones.map((z) => <SensorCard key={z.id} zone={z} language={language} stale={!!sensorHealth[z.sensorId]?.stale} />)}</div>
      <Panel className="metrics-panel">
        <Metric icon={<CalendarDays />} label="Data" value={dateStr || '—'} />
        <Metric icon={<TimerReset />} label="Hora" value={clock || '—'} />
        <Metric icon={<Droplets />} label="Última rega" value={zones[0]?.name ?? '—'} detail={zones[0]?.lastWatered ?? '—'} />
        <Metric icon={<Cpu />} label="Controlador" value={deviceOnline ? (deviceInfo?.deviceId || 'ESP32-S3') : 'Simulação'} detail={deviceOnline ? `Wi-Fi · fw ${deviceInfo?.firmware || '—'}` : 'Sem dispositivo real ligado'} accent={deviceOnline} />
      </Panel>
      <div className="quick-grid">
        <Panel className="quick-panel">
          <div className="panel-title-row"><div><span className="section-kicker">{t('overview.attentionOps', language)}</span><h3>{t('overview.nextWater', language)}</h3></div><TimerReset size={20} /></div>
          <div className="next-irrigation"><strong>{zones.find((z) => z.moisture < z.target)?.name ?? zones[0]?.name ?? '—'}</strong><span>{t('overview.scheduled', language)}</span><ChevronRight size={18} /></div>
        </Panel>
        <Panel className="quick-panel alarm-preview">
          <div className="panel-title-row"><div><span className="section-kicker">{t('overview.system', language)}</span><h3>{t('overview.recentAlerts', language)}</h3></div><AlertTriangle size={20} /></div>
          {latestAlert ? (
            <div className="alert-line"><span className="alert-icon"><AlertTriangle size={15} /></span><div><strong>{latestAlert.source}</strong><span>{latestAlert.message}</span></div><small>{latestAlert.time}</small></div>
          ) : (
            <div className="alert-line alert-line-empty"><span className="alert-icon ok"><CheckCircle2 size={15} /></span><div><strong>Sem alarmes ativos</strong><span>{staleSensorCount > 0 ? `${staleSensorCount} sensor(es) sem sinal` : 'Todos os sensores a reportar normalmente'}</span></div></div>
          )}
        </Panel>
      </div>
      <div className="overview-map-link">
        <Panel className="quick-panel">
          <div className="panel-title-row"><div><span className="section-kicker">{t('overview.location', language)}</span><h3>{t('overview.sensorMap', language)}</h3></div><MapIcon size={20} /></div>
          <button className="action-button" onClick={onOpenMap}><MapIcon size={20} /><span><strong>Ver mapa completo</strong><small>Localização e estado de cada sensor na propriedade</small></span><ChevronRight size={17} /></button>
        </Panel>
      </div>
    </div>
  );
}

function ActuatorRow({ icon, label, on, onToggle }: { icon: React.ReactNode; label: string; on: boolean; onToggle: () => void }) {
  return <div className="actuator-row"><span className="actuator-icon">{icon}</span><strong>{label}</strong><button className={`switch ${on ? 'switch-on' : ''}`} onClick={onToggle} aria-label={`Alternar ${label}`}><span /></button><span className={`actuator-state ${on ? 'on' : ''}`}>{on ? 'LIGADO' : 'DESLIGADO'}</span></div>;
}

function SensorCard({ zone, language, stale }: { zone: Zone; language: Language; stale?: boolean }) {
  return (
    <Panel className={`sensor-card ${stale ? 'sensor-card-stale' : ''}`}>
      <div className="sensor-header">
        <div><span className="section-kicker">{t('overview.sensor', language)} {zone.sensorId}</span><h3>{zone.name}</h3></div>
        <StatusBadge tone={stale ? 'warning' : zone.moisture >= zone.target ? 'success' : 'warning'}>{stale ? (language === 'PT' ? 'Sem sinal' : 'No signal') : zone.moisture >= zone.target ? t('overview.normal', language) : t('overview.attention', language)}</StatusBadge>
      </div>
      <div className="sensor-reading">
        <div className="water-icon"><Droplets size={24} /></div>
        <strong>{zone.moisture}<small>%</small></strong>
        <span>{t('overview.moisture', language)}</span>
      </div>
      <div className="meter"><span style={{ width: `${zone.moisture}%` }} /></div>
      <div className="sensor-footer"><span>Setpoint <b>{zone.target}%</b></span><span>{stale ? (language === 'PT' ? 'Última leitura desatualizada' : 'Reading stale') : 'Atualizado agora'}</span></div>
    </Panel>
  );
}

function Metric({ icon, label, value, detail, accent }: { icon: React.ReactNode; label: string; value: string; detail?: string; accent?: boolean }) {
  return <div className="metric"><span className="metric-icon">{icon}</span><div><span className="label">{label}</span><strong className={accent ? 'accent-text' : ''}>{value}</strong>{detail && <small>{detail}</small>}</div></div>;
}

/* ---------- Estado ---------- */
function StateView({ zones, pumpOn, autoMode, onToggleMode, language, gpioConfig, editingGpio, setEditingGpio, handleGpioUpdate, saveGpioConfig, deviceOnline, deviceInfo, sensorHealth, engineState }: { zones: Zone[]; pumpOn: boolean; autoMode: boolean; onToggleMode: () => void; language: Language; gpioConfig: { gpio: number; direction: string; label: string; func: string; inChannel: string }[]; editingGpio: number | null; setEditingGpio: (v: number | null) => void; handleGpioUpdate: (gpio: number, key: string, value: string) => void; saveGpioConfig: () => void; deviceOnline: boolean; deviceInfo: { deviceId?: string; firmware?: string; ip?: string; rssi?: number; uptime?: number } | null; sensorHealth: Record<string, { stale: boolean; lastSeen: number | null }>; engineState: string; }) {
  return (
    <div className="two-column">
      <Panel>
        <PanelHeader eyebrow="LEITURA EM TEMPO REAL" title="Estado dos equipamentos" />
        <div className="state-list">
          <StateRow icon={<Cpu />} title={language === "PT" ? "Controlador central" : "Central controller"} detail={deviceOnline && deviceInfo ? `${deviceInfo.deviceId || "ESP32-S3"} · fw ${deviceInfo.firmware || "—"} · ${deviceInfo.ip || "Wi-Fi"}` : (language === "PT" ? "ESP32-S3 · Wi-Fi · Simulação" : "ESP32-S3 · Wi-Fi · Simulation")} status={deviceOnline ? "Online" : (language === "PT" ? "Simulação" : "Simulating")} active={deviceOnline} />
          <StateRow icon={<Power />} title="Bomba principal" detail="Relé K1 · Saída digital" status={pumpOn ? 'Ligada' : 'Desligada'} active={pumpOn} />
          {zones.map((z) => <StateRow key={z.id} icon={<Droplets />} title={`${z.name} · Válvula ${z.id}`} detail="Válvula solenóide" status={z.on ? 'Ligada' : 'Desligada'} active={z.on} />)}
          {zones.map((z) => { const health = sensorHealth[z.sensorId]; const stale = !!health?.stale; return <StateRow key={`s-${z.sensorId}`} icon={<Radio />} title={`${z.name} · Sensor ${z.sensorId}`} detail={stale ? (language === 'PT' ? 'Sem sinal · Verificar ligação' : 'No signal · Check connection') : `Humidade do solo · ${z.moisture}%`} status={stale ? (language === 'PT' ? 'Sem sinal' : 'No signal') : 'Online'} active={!stale} />; })}
        </div>
      </Panel>
      <Panel>
        <PanelHeader eyebrow="MODO DE OPERAÇÃO" title="Automação" />
        <div className="mode-card">
          <div className="mode-graphic"><Sparkles size={25} /></div>
          <div><strong>{autoMode ? 'Automático' : 'Manual'}</strong><p>{autoMode ? 'O sistema gere a rega com base nos setpoints.' : 'Os atuadores aguardam comandos manuais.'}</p></div>
          <StatusBadge tone="cyan">Ativo</StatusBadge>
        </div>
        <button className={`mode-toggle-btn ${autoMode ? 'mode-auto' : 'mode-manual'}`} onClick={onToggleMode}>
          <Settings2 size={15} />{autoMode ? 'Passar para Manual' : 'Passar para Automático'}
        </button>
        <div className="info-list">
          <div><span>{language === "PT" ? "Última sincronização" : "Last sync"}</span><strong>{deviceOnline ? (deviceInfo?.uptime ? `há ${Math.floor(deviceInfo.uptime / 60)} minutos` : "Agora") : (language === "PT" ? "Simulação ativa" : "Simulation active")}</strong></div>
          <div><span>{language === "PT" ? "Tempo de atividade" : "Uptime"}</span><strong>{deviceOnline && deviceInfo?.uptime ? formatUptime(deviceInfo.uptime) || "—" : (language === "PT" ? "Modo simulação" : "Simulation mode")}</strong></div>
          <div><span>{language === "PT" ? "Versão do controlador" : "Controller version"}</span><strong>{deviceOnline && deviceInfo?.firmware ? `GTC v${deviceInfo.firmware} · ${deviceInfo.deviceId || "ESP32-S3"}` : "GTC v2.15 · ESP32-S3"}</strong></div>
          <div><span>Sensores ativos</span><strong>{zones.length} zonas</strong></div>
        </div>
      </Panel>

      {/* ESP32-S3 Hardware Diagram */}
      <Panel className="estado-pinout-panel" style={{ gridColumn: '1 / -1' }}>
        <div className="hardware-panel-header">
          <div className="hardware-header-left">
            <span className="section-kicker">HARDWARE</span>
            <h3>ESP32-S3 · Mapa de Ligações GPIO</h3>
          </div>
          <div className="hardware-header-right">
            <button className="gpio-edit-btn" onClick={() => setEditingGpio(editingGpio === null ? -1 : null)}>
              <Settings2 size={15} /> {editingGpio === null ? (language === 'PT' ? 'Editar GPIO' : 'Edit GPIO') : (language === 'PT' ? 'Concluído' : 'Done')}
            </button>
          </div>
        </div>
        <div className="hardware-diagram">
          {/* Left: Sensors */}
          <div className="hw-section hw-inputs">
            <div className="hw-section-header">
              <span className="hw-section-kicker">INPUT</span>
            </div>
            {zones.map((z) => (
              <div key={z.sensorId} className="hw-sensor-node">
                <div className="hw-sensor-info">
                  <div className="hw-sensor-badge">{z.sensorId}</div>
                  <div className="hw-sensor-detail">
                    <strong>Sensor {z.sensorId}</strong>
                    <span>{z.name} · {z.moisture}%</span>
                  </div>
                </div>
                <div className={`hw-arrow hw-arrow-input ${z.sensorId === 'B1' ? 'hw-arrow-b1' : 'hw-arrow-b2'}`} />
                <div className="hw-gpio-tag hw-input-tag">
                  <span>GPIO {z.sensorId === 'B1' ? 4 : z.sensorId === 'B2' ? 5 : '—'}</span>
                  <span className="hw-gpio-dir">INPUT</span>
                </div>
              </div>
            ))}
          </div>

          {/* Center: ESP32-S3 */}
          <div className="hw-section hw-controller">
            <div className="hw-chip">
              <div className="hw-chip-top">
                <Cpu size={22} />
                <span>ESP32-S3</span>
              </div>
              <div className="hw-chip-pins">
                <div className="hw-chip-column hw-column-in">
                  {gpioConfig.filter(g => g.direction === 'INPUT').map(g => (
                    <div key={g.gpio} className={`hw-pin-tag ${g.direction === 'INPUT' ? 'hw-pin-in' : 'hw-pin-out'}`}>
                      <span className="hw-pin-num">GPIO {g.gpio}</span>
                      <span className="hw-pin-dir">{g.direction}</span>
                    </div>
                  ))}
                </div>
                <div className="hw-chip-column hw-column-out">
                  {gpioConfig.filter(g => g.direction === 'OUTPUT').map(g => (
                    <div key={g.gpio} className={`hw-pin-tag ${g.direction === 'INPUT' ? 'hw-pin-in' : 'hw-pin-out'}`}>
                      <span className="hw-pin-num">GPIO {g.gpio}</span>
                      <span className="hw-pin-dir">{g.direction}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Right: Relay outputs */}
          <div className="hw-section hw-outputs">
            <div className="hw-section-header">
              <span className="hw-section-kicker">OUTPUT · Módulo 8 Relés</span>
            </div>
            {gpioConfig.filter(g => g.direction === 'OUTPUT').map((g) => (
              <div key={g.gpio} className="hw-relay-node">
                <div className="hw-gpio-tag hw-output-tag">
                  <span>GPIO {g.gpio}</span>
                  <span className="hw-gpio-dir">OUTPUT</span>
                </div>
                <div className="hw-arrow hw-arrow-output" />
                <div className="hw-relay-info">
                  <div className="hw-relay-badge">{g.label}</div>
                  <div className="hw-relay-detail">
                    <strong>{g.func}</strong>
                    {g.inChannel && <span>{g.inChannel}</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Legend */}
        <div className="hw-legend">
          <div className="hw-legend-item"><span className="hw-legend-dot hw-legend-in" /> {language === 'PT' ? 'INPUT · Entrada' : 'INPUT · Input'}</div>
          <div className="hw-legend-item"><span className="hw-legend-dot hw-legend-out" /> {language === 'PT' ? 'OUTPUT · Saída' : 'OUTPUT · Output'}</div>
        </div>

        {/* Editable GPIO Table */}
        {editingGpio !== null && (
          <div className="gpio-edit-table-wrap">
            <h4>{language === 'PT' ? 'Editar configuração GPIO' : 'Edit GPIO Configuration'}</h4>
            <table className="gpio-edit-table">
              <thead>
                <tr>
                  <th>GPIO</th>
                  <th>{language === 'PT' ? 'Direção' : 'Direction'}</th>
                  <th>{language === 'PT' ? 'Rótulo' : 'Label'}</th>
                  <th>{language === 'PT' ? 'Função' : 'Function'}</th>
                  <th>{language === 'PT' ? 'Canal Relé' : 'Relay Channel'}</th>
                </tr>
              </thead>
              <tbody>
                {gpioConfig.map((g) => (
                  <tr key={g.gpio}>
                    <td><span className="gpio-badge">{g.gpio}</span></td>
                    <td>
                      <select className="gpio-select" value={g.direction} onChange={(e) => handleGpioUpdate(g.gpio, 'direction', e.target.value)}>
                        <option value="INPUT">INPUT</option>
                        <option value="OUTPUT">OUTPUT</option>
                      </select>
                    </td>
                    <td><input className="gpio-input" value={g.label} onChange={(e) => handleGpioUpdate(g.gpio, 'label', e.target.value)} /></td>
                    <td><input className="gpio-input" value={g.func} onChange={(e) => handleGpioUpdate(g.gpio, 'func', e.target.value)} /></td>
                    <td><input className="gpio-input gpio-input-sm" value={g.inChannel} onChange={(e) => handleGpioUpdate(g.gpio, 'inChannel', e.target.value)} placeholder="IN—" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="save-btn" onClick={saveGpioConfig}>
              <Save size={15} /> {language === 'PT' ? 'Guardar configuração GPIO' : 'Save GPIO configuration'}
            </button>
          </div>
        )}
      </Panel>
    </div>
  );
}

function PinSlot({ gpio, label, func, direction, inChannel, connected }: { gpio: number | null; label: string; func: string; direction: 'INPUT' | 'OUTPUT'; inChannel?: string; connected: boolean }) {
  return (
    <div className={`pin-slot ${direction === 'INPUT' ? 'pin-slot-in' : 'pin-slot-out'} ${connected ? 'connected' : 'disconnected'}`}>
      <span className={`pin-slot-gpio ${connected ? 'active' : ''}`}>{gpio !== null ? `GPIO ${gpio}` : '—'}</span>
      <span className="pin-slot-label">{label}</span>
      <span className="pin-slot-func">{func}{inChannel ? ` · ${inChannel}` : ''}</span>
    </div>
  );
}

function StateRow({ icon, title, detail, status, active }: { icon: React.ReactNode; title: string; detail: string; status: string; active?: boolean }) {
  const tone: 'success' | 'warning' | 'error' | 'neutral' | 'cyan' =
    status === 'Online' ? 'success' :
    status === 'Ligada' ? 'cyan' :
    status === 'Desligada' ? 'neutral' :
    status === 'Atenção' ? 'warning' :
    active ? 'cyan' : 'neutral';
  return <div className="state-row"><span className="state-icon">{icon}</span><div><strong>{title}</strong><span>{detail}</span></div><StatusBadge tone={tone}>{status}</StatusBadge></div>;
}

function PanelHeader({ eyebrow, title, showIcon = true }: { eyebrow: string; title: string; showIcon?: boolean }) {
  return <div className="panel-heading"><div><span className="section-kicker">{eyebrow}</span><h3>{title}</h3></div>{showIcon && <Settings2 size={19} />}</div>;
}

/* ---------- Setpoints com teclado alfanumérico ---------- */
function SetpointsView({ zones, onChange, onUpdateZone, pumpDelay, setPumpDelay, onAddZone, onRemoveZone, language }: {
  zones: Zone[];
  onChange: (id: string, target: number) => void;
  onUpdateZone: (id: string, patch: Partial<Zone>) => void;
  pumpDelay: number;
  setPumpDelay: (n: number) => void;
  onAddZone: () => void;
  onRemoveZone: (zone: Zone) => void;
  language: Language;
}) {
  const [keyboard, setKeyboard] = useState<{ target: 'pump' | string; value: string } | null>(null);
  // Valores em edição (ainda não guardados) por zona — o slider já não grava sozinho
  const [pending, setPending] = useState<Record<string, number>>({});
  const [justSaved, setJustSaved] = useState<Record<string, boolean>>({});
  const [noticeMsg, setNoticeMsg] = useState('');

  const showNotice = (msg: string) => {
    setNoticeMsg(msg);
    setTimeout(() => setNoticeMsg(''), 2800);
  };

  const openKeyboard = (target: 'pump' | string, current: number) => {
    setKeyboard({ target, value: String(current) });
  };

  const submitKeyboard = () => {
    if (!keyboard) return;
    const n = Math.max(0, Number(keyboard.value) || 0);
    if (keyboard.target === 'pump') setPumpDelay(n);
    else onUpdateZone(keyboard.target, { waterDuration: n });
    setKeyboard(null);
  };

  const getDisplayTarget = (zone: Zone) => pending[zone.id] ?? zone.target;
  const isDirty = (zone: Zone) => pending[zone.id] !== undefined && pending[zone.id] !== zone.target;

  const handleSlide = (id: string, value: number) => {
    setPending((cur) => ({ ...cur, [id]: value }));
  };

  const saveSetpoint = (zone: Zone) => {
    const value = pending[zone.id];
    if (value === undefined || value === zone.target) return;
    onChange(zone.id, value);
    setPending((cur) => {
      const next = { ...cur };
      delete next[zone.id];
      return next;
    });
    setJustSaved((cur) => ({ ...cur, [zone.id]: true }));
    window.setTimeout(() => setJustSaved((cur) => ({ ...cur, [zone.id]: false })), 1800);
  };

  return (
    <>
      <div className="two-column">
        <Panel className="pump-panel">
          <PanelHeader eyebrow="CONFIGURAÇÃO" title="Delay bomba → válvulas" />
          <div className="pump-control">
            <div className="time-input">
              <button className="btn-step" onClick={() => setPumpDelay(Math.max(0, pumpDelay - 1))}>-</button>
              <button className="time-display" onClick={() => openKeyboard('pump', pumpDelay)}>{pumpDelay}<span>s</span></button>
              <button className="btn-step" onClick={() => setPumpDelay(pumpDelay + 1)}>+</button>
            </div>
            <small>Delay entre ligar a bomba e abrir as válvulas</small>
          </div>
        </Panel>
        <Panel className="add-sensor-panel">
          <PanelHeader eyebrow="GESTÃO DE SENSORES" title="Sensores do projeto" />
          <div className="add-sensor-info">
            <Droplets size={22} />
            <div>
              <strong>{zones.length} sensores ativos</strong>
              <span>Adicione novos sensores para monitorizar mais zonas de rega</span>
            </div>
          </div>
          <button className="add-sensor-btn" onClick={onAddZone}><Plus size={18} /><span>Adicionar sensor</span></button>
        </Panel>
      </div>
      <div className="setpoint-grid-v2">
        {zones.map((zone) => {
          const displayTarget = getDisplayTarget(zone);
          const dirty = isDirty(zone);
          return (
          <Panel key={zone.id} className={`setpoint-card-v2 ${dirty ? 'setpoint-dirty-v2' : ''}`}>
            {/* Header */}
            <div className="sp2-header">
              <div>
                <span className="section-kicker">{language === 'PT' ? 'CONFIGURAÇÃO' : 'CONFIGURATION'} · SENSOR {zone.sensorId}</span>
                <h3>{zone.name}</h3>
              </div>
              <button className="sp2-remove-btn" onClick={() => onRemoveZone(zone)} aria-label={`Remover ${zone.name}`}><Trash2 size={17} /></button>
            </div>

            {/* Tags */}
            <div className="sp2-tags">
              <span className="sp2-tag sp2-tag-valve"><Droplets size={12} /> {language === 'PT' ? 'Válvula' : 'Valve'} {zone.id}</span>
              <span className="sp2-tag sp2-tag-sensor"><Radio size={12} /> {language === 'PT' ? 'Sensor' : 'Sensor'} {zone.sensorId}</span>
            </div>

            {/* Current moisture — BIG number */}
            <div className="sp2-current">
              <strong>{zone.moisture}<small>%</small></strong>
              <span>{language === 'PT' ? 'Humidade atual' : 'Current moisture'}</span>
            </div>

            {/* Slider */}
            <div className="sp2-slider-section">
              <span className="sp2-slider-label">{language === 'PT' ? 'Humidade mínima desejada' : 'Minimum desired moisture'}</span>
              <div className="sp2-slider-row">
                <input type="range" min="20" max="90" value={displayTarget} onChange={(e) => handleSlide(zone.id, Number(e.target.value))} className="sp2-range" />
                <span className={`sp2-slider-value ${dirty ? 'sp2-slider-dirty' : ''}`}>{displayTarget}%</span>
              </div>
              <div className="sp2-range-labels"><span>20%</span><span>90%</span></div>
            </div>

            {/* Status note + save */}
            <div className="sp2-status-row">
              <div className="sp2-status-note">
                <Gauge size={14} />
                <span>{language === 'PT' ? 'Atual' : 'Current'}: <b>{zone.moisture}%</b> · {zone.moisture >= displayTarget ? (language === 'PT' ? 'acima do mínimo' : 'above minimum') : (language === 'PT' ? 'abaixo do mínimo' : 'below minimum')}</span>
              </div>
              <button
                className={`sp2-save-btn ${dirty ? 'is-dirty' : ''} ${justSaved[zone.id] ? 'is-saved' : ''}`}
                onClick={() => saveSetpoint(zone)}
                disabled={!dirty}
              >
                {justSaved[zone.id] ? <><CheckCircle2 size={14} /> {language === 'PT' ? 'Guardado' : 'Saved'}</> : <><Save size={14} /> {dirty ? (language === 'PT' ? 'Guardar' : 'Save') : (language === 'PT' ? 'Guardado' : 'Saved')}</>}
              </button>
            </div>

            {/* Water duration */}
            <div className="sp2-duration-section">
              <span className="sp2-section-label">{language === 'PT' ? 'Tempo de rega da válvula' : 'Valve watering duration'}</span>
              <div className="sp2-duration-row">
                <button className="sp2-dur-btn" onClick={() => onUpdateZone(zone.id, { waterDuration: Math.max(5, zone.waterDuration - 5) })}><Minus size={14} /></button>
                <button className="sp2-dur-value" onClick={() => openKeyboard(zone.id, zone.waterDuration)}>{zone.waterDuration}<span>s</span></button>
                <button className="sp2-dur-btn" onClick={() => onUpdateZone(zone.id, { waterDuration: zone.waterDuration + 5 })}><Plus size={14} /></button>
              </div>
              <span className="sp2-hint">{language === 'PT' ? 'Toque no valor para abrir o teclado numérico' : 'Tap the value to open the numeric keypad'}</span>
            </div>

            {/* Weekly schedule */}
            <div className="sp2-schedule-section">
              <span className="sp2-section-label">{language === 'PT' ? 'Programação semanal' : 'Weekly schedule'}</span>
              <ScheduleEditorV2 zone={zone} onChange={(schedules) => onUpdateZone(zone.id, { schedules } as Partial<Zone>)} language={language} />
            </div>
          </Panel>
          );
        })}
      </div>
      {Object.values(pending).some(v => v !== undefined) && (
        <div className="setpoint-floating-bar">
          <span><AlertTriangle size={16} /> {language === 'PT' ? 'Existem alterações por guardar nos setpoints' : 'There are unsaved setpoint changes'}</span>
          <button className="setpoint-save-all-btn" onClick={() => {
            Object.entries(pending).forEach(([id, value]) => {
              if (value !== undefined) {
                onChange(id, value);
              }
            });
            setPending({});
            showNotice(language === 'PT' ? 'Todos os setpoints guardados' : 'All setpoints saved');
          }}>
            <Save size={16} /> {language === 'PT' ? 'Guardar todos os setpoints' : 'Save all setpoints'}
          </button>
        </div>
      )}
      {keyboard && <NumericKeyboard value={keyboard.value} onChange={(v) => setKeyboard((k) => (k ? { ...k, value: v } : k))} onSubmit={submitKeyboard} onClose={() => setKeyboard(null)} />}
    </>
  );
}

/* ---------- Mapa ---------- */
type MapElement = { x: number; y: number };
type MapField = { id: string; x: number; y: number; w: number; h: number; name: string };

const DEFAULT_PUMP_POS: MapElement = { x: 38, y: 84 };
const DEFAULT_MCU_POS: MapElement = { x: 62, y: 84 };
const DEFAULT_FIELDS: MapField[] = [
  { id: 'F1', x: 5, y: 8, w: 41, h: 56, name: 'Terreno A' },
  { id: 'F2', x: 54, y: 8, w: 41, h: 56, name: 'Terreno B' },
];

let nextFieldId = 3;
function makeFieldId() {
  return `F${nextFieldId++}`;
}

function pipePath(x1: number, y1: number, x2: number, y2: number, curved: boolean): string {
  if (!curved) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const offset = Math.min(7, len * 0.25);
  const px = -dy / len;
  const py = dx / len;
  const cx = mx + px * offset;
  const cy = my + py * offset;
  return `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`;
}

const MIN_ZONE_SCALE = 0.7;
const MAX_ZONE_SCALE = 1.7;
const ZONE_SCALE_STEP = 0.15;
type EditorTool = 'select' | 'add' | 'duplicate';

function MapView({ zones, pumpOn, onAddZone, onDuplicateZone, onDragZone, onRenameZone, onRemoveZone, onClearAll, onToggleZone, weather, language }: {
  zones: Zone[];
  pumpOn: boolean;
  onAddZone: (x: number, y: number) => void;
  onDuplicateZone: (zone: Zone) => void;
  onDragZone: (id: string, x: number, y: number) => void;
  onRenameZone: (id: string, name: string) => void;
  onRemoveZone: (zone: Zone) => void;
  onClearAll: () => void;
  onToggleZone: (id: string) => void;
  weather: { temp: number; desc: string; city: string; country: string; icon: string };
  language: Language;
}) {
  const [pumpPos, setPumpPos] = useState<MapElement>(DEFAULT_PUMP_POS);
  const [mcuPos, setMcuPos] = useState<MapElement>(DEFAULT_MCU_POS);
  const [fields, setFields] = useState<MapField[]>(DEFAULT_FIELDS);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [resizing, setResizing] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editorTool, setEditorTool] = useState<EditorTool>('select');
  const [selected, setSelected] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editNameValue, setEditNameValue] = useState('');
  const [fieldNameEdit, setFieldNameEdit] = useState<string | null>(null);
  const [fieldNameValue, setFieldNameValue] = useState('');
  const [zoneScale, setZoneScale] = useState<Record<string, number>>({});
  const [curvedPipes, setCurvedPipes] = useState(false);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [selectedPart, setSelectedPart] = useState<'sensor' | 'valve' | null>(null);
  const [showPinout, setShowPinout] = useState(false);
  const [layoutSaved, setLayoutSaved] = useState(false);

  // Load saved layout from backend on mount
  useEffect(() => {
    const init = async () => {
      const saved = await loadLayout();
      if (saved && typeof saved === 'object') {
        const s = saved as Record<string, unknown>;
        if (s.pumpPos) setPumpPos(s.pumpPos as MapElement);
        if (s.mcuPos) setMcuPos(s.mcuPos as MapElement);
        if (s.fields && Array.isArray(s.fields)) setFields(s.fields as MapField[]);
        if (s.curvedPipes !== undefined) setCurvedPipes(s.curvedPipes as boolean);
        if (s.zoneScale) setZoneScale(s.zoneScale as Record<string, number>);
      }
    };
    init();
  }, []);

  const getZoneScale = (id: string) => zoneScale[id] ?? 1;

  const adjustZoneScale = (id: string, delta: number) => {
    setZoneScale((cur) => {
      const next = Math.round(Math.min(MAX_ZONE_SCALE, Math.max(MIN_ZONE_SCALE, (cur[id] ?? 1) + delta)) * 100) / 100;
      return { ...cur, [id]: next };
    });
  };

  const handleClearAll = () => {
    onClearAll();
    setFields([]);
    setZoneScale({});
    setSelected(null);
    setConfirmClearAll(false);
  };

  const getXY = (e: MouseEvent | React.MouseEvent): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(2, Math.min(98, ((e.clientX - rect.left) / rect.width) * 100)),
      y: Math.max(2, Math.min(98, ((e.clientY - rect.top) / rect.height) * 100)),
    };
  };

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (dragging || resizing) return;
    const clickedCanvas = e.target === canvasRef.current || (e.target as HTMLElement).classList.contains('map-grid-bg');
    if (clickedCanvas) {
      setSelected(null);
      setSelectedPart(null);
    }
    if (!editMode || editorTool !== 'add' || !clickedCanvas) return;
    const pos = getXY(e);
    if (!pos) return;
    if (pos.y > 80) return;
    onAddZone(pos.x, pos.y);
  };

  const handleMouseDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    setSelected(id);
    setDragging(id);
  };

  const handleResizeDown = (e: React.MouseEvent, fieldId: string) => {
    e.stopPropagation();
    e.preventDefault();
    setResizing(fieldId);
    setSelected(`field-${fieldId}`);
  };

  useEffect(() => {
    if (!dragging && !resizing) return;
    const handleMove = (e: MouseEvent) => {
      const pos = getXY(e);
      if (!pos) return;
      if (resizing) {
        setFields((cur) => cur.map((f) => (f.id === resizing
          ? { ...f, w: Math.max(10, Math.min(96 - f.x, pos.x - f.x)), h: Math.max(10, Math.min(96 - f.y, pos.y - f.y)) }
          : f)));
        return;
      }
      if (!dragging) return;
      if (dragging === 'pump') setPumpPos(pos);
      else if (dragging === 'mcu') setMcuPos(pos);
      else if (dragging.startsWith('field-')) {
        const fid = dragging.slice(6);
        setFields((cur) => cur.map((f) => (f.id === fid ? { ...f, x: pos.x - f.w / 2, y: pos.y - f.h / 2 } : f)));
      } else {
        onDragZone(dragging, pos.x, pos.y);
      }
    };
    const handleUp = () => { setDragging(null); setResizing(null); };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [dragging, resizing, onDragZone]);

  const startEditName = (e: React.MouseEvent, zone: Zone) => {
    e.stopPropagation();
    setEditingName(zone.id);
    setEditNameValue(zone.name);
  };

  const submitNameEdit = () => {
    if (editingName && editNameValue.trim()) {
      onRenameZone(editingName, editNameValue.trim());
    }
    setEditingName(null);
    setEditNameValue('');
  };

  const addField = () => {
    const id = makeFieldId();
    setFields((cur) => [...cur, { id, x: 30, y: 20, w: 30, h: 30, name: `Terreno ${String.fromCharCode(64 + cur.length + 1)}` }]);
    setSelected(`field-${id}`);
  };

  const removeField = (id: string) => {
    setFields((cur) => cur.filter((f) => f.id !== id));
    if (selected === `field-${id}`) setSelected(null);
  };

  const startFieldNameEdit = (e: React.MouseEvent, f: MapField) => {
    e.stopPropagation();
    setFieldNameEdit(f.id);
    setFieldNameValue(f.name);
  };

  const submitFieldName = () => {
    if (fieldNameEdit && fieldNameValue.trim()) {
      setFields((cur) => cur.map((f) => (f.id === fieldNameEdit ? { ...f, name: fieldNameValue.trim() } : f)));
    }
    setFieldNameEdit(null);
    setFieldNameValue('');
  };

  const autoLayout = () => {
    const newFields = DEFAULT_FIELDS.map((f) => ({ ...f }));
    setFields(newFields);
    setPumpPos({ ...DEFAULT_PUMP_POS });
    setMcuPos({ ...DEFAULT_MCU_POS });
    // Reposition zones inside their respective fields
    const newZones = zones.map((zone, i) => {
      const field = i < newFields.length ? newFields[i] : newFields[0];
      const cx = field.x + field.w / 2;
      const cy = field.y + field.h * 0.45;
      return { ...zone, x: cx, y: cy };
    });
    newZones.forEach(z => onDragZone(z.id, z.x, z.y));
    setLayoutSaved(false);
  };

  const resetLayout = () => {
    setPumpPos(DEFAULT_PUMP_POS);
    setMcuPos(DEFAULT_MCU_POS);
    setFields(DEFAULT_FIELDS.map((f) => ({ ...f })));
    setZoneScale({});
    setCurvedPipes(false);
    setSelected(null);
  };

  const handleSaveLayout = async () => {
    const layout = { pumpPos, mcuPos, fields, curvedPipes, zoneScale, timestamp: new Date().toISOString() };
    await saveLayout(layout);
    logEvent('layout_save', 'Mapa', 'Layout do mapa guardado', 'info', { fields: fields.length });
    setLayoutSaved(true);
    setTimeout(() => setLayoutSaved(false), 2000);
  };

  const selectedZone = zones.find((z) => z.id === selected);

  return (
    <Panel className={`map-panel ${editMode ? 'map-editing' : ''}`}>
      <div className="panel-heading">
        <div><span className="section-kicker">LOCALIZAÇÃO EM TEMPO REAL</span><h3>Quinta GTC · Leiria</h3></div>
        <div className="map-legend">
          <span><i className="legend-dot legend-pump" /> Bomba</span>
          <span><i className="legend-dot legend-valve" /> Válvula</span>
          <span><i className="legend-dot legend-ok" /> Sensor OK</span>
          <span><i className="legend-dot legend-warning" /> Sensor atenção</span>
          <span><i className="legend-dot legend-mcu" /> Microcontrolador</span>
        </div>
      </div>

      <div className="map-toolbar">
        <button
          className={`map-tool-btn ${editMode ? 'active' : ''}`}
          onClick={() => {
            setEditMode((v) => {
              const next = !v;
              setSelected(null);
              setEditorTool('select');
              return next;
            });
          }}
        >
          <PencilLine size={15} />{editMode ? 'Modo edição ativo' : 'Editar mapa'}
        </button>
        <button className={`map-tool-btn ${showPinout ? 'active' : ''}`} onClick={() => setShowPinout(v => !v)}>
          <CircuitBoard size={15} />Pinout ESP32-S3
        </button>
        <button className={`map-tool-btn ${layoutSaved ? 'active' : ''}`} onClick={handleSaveLayout}>
          <Save size={15} />{layoutSaved ? 'Layout guardado!' : 'Guardar layout'}
        </button>
        {editMode && (
          <>
            <button className={`map-tool-btn ${editorTool === 'select' ? 'active' : ''}`} onClick={() => setEditorTool('select')}>
              <MapPin size={15} />Selecionar e arrastar
            </button>
            <button className={`map-tool-btn ${editorTool === 'add' ? 'active' : ''}`} onClick={() => setEditorTool('add')}>
              <Plus size={15} />Adicionar sensor
            </button>
            <button className={`map-tool-btn ${editorTool === 'duplicate' ? 'active' : ''}`} onClick={() => setEditorTool('duplicate')}>
              <Copy size={15} />Duplicar sensor
            </button>
            <button className="map-tool-btn" onClick={addField}><Plus size={15} />Adicionar terreno</button>
            <button className={`map-tool-btn ${curvedPipes ? 'active' : ''}`} onClick={() => setCurvedPipes((v) => !v)}>
              <Spline size={15} />{curvedPipes ? 'Linhas curvas' : 'Linhas retas'}
            </button>
            <button className="map-tool-btn" onClick={autoLayout}><RefreshCw size={15} />Auto-organizar</button>
            <button className="map-tool-btn map-tool-reset" onClick={resetLayout}><RotateCcw size={15} />Layout original</button>
            <button
              className="map-tool-btn map-tool-clear"
              onClick={() => setConfirmClearAll(true)}
              disabled={zones.length === 0 && fields.length === 0}
            >
              <Eraser size={15} />Apagar tudo
            </button>
          </>
        )}
        <span className="map-tool-status">{zones.length} sensores · {fields.length} terrenos</span>
      </div>

      <div className="map-hint">
        <MapPin size={14} />
        {editMode
          ? editorTool === 'add'
            ? 'Modo adicionar: clique numa área livre do mapa para criar um novo sensor'
            : editorTool === 'duplicate'
              ? 'Modo duplicar: clique num sensor existente para criar uma cópia perto dele'
              : 'Modo seleção: arraste sensores, bomba e terrenos com precisão · Selecione um sensor para renomear, ajustar tamanho ou apagar · Arraste o canto do terreno para redimensionar'
          : 'Ative "Editar mapa" para adicionar, mover, redimensionar ou apagar elementos'}
      </div>

      <div className="map-canvas" ref={canvasRef} onClick={handleCanvasClick}>
        <div className="map-grid-bg" />
        {fields.map((f) => {
          const isSel = selected === `field-${f.id}`;
          return (
            <div
              key={f.id}
              className={`map-field-draggable ${dragging === `field-${f.id}` ? 'dragging' : ''} ${isSel ? 'selected' : ''} ${editMode ? 'editable' : ''}`}
              style={{ left: `${f.x}%`, top: `${f.y}%`, width: `${f.w}%`, height: `${f.h}%` }}
              onMouseDown={(e) => editMode && editorTool === 'select' && handleMouseDown(e, `field-${f.id}`)}
              onClick={(e) => { e.stopPropagation(); if (editMode) setSelected(`field-${f.id}`); }}
            >
              <span className="map-field-label">{f.name}</span>
              {editMode && isSel && (
                <>
                  <button className="field-action field-edit" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => startFieldNameEdit(e, f)} aria-label="Renomear terreno"><PencilLine size={12} /></button>
                  <button className="field-action field-delete" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); removeField(f.id); }} aria-label="Apagar terreno"><Trash2 size={12} /></button>
                  <span className="field-resize-handle" onMouseDown={(e) => handleResizeDown(e, f.id)} aria-label="Redimensionar terreno" />
                </>
              )}
            </div>
          );
        })}
        <svg className="map-pipes" viewBox="0 0 100 100" preserveAspectRatio="none">
          {zones.map((zone) => {
            const vx = zone.x + 5;
            const vy = zone.y;
            const sx = zone.x - 5;
            const sy = zone.y;
            return (
              <g key={zone.id}>
                <path d={pipePath(mcuPos.x, mcuPos.y, sx, sy, curvedPipes)} className={`pipe pipe-mcu ${zone.on ? 'pipe-active' : ''}`} />
                <path d={pipePath(sx, sy, vx, vy, curvedPipes)} className={`pipe pipe-sensor ${zone.on ? 'pipe-active' : ''}`} />
                <path d={pipePath(vx, vy, pumpPos.x, pumpPos.y, curvedPipes)} className={`pipe pipe-main ${zone.on ? 'pipe-active' : ''}`} />
              </g>
            );
          })}
          <path d={pipePath(mcuPos.x, mcuPos.y, pumpPos.x, pumpPos.y, curvedPipes)} className={`pipe pipe-mcu ${pumpOn ? 'pipe-active' : ''}`} />
        </svg>
        <div
          className={`map-marker marker-pump ${dragging === 'pump' ? 'dragging' : ''} ${selected === 'pump' ? 'selected' : ''} ${editMode ? 'editable' : ''}`}
          style={{ left: `${pumpPos.x}%`, top: `${pumpPos.y}%` }}
          onMouseDown={(e) => editMode && editorTool === 'select' && handleMouseDown(e, 'pump')}
        >
          <span className="marker-pin marker-pin-pump"><Waves size={16} /></span>
          <div className="marker-label">
            <strong>Bomba K1</strong>
            <span>{pumpOn ? 'Ligada' : 'Desligada'}</span>
          </div>
        </div>
        <div
          className={`map-marker marker-mcu ${dragging === 'mcu' ? 'dragging' : ''} ${selected === 'mcu' ? 'selected' : ''} ${editMode ? 'editable' : ''}`}
          style={{ left: `${mcuPos.x}%`, top: `${mcuPos.y}%` }}
          onMouseDown={(e) => editMode && editorTool === 'select' && handleMouseDown(e, 'mcu')}
        >
          <span className="marker-pin marker-pin-mcu"><Cpu size={14} /></span>
          <div className="marker-label">
            <strong>ESP32-S3</strong>
            <span>Microcontrolador</span>
          </div>
        </div>
        {zones.map((zone) => {
          const status = sensorStatus(zone);
          const vx = zone.x + 5;
          const vy = zone.y;
          const sx = zone.x - 5;
          const sy = zone.y;
          const isSel = selected === zone.id;
          return (
            <div key={zone.id} className="map-zone-group">
              <div
                className={`map-marker marker-valve ${zone.on ? 'valve-open' : ''} ${dragging === zone.id ? 'dragging' : ''} ${isSel ? 'selected' : ''} ${editMode ? 'editable' : ''}`}
                style={{ left: `${vx}%`, top: `${vy}%`, '--pin-scale': getZoneScale(zone.id) } as React.CSSProperties}
                onMouseDown={(e) => editMode && editorTool === 'select' && handleMouseDown(e, zone.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(zone.id);
                  setSelectedPart('valve');
                  if (editMode && editorTool === 'duplicate') {
                    onDuplicateZone(zone);
                  }
                }}
              >
                <span className="marker-pin marker-pin-valve">{zone.id}</span>
                <div className="marker-label">
                  <strong>Válvula {zone.id}</strong>
                  <span>{zone.on ? 'Aberta' : 'Fechada'}</span>
                </div>
              </div>
              <div
                className={`map-marker marker-sensor marker-${status} ${dragging === zone.id ? 'dragging' : ''} ${isSel ? 'selected' : ''} ${editMode ? 'editable' : ''}`}
                style={{ left: `${sx}%`, top: `${sy}%`, '--pin-scale': getZoneScale(zone.id) } as React.CSSProperties}
                onMouseDown={(e) => editMode && editorTool === 'select' && handleMouseDown(e, zone.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelected(zone.id);
                  setSelectedPart('sensor');
                  if (editMode && editorTool === 'duplicate') {
                    onDuplicateZone(zone);
                  }
                }}
              >
                <span className="marker-pin">{zone.sensorId}</span>
                <div className="marker-label">
                  {editingName === zone.id ? (
                    <input
                      className="marker-name-input"
                      value={editNameValue}
                      onChange={(e) => setEditNameValue(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => { if (e.key === 'Enter') submitNameEdit(); if (e.key === 'Escape') { setEditingName(null); setEditNameValue(''); } }}
                      onBlur={submitNameEdit}
                      autoFocus
                    />
                  ) : (
                    <>
                      <strong>
                        {zone.name}
                        {editMode && <button className="marker-edit-btn" onMouseDown={(e) => e.stopPropagation()} onClick={(e) => startEditName(e, zone)} aria-label="Editar nome"><PencilLine size={11} /></button>}
                      </strong>
                      <span>{status === 'ok' ? 'Normal' : 'Atenção'} · {zone.moisture}%</span>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {selectedZone && (
        <div className="map-selection-bar">
          <div className="map-sel-info">
            <span className={`map-sel-pin ${selectedPart === 'valve' ? 'pin-valve' : 'pin-sensor'}`}>{selectedPart === 'valve' ? selectedZone.id : selectedZone.sensorId}</span>
            <div>
              <strong>{selectedZone.name}</strong>
              <span>
                {selectedPart === 'valve'
                  ? `Válvula ${selectedZone.id} · ${selectedZone.on ? 'Aberta' : 'Fechada'}`
                  : `Sensor ${selectedZone.sensorId} · Humidade ${selectedZone.moisture}%`}
              </span>
            </div>
          </div>
          <div className="map-sel-gpio">
            {selectedPart === 'valve'
              ? <span className="gpio-chip"><CircuitBoard size={13} /> Comutação por relés do sistema</span>
              : (SENSOR_GPIO_MAP[selectedZone.sensorId]
                ? <span className="gpio-chip"><CircuitBoard size={13} /> GPIO {SENSOR_GPIO_MAP[selectedZone.sensorId]} · INPUT</span>
                : <span className="gpio-chip gpio-unassigned"><CircuitBoard size={13} /> Sem GPIO atribuído</span>)}
          </div>
          <button className={`map-sel-btn ${selectedZone.on ? 'valve-open-btn' : 'valve-closed-btn'}`} onClick={() => onToggleZone(selectedZone.id)}>
            <Zap size={14} />{selectedZone.on ? 'Fechar válvula' : 'Abrir válvula'}
          </button>
          {editMode && (
            <>
              <div className="map-sel-size">
                <span>Tamanho</span>
                <button className="map-sel-size-btn" onClick={() => adjustZoneScale(selectedZone.id, -ZONE_SCALE_STEP)} disabled={getZoneScale(selectedZone.id) <= MIN_ZONE_SCALE} aria-label="Diminuir tamanho"><Minus size={13} /></button>
                <span className="map-sel-size-value">{Math.round(getZoneScale(selectedZone.id) * 100)}%</span>
                <button className="map-sel-size-btn" onClick={() => adjustZoneScale(selectedZone.id, ZONE_SCALE_STEP)} disabled={getZoneScale(selectedZone.id) >= MAX_ZONE_SCALE} aria-label="Aumentar tamanho"><Plus size={13} /></button>
              </div>
              <div className="map-sel-actions">
                <button className="map-sel-btn" onClick={() => { setEditingName(selectedZone.id); setEditNameValue(selectedZone.name); }}><PencilLine size={14} />Renomear</button>
                <button className="map-sel-btn" onClick={() => { onDuplicateZone(selectedZone); }}><Copy size={14} />Duplicar</button>
                <button className="map-sel-btn map-sel-delete" onClick={() => { onRemoveZone(selectedZone); setSelected(null); setSelectedPart(null); }}><Trash2 size={14} />Apagar</button>
              </div>
            </>
          )}
          {!editMode && (
            <div className="map-sel-actions">
              <button className="map-sel-btn" onClick={() => setSelectedPart(selectedPart === 'valve' ? 'sensor' : 'valve')}>
                <MapPin size={14} />Ver {selectedPart === 'valve' ? 'sensor' : 'válvula'}
              </button>
            </div>
          )}
        </div>
      )}

      {showPinout && (
        <div className="pinout-panel">
          <div className="pinout-header">
            <div><span className="section-kicker">HARDWARE</span><h3>ESP32-S3 · Mapa de pinos GPIO</h3></div>
            <button className="pinout-close" onClick={() => setShowPinout(false)} aria-label="Fechar"><X size={16} /></button>
          </div>
          <div className="pinout-grid">
            <div className="pinout-section">
              <div className="pinout-section-title"><Radio size={14} /> Sensores (INPUT)</div>
              {zones.map((z) => (
                <div key={z.sensorId} className="pinout-row">
                  <span className="pinout-pin">GPIO {SENSOR_GPIO_MAP[z.sensorId] ?? '—'}</span>
                  <span className="pinout-label">{z.sensorId}</span>
                  <span className="pinout-desc">{z.name}</span>
                </div>
              ))}
            </div>
            <div className="pinout-section">
              <div className="pinout-section-title"><Droplets size={14} /> Sensores (INPUT)</div>
              {zones.map((z) => (
                <div key={z.sensorId} className="pinout-row">
                  <span className="pinout-pin">GPIO {SENSOR_GPIO_MAP[z.sensorId] ?? '—'}</span>
                  <span className="pinout-label">{z.sensorId}</span>
                  <span className="pinout-desc">{z.name} · Humidade {z.moisture}%</span>
                </div>
              ))}
            </div>
            <div className="pinout-section">
              <div className="pinout-section-title"><Cpu size={14} /> Relés do sistema (OUTPUT)</div>
              {SYSTEM_RELAYS.map((r) => (
                <div key={r.relay} className="pinout-row">
                  <span className="pinout-pin">GPIO {r.gpio}</span>
                  <span className="pinout-label">{r.relay} · {r.inChannel}</span>
                  <span className="pinout-desc">{r.func}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {editingName && (
        <TextKeyboard
          value={editNameValue}
          onChange={setEditNameValue}
          onSubmit={submitNameEdit}
          onClose={() => { setEditingName(null); setEditNameValue(''); }}
        />
      )}
      {fieldNameEdit && (
        <TextKeyboard
          value={fieldNameValue}
          onChange={setFieldNameValue}
          onSubmit={submitFieldName}
          onClose={() => { setFieldNameEdit(null); setFieldNameValue(''); }}
        />
      )}
      {confirmClearAll && (
        <div className="modal-overlay" onClick={() => setConfirmClearAll(false)}>
          <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-modal-icon"><Eraser size={32} /></div>
            <h3>Apagar todos os elementos?</h3>
            <p>Esta ação remove <strong>todos os sensores e terrenos</strong> do mapa. Não pode ser desfeita.</p>
            <div className="confirm-modal-actions">
              <button className="kb-clear" onClick={() => setConfirmClearAll(false)}>Cancelar</button>
              <button className="confirm-delete-btn" onClick={handleClearAll}><Trash2 size={15} />Apagar tudo</button>
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

/* ---------- Confirm delete modal ---------- */
function ConfirmDeleteModal({ zone, onCancel, onConfirm }: { zone: Zone; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-modal-icon"><Leaf size={32} /></div>
        <h3>Remover sensor {zone.sensorId}?</h3>
        <p>Tem a certeza que pretende remover o sensor <strong>{zone.name}</strong> ({zone.sensorId})? Esta ação não pode ser desfeita.</p>
        <div className="confirm-modal-actions">
          <button className="kb-clear" onClick={onCancel}>Cancelar</button>
          <button className="confirm-delete-btn" onClick={onConfirm}><Trash2 size={15} />Remover</button>
        </div>
      </div>
    </div>
  );
}

/* Fecha qualquer teclado virtual com a tecla Escape (funciona em conjunto com o teclado físico) */
function useCloseOnEscape(onClose: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);
}

/* Evita que clicar numa tecla virtual roube o foco a um input real, para que o teclado físico continue disponível */
const preventFocusSteal = (e: React.MouseEvent) => e.preventDefault();

function NumericKeyboard({ value, onChange, onSubmit, onClose }: { value: string; onChange: (v: string) => void; onSubmit: () => void; onClose: () => void }) {
  useCloseOnEscape(onClose);
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '00'];

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) onChange(value + e.key);
      else if (e.key === 'Backspace') onChange(value.slice(0, -1));
      else if (e.key === 'Enter') onSubmit();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="keyboard-overlay" onClick={onClose}>
      <div className="keyboard" onClick={(e) => e.stopPropagation()}>
        <div className="keyboard-header">
          <span>Inserir valor (segundos)</span>
          <button onClick={onClose} aria-label="Fechar teclado"><X size={18} /></button>
        </div>
        <div className="keyboard-display">{value || '0'}<span>s</span></div>
        <div className="keyboard-hint">Também pode escrever com o teclado físico</div>
        <div className="keyboard-keys">
          {keys.map((k) => (
            <button key={k} className="kb-key" onMouseDown={preventFocusSteal} onClick={() => onChange(value + k)}>{k}</button>
          ))}
          <button className="kb-key kb-backspace" onMouseDown={preventFocusSteal} onClick={() => onChange(value.slice(0, -1))} aria-label="Apagar"><Delete size={18} /></button>
        </div>
        <div className="keyboard-actions">
          <button className="kb-clear" onClick={() => onChange('')}>Limpar</button>
          <button className="kb-confirm" onClick={onSubmit}>Confirmar</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Full Keyboard (numbers, letters, accents) ---------- */
const KB_NUMS = ['1','2','3','4','5','6','7','8','9','0'];
const KB_ROWS = [
  ['Q','W','E','R','T','Y','U','I','O','P'],
  ['A','S','D','F','G','H','J','K','L','Ç'],
  ['@','Z','X','C','V','B','N','M','.','-'],
];
const KB_ACCENTS = ['á','à','ã','â','é','ê','í','ó','õ','ô','ú','ü'];

function FullKeyboard({ value, onChange, onSubmit, onClose, title, language, hint }: { value: string; onChange: (v: string) => void; onSubmit: () => void; onClose: () => void; title?: string; language?: Language; hint?: string }) {
  const [showAccents, setShowAccents] = useState(false);
  useCloseOnEscape(onClose);
  return (
    <div className="keyboard-overlay" onClick={onClose}>
      <div className="keyboard full-keyboard" onClick={(e) => e.stopPropagation()}>
        <div className="keyboard-header">
          <span>{title || 'Editar texto'}</span>
          <button onClick={onClose} aria-label="Fechar"><X size={18} /></button>
        </div>
        <div className="keyboard-display text-display">{value || ' '}</div>
        {hint && <div className="keyboard-hint">{hint}</div>}
        <div className="text-kb-nums">{KB_NUMS.map(n => <button key={n} className="kb-key kb-key-sm" onMouseDown={preventFocusSteal} onClick={() => onChange(value + n)}>{n}</button>)}</div>
        <div className="text-kb-rows">{KB_ROWS.map((row, i) => <div key={i} className="text-kb-row">{row.map(k => <button key={k} className="kb-key kb-key-sm" onMouseDown={preventFocusSteal} onClick={() => onChange(value + k)}>{k}</button>)}</div>)}</div>
        <div className="text-kb-actions">
          <button className="kb-key kb-key-sm kb-accent-toggle" onMouseDown={preventFocusSteal} onClick={() => setShowAccents(!showAccents)}>{showAccents ? 'ABC' : 'áéí'}</button>
          <button className="kb-key kb-key-sm kb-space" onMouseDown={preventFocusSteal} onClick={() => onChange(value + ' ')}>{language === 'PT' ? 'Espaço' : 'Space'}</button>
          <button className="kb-key kb-key-sm kb-backspace" onMouseDown={preventFocusSteal} onClick={() => onChange(value.slice(0, -1))}><Delete size={16} /></button>
        </div>
        {showAccents && <div className="text-kb-nums text-kb-accents">{KB_ACCENTS.map(a => <button key={a} className="kb-key kb-key-sm kb-accent" onMouseDown={preventFocusSteal} onClick={() => { onChange(value + a); setShowAccents(false); }}>{a}</button>)}</div>}
        <div className="keyboard-actions">
          <button className="kb-clear" onClick={onClose}>{language === 'PT' ? 'Cancelar' : 'Cancel'}</button>
          <button className="kb-confirm" onClick={onSubmit}>{language === 'PT' ? 'Confirmar' : 'Confirm'}</button>
        </div>
      </div>
    </div>
  );
}

function TextKeyboard({ value, onChange, onSubmit, onClose }: { value: string; onChange: (v: string) => void; onSubmit: () => void; onClose: () => void }) {
  return <FullKeyboard value={value} onChange={onChange} onSubmit={onSubmit} onClose={onClose} title="Editar nome do local" language="PT" />;
}

/* ---------- Settings panel ---------- */
function SettingsPanel({ language, setLanguage, username, setUsername, password, setPassword, saved, onSave, onClose, onLogout, authenticated }: {
  language: Language;
  setLanguage: (l: Language) => void;
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  saved: boolean;
  onSave: () => void;
  onClose: () => void;
  onLogout: () => void;
  authenticated: boolean;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <aside className="settings-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <div><span className="section-kicker">{t('settings.kicker', language)}</span><h3>{t('settings.title', language)}</h3></div>
          <button className="drawer-close" onClick={onClose} aria-label={t('settings.close', language)}><X size={19} /></button>
        </div>
        <div className="settings-section">
          <div className="settings-label"><Globe2 size={18} /><div><strong>{t('settings.language', language)}</strong><span>{t('settings.languageDesc', language)}</span></div></div>
          <div className="language-toggle">
            <button className={language === 'PT' ? 'selected' : ''} onClick={() => setLanguage('PT')}>Português</button>
            <button className={language === 'EN' ? 'selected' : ''} onClick={() => setLanguage('EN')}>English</button>
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-label"><UserRound size={18} /><div><strong>{t('settings.account', language)}</strong><span>{t('settings.accountDesc', language)}</span></div></div>
          <label className="field-label">{t('settings.username', language)}<input value={username} onChange={(e) => setUsername(e.target.value)} /></label>
          <label className="field-label">{t('settings.password', language)}<input type="password" placeholder={t('settings.passwordPlaceholder', language)} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <div className="security-note"><LockKeyhole size={15} /> {t('settings.securityNote', language)}</div>
        </div>
        {authenticated && (
          <div className="settings-section">
            <div className="settings-label"><LockKeyhole size={18} /><div><strong>{t('settings.logout', language)}</strong><span>{t('settings.logoutDesc', language)}</span></div></div>
            <button className="logout-btn" onClick={onLogout}>{t('settings.logoutBtn', language)}</button>
          </div>
        )}
        <div className="drawer-footer">
          <button className={`save-btn ${saved ? 'saved' : ''}`} onClick={onSave}><Save size={17} /> {saved ? t('general.saved', language) : t('general.save', language)}</button>
        </div>
      </aside>
    </div>
  );
}

/* ---------- Histórico de Erros + Eventos Reais ---------- */
function HistoryView({ errors, eventLog, eventLogLoading, onRefresh, language }: { errors: ErrorEvent[]; eventLog: EventLogEntry[]; eventLogLoading: boolean; onRefresh: () => void; language: Language }) {
  // Mostrar TODOS os eventos reais, agrupados por severidade para destaque
  const allEvents = [...eventLog].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const irrigationEvents = allEvents.filter((e) =>
    ['zone_toggle', 'system_start', 'system_stop', 'system_reset', 'emergency_stop', 'test_cycle', 'mode_change', 'pump_toggle',
     'device_connected', 'device_disconnected', 'device_reconnected', 'device_offline',
     'sensor_stale', 'sensor_recovered', 'schedule_trigger', 'cycle_complete',
     'watchdog_triggered', 'zone_add', 'zone_remove', 'zone_rename', 'layout_save', 'cycle_continue'].includes(e.event_type)
  );
  return (
    <div className="two-column">
      <Panel className="chart-panel">
        <PanelHeader eyebrow={language === 'PT' ? 'ÚLTIMAS 24 HORAS' : 'LAST 24 HOURS'} title={language === 'PT' ? 'Eventos por tipo' : 'Events by type'} />
        <div className="history-stats-grid">
          {(() => {
            const criticalCount = allEvents.filter(e => e.severity === 'critical').length;
            const warningCount = allEvents.filter(e => e.severity === 'warning').length;
            const infoCount = allEvents.filter(e => e.severity === 'info').length;
            const total = allEvents.length || 1;
            return (
              <>
                <div className="history-stat-card stat-critical">
                  <div className="history-stat-icon"><AlertTriangle size={20} /></div>
                  <div>
                    <strong>{criticalCount}</strong>
                    <span>{language === 'PT' ? 'Críticos' : 'Critical'}</span>
                    <div className="history-stat-bar"><div style={{width: `${(criticalCount/total)*100}%`}} /></div>
                  </div>
                </div>
                <div className="history-stat-card stat-warning">
                  <div className="history-stat-icon"><AlertTriangle size={20} /></div>
                  <div>
                    <strong>{warningCount}</strong>
                    <span>{language === 'PT' ? 'Avisos' : 'Warnings'}</span>
                    <div className="history-stat-bar"><div style={{width: `${(warningCount/total)*100}%`}} /></div>
                  </div>
                </div>
                <div className="history-stat-card stat-info">
                  <div className="history-stat-icon"><Activity size={20} /></div>
                  <div>
                    <strong>{infoCount}</strong>
                    <span>{language === 'PT' ? 'Informação' : 'Info'}</span>
                    <div className="history-stat-bar"><div style={{width: `${(infoCount/total)*100}%`}} /></div>
                  </div>
                </div>
              </>
            );
          })()}
        </div>
        <div className="history-total-row">
          <span>{language === 'PT' ? 'Total de eventos' : 'Total events'}: <b>{allEvents.length}</b></span>
          <span>{language === 'PT' ? 'Eventos do backend em tempo real' : 'Real-time backend events'}</span>
        </div>
      </Panel>
      <Panel>
        <div className="panel-heading">
          <div><span className="section-kicker">{language === 'PT' ? 'REGISTO DE ATIVIDADE' : 'ACTIVITY LOG'}</span><h3>{language === 'PT' ? 'Todos os eventos do sistema' : 'All system events'}</h3></div>
          <button className="refresh-btn" onClick={onRefresh} aria-label="Atualizar"><RotateCcw size={16} /></button>
        </div>
        <div className="history-list">
          {eventLogLoading && <div className="empty-state"><Activity size={28} /><span>A carregar eventos…</span></div>}
          {!eventLogLoading && irrigationEvents.length === 0 && <div className="empty-state"><CheckCircle2 size={28} /><span>Nenhum evento registado</span></div>}
          {!eventLogLoading && irrigationEvents.map((ev) => {
            return <HistoryItem key={ev.id} event={ev} language={language} />;
          })}
        </div>
      </Panel>
      <Panel className="error-history-panel">
        <PanelHeader eyebrow={language === 'PT' ? 'DIAGNÓSTICO' : 'DIAGNOSTICS'} title={language === 'PT' ? 'Eventos de diagnóstico' : 'Diagnostic events'} />
        <div className="error-list">
          {(() => {
            const diagEvents = allEvents.filter(e => e.severity === 'warning' || e.severity === 'critical');
            if (diagEvents.length === 0) {
              return <div className="empty-state"><CheckCircle2 size={28} /><span>{language === 'PT' ? 'Nenhum evento de diagnóstico' : 'No diagnostic events'}</span></div>;
            }
            return diagEvents.map((ev) => <ErrorItem key={ev.id} event={{
              id: ev.id,
              time: formatDateTime(ev.created_at),
              source: ev.source,
              message: ev.message,
              severity: ev.severity as 'critical' | 'warning' | 'info',
              resolved: false,
            }} />);
          })()}
        </div>
      </Panel>
    </div>
  );
}

function HistoryItem({ event, language }: { event: EventLogEntry; language: Language }) {
  const time = formatDateTime(event.created_at);
  const severityIcon = event.severity === 'critical' ? <AlertTriangle size={15} /> : event.severity === 'warning' ? <AlertTriangle size={15} /> : <Activity size={15} />;
  const severityClass = event.severity === 'critical' ? 'history-critical' : event.severity === 'warning' ? 'history-warning' : '';
  const eventLabel: Record<string, string> = {
    zone_toggle: language === 'PT' ? 'Válvula' : 'Valve',
    pump_toggle: language === 'PT' ? 'Bomba' : 'Pump',
    system_start: language === 'PT' ? 'Start' : 'Start',
    system_stop: language === 'PT' ? 'Stop' : 'Stop',
    system_reset: language === 'PT' ? 'Reset' : 'Reset',
    emergency_stop: language === 'PT' ? 'Emergência' : 'Emergency',
    test_cycle: language === 'PT' ? 'Teste' : 'Test',
    mode_change: language === 'PT' ? 'Modo' : 'Mode',
    device_connected: language === 'PT' ? 'ESP32' : 'ESP32',
    device_disconnected: language === 'PT' ? 'ESP32' : 'ESP32',
    device_reconnected: language === 'PT' ? 'ESP32' : 'ESP32',
    device_offline: language === 'PT' ? 'ESP32' : 'ESP32',
    sensor_stale: language === 'PT' ? 'Sensor' : 'Sensor',
    sensor_recovered: language === 'PT' ? 'Sensor' : 'Sensor',
    schedule_trigger: language === 'PT' ? 'Horário' : 'Schedule',
    cycle_complete: language === 'PT' ? 'Ciclo' : 'Cycle',
    cycle_continue: language === 'PT' ? 'Ciclo' : 'Cycle',
    watchdog_triggered: language === 'PT' ? 'Watchdog' : 'Watchdog',
    zone_add: language === 'PT' ? 'Zona' : 'Zone',
    zone_remove: language === 'PT' ? 'Zona' : 'Zone',
    zone_rename: language === 'PT' ? 'Zona' : 'Zone',
    layout_save: language === 'PT' ? 'Mapa' : 'Map',
  };
  return (
    <div className={`history-item ${severityClass}`}>
      <span className={`history-icon hist-${event.severity}`}>{severityIcon}</span>
      <div className="history-body">
        <div className="history-top-row">
          <strong>{event.source}</strong>
          <small>{time}</small>
        </div>
        <span className="history-msg">{event.message}</span>
        <div className="history-meta">
          <span className="history-tag">{eventLabel[event.event_type] || event.event_type}</span>
          <span className={`history-severity hist-sev-${event.severity}`}>{event.severity.toUpperCase()}</span>
        </div>
      </div>
    </div>
  );
}

function ErrorItem({ event }: { event: ErrorEvent }) {
  const tone = event.severity === 'critical' ? 'error' : event.severity === 'warning' ? 'warning' : 'neutral';
  return (
    <div className={`error-item ${event.resolved ? 'resolved' : ''}`}>
      <span className={`error-icon error-${event.severity}`}>
        {event.severity === 'critical' ? <AlertTriangle size={16} /> : event.severity === 'warning' ? <AlertTriangle size={16} /> : <Activity size={16} />}
      </span>
      <div className="error-body">
        <div className="error-top"><strong>{event.source}</strong><span className="error-id">{event.id}</span></div>
        <span className="error-msg">{event.message}</span>
        <div className="error-meta"><small>{event.time}</small><StatusBadge tone={event.resolved ? 'success' : tone}>{event.resolved ? 'Resolvido' : 'Ativo'}</StatusBadge></div>
      </div>
    </div>
  );
}

/* ---------- Comandos com Start/Stop/Reset ---------- */
function CommandsView({ zones, pumpOn, systemRunning, starting, startStep, autoMode, onToggleZone, onTogglePump, onToggleMode, onEmergencyStop, onTestCycle, onStart, onStop, onReset, language }: {
  zones: Zone[];
  pumpOn: boolean;
  systemRunning: boolean;
  starting: boolean;
  startStep: string;
  autoMode: boolean;
  onToggleZone: (id: string) => void;
  onTogglePump: () => void;
  onToggleMode: () => void;
  onEmergencyStop: () => void;
  onTestCycle: () => void;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  language: Language;
}) {
  return (
    <div className="commands-layout">
      <Panel>
        <PanelHeader eyebrow="CONTROLO DO SISTEMA" title="Comandos principais" />
        <div className="command-actions">
          <button className={`cmd-btn cmd-start ${systemRunning ? 'active' : ''}`} onClick={onStart} disabled={starting}>
            <Play size={24} />
            <span><strong>Start</strong><small>{starting ? startStep : 'Inicia o sistema de rega'}</small></span>
          </button>
          <button className="cmd-btn cmd-stop" onClick={onStop}>
            <Square size={24} />
            <span><strong>Stop</strong><small>Para todos os atuadores</small></span>
          </button>
          <button className="cmd-btn cmd-reset" onClick={onReset}>
            <RotateCcw size={24} />
            <span><strong>Reset</strong><small>Reinicia o sistema</small></span>
          </button>
        </div>
        <div className="mode-toggle-wrapper">
          <span className="section-kicker">MODO DE OPERAÇÃO</span>
          <button className={`mode-toggle-btn ${autoMode ? 'mode-auto' : 'mode-manual'}`} onClick={onToggleMode}>
            <Settings2 size={15} />{autoMode ? 'Automático' : 'Manual'}<span className="mode-pulse" />
          </button>
        </div>
      </Panel>
      <Panel>
        <PanelHeader eyebrow="CONTROLO MANUAL" title="Atuadores" />
        <div className="command-list">
          <CommandRow icon={<Waves />} label="Bomba principal" description="Relé K1" on={pumpOn} onToggle={onTogglePump} />
          {zones.map((z) => <CommandRow key={z.id} icon={<Droplets />} label={`${z.name} · Válvula ${z.id}`} description="Válvula solenóide" on={z.on} onToggle={() => onToggleZone(z.id)} />)}
        </div>
      </Panel>
      <Panel>
        <PanelHeader eyebrow="AÇÃO RÁPIDA" title="Rotinas do sistema" />
        <button className="action-button" onClick={onTestCycle}><PlayCircle size={20} /><span><strong>Executar ciclo de teste</strong><small>Verifica bomba e válvulas durante 30 segundos</small></span><ChevronRight size={17} /></button>
        <button className="action-button action-emergency" onClick={onEmergencyStop}><Power size={20} /><span><strong>Paragem de emergência</strong><small>Desliga todos os atuadores ativos</small></span><ChevronRight size={17} /></button>
      </Panel>
    </div>
  );
}

function CommandRow({ icon, label, description, on, onToggle }: { icon: React.ReactNode; label: string; description: string; on: boolean; onToggle: () => void }) {
  return <div className="command-row"><span className="command-icon">{icon}</span><div><strong>{label}</strong><span>{description}</span></div><button className={`switch ${on ? 'switch-on' : ''}`} onClick={onToggle} aria-label={`Alternar ${label}`}><span /></button></div>;
}

/* ---------- Alarmes refinados ---------- */
function AlarmsView({ errors, onResolve, language }: { errors: ErrorEvent[]; onResolve: (id: string) => void; language: Language }) {
  const active = errors.filter((e) => !e.resolved);
  const resolved = errors.filter((e) => e.resolved);
  const critical = active.filter((e) => e.severity === 'critical').length;
  const warnings = active.filter((e) => e.severity === 'warning').length;
  const infos = active.filter((e) => e.severity === 'info').length;

  return (
    <div className="alarms-layout">
      <div className="alarm-summary-grid">
        <Panel className={`alarm-summary-card ${critical > 0 ? 'card-error' : 'card-ok'}`}>
          <div className="alarm-summary-icon"><AlertTriangle size={24} /></div>
          <div><strong>{critical}</strong><span>{language === 'PT' ? 'Críticos' : 'Critical'}</span></div>
        </Panel>
        <Panel className={`alarm-summary-card ${warnings > 0 ? 'card-warning' : 'card-ok'}`}>
          <div className="alarm-summary-icon"><AlertTriangle size={24} /></div>
          <div><strong>{warnings}</strong><span>{language === 'PT' ? 'Avisos' : 'Warnings'}</span></div>
        </Panel>
        <Panel className="alarm-summary-card card-ok">
          <div className="alarm-summary-icon"><Activity size={24} /></div>
          <div><strong>{active.length}</strong><span>{language === 'PT' ? 'Ativos' : 'Active'}</span></div>
        </Panel>
        <Panel className="alarm-summary-card card-ok">
          <div className="alarm-summary-icon"><CheckCircle2 size={24} /></div>
          <div><strong>{resolved.length}</strong><span>{language === 'PT' ? 'Resolvidos' : 'Resolved'}</span></div>
        </Panel>
      </div>

      {active.length > 0 ? (
        <Panel className="alarm-banner">
          <div className="alarm-banner-icon"><AlertTriangle size={22} /></div>
          <div>
            <span className="section-kicker">{language === 'PT' ? 'ALARMES ATIVOS' : 'ACTIVE ALARMS'}</span>
            <h3>{active.length} {language === 'PT' ? 'evento(s) requer(em) atenção' : 'event(s) require attention'}</h3>
            <p>{language === 'PT' ? 'Existem alarmes ativos que devem ser verificados.' : 'There are active alarms that should be checked.'}</p>
          </div>
          <StatusBadge tone="error">{language === 'PT' ? 'Atenção' : 'Attention'}</StatusBadge>
        </Panel>
      ) : (
        <Panel className="alarm-banner alarm-banner-ok">
          <div className="alarm-banner-icon ok"><CheckCircle2 size={22} /></div>
          <div>
            <span className="section-kicker">{language === 'PT' ? 'ESTADO DOS ALARMES' : 'ALARM STATUS'}</span>
            <h3>{language === 'PT' ? 'Sem alarmes ativos' : 'No active alarms'}</h3>
            <p>{language === 'PT' ? 'Não existem falhas que impeçam o funcionamento do sistema.' : 'There are no faults preventing system operation.'}</p>
          </div>
          <StatusBadge tone="success">{language === 'PT' ? 'Tudo OK' : 'All OK'}</StatusBadge>
        </Panel>
      )}

      <Panel>
        <PanelHeader eyebrow={language === 'PT' ? 'ALARMES ATIVOS' : 'ACTIVE ALARMS'} title={language === 'PT' ? 'Requerem atenção' : 'Require attention'} />
        <div className="alarm-list">
          {active.length === 0 && <div className="empty-state"><CheckCircle2 size={28} /><span>{language === 'PT' ? 'Nenhum alarme ativo' : 'No active alarms'}</span></div>}
          {active.map((ev) => (
            <AlarmItem key={ev.id} event={ev} onResolve={() => onResolve(ev.id)} language={language} />
          ))}
        </div>
      </Panel>

      {resolved.length > 0 && (
        <Panel>
          <PanelHeader eyebrow={language === 'PT' ? 'HISTÓRICO' : 'HISTORY'} title={language === 'PT' ? 'Alarmes resolvidos' : 'Resolved alarms'} />
          <div className="alarm-list">
            {resolved.map((ev) => <AlarmItem key={ev.id} event={ev} language={language} />)}
          </div>
        </Panel>
      )}
    </div>
  );
}

function AlarmItem({ event, onResolve, language }: { event: ErrorEvent; onResolve?: () => void; language?: Language }) {
  const isCritical = event.severity === 'critical';
  const isWarning = event.severity === 'warning';
  return (
    <div className={`alarm-item alarm-${event.severity}`}>
      <span className={`alarm-item-icon alarm-icon-${event.severity}`}>
        {event.severity === 'info' ? <Activity size={16} /> : <AlertTriangle size={16} />}
      </span>
      <div className="alarm-item-body">
        <div className="alarm-item-top">
          <strong>{event.source}</strong>
          <span className={`alarm-item-badge alarm-badge-${event.severity}`}>
            {isCritical ? (language === 'PT' ? 'CRÍTICO' : 'CRITICAL') : isWarning ? (language === 'PT' ? 'AVISO' : 'WARNING') : 'INFO'}
          </span>
        </div>
        <span className="alarm-item-msg">{event.message}</span>
        <div className="alarm-meta"><small>{event.time}</small><span className="alarm-id">{event.id}</span></div>
      </div>
      {!event.resolved && onResolve ? (
        <button className="resolve-btn" onClick={onResolve}><CheckCircle2 size={15} />{language === 'PT' ? 'Resolver' : 'Resolve'}</button>
      ) : event.resolved ? (
        <StatusBadge tone="success">{language === 'PT' ? 'Resolvido' : 'Resolved'}</StatusBadge>
      ) : null}
    </div>
  );
}

/* ---------- Login Screen (full-screen, user + password) ---------- */
function LoginScreen({ language, onSubmit }: { language: Language; onSubmit: (user: string, pass: string) => void }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [keyboardTarget, setKeyboardTarget] = useState<'user' | 'pass' | null>(null);
  const userInputRef = useRef<HTMLInputElement>(null);
  const passInputRef = useRef<HTMLInputElement>(null);

  const openKeyboardFor = (t: 'user' | 'pass') => {
    setKeyboardTarget((prev) => (prev === t ? null : t));
    // Mantém o foco no campo real para que o teclado físico continue a funcionar em simultâneo
    requestAnimationFrame(() => (t === 'user' ? userInputRef : passInputRef).current?.focus());
  };

  // O teclado virtual escreve diretamente no mesmo estado do campo (user/pass),
  // por isso fica sempre sincronizado com o que for digitado no teclado físico.
  const keyboardValue = keyboardTarget === 'user' ? user : keyboardTarget === 'pass' ? pass : '';
  const handleKeyboardChange = (v: string) => {
    if (keyboardTarget === 'user') setUser(v);
    else if (keyboardTarget === 'pass') setPass(v);
  };

  const handleSubmit = () => {
    if (user && pass === '1234') {
      onSubmit(user, pass);
      setError(false);
    } else {
      setError(true);
      setPass('');
      setTimeout(() => setError(false), 2000);
    }
  };

  return (
    <div className="login-screen">
      <div className="login-screen-bg" />
      <div className="login-screen-card">
        <div className="login-brand">
          <div className="login-brand-mark"><Leaf size={36} /></div>
          <div className="login-brand-text"><strong>GTC</strong><span>REGA</span></div>
        </div>
        <h2>{t('login.welcome', language)}</h2>
        <p className="login-desc">{t('login.description', language)}</p>
        <div className="login-form">
          <div className={`login-input-group ${keyboardTarget === 'user' ? 'login-input-active' : ''}`}>
            <UserRound size={18} />
            <input
              ref={userInputRef}
              type="text"
              placeholder={t('login.user', language)}
              value={user}
              onChange={(e) => { setUser(e.target.value); setError(false); }}
              autoComplete="username"
            />
            <button
              type="button"
              className={`login-kb-toggle ${keyboardTarget === 'user' ? 'active' : ''}`}
              onClick={() => openKeyboardFor('user')}
              aria-label={language === 'PT' ? 'Abrir teclado virtual' : 'Open virtual keyboard'}
              aria-pressed={keyboardTarget === 'user'}
            >
              <Keyboard size={17} />
            </button>
          </div>
          <div className={`login-input-group ${error ? 'login-input-error' : ''} ${keyboardTarget === 'pass' ? 'login-input-active' : ''}`}>
            <LockKeyhole size={18} />
            <input
              ref={passInputRef}
              type="password"
              placeholder={t('login.password', language)}
              value={pass}
              onChange={(e) => { setPass(e.target.value); setError(false); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); setCapsLock(e.getModifierState('CapsLock')); }}
              onKeyUp={(e) => setCapsLock(e.getModifierState('CapsLock'))}
            />
            <button
              type="button"
              className={`login-kb-toggle ${keyboardTarget === 'pass' ? 'active' : ''}`}
              onClick={() => openKeyboardFor('pass')}
              aria-label={language === 'PT' ? 'Abrir teclado virtual' : 'Open virtual keyboard'}
              aria-pressed={keyboardTarget === 'pass'}
            >
              <Keyboard size={17} />
            </button>
          </div>
          {capsLock && <div className="login-caps-warning">⚠ {t('login.capsLock', language)}</div>}
          {error && <div className="login-message error">{t('login.error', language)}</div>}
          <button className="login-submit-btn" onClick={handleSubmit} disabled={!user || !pass}>
            {t('login.submit', language)}
          </button>
        </div>
        <div className="login-footer">
          <span>ESP32-S3 · v2.15</span>
          <span>© Deogracia de Castro</span>
        </div>
      </div>
      {keyboardTarget && (
        <FullKeyboard value={keyboardValue} onChange={handleKeyboardChange} onSubmit={() => setKeyboardTarget(null)} onClose={() => setKeyboardTarget(null)}
          title={keyboardTarget === 'user' ? (language === 'PT' ? 'Utilizador' : 'Username') : (language === 'PT' ? 'Palavra-passe' : 'Password')}
          hint={language === 'PT' ? 'Também pode escrever com o teclado físico' : 'You can also type using your physical keyboard'}
          language={language} />
      )}
    </div>
  );
}

/* ---------- Time keyboard for schedules ---------- */
function TimeKeyboard({ value, onChange, onSubmit, onClose, preview, language }: { value: string; onChange: (v: string) => void; onSubmit: () => void; onClose: () => void; preview: string; language?: Language }) {
  useCloseOnEscape(onClose);

  const appendDigit = (d: string) => {
    if (!value.includes(':')) {
      const next = value + d;
      if (next.length > 2) return;
      // Insere ":" automaticamente assim que as horas ficam completas (2 dígitos)
      onChange(next.length === 2 ? next + ':' : next);
    } else {
      if (value.length >= 5) return;
      onChange(value + d);
    }
  };
  const appendColon = () => {
    if (value.length > 0 && !value.includes(':')) onChange(value + ':');
  };
  const backspace = () => onChange(value.slice(0, -1));

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) appendDigit(e.key);
      else if (e.key === ':') appendColon();
      else if (e.key === 'Backspace') backspace();
      else if (e.key === 'Enter') onSubmit();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="keyboard-overlay" onClick={onClose}>
      <div className="keyboard full-keyboard" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 320 }}>
        <div className="keyboard-header">
          <span>{language === 'PT' ? 'Inserir hora (HH:MM)' : 'Enter time (HH:MM)'}</span>
          <button onClick={onClose} aria-label="Fechar"><X size={18} /></button>
        </div>
        <div className="keyboard-display">{value || preview || '00:00'}</div>
        <div className="keyboard-hint">{language === 'PT' ? 'Também pode escrever com o teclado físico' : 'You can also type using your physical keyboard'}</div>
        <div className="keyboard-keys">
          {['1','2','3','4','5','6','7','8','9'].map(n => (
            <button key={n} className="kb-key" onMouseDown={preventFocusSteal} onClick={() => appendDigit(n)}>{n}</button>
          ))}
          <button className="kb-key" onMouseDown={preventFocusSteal} onClick={appendColon}>:</button>
          <button className="kb-key" onMouseDown={preventFocusSteal} onClick={() => appendDigit('0')}>0</button>
          <button className="kb-key kb-backspace" onMouseDown={preventFocusSteal} onClick={backspace} aria-label={language === 'PT' ? 'Apagar' : 'Backspace'}><Delete size={18} /></button>
        </div>
        <div className="keyboard-actions">
          <button className="kb-clear" onClick={onClose}>{language === 'PT' ? 'Cancelar' : 'Cancel'}</button>
          <button className="kb-confirm" onClick={onSubmit}>{language === 'PT' ? 'Confirmar' : 'Confirm'}</button>
        </div>
      </div>
    </div>
  );
}

const WEEKDAYS: WeekDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAY_LABELS_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const WEEKDAY_LABELS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ---------- Weekly Schedule Editor V2 (design do card) ---------- */
function ScheduleEditorV2({ zone, onChange, language }: { zone: Zone; onChange: (schedules: Record<WeekDay, WaterSchedule>) => void; language: Language }) {
  const labels = language === 'EN' ? WEEKDAY_LABELS_EN : WEEKDAY_LABELS_PT;
  const [keyboardForTime, setKeyboardForTime] = useState(false);
  const [timeEditing, setTimeEditing] = useState<{ day: WeekDay; hour: number; minute: number }>({ day: 'mon', hour: 6, minute: 0 });
  const [timeStr, setTimeStr] = useState('');
  const [localSchedules, setLocalSchedules] = useState<Record<WeekDay, WaterSchedule> | null>(null);
  const [showCopyMenu, setShowCopyMenu] = useState(false);
  const [copyTargetDay, setCopyTargetDay] = useState<WeekDay | null>(null);

  const schedules = localSchedules || zone.schedules || (() => {
    const defaults: Record<string, WaterSchedule> = {};
    WEEKDAYS.forEach(d => { defaults[d] = { enabled: true, hour: 6, minute: 0 }; });
    return defaults as Record<WeekDay, WaterSchedule>;
  })();

  useEffect(() => { setLocalSchedules(null); }, [zone.id]);

  const updateLocal = (day: WeekDay, patch: Partial<WaterSchedule>) => {
    setLocalSchedules((cur) => ({ ...(cur || { ...zone.schedules }), [day]: { ...(cur || { ...zone.schedules })[day], ...patch } }));
  };

  const toggleDayLocal = (day: WeekDay) => {
    setLocalSchedules((cur) => {
      const base = cur || { ...zone.schedules };
      return { ...base, [day]: { ...base[day], enabled: !base[day].enabled } };
    });
  };

  const copyToAllDays = (sourceDay: WeekDay) => {
    const source = schedules[sourceDay];
    if (!source) return;
    setLocalSchedules((cur) => {
      const base = { ...(cur || { ...zone.schedules }) };
      WEEKDAYS.forEach(d => { base[d] = { ...source }; });
      return base;
    });
    setShowCopyMenu(false);
    setCopyTargetDay(null);
  };

  const clearAllSchedules = () => {
    setLocalSchedules((cur) => {
      const base = { ...(cur || { ...zone.schedules }) };
      WEEKDAYS.forEach(d => { base[d] = { ...base[d], hour: 6, minute: 0 }; });
      return base;
    });
  };

  const hasChanges = localSchedules !== null;

  const formatTime = (h: number, m: number) =>
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  return (
    <div className="schedule-v2">
      <div className="sched2-grid">
        {WEEKDAYS.map((day, i) => {
          const s = schedules[day] || { enabled: true, hour: 6, minute: 0 };
          return (
            <div key={day} className={`sched2-day ${s.enabled ? 'sched2-day-on' : 'sched2-day-off'}`}>
              <div className="sched2-day-top">
                <span className="sched2-day-label">{labels[i]}</span>
                <button
                  className={`sched2-toggle ${s.enabled ? 'on' : 'off'}`}
                  onClick={() => toggleDayLocal(day)}
                  title={s.enabled ? (language === 'PT' ? 'Desativar' : 'Disable') : (language === 'PT' ? 'Ativar' : 'Enable')}
                >
                  <span className="sched2-toggle-dot" />
                </button>
              </div>
              <span className={`sched2-status ${s.enabled ? 'on' : 'off'}`}>
                {s.enabled ? (language === 'PT' ? 'Ativo' : 'Active') : (language === 'PT' ? 'Inativo' : 'Inactive')}
              </span>
              {s.enabled && (
                <button
                  className="sched2-time-btn"
                  onClick={() => {
                    setTimeEditing({ day, hour: s.hour, minute: s.minute });
                    setTimeStr('');
                    setKeyboardForTime(true);
                  }}
                >
                  {formatTime(s.hour, s.minute)}
                </button>
              )}
              <span className="sched2-hint">{language === 'PT' ? 'Início da rega' : 'Watering start'}</span>
            </div>
          );
        })}
      </div>

      {/* Actions row */}
      <div className="sched2-actions">
        {hasChanges && (
          <button className="sched2-action-btn sched2-save" onClick={() => { if (localSchedules) { onChange(localSchedules); setLocalSchedules(null); } }}>
            <Save size={13} /> {language === 'PT' ? 'Guardar' : 'Save'}
          </button>
        )}
        <div className="sched2-copy-wrap">
          <button className="sched2-action-btn" onClick={() => setShowCopyMenu(!showCopyMenu)}>
            <Copy size={13} /> {language === 'PT' ? 'Copiar programação para outros dias' : 'Copy schedule to other days'}
          </button>
          {showCopyMenu && (
            <div className="sched2-copy-menu">
              {WEEKDAYS.map((day, i) => (
                <button key={day} className="sched2-copy-item" onClick={() => copyToAllDays(day)}>
                  {language === 'PT' ? 'Copiar de' : 'Copy from'} {labels[i]}
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="sched2-action-btn sched2-clear" onClick={clearAllSchedules}>
          <Eraser size={13} /> {language === 'PT' ? 'Limpar todos' : 'Clear all'}
        </button>
      </div>

      {keyboardForTime && (
        <TimeKeyboard
          value={timeStr}
          onChange={setTimeStr}
          onSubmit={() => {
            const parts = timeStr.split(':');
            if (parts[0] !== undefined && parts[0] !== '') {
              const h = Math.max(0, Math.min(23, parseInt(parts[0], 10) || 0));
              const m = parts[1] ? Math.max(0, Math.min(59, parseInt(parts[1], 10) || 0)) : 0;
              updateLocal(timeEditing.day, { hour: h, minute: m });
            }
            setKeyboardForTime(false);
            setTimeStr('');
          }}
          onClose={() => { setKeyboardForTime(false); setTimeStr(''); }}
          preview={`${String(timeEditing.hour).padStart(2,'0')}:${String(timeEditing.minute).padStart(2,'0')}`}
          language={language}
        />
      )}
    </div>
  );
}

function ScheduleEditor({ zone, onChange, language }: { zone: Zone; onChange: (schedules: Record<WeekDay, WaterSchedule>) => void; language: Language }) {
  const labels = language === 'EN' ? WEEKDAY_LABELS_EN : WEEKDAY_LABELS_PT;
  const schedules = zone.schedules || (() => { const d: Record<string, WaterSchedule> = {}; WEEKDAYS.forEach(day => { d[day] = { enabled: true, hour: 6, minute: 0 }; }); return d as Record<WeekDay, WaterSchedule>; })();
  const toggleDay = (day: WeekDay) => { const next = { ...zone.schedules }; next[day] = { ...next[day], enabled: !next[day].enabled }; onChange(next); };
  const setTime = (day: WeekDay, hour: number, minute: number) => { const next = { ...zone.schedules }; next[day] = { ...next[day], hour, minute }; onChange(next); };
  const formatTime = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  return (
    <div className="schedule-grid">
      {WEEKDAYS.map((day, i) => { const s = schedules[day] || { enabled: true, hour: 6, minute: 0 };
        return (<div key={day} className={`schedule-day ${s.enabled ? 'schedule-enabled' : ''}`}>
          <button className="schedule-day-toggle" onClick={() => toggleDay(day)}><span className="schedule-day-label">{labels[i]}</span><span className={`schedule-day-status ${s.enabled ? 'on' : 'off'}`} /></button>
          {s.enabled && (<div className="schedule-time-controls"><span className="schedule-time-display">{formatTime(s.hour, s.minute)}</span></div>)}
        </div>);
      })}
    </div>
  );
}

export default App;
