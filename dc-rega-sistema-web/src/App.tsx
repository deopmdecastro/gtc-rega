import { useMemo, useState } from 'react';
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
  History,
  Home,
  Leaf,
  Menu,
  Play,
  PlayCircle,
  Plus,
  Power,
  Radio,
  RotateCcw,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Square,
  TimerReset,
  Trash2,
  Waves,
  X,
} from 'lucide-react';

type Page = 'Resumo' | 'Estado' | 'Setpoints' | 'Histórico' | 'Comandos' | 'Alarmes';
type Zone = {
  id: string;
  name: string;
  moisture: number;
  target: number;
  lastWatered: string;
  on: boolean;
  waterDuration: number;
};

type ErrorEvent = {
  id: string;
  time: string;
  source: string;
  message: string;
  severity: 'critical' | 'warning' | 'info';
  resolved: boolean;
};

const pages: { label: Page; icon: typeof Home }[] = [
  { label: 'Resumo', icon: Home },
  { label: 'Estado', icon: Activity },
  { label: 'Setpoints', icon: SlidersHorizontal },
  { label: 'Histórico', icon: History },
  { label: 'Comandos', icon: PlayCircle },
  { label: 'Alarmes', icon: Bell },
];

const initialZones: Zone[] = [
  { id: 'Y1', name: 'Zona 1', moisture: 64, target: 55, lastWatered: 'Hoje, 18:12', on: false, waterDuration: 60 },
  { id: 'Y2', name: 'Zona 2', moisture: 57, target: 52, lastWatered: 'Hoje, 17:48', on: false, waterDuration: 45 },
];

const initialErrors: ErrorEvent[] = [
  { id: 'E001', time: 'Hoje, 21:12', source: 'Sensor B2', message: 'Leitura recebida dentro do intervalo esperado.', severity: 'info', resolved: true },
  { id: 'E002', time: 'Hoje, 14:03', source: 'Bomba K1', message: 'Sobrecorrente detectada no relé K1 durante o arranque.', severity: 'warning', resolved: true },
  { id: 'E003', time: 'Ontem, 06:30', source: 'Comunicação', message: 'Timeout Modbus no barramento RS485 — sensor Y1.', severity: 'critical', resolved: true },
];

function StatusBadge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'success' | 'warning' | 'error' | 'neutral' | 'cyan' }) {
  return <span className={`status-badge status-${tone}`}><span className="status-dot" />{children}</span>;
}

function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{children}</section>;
}

let nextZoneId = 3;
function makeZoneId() {
  return `Y${nextZoneId++}`;
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

  const activeZones = useMemo(() => zones.filter((z) => z.on).length, [zones]);
  const alarmCount = useMemo(() => errors.filter((e) => !e.resolved).length, [errors]);

  const toggleZone = (id: string) => setZones((cur) => cur.map((z) => (z.id === id ? { ...z, on: !z.on } : z)));
  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 2800);
  };

  const addZone = () => {
    const id = makeZoneId();
    const num = zones.length + 1;
    setZones((cur) => [...cur, { id, name: `Zona ${num}`, moisture: 50, target: 50, lastWatered: '—', on: false, waterDuration: 30 }]);
    showNotice(`Sensor ${id} adicionado`);
  };

  const removeZone = (id: string) => {
    setZones((cur) => cur.filter((z) => z.id !== id));
    showNotice(`Sensor ${id} removido`);
  };

  const handleStart = () => {
    setSystemRunning(true);
    setPumpOn(true);
    setAutoMode(true);
    setZones((cur) => cur.map((z, i) => (i === 0 ? { ...z, on: true } : z)));
    showNotice('Sistema iniciado');
  };
  const handleStop = () => {
    setSystemRunning(false);
    setPumpOn(false);
    setZones((cur) => cur.map((z) => ({ ...z, on: false })));
    showNotice('Sistema parado');
  };
  const handleReset = () => {
    setSystemRunning(false);
    setPumpOn(false);
    setZones((cur) => cur.map((z) => ({ ...z, on: false, moisture: Math.max(20, Math.min(90, Math.round(z.moisture))) })));
    setErrors((cur) => cur.map((e) => ({ ...e, resolved: true })));
    showNotice('Sistema reiniciado');
  };

  const renderPage = () => {
    if (activePage === 'Resumo') {
      return <Overview zones={zones} pumpOn={pumpOn} autoMode={autoMode} activeZones={activeZones} onToggleZone={toggleZone} onTogglePump={() => setPumpOn((v) => !v)} />;
    }
    if (activePage === 'Estado') return <StateView zones={zones} pumpOn={pumpOn} autoMode={autoMode} />;
    if (activePage === 'Setpoints') return <SetpointsView zones={zones} pumpDelay={pumpDelay} setPumpDelay={setPumpDelay} onChange={(id, target) => setZones((cur) => cur.map((z) => (z.id === id ? { ...z, target } : z)))} onUpdateZone={(id, patch) => setZones((cur) => cur.map((z) => (z.id === id ? { ...z, ...patch } : z)))} onAddZone={addZone} onRemoveZone={removeZone} />;
    if (activePage === 'Histórico') return <HistoryView errors={errors} />;
    if (activePage === 'Comandos') return <CommandsView zones={zones} pumpOn={pumpOn} systemRunning={systemRunning} onToggleZone={toggleZone} onTogglePump={() => setPumpOn((v) => !v)} onAction={showNotice} onStart={handleStart} onStop={handleStop} onReset={handleReset} />;
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
          <div className="footer-reading"><CloudSun size={19} /><div><strong>24°C</strong><span>Parcialmente nublado</span></div></div>
          <div className="footer-reading"><Cpu size={17} /><div><strong>ESP32-S3</strong><span>Controlador principal</span></div></div>
        </div>
      </aside>
      {mobileOpen && <button className="scrim" onClick={() => setMobileOpen(false)} aria-label="Fechar menu" />}
      <main className="main-content">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Abrir menu"><Menu size={22} /></button>
          <div>
            <div className="eyebrow">CENTRO DE OPERAÇÕES <span>•</span> 10 AGO 2026</div>
            <h1>GTC <span>—</span> Sistema de Rega Automatizada</h1>
            <p>Monitorização e controlo do sistema de rega · ESP32-S3</p>
          </div>
          <div className="weather"><CloudSun size={28} /><div><strong>24°C</strong><span>Parcialmente nublado</span></div></div>
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
    </div>
  );
}

/* ---------- Overview ---------- */
function Overview({ zones, pumpOn, autoMode, activeZones, onToggleZone, onTogglePump }: { zones: Zone[]; pumpOn: boolean; autoMode: boolean; activeZones: number; onToggleZone: (id: string) => void; onTogglePump: () => void }) {
  return (
    <div className="content-stack">
      <Panel className="hero-panel">
        <div className="hero-status">
          <div className="system-orbit"><div className="orbit-ring" /><div className="orbit-core"><Leaf size={39} /></div></div>
          <div>
            <span className="label">ESTADO DO SISTEMA</span>
            <h3>{autoMode ? 'Automático' : 'Manual'}</h3>
            <StatusBadge tone="success">Funcionamento normal</StatusBadge>
          </div>
        </div>
        <div className="hero-divider" />
        <div className="actuator-list">
          <div className="panel-title-row"><span>ATUADORES</span><small>{activeZones} ativos</small></div>
          <ActuatorRow icon={<Waves />} label="Bomba" on={pumpOn} onToggle={onTogglePump} />
          {zones.map((z) => <ActuatorRow key={z.id} icon={<Droplets />} label={`${z.name} · ${z.id}`} on={z.on} onToggle={() => onToggleZone(z.id)} />)}
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
        <div><span className="section-kicker">SENSOR {zone.id}</span><h3>{zone.name}</h3></div>
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
function StateView({ zones, pumpOn, autoMode }: { zones: Zone[]; pumpOn: boolean; autoMode: boolean }) {
  return (
    <div className="two-column">
      <Panel>
        <PanelHeader eyebrow="LEITURA EM TEMPO REAL" title="Estado dos equipamentos" />
        <div className="state-list">
          <StateRow icon={<Cpu />} title="Controlador central" detail="ESP32-S3 · Wi-Fi · RS485" status="Online" />
          <StateRow icon={<Power />} title="Bomba principal" detail="Relé K1 · Saída digital" status={pumpOn ? 'Ligada' : 'Desligada'} active={pumpOn} />
          {zones.map((z) => <StateRow key={z.id} icon={<Droplets />} title={`${z.name} · Válvula ${z.id}`} detail="Válvula solenóide" status={z.on ? 'Ligada' : 'Desligada'} active={z.on} />)}
        </div>
      </Panel>
      <Panel>
        <PanelHeader eyebrow="MODO DE OPERAÇÃO" title="Automação" />
        <div className="mode-card">
          <div className="mode-graphic"><Sparkles size={25} /></div>
          <div><strong>{autoMode ? 'Automático' : 'Manual'}</strong><p>{autoMode ? 'O sistema gere a rega com base nos setpoints.' : 'Os atuadores aguardam comandos manuais.'}</p></div>
          <StatusBadge tone="cyan">Ativo</StatusBadge>
        </div>
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
  onRemoveZone: (id: string) => void;
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
      {zones.map((zone) => (
        <Panel key={zone.id} className="setpoint-card">
          <PanelHeader eyebrow={`CONFIGURAÇÃO · SENSOR ${zone.id}`} title={zone.name} />
          <button className="remove-sensor-btn" onClick={() => onRemoveZone(zone.id)} aria-label={`Remover ${zone.name}`}><Trash2 size={16} /></button>
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
      {keyboard && <NumericKeyboard value={keyboard.value} onChange={(v) => setKeyboard((k) => (k ? { ...k, value: v } : k))} onSubmit={submitKeyboard} onClose={() => setKeyboard(null)} />}
    </>
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

/* ---------- Histórico de Erros ---------- */
function HistoryView({ errors }: { errors: ErrorEvent[] }) {
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
        <PanelHeader eyebrow="REGISTO DE ATIVIDADE" title="Últimas regas" />
        <div className="history-list">
          <HistoryItem time="18:12" zone="Zona 1 · Y1" duration="08 min" />
          <HistoryItem time="17:48" zone="Zona 2 · Y2" duration="06 min" />
          <HistoryItem time="06:30" zone="Zona 1 · Y1" duration="10 min" />
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
  return <div className="history-item"><span className="history-time">{time}</span><div><strong>{zone}</strong><span>Rega concluída</span></div><small>{duration}</small></div>;
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
function CommandsView({ zones, pumpOn, systemRunning, onToggleZone, onTogglePump, onAction, onStart, onStop, onReset }: {
  zones: Zone[];
  pumpOn: boolean;
  systemRunning: boolean;
  onToggleZone: (id: string) => void;
  onTogglePump: () => void;
  onAction: (m: string) => void;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
}) {
  return (
    <div className="commands-layout">
      <Panel>
        <PanelHeader eyebrow="CONTROLO DO SISTEMA" title="Comandos principais" />
        <div className="command-actions">
          <button className={`cmd-btn cmd-start ${systemRunning ? 'active' : ''}`} onClick={onStart}>
            <Play size={24} />
            <span><strong>Start</strong><small>Inicia o sistema de rega</small></span>
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
      </Panel>
      <Panel>
        <PanelHeader eyebrow="CONTROLO MANUAL" title="Atuadores" />
        <div className="command-list">
          <CommandRow icon={<Waves />} label="Bomba principal" description="Relé K1" on={pumpOn} onToggle={onTogglePump} />
          {zones.map((z) => <CommandRow key={z.id} icon={<Droplets />} label={`${z.name} · ${z.id}`} description="Válvula solenóide" on={z.on} onToggle={() => onToggleZone(z.id)} />)}
        </div>
      </Panel>
      <Panel>
        <PanelHeader eyebrow="AÇÃO RÁPIDA" title="Rotinas do sistema" />
        <button className="action-button" onClick={() => onAction('Ciclo de teste iniciado')}><PlayCircle size={20} /><span><strong>Executar ciclo de teste</strong><small>Verifica bomba e válvulas durante 30 segundos</small></span><ChevronRight size={17} /></button>
        <button className="action-button" onClick={() => onAction('Todas as zonas foram desligadas')}><Power size={20} /><span><strong>Paragem de emergência</strong><small>Desliga todos os atuadores ativos</small></span><ChevronRight size={17} /></button>
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
