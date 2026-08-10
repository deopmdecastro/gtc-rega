import { useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bell,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  CircleGauge,
  CloudSun,
  Droplets,
  Gauge,
  History,
  Home,
  Leaf,
  Menu,
  PlayCircle,
  Power,
  Radio,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  TimerReset,
  Waves,
  X,
} from 'lucide-react';

type Page = 'Resumo' | 'Estado' | 'Setpoints' | 'Histórico' | 'Comandos' | 'Alarmes';
type Zone = { id: string; name: string; moisture: number; target: number; lastWatered: string; on: boolean };

const pages: { label: Page; icon: typeof Home }[] = [
  { label: 'Resumo', icon: Home },
  { label: 'Estado', icon: Activity },
  { label: 'Setpoints', icon: SlidersHorizontal },
  { label: 'Histórico', icon: History },
  { label: 'Comandos', icon: PlayCircle },
  { label: 'Alarmes', icon: Bell },
];

const initialZones: Zone[] = [
  { id: 'Y1', name: 'Zona 1', moisture: 64, target: 55, lastWatered: 'Hoje, 18:12', on: false },
  { id: 'Y2', name: 'Zona 2', moisture: 57, target: 52, lastWatered: 'Hoje, 17:48', on: false },
];

function StatusBadge({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'success' | 'warning' | 'neutral' | 'cyan' }) {
  return <span className={`status-badge status-${tone}`}><span className="status-dot" />{children}</span>;
}

function Panel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{children}</section>;
}

function App() {
  const [activePage, setActivePage] = useState<Page>('Resumo');
  const [zones, setZones] = useState(initialZones);
  const [pumpOn, setPumpOn] = useState(false);
  const [autoMode] = useState(true);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [notice, setNotice] = useState('');

  const activeZones = useMemo(() => zones.filter((zone) => zone.on).length, [zones]);
  const toggleZone = (id: string) => setZones((current) => current.map((zone) => zone.id === id ? { ...zone, on: !zone.on } : zone));
  const showNotice = (message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 2800);
  };

  const renderPage = () => {
    if (activePage === 'Resumo') {
      return <Overview zones={zones} pumpOn={pumpOn} autoMode={autoMode} activeZones={activeZones} onToggleZone={toggleZone} onTogglePump={() => setPumpOn((value) => !value)} />;
    }
    if (activePage === 'Estado') return <StateView zones={zones} pumpOn={pumpOn} autoMode={autoMode} />;
    if (activePage === 'Setpoints') return <SetpointsView zones={zones} onChange={(id, target) => setZones((current) => current.map((zone) => zone.id === id ? { ...zone, target } : zone))} />;
    if (activePage === 'Histórico') return <HistoryView />;
    if (activePage === 'Comandos') return <CommandsView zones={zones} pumpOn={pumpOn} onToggleZone={toggleZone} onTogglePump={() => setPumpOn((value) => !value)} onAction={showNotice} />;
    return <AlarmsView />;
  };

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
        <div className="brand"><div className="brand-mark"><Leaf size={22} /></div><div><strong>GTC</strong><span>REGA</span></div><button className="close-menu" onClick={() => setMobileOpen(false)} aria-label="Fechar menu"><X size={18} /></button></div>
        <div className="sidebar-label">CONTROLO CENTRAL</div>
        <nav className="side-nav" aria-label="Navegação principal">
          {pages.map(({ label, icon: Icon }) => <button key={label} className={activePage === label ? 'nav-item active' : 'nav-item'} onClick={() => { setActivePage(label); setMobileOpen(false); }}><Icon size={19} strokeWidth={1.8} /><span>{label}</span>{label === 'Alarmes' && <span className="nav-count">1</span>}</button>)}
        </nav>
        <div className="sidebar-footer"><StatusBadge tone="success">Sistema em operação</StatusBadge><div className="footer-reading"><TimerReset size={17} /><div><strong>21:16</strong><span>10/08/2026</span></div></div><div className="footer-reading"><CloudSun size={19} /><div><strong>24°C</strong><span>Parcialmente nublado</span></div></div></div>
      </aside>
      {mobileOpen && <button className="scrim" onClick={() => setMobileOpen(false)} aria-label="Fechar menu" />}
      <main className="main-content">
        <header className="topbar"><button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Abrir menu"><Menu size={22} /></button><div><div className="eyebrow">CENTRO DE OPERAÇÕES <span>•</span> 10 AGO 2026</div><h1>GTC <span>—</span> Sistema de Rega Automatizada</h1><p>Monitorização e controlo do sistema de rega</p></div><div className="weather"><CloudSun size={28} /><div><strong>24°C</strong><span>Parcialmente nublado</span></div></div></header>
        <div className="page-heading"><div><span className="section-kicker">VISÃO GERAL</span><h2>{activePage}</h2></div><div className="connection"><Radio size={15} /> Ligação estável <span className="pulse" /></div></div>
        {renderPage()}
      </main>
      {notice && <div className="toast"><CheckCircle2 size={18} />{notice}</div>}
    </div>
  );
}

function Overview({ zones, pumpOn, autoMode, activeZones, onToggleZone, onTogglePump }: { zones: Zone[]; pumpOn: boolean; autoMode: boolean; activeZones: number; onToggleZone: (id: string) => void; onTogglePump: () => void }) {
  return <div className="content-stack"><Panel className="hero-panel"><div className="hero-status"><div className="system-orbit"><div className="orbit-ring" /><div className="orbit-core"><Leaf size={39} /></div></div><div><span className="label">ESTADO DO SISTEMA</span><h3>{autoMode ? 'Automático' : 'Manual'}</h3><StatusBadge tone="success">Funcionamento normal</StatusBadge></div></div><div className="hero-divider" /><div className="actuator-list"><div className="panel-title-row"><span>ATUADORES</span><small>{activeZones} ativos</small></div><ActuatorRow icon={<Waves />} label="Bomba" on={pumpOn} onToggle={onTogglePump} /><ActuatorRow icon={<Droplets />} label="Zona 1 · Y1" on={zones[0].on} onToggle={() => onToggleZone('Y1')} /><ActuatorRow icon={<Droplets />} label="Zona 2 · Y2" on={zones[1].on} onToggle={() => onToggleZone('Y2')} /></div></Panel><div className="sensor-grid">{zones.map((zone) => <SensorCard key={zone.id} zone={zone} />)}</div><Panel className="metrics-panel"><Metric icon={<CalendarDays />} label="Data" value="10/08/2026" /><Metric icon={<TimerReset />} label="Hora" value="21:16:43" /><Metric icon={<Droplets />} label="Última rega" value="Zona 1 · Y1" detail={zones[0].lastWatered} /><Metric icon={<CheckCircle2 />} label="Estado do sistema" value="Operacional" accent /></Panel><div className="quick-grid"><Panel className="quick-panel"><div className="panel-title-row"><div><span className="section-kicker">ATENÇÃO OPERACIONAL</span><h3>Próxima rega</h3></div><TimerReset size={20} /></div><div className="next-irrigation"><strong>Zona 2</strong><span>Agendada para amanhã às 06:30</span><ChevronRight size={18} /></div></Panel><Panel className="quick-panel alarm-preview"><div className="panel-title-row"><div><span className="section-kicker">SISTEMA</span><h3>Alertas recentes</h3></div><AlertTriangle size={20} /></div><div className="alert-line"><span className="alert-icon"><AlertTriangle size={15} /></span><div><strong>Sensor B2</strong><span>Leitura dentro do intervalo normal</span></div><small>há 4 min</small></div></Panel></div></div>;
}

function ActuatorRow({ icon, label, on, onToggle }: { icon: React.ReactNode; label: string; on: boolean; onToggle: () => void }) { return <div className="actuator-row"><span className="actuator-icon">{icon}</span><strong>{label}</strong><button className={`switch ${on ? 'switch-on' : ''}`} onClick={onToggle} aria-label={`Alternar ${label}`}><span /></button><span className={`actuator-state ${on ? 'on' : ''}`}>{on ? 'LIGADO' : 'DESLIGADO'}</span></div>; }
function SensorCard({ zone }: { zone: Zone }) { return <Panel className="sensor-card"><div className="sensor-header"><div><span className="section-kicker">SENSOR {zone.id}</span><h3>{zone.name}</h3></div><StatusBadge tone={zone.moisture >= zone.target ? 'success' : 'warning'}>{zone.moisture >= zone.target ? 'Normal' : 'Atenção'}</StatusBadge></div><div className="sensor-reading"><div className="water-icon"><Droplets size={24} /></div><strong>{zone.moisture}<small>%</small></strong><span>Humidade do solo</span></div><div className="meter"><span style={{ width: `${zone.moisture}%` }} /></div><div className="sensor-footer"><span>Setpoint <b>{zone.target}%</b></span><span>Atualizado agora</span></div></Panel>; }
function Metric({ icon, label, value, detail, accent }: { icon: React.ReactNode; label: string; value: string; detail?: string; accent?: boolean }) { return <div className="metric"><span className="metric-icon">{icon}</span><div><span className="label">{label}</span><strong className={accent ? 'accent-text' : ''}>{value}</strong>{detail && <small>{detail}</small>}</div></div>; }

function StateView({ zones, pumpOn, autoMode }: { zones: Zone[]; pumpOn: boolean; autoMode: boolean }) { return <div className="two-column"><Panel><PanelHeader eyebrow="LEITURA EM TEMPO REAL" title="Estado dos equipamentos" /><div className="state-list"><StateRow icon={<CircleGauge />} title="Controlador central" detail="PLC-01 · Comunicação Modbus" status="Online" /><StateRow icon={<Power />} title="Bomba principal" detail="Relé K1 · Saída digital" status={pumpOn ? 'Ligada' : 'Desligada'} active={pumpOn} /><StateRow icon={<Droplets />} title="Zona 1 · Válvula Y1" detail="Válvula solenóide" status={zones[0].on ? 'Ligada' : 'Desligada'} active={zones[0].on} /><StateRow icon={<Droplets />} title="Zona 2 · Válvula Y2" detail="Válvula solenóide" status={zones[1].on ? 'Ligada' : 'Desligada'} active={zones[1].on} /></div></Panel><Panel><PanelHeader eyebrow="MODO DE OPERAÇÃO" title="Automação" /><div className="mode-card"><div className="mode-graphic"><Sparkles size={25} /></div><div><strong>{autoMode ? 'Automático' : 'Manual'}</strong><p>{autoMode ? 'O sistema gere a rega com base nos setpoints.' : 'Os atuadores aguardam comandos manuais.'}</p></div><StatusBadge tone="cyan">Ativo</StatusBadge></div><div className="info-list"><div><span>Última sincronização</span><strong>há 12 segundos</strong></div><div><span>Tempo de atividade</span><strong>14 dias, 08h 32m</strong></div><div><span>Versão do controlador</span><strong>GTC v2.4.1</strong></div></div></Panel></div>; }
function StateRow({ icon, title, detail, status, active }: { icon: React.ReactNode; title: string; detail: string; status: string; active?: boolean }) { return <div className="state-row"><span className="state-icon">{icon}</span><div><strong>{title}</strong><span>{detail}</span></div><StatusBadge tone={active ? 'cyan' : 'neutral'}>{status}</StatusBadge></div>; }
function PanelHeader({ eyebrow, title }: { eyebrow: string; title: string }) { return <div className="panel-heading"><div><span className="section-kicker">{eyebrow}</span><h3>{title}</h3></div><Settings2 size={19} /></div>; }

function SetpointsView({ zones, onChange }: { zones: Zone[]; onChange: (id: string, target: number) => void }) { return <div className="two-column">{zones.map((zone) => <Panel key={zone.id} className="setpoint-card"><PanelHeader eyebrow={`CONFIGURAÇÃO · SENSOR ${zone.id}`} title={zone.name} /><div className="setpoint-value"><strong>{zone.target}<small>%</small></strong><span>Humidade mínima desejada</span></div><input type="range" min="20" max="90" value={zone.target} onChange={(event) => onChange(zone.id, Number(event.target.value))} /><div className="range-labels"><span>20%</span><span>90%</span></div><div className="setpoint-note"><Gauge size={16} /><span>Atual: <b>{zone.moisture}%</b> · {zone.moisture >= zone.target ? 'acima do mínimo' : 'abaixo do mínimo'}</span></div></Panel>)}</div>; }
function HistoryView() { return <div className="two-column"><Panel className="chart-panel"><PanelHeader eyebrow="ÚLTIMAS 24 HORAS" title="Humidade por zona" /><div className="chart"><div className="chart-grid"><span>80%</span><span>60%</span><span>40%</span><span>20%</span></div><div className="chart-lines"><div className="line line-a" /><div className="line line-b" /><div className="chart-labels"><span>00h</span><span>06h</span><span>12h</span><span>18h</span><span>Agora</span></div></div></div><div className="legend"><span><i className="legend-a" />Zona 1</span><span><i className="legend-b" />Zona 2</span></div></Panel><Panel><PanelHeader eyebrow="REGISTO DE ATIVIDADE" title="Últimas regas" /><div className="history-list"><HistoryItem time="18:12" zone="Zona 1 · Y1" duration="08 min" /><HistoryItem time="17:48" zone="Zona 2 · Y2" duration="06 min" /><HistoryItem time="06:30" zone="Zona 1 · Y1" duration="10 min" /></div></Panel></div>; }
function HistoryItem({ time, zone, duration }: { time: string; zone: string; duration: string }) { return <div className="history-item"><span className="history-time">{time}</span><div><strong>{zone}</strong><span>Rega concluída</span></div><small>{duration}</small></div>; }
function CommandsView({ zones, pumpOn, onToggleZone, onTogglePump, onAction }: { zones: Zone[]; pumpOn: boolean; onToggleZone: (id: string) => void; onTogglePump: () => void; onAction: (message: string) => void }) { return <div className="commands-layout"><Panel><PanelHeader eyebrow="CONTROLO MANUAL" title="Atuadores" /><div className="command-list"><CommandRow icon={<Waves />} label="Bomba principal" description="Relé K1" on={pumpOn} onToggle={onTogglePump} /><CommandRow icon={<Droplets />} label="Zona 1 · Y1" description="Válvula solenóide" on={zones[0].on} onToggle={() => onToggleZone('Y1')} /><CommandRow icon={<Droplets />} label="Zona 2 · Y2" description="Válvula solenóide" on={zones[1].on} onToggle={() => onToggleZone('Y2')} /></div></Panel><Panel><PanelHeader eyebrow="AÇÃO RÁPIDA" title="Rotinas do sistema" /><button className="action-button" onClick={() => onAction('Ciclo de teste iniciado')}><PlayCircle size={20} /><span><strong>Executar ciclo de teste</strong><small>Verifica bomba e válvulas durante 30 segundos</small></span><ChevronRight size={17} /></button><button className="action-button" onClick={() => onAction('Todas as zonas foram desligadas')}><Power size={20} /><span><strong>Paragem de emergência</strong><small>Desliga todos os atuadores ativos</small></span><ChevronRight size={17} /></button></Panel></div>; }
function CommandRow({ icon, label, description, on, onToggle }: { icon: React.ReactNode; label: string; description: string; on: boolean; onToggle: () => void }) { return <div className="command-row"><span className="command-icon">{icon}</span><div><strong>{label}</strong><span>{description}</span></div><button className={`switch ${on ? 'switch-on' : ''}`} onClick={onToggle} aria-label={`Alternar ${label}`}><span /></button></div>; }
function AlarmsView() { return <div className="alarms-layout"><Panel className="alarm-banner"><div className="alarm-banner-icon"><AlertTriangle size={22} /></div><div><span className="section-kicker">ESTADO DOS ALARMES</span><h3>1 evento informativo</h3><p>Não existem falhas que impeçam o funcionamento do sistema.</p></div><StatusBadge tone="warning">Atenção</StatusBadge></Panel><Panel><PanelHeader eyebrow="HISTÓRICO DE EVENTOS" title="Alarmes e notificações" /><div className="alarm-item"><span className="alarm-item-icon"><AlertTriangle size={16} /></span><div><strong>Sensor B2 atualizado</strong><span>Leitura recebida dentro do intervalo esperado.</span></div><small>Hoje, 21:12</small><StatusBadge tone="success">Resolvido</StatusBadge></div></Panel></div>; }

export default App;
