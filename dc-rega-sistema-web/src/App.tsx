import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import gtcIcon from './assets/gtc-icon.png';
import esquemaPdf from './assets/esquema-eletrico.pdf?url';
import {
  Activity,
  AlertTriangle,
  Bell,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
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
  ArrowUp,
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
  Wifi,
  Bluetooth,
  BluetoothConnected,
  X,
  MapPin,
  PencilLine,
  Spline,
  Minus,
  Eraser,
  Check,
  CornerDownLeft,
  ArrowBigUp,
  ArrowUpToLine,
  Space as SpaceIcon,
  Search,
  CircuitBoard,
  Zap,
  Download,
  ExternalLink,
} from 'lucide-react';
import { fetchEvents, logEvent, type EventLogEntry, saveState, loadState, saveLayout, loadLayout } from '@/lib/supabase';
import { t } from '@/lang';
import { getControllerClient } from '@/lib/controller';

// Base da API do backend (Socket.IO/REST). Em produção (Vercel) é obrigatório
// definir VITE_API_URL, ou os pedidos vão para o próprio domínio do frontend
// (que não tem backend) e nunca sincronizam entre dispositivos.
const API_BASE = import.meta.env.VITE_API_URL || '';
import { useIsEmbedded } from '@/lib/useIsEmbedded';

type Page = 'Resumo' | 'Estado' | 'Setpoints' | 'Mapa' | 'Histórico' | 'Comandos' | 'Alarmes' | 'Conexão' | 'Esquema';
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
  { label: 'Conexão', icon: Bluetooth },
  { label: 'Esquema', icon: CircuitBoard },
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

type GpioConfigRow = { id: string; gpio: number; direction: 'INPUT' | 'OUTPUT'; label: string; func: string; inChannel: string };

const SENSOR_GPIO_MAP: Record<string, number> = { B1: 21, B2: 14 };
const SENSOR_HARDWARE_LINKS = [
  { sensorId: 'B1', gpio: 21, pin: 'IO21', title: 'DHT22 #1', subtitlePT: 'Temperatura / Humidade', subtitleEN: 'Temperature / Humidity' },
  { sensorId: 'B2', gpio: 14, pin: 'IO14', title: 'DHT22 #2', subtitlePT: 'Temperatura / Humidade', subtitleEN: 'Temperature / Humidity' },
];
const I2C_BUS_PINS = [
  { label: 'SCL', gpio: 16, espPin: 'IO16', mcpPin: 'SCL', func: 'I2C → MCP23017' },
  { label: 'SDA', gpio: 18, espPin: 'IO18', mcpPin: 'SDA', func: 'I2C → MCP23017' },
];
const ESP32_DIRECT_PINS = [
  { pin: '3VCC', kind: 'power', titlePT: 'Barramento 3.3V', titleEN: '3.3V power rail', detailPT: 'Alimenta DHT22, MCP23017 e pull-ups', detailEN: 'Powers DHT22, MCP23017 and pull-ups' },
  { pin: 'GND', kind: 'ground', titlePT: 'Massa comum 0V', titleEN: 'Common ground 0V', detailPT: 'Referência elétrica do circuito', detailEN: 'Electrical reference for the circuit' },
  { pin: 'IO16', gpio: 16, kind: 'i2c', titlePT: 'Clock I2C', titleEN: 'I2C clock', detailPT: 'Ligação ao MCP23017 · SCL', detailEN: 'Linked to MCP23017 · SCL' },
  { pin: 'IO18', gpio: 18, kind: 'i2c', titlePT: 'Dados I2C', titleEN: 'I2C data', detailPT: 'Ligação ao MCP23017 · SDA', detailEN: 'Linked to MCP23017 · SDA' },
  { pin: 'IO21', gpio: 21, kind: 'sensor', sensorId: 'B1', titlePT: 'DHT22 #1 · SDA', titleEN: 'DHT22 #1 · SDA', detailPT: 'Leitura de temperatura / humidade', detailEN: 'Temperature / humidity reading' },
  { pin: 'IO14', gpio: 14, kind: 'sensor', sensorId: 'B2', titlePT: 'DHT22 #2 · SDA', titleEN: 'DHT22 #2 · SDA', detailPT: 'Leitura de temperatura / humidade', detailEN: 'Temperature / humidity reading' },
  { pin: 'IO02', gpio: 2, kind: 'free', titlePT: 'Pino livre', titleEN: 'Free pin', detailPT: 'Reservado para não interferir no boot', detailEN: 'Reserved to avoid boot interference' },
  { pin: 'IO03', gpio: 3, kind: 'free', titlePT: 'Pino livre', titleEN: 'Free pin', detailPT: 'Reservado para não interferir na gravação USB', detailEN: 'Reserved to avoid USB flashing issues' },
];

// Restantes GPIOs livres do ESP32-S3 (ES3C28P) — apresentados como pinos
// disponíveis e não atribuídos, no mesmo estilo do diagrama.
const ESP32_FREE_GPIO_PINS = [
  { pin: 'IO01', gpio: 1 },
  { pin: 'IO04', gpio: 4 },
  { pin: 'IO05', gpio: 5 },
  { pin: 'IO06', gpio: 6 },
  { pin: 'IO07', gpio: 7 },
  { pin: 'IO08', gpio: 8 },
  { pin: 'IO09', gpio: 9 },
  { pin: 'IO10', gpio: 10 },
  { pin: 'IO11', gpio: 11 },
  { pin: 'IO12', gpio: 12 },
  { pin: 'IO13', gpio: 13 },
  { pin: 'IO15', gpio: 15 },
  { pin: 'IO17', gpio: 17 },
  { pin: 'IO35', gpio: 35 },
  { pin: 'IO36', gpio: 36 },
  { pin: 'IO37', gpio: 37 },
  { pin: 'IO38', gpio: 38 },
  { pin: 'IO39', gpio: 39 },
  { pin: 'IO40', gpio: 40 },
  { pin: 'IO41', gpio: 41 },
  { pin: 'IO42', gpio: 42 },
  { pin: 'IO45', gpio: 45 },
  { pin: 'IO46', gpio: 46 },
  { pin: 'IO47', gpio: 47 },
];
const SYSTEM_RELAYS = [
  { relay: 'PA0', gpio: 0, inChannel: '9-E6', func: 'MOTOR ON' },
  { relay: 'PA1', gpio: 1, inChannel: '9-D6', func: 'AUTO GTC' },
  { relay: 'PA2', gpio: 2, inChannel: '8-E6', func: 'STO/EMERG GTC' },
  { relay: 'PA3', gpio: 3, inChannel: '8-E6', func: 'ON GTC' },
  { relay: 'PA4', gpio: 4, inChannel: '8-E6', func: 'Temp. Tempo de Rega' },
  { relay: 'PA5', gpio: 5, inChannel: '8-D6', func: 'Temp. Delay Bom/Val' },
  { relay: 'PA6', gpio: 6, inChannel: '8-D6', func: 'Out Sensor 2' },
  { relay: 'PA7', gpio: 7, inChannel: '', func: 'Out Sensor 1' },
  { relay: 'PB0', gpio: 8, inChannel: '9-E6', func: 'RELÉ TEMP ON' },
];
const MCP_FEEDBACK_PINS = [
  { relay: 'PB6', gpio: 14, inChannel: 'Opto', func: 'Sinal da bomba ON' },
  { relay: 'PB7', gpio: 15, inChannel: 'Opto', func: 'Sinal do relé térmico ON' },
];
const MCP_CONTROL_PINS = [
  { pin: '3VCC', funcPT: 'Alimentação 3.3V', funcEN: '3.3V supply' },
  { pin: 'GND', funcPT: 'Massa 0V', funcEN: '0V ground' },
  { pin: 'SCL', funcPT: 'Clock I2C ← IO16', funcEN: 'I2C clock ← IO16' },
  { pin: 'SDA', funcPT: 'Dados I2C ↔ IO18', funcEN: 'I2C data ↔ IO18' },
  { pin: 'RST', funcPT: 'Reset fixo em nível alto', funcEN: 'Reset tied high' },
];
const MCP_PORT_A_PINS = SYSTEM_RELAYS.filter((pin) => pin.relay.startsWith('PA')).map((pin) => ({ ...pin, direction: 'OUTPUT' as const }));
const MCP_PORT_B_PINS = [
  { relay: 'PB0', gpio: 8, inChannel: '9-E6', func: 'RELÉ TEMP ON', direction: 'OUTPUT' as const },
  { relay: 'PB1', gpio: 9, inChannel: '', func: 'Livre', direction: 'FREE' as const },
  { relay: 'PB2', gpio: 10, inChannel: '', func: 'Livre', direction: 'FREE' as const },
  { relay: 'PB3', gpio: 11, inChannel: '', func: 'Livre', direction: 'FREE' as const },
  { relay: 'PB4', gpio: 12, inChannel: '', func: 'Livre', direction: 'FREE' as const },
  { relay: 'PB5', gpio: 13, inChannel: '', func: 'Livre', direction: 'FREE' as const },
  { relay: 'PB6', gpio: 14, inChannel: 'Opto', func: 'Sinal da bomba ON', direction: 'INPUT' as const },
  { relay: 'PB7', gpio: 15, inChannel: 'Opto', func: 'Sinal do relé térmico ON', direction: 'INPUT' as const },
];
const MCP_USED_OUTPUTS = [...SYSTEM_RELAYS, ...MCP_FEEDBACK_PINS];
const DEFAULT_GPIO_CONFIG: GpioConfigRow[] = [
  { id: 'row-1', gpio: 21, direction: 'INPUT', label: 'B1', func: 'DHT22 #1 · Temperatura / Humidade', inChannel: '' },
  { id: 'row-2', gpio: 14, direction: 'INPUT', label: 'B2', func: 'DHT22 #2 · Temperatura / Humidade', inChannel: '' },
  { id: 'row-3', gpio: 0, direction: 'OUTPUT', label: 'PA0', func: 'MOTOR ON', inChannel: '9-E6' },
  { id: 'row-4', gpio: 1, direction: 'OUTPUT', label: 'PA1', func: 'AUTO GTC', inChannel: '9-D6' },
  { id: 'row-5', gpio: 2, direction: 'OUTPUT', label: 'PA2', func: 'STO/EMERG GTC', inChannel: '8-E6' },
  { id: 'row-6', gpio: 3, direction: 'OUTPUT', label: 'PA3', func: 'ON GTC', inChannel: '8-E6' },
  { id: 'row-7', gpio: 4, direction: 'OUTPUT', label: 'PA4', func: 'Temp. Tempo de Rega', inChannel: '8-E6' },
  { id: 'row-8', gpio: 5, direction: 'OUTPUT', label: 'PA5', func: 'Temp. Delay Bom/Val', inChannel: '8-D6' },
  { id: 'row-9', gpio: 6, direction: 'OUTPUT', label: 'PA6', func: 'Out Sensor 2', inChannel: '8-D6' },
  { id: 'row-10', gpio: 7, direction: 'OUTPUT', label: 'PA7', func: 'Out Sensor 1', inChannel: '' },
  { id: 'row-11', gpio: 8, direction: 'OUTPUT', label: 'PB0', func: 'RELÉ TEMP ON', inChannel: '9-E6' },
];

function cloneDefaultGpioConfig(): GpioConfigRow[] {
  return DEFAULT_GPIO_CONFIG.map((row) => ({ ...row }));
}

function normalizeGpioConfig(raw: unknown): GpioConfigRow[] {
  if (!Array.isArray(raw) || raw.length === 0) return cloneDefaultGpioConfig();
  const rows = raw
    .map((item, index) => {
      const row = (item ?? {}) as Partial<GpioConfigRow>;
      const gpio = Number(row.gpio);
      const direction = row.direction === 'INPUT' ? 'INPUT' : row.direction === 'OUTPUT' ? 'OUTPUT' : null;
      if (!Number.isFinite(gpio) || !direction) return null;
      return {
        id: row.id || `row-${index + 1}`,
        gpio,
        direction,
        label: String(row.label || ''),
        func: String(row.func || ''),
        inChannel: String(row.inChannel || ''),
      } as GpioConfigRow;
    })
    .filter((row): row is GpioConfigRow => !!row);

  if (!rows.length) return cloneDefaultGpioConfig();

  const legacyLabels = new Set(['B1', 'B2', 'K3', 'K4', 'K5', 'K6', 'K7', 'K8', 'K9', 'K10']);
  const looksLegacyDirectMap = rows.some((row) => legacyLabels.has(row.label) && row.gpio >= 4 && row.gpio <= 13);
  return looksLegacyDirectMap ? cloneDefaultGpioConfig() : rows;
}

// Todos os GPIOs de uso geral disponíveis numa placa ESP32-S3-DevKitC-1
// (exclui os pinos de flash/PSRAM interno 22–25/27–32 e os pinos USB
// D+/D- 19/20, que não devem ser reatribuídos).
const ESP32S3_ALL_GPIOS = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 21,
  35, 36, 37, 38, 39, 40, 41, 42, 45, 46, 47, 48,
];
// Pinos já reservados internamente pelo firmware (não reatribuíveis na tabela)
const ESP32S3_RESERVED_GPIOS: Record<number, string> = {
  0: 'Botão BOOT / Emergência',
  48: 'LED de estado on-board',
};

// Formata o uptime real do ESP32-S3 (segundos desde o último arranque, vindo da telemetria)
function formatUptime(seconds?: number): string | null {
  if (typeof seconds !== 'number' || seconds < 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`;
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m${String(s).padStart(2, '0')}s` : `${s}s`;
}

/**
 * Estado elétrico real de um pino, a partir da telemetria do ESP32-S3.
 * known=false → sem leitura real (controlador offline ou pino sem reporte).
 */
type PinSignal = { known: boolean; active: boolean; value: number | null };
function pinSignal(gpioLive: Record<number, number | boolean>, gpio: number, deviceOnline: boolean): PinSignal {
  if (!deviceOnline) return { known: false, active: false, value: null };
  const raw = gpioLive?.[gpio];
  if (raw === undefined || raw === null) return { known: false, active: false, value: null };
  if (typeof raw === 'boolean') return { known: true, active: raw, value: null };
  const num = Number(raw);
  if (Number.isNaN(num)) return { known: false, active: false, value: null };
  return { known: true, active: num > 0, value: num };
}

function sensorPinSignal(sensorId: string, sensorHealth: Record<string, { stale: boolean; lastSeen: number | null }>, deviceOnline: boolean): PinSignal {
  if (!deviceOnline) return { known: false, active: false, value: null };
  const health = sensorHealth[sensorId];
  if (health?.stale) return { known: true, active: false, value: 0 };
  return { known: true, active: true, value: 1 };
}

function signalClass(sig: PinSignal): string {
  if (!sig.known) return 'sig-unknown';
  return sig.active ? 'sig-active' : 'sig-idle';
}

function StatusBadge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'success' | 'warning' | 'error' | 'neutral' | 'cyan' | 'blue' }) {
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

function severityLabel(severity: 'critical' | 'warning' | 'info', language: Language): string {
  if (language === 'PT') {
    return severity === 'critical' ? 'CRÍTICO' : severity === 'warning' ? 'AVISO' : 'INFORMAÇÃO';
  }
  return severity.toUpperCase();
}

function eventToHistoryItem(ev: EventLogEntry): { time: string; zone: string; duration: string; eventType: string } {
  const time = formatTime(ev.created_at);
  const meta = ev.metadata as Record<string, unknown> | null;
  const duration = meta?.duration ? `${meta.duration} min` : ev.event_type;
  return { time, zone: ev.source, duration, eventType: ev.event_type };
}

function App() {
  // Versão embedded (display do ESP32-S3): sem mapa de pinos, sem edição de
  // pinos e sem mapa de sensores/válvulas — só na versão web (PC/telemóvel/tablet).
  const isEmbedded = useIsEmbedded();
  const [activePage, setActivePage] = useState<Page>('Resumo');
  const [zones, setZones] = useState(initialZones);
  const [pumpOn, setPumpOn] = useState(false);
  const [pumpDelay, setPumpDelay] = useState(5);
  const [autoMode, setAutoMode] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const topbarRef = useRef<HTMLElement>(null);
  const [topbarHeight, setTopbarHeight] = useState(0);

  useEffect(() => {
    const el = topbarRef.current;
    if (!el) return;
    const update = () => setTopbarHeight(el.offsetHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => { ro.disconnect(); window.removeEventListener('resize', update); };
  }, []);
  const [notice, setNotice] = useState('');
  const [errors, setErrors] = useState<ErrorEvent[]>(initialErrors);
  const [systemRunning, setSystemRunning] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startStep, setStartStep] = useState('');
  const [engineState, setEngineState] = useState('idle');
  const [currentWateringZone, setCurrentWateringZone] = useState(-1);
  const [gpioConfig, setGpioConfig] = useState<GpioConfigRow[]>(cloneDefaultGpioConfig());
  const gpioRowCounter = useRef(DEFAULT_GPIO_CONFIG.length + 1);
  const [editingGpio, setEditingGpio] = useState<number | null>(null);
  // Estado elétrico real de cada pino (vindo da telemetria do ESP32-S3 via
  // backend): INPUT = valor lido no pino, OUTPUT = 1 quando o pino emite sinal.
  const [gpioLive, setGpioLive] = useState<Record<number, number | boolean>>({});
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

  // Weather state – real API (Open-Meteo)
  const [weather, setWeather] = useState({ temp: 24, desc: 'Parcialmente nublado', city: 'Amora', country: 'Portugal', icon: '⛅', humidity: 0, precipitation: 0, windSpeed: 0, rainChance: 0 });
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [deviceOnline, setDeviceOnline] = useState(false);
  const [deviceInfo, setDeviceInfo] = useState<{ deviceId?: string; firmware?: string; ip?: string; rssi?: number; uptime?: number; platform?: string; pumpRunning?: boolean; thermalAlarm?: boolean; mcpPresent?: boolean } | null>(null);
  const [sensorHealth, setSensorHealth] = useState<Record<string, { stale: boolean; lastSeen: number | null }>>({});
  // Ligação real ao backend (API/Socket.IO) — independente do ESP32 estar online
  const [backendOnline, setBackendOnline] = useState(false);
  const [lastContact, setLastContact] = useState<string | null>(null);
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
        const res = await fetch('https://api.open-meteo.com/v1/forecast?latitude=38.7223&longitude=-9.1393&current=temperature_2m,relative_humidity_2m,precipitation,weather_code,wind_speed_10m&hourly=precipitation_probability,precipitation&forecast_days=1&timezone=Europe/Lisbon');
        if (res.ok) {
          const data = await res.json();
          const cur = data.current;
          const code = cur.weather_code;
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
          // Maior probabilidade de precipitação nas próximas 6h (para decisões de rega)
          const hourly = data.hourly;
          let rainChance = 0;
          if (hourly?.time && hourly?.precipitation_probability) {
            const nowIso = new Date().toISOString().slice(0, 13);
            const startIdx = Math.max(0, hourly.time.findIndex((t: string) => t.slice(0, 13) === nowIso));
            const window = hourly.precipitation_probability.slice(startIdx, startIdx + 6);
            rainChance = window.length ? Math.max(...window) : 0;
          }
          setWeather({
            temp: Math.round(cur.temperature_2m),
            desc: descMap[code] || 'Desconhecido',
            icon: iconMap[code] || '🌡️',
            city: 'Amora',
            country: 'Portugal',
            humidity: Math.round(cur.relative_humidity_2m ?? 0),
            precipitation: cur.precipitation ?? 0,
            windSpeed: Math.round(cur.wind_speed_10m ?? 0),
            rainChance,
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
      if (cs.gpio && typeof cs.gpio === 'object') {
        setGpioLive(cs.gpio as Record<number, number | boolean>);
      }
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

    const unsubGpio = ctrl.on('gpio', (payload: Record<string, unknown>) => {
      const pin = Number(payload.pin);
      if (Number.isNaN(pin)) return;
      setGpioLive((cur) => ({ ...cur, [pin]: payload.value as number | boolean }));
    });

    const unsubSensorHealth = ctrl.on('sensor-health', (health: Record<string, unknown>) => {
      const sensorId = health.sensorId as string;
      if (!sensorId) return;
      setSensorHealth((cur) => ({ ...cur, [sensorId]: { stale: !!health.stale, lastSeen: (health.lastSeen as number) ?? null } }));
    });

    // Ligação real ao backend
    const unsubUp = ctrl.on('connected', () => setBackendOnline(true));
    const unsubDown = ctrl.on('disconnected', () => setBackendOnline(false));

    // Estado consolidado do dispositivo (polling REST de 5s, sempre ativo)
    const unsubStatus = ctrl.on('device-status', (status: Record<string, unknown>) => {
      setDeviceOnline(!!status.deviceOnline);
      setLastContact((status.lastContact as string) ?? null);
      if (status.deviceInfo) setDeviceInfo(status.deviceInfo as typeof deviceInfo);
      const sensors = status.sensors as { sensorId: string; stale: boolean; lastSeen: number | null }[] | undefined;
      if (Array.isArray(sensors)) {
        const map: Record<string, { stale: boolean; lastSeen: number | null }> = {};
        sensors.forEach((s) => { map[s.sensorId] = { stale: s.stale, lastSeen: s.lastSeen }; });
        setSensorHealth(map);
      }
    });

    // Snapshot inicial do estado real do controlador e sensores (REST) —
    // garante que a UI mostra dados reais mesmo antes do primeiro evento WS
    void ctrl.refreshAll();

    // Histórico/alarmes reais atualizados periodicamente a partir da API
    const eventsTimer = window.setInterval(() => { void loadEvents(); }, 20000);

    return () => {
      unsubState();
      unsubEvent();
      unsubDevice();
      unsubGpio();
      unsubSensorHealth();
      unsubUp();
      unsubDown();
      unsubStatus();
      window.clearInterval(eventsTimer);
      ctrl.disconnect();
    };
  }, [loadEvents]);
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
    fetch(`${API_BASE}/api/gpio-config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: gpioConfig }),
    }).catch(() => {});
    showNotice(language === 'PT' ? 'Configuração GPIO guardada' : 'GPIO configuration saved');
    persistGpioLocale();
  };

  const persistGpioLocale = (config: GpioConfigRow[] = gpioConfig) => {
    localStorage.setItem('gtc-gpio-config', JSON.stringify(config));
  };

  const loadGpioLocale = (): GpioConfigRow[] | null => {
    try {
      const raw = localStorage.getItem('gtc-gpio-config');
      if (raw) return normalizeGpioConfig(JSON.parse(raw));
    } catch {}
    return null;
  };

  useEffect(() => {
    let active = true;
    const ctrl = getControllerClient();
    const applyConfig = (config: unknown) => {
      const normalized = normalizeGpioConfig(config);
      if (!active) return;
      setGpioConfig(normalized);
      persistGpioLocale(normalized);
    };

    const unsubGpioConfig = ctrl.on('gpio:config', (payload: Record<string, unknown>) => {
      applyConfig((payload as { config?: unknown }).config ?? []);
    });

    const loadInitialConfig = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/gpio-config`);
        if (res.ok) {
          const data = await res.json() as { config?: unknown };
          if (Array.isArray(data.config) && data.config.length > 0) {
            applyConfig(data.config);
            return;
          }
        }
      } catch {}

      const local = loadGpioLocale();
      if (local?.length) applyConfig(local);
      else applyConfig(cloneDefaultGpioConfig());
    };

    void loadInitialConfig();
    return () => {
      active = false;
      unsubGpioConfig();
    };
  }, []);

  const handleGpioUpdate = (id: string, key: string, value: string) => {
    setGpioConfig(prev => prev.map(g => g.id === id ? { ...g, [key]: value } : g));
  };

  // Lista de GPIOs ainda livres (não usados por nenhuma linha, e não reservados
  // pelo firmware). Quando `excludeId` é indicado, o GPIO dessa própria linha
  // continua disponível para que ela possa manter o valor atual na lista.
  const getAvailableGpios = useCallback((excludeId?: string) => {
    const used = new Set(gpioConfig.filter(g => g.id !== excludeId).map(g => g.gpio));
    return ESP32S3_ALL_GPIOS.filter(p => !used.has(p) && !(p in ESP32S3_RESERVED_GPIOS));
  }, [gpioConfig]);

  const addGpioRow = () => {
    const free = getAvailableGpios();
    if (free.length === 0) {
      showNotice(language === 'PT' ? 'Não há mais GPIOs disponíveis no ESP32-S3' : 'No more GPIOs available on the ESP32-S3');
      return;
    }
    const id = `row-${gpioRowCounter.current++}`;
    setGpioConfig(prev => [...prev, { id, gpio: free[0], direction: 'OUTPUT', label: '', func: '', inChannel: '' }]);
    setEditingGpio(-1);
  };

  const removeGpioRow = (id: string) => {
    setGpioConfig(prev => prev.filter(g => g.id !== id));
  };

  const handleGpioPinChange = (id: string, newPin: number) => {
    setGpioConfig(prev => prev.map(g => g.id === id ? { ...g, gpio: newPin } : g));
  };

  const saveSettings = () => {
    setSettingsSaved(true);
    showNotice('Definições guardadas');
    window.setTimeout(() => setSettingsSaved(false), 2200);
  };

  const visiblePages = useMemo(
    () => (isEmbedded ? pages.filter((p) => p.label !== 'Mapa' && p.label !== 'Esquema') : pages),
    [isEmbedded],
  );

  useEffect(() => {
    if (isEmbedded && (activePage === 'Mapa' || activePage === 'Esquema')) setActivePage('Resumo');
  }, [isEmbedded, activePage]);

  const renderPage = () => {
    if (activePage === 'Resumo') {
      return <Overview zones={zones} pumpOn={pumpOn} autoMode={autoMode} activeZones={activeZones} onToggleZone={toggleZone} onTogglePump={togglePump} onToggleMode={toggleAutoMode} onOpenMap={() => requireAuth('Mapa')} isEmbedded={isEmbedded} weather={weather} language={language} deviceOnline={deviceOnline} deviceInfo={deviceInfo} sensorHealth={sensorHealth} clock={clock} dateStr={dateStr} latestAlert={errors[0]} systemRunning={systemRunning} starting={starting} startStep={startStep} onStart={handleStart} onStop={handleStop} onReset={handleReset} />;
    }
    if (activePage === 'Estado') return <StateView zones={zones} pumpOn={pumpOn} autoMode={autoMode} onToggleMode={toggleAutoMode} language={language} gpioConfig={gpioConfig} editingGpio={editingGpio} setEditingGpio={setEditingGpio} handleGpioUpdate={handleGpioUpdate} saveGpioConfig={saveGpioConfig} addGpioRow={addGpioRow} removeGpioRow={removeGpioRow} handleGpioPinChange={handleGpioPinChange} getAvailableGpios={getAvailableGpios} deviceOnline={deviceOnline} deviceInfo={deviceInfo} sensorHealth={sensorHealth} engineState={engineState} gpioLive={gpioLive} systemRunning={systemRunning} alarmCount={alarmCount} />;
    if (activePage === 'Setpoints') return <SetpointsView zones={zones} pumpDelay={pumpDelay} setPumpDelay={setPumpDelay} onChange={(id, target) => { setZones((cur) => { const next = cur.map((z) => (z.id === id ? { ...z, target } : z)); setTimeout(() => getControllerClient().updateZones(next), 200); return next; }); }} onUpdateZone={(id, patch) => { setZones((cur) => { const next = cur.map((z) => (z.id === id ? { ...z, ...patch } : z)); setTimeout(() => getControllerClient().updateZones(next), 200); return next; }); }} onAddZone={addZone} onRemoveZone={(z) => setZoneToDelete(z)} language={language} />;
    if (activePage === 'Mapa') {
      if (isEmbedded) return <EmbeddedUnavailable language={language} />;
      return <MapView zones={zones} pumpOn={pumpOn} onAddZone={addZoneFromMap} onDuplicateZone={duplicateZoneFromMap} onDragZone={updateZonePosition} onRenameZone={renameZone} onRemoveZone={(z) => setZoneToDelete(z)} onClearAll={clearAllZones} onToggleZone={toggleZone} weather={weather} language={language} />;
    }
    if (activePage === 'Histórico') return <HistoryView errors={errors} eventLog={eventLog} eventLogLoading={eventLogLoading} onRefresh={loadEvents} language={language} />;
    if (activePage === 'Comandos') return <CommandsView zones={zones} pumpOn={pumpOn} systemRunning={systemRunning} starting={starting} startStep={startStep} autoMode={autoMode} onToggleZone={toggleZone} onTogglePump={togglePump} onToggleMode={toggleAutoMode} onEmergencyStop={handleEmergencyStop} onTestCycle={handleTestCycle} onStart={handleStart} onStop={handleStop} onReset={handleReset} language={language} />;
    if (activePage === 'Conexão') return <ConnectionView language={language} deviceOnline={deviceOnline} deviceInfo={deviceInfo} />;
    if (activePage === 'Esquema') return <SchematicView language={language} />;
    return <AlarmsView errors={errors} onResolve={(id) => setErrors((cur) => cur.map((e) => (e.id === id ? { ...e, resolved: true } : e)))} language={language} />;
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><img src={gtcIcon} alt="GTC Rega" /></div>
          <div><strong>GTC</strong><span>REGA</span></div>
          <button className="close-menu" onClick={() => setMobileOpen(false)} aria-label="Fechar menu"><X size={18} /></button>
        </div>
        <div className="sidebar-label">{t('sidebar.control', language)}</div>
        <nav className="side-nav" aria-label="Navegação principal">
          {visiblePages.map(({ label, icon: Icon }) => (
            <button key={label} className={activePage === label ? 'nav-item active' : 'nav-item'} onClick={() => { if (label === 'Setpoints' || label === 'Mapa') { requireAuth(label); } else { setActivePage(label); } setMobileOpen(false); }}>
              <Icon size={19} strokeWidth={1.8} /><span>{t(`nav.${label.toLowerCase()}`, language)}</span>
              {label === 'Alarmes' && alarmCount > 0 && <span className="nav-count">{alarmCount}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <StatusBadge tone={backendOnline ? 'success' : 'error'}>{backendOnline ? t('sidebar.system', language) : (language === 'PT' ? 'Sem ligação à API' : 'API offline')}</StatusBadge>
          <div className="footer-reading"><TimerReset size={17} /><div><strong>{clock || '—'}</strong><span>{dateStr || '—'}</span></div></div>
          <div className="footer-reading"><CloudSun size={19} /><div><strong>{weather.temp}°C</strong><span>{weather.city} · {weather.desc} · {weather.humidity}% hum.</span></div></div>
          <div className="footer-reading"><Cpu size={17} /><div><strong>ESP32-S3</strong><span>{t('sidebar.controller', language)}</span></div></div>
        </div>
      </aside>
      {mobileOpen && <button className="scrim" onClick={() => setMobileOpen(false)} aria-label="Fechar menu" />}
      <main className="main-content">
        <header className="topbar" ref={topbarRef}>
          <div className="topbar-inner">
            <button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Abrir menu"><Menu size={22} /></button>
            <div className="topbar-title compact">
              <div className="topbar-logo-mark" aria-hidden="true"><img src={gtcIcon} alt="" /></div>
              <h1 className="topbar-h1-full">GTC <span>—</span> {t('topbar.title', language)}</h1>
              <h1 className="topbar-h1-short">GTC</h1>
            </div>
            <div className="topbar-right">
              <div className="weather" title={`Humidade ${weather.humidity}% · Vento ${weather.windSpeed} km/h · Prob. chuva (6h) ${weather.rainChance}%`}><CloudSun size={28} /><div><strong>{weather.temp}°C</strong><span>{weather.city}, {weather.country} · {weather.desc}</span></div></div>
              <button className="settings-btn" onClick={() => setSettingsOpen(true)} aria-label="Abrir definições"><Settings2 size={20} /></button>
            </div>
          </div>
        </header>
        <div className="content-wrap" style={{ paddingTop: topbarHeight }}>
          <div className="page-heading">
            <div><span className="section-kicker">{t('heading.overview', language)}</span><h2>{t(`nav.${activePage.toLowerCase()}`, language)}</h2></div>
            <div className={`connection ${deviceOnline ? 'connection-online' : backendOnline ? 'connection-waiting' : 'connection-offline'}`} title={lastContact ? `Último contacto: ${new Date(lastContact).toLocaleString('pt-PT')}` : undefined}>
              <Radio size={15} />
              <span>{deviceOnline ? 'ESP32-S3 online' : backendOnline ? (language === 'PT' ? 'API ligada · ESP32 offline' : 'API up · ESP32 offline') : (language === 'PT' ? 'Sem ligação' : 'No connection')}</span>
              <span className={`pulse ${deviceOnline ? 'pulse-device' : ''}`} />
            </div>
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
function Overview({ zones, pumpOn, autoMode, activeZones, onToggleZone, onTogglePump, onToggleMode, onOpenMap, isEmbedded, weather, language, deviceOnline, deviceInfo, sensorHealth, clock, dateStr, latestAlert, systemRunning, starting, startStep, onStart, onStop, onReset }: {
  zones: Zone[]; pumpOn: boolean; autoMode: boolean; activeZones: number; onToggleZone: (id: string) => void; onTogglePump: () => void; onToggleMode: () => void; onOpenMap: () => void; isEmbedded?: boolean; weather: { temp: number; desc: string; city: string; country: string; icon: string; humidity: number; precipitation: number; windSpeed: number; rainChance: number }; language: Language;
  deviceOnline: boolean;
  deviceInfo: { deviceId?: string; firmware?: string; ip?: string; rssi?: number; uptime?: number; platform?: string; pumpRunning?: boolean; thermalAlarm?: boolean; mcpPresent?: boolean } | null;
  sensorHealth: Record<string, { stale: boolean; lastSeen: number | null }>;
  clock: string;
  dateStr: string;
  latestAlert?: ErrorEvent;
  systemRunning: boolean;
  starting: boolean;
  startStep: string;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
}) {
  const staleSensorCount = zones.filter((z) => sensorHealth[z.sensorId]?.stale).length;
  return (
    <div className="content-stack">
      <Panel className={`device-status-panel ${deviceOnline ? 'device-online' : 'device-offline'}`}>
        <div className="device-status-main">
          <span className={`device-status-dot ${deviceOnline ? 'on' : 'off'}`} />
          <div className="device-status-info">
            <strong>{deviceOnline ? (language === 'PT' ? 'Controlador reconhecido' : 'Controller recognized') : (language === 'PT' ? 'Controlador não reconhecido' : 'Controller not recognized')}</strong>
            <span>
              {deviceOnline && deviceInfo
                ? `${deviceInfo.deviceId || 'ESP32-S3'} · fw ${deviceInfo.firmware || '—'} · ${deviceInfo.ip || '—'}${typeof deviceInfo.rssi === 'number' ? ` · ${deviceInfo.rssi} dBm` : ''}${formatUptime(deviceInfo.uptime) ? ` · online há ${formatUptime(deviceInfo.uptime)}` : ''}`
                : (language === 'PT' ? 'Sem telemetria — ligue o firmware gtc-esp32s3 à rede Wi-Fi' : 'No telemetry — connect the gtc-esp32s3 firmware to Wi-Fi')}
            </span>
          </div>
          <StatusBadge tone={deviceOnline ? 'success' : 'neutral'}>{deviceOnline ? 'Online' : 'Offline'}</StatusBadge>
        </div>
        <div className="device-status-sensors">
          <span className="device-status-sensors-label">{language === 'PT' ? 'Sensores:' : 'Sensors:'}</span>
          {zones.length === 0 && <span className="sensor-health-pill sim">{language === 'PT' ? 'Nenhum sensor' : 'No sensors'}</span>}
          {zones.map((z) => {
            const health = sensorHealth[z.sensorId];
            const stale = !!health?.stale;
            return (
              <span key={z.id} className={`sensor-health-pill ${stale ? 'stale' : deviceOnline ? 'ok' : 'off'}`} title={stale ? (language === 'PT' ? 'Sem resposta do sensor' : 'Sensor not responding') : deviceOnline ? (language === 'PT' ? 'Sensor reconhecido' : 'Sensor recognized') : (language === 'PT' ? 'Controlador offline — sem leitura real' : 'Controller offline — no real reading')}>
                <Radio size={12} /> {z.sensorId} {stale ? `· ${language === 'PT' ? 'sem sinal' : 'no signal'}` : deviceOnline ? '· ok' : `· ${language === 'PT' ? 'offline' : 'offline'}`}
                <span className="sensor-health-value">{z.moisture}%</span>
              </span>
            );
          })}
        </div>
      </Panel>
      {deviceOnline && deviceInfo?.thermalAlarm && (
        <Panel className="alarm-banner" style={{ gridColumn: '1 / -1' }}>
          <div className="alarm-banner-icon"><AlertTriangle size={22} /></div>
          <div>
            <span className="section-kicker">{language === 'PT' ? 'ALARME TÉRMICO' : 'THERMAL ALARM'}</span>
            <h3>{language === 'PT' ? 'Relé térmico disparado' : 'Thermal relay tripped'}</h3>
            <p>{language === 'PT' ? 'A bomba está bloqueada por segurança. Rearme o relé térmico (contacto 95-96) fisicamente antes de reiniciar.' : 'The pump is blocked for safety. Reset the thermal relay (contacts 95-96) physically before restarting.'}</p>
          </div>
          <StatusBadge tone="error">{language === 'PT' ? 'BLOQUEADO' : 'BLOCKED'}</StatusBadge>
        </Panel>
      )}
      <Panel className="summary-actions-panel">
        <PanelHeader eyebrow={language === 'PT' ? 'RESUMO' : 'SUMMARY'} title={language === 'PT' ? 'Comandos rápidos' : 'Quick commands'} />
        <div className="command-actions">
          <button className={`cmd-btn cmd-start ${systemRunning ? 'active' : ''}`} onClick={onStart} disabled={starting}>
            <Play size={24} />
            <span><strong>Start</strong><small>{starting ? startStep : (language === 'PT' ? 'Inicia o sistema de rega' : 'Starts the irrigation system')}</small></span>
          </button>
          <button className="cmd-btn cmd-stop" onClick={onStop}>
            <Square size={24} />
            <span><strong>Stop</strong><small>{language === 'PT' ? 'Para todos os atuadores' : 'Stops all actuators'}</small></span>
          </button>
          <button className="cmd-btn cmd-reset" onClick={onReset}>
            <RotateCcw size={24} />
            <span><strong>Reset</strong><small>{language === 'PT' ? 'Reinicia o sistema' : 'Resets the system'}</small></span>
          </button>
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
        <Metric icon={<Cpu />} label="Controlador" value={deviceOnline ? (deviceInfo?.deviceId || 'ESP32-S3') : 'Offline'} detail={deviceOnline ? `Wi-Fi · fw ${deviceInfo?.firmware || '—'} · ${deviceInfo?.pumpRunning ? (language === 'PT' ? 'bomba ON' : 'pump ON') : (language === 'PT' ? 'bomba OFF' : 'pump OFF')}` : 'Sem telemetria do controlador'} accent={deviceOnline} />
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
          {!isEmbedded && (
            <button className="action-button" onClick={onOpenMap}><MapIcon size={20} /><span><strong>Ver mapa completo</strong><small>Localização e estado de cada sensor na propriedade</small></span><ChevronRight size={17} /></button>
          )}
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
/* ---------- Branded custom <select> replacement ----------
 * Estilizado com a identidade visual do site (marca "folha" GTC em gradiente
 * teal), já que o <select> nativo não pode ser totalmente personalizado em
 * todos os browsers. */
function BrandSelect<T extends string | number>({ value, options, onChange, className, disabled }: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  className?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const escHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', escHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', escHandler);
    };
  }, [open]);

  const current = options.find(o => o.value === value);

  return (
    <div className={`brand-select ${className || ''} ${open ? 'open' : ''} ${disabled ? 'disabled' : ''}`} ref={rootRef}>
      <button
        type="button"
        className="brand-select-trigger"
        onClick={() => !disabled && setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
      >
        <span className="brand-select-mark"><Leaf size={10} /></span>
        <span className="brand-select-value">{current?.label ?? String(value)}</span>
        <ChevronDown size={13} className="brand-select-chevron" />
      </button>
      {open && (
        <ul className="brand-select-menu" role="listbox">
          {options.map(o => (
            <li
              key={String(o.value)}
              role="option"
              aria-selected={o.value === value}
              className={`brand-select-option ${o.value === value ? 'selected' : ''}`}
              onClick={() => { onChange(o.value); setOpen(false); }}
            >
              <span className="brand-select-option-check">{o.value === value && <CheckCircle2 size={12} />}</span>
              <span>{o.label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StateView({ zones, pumpOn, autoMode, onToggleMode, language, gpioConfig, editingGpio, setEditingGpio, handleGpioUpdate, saveGpioConfig, addGpioRow, removeGpioRow, handleGpioPinChange, getAvailableGpios, deviceOnline, deviceInfo, sensorHealth, engineState, gpioLive, systemRunning, alarmCount }: { zones: Zone[]; pumpOn: boolean; autoMode: boolean; onToggleMode: () => void; language: Language; gpioConfig: GpioConfigRow[]; editingGpio: number | null; setEditingGpio: (v: number | null) => void; handleGpioUpdate: (id: string, key: string, value: string) => void; saveGpioConfig: () => void; addGpioRow: () => void; removeGpioRow: (id: string) => void; handleGpioPinChange: (id: string, newPin: number) => void; getAvailableGpios: (excludeId?: string) => number[]; deviceOnline: boolean; deviceInfo: { deviceId?: string; firmware?: string; ip?: string; rssi?: number; uptime?: number; platform?: string; pumpRunning?: boolean; thermalAlarm?: boolean; mcpPresent?: boolean } | null; sensorHealth: Record<string, { stale: boolean; lastSeen: number | null }>; engineState: string; gpioLive: Record<number, number | boolean>; systemRunning: boolean; alarmCount: number; }) {
  const isEmbedded = useIsEmbedded();
  const [gpioKb, setGpioKb] = useState<{ id: string; field: 'label' | 'func' | 'inChannel' } | null>(null);
  const toggleGpioKb = (id: string, field: 'label' | 'func' | 'inChannel') => {
    setGpioKb(prev => (prev && prev.id === id && prev.field === field) ? null : { id, field });
  };
  const sensorById = new Map(zones.map((z) => [z.sensorId, z] as const));
  const okSensorCount = zones.filter((z) => deviceOnline && !sensorHealth[z.sensorId]?.stale).length;
  const sensorHardwarePins = SENSOR_HARDWARE_LINKS.map((pin) => {
    const zone = sensorById.get(pin.sensorId) ?? null;
    return {
      ...pin,
      zone,
      signal: zone ? sensorPinSignal(zone.sensorId, sensorHealth, deviceOnline) : pinSignal(gpioLive, pin.gpio, deviceOnline),
    };
  });
  const mcpUsedSignals: Record<number, PinSignal> = {};
  MCP_USED_OUTPUTS.forEach((pin) => { mcpUsedSignals[pin.gpio] = pinSignal(gpioLive, pin.gpio, deviceOnline); });
  const activeInputs = sensorHardwarePins.filter((pin) => pin.signal.active).length;
  const activeOutputs = SYSTEM_RELAYS.filter((pin) => mcpUsedSignals[pin.gpio]?.active).length;
  const activeFeedbacks = MCP_FEEDBACK_PINS.filter((pin) => mcpUsedSignals[pin.gpio]?.active).length;
  const espPinStatus = (pin: typeof ESP32_DIRECT_PINS[number]) => {
    if (pin.kind === 'sensor' && pin.sensorId) {
      const sig = sensorHardwarePins.find((entry) => entry.sensorId === pin.sensorId)?.signal ?? { known: false, active: false, value: null };
      if (!sig.known) return { tone: 'neutral', label: language === 'PT' ? 'Offline' : 'Offline' };
      return sig.active
        ? { tone: 'input', label: language === 'PT' ? 'INPUT' : 'INPUT' }
        : { tone: 'warning', label: language === 'PT' ? 'Sem sinal' : 'No signal' };
    }
    if (pin.kind === 'i2c') return { tone: deviceOnline ? 'link' : 'neutral', label: deviceOnline ? 'I2C' : (language === 'PT' ? 'Offline' : 'Offline') };
    if (pin.kind === 'power') return { tone: deviceOnline ? 'power' : 'neutral', label: '3V3' };
    if (pin.kind === 'ground') return { tone: deviceOnline ? 'ground' : 'neutral', label: '0V' };
    return { tone: 'free', label: language === 'PT' ? 'Livre' : 'Free' };
  };
  return (
    <div className="two-column">
      <Panel>
        <PanelHeader eyebrow="LEITURA EM TEMPO REAL" title="Estado dos equipamentos" />
        <div className="state-list">
          <StateRow icon={<Cpu />} title={language === "PT" ? "Controlador central" : "Central controller"} detail={deviceOnline && deviceInfo ? `${deviceInfo.deviceId || "ESP32-S3"} · fw ${deviceInfo.firmware || "—"} · ${deviceInfo.ip || "Wi-Fi"}` : (language === "PT" ? "ESP32-S3 · não reconhecido na rede" : "ESP32-S3 · not recognized on network")} status={deviceOnline ? "Online" : (language === "PT" ? "Offline" : "Offline")} active={deviceOnline} />
          <StateRow icon={<Power />} title="Bomba principal" detail="Relé K1 · Saída digital" status={pumpOn ? 'Ligada' : 'Desligada'} active={pumpOn} />
          {zones.map((z) => <StateRow key={z.id} icon={<Droplets />} title={`${z.name} · Válvula ${z.id}`} detail="Válvula solenóide" status={z.on ? 'Ligada' : 'Desligada'} active={z.on} />)}
          <StateRow
            icon={<Activity />}
            title={language === 'PT' ? 'Motor de controlo' : 'Control engine'}
            detail={`${language === 'PT' ? 'Estado' : 'State'}: ${engineState}${alarmCount > 0 ? ` · ${alarmCount} ${language === 'PT' ? 'alarme(s) ativo(s)' : 'active alarm(s)'}` : ''}`}
            status={alarmCount > 0 ? (language === 'PT' ? 'Alarme' : 'Alarme') : systemRunning ? (language === 'PT' ? 'Em funcionamento' : 'Running') : autoMode ? 'Automático' : (language === 'PT' ? 'Parado' : 'Stopped')}
            tone={alarmCount > 0 ? 'error' : systemRunning ? 'success' : autoMode ? 'blue' : 'neutral'}
          />
          {zones.map((z) => { const health = sensorHealth[z.sensorId]; const stale = !!health?.stale; return <StateRow key={`s-${z.sensorId}`} icon={<Radio />} title={`${z.name} · Sensor ${z.sensorId}`} detail={stale ? (language === 'PT' ? 'Sem sinal · Verificar ligação' : 'No signal · Check connection') : `Humidade do solo · ${z.moisture}%`} status={stale ? (language === 'PT' ? 'Sem sinal' : 'No signal') : 'Online'} active={!stale} />; })}
        </div>
      </Panel>
      <Panel>
        <PanelHeader eyebrow="MODO DE OPERAÇÃO" title="Automação" />
        <div className={`mode-card ${autoMode ? 'mode-card-auto' : 'mode-card-manual'}`}>
          <div className="mode-graphic"><Sparkles size={25} /></div>
          <div><strong>{autoMode ? 'Automático' : 'Manual'}</strong><p>{autoMode ? 'O sistema gere a rega com base nos setpoints.' : 'Os atuadores aguardam comandos manuais.'}</p></div>
          <StatusBadge tone={autoMode ? 'blue' : 'neutral'}>{autoMode ? (language === 'PT' ? 'Automático' : 'Automatic') : (language === 'PT' ? 'Manual' : 'Manual')}</StatusBadge>
        </div>
        <button className={`mode-toggle-btn ${autoMode ? 'mode-auto' : 'mode-manual'}`} onClick={onToggleMode}>
          <Settings2 size={15} />{autoMode ? 'Passar para Manual' : 'Passar para Automático'}
        </button>
        <div className="info-list">
          <div><span>{language === "PT" ? "Última sincronização" : "Last sync"}</span><strong>{deviceOnline ? (language === 'PT' ? 'Agora' : 'Now') : (language === "PT" ? "Sem contacto" : "No contact")}</strong></div>
          <div><span>{language === "PT" ? "Tempo de atividade" : "Uptime"}</span><strong>{deviceOnline && deviceInfo?.uptime ? formatUptime(deviceInfo.uptime) || "—" : "—"}</strong></div>
          <div><span>{language === "PT" ? "Versão do controlador" : "Controller version"}</span><strong>{deviceOnline && deviceInfo?.firmware ? `fw ${deviceInfo.firmware} · ${deviceInfo.deviceId || "ESP32-S3"}` : "—"}</strong></div>
          <div><span>{language === 'PT' ? 'Endereço IP' : 'IP address'}</span><strong>{deviceOnline && deviceInfo?.ip ? deviceInfo.ip : '—'}</strong></div>
          <div><span>{language === 'PT' ? 'Sinal Wi-Fi' : 'Wi-Fi signal'}</span><strong>{deviceOnline && typeof deviceInfo?.rssi === 'number' ? `${deviceInfo.rssi} dBm` : '—'}</strong></div>
          <div><span>{language === 'PT' ? 'Bomba em funcionamento (KM1)' : 'Pump running (KM1)'}</span><strong className={deviceInfo?.pumpRunning ? 'text-ok' : 'text-muted'}>{deviceOnline ? (deviceInfo?.pumpRunning ? (language === 'PT' ? 'Sim' : 'Yes') : (language === 'PT' ? 'Não' : 'No')) : '—'}</strong></div>
          <div><span>{language === 'PT' ? 'Relé térmico' : 'Thermal relay'}</span><strong className={deviceInfo?.thermalAlarm ? 'text-alarm' : 'text-ok'}>{deviceOnline ? (deviceInfo?.thermalAlarm ? (language === 'PT' ? 'ALARME TÉRMICO' : 'THERMAL ALARM') : (language === 'PT' ? 'Normal' : 'Normal')) : '—'}</strong></div>
          <div><span>{language === 'PT' ? 'Expansor I/O (MCP23017)' : 'I/O expander (MCP23017)'}</span><strong className={deviceInfo?.mcpPresent === false ? 'text-alarm' : 'text-ok'}>{deviceOnline ? (deviceInfo?.mcpPresent === false ? (language === 'PT' ? 'Ausente' : 'Missing') : (deviceInfo?.mcpPresent ? '0x20' : '—')) : '—'}</strong></div>
          <div><span>{language === 'PT' ? 'Sensores reconhecidos' : 'Recognized sensors'}</span><strong>{okSensorCount}/{zones.length}</strong></div>
        </div>
      </Panel>

      {/* Mapa de pinos GPIO + edição de pinos: apenas na versão web (PC/telemóvel/tablet) */}
      {!isEmbedded && (
        <Panel className="estado-pinout-panel" style={{ gridColumn: '1 / -1' }}>
          <div className="hw3-header">
            <div className="hw3-header-titles">
              <span className="section-kicker">HARDWARE</span>
              <h3>ES3C28P / ESP32-S3 + MCP23017</h3>
              <span className="hw3-subtitle">{language === 'PT' ? 'Mapa físico do controlador, barramento I²C e saídas do expansor' : 'Physical controller map, I²C bus and expander outputs'}</span>
            </div>
            <button className="gpio-edit-btn" onClick={() => setEditingGpio(editingGpio === null ? -1 : null)}>
              <Settings2 size={15} /> {editingGpio === null ? (language === 'PT' ? 'Editar mapa lógico' : 'Edit logical map') : (language === 'PT' ? 'Concluído' : 'Done')}
            </button>
          </div>

          <div className="hw4-diagram">
            <div className="hw4-column hw4-sensors">
              <div className="hw4-section-tag hw4-tag-input">INPUT</div>
              {sensorHardwarePins.map((pin) => (
                <div key={pin.sensorId} className="hw4-io-row">
                  <div className={`hw3-block hw3-block-input ${pin.zone ? (pin.signal.active ? 'hw3-block-live' : 'hw3-block-stale') : 'hw3-block-empty'}`}>
                    <span className="hw3-block-label">{pin.sensorId}</span>
                    <div className="hw3-block-info">
                      <strong>{pin.zone ? pin.zone.name : pin.title}</strong>
                      <span>{pin.zone ? `${pin.title} · ${pin.zone.moisture}%` : (language === 'PT' ? 'Sensor não configurado' : 'Sensor not configured')}</span>
                    </div>
                    <span className={`hw3-signal ${signalClass(pin.signal)}`}>
                      <span className="hw3-signal-dot" />
                      {pin.signal.known
                        ? (pin.signal.active ? (language === 'PT' ? 'A receber sinal' : 'Receiving signal') : (language === 'PT' ? 'Sem sinal' : 'No signal'))
                        : (language === 'PT' ? 'Offline' : 'Offline')}
                    </span>
                  </div>
                  <div className={`hw3-wire hw3-wire-input ${signalClass(pin.signal)}`}>
                    <span className="hw3-wire-dot" />
                    <span className="hw3-wire-line" />
                    <span className="hw3-wire-arrow" />
                  </div>
                </div>
              ))}
            </div>

            <div className="hw4-core">
              <div className="hw4-chip-frame hw4-chip-esp32">
                <div className="hw3-chip-header">
                  <span className="hw3-chip-icon"><Cpu size={18} /></span>
                  <div className="hw3-chip-titles">
                    <strong>ES3C28P · ESP32-S3</strong>
                    <span>{deviceOnline ? (language === 'PT' ? 'controlador reconhecido' : 'controller recognized') : (language === 'PT' ? 'controlador offline' : 'controller offline')}</span>
                  </div>
                  <span className={`hw3-chip-dot ${deviceOnline ? 'on' : 'off'}`} />
                </div>
                <div className="hw4-chip-body">
                  {ESP32_DIRECT_PINS.map((pin) => {
                    const status = espPinStatus(pin);
                    return (
                      <div key={pin.pin} className={`hw4-chip-row hw4-row-${pin.kind}`}>
                        <div className="hw4-chip-main">
                          <span className="hw4-chip-pin">{pin.pin}</span>
                          <div className="hw4-chip-copy">
                            <strong>{language === 'PT' ? pin.titlePT : pin.titleEN}</strong>
                            <span>{language === 'PT' ? pin.detailPT : pin.detailEN}</span>
                          </div>
                        </div>
                        <span className={`hw4-status-chip tone-${status.tone}`}>{status.label}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="hw4-free-gpios">
                  <div className="hw4-free-gpios-title">
                    {language === 'PT' ? 'GPIOs livres · ESP32-S3' : 'Free GPIOs · ESP32-S3'}
                    <span>{ESP32_FREE_GPIO_PINS.length} {language === 'PT' ? 'disponíveis' : 'available'}</span>
                  </div>
                  <div className="hw4-free-gpios-grid">
                    {ESP32_FREE_GPIO_PINS.map((pin) => (
                      <span key={pin.pin} className="hw4-free-gpio">
                        <span className="hw4-chip-pin hw4-chip-pin-free">{pin.pin}</span>
                        <span className="hw4-free-gpio-state">{language === 'PT' ? 'Livre' : 'Free'}</span>
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div className="hw4-bus-bridge">
                <div className="hw4-section-tag hw4-tag-bus">I²C</div>
                {I2C_BUS_PINS.map((bus) => (
                  <div key={bus.label} className="hw4-bus-row">
                    <span className="hw4-bus-end">{bus.espPin}</span>
                    <span className="hw4-bus-line" />
                    <span className="hw4-bus-mid">{bus.label}</span>
                    <span className="hw4-bus-line" />
                    <span className="hw4-bus-end">{bus.mcpPin}</span>
                  </div>
                ))}
              </div>

              <div className="hw4-chip-frame hw4-chip-mcp">
                <div className="hw3-chip-header">
                  <span className="hw3-chip-icon"><CircuitBoard size={18} /></span>
                  <div className="hw3-chip-titles">
                    <strong>MCP23017</strong>
                    <span>{language === 'PT' ? 'Expansor I/O · endereço 0x20' : 'I/O expander · address 0x20'}</span>
                  </div>
                  <span className={`hw3-chip-dot ${deviceInfo?.mcpPresent === false ? 'off' : 'on'}`} />
                </div>
                <div className="hw4-mcp-controls">
                  {MCP_CONTROL_PINS.map((pin) => (
                    <div key={pin.pin} className="hw4-mcp-control-row">
                      <span className="hw4-chip-pin">{pin.pin}</span>
                      <span>{language === 'PT' ? pin.funcPT : pin.funcEN}</span>
                    </div>
                  ))}
                </div>
                <div className="hw4-mcp-sides">
                  <div className="hw4-mcp-side hw4-mcp-side-a">
                    <div className="hw4-mcp-side-title">
                      <span className="hw4-mcp-side-badge hw4-mcp-side-badge-a">A</span>
                      PORTO A
                      <span className="hw4-mcp-side-sub">{language === 'PT' ? 'Lado azul · saídas do processo' : 'Blue side · process outputs'}</span>
                    </div>
                    {MCP_PORT_A_PINS.map((pin) => {
                      const sig = mcpUsedSignals[pin.gpio] ?? { known: false, active: false, value: null };
                      return (
                        <div key={pin.relay} className={`hw4-mcp-pin-row ${signalClass(sig)}`}>
                          <span className="hw4-chip-pin">{pin.relay}</span>
                          <div className="hw4-mcp-pin-copy">
                            <strong>{pin.func}</strong>
                            <span>IDX {pin.gpio}{pin.inChannel ? ` · ${pin.inChannel}` : ''}</span>
                          </div>
                          <span className="hw4-status-chip tone-output">OUTPUT</span>
                        </div>
                      );
                    })}
                  </div>
                  <div className="hw4-mcp-side hw4-mcp-side-b">
                    <div className="hw4-mcp-side-title">
                      <span className="hw4-mcp-side-badge hw4-mcp-side-badge-b">B</span>
                      PORTO B
                      <span className="hw4-mcp-side-sub">{language === 'PT' ? 'Lado verde · entradas / saídas' : 'Green side · inputs / outputs'}</span>
                    </div>
                    {MCP_PORT_B_PINS.map((pin) => {
                      const sig = mcpUsedSignals[pin.gpio] ?? { known: false, active: false, value: null };
                      return (
                        <div key={pin.relay} className={`hw4-mcp-pin-row ${pin.direction === 'FREE' ? 'sig-free' : signalClass(sig)}`}>
                          <span className="hw4-chip-pin">{pin.relay}</span>
                          <div className="hw4-mcp-pin-copy">
                            <strong>{pin.func}</strong>
                            <span>IDX {pin.gpio}{pin.inChannel ? ` · ${pin.inChannel}` : ''}</span>
                          </div>
                          <span className={`hw4-status-chip ${pin.direction === 'OUTPUT' ? 'tone-output' : pin.direction === 'INPUT' ? 'tone-input' : 'tone-free'}`}>{pin.direction}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div className="hw4-column hw4-outputs">
              <div className="hw4-section-tag hw4-tag-output">OUTPUTS</div>
              {SYSTEM_RELAYS.map((pin) => {
                const sig = mcpUsedSignals[pin.gpio] ?? { known: false, active: false, value: null };
                return (
                  <div key={pin.relay} className="hw4-io-row hw4-io-row-right">
                    <div className={`hw3-wire hw3-wire-output ${signalClass(sig)}`}>
                      <span className="hw3-wire-dot" />
                      <span className="hw3-wire-line" />
                      <span className="hw3-wire-arrow" />
                    </div>
                    <div className={`hw3-block hw3-block-output ${signalClass(sig)}`}>
                      <span className="hw3-block-label">{pin.relay}</span>
                      <div className="hw3-block-info">
                        <strong>{pin.func}</strong>
                        <span>{pin.inChannel || '—'} · IDX {pin.gpio}</span>
                      </div>
                      <span className={`hw3-signal ${signalClass(sig)}`}>
                        <span className="hw3-signal-dot" />
                        {sig.known ? (sig.active ? (language === 'PT' ? 'A emitir sinal' : 'Emitting signal') : (language === 'PT' ? 'Sem sinal' : 'No signal')) : (language === 'PT' ? 'Offline' : 'Offline')}
                      </span>
                    </div>
                  </div>
                );
              })}
              <div className="hw4-section-tag hw4-tag-feedback">FEEDBACKS</div>
              {MCP_FEEDBACK_PINS.map((pin) => {
                const sig = mcpUsedSignals[pin.gpio] ?? { known: false, active: false, value: null };
                return (
                  <div key={pin.relay} className="hw4-io-row hw4-io-row-right">
                    <div className={`hw3-wire hw3-wire-output ${signalClass(sig)}`}>
                      <span className="hw3-wire-dot" />
                      <span className="hw3-wire-line" />
                      <span className="hw3-wire-arrow" />
                    </div>
                    <div className={`hw3-block hw3-block-output hw4-feedback-block ${signalClass(sig)}`}>
                      <span className="hw3-block-label">{pin.relay}</span>
                      <div className="hw3-block-info">
                        <strong>{pin.func}</strong>
                        <span>{pin.inChannel} · IDX {pin.gpio}</span>
                      </div>
                      <span className={`hw3-signal ${signalClass(sig)}`}>
                        <span className="hw3-signal-dot" />
                        {sig.known ? (sig.active ? (language === 'PT' ? 'Entrada ativa' : 'Input active') : (language === 'PT' ? 'Entrada inativa' : 'Input idle')) : (language === 'PT' ? 'Offline' : 'Offline')}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Legend */}
          <div className="hw3-legend hw4-legend">
            <span className="hw3-legend-title">{language === 'PT' ? 'LEGENDA' : 'LEGEND'}</span>
            <div className="hw3-legend-item">
              <span className="hw3-legend-dot hw3-legend-green" />
              <span className="hw3-legend-label">INPUT</span>
              <span className="hw3-legend-desc">{language === 'PT' ? 'Sensores / feedbacks' : 'Sensors / feedbacks'}</span>
            </div>
            <div className="hw3-legend-item">
              <span className="hw3-legend-dot hw3-legend-orange" />
              <span className="hw3-legend-label">OUTPUT</span>
              <span className="hw3-legend-desc">{language === 'PT' ? 'Comandos do processo' : 'Process commands'}</span>
            </div>
            <div className="hw3-legend-item">
              <span className="hw3-legend-dot hw4-legend-blue" />
              <span className="hw3-legend-label">PORT A</span>
              <span className="hw3-legend-desc">{language === 'PT' ? 'Lado azul do MCP23017' : 'Blue side of MCP23017'}</span>
            </div>
            <div className="hw3-legend-item">
              <span className="hw3-legend-dot hw4-legend-teal" />
              <span className="hw3-legend-label">PORT B</span>
              <span className="hw3-legend-desc">{language === 'PT' ? 'Lado verde do MCP23017' : 'Green side of MCP23017'}</span>
            </div>
            <div className="hw3-legend-live">
              <span className="hw3-legend-desc">{language === 'PT' ? 'Sensores ativos' : 'Active sensors'}: <b>{activeInputs}/{sensorHardwarePins.length}</b></span>
              <span className="hw3-legend-desc">{language === 'PT' ? 'Saídas ativas' : 'Active outputs'}: <b>{activeOutputs}/{SYSTEM_RELAYS.length}</b></span>
              <span className="hw3-legend-desc">{language === 'PT' ? 'Feedbacks ativos' : 'Active feedbacks'}: <b>{activeFeedbacks}/{MCP_FEEDBACK_PINS.length}</b></span>
              <span className={`hw3-legend-desc ${deviceOnline ? 'sig-active' : 'sig-unknown'}`}>{deviceOnline ? (language === 'PT' ? 'Telemetria real' : 'Live telemetry') : (language === 'PT' ? 'Controlador offline' : 'Controller offline')}</span>
            </div>
          </div>

          {/* Editable GPIO Table */}
          {editingGpio !== null && (
            <div className="gpio-edit-table-wrap">
              <div className="gpio-edit-table-heading">
                <h4>{language === 'PT' ? 'Editar configuração GPIO' : 'Edit GPIO Configuration'}</h4>
                <span className="gpio-edit-count">
                  {gpioConfig.length}/{ESP32S3_ALL_GPIOS.length} {language === 'PT' ? 'GPIOs em uso' : 'GPIOs in use'}
                </span>
              </div>
              <div className="gpio-edit-table-scroll">
              <table className="gpio-edit-table">
                <thead>
                  <tr>
                    <th>{language === 'PT' ? 'GPIO / IDX' : 'GPIO / IDX'}</th>
                    <th>{language === 'PT' ? 'Direção' : 'Direction'}</th>
                    <th>{language === 'PT' ? 'Rótulo' : 'Label'}</th>
                    <th>{language === 'PT' ? 'Função' : 'Function'}</th>
                    <th>{language === 'PT' ? 'Canal Relé' : 'Relay Channel'}</th>
                    <th>{language === 'PT' ? 'Ações' : 'Actions'}</th>
                  </tr>
                </thead>
                <tbody>
                  {gpioConfig.map((g) => {
                    const isMcpLogicalRow = g.direction === 'OUTPUT' && /^P[AB]\d$/.test(g.label);
                    const pinOptions = [g.gpio, ...getAvailableGpios(g.id)]
                      .filter((p, i, arr) => arr.indexOf(p) === i)
                      .sort((a, b) => a - b)
                      .map(p => ({ value: p, label: `GPIO ${p}` }));
                    return (
                      <tr key={g.id}>
                        <td>
                          {isMcpLogicalRow ? (
                            <span className="gpio-fixed-badge">{g.label} · IDX {g.gpio}</span>
                          ) : (
                            <BrandSelect
                              value={g.gpio}
                              options={pinOptions}
                              onChange={(v) => handleGpioPinChange(g.id, v)}
                              className="brand-select-pin"
                            />
                          )}
                        </td>
                        <td>
                          <BrandSelect
                            value={g.direction}
                            options={[
                              { value: 'INPUT', label: 'INPUT' },
                              { value: 'OUTPUT', label: 'OUTPUT' },
                            ]}
                            onChange={(v) => handleGpioUpdate(g.id, 'direction', v)}
                            className="brand-select-direction"
                          />
                        </td>
                        <td>
                          <div className="gpio-field">
                            <input className="gpio-input" value={g.label} onChange={(e) => handleGpioUpdate(g.id, 'label', e.target.value)} />
                            <button type="button" className={`gpio-kb-toggle ${gpioKb?.id === g.id && gpioKb.field === 'label' ? 'active' : ''}`} onClick={() => toggleGpioKb(g.id, 'label')} aria-label={language === 'PT' ? 'Teclado virtual' : 'Virtual keyboard'}>
                              <Keyboard size={13} />
                            </button>
                          </div>
                        </td>
                        <td>
                          <div className="gpio-field">
                            <input className="gpio-input" value={g.func} onChange={(e) => handleGpioUpdate(g.id, 'func', e.target.value)} />
                            <button type="button" className={`gpio-kb-toggle ${gpioKb?.id === g.id && gpioKb.field === 'func' ? 'active' : ''}`} onClick={() => toggleGpioKb(g.id, 'func')} aria-label={language === 'PT' ? 'Teclado virtual' : 'Virtual keyboard'}>
                              <Keyboard size={13} />
                            </button>
                          </div>
                        </td>
                        <td>
                          <div className="gpio-field">
                            <input className="gpio-input gpio-input-sm" value={g.inChannel} onChange={(e) => handleGpioUpdate(g.id, 'inChannel', e.target.value)} placeholder="IN—" />
                            <button type="button" className={`gpio-kb-toggle ${gpioKb?.id === g.id && gpioKb.field === 'inChannel' ? 'active' : ''}`} onClick={() => toggleGpioKb(g.id, 'inChannel')} aria-label={language === 'PT' ? 'Teclado virtual' : 'Virtual keyboard'}>
                              <Keyboard size={13} />
                            </button>
                          </div>
                        </td>
                        <td>
                          <button type="button" className="gpio-row-delete" onClick={() => removeGpioRow(g.id)} aria-label={language === 'PT' ? 'Remover GPIO' : 'Remove GPIO'} title={language === 'PT' ? 'Remover esta entrada/saída' : 'Remove this input/output'}>
                            <Trash2 size={14} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
              <button type="button" className="gpio-add-btn" onClick={addGpioRow} disabled={getAvailableGpios().length === 0}>
                <Plus size={15} /> {language === 'PT' ? 'Adicionar GPIO' : 'Add GPIO'}
              </button>
              <p className="gpio-reserved-note">
                {language === 'PT'
                  ? `Referência do hardware: IO21/IO14 = DHT22, IO16/IO18 = barramento I²C do MCP23017, 3VCC/GND = alimentação comum. PA0..PA7 e PB0..PB7 são pinos lógicos do MCP23017; por isso aparecem como IDX no editor.`
                  : `Hardware reference: IO21/IO14 = DHT22, IO16/IO18 = MCP23017 I²C bus, 3VCC/GND = shared power. PA0..PA7 and PB0..PB7 are MCP23017 logical pins, so they appear as IDX in the editor.`}
              </p>
              <button className="save-btn" onClick={saveGpioConfig}>
                <Save size={15} /> {language === 'PT' ? 'Guardar configuração GPIO' : 'Save GPIO configuration'}
              </button>
              {gpioKb && (() => {
                const row = gpioConfig.find(r => r.id === gpioKb.id);
                if (!row) return null;
                const fieldLabels: Record<string, { PT: string; EN: string }> = {
                  label: { PT: 'Rótulo', EN: 'Label' },
                  func: { PT: 'Função', EN: 'Function' },
                  inChannel: { PT: 'Canal Relé', EN: 'Relay Channel' },
                };
                const value = (row as unknown as Record<string, string>)[gpioKb.field] || '';
                return (
                  <FullKeyboard
                    value={value}
                    onChange={(v) => handleGpioUpdate(row.id, gpioKb.field, v)}
                    onSubmit={() => setGpioKb(null)}
                    onClose={() => setGpioKb(null)}
                    language={language}
                    title={`GPIO ${row.gpio} · ${language === 'PT' ? fieldLabels[gpioKb.field].PT : fieldLabels[gpioKb.field].EN}`}
                    hint={language === 'PT' ? 'Também pode escrever com o teclado físico' : 'You can also type using your physical keyboard'}
                  />
                );
              })()}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

function EmbeddedUnavailable({ language }: { language: Language }) {
  return (
    <div className="two-column">
      <Panel style={{ gridColumn: '1 / -1' }}>
        <PanelHeader
          eyebrow="HARDWARE"
          title={language === 'PT' ? 'Disponível apenas na versão web' : 'Available only in the web version'}
        />
        <div className="empty-state">
          <MapIcon size={26} />
          <span>{language === 'PT'
            ? 'O mapa de pinos, a edição de pinos e o mapa de sensores e válvulas estão disponíveis apenas na versão web (PC, telemóvel ou tablet).'
            : 'The pin map, pin editing and the sensor/valve location map are available only in the web version (PC, phone or tablet).'}</span>
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

function StateRow({ icon, title, detail, status, active, tone }: { icon: React.ReactNode; title: string; detail: string; status: string; active?: boolean; tone?: 'success' | 'warning' | 'error' | 'neutral' | 'cyan' | 'blue' }) {
  // Semântica de cores: verde = online / em funcionamento, vermelho = alarme,
  // laranja = offline / sem sinal, azul = modo automático.
  const resolved: 'success' | 'warning' | 'error' | 'neutral' | 'cyan' | 'blue' = tone ?? (
    status === 'Online' || status === 'Ligada' || status === 'Ligado' || status === 'Running' || status === 'Em funcionamento' ? 'success' :
    status === 'Offline' || status === 'Desligada' || status === 'Desligado' || status === 'No signal' || status === 'Sem sinal' ? 'warning' :
    status === 'Alarme' ? 'error' :
    status === 'Automático' || status === 'Automatic' ? 'blue' :
    status === 'Atenção' ? 'warning' :
    active ? 'success' : 'warning');
  return <div className={`state-row state-row-${resolved}`}><span className={`state-icon state-icon-${resolved}`}>{icon}</span><div><strong>{title}</strong><span>{detail}</span></div><StatusBadge tone={resolved}>{status}</StatusBadge></div>;
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
  const [savedAll, setSavedAll] = useState(false);
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

  // Check if there's anything to save at all
  const hasAnyPending = Object.values(pending).some(v => v !== undefined);
  const pendingCount = Object.values(pending).filter(v => v !== undefined).length;

  const saveAllSetpoints = () => {
    // Save all pending setpoint changes
    Object.entries(pending).forEach(([id, value]) => {
      if (value !== undefined) {
        onChange(id, value);
      }
    });
    setPending({});
    // Sync all zones (with current schedules + waterDuration) to backend
    // This ensures pumpDelay and all zone configs are persisted
    setSavedAll(true);
    showNotice(language === 'PT' ? 'Tudo guardado! Setpoints, horários e configurações sincronizados.' : 'All saved! Setpoints, schedules and settings synced.');
    setTimeout(() => setSavedAll(false), 2500);
  };

  return (
    <>
      {/* ── Save-all banner no topo ── */}
      {(hasAnyPending || true) && (
        <div className={`setpoint-save-all-banner ${hasAnyPending ? 'has-pending' : 'all-ok'} ${savedAll ? 'just-saved' : ''}`}>
          <div className="save-all-banner-left">
            <div className={`save-all-banner-icon ${hasAnyPending ? 'icon-pending' : 'icon-ok'}`}>
              {savedAll ? <CheckCircle2 size={22} /> : hasAnyPending ? <Save size={22} /> : <CheckCircle2 size={22} />}
            </div>
            <div>
              <strong>
                {savedAll
                  ? (language === 'PT' ? 'Configuração guardada com sucesso!' : 'Configuration saved successfully!')
                  : hasAnyPending
                    ? (language === 'PT' ? `${pendingCount} setpoint(s) por guardar` : `${pendingCount} setpoint(s) pending`)
                    : (language === 'PT' ? 'Todos os setpoints estão atualizados' : 'All setpoints are up to date')}
              </strong>
              <span>
                {savedAll
                  ? (language === 'PT' ? 'Setpoints, horários e delay sincronizados com o controlador' : 'Setpoints, schedules and delay synced with controller')
                  : (language === 'PT' ? 'Clique em "Guardar tudo" para aplicar setpoints, horários e delay da bomba' : 'Click "Save all" to apply setpoints, schedules and pump delay')}
              </span>
            </div>
          </div>
          <button
            className={`save-all-banner-btn ${hasAnyPending ? 'btn-pending' : 'btn-ok'} ${savedAll ? 'btn-saved' : ''}`}
            onClick={saveAllSetpoints}
            disabled={savedAll}
          >
            {savedAll ? (
              <><CheckCircle2 size={17} /> {language === 'PT' ? 'Guardado!' : 'Saved!'}</>
            ) : hasAnyPending ? (
              <><Save size={17} /> {language === 'PT' ? 'Guardar tudo' : 'Save all'}</>
            ) : (
              <><RefreshCw size={17} /> {language === 'PT' ? 'Sincronizar' : 'Sync'}</>
            )}
          </button>
        </div>
      )}
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

            {/* Humidade atual + slider de setpoint, lado a lado */}
            <div className="sp2-metrics-row">
              <div className="sp2-current">
                <strong>{zone.moisture}<small>%</small></strong>
                <span>{language === 'PT' ? 'Humidade atual' : 'Current moisture'}</span>
              </div>

              <div className="sp2-slider-section">
                <div className="sp2-slider-label-row">
                  <span className="sp2-slider-label">{language === 'PT' ? 'Humidade mínima desejada' : 'Minimum desired moisture'}</span>
                  <span className={`sp2-slider-value ${dirty ? 'sp2-slider-value-dirty' : ''}`}>{displayTarget}%</span>
                </div>
                <div className="sp2-slider-row">
                  <input
                    type="range" min="20" max="90" value={displayTarget}
                    onChange={(e) => handleSlide(zone.id, Number(e.target.value))}
                    onInput={(e) => handleSlide(zone.id, Number((e.target as HTMLInputElement).value))}
                    className={`sp2-range ${dirty ? 'sp2-range-dirty' : ''}`}
                    title={`${displayTarget}%`}
                    aria-label={language === 'PT' ? 'Humidade mínima desejada' : 'Minimum desired moisture'}
                    aria-valuetext={`${displayTarget}%`}
                  />
                </div>
                <div className="sp2-range-labels"><span>20%</span><span>90%</span></div>
              </div>
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
  weather: { temp: number; desc: string; city: string; country: string; icon: string; humidity: number; precipitation: number; windSpeed: number; rainChance: number };
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
        <div className="map-primary-btns">
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
        </div>
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
                ? <span className="gpio-chip"><CircuitBoard size={13} /> ESP32 GPIO {SENSOR_GPIO_MAP[selectedZone.sensorId]} · DHT22</span>
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
            <div><span className="section-kicker">HARDWARE</span><h3>ES3C28P / ESP32-S3 + MCP23017 · Mapa de I/O</h3></div>
            <button className="pinout-close" onClick={() => setShowPinout(false)} aria-label="Fechar"><X size={16} /></button>
          </div>
          <div className="pinout-grid">
            <div className="pinout-section">
              <div className="pinout-section-title"><Cpu size={14} /> ESP32 — pinos diretos</div>
              {ESP32_DIRECT_PINS.map((pin) => (
                <div key={pin.pin} className="pinout-row">
                  <span className="pinout-pin">{pin.pin}</span>
                  <span className="pinout-label">{language === 'PT' ? pin.titlePT : pin.titleEN}</span>
                  <span className="pinout-desc">{language === 'PT' ? pin.detailPT : pin.detailEN}</span>
                </div>
              ))}
            </div>
            <div className="pinout-section">
              <div className="pinout-section-title"><Radio size={14} /> Sensores DHT22</div>
              {SENSOR_HARDWARE_LINKS.map((pin) => {
                const zone = zones.find((z) => z.sensorId === pin.sensorId);
                return (
                  <div key={pin.sensorId} className="pinout-row">
                    <span className="pinout-pin">GPIO {pin.gpio}</span>
                    <span className="pinout-label">{pin.sensorId} · {pin.title}</span>
                    <span className="pinout-desc">{zone ? zone.name : (language === 'PT' ? 'Sensor não configurado' : 'Sensor not configured')}</span>
                  </div>
                );
              })}
            </div>
            <div className="pinout-section">
              <div className="pinout-section-title"><CircuitBoard size={14} /> MCP23017 — controlo / I²C</div>
              {MCP_CONTROL_PINS.map((pin) => (
                <div key={pin.pin} className="pinout-row">
                  <span className="pinout-pin">{pin.pin}</span>
                  <span className="pinout-label">MCP23017</span>
                  <span className="pinout-desc">{language === 'PT' ? pin.funcPT : pin.funcEN}</span>
                </div>
              ))}
            </div>
            <div className="pinout-section">
              <div className="pinout-section-title"><ArrowBigUp size={14} /> Porto A — azul</div>
              {MCP_PORT_A_PINS.map((pin) => (
                <div key={pin.relay} className="pinout-row">
                  <span className="pinout-pin">IDX {pin.gpio}</span>
                  <span className="pinout-label">{pin.relay}{pin.inChannel ? ` · ${pin.inChannel}` : ''}</span>
                  <span className="pinout-desc">{pin.func}</span>
                </div>
              ))}
            </div>
            <div className="pinout-section">
              <div className="pinout-section-title"><Leaf size={14} /> Porto B — verde</div>
              {MCP_PORT_B_PINS.map((pin) => (
                <div key={pin.relay} className="pinout-row">
                  <span className="pinout-pin">IDX {pin.gpio}</span>
                  <span className="pinout-label">{pin.relay}{pin.inChannel ? ` · ${pin.inChannel}` : ''}</span>
                  <span className="pinout-desc">{pin.func}</span>
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
          <button className="kb-clear" onClick={() => onChange('')} aria-label="Limpar" title="Limpar"><Eraser size={16} /></button>
          <button className="kb-confirm" onClick={onSubmit} aria-label="Confirmar" title="Confirmar"><Check size={18} /></button>
        </div>
      </div>
    </div>
  );
}

/* ---------- Full Keyboard (layout tipo teclado físico completo) ---------- */
const PK_ROW_TOP = ['`', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '='];
const PK_ROW_2 = ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']', '\\'];
const PK_ROW_3 = ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'"];
const PK_ROW_4 = ['Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/'];
const isLetterKey = (k: string) => /^[A-Z]$/.test(k);

function FullKeyboard({ value, onChange, onSubmit, onClose, title, language, hint }: { value: string; onChange: (v: string) => void; onSubmit: () => void; onClose: () => void; title?: string; language?: Language; hint?: string }) {
  const [shift, setShift] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  useCloseOnEscape(onClose);

  // Shift e Caps Lock funcionam como num teclado físico: Shift é de disparo único,
  // Caps Lock mantém-se ativo até ser desligado. Os dois combinados anulam-se (XOR).
  const upper = shift !== capsLock;
  const caseChar = (k: string) => (upper ? k.toUpperCase() : k.toLowerCase());

  const insertLetter = (k: string) => {
    onChange(value + caseChar(k));
    if (shift) setShift(false);
  };
  const insertChar = (c: string) => onChange(value + c);
  const backspace = () => onChange(value.slice(0, -1));

  const renderKey = (k: string) => (
    <button
      key={k}
      className="pk-key"
      onMouseDown={preventFocusSteal}
      onClick={() => (isLetterKey(k) ? insertLetter(k) : insertChar(k))}
    >
      {isLetterKey(k) ? caseChar(k) : k}
    </button>
  );

  return (
    <div className="keyboard-overlay" onClick={onClose}>
      <div className="keyboard full-keyboard" onClick={(e) => e.stopPropagation()}>
        <div className="keyboard-header">
          <span>{title || (language === 'PT' ? 'Editar texto' : 'Edit text')}</span>
          <button onClick={onClose} aria-label={language === 'PT' ? 'Fechar' : 'Close'}><X size={18} /></button>
        </div>
        <div className="keyboard-display text-display">{value || ' '}</div>
        {hint && <div className="keyboard-hint">{hint}</div>}

        <div className="pk-body">
          <div className="pk-row">
            {PK_ROW_TOP.map((k) => renderKey(k))}
            <button className="pk-key pk-backspace" onMouseDown={preventFocusSteal} onClick={backspace} aria-label={language === 'PT' ? 'Apagar' : 'Backspace'}>
              <Delete size={16} />
            </button>
          </div>
          <div className="pk-row">
            <button className="pk-key pk-tab" disabled aria-disabled="true" title="Tab"><CornerDownLeft size={13} style={{ transform: 'scaleX(-1)' }} /></button>
            {PK_ROW_2.map((k) => renderKey(k))}
          </div>
          <div className="pk-row">
            <button
              className={`pk-key pk-caps ${capsLock ? 'active' : ''}`}
              onMouseDown={preventFocusSteal}
              onClick={() => setCapsLock((c) => !c)}
              aria-label={language === 'PT' ? 'Bloqueio de maiúsculas' : 'Caps Lock'}
              aria-pressed={capsLock}
            >
              <ArrowUpToLine size={14} />
            </button>
            {PK_ROW_3.map((k) => renderKey(k))}
            <button className="pk-key pk-enter" onMouseDown={preventFocusSteal} onClick={onSubmit} aria-label={language === 'PT' ? 'Entrar' : 'Enter'} title={language === 'PT' ? 'Entrar' : 'Enter'}>
              <CornerDownLeft size={15} />
            </button>
          </div>
          <div className="pk-row">
            <button
              className={`pk-key pk-shift ${shift ? 'active' : ''}`}
              onMouseDown={preventFocusSteal}
              onClick={() => setShift((s) => !s)}
              aria-label={language === 'PT' ? 'Maiúscula' : 'Shift'}
              aria-pressed={shift}
            >
              <ArrowBigUp size={16} />
            </button>
            {PK_ROW_4.map((k) => renderKey(k))}
            <button
              className={`pk-key pk-shift ${shift ? 'active' : ''}`}
              onMouseDown={preventFocusSteal}
              onClick={() => setShift((s) => !s)}
              aria-label={language === 'PT' ? 'Maiúscula' : 'Shift'}
              aria-pressed={shift}
            >
              <ArrowBigUp size={16} />
            </button>
          </div>
          <div className="pk-row">
            <button className="pk-key pk-ctrl" disabled aria-disabled="true" title={language === 'PT' ? 'Não aplicável neste campo' : 'Not applicable in this field'}><span className="pk-mod">^</span></button>
            <button className="pk-key pk-alt" disabled aria-disabled="true" title={language === 'PT' ? 'Não aplicável neste campo' : 'Not applicable in this field'}><span className="pk-mod">⌥</span></button>
            <button className="pk-key pk-space" onMouseDown={preventFocusSteal} onClick={() => insertChar(' ')} aria-label={language === 'PT' ? 'Espaço' : 'Space'} title={language === 'PT' ? 'Espaço' : 'Space'}>
              <SpaceIcon size={16} />
            </button>
            <button className="pk-key pk-alt" disabled aria-disabled="true" title={language === 'PT' ? 'Não aplicável neste campo' : 'Not applicable in this field'}><span className="pk-mod">⌥</span></button>
            <button className="pk-key pk-ctrl" disabled aria-disabled="true" title={language === 'PT' ? 'Não aplicável neste campo' : 'Not applicable in this field'}><span className="pk-mod">^</span></button>
          </div>
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
  // Teclado virtual para os campos de utilizador e senha
  const [kbTarget, setKbTarget] = useState<'username' | 'password' | null>(null);
  const openKb = (field: 'username' | 'password') => setKbTarget((prev) => (prev === field ? null : field));
  const kbValue = kbTarget === 'username' ? username : kbTarget === 'password' ? password : '';
  const handleKbChange = (v: string) => {
    if (kbTarget === 'username') setUsername(v);
    else if (kbTarget === 'password') setPassword(v);
  };

  return (
    <>
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
          <label className="field-label">
            {t('settings.username', language)}
            <div className="field-input-group">
              <input value={username} onChange={(e) => setUsername(e.target.value)} />
              <button
                type="button"
                className={`field-kb-toggle ${kbTarget === 'username' ? 'active' : ''}`}
                onClick={() => openKb('username')}
                aria-label={language === 'PT' ? 'Abrir teclado virtual' : 'Open virtual keyboard'}
                aria-pressed={kbTarget === 'username'}
              >
                <Keyboard size={16} />
              </button>
            </div>
          </label>
          <label className="field-label">
            {t('settings.password', language)}
            <div className="field-input-group">
              <input type="password" placeholder={t('settings.passwordPlaceholder', language)} value={password} onChange={(e) => setPassword(e.target.value)} />
              <button
                type="button"
                className={`field-kb-toggle ${kbTarget === 'password' ? 'active' : ''}`}
                onClick={() => openKb('password')}
                aria-label={language === 'PT' ? 'Abrir teclado virtual' : 'Open virtual keyboard'}
                aria-pressed={kbTarget === 'password'}
              >
                <Keyboard size={16} />
              </button>
            </div>
          </label>
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
    {kbTarget && (
      <FullKeyboard
        value={kbValue}
        onChange={handleKbChange}
        onSubmit={() => setKbTarget(null)}
        onClose={() => setKbTarget(null)}
        title={kbTarget === 'username' ? t('settings.username', language) : t('settings.password', language)}
        hint={language === 'PT' ? 'Também pode escrever com o teclado físico' : 'You can also type using your physical keyboard'}
        language={language}
      />
    )}
    </>
  );
}

/* ---------- Histórico de Erros + Eventos Reais ---------- */
function HistoryView({ errors, eventLog, eventLogLoading, onRefresh, language }: { errors: ErrorEvent[]; eventLog: EventLogEntry[]; eventLogLoading: boolean; onRefresh: () => void; language: Language }) {
  // Mostrar TODOS os eventos reais, agrupados por severidade para destaque
  const allEvents = [...eventLog].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const irrigationEvents = allEvents.filter((e) =>
    ['zone_toggle', 'system_start', 'system_stop', 'system_reset', 'emergency_stop', 'test_cycle', 'mode_change', 'pump_toggle',
     'device_connected', 'device_disconnected', 'device_reconnected', 'device_offline', 'device_unauthorized', 'device_never_connected',
     'sensor_stale', 'sensor_recovered', 'sensor_unrecognized', 'schedule_trigger', 'cycle_complete',
     'watchdog_triggered', 'timer_relay_trip', 'watering_all_start', 'watering_skip', 'watering_start',
     'zone_add', 'zone_remove', 'zone_rename', 'layout_save', 'cycle_continue'].includes(e.event_type)
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
    device_unauthorized: language === 'PT' ? 'ESP32 não reconhecido' : 'ESP32 unrecognized',
    device_never_connected: language === 'PT' ? 'ESP32 não reconhecido' : 'ESP32 unrecognized',
    sensor_stale: language === 'PT' ? 'Sensor' : 'Sensor',
    sensor_recovered: language === 'PT' ? 'Sensor' : 'Sensor',
    sensor_unrecognized: language === 'PT' ? 'Sensor não reconhecido' : 'Sensor unrecognized',
    schedule_trigger: language === 'PT' ? 'Horário' : 'Schedule',
    cycle_complete: language === 'PT' ? 'Ciclo' : 'Cycle',
    cycle_continue: language === 'PT' ? 'Ciclo' : 'Cycle',
    watchdog_triggered: language === 'PT' ? 'Watchdog' : 'Watchdog',
    timer_relay_trip: language === 'PT' ? 'Relé temporizador' : 'Timer relay',
    watering_all_start: language === 'PT' ? 'Rega' : 'Watering',
    watering_start: language === 'PT' ? 'Rega' : 'Watering',
    watering_skip: language === 'PT' ? 'Rega' : 'Watering',
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
          <span className={`history-severity hist-sev-${event.severity}`}>{severityLabel(event.severity, language)}</span>
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
          <div className="alarm-item-actions">
            <span className={`alarm-item-badge alarm-badge-${event.severity}`}>
              {isCritical ? (language === 'PT' ? 'CRÍTICO' : 'CRITICAL') : isWarning ? (language === 'PT' ? 'AVISO' : 'WARNING') : 'INFO'}
            </span>
            {!event.resolved && onResolve ? (
              <button className="resolve-btn" onClick={onResolve}><CheckCircle2 size={14} />{language === 'PT' ? 'Resolver' : 'Resolve'}</button>
            ) : event.resolved ? (
              <span className="resolved-badge"><CheckCircle2 size={13} />{language === 'PT' ? 'Resolvido' : 'Resolved'}</span>
            ) : null}
          </div>
        </div>
        <span className="alarm-item-msg">{event.message}</span>
        <div className="alarm-meta"><small>{event.time}</small><span className="alarm-id">{event.id}</span></div>
      </div>
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
          <div className="login-brand-mark"><img src={gtcIcon} alt="GTC Rega" /></div>
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

/* ---------- Connection View (Wi-Fi + Bluetooth) ---------- */
function ConnectionView({ language, deviceOnline, deviceInfo }: { language: Language; deviceOnline: boolean; deviceInfo: { deviceId?: string; firmware?: string; ip?: string; rssi?: number; uptime?: number; platform?: string; pumpRunning?: boolean; thermalAlarm?: boolean; mcpPresent?: boolean } | null }) {
  const [connectionTab, setConnectionTab] = useState<'wifi' | 'bluetooth'>('wifi');
  const [savedNetworks, setSavedNetworks] = useState<{ ssid: string; password: string; hostname: string; createdAt?: string }[]>([]);
  const [scanResults, setScanResults] = useState<{ ssid: string; rssi: number; secure: boolean }[]>([]);
  const [scanning, setScanning] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [formSsid, setFormSsid] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formHostname, setFormHostname] = useState('gtc-esp32s3');
  const [notice, setNotice] = useState('');
  const [saved, setSaved] = useState(false);
  const [kbTarget, setKbTarget] = useState<'ssid' | 'password' | 'hostname' | 'btname' | 'btpin' | null>(null);

  // Bluetooth state
  const [pairedDevices, setPairedDevices] = useState<{ address: string; name: string; pin?: string; paired: boolean; createdAt?: string }[]>([]);
  const [btScanResults, setBtScanResults] = useState<{ address: string; name: string; rssi: number }[]>([]);
  const [btScanning, setBtScanning] = useState(false);
  const [showBtAddForm, setShowBtAddForm] = useState(false);
  const [formBtAddress, setFormBtAddress] = useState('');
  const [formBtName, setFormBtName] = useState('');
  const [formBtPin, setFormBtPin] = useState('');
  const [btNotice, setBtNotice] = useState('');
  const [btSaved, setBtSaved] = useState(false);

  const openKb = (field: 'ssid' | 'password' | 'hostname' | 'btname' | 'btpin') => setKbTarget((prev) => (prev === field ? null : field));
  const kbValue = kbTarget === 'ssid' ? formSsid : kbTarget === 'password' ? formPassword : kbTarget === 'hostname' ? formHostname : kbTarget === 'btname' ? formBtName : kbTarget === 'btpin' ? formBtPin : '';
  const handleKbChange = (v: string) => {
    if (kbTarget === 'ssid') setFormSsid(v);
    else if (kbTarget === 'password') setFormPassword(v);
    else if (kbTarget === 'hostname') setFormHostname(v);
    else if (kbTarget === 'btname') setFormBtName(v);
    else if (kbTarget === 'btpin') setFormBtPin(v);
  };
  const kbTitle = kbTarget === 'ssid' ? 'SSID'
    : kbTarget === 'password' ? (language === 'PT' ? 'Senha' : 'Password')
    : kbTarget === 'hostname' ? (language === 'PT' ? 'Hostname' : 'Hostname')
    : kbTarget === 'btname' ? (language === 'PT' ? 'Nome do dispositivo' : 'Device name')
    : (language === 'PT' ? 'PIN de emparelhamento' : 'Pairing PIN');

  useEffect(() => {
    loadWifiConfig();
    loadBluetoothConfig();
  }, []);

  const loadBluetoothConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/bluetooth/config`);
      if (res.ok) {
        const data = await res.json();
        setPairedDevices(data.devices || []);
      }
    } catch {}
  };

  const handleBtScan = async () => {
    if (!deviceOnline) {
      setBtNotice(language === 'PT' ? 'ESP32 offline — não é possível procurar dispositivos' : 'ESP32 offline — cannot scan');
      setTimeout(() => setBtNotice(''), 3000);
      return;
    }
    setBtScanning(true);
    setBtNotice(language === 'PT' ? 'A procurar dispositivos Bluetooth...' : 'Scanning Bluetooth devices...');
    try {
      await fetch(`${API_BASE}/api/bluetooth/scan`, { method: 'POST' });
      setTimeout(async () => {
        if (btScanResults.length === 0) {
          setBtScanResults([
            { address: '3C:71:BF:00:11:22', name: 'GTC-Rega-BLE', rssi: -50 },
            { address: 'A4:C1:38:AA:BB:CC', name: 'Auscultadores', rssi: -70 },
          ]);
        }
        setBtScanning(false);
        setBtNotice('');
      }, 2000);
    } catch {
      setBtScanning(false);
      setBtNotice(language === 'PT' ? 'Erro ao procurar dispositivos' : 'Error scanning devices');
      setTimeout(() => setBtNotice(''), 3000);
    }
  };

  const handleSaveBtDevice = async () => {
    if (!formBtAddress.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/api/bluetooth/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: formBtAddress.trim(), name: formBtName || formBtAddress.trim(), pin: formBtPin }),
      });
      if (res.ok) {
        setBtSaved(true);
        setBtNotice(language === 'PT' ? 'Dispositivo Bluetooth guardado com sucesso!' : 'Bluetooth device saved successfully!');
        setShowBtAddForm(false);
        setFormBtAddress('');
        setFormBtName('');
        setFormBtPin('');
        loadBluetoothConfig();
        setTimeout(() => { setBtSaved(false); setBtNotice(''); }, 2500);
      }
    } catch {
      setBtNotice(language === 'PT' ? 'Erro ao guardar dispositivo' : 'Error saving device');
      setTimeout(() => setBtNotice(''), 3000);
    }
  };

  const handleDeleteBtDevice = async (address: string) => {
    try {
      await fetch(`${API_BASE}/api/bluetooth/config`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      loadBluetoothConfig();
      setBtNotice(language === 'PT' ? 'Dispositivo removido' : 'Device removed');
      setTimeout(() => setBtNotice(''), 2000);
    } catch {
      setBtNotice(language === 'PT' ? 'Erro ao remover dispositivo' : 'Error removing device');
      setTimeout(() => setBtNotice(''), 3000);
    }
  };

  const fillFromBtScan = (device: { address: string; name: string }) => {
    setFormBtAddress(device.address);
    setFormBtName(device.name);
    setShowBtAddForm(true);
    setBtScanResults([]);
  };

  const loadWifiConfig = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/wifi/config`);
      if (res.ok) {
        const data = await res.json();
        setSavedNetworks(data.networks || []);
      }
    } catch {}
  };

  const handleScan = async () => {
    if (!deviceOnline) {
      setNotice(language === 'PT' ? 'ESP32 offline — não é possível procurar redes' : 'ESP32 offline — cannot scan');
      setTimeout(() => setNotice(''), 3000);
      return;
    }
    setScanning(true);
    setNotice(language === 'PT' ? 'A procurar redes Wi-Fi...' : 'Scanning Wi-Fi networks...');
    try {
      await fetch(`${API_BASE}/api/wifi/scan`, { method: 'POST' });
      // Listen for scan results via polling or SSE — for now show message
      setTimeout(async () => {
        // For demo, show some example networks
        if (scanResults.length === 0) {
          setScanResults([
            { ssid: 'GTC_Rede', rssi: -45, secure: true },
            { ssid: 'Casa_Deo', rssi: -62, secure: true },
            { ssid: 'WiFi_Publico', rssi: -78, secure: false },
          ]);
        }
        setScanning(false);
        setNotice('');
      }, 2000);
    } catch {
      setScanning(false);
      setNotice(language === 'PT' ? 'Erro ao procurar redes' : 'Error scanning networks');
      setTimeout(() => setNotice(''), 3000);
    }
  };

  const handleSaveNetwork = async () => {
    if (!formSsid.trim()) return;
    try {
      const res = await fetch(`${API_BASE}/api/wifi/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssid: formSsid.trim(), password: formPassword, hostname: formHostname || 'gtc-esp32s3' }),
      });
      if (res.ok) {
        setSaved(true);
        setNotice(language === 'PT' ? 'Rede Wi-Fi guardada com sucesso!' : 'Wi-Fi network saved successfully!');
        setShowAddForm(false);
        setFormSsid('');
        setFormPassword('');
        setFormHostname('gtc-esp32s3');
        loadWifiConfig();
        setTimeout(() => { setSaved(false); setNotice(''); }, 2500);
      }
    } catch {
      setNotice(language === 'PT' ? 'Erro ao guardar rede' : 'Error saving network');
      setTimeout(() => setNotice(''), 3000);
    }
  };

  const handleDeleteNetwork = async (ssid: string) => {
    try {
      await fetch(`${API_BASE}/api/wifi/config`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ssid }),
      });
      loadWifiConfig();
      setNotice(language === 'PT' ? 'Rede removida' : 'Network removed');
      setTimeout(() => setNotice(''), 2000);
    } catch {
      setNotice(language === 'PT' ? 'Erro ao remover rede' : 'Error removing network');
      setTimeout(() => setNotice(''), 3000);
    }
  };

  const fillFromScan = (ssid: string) => {
    setFormSsid(ssid);
    setShowAddForm(true);
    setScanResults([]);
  };

  return (
    <>
    <div className="connection-tabs" role="tablist" style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
      <button
        role="tab"
        aria-selected={connectionTab === 'wifi'}
        className={`gpio-edit-btn ${connectionTab === 'wifi' ? 'active' : ''}`}
        onClick={() => setConnectionTab('wifi')}
      >
        <Wifi size={15} /> Wi-Fi
      </button>
      <button
        role="tab"
        aria-selected={connectionTab === 'bluetooth'}
        className={`gpio-edit-btn ${connectionTab === 'bluetooth' ? 'active' : ''}`}
        onClick={() => setConnectionTab('bluetooth')}
      >
        <Bluetooth size={15} /> Bluetooth
      </button>
    </div>
    {connectionTab === 'wifi' ? (
    <div className="two-column">
      {/* Current connection status */}
      <Panel>
        <PanelHeader eyebrow={language === 'PT' ? 'ESTADO DA LIGAÇÃO' : 'CONNECTION STATUS'} title={language === 'PT' ? 'Ligação Wi-Fi atual' : 'Current Wi-Fi connection'} />
        <div className={`mode-card ${deviceOnline ? 'mode-card-auto' : 'mode-card-manual'}`}>
          <div className="mode-graphic"><Wifi size={22} /></div>
          <div>
            <strong>{deviceOnline ? (language === 'PT' ? 'Conectado' : 'Connected') : (language === 'PT' ? 'Desconectado' : 'Disconnected')}</strong>
            <p>{deviceOnline && deviceInfo?.ip
              ? `${language === 'PT' ? 'Endereço IP' : 'IP address'}: ${deviceInfo.ip}`
              : (language === 'PT' ? 'ESP32-S3 não está ligado à rede' : 'ESP32-S3 is not connected to the network')}</p>
          </div>
          <StatusBadge tone={deviceOnline ? 'success' : 'error'}>{deviceOnline ? 'Online' : 'Offline'}</StatusBadge>
        </div>
        <div className="info-list">
          <div><span>{language === 'PT' ? 'Dispositivo' : 'Device'}</span><strong>{deviceInfo?.deviceId || 'ESP32-S3'}</strong></div>
          <div><span>{language === 'PT' ? 'Firmware' : 'Firmware'}</span><strong>{deviceInfo?.firmware || '—'}</strong></div>
          <div><span>{language === 'PT' ? 'Endereço IP' : 'IP address'}</span><strong>{deviceInfo?.ip || '—'}</strong></div>
          <div><span>{language === 'PT' ? 'Sinal Wi-Fi' : 'Wi-Fi signal'}</span><strong>{typeof deviceInfo?.rssi === 'number' ? `${deviceInfo.rssi} dBm` : '—'}</strong></div>
          <div><span>{language === 'PT' ? 'Hostname' : 'Hostname'}</span><strong>{deviceInfo?.deviceId || 'gtc-esp32s3'}.local</strong></div>
          <div><span>{language === 'PT' ? 'Tempo online' : 'Uptime'}</span><strong>{deviceOnline && deviceInfo?.uptime ? formatUptime(deviceInfo.uptime) || '—' : '—'}</strong></div>
          <div><span>{language === 'PT' ? 'Bomba (KM1)' : 'Pump (KM1)'}</span><strong className={deviceInfo?.pumpRunning ? 'text-ok' : 'text-muted'}>{deviceInfo?.pumpRunning ? (language === 'PT' ? 'Em funcionamento' : 'Running') : (language === 'PT' ? 'Parada' : 'Stopped')}</strong></div>
          <div><span>{language === 'PT' ? 'Relé térmico' : 'Thermal relay'}</span><strong className={deviceInfo?.thermalAlarm ? 'text-alarm' : 'text-ok'}>{deviceInfo?.thermalAlarm ? (language === 'PT' ? 'ALARME' : 'ALARM') : (language === 'PT' ? 'Normal' : 'Normal')}</strong></div>
          <div><span>{language === 'PT' ? 'Expansor I/O' : 'I/O expander'}</span><strong className={deviceInfo?.mcpPresent === false ? 'text-alarm' : 'text-ok'}>{deviceInfo?.mcpPresent === false ? (language === 'PT' ? 'MCP23017 ausente' : 'MCP23017 missing') : 'MCP23017 @ 0x20'}</strong></div>
        </div>
      </Panel>

      {/* WiFi Configuration */}
      <Panel>
        <div className="panel-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div><span className="section-kicker">{language === 'PT' ? 'CONFIGURAR WI-FI' : 'CONFIGURE WI-FI'}</span><h3>{language === 'PT' ? 'Redes guardadas' : 'Saved networks'}</h3></div>
          <button className="gpio-edit-btn" onClick={() => setShowAddForm(!showAddForm)}>
            {showAddForm ? <X size={15} /> : <Plus size={15} />} <span className="btn-label">{showAddForm ? (language === 'PT' ? 'Fechar' : 'Close') : (language === 'PT' ? 'Adicionar rede' : 'Add network')}</span>
          </button>
        </div>

        {/* Add form */}
        {showAddForm && (
          <div className="wifi-add-form">
            <label className="field-label">
              SSID
              <div style={{ display: 'flex', gap: 8 }}>
                <div className="field-input-group" style={{ flex: 1 }}>
                  <input
                    value={formSsid}
                    onChange={(e) => setFormSsid(e.target.value)}
                    placeholder={language === 'PT' ? 'Nome da rede' : 'Network name'}
                  />
                  <button
                    type="button"
                    className={`field-kb-toggle ${kbTarget === 'ssid' ? 'active' : ''}`}
                    onClick={() => openKb('ssid')}
                    aria-label={language === 'PT' ? 'Abrir teclado virtual' : 'Open virtual keyboard'}
                    aria-pressed={kbTarget === 'ssid'}
                  >
                    <Keyboard size={16} />
                  </button>
                </div>
                <button className="gpio-edit-btn" onClick={handleScan} disabled={scanning}>
                  <Search size={14} className={scanning ? 'spin' : ''} /> <span className="btn-label">{scanning ? (language === 'PT' ? 'A procurar...' : 'Scanning...') : (language === 'PT' ? 'Procurar' : 'Scan')}</span>
                </button>
              </div>
            </label>
            {scanResults.length > 0 && (
              <div className="wifi-scan-results">
                <span className="section-kicker">{language === 'PT' ? 'REDES ENCONTRADAS' : 'NETWORKS FOUND'}</span>
                {scanResults.map((net) => (
                  <button key={net.ssid} className="wifi-scan-item" onClick={() => fillFromScan(net.ssid)}>
                    <div className="wifi-scan-item-left">
                      <Wifi size={14} />
                      <strong>{net.ssid}</strong>
                      {net.secure && <LockKeyhole size={12} />}
                    </div>
                    <span className={`sensor-health-pill ${net.rssi > -60 ? 'ok' : net.rssi > -75 ? 'off' : 'stale'}`}>
                      {net.rssi} dBm
                    </span>
                  </button>
                ))}
              </div>
            )}
            <label className="field-label">
              {language === 'PT' ? 'Senha' : 'Password'}
              <div className="field-input-group">
                <input
                  type="password"
                  value={formPassword}
                  onChange={(e) => setFormPassword(e.target.value)}
                  placeholder={language === 'PT' ? 'Senha da rede Wi-Fi' : 'Wi-Fi password'}
                />
                <button
                  type="button"
                  className={`field-kb-toggle ${kbTarget === 'password' ? 'active' : ''}`}
                  onClick={() => openKb('password')}
                  aria-label={language === 'PT' ? 'Abrir teclado virtual' : 'Open virtual keyboard'}
                  aria-pressed={kbTarget === 'password'}
                >
                  <Keyboard size={16} />
                </button>
              </div>
            </label>
            <label className="field-label">
              {language === 'PT' ? 'Hostname' : 'Hostname'}
              <div className="field-input-group">
                <input
                  value={formHostname}
                  onChange={(e) => setFormHostname(e.target.value)}
                  placeholder="gtc-esp32s3"
                />
                <button
                  type="button"
                  className={`field-kb-toggle ${kbTarget === 'hostname' ? 'active' : ''}`}
                  onClick={() => openKb('hostname')}
                  aria-label={language === 'PT' ? 'Abrir teclado virtual' : 'Open virtual keyboard'}
                  aria-pressed={kbTarget === 'hostname'}
                >
                  <Keyboard size={16} />
                </button>
              </div>
            </label>
            <button className="save-btn" onClick={handleSaveNetwork} style={{ marginTop: 12 }}>
              <Save size={15} /> {language === 'PT' ? 'Guardar rede' : 'Save network'}
            </button>
          </div>
        )}

        {/* Saved networks list */}
        <div className="wifi-networks-list">
          {savedNetworks.length === 0 && !showAddForm && (
            <div className="empty-state">
              <Wifi size={28} />
              <span>{language === 'PT' ? 'Nenhuma rede guardada. Adicione uma rede para o ESP32-S3 se conectar.' : 'No saved networks. Add a network for the ESP32-S3 to connect to.'}</span>
            </div>
          )}
          {savedNetworks.map((net) => (
            <div key={net.ssid} className="wifi-network-item">
              <div className="wifi-network-icon"><Wifi size={18} /></div>
              <div className="wifi-network-info">
                <strong>{net.ssid}</strong>
                <span>{net.hostname || 'gtc-esp32s3'}.local</span>
              </div>
              <button
                className="sp2-remove-btn"
                onClick={() => handleDeleteNetwork(net.ssid)}
                aria-label={language === 'PT' ? 'Remover rede' : 'Remove network'}
                title={language === 'PT' ? 'Remover rede' : 'Remove network'}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      </Panel>

      {!deviceOnline && (
        <Panel className="alarm-banner" style={{ gridColumn: '1 / -1' }}>
          <div className="alarm-banner-icon"><AlertTriangle size={22} /></div>
          <div>
            <span className="section-kicker">{language === 'PT' ? 'ATENÇÃO' : 'ATTENTION'}</span>
            <h3>{language === 'PT' ? 'ESP32-S3 offline' : 'ESP32-S3 offline'}</h3>
            <p>{language === 'PT' ? 'O controlador não está conectado. As configurações Wi-Fi serão aplicadas assim que o dispositivo se ligar.' : 'The controller is not connected. Wi-Fi settings will be applied once the device connects.'}</p>
          </div>
          <StatusBadge tone="warning">{language === 'PT' ? 'Offline' : 'Offline'}</StatusBadge>
        </Panel>
      )}

      {notice && (
        <div className={`setpoint-save-all-banner ${saved ? 'just-saved' : 'has-pending'}`} style={{ gridColumn: '1 / -1', marginTop: 8 }}>
          <div className="save-all-banner-left">
            <div className={`save-all-banner-icon ${saved ? 'icon-ok' : 'icon-pending'}`}>
              {saved ? <CheckCircle2 size={22} /> : <Wifi size={22} />}
            </div>
            <div><strong>{notice}</strong></div>
          </div>
        </div>
      )}
    </div>
    ) : (
    <div className="two-column">
      {/* Current bluetooth status */}
      <Panel>
        <PanelHeader eyebrow={language === 'PT' ? 'ESTADO BLUETOOTH' : 'BLUETOOTH STATUS'} title={language === 'PT' ? 'Rádio Bluetooth (BLE)' : 'Bluetooth radio (BLE)'} />
        <div className={`mode-card ${deviceOnline ? 'mode-card-auto' : 'mode-card-manual'}`}>
          <div className="mode-graphic"><Bluetooth size={22} /></div>
          <div>
            <strong>{deviceOnline ? (language === 'PT' ? 'Rádio ativo' : 'Radio active') : (language === 'PT' ? 'Indisponível' : 'Unavailable')}</strong>
            <p>{deviceOnline
              ? (language === 'PT' ? `${pairedDevices.filter(d => d.paired).length} dispositivo(s) emparelhado(s)` : `${pairedDevices.filter(d => d.paired).length} paired device(s)`)
              : (language === 'PT' ? 'ESP32-S3 não está ligado à rede' : 'ESP32-S3 is not connected to the network')}</p>
          </div>
          <StatusBadge tone={deviceOnline ? 'success' : 'error'}>{deviceOnline ? 'Online' : 'Offline'}</StatusBadge>
        </div>
        <div className="info-list">
          <div><span>{language === 'PT' ? 'Dispositivo' : 'Device'}</span><strong>{deviceInfo?.deviceId || 'ESP32-S3'}</strong></div>
          <div><span>{language === 'PT' ? 'Modo' : 'Mode'}</span><strong>BLE (Bluetooth Low Energy)</strong></div>
          <div><span>{language === 'PT' ? 'Dispositivos guardados' : 'Saved devices'}</span><strong>{pairedDevices.length}</strong></div>
        </div>
      </Panel>

      {/* Bluetooth Configuration */}
      <Panel>
        <div className="panel-heading" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div><span className="section-kicker">{language === 'PT' ? 'CONFIGURAR BLUETOOTH' : 'CONFIGURE BLUETOOTH'}</span><h3>{language === 'PT' ? 'Dispositivos emparelhados' : 'Paired devices'}</h3></div>
          <button className="gpio-edit-btn" onClick={() => setShowBtAddForm(!showBtAddForm)}>
            {showBtAddForm ? <X size={15} /> : <Plus size={15} />} <span className="btn-label">{showBtAddForm ? (language === 'PT' ? 'Fechar' : 'Close') : (language === 'PT' ? 'Adicionar dispositivo' : 'Add device')}</span>
          </button>
        </div>

        {showBtAddForm && (
          <div className="wifi-add-form">
            <label className="field-label">
              {language === 'PT' ? 'Endereço MAC' : 'MAC address'}
              <div style={{ display: 'flex', gap: 8 }}>
                <div className="field-input-group" style={{ flex: 1 }}>
                  <input
                    value={formBtAddress}
                    onChange={(e) => setFormBtAddress(e.target.value)}
                    placeholder="AA:BB:CC:DD:EE:FF"
                  />
                </div>
                <button className="gpio-edit-btn" onClick={handleBtScan} disabled={btScanning}>
                  <Search size={14} className={btScanning ? 'spin' : ''} /> <span className="btn-label">{btScanning ? (language === 'PT' ? 'A procurar...' : 'Scanning...') : (language === 'PT' ? 'Procurar' : 'Scan')}</span>
                </button>
              </div>
            </label>
            {btScanResults.length > 0 && (
              <div className="wifi-scan-results">
                <span className="section-kicker">{language === 'PT' ? 'DISPOSITIVOS ENCONTRADOS' : 'DEVICES FOUND'}</span>
                {btScanResults.map((dev) => (
                  <button key={dev.address} className="wifi-scan-item" onClick={() => fillFromBtScan(dev)}>
                    <div className="wifi-scan-item-left">
                      <Bluetooth size={14} />
                      <strong>{dev.name}</strong>
                      <span style={{ opacity: 0.6, fontSize: 12 }}>{dev.address}</span>
                    </div>
                    <span className={`sensor-health-pill ${dev.rssi > -60 ? 'ok' : dev.rssi > -75 ? 'off' : 'stale'}`}>
                      {dev.rssi} dBm
                    </span>
                  </button>
                ))}
              </div>
            )}
            <label className="field-label">
              {language === 'PT' ? 'Nome do dispositivo' : 'Device name'}
              <div className="field-input-group">
                <input
                  value={formBtName}
                  onChange={(e) => setFormBtName(e.target.value)}
                  placeholder={language === 'PT' ? 'Nome amigável' : 'Friendly name'}
                />
                <button
                  type="button"
                  className={`field-kb-toggle ${kbTarget === 'btname' ? 'active' : ''}`}
                  onClick={() => openKb('btname')}
                  aria-label={language === 'PT' ? 'Abrir teclado virtual' : 'Open virtual keyboard'}
                  aria-pressed={kbTarget === 'btname'}
                >
                  <Keyboard size={16} />
                </button>
              </div>
            </label>
            <label className="field-label">
              {language === 'PT' ? 'PIN de emparelhamento (opcional)' : 'Pairing PIN (optional)'}
              <div className="field-input-group">
                <input
                  value={formBtPin}
                  onChange={(e) => setFormBtPin(e.target.value)}
                  placeholder="0000"
                />
                <button
                  type="button"
                  className={`field-kb-toggle ${kbTarget === 'btpin' ? 'active' : ''}`}
                  onClick={() => openKb('btpin')}
                  aria-label={language === 'PT' ? 'Abrir teclado virtual' : 'Open virtual keyboard'}
                  aria-pressed={kbTarget === 'btpin'}
                >
                  <Keyboard size={16} />
                </button>
              </div>
            </label>
            <button className="save-btn" onClick={handleSaveBtDevice} style={{ marginTop: 12 }}>
              <Save size={15} /> {language === 'PT' ? 'Guardar dispositivo' : 'Save device'}
            </button>
          </div>
        )}

        <div className="wifi-networks-list">
          {pairedDevices.length === 0 && !showBtAddForm && (
            <div className="empty-state">
              <Bluetooth size={28} />
              <span>{language === 'PT' ? 'Nenhum dispositivo Bluetooth guardado. Procure e adicione um dispositivo para emparelhar com o ESP32-S3.' : 'No saved Bluetooth devices. Scan and add a device to pair with the ESP32-S3.'}</span>
            </div>
          )}
          {pairedDevices.map((dev) => (
            <div key={dev.address} className="wifi-network-item">
              <div className="wifi-network-icon">{dev.paired ? <BluetoothConnected size={18} /> : <Bluetooth size={18} />}</div>
              <div className="wifi-network-info">
                <strong>{dev.name}</strong>
                <span>{dev.address}</span>
              </div>
              <StatusBadge tone={dev.paired ? 'success' : 'warning'}>
                {dev.paired ? (language === 'PT' ? 'Emparelhado' : 'Paired') : (language === 'PT' ? 'Pendente' : 'Pending')}
              </StatusBadge>
              <button
                className="sp2-remove-btn"
                onClick={() => handleDeleteBtDevice(dev.address)}
                aria-label={language === 'PT' ? 'Remover dispositivo' : 'Remove device'}
                title={language === 'PT' ? 'Remover dispositivo' : 'Remove device'}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      </Panel>

      {!deviceOnline && (
        <Panel className="alarm-banner" style={{ gridColumn: '1 / -1' }}>
          <div className="alarm-banner-icon"><AlertTriangle size={22} /></div>
          <div>
            <span className="section-kicker">{language === 'PT' ? 'ATENÇÃO' : 'ATTENTION'}</span>
            <h3>{language === 'PT' ? 'ESP32-S3 offline' : 'ESP32-S3 offline'}</h3>
            <p>{language === 'PT' ? 'O controlador não está conectado. Os dispositivos Bluetooth serão emparelhados assim que o dispositivo se ligar.' : 'The controller is not connected. Bluetooth devices will be paired once the device connects.'}</p>
          </div>
          <StatusBadge tone="warning">{language === 'PT' ? 'Offline' : 'Offline'}</StatusBadge>
        </Panel>
      )}

      {btNotice && (
        <div className={`setpoint-save-all-banner ${btSaved ? 'just-saved' : 'has-pending'}`} style={{ gridColumn: '1 / -1', marginTop: 8 }}>
          <div className="save-all-banner-left">
            <div className={`save-all-banner-icon ${btSaved ? 'icon-ok' : 'icon-pending'}`}>
              {btSaved ? <CheckCircle2 size={22} /> : <Bluetooth size={22} />}
            </div>
            <div><strong>{btNotice}</strong></div>
          </div>
        </div>
      )}
    </div>
    )}
    {kbTarget && (
      <FullKeyboard
        value={kbValue}
        onChange={handleKbChange}
        onSubmit={() => setKbTarget(null)}
        onClose={() => setKbTarget(null)}
        title={kbTitle}
        hint={language === 'PT' ? 'Também pode escrever com o teclado físico' : 'You can also type using your physical keyboard'}
        language={language}
      />
    )}
    </>
  );
}

export default App;

/* ---------- Schematic View (esquema elétrico em PDF) ---------- */
function SchematicView({ language }: { language: Language }) {
  return (
    <div className="two-column">
      <Panel style={{ gridColumn: '1 / -1' }}>
        <PanelHeader
          eyebrow={language === 'PT' ? 'DOCUMENTAÇÃO' : 'DOCUMENTATION'}
          title={language === 'PT' ? 'Esquema elétrico' : 'Electrical schematic'}
        />
        <p className="schematic-desc">
          {language === 'PT'
            ? 'Esquema elétrico completo do sistema GTC Rega (ligações do ESP32-S3, sensores, relés e alimentação).'
            : 'Full electrical schematic of the GTC Rega system (ESP32-S3 wiring, sensors, relays and power supply).'}
        </p>
        <div className="schematic-actions">
          <a className="schematic-open-btn" href={esquemaPdf} target="_blank" rel="noopener noreferrer">
            <ExternalLink size={15} />{language === 'PT' ? 'Abrir em nova aba' : 'Open in new tab'}
          </a>
          <a className="schematic-download-btn" href={esquemaPdf} download="Esquema - GTC Rega.pdf">
            <Download size={15} />{language === 'PT' ? 'Descarregar PDF' : 'Download PDF'}
          </a>
        </div>
        <div className="schematic-viewer">
          <iframe src={esquemaPdf} title={language === 'PT' ? 'Esquema elétrico' : 'Electrical schematic'} />
        </div>
        <p className="schematic-hint">
          {language === 'PT'
            ? 'Se a pré-visualização não aparecer (comum em alguns navegadores móveis), usa o botão "Abrir em nova aba".'
            : 'If the preview doesn\'t show (common on some mobile browsers), use the "Open in new tab" button.'}
        </p>
      </Panel>
    </div>
  );
}
