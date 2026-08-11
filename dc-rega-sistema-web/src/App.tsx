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
  Leaf,
  LockKeyhole,
  Map as MapIcon,
  Menu,
  Play,
  PlayCircle,
  Plus,
  Power,
  Radio,
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
  { id: 'Y1', sensorId: 'B1', name: 'Zona 1', moisture: 64, target: 55, lastWatered: 'Hoje, 18:12', on: false, waterDuration: 60, x: 28, y: 36, schedules: defaultSchedules(true) },
  { id: 'Y2', sensorId: 'B2', name: 'Zona 2', moisture: 57, target: 52, lastWatered: 'Hoje, 17:48', on: false, waterDuration: 45, x: 56, y: 62, schedules: defaultSchedules(true) },
];

const initialErrors: ErrorEvent[] = [
  { id: 'E001', time: 'Hoje, 21:12', source: 'Sensor B2', message: 'Leitura recebida dentro do intervalo esperado.', severity: 'info', resolved: true },
  { id: 'E002', time: 'Hoje, 14:03', source: 'Bomba K1', message: 'Sobrecorrente detectada no relé K1 durante o arranque.', severity: 'warning', resolved: true },
  { id: 'E003', time: 'Ontem, 06:30', source: 'Comunicação', message: 'Timeout Modbus no barramento RS485 — sensor B1.', severity: 'critical', resolved: true },
];

const SENSOR_GPIO_MAP: Record<string, number> = { B1: 4, B2: 5 };
// Novo esquema: sensores B1/B2 não têm relés dedicados.
// Os 8 relés (K3–K10) são todos funções do sistema:
// GPIO 6→K3(Timer1), 7→K4(Timer2), 8→K5(START), 9→K6(STOP), 10→K7(AUTO), 11→K8(Reserva), 12→K9, 13→K10
const VALVE_RELAY_MAP: Record<string, { relay: string; gpio: number; inChannel: string }> = {};
const SYSTEM_RELAYS = [
  { relay: 'K3', gpio: 6, inChannel: 'IN1', func: 'Temporizador 1' },
  { relay: 'K4', gpio: 7, inChannel: 'IN2', func: 'Temporizador 2' },
  { relay: 'K5', gpio: 8, inChannel: 'IN3', func: 'START GTC' },
  { relay: 'K6', gpio: 9, inChannel: 'IN4', func: 'STOP / Emergência' },
  { relay: 'K7', gpio: 10, inChannel: 'IN5', func: 'AUTOMÁTICO' },
  { relay: 'K8', gpio: 11, inChannel: 'IN6', func: 'Reserva' },
  { relay: 'K9', gpio: 12, inChannel: 'IN7', func: 'Reserva' },
  { relay: 'K10', gpio: 13, inChannel: 'IN8', func: 'Reserva' },
];

function StatusBadge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'success' | 'warning' | 'error' | 'neutral' | 'cyan' }) {
  return <span className={`status-badge status-${tone}`}><span className="status-dot" />{children}</span>;
}

function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{children}</section>;
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
    });

    return () => {
      unsubState();
      unsubEvent();
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
    const newZone: Zone = { id, sensorId, name: `Zona ${num}`, moisture: 50, target: 50, lastWatered: '—', on: false, waterDuration: 30, x: 30 + Math.random() * 40, y: 30 + Math.random() * 40, schedules: defaultSchedules(true) };
    setZones((cur) => [...cur, newZone]);
    logEvent('zone_add', `${newZone.name} · Sensor ${sensorId}`, `Sensor ${sensorId} e válvula ${id} adicionados`, 'info', { zone_id: id, sensor_id: sensorId });
    showNotice(`Sensor ${sensorId} adicionado`);
    // Sync with backend
    setTimeout(() => {
      const ctrl = getControllerClient();
      ctrl.updateZones([...zones, newZone]);
    }, 100);
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
    const ok = ctrl.start(pumpDelay);
    if (ok) {
      setSystemRunning(true);
      setStarting(true);
      setPumpOn(true);
      setStartStep('A ligar bomba…');
      showNotice('Start enviado ao controlador');
    }
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

  const handleLogin = (pass: string) => {
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

  const saveSettings = () => {
    setSettingsSaved(true);
    showNotice('Definições guardadas');
    window.setTimeout(() => setSettingsSaved(false), 2200);
  };

  const renderPage = () => {
    if (activePage === 'Resumo') {
      return <Overview zones={zones} pumpOn={pumpOn} autoMode={autoMode} activeZones={activeZones} onToggleZone={toggleZone} onTogglePump={togglePump} onToggleMode={toggleAutoMode} onOpenMap={() => requireAuth('Mapa')} weather={weather} language={language} />;
    }
    if (activePage === 'Estado') return <StateView zones={zones} pumpOn={pumpOn} autoMode={autoMode} onToggleMode={toggleAutoMode} language={language} />;
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
            <div className="connection"><Radio size={15} /> {t('heading.connection', language)} <span className="pulse" /></div>
          </div>
          {renderPage()}
          <footer className="app-footer">
            <span>Desenvolvido por <strong>Deogracia de Castro</strong></span>
            <span className="footer-divider">·</span>
            <span>GTC Rega v2.7 · ESP32-S3 · Build 2026-08-14</span>
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
function Overview({ zones, pumpOn, autoMode, activeZones, onToggleZone, onTogglePump, onToggleMode, onOpenMap, weather, language }: { zones: Zone[]; pumpOn: boolean; autoMode: boolean; activeZones: number; onToggleZone: (id: string) => void; onTogglePump: () => void; onToggleMode: () => void; onOpenMap: () => void; weather: { temp: number; desc: string; city: string; country: string; icon: string }; language: Language }) {
  return (
    <div className="content-stack">
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
      <div className="sensor-grid">{zones.map((z) => <SensorCard key={z.id} zone={z} />)}</div>
      <Panel className="metrics-panel">
        <Metric icon={<CalendarDays />} label="Data" value="10/08/2026" />
        <Metric icon={<TimerReset />} label="Hora" value="21:16:43" />
        <Metric icon={<Droplets />} label="Última rega" value={zones[0]?.name ?? '—'} detail={zones[0]?.lastWatered ?? '—'} />
        <Metric icon={<Cpu />} label="Controlador" value="ESP32-S3" detail="Wi-Fi · BLE · RS485" accent />
      </Panel>
      <div className="quick-grid">
        <Panel className="quick-panel">
          <div className="panel-title-row"><div><span className="section-kicker">{t('overview.attentionOps', language)}</span><h3>{t('overview.nextWater', language)}</h3></div><TimerReset size={20} /></div>
          <div className="next-irrigation"><strong>Zona 2</strong><span>{t('overview.scheduled', language)}</span><ChevronRight size={18} /></div>
        </Panel>
        <Panel className="quick-panel alarm-preview">
          <div className="panel-title-row"><div><span className="section-kicker">{t('overview.system', language)}</span><h3>{t('overview.recentAlerts', language)}</h3></div><AlertTriangle size={20} /></div>
          <div className="alert-line"><span className="alert-icon"><AlertTriangle size={15} /></span><div><strong>Sensor B2</strong><span>Leitura dentro do intervalo normal</span></div><small>há 4 min</small></div>
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

function SensorCard({ zone, language }: { zone: Zone; language: Language }) {
  return (
    <Panel className="sensor-card">
      <div className="sensor-header">
        <div><span className="section-kicker">{t('overview.sensor', language)} {zone.sensorId}</span><h3>{zone.name}</h3></div>
        <StatusBadge tone={zone.moisture >= zone.target ? 'success' : 'warning'}>{zone.moisture >= zone.target ? t('overview.normal', language) : t('overview.attention', language)}</StatusBadge>
      </div>
      <div className="sensor-reading">
        <div className="water-icon"><Droplets size={24} /></div>
        <strong>{zone.moisture}<small>%</small></strong>
        <span>{t('overview.moisture', language)}</span>
      </div>
      <div className="meter"><span style={{ width: `${zone.moisture}%` }} /></div>
      <div className="sensor-footer"><span>Setpoint <b>{zone.target}%</b></span><span>Atualizado agora</span></div>
    </Panel>
  );
}

function Metric({ icon, label, value, detail, accent }: { icon: React.ReactNode; label: string; value: string; detail?: string; accent?: boolean }) {
  return <div className="metric"><span className="metric-icon">{icon}</span><div><span className="label">{label}</span><strong className={accent ? 'accent-text' : ''}>{value}</strong>{detail && <small>{detail}</small>}</div></div>;
}

/* ---------- Estado ---------- */
function StateView({ zones, pumpOn, autoMode, onToggleMode, language }: { zones: Zone[]; pumpOn: boolean; autoMode: boolean; onToggleMode: () => void; language: Language }) {
  return (
    <div className="two-column">
      <Panel>
        <PanelHeader eyebrow="LEITURA EM TEMPO REAL" title="Estado dos equipamentos" />
        <div className="state-list">
          <StateRow icon={<Cpu />} title="Controlador central" detail="ESP32-S3 · Wi-Fi · RS485" status="Online" />
          <StateRow icon={<Power />} title="Bomba principal" detail="Relé K1 · Saída digital" status={pumpOn ? 'Ligada' : 'Desligada'} active={pumpOn} />
          {zones.map((z) => <StateRow key={z.id} icon={<Droplets />} title={`${z.name} · Válvula ${z.id}`} detail="Válvula solenóide" status={z.on ? 'Ligada' : 'Desligada'} active={z.on} />)}
          {zones.map((z) => <StateRow key={`s-${z.sensorId}`} icon={<Radio />} title={`${z.name} · Sensor ${z.sensorId}`} detail={`Humidade do solo · ${z.moisture}%`} status="Online" active />)}
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
          <div><span>Última sincronização</span><strong>há 12 segundos</strong></div>
          <div><span>Tempo de atividade</span><strong>14 dias, 08h 32m</strong></div>
          <div><span>Versão do controlador</span><strong>GTC v2.5 · ESP32-S3</strong></div>
          <div><span>Sensores ativos</span><strong>{zones.length} zonas</strong></div>
        </div>
      </Panel>

      {/* ESP32-S3 Pinout Diagram */}
      <Panel className="estado-pinout-panel" style={{ gridColumn: '1 / -1' }}>
        <PanelHeader eyebrow="HARDWARE" title="ESP32-S3 · Mapa de pinos GPIO" />
        <div className="pinout-full-grid">
          {/* Diagrama visual */}
          <div className="pinout-visual">
            <div className="pinout-chip">
              <div className="pinout-chip-header">
                <Cpu size={20} />
                <span>ESP32-S3</span>
              </div>
              <div className="pinout-chip-body">
                <div className="pinout-side pinout-left">
                  <div className="pinout-side-label">INPUT</div>
                  <PinSlot gpio={4} label="B1" func="Sensor B1" direction="INPUT" connected={zones.some(z => z.sensorId === 'B1')} />
                  <PinSlot gpio={5} label="B2" func="Sensor B2" direction="INPUT" connected={zones.some(z => z.sensorId === 'B2')} />
                  {zones.filter(z => !['B1','B2'].includes(z.sensorId)).map((z, i) => (
                    <PinSlot key={z.sensorId} gpio={null} label={z.sensorId} func={z.name} direction="INPUT" connected={true} />
                  ))}
                </div>
                <div className="pinout-side pinout-right">
                  <div className="pinout-side-label">OUTPUT → Módulo 8 Relés</div>
                  {SYSTEM_RELAYS.map((r) => {
                    return <PinSlot key={r.relay} gpio={r.gpio} label={r.relay} func={r.func} direction="OUTPUT" inChannel={r.inChannel} connected={true} />;
                  })}
                </div>
              </div>
            </div>
          </div>
          {/* Tabela de referência */}
          <div className="pinout-table-wrap">
            <table className="pinout-ref-table">
              <thead>
                <tr>
                  <th>GPIO</th>
                  <th>Direção</th>
                  <th>Ligação</th>
                  <th>Função</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                <tr><td><span className="gpio-badge">4</span></td><td><span className="dir-badge dir-in">INPUT</span></td><td>B1</td><td>Sensor B1</td><td>{zones.some(z => z.sensorId === 'B1') ? <StatusBadge tone="success">Ativo</StatusBadge> : <StatusBadge tone="neutral">—</StatusBadge>}</td></tr>
                <tr><td><span className="gpio-badge">5</span></td><td><span className="dir-badge dir-in">INPUT</span></td><td>B2</td><td>Sensor B2</td><td>{zones.some(z => z.sensorId === 'B2') ? <StatusBadge tone="success">Ativo</StatusBadge> : <StatusBadge tone="neutral">—</StatusBadge>}</td></tr>
                <tr className="pinout-sep"><td colSpan={5}><span className="pinout-sep-label">— Módulo de 8 Relés (IN1–IN8) —</span></td></tr>
                {SYSTEM_RELAYS.map((r) => {
                  return (
                    <tr key={r.relay}>
                      <td><span className="gpio-badge">{r.gpio}</span></td>
                      <td><span className="dir-badge dir-out">OUTPUT</span></td>
                      <td>{r.inChannel} / {r.relay}</td>
                      <td>{r.func}</td>
                      <td><StatusBadge tone="neutral">Pronto</StatusBadge></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
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
      <div className="setpoint-grid">
        {zones.map((zone) => (
          <Panel key={zone.id} className="setpoint-card">
            <PanelHeader eyebrow={`CONFIGURAÇÃO · SENSOR ${zone.sensorId}`} title={zone.name} showIcon={false} />
            <div className="setpoint-ids"><span><Droplets size={13} /> Válvula {zone.id}</span><span><Radio size={13} /> Sensor {zone.sensorId}</span></div>
            <button className="remove-sensor-btn" onClick={() => onRemoveZone(zone)} aria-label={`Remover ${zone.name}`}><Trash2 size={16} /></button>
            <div className="setpoint-value"><strong>{zone.target}<small>%</small></strong><span>Humidade mínima desejada</span></div>
            <input type="range" min="20" max="90" value={zone.target} onChange={(e) => onChange(zone.id, Number(e.target.value))} />
            <div className="range-labels"><span>20%</span><span>90%</span></div>
            <div className="setpoint-note"><Gauge size={16} /><span>Atual: <b>{zone.moisture}%</b> · {zone.moisture >= zone.target ? 'acima do mínimo' : 'abaixo do mínimo'}</span></div>
            <div className="time-controls">
              <label>Tempo de rega da válvula</label>
              <div className="time-input">
                <button className="btn-step" onClick={() => onUpdateZone(zone.id, { waterDuration: Math.max(5, zone.waterDuration - 5) })}>-</button>
                <button className="time-display" onClick={() => openKeyboard(zone.id, zone.waterDuration)}>{zone.waterDuration}<span>s</span></button>
                <button className="btn-step" onClick={() => onUpdateZone(zone.id, { waterDuration: zone.waterDuration + 5 })}>+</button>
              </div>
              <small>Toque no valor para abrir o teclado numérico</small>
            </div>
            <div className="setpoint-schedule">
              <label>{language === 'PT' ? 'Programação semanal' : 'Weekly schedule'}</label>
              <ScheduleEditor zone={zone} onChange={(schedules) => onUpdateZone(zone.id, { schedules } as Partial<Zone>)} language={language} />
            </div>
          </Panel>
        ))}
      </div>
      {keyboard && <NumericKeyboard value={keyboard.value} onChange={(v) => setKeyboard((k) => (k ? { ...k, value: v } : k))} onSubmit={submitKeyboard} onClose={() => setKeyboard(null)} />}
    </>
  );
}

/* ---------- Mapa ---------- */
type MapElement = { x: number; y: number };
type MapField = { id: string; x: number; y: number; w: number; h: number; name: string };

const DEFAULT_PUMP_POS: MapElement = { x: 50, y: 82 };
const DEFAULT_MCU_POS: MapElement = { x: 50, y: 92 };
const DEFAULT_FIELDS: MapField[] = [
  { id: 'F1', x: 6, y: 8, w: 40, h: 42, name: 'Terreno A' },
  { id: 'F2', x: 52, y: 36, w: 42, h: 46, name: 'Terreno B' },
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
            <button className="map-tool-btn map-tool-reset" onClick={resetLayout}><RotateCcw size={15} />Repor layout</button>
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

function NumericKeyboard({ value, onChange, onSubmit, onClose }: { value: string; onChange: (v: string) => void; onSubmit: () => void; onClose: () => void }) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '00'];
  return (
    <div className="keyboard-overlay" onClick={onClose}>
      <div className="keyboard" onClick={(e) => e.stopPropagation()}>
        <div className="keyboard-header">
          <span>Inserir valor (segundos)</span>
          <button onClick={onClose} aria-label="Fechar teclado"><X size={18} /></button>
        </div>
        <div className="keyboard-display">{value || '0'}<span>s</span></div>
        <div className="keyboard-keys">
          {keys.map((k) => (
            <button key={k} className="kb-key" onClick={() => onChange(value + k)}>{k}</button>
          ))}
          <button className="kb-key kb-backspace" onClick={() => onChange(value.slice(0, -1))} aria-label="Apagar"><Delete size={18} /></button>
        </div>
        <div className="keyboard-actions">
          <button className="kb-clear" onClick={() => onChange('')}>Limpar</button>
          <button className="kb-confirm" onClick={onSubmit}>Confirmar</button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Text keyboard (themed, for map name editing) ---------- */
function TextKeyboard({ value, onChange, onSubmit, onClose }: { value: string; onChange: (v: string) => void; onSubmit: () => void; onClose: () => void }) {
  const rows = [
    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', 'Ç'],
    ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
  ];
  const nums = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'];
  return (
    <div className="keyboard-overlay" onClick={onClose}>
      <div className="keyboard text-keyboard" onClick={(e) => e.stopPropagation()}>
        <div className="keyboard-header">
          <span>Editar nome do local</span>
          <button onClick={onClose} aria-label="Fechar teclado"><X size={18} /></button>
        </div>
        <div className="keyboard-display text-display">{value || ' '}</div>
        <div className="text-kb-nums">
          {nums.map((n) => (
            <button key={n} className="kb-key kb-key-sm" onClick={() => onChange(value + n)}>{n}</button>
          ))}
        </div>
        <div className="text-kb-rows">
          {rows.map((row, i) => (
            <div key={i} className="text-kb-row">
              {row.map((k) => (
                <button key={k} className="kb-key kb-key-sm" onClick={() => onChange(value + k)}>{k}</button>
              ))}
            </div>
          ))}
        </div>
        <div className="text-kb-actions">
          <button className="kb-key kb-key-sm kb-space" onClick={() => onChange(value + ' ')}>Espaço</button>
          <button className="kb-key kb-key-sm kb-backspace" onClick={() => onChange(value.slice(0, -1))} aria-label="Apagar"><Delete size={16} /></button>
        </div>
        <div className="keyboard-actions">
          <button className="kb-clear" onClick={onClose}>Cancelar</button>
          <button className="kb-confirm" onClick={onSubmit}>Confirmar</button>
        </div>
      </div>
    </div>
  );
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
function HistoryView({ errors, eventLog, eventLogLoading, onRefresh, language }: { errors: ErrorEvent[]; eventLog: EventLogEntry[]; eventLogLoading: boolean; onRefresh: () => void }) {
  const irrigationEvents = eventLog.filter((e) =>
    ['zone_toggle', 'system_start', 'system_stop', 'system_reset', 'emergency_stop', 'test_cycle', 'mode_change'].includes(e.event_type)
  );
  return (
    <div className="two-column">
      <Panel className="chart-panel">
        <PanelHeader eyebrow="ÚLTIMAS 24 HORAS" title="Humidade por zona" />
        <div className="chart">
          <div className="chart-grid"><span>80%</span><span>60%</span><span>40%</span><span>20%</span></div>
          <div className="chart-lines">
            <div className="line line-a" />
            <div className="line line-b" />
            <div className="chart-labels"><span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>Agora</span></div>
          </div>
        </div>
        <div className="legend"><span><i className="legend-a" />Zona 1</span><span><i className="legend-b" />Zona 2</span></div>
      </Panel>
      <Panel>
        <div className="panel-heading">
          <div><span className="section-kicker">REGISTO DE ATIVIDADE</span><h3>Eventos recentes</h3></div>
          <button className="refresh-btn" onClick={onRefresh} aria-label="Atualizar"><RotateCcw size={16} /></button>
        </div>
        <div className="history-list">
          {eventLogLoading && <div className="empty-state"><Activity size={28} /><span>A carregar eventos…</span></div>}
          {!eventLogLoading && irrigationEvents.length === 0 && <div className="empty-state"><CheckCircle2 size={28} /><span>Nenhum evento registado</span></div>}
          {!eventLogLoading && irrigationEvents.map((ev) => {
            const item = eventToHistoryItem(ev);
            return <HistoryItem key={ev.id} time={item.time} zone={item.zone} duration={ev.message} />;
          })}
        </div>
      </Panel>
      <Panel className="error-history-panel">
        <PanelHeader eyebrow="DIAGNÓSTICO" title="Histórico de erros" />
        <div className="error-list">
          {errors.length === 0 && <div className="empty-state"><CheckCircle2 size={28} /><span>Nenhum erro registado</span></div>}
          {errors.map((err) => <ErrorItem key={err.id} event={err} />)}
        </div>
      </Panel>
    </div>
  );
}

function HistoryItem({ time, zone, duration }: { time: string; zone: string; duration: string }) {
  return <div className="history-item"><span className="history-time">{time}</span><div><strong>{zone}</strong><span>{duration}</span></div></div>;
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

  return (
    <div className="alarms-layout">
      <div className="alarm-summary-grid">
        <Panel className={`alarm-summary-card ${critical > 0 ? 'card-error' : 'card-ok'}`}>
          <div className="alarm-summary-icon"><AlertTriangle size={24} /></div>
          <div><strong>{critical}</strong><span>Críticos</span></div>
        </Panel>
        <Panel className={`alarm-summary-card ${warnings > 0 ? 'card-warning' : 'card-ok'}`}>
          <div className="alarm-summary-icon"><AlertTriangle size={24} /></div>
          <div><strong>{warnings}</strong><span>Avisos</span></div>
        </Panel>
        <Panel className="alarm-summary-card card-ok">
          <div className="alarm-summary-icon"><CheckCircle2 size={24} /></div>
          <div><strong>{resolved.length}</strong><span>Resolvidos</span></div>
        </Panel>
      </div>

      {active.length > 0 ? (
        <Panel className="alarm-banner">
          <div className="alarm-banner-icon"><AlertTriangle size={22} /></div>
          <div>
            <span className="section-kicker">ALARMES ATIVOS</span>
            <h3>{active.length} evento(s) requer(em) atenção</h3>
            <p>Existem alarmes ativos que devem ser verificados.</p>
          </div>
          <StatusBadge tone="error">Atenção</StatusBadge>
        </Panel>
      ) : (
        <Panel className="alarm-banner alarm-banner-ok">
          <div className="alarm-banner-icon ok"><CheckCircle2 size={22} /></div>
          <div>
            <span className="section-kicker">ESTADO DOS ALARMES</span>
            <h3>Sem alarmes ativos</h3>
            <p>Não existem falhas que impeçam o funcionamento do sistema.</p>
          </div>
          <StatusBadge tone="success">Tudo OK</StatusBadge>
        </Panel>
      )}

      <Panel>
        <PanelHeader eyebrow="ALARMES ATIVOS" title="Requerem atenção" />
        <div className="alarm-list">
          {active.length === 0 && <div className="empty-state"><CheckCircle2 size={28} /><span>Nenhum alarme ativo</span></div>}
          {active.map((ev) => (
            <AlarmItem key={ev.id} event={ev} onResolve={() => onResolve(ev.id)} />
          ))}
        </div>
      </Panel>

      {resolved.length > 0 && (
        <Panel>
          <PanelHeader eyebrow="HISTÓRICO" title="Alarmes resolvidos" />
          <div className="alarm-list">
            {resolved.map((ev) => <AlarmItem key={ev.id} event={ev} />)}
          </div>
        </Panel>
      )}
    </div>
  );
}

function AlarmItem({ event, onResolve }: { event: ErrorEvent; onResolve?: () => void }) {
  return (
    <div className={`alarm-item alarm-${event.severity}`}>
      <span className={`alarm-item-icon alarm-icon-${event.severity}`}>
        {event.severity === 'info' ? <Activity size={16} /> : <AlertTriangle size={16} />}
      </span>
      <div>
        <strong>{event.source}</strong>
        <span>{event.message}</span>
        <div className="alarm-meta"><small>{event.time}</small><span className="alarm-id">{event.id}</span></div>
      </div>
      {!event.resolved && onResolve ? (
        <button className="resolve-btn" onClick={onResolve}><CheckCircle2 size={15} />Resolver</button>
      ) : (
        <StatusBadge tone="success">Resolvido</StatusBadge>
      )}
    </div>
  );
}

/* ---------- Login Screen (full-screen) ---------- */
function LoginScreen({ language, onSubmit }: { language: Language; onSubmit: (pass: string) => void }) {
  const [pass, setPass] = useState('');
  const [error, setError] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(false);

  const handleSubmit = () => {
    if (pass === '1234') {
      onSubmit(pass);
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
          <div className="login-brand-text">
            <strong>GTC</strong><span>REGA</span>
          </div>
        </div>
        <h2>{t('login.welcome', language)}</h2>
        <p className="login-desc">{t('login.description', language)}</p>
        <div className="login-form">
          <div className={`login-input-group ${error ? 'login-input-error' : ''}`} onClick={() => setShowKeyboard(true)}>
            <LockKeyhole size={18} />
            <input
              type="password"
              placeholder={t('login.password', language)}
              value={pass}
              onChange={(e) => { setPass(e.target.value); setError(false); }}
              onFocus={() => setShowKeyboard(true)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); setCapsLock(e.getModifierState('CapsLock')); }}
              onKeyUp={(e) => setCapsLock(e.getModifierState('CapsLock'))}
              autoFocus
            />
          </div>
          {capsLock && <div className="login-caps-warning">⚠ {t('login.capsLock', language)}</div>}
          {error && <div className="login-message error">{t('login.error', language)}</div>}
          <button className="login-submit-btn" onClick={handleSubmit} disabled={!pass}>
            {t('login.submit', language)}
          </button>
        </div>
        <div className="login-footer">
          <span>ESP32-S3 · v2.11</span>
          <span>© Deogracia de Castro</span>
        </div>
      </div>
      {showKeyboard && (
        <TextKeyboard value={pass} onChange={setPass} onSubmit={() => { handleSubmit(); setShowKeyboard(false); }} onClose={() => setShowKeyboard(false)} />
      )}
    </div>
  );
}

/* ---------- Login Modal ---------- */
function LoginModal({ language, reason, onSubmit, onClose }: { language: Language; reason: 'startup' | 'setpoints' | 'map'; onSubmit: (pass: string) => void; onClose: () => void }) {
  const [pass, setPass] = useState('');
  const [error, setError] = useState(false);
  const [showKeyboard, setShowKeyboard] = useState(false);

  const handleSubmit = () => {
    if (pass === '1234') {
      onSubmit(pass);
      setError(false);
    } else {
      setError(true);
      setTimeout(() => setError(false), 2000);
    }
  };

  return (
    <div className="modal-overlay" onClick={reason === 'startup' ? undefined : onClose}>
      <div className="confirm-modal login-modal" onClick={(e) => e.stopPropagation()}>
        <div className="confirm-modal-icon"><LockKeyhole size={32} /></div>
        <h3>{t('login.title', language)}</h3>
        <p>{t('login.subtitle', language)}</p>
        <div className="login-field" onClick={() => setShowKeyboard(true)}>
          <LockKeyhole size={16} />
          <input
            type="password"
            placeholder={t('login.password', language)}
            value={pass}
            onChange={(e) => { setPass(e.target.value); setError(false); }}
            onFocus={() => setShowKeyboard(true)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit(); }}
            autoFocus
          />
        </div>
        {error && <div className="login-error">{t('login.error', language)}</div>}
        <div className="confirm-modal-actions">
          {reason !== 'startup' && <button className="kb-clear" onClick={onClose}>{t('general.cancel', language)}</button>}
          <button className="kb-confirm" onClick={handleSubmit}>{t('login.submit', language)}</button>
        </div>
      </div>
      {showKeyboard && (
        <TextKeyboard
          value={pass}
          onChange={setPass}
          onSubmit={() => { handleSubmit(); setShowKeyboard(false); }}
          onClose={() => setShowKeyboard(false)}
        />
      )}
    </div>
  );
}

/* ---------- Weekly Schedule Editor ---------- */
const WEEKDAYS: WeekDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const WEEKDAY_LABELS_PT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const WEEKDAY_LABELS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ScheduleEditor({ zone, onChange, language }: { zone: Zone; onChange: (schedules: Record<WeekDay, WaterSchedule>) => void; language: Language }) {
  const labels = language === 'EN' ? WEEKDAY_LABELS_EN : WEEKDAY_LABELS_PT;

  const toggleDay = (day: WeekDay) => {
    const next = { ...zone.schedules };
    next[day] = { ...next[day], enabled: !next[day].enabled };
    onChange(next);
  };

  const setTime = (day: WeekDay, hour: number, minute: number) => {
    const next = { ...zone.schedules };
    next[day] = { ...next[day], hour, minute };
    onChange(next);
  };

  const formatTime = (h: number, m: number) => 
    `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

  if (!zone.schedules) {
    // If schedules is missing, create default
    const defaults: Record<string, WaterSchedule> = {};
    WEEKDAYS.forEach(d => { defaults[d] = { enabled: true, hour: 6, minute: 0 }; });
    zone.schedules = defaults as Record<WeekDay, WaterSchedule>;
  }

  return (
    <div className="schedule-grid">
      {WEEKDAYS.map((day, i) => {
        const s = zone.schedules[day] || { enabled: true, hour: 6, minute: 0 };
        return (
          <div key={day} className={`schedule-day ${s.enabled ? 'schedule-enabled' : ''}`}>
            <button
              className="schedule-day-toggle"
              onClick={() => toggleDay(day)}
              title={s.enabled ? (language === 'PT' ? 'Desativar' : 'Disable') : (language === 'PT' ? 'Ativar' : 'Enable')}
            >
              <span className="schedule-day-label">{labels[i]}</span>
              <span className={`schedule-day-status ${s.enabled ? 'on' : 'off'}`} />
            </button>
            {s.enabled && (
              <div className="schedule-time-controls">
                <button className="schedule-time-btn" onClick={() => {
                  const newH = s.hour - 1 < 0 ? 23 : s.hour - 1;
                  setTime(day, newH, s.minute);
                }}>−</button>
                <button className="schedule-time-display" onClick={() => {
                  // Open numeric keyboard for hour input
                  const h = prompt(language === 'PT' ? 'Hora (0-23):' : 'Hour (0-23):', String(s.hour));
                  if (h !== null) {
                    const m = prompt(language === 'PT' ? 'Minuto (0-59):' : 'Minute (0-59):', String(s.minute));
                    if (m !== null) {
                      setTime(day, Math.max(0, Math.min(23, parseInt(h) || 0)), Math.max(0, Math.min(59, parseInt(m) || 0)));
                    }
                  }
                }}>
                  {formatTime(s.hour, s.minute)}
                </button>
                <button className="schedule-time-btn" onClick={() => {
                  const newH = s.hour + 1 > 23 ? 0 : s.hour + 1;
                  setTime(day, newH, s.minute);
                }}>+</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default App;
