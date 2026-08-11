import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bell,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CloudSun,
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
} from 'lucide-react';
import { fetchEvents, logEvent, type EventLogEntry, type EventType } from '@/lib/supabase';

type Page = 'Resumo' | 'Estado' | 'Setpoints' | 'Mapa' | 'Histórico' | 'Comandos' | 'Alarmes';
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

const initialZones: Zone[] = [
  { id: 'Y1', sensorId: 'B1', name: 'Zona 1', moisture: 64, target: 55, lastWatered: 'Hoje, 18:12', on: false, waterDuration: 60, x: 28, y: 36 },
  { id: 'Y2', sensorId: 'B2', name: 'Zona 2', moisture: 57, target: 52, lastWatered: 'Hoje, 17:48', on: false, waterDuration: 45, x: 56, y: 62 },
];

const initialErrors: ErrorEvent[] = [
  { id: 'E001', time: 'Hoje, 21:12', source: 'Sensor B2', message: 'Leitura recebida dentro do intervalo esperado.', severity: 'info', resolved: true },
  { id: 'E002', time: 'Hoje, 14:03', source: 'Bomba K1', message: 'Sobrecorrente detectada no relé K1 durante o arranque.', severity: 'warning', resolved: true },
  { id: 'E003', time: 'Ontem, 06:30', source: 'Comunicação', message: 'Timeout Modbus no barramento RS485 — sensor B1.', severity: 'critical', resolved: true },
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

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const isYesterday = d.toDateString() === yesterday.toDateString();
  const time = d.toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return `Hoje, ${time}`;
  if (isYesterday) return `Ontem, ${time}`;
  return d.toLocaleDateString('pt-PT') + ', ' + time;
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
  const [zoneToDelete, setZoneToDelete] = useState<Zone | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [language, setLanguage] = useState<Language>('PT');
  const [username, setUsername] = useState('operador');
  const [password, setPassword] = useState('');
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [eventLog, setEventLog] = useState<EventLogEntry[]>([]);
  const [eventLogLoading, setEventLogLoading] = useState(false);
  const startTimers = useRef<number[]>([]);

  useEffect(() => () => startTimers.current.forEach((t) => clearTimeout(t)), []);

  const loadEvents = useCallback(async () => {
    setEventLogLoading(true);
    const events = await fetchEvents(100);
    setEventLog(events);
    setEventLogLoading(false);
  }, []);

  useEffect(() => {
    loadEvents();
  }, [loadEvents]);

  const activeZones = useMemo(() => zones.filter((z) => z.on).length, [zones]);
  const alarmCount = useMemo(() => errors.filter((e) => !e.resolved).length, [errors]);

  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 2800);
  };

  const toggleZone = useCallback((id: string) => {
    setZones((cur) => {
      const zone = cur.find((z) => z.id === id);
      if (!zone) return cur;
      const newState = !zone.on;
      logEvent('zone_toggle', `${zone.name} · Válvula ${zone.id}`, newState ? `Válvula ${zone.id} aberta` : `Válvula ${zone.id} fechada`, 'info', { zone_id: id, state: newState });
      return cur.map((z) => (z.id === id ? { ...z, on: newState } : z));
    });
  }, []);

  const togglePump = useCallback(() => {
    setPumpOn((prev) => {
      const next = !prev;
      logEvent('pump_toggle', 'Bomba K1', next ? 'Bomba ligada' : 'Bomba desligada', 'info', { state: next });
      return next;
    });
  }, []);

  const addZone = () => {
    const id = makeZoneId();
    const sensorId = makeSensorId();
    const num = zones.length + 1;
    const newZone: Zone = { id, sensorId, name: `Zona ${num}`, moisture: 50, target: 50, lastWatered: '—', on: false, waterDuration: 30, x: 30 + Math.random() * 40, y: 30 + Math.random() * 40 };
    setZones((cur) => [...cur, newZone]);
    logEvent('zone_add', `${newZone.name} · Sensor ${sensorId}`, `Sensor ${sensorId} e válvula ${id} adicionados`, 'info', { zone_id: id, sensor_id: sensorId });
    showNotice(`Sensor ${sensorId} adicionado`);
  };

  const addZoneFromMap = useCallback((x: number, y: number) => {
    const id = makeZoneId();
    const sensorId = makeSensorId();
    const num = zones.length + 1;
    const newZone: Zone = { id, sensorId, name: `Zona ${num}`, moisture: 50, target: 50, lastWatered: '—', on: false, waterDuration: 30, x, y };
    setZones((cur) => [...cur, newZone]);
    logEvent('zone_add_map', `${newZone.name} · Sensor ${sensorId}`, `Local adicionado no mapa: válvula ${id}, sensor ${sensorId}`, 'info', { zone_id: id, sensor_id: sensorId, x, y });
    showNotice(`Local adicionado: ${newZone.name}`);
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
    if (starting || systemRunning) return;
    startTimers.current.forEach((t) => clearTimeout(t));
    startTimers.current = [];
    setStarting(true);
    setSystemRunning(true);
    setAutoMode(true);

    setPumpOn(true);
    setStartStep('A ligar bomba…');
    logEvent('system_start', 'Sistema', 'Sistema iniciado — bomba ligada', 'info', { pump_delay: pumpDelay });
    showNotice('Bomba ligada');

    const t1 = window.setTimeout(() => {
      setStartStep('A abrir válvulas…');
      setZones((cur) => {
        cur.forEach((z) => {
          if (!z.on) logEvent('zone_toggle', `${z.name} · Válvula ${z.id}`, `Válvula ${z.id} aberta (sistema)`, 'info', { zone_id: z.id, state: true });
        });
        return cur.map((z) => ({ ...z, on: true }));
      });
      showNotice('Válvulas abertas');
      const t2 = window.setTimeout(() => {
        setStarting(false);
        setStartStep('');
        showNotice('Sistema iniciado');
        startTimers.current.push(t2);
      }, 600);
      startTimers.current.push(t2);
    }, pumpDelay * 1000);
    startTimers.current.push(t1);
  };
  const handleStop = () => {
    startTimers.current.forEach((t) => clearTimeout(t));
    startTimers.current = [];
    setSystemRunning(false);
    setStarting(false);
    setStartStep('');
    setPumpOn(false);
    setZones((cur) => {
      cur.forEach((z) => {
        if (z.on) logEvent('zone_toggle', `${z.name} · Válvula ${z.id}`, `Válvula ${z.id} fechada (sistema parado)`, 'info', { zone_id: z.id, state: false });
      });
      return cur.map((z) => ({ ...z, on: false }));
    });
    logEvent('system_stop', 'Sistema', 'Sistema parado — todos os atuadores desligados', 'warning');
    showNotice('Sistema parado');
  };
  const handleReset = () => {
    startTimers.current.forEach((t) => clearTimeout(t));
    startTimers.current = [];
    setSystemRunning(false);
    setStarting(false);
    setStartStep('');
    setPumpOn(false);
    setZones((cur) => cur.map((z) => ({ ...z, on: false, moisture: Math.max(20, Math.min(90, Math.round(z.moisture))) })));
    setErrors((cur) => cur.map((e) => ({ ...e, resolved: true })));
    logEvent('system_reset', 'Sistema', 'Sistema reiniciado', 'warning');
    showNotice('Sistema reiniciado');
  };

  const toggleAutoMode = () => {
    const next = !autoMode;
    setAutoMode(next);
    logEvent('mode_change', 'Modo de operação', next ? 'Modo automático ativado' : 'Modo manual ativado', 'info', { mode: next ? 'auto' : 'manual' });
    showNotice(next ? 'Modo automático ativado' : 'Modo manual ativado');
  };

  const handleEmergencyStop = () => {
    setZones((cur) => {
      cur.forEach((z) => {
        if (z.on) logEvent('zone_toggle', `${z.name} · Válvula ${z.id}`, `Válvula ${z.id} fechada (emergência)`, 'critical', { zone_id: z.id, state: false });
      });
      return cur.map((z) => ({ ...z, on: false }));
    });
    setPumpOn(false);
    logEvent('emergency_stop', 'Paragem de emergência', 'Paragem de emergência executada — todos os atuadores desligados', 'critical');
    showNotice('Todas as zonas foram desligadas');
  };

  const handleTestCycle = () => {
    logEvent('test_cycle', 'Ciclo de teste', 'Ciclo de teste iniciado — verificação de bomba e válvulas', 'info');
    showNotice('Ciclo de teste iniciado');
  };

  const confirmDeleteZone = () => {
    if (!zoneToDelete) return;
    setZones((cur) => cur.filter((z) => z.id !== zoneToDelete.id));
    logEvent('zone_remove', `${zoneToDelete.name} · Sensor ${zoneToDelete.sensorId}`, `Sensor ${zoneToDelete.sensorId} e válvula ${zoneToDelete.id} removidos`, 'warning', { zone_id: zoneToDelete.id, sensor_id: zoneToDelete.sensorId });
    showNotice(`Sensor ${zoneToDelete.sensorId} removido`);
    setZoneToDelete(null);
  };

  const saveSettings = () => {
    setSettingsSaved(true);
    showNotice('Definições guardadas');
    window.setTimeout(() => setSettingsSaved(false), 2200);
  };

  const renderPage = () => {
    if (activePage === 'Resumo') {
      return <Overview zones={zones} pumpOn={pumpOn} autoMode={autoMode} activeZones={activeZones} onToggleZone={toggleZone} onTogglePump={togglePump} onToggleMode={toggleAutoMode} onOpenMap={() => setActivePage('Mapa')} />;
    }
    if (activePage === 'Estado') return <StateView zones={zones} pumpOn={pumpOn} autoMode={autoMode} onToggleMode={toggleAutoMode} />;
    if (activePage === 'Setpoints') return <SetpointsView zones={zones} pumpDelay={pumpDelay} setPumpDelay={setPumpDelay} onChange={(id, target) => setZones((cur) => cur.map((z) => (z.id === id ? { ...z, target } : z)))} onUpdateZone={(id, patch) => setZones((cur) => cur.map((z) => (z.id === id ? { ...z, ...patch } : z)))} onAddZone={addZone} onRemoveZone={(z) => setZoneToDelete(z)} />;
    if (activePage === 'Mapa') return <MapView zones={zones} pumpOn={pumpOn} onAddZone={addZoneFromMap} onDragZone={updateZonePosition} onRenameZone={renameZone} />;
    if (activePage === 'Histórico') return <HistoryView errors={errors} eventLog={eventLog} eventLogLoading={eventLogLoading} onRefresh={loadEvents} />;
    if (activePage === 'Comandos') return <CommandsView zones={zones} pumpOn={pumpOn} systemRunning={systemRunning} starting={starting} startStep={startStep} autoMode={autoMode} onToggleZone={toggleZone} onTogglePump={togglePump} onToggleMode={toggleAutoMode} onAction={showNotice} onEmergencyStop={handleEmergencyStop} onTestCycle={handleTestCycle} onStart={handleStart} onStop={handleStop} onReset={handleReset} />;
    return <AlarmsView errors={errors} onResolve={(id) => setErrors((cur) => cur.map((e) => (e.id === id ? { ...e, resolved: true } : e)))} />;
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="brand">
          <div className="brand-mark"><Leaf size={22} /></div>
          <div><strong>GTC</strong><span>REGA</span></div>
          <button className="close-menu" onClick={() => setMobileOpen(false)} aria-label="Fechar menu"><X size={18} /></button>
        </div>
        <div className="sidebar-label">CONTROLO CENTRAL</div>
        <nav className="side-nav" aria-label="Navegação principal">
          {pages.map(({ label, icon: Icon }) => (
            <button key={label} className={activePage === label ? 'nav-item active' : 'nav-item'} onClick={() => { setActivePage(label); setMobileOpen(false); }}>
              <Icon size={19} strokeWidth={1.8} /><span>{label}</span>
              {label === 'Alarmes' && alarmCount > 0 && <span className="nav-count">{alarmCount}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <StatusBadge tone="success">Sistema em operação</StatusBadge>
          <div className="footer-reading"><TimerReset size={17} /><div><strong>21:16</strong><span>10/08/2026</span></div></div>
          <div className="footer-reading"><CloudSun size={19} /><div><strong>24°C</strong><span>Leiria · Parcialmente nublado</span></div></div>
          <div className="footer-reading"><Cpu size={17} /><div><strong>ESP32-S3</strong><span>Controlador principal</span></div></div>
        </div>
      </aside>
      {mobileOpen && <button className="scrim" onClick={() => setMobileOpen(false)} aria-label="Fechar menu" />}
      <main className="main-content">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Abrir menu"><Menu size={22} /></button>
          <div className="topbar-title">
            <div className="eyebrow">CENTRO DE OPERAÇÕES <span>•</span> 10 AGO 2026</div>
            <h1>GTC <span>—</span> Sistema de Rega Automatizada</h1>
            <p>Monitorização e controlo do sistema de rega · ESP32-S3</p>
          </div>
          <div className="topbar-right">
            <div className="weather"><CloudSun size={28} /><div><strong>24°C</strong><span>Leiria, Portugal · Parcialmente nublado</span></div></div>
            <button className="settings-btn" onClick={() => setSettingsOpen(true)} aria-label="Abrir definições"><Settings2 size={20} /></button>
          </div>
        </header>
        <div className="page-heading">
          <div><span className="section-kicker">VISÃO GERAL</span><h2>{activePage}</h2></div>
          <div className="connection"><Radio size={15} /> Ligação estável <span className="pulse" /></div>
        </div>
        {renderPage()}
        <footer className="app-footer">
          <span>Desenvolvido por <strong>Deogracia de Castro</strong></span>
          <span className="footer-divider">·</span>
          <span>GTC Rega v2.6 · ESP32-S3 · Build 2026-08-10</span>
        </footer>
      </main>
      {notice && <div className="toast"><CheckCircle2 size={18} />{notice}</div>}
      {zoneToDelete && <ConfirmDeleteModal zone={zoneToDelete} onCancel={() => setZoneToDelete(null)} onConfirm={confirmDeleteZone} />}
      {settingsOpen && <SettingsPanel language={language} setLanguage={setLanguage} username={username} setUsername={setUsername} password={password} setPassword={setPassword} saved={settingsSaved} onSave={saveSettings} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

/* ---------- Overview ---------- */
function Overview({ zones, pumpOn, autoMode, activeZones, onToggleZone, onTogglePump, onToggleMode, onOpenMap }: { zones: Zone[]; pumpOn: boolean; autoMode: boolean; activeZones: number; onToggleZone: (id: string) => void; onTogglePump: () => void; onToggleMode: () => void; onOpenMap: () => void }) {
  return (
    <div className="content-stack">
      <Panel className="hero-panel">
        <div className="hero-status">
          <div className="system-orbit"><div className="orbit-ring" /><div className="orbit-core"><Leaf size={39} /></div></div>
          <div>
            <span className="label">ESTADO DO SISTEMA</span>
            <h3>{autoMode ? 'Automático' : 'Manual'}</h3>
            <button className={`mode-toggle-btn ${autoMode ? 'mode-auto' : 'mode-manual'}`} onClick={onToggleMode}>
              <Settings2 size={14} />{autoMode ? 'Automático' : 'Manual'}<span className="mode-pulse" />
            </button>
          </div>
        </div>
        <div className="hero-divider" />
        <div className="actuator-list">
          <div className="panel-title-row"><span>ATUADORES</span><small>{activeZones} ativos</small></div>
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
          <div className="panel-title-row"><div><span className="section-kicker">ATENÇÃO OPERACIONAL</span><h3>Próxima rega</h3></div><TimerReset size={20} /></div>
          <div className="next-irrigation"><strong>Zona 2</strong><span>Agendada para amanhã às 06:30</span><ChevronRight size={18} /></div>
        </Panel>
        <Panel className="quick-panel alarm-preview">
          <div className="panel-title-row"><div><span className="section-kicker">SISTEMA</span><h3>Alertas recentes</h3></div><AlertTriangle size={20} /></div>
          <div className="alert-line"><span className="alert-icon"><AlertTriangle size={15} /></span><div><strong>Sensor B2</strong><span>Leitura dentro do intervalo normal</span></div><small>há 4 min</small></div>
        </Panel>
      </div>
      <div className="overview-map-link">
        <Panel className="quick-panel">
          <div className="panel-title-row"><div><span className="section-kicker">LOCALIZAÇÃO</span><h3>Mapa dos sensores</h3></div><MapIcon size={20} /></div>
          <button className="action-button" onClick={onOpenMap}><MapIcon size={20} /><span><strong>Ver mapa completo</strong><small>Localização e estado de cada sensor na propriedade</small></span><ChevronRight size={17} /></button>
        </Panel>
      </div>
    </div>
  );
}

function ActuatorRow({ icon, label, on, onToggle }: { icon: React.ReactNode; label: string; on: boolean; onToggle: () => void }) {
  return <div className="actuator-row"><span className="actuator-icon">{icon}</span><strong>{label}</strong><button className={`switch ${on ? 'switch-on' : ''}`} onClick={onToggle} aria-label={`Alternar ${label}`}><span /></button><span className={`actuator-state ${on ? 'on' : ''}`}>{on ? 'LIGADO' : 'DESLIGADO'}</span></div>;
}

function SensorCard({ zone }: { zone: Zone }) {
  return (
    <Panel className="sensor-card">
      <div className="sensor-header">
        <div><span className="section-kicker">SENSOR {zone.sensorId}</span><h3>{zone.name}</h3></div>
        <StatusBadge tone={zone.moisture >= zone.target ? 'success' : 'warning'}>{zone.moisture >= zone.target ? 'Normal' : 'Atenção'}</StatusBadge>
      </div>
      <div className="sensor-reading">
        <div className="water-icon"><Droplets size={24} /></div>
        <strong>{zone.moisture}<small>%</small></strong>
        <span>Humidade do solo</span>
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
function StateView({ zones, pumpOn, autoMode, onToggleMode }: { zones: Zone[]; pumpOn: boolean; autoMode: boolean; onToggleMode: () => void }) {
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
    </div>
  );
}

function StateRow({ icon, title, detail, status, active }: { icon: React.ReactNode; title: string; detail: string; status: string; active?: boolean }) {
  return <div className="state-row"><span className="state-icon">{icon}</span><div><strong>{title}</strong><span>{detail}</span></div><StatusBadge tone={active ? 'cyan' : 'neutral'}>{status}</StatusBadge></div>;
}

function PanelHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  return <div className="panel-heading"><div><span className="section-kicker">{eyebrow}</span><h3>{title}</h3></div><Settings2 size={19} /></div>;
}

/* ---------- Setpoints com teclado alfanumérico ---------- */
function SetpointsView({ zones, onChange, onUpdateZone, pumpDelay, setPumpDelay, onAddZone, onRemoveZone }: {
  zones: Zone[];
  onChange: (id: string, target: number) => void;
  onUpdateZone: (id: string, patch: Partial<Zone>) => void;
  pumpDelay: number;
  setPumpDelay: (n: number) => void;
  onAddZone: () => void;
  onRemoveZone: (zone: Zone) => void;
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
            <PanelHeader eyebrow={`CONFIGURAÇÃO · SENSOR ${zone.sensorId}`} title={zone.name} />
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
          </Panel>
        ))}
      </div>
      {keyboard && <NumericKeyboard value={keyboard.value} onChange={(v) => setKeyboard((k) => (k ? { ...k, value: v } : k))} onSubmit={submitKeyboard} onClose={() => setKeyboard(null)} />}
    </>
  );
}

/* ---------- Mapa ---------- */
function MapView({ zones, pumpOn, onAddZone, onDragZone, onRenameZone }: {
  zones: Zone[];
  pumpOn: boolean;
  onAddZone: (x: number, y: number) => void;
  onDragZone: (id: string, x: number, y: number) => void;
  onRenameZone: (id: string, name: string) => void;
}) {
  const pumpPos = { x: 50, y: 82 };
  const mcuPos = { x: 50, y: 90 };
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editNameValue, setEditNameValue] = useState('');

  const handleCanvasClick = (e: React.MouseEvent) => {
    if (dragging) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    if (x < 5 || x > 95 || y < 5 || y > 78) return;
    onAddZone(x, y);
  };

  const handleMarkerMouseDown = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    e.preventDefault();
    setDragging(id);
  };

  useEffect(() => {
    if (!dragging) return;
    const handleMove = (e: MouseEvent) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(5, Math.min(95, ((e.clientX - rect.left) / rect.width) * 100));
      const y = Math.max(5, Math.min(78, ((e.clientY - rect.top) / rect.height) * 100));
      onDragZone(dragging, x, y);
    };
    const handleUp = () => setDragging(null);
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [dragging, onDragZone]);

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

  return (
    <Panel className="map-panel">
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
      <div className="map-hint"><MapPin size={14} /> Clique no mapa para adicionar um novo local · Arraste os marcadores para reposicionar</div>
      <div className="map-canvas" ref={canvasRef} onClick={handleCanvasClick}>
        <div className="map-grid-bg" />
        <div className="map-field field-a" />
        <div className="map-field field-b" />
        <svg className="map-pipes" viewBox="0 0 100 100" preserveAspectRatio="none">
          {zones.map((zone) => {
            const vx = zone.x + 6;
            const vy = zone.y + 4;
            const sx = zone.x - 6;
            const sy = zone.y - 4;
            return (
              <g key={zone.id}>
                <line x1={mcuPos.x} y1={mcuPos.y} x2={sx} y2={sy} className={`pipe pipe-mcu ${zone.on ? 'pipe-active' : ''}`} />
                <line x1={sx} y1={sy} x2={vx} y2={vy} className={`pipe pipe-sensor ${zone.on ? 'pipe-active' : ''}`} />
                <line x1={vx} y1={vy} x2={pumpPos.x} y2={pumpPos.y} className={`pipe pipe-main ${zone.on ? 'pipe-active' : ''}`} />
              </g>
            );
          })}
        </svg>
        <div className="map-marker marker-pump" style={{ left: `${pumpPos.x}%`, top: `${pumpPos.y}%` }}>
          <span className="marker-pin marker-pin-pump"><Waves size={16} /></span>
          <div className="marker-label">
            <strong>Bomba K1</strong>
            <span>{pumpOn ? 'Ligada' : 'Desligada'}</span>
          </div>
        </div>
        <div className="map-marker marker-mcu" style={{ left: `${mcuPos.x}%`, top: `${mcuPos.y}%` }}>
          <span className="marker-pin marker-pin-mcu"><Cpu size={14} /></span>
          <div className="marker-label">
            <strong>ESP32-S3</strong>
            <span>Microcontrolador</span>
          </div>
        </div>
        {zones.map((zone) => {
          const status = sensorStatus(zone);
          const vx = zone.x + 6;
          const vy = zone.y + 4;
          const sx = zone.x - 6;
          const sy = zone.y - 4;
          return (
            <div key={zone.id} className="map-zone-group">
              <div
                className={`map-marker marker-valve ${zone.on ? 'valve-open' : ''} ${dragging === zone.id ? 'dragging' : ''}`}
                style={{ left: `${vx}%`, top: `${vy}%` }}
                onMouseDown={(e) => handleMarkerMouseDown(e, zone.id)}
              >
                <span className="marker-pin marker-pin-valve">{zone.id}</span>
                <div className="marker-label">
                  <strong>Válvula {zone.id}</strong>
                  <span>{zone.on ? 'Aberta' : 'Fechada'}</span>
                </div>
              </div>
              <div
                className={`map-marker marker-sensor marker-${status} ${dragging === zone.id ? 'dragging' : ''}`}
                style={{ left: `${sx}%`, top: `${sy}%` }}
                onMouseDown={(e) => handleMarkerMouseDown(e, zone.id)}
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
                        {zone.name} <button className="marker-edit-btn" onClick={(e) => startEditName(e, zone)} aria-label="Editar nome"><PencilLine size={11} /></button>
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
      {editingName && (
        <TextKeyboard
          value={editNameValue}
          onChange={setEditNameValue}
          onSubmit={submitNameEdit}
          onClose={() => { setEditingName(null); setEditNameValue(''); }}
        />
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
function SettingsPanel({ language, setLanguage, username, setUsername, password, setPassword, saved, onSave, onClose }: {
  language: Language;
  setLanguage: (l: Language) => void;
  username: string;
  setUsername: (v: string) => void;
  password: string;
  setPassword: (v: string) => void;
  saved: boolean;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <aside className="settings-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <div><span className="section-kicker">PREFERÊNCIAS</span><h3>Definições</h3></div>
          <button className="drawer-close" onClick={onClose} aria-label="Fechar"><X size={19} /></button>
        </div>
        <div className="settings-section">
          <div className="settings-label"><Globe2 size={18} /><div><strong>Idioma</strong><span>Escolha o idioma do painel.</span></div></div>
          <div className="language-toggle">
            <button className={language === 'PT' ? 'selected' : ''} onClick={() => setLanguage('PT')}>Português</button>
            <button className={language === 'EN' ? 'selected' : ''} onClick={() => setLanguage('EN')}>English</button>
          </div>
        </div>
        <div className="settings-section">
          <div className="settings-label"><UserRound size={18} /><div><strong>Conta do operador</strong><span>Atualize os dados de acesso ao painel.</span></div></div>
          <label className="field-label">Utilizador<input value={username} onChange={(e) => setUsername(e.target.value)} /></label>
          <label className="field-label">Nova palavra-passe<input type="password" placeholder="Deixe vazio para manter" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
          <div className="security-note"><LockKeyhole size={15} /> Os dados de acesso ficam protegidos neste dispositivo.</div>
        </div>
        <div className="drawer-footer">
          <button className={`save-btn ${saved ? 'saved' : ''}`} onClick={onSave}><Save size={17} /> {saved ? 'Definições guardadas' : 'Guardar alterações'}</button>
        </div>
      </aside>
    </div>
  );
}

/* ---------- Histórico de Erros + Eventos Reais ---------- */
function HistoryView({ errors, eventLog, eventLogLoading, onRefresh }: { errors: ErrorEvent[]; eventLog: EventLogEntry[]; eventLogLoading: boolean; onRefresh: () => void }) {
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
function CommandsView({ zones, pumpOn, systemRunning, starting, startStep, autoMode, onToggleZone, onTogglePump, onToggleMode, onAction, onEmergencyStop, onTestCycle, onStart, onStop, onReset }: {
  zones: Zone[];
  pumpOn: boolean;
  systemRunning: boolean;
  starting: boolean;
  startStep: string;
  autoMode: boolean;
  onToggleZone: (id: string) => void;
  onTogglePump: () => void;
  onToggleMode: () => void;
  onAction: (m: string) => void;
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
function AlarmsView({ errors, onResolve }: { errors: ErrorEvent[]; onResolve: (id: string) => void }) {
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

export default App;
