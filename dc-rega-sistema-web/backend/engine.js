/**
 * GTC Rega — Control Engine
 * 
 * Máquina de estados do controlador de rega.
 * Simula GPIOs, temporizadores, sensores e ciclo automático.
 *
 * Estados do sistema:
 *   IDLE       → parado, aguardando comando
 *   STARTING   → bomba ligada, aguardando delay antes de abrir válvulas
 *   WATERING   → zona ativa a regar (temporizador da válvula)
 *   STOPPING   → a fechar válvulas e desligar bomba
 *   EMERGENCY  → paragem de emergência (tudo desligado, requer reset)
 */

// ── Constantes GPIO ──
const GPIO = {
  SENSOR_B1: 4,
  SENSOR_B2: 5,
  RELAY_K3_TIMER1: 6,
  RELAY_K4_TIMER2: 7,
  RELAY_K5_START: 8,
  RELAY_K6_STOP: 9,
  RELAY_K7_AUTO: 10,
  RELAY_K8_RESERVA: 11,
  RELAY_K9_RESERVA: 12,
  RELAY_K10_RESERVA: 13,
};

// ── Estados ──
const STATES = {
  IDLE: 'idle',
  STARTING: 'starting',
  WATERING: 'watering',
  STOPPING: 'stopping',
  EMERGENCY: 'emergency',
};

class ControlEngine {
  constructor() {
    this.state = STATES.IDLE;
    this.pumpOn = false;
    this.autoMode = true;
    this.zones = [];
    this.currentZoneIndex = -1;
    this.timers = [];
    this.cycleActive = false;
    this.testCycleActive = false;
    this.startTime = null;
    this.watchdogTimer = null;
    this.watchdogTimeout = 60000; // 60s max per zone before force-stop
    this.errors = [];
    this.uptime = 0;
    
    // GPIO virtual states
    this.gpio = {
      [GPIO.SENSOR_B1]: 0,  // leitura analógica simulada (0-100)
      [GPIO.SENSOR_B2]: 0,
      [GPIO.RELAY_K3_TIMER1]: false,
      [GPIO.RELAY_K4_TIMER2]: false,
      [GPIO.RELAY_K5_START]: false,
      [GPIO.RELAY_K6_STOP]: false,
      [GPIO.RELAY_K7_AUTO]: false,
      [GPIO.RELAY_K8_RESERVA]: false,
      [GPIO.RELAY_K9_RESERVA]: false,
      [GPIO.RELAY_K10_RESERVA]: false,
    };

    // Callbacks
    this.onStateChange = null;   // (state) => void
    this.onLog = null;           // (entry) => void
    this.onGpioChange = null;    // (gpio, value) => void
    this.onSensorUpdate = null;  // (sensorId, moisture) => void
    this.onSensorHealthChange = null; // ({ sensorId, stale, lastSeen }) => void

    // Saúde dos sensores reais (telemetria do ESP32)
    this.sensorLastSeen = {};    // sensorId -> timestamp (ms)
    this.sensorStale = {};       // sensorId -> bool
    this.unknownSensorsWarned = new Set(); // sensorIds não associados a nenhuma zona já alarmados

    // Watchdog / relé temporizador atualmente armado (K3 ou K4), para
    // identificar no alarme qual temporizador disparou.
    this.watchdogRelayPin = null;

    // Zonas ainda a regar no ciclo paralelo atual (todas as válvulas abrem
    // em simultâneo depois do delay da bomba)
    this.pendingZones = 0;
  }

  // ── Inicialização ──
  init(zonesConfig) {
    this.zones = zonesConfig.map(z => ({
      ...z,
      on: false,
      moisture: z.moisture || 50,
    }));
    this._ensureSchedules();
    this._broadcast();
  }

  // Ensure all zones have schedules
  _ensureSchedules() {
    this.zones.forEach(z => {
      if (!z.schedules) {
        z.schedules = {};
        ['sun','mon','tue','wed','thu','fri','sat'].forEach(d => {
          z.schedules[d] = { enabled: true, hour: 6, minute: 0 };
        });
      }
    });
  }

  // Restore engine from persisted state
  restoreState(saved) {
    if (!saved || !saved.controlState) return;
    const cs = saved.controlState;
    this.state = cs.state || STATES.IDLE;
    this.pumpOn = cs.pump || false;
    this.autoMode = cs.autoMode !== false;
    this.zones = (cs.zones || []).map(z => ({
      ...z,
      on: z.on || false,
      moisture: z.moisture || 50,
    }));
    this.currentZoneIndex = cs.currentZoneIndex ?? -1;
    this.cycleActive = cs.cycleActive || false;
    this.testCycleActive = cs.testCycleActive || false;
    this.startTime = cs.startTime || null;
    if (cs.gpio) {
      Object.entries(cs.gpio).forEach(([k, v]) => {
        this.gpio[parseInt(k)] = v;
      });
    }
    // If was in a transient state, reset to idle
    if (this.state === STATES.STARTING || this.state === STATES.STOPPING) {
      this.state = STATES.IDLE;
      this.pumpOn = false;
      this.zones.forEach(z => { z.on = false; });
      this.cycleActive = false;
      this.testCycleActive = false;
    }
    this._broadcast();
  }

  updateZones(zonesConfig) {
    // Preserve runtime state (on/moisture) when config changes
    const oldMap = new Map(this.zones.map(z => [z.id, z]));
    this.zones = zonesConfig.map(z => {
      const old = oldMap.get(z.id);
      const merged = {
        ...z,
        on: old ? old.on : false,
        moisture: old ? old.moisture : (z.moisture || 50),
      };
      // Preserve schedules from config if present, otherwise keep old
      if (!merged.schedules && old && old.schedules) {
        merged.schedules = old.schedules;
      }
      // Ensure schedules object exists
      if (!merged.schedules) {
        merged.schedules = {};
        ['sun','mon','tue','wed','thu','fri','sat'].forEach(d => {
          merged.schedules[d] = { enabled: true, hour: 6, minute: 0 };
        });
      }
      return merged;
    });
    this._broadcast();
  }
  // ── Comandos ──
  start(pumpDelaySec = 5) {
    if (this.state === STATES.EMERGENCY) {
      this._log('start_blocked', 'Sistema', 'Start bloqueado — sistema em emergência', 'warning');
      return false;
    }
    if (this.state !== STATES.IDLE) {
      this._log('start_blocked', 'Sistema', 'Start bloqueado — sistema já em operação', 'warning');
      return false;
    }

    this._ensureSchedules();
    this._clearTimers();
    this.state = STATES.STARTING;
    this.startTime = Date.now();
    this._setPump(true);
    this._setGpio(GPIO.RELAY_K7_AUTO, true);
    // K3 — relé temporizador do delay de arranque da bomba
    this._setGpio(GPIO.RELAY_K3_TIMER1, true);
    this._log('system_start', 'Sistema', `Sistema iniciado — bomba ligada, a aguardar ${pumpDelaySec}s (K3) antes de abrir as válvulas`, 'info', { pumpDelay: pumpDelaySec });

    // Fase 1: delay da bomba (temporizado pelo relé K3)
    this._startWatchdog(pumpDelaySec + 15, GPIO.RELAY_K3_TIMER1);
    this._addTimer(setTimeout(() => {
      this._setGpio(GPIO.RELAY_K3_TIMER1, false);
      this.state = STATES.WATERING;
      this.cycleActive = true;
      this._log('watering_start', 'Sistema', 'Delay da bomba concluído — todas as válvulas abrem em simultâneo', 'info');
      this._waterAllZones();
    }, pumpDelaySec * 1000));

    this._broadcast();
    return true;
  }

  stop() {
    this._clearTimers();
    this._clearWatchdog();
    this.state = STATES.STOPPING;
    
    // Fechar válvulas da zona atual primeiro
    this._closeAllValves();
    this._setPump(false);
    this._setGpio(GPIO.RELAY_K7_AUTO, false);
    this._setGpio(GPIO.RELAY_K3_TIMER1, false);
    this._setGpio(GPIO.RELAY_K4_TIMER2, false);
    this.cycleActive = false;
    this.testCycleActive = false;
    this.currentZoneIndex = -1;
    this.pendingZones = 0;

    this._log('system_stop', 'Sistema', 'Sistema parado — todos os atuadores desligados', 'warning');
    
    this._startWatchdog(5);
    this._addTimer(setTimeout(() => {
      this.state = STATES.IDLE;
      this._broadcast();
    }, 500));

    this._broadcast();
    return true;
  }

  emergencyStop() {
    this._clearTimers();
    this._clearWatchdog();
    this.state = STATES.EMERGENCY;
    this._closeAllValves();
    this._setPump(false);
    
    // Desligar todos os relés
    Object.values(GPIO).forEach(g => {
      if (g >= GPIO.RELAY_K3_TIMER1) this._setGpio(g, false);
    });
    
    this.cycleActive = false;
    this.testCycleActive = false;
    this.currentZoneIndex = -1;
    this.pendingZones = 0;
    
    this._log('emergency_stop', 'Paragem de emergência', 'Todos os atuadores desligados por emergência', 'critical');
    this._broadcast();
    return true;
  }

  reset() {
    this._clearTimers();
    this._clearWatchdog();
    this.state = STATES.IDLE;
    this._closeAllValves();
    this._setPump(false);
    this._setGpio(GPIO.RELAY_K3_TIMER1, false);
    this._setGpio(GPIO.RELAY_K4_TIMER2, false);
    this.cycleActive = false;
    this.testCycleActive = false;
    this.currentZoneIndex = -1;
    this.pendingZones = 0;
    
    // Reset moisture to realistic values
    this.zones.forEach(z => {
      z.moisture = Math.max(20, Math.min(90, Math.round(z.moisture)));
    });
    
    this._log('system_reset', 'Sistema', 'Sistema reiniciado', 'warning');
    this._broadcast();
    return true;
  }

  testCycle() {
    if (this.state !== STATES.IDLE) {
      this._log('test_blocked', 'Sistema', 'Teste bloqueado — sistema em operação', 'warning');
      return false;
    }

    this._clearTimers();
    this.state = STATES.STARTING;
    this.testCycleActive = true;
    this._setPump(true);
    this._log('test_cycle', 'Ciclo de teste', 'Ciclo de teste iniciado — verificação de bomba e válvulas', 'info');

    // Teste: bomba 3s → cada válvula 4s
    this._startWatchdog(30);

    this._addTimer(setTimeout(() => {
      this.state = STATES.WATERING;
      this._runTestSequence(0);
    }, 3000));

    this._broadcast();
    return true;
  }

  toggleZone(zoneId) {
    const zone = this.zones.find(z => z.id === zoneId);
    if (!zone) return false;
    
    zone.on = !zone.on;
    
    // Mapear para o relé correspondente (se houver)
    if (zone.on) {
      this._setGpio(GPIO.RELAY_K5_START, true);
    } else {
      // Verificar se alguma outra zona ainda está ligada
      const anyOn = this.zones.some(z => z.on);
      if (!anyOn) this._setGpio(GPIO.RELAY_K5_START, false);
    }
    
    this._log('zone_toggle', `${zone.name} · Válvula ${zone.id}`, 
      zone.on ? `Válvula ${zone.id} aberta (manual)` : `Válvula ${zone.id} fechada (manual)`, 
      'info', { zone_id: zone.id, state: zone.on });
    
    this._broadcast();
    return true;
  }

  togglePump() {
    if (this.state === STATES.EMERGENCY) return false;
    this._setPump(!this.pumpOn);
    this._log('pump_toggle', 'Bomba K1', this.pumpOn ? 'Bomba ligada (manual)' : 'Bomba desligada (manual)', 'info');
    this._broadcast();
    return true;
  }

  setAutoMode(mode) {
    this.autoMode = mode;
    this._setGpio(GPIO.RELAY_K7_AUTO, mode);
    this._log('mode_change', 'Modo de operação', mode ? 'Modo automático ativado' : 'Modo manual ativado', 'info');
    this._broadcast();
  }
  // Nota: não existe simulação de sensores. Os valores de humidade chegam
  // exclusivamente por telemetria real do ESP32-S3 (updateDeviceSensor).

  // ── Update sensor from real device (ESP32 telemetry) ──
  updateDeviceSensor(sensorId, moisture) {
    // Marcar sensor como visto agora — independente de existir zona associada
    this.sensorLastSeen[sensorId] = Date.now();
    if (this.sensorStale[sensorId]) {
      this.sensorStale[sensorId] = false;
      this._log('sensor_recovered', `Sensor ${sensorId}`, `Sensor ${sensorId} voltou a reportar dados`, 'info', { sensorId });
      if (this.onSensorHealthChange) this.onSensorHealthChange({ sensorId, stale: false, lastSeen: this.sensorLastSeen[sensorId] });
    }

    const zone = this.zones.find(z => z.sensorId === sensorId);
    if (!zone) {
      // Sensor a reportar telemetria mas não associado a nenhuma zona
      // configurada — alarme (uma vez por sensorId, até ser reconhecido).
      if (!this.unknownSensorsWarned.has(sensorId)) {
        this.unknownSensorsWarned.add(sensorId);
        this._log('sensor_unrecognized', `Sensor ${sensorId}`,
          `Sensor ${sensorId} não reconhecido — a reportar dados mas não está associado a nenhuma zona configurada`,
          'warning', { sensorId });
        if (this.onSensorHealthChange) {
          this.onSensorHealthChange({ sensorId, stale: false, unrecognized: true, lastSeen: this.sensorLastSeen[sensorId] });
        }
      }
      return;
    }
    this.unknownSensorsWarned.delete(sensorId);
    zone.moisture = moisture;
    // Update virtual GPIO
    const sensorGpio = sensorId === 'B1' ? GPIO.SENSOR_B1 :
                       sensorId === 'B2' ? GPIO.SENSOR_B2 : null;
    if (sensorGpio !== null) {
      this.gpio[sensorGpio] = moisture;
    }
    if (this.onSensorUpdate) {
      this.onSensorUpdate(sensorId, moisture);
    }
  }

  // Verifica sensores sem resposta há mais tempo do que o esperado
  // (chamado periodicamente pelo server enquanto o dispositivo está online)
  checkSensorHealth(staleAfterMs = 15000) {
    const now = Date.now();
    const knownSensorIds = Array.from(new Set(this.zones.map(z => z.sensorId).filter(Boolean)));
    knownSensorIds.forEach(sensorId => {
      const lastSeen = this.sensorLastSeen[sensorId];
      const isStale = !lastSeen || (now - lastSeen) > staleAfterMs;
      if (isStale && !this.sensorStale[sensorId]) {
        this.sensorStale[sensorId] = true;
        this._log('sensor_stale', `Sensor ${sensorId}`, `Sensor ${sensorId} sem resposta há mais de ${Math.round(staleAfterMs / 1000)}s`, 'warning', { sensorId, lastSeen: lastSeen || null });
        if (this.onSensorHealthChange) this.onSensorHealthChange({ sensorId, stale: true, lastSeen: lastSeen || null });
      }
    });
  }

  getSensorHealth() {
    const knownSensorIds = Array.from(new Set(this.zones.map(z => z.sensorId).filter(Boolean)));
    return knownSensorIds.map(sensorId => ({
      sensorId,
      lastSeen: this.sensorLastSeen[sensorId] || null,
      stale: !!this.sensorStale[sensorId],
    }));
  }

  // ── Verificação do ciclo automático (com schedules) ──
  checkAutoCycle() {
    // Só corre em modo automático
    if (!this.autoMode) return;

    // Se não está a regar, verificar se é hora de arrancar segundo os horários.
    // Nota: esta verificação NÃO depende de cycleActive — cycleActive só passa
    // a true depois de start() arrancar, por isso exigi-lo aqui impedia que
    // qualquer horário alguma vez disparasse a rega (bug: ciclo automático
    // nunca arrancava sozinho a partir de IDLE).
    if (this.state === STATES.IDLE && this.zones.length > 0) {
      if (this._shouldWaterNow()) {
        this.start(5);
      }
      return;
    }

    // A partir daqui, um ciclo já em curso (todas as válvulas a regar em
    // simultâneo) termina e decide continuar/parar sozinho em
    // _onAllZonesDone() assim que a última válvula fecha — não há nada a
    // verificar aqui a cada tick.
  }

  // Check if any schedule says "water now"
  _shouldWaterNow() {
    const now = new Date();
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const today = dayNames[now.getDay()];
    const currentMin = now.getHours() * 60 + now.getMinutes();

    // Check each zone's schedule for today
    for (const zone of this.zones) {
      if (!zone.schedules) continue;
      const sched = zone.schedules[today];
      if (!sched || !sched.enabled) continue;
      
      const schedMin = sched.hour * 60 + sched.minute;
      // Fire within a 3-minute window (sensor loop runs every 3s)
      if (Math.abs(currentMin - schedMin) <= 3 && zone.moisture < zone.target) {
        this._log('schedule_trigger', `${zone.name}`, 
          `Horário programado (${String(sched.hour).padStart(2,'0')}:${String(sched.minute).padStart(2,'0')}) — humidade ${zone.moisture}% < ${zone.target}%`,
          'info', { zone_id: zone.id, schedule: `${sched.hour}:${sched.minute}`, moisture: zone.moisture, target: zone.target });
        return true;
      }
    }
    return false;
  }

  // ── Estado atual (para API) ──
  getState() {
    return {
      state: this.state,
      pump: this.pumpOn,
      autoMode: this.autoMode,
      zones: this.zones.map(z => ({
        id: z.id,
        sensorId: z.sensorId,
        name: z.name,
        moisture: z.moisture,
        target: z.target,
        lastWatered: z.lastWatered || '—',
        on: z.on,
        waterDuration: z.waterDuration || 30,
        // x/y (posição no mapa) e schedules (programação semanal) têm de
        // viajar em todos os broadcasts, senão o frontend sobrepõe-os com
        // undefined a cada atualização de estado (bug: mapa "desorganizado").
        x: typeof z.x === 'number' ? z.x : 50,
        y: typeof z.y === 'number' ? z.y : 50,
        schedules: z.schedules || null,
      })),
      gpio: { ...this.gpio },
      currentZoneIndex: this.currentZoneIndex,
      cycleActive: this.cycleActive,
      testCycleActive: this.testCycleActive,
      startTime: this.startTime,
    };
  }

  // ── Internals ──
  // Abre TODAS as válvulas em simultâneo (depois do delay da bomba) — cada
  // uma fecha sozinha quando o seu próprio temporizador de duração termina.
  _waterAllZones() {
    if (this.zones.length === 0) {
      this._log('watering_skip', 'Sistema', 'Sem zonas configuradas — ciclo terminado', 'warning');
      this.cycleActive = false;
      this.state = STATES.IDLE;
      this._setPump(false);
      this._setGpio(GPIO.RELAY_K7_AUTO, false);
      this._broadcast();
      return;
    }

    this.currentZoneIndex = 0;
    this.pendingZones = this.zones.length;

    // K4 — relé temporizador da duração de rega (armado enquanto houver
    // pelo menos uma válvula aberta)
    this._setGpio(GPIO.RELAY_K4_TIMER2, true);
    this._setGpio(GPIO.RELAY_K5_START, true);

    const maxDuration = Math.max(...this.zones.map(z => z.waterDuration || 30));
    this._startWatchdog(maxDuration + 10, GPIO.RELAY_K4_TIMER2);

    this._log('watering_all_start', 'Sistema',
      `${this.zones.length} válvula(s) aberta(s) em simultâneo`, 'info',
      { zones: this.zones.map(z => z.id) });

    this.zones.forEach((zone) => {
      zone.on = true;
      const duration = zone.waterDuration || 30;

      this._log('zone_watering', `${zone.name} · Válvula ${zone.id}`,
        `A regar ${zone.name} durante ${duration}s`, 'info', { zone_id: zone.id, duration });

      this._addTimer(setTimeout(() => {
        zone.on = false;
        zone.lastWatered = new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });

        this._log('zone_done', `${zone.name} · Válvula ${zone.id}`,
          `Rega de ${zone.name} concluída`, 'info', { zone_id: zone.id });

        this.pendingZones = Math.max(0, this.pendingZones - 1);
        this.currentZoneIndex = this.zones.length - this.pendingZones;
        this._broadcast();

        if (this.pendingZones === 0) {
          this._onAllZonesDone();
        }
      }, duration * 1000));
    });

    this._broadcast();
  }

  // Chamado quando a última válvula do ciclo paralelo fecha — decide se o
  // ciclo continua (alguma zona ainda abaixo do setpoint) ou termina.
  _onAllZonesDone() {
    this._setGpio(GPIO.RELAY_K4_TIMER2, false);
    this._setGpio(GPIO.RELAY_K5_START, false);

    if (this.testCycleActive) return; // ciclo de teste tem o seu próprio fluxo

    const needsWater = this.cycleActive && this.zones.some(z => z.moisture < z.target);
    if (needsWater) {
      this._log('cycle_continue', 'Sistema', 'Ciclo de rega — algumas zonas ainda abaixo do setpoint', 'info');
      this._addTimer(setTimeout(() => {
        if (this.cycleActive) this._waterAllZones();
      }, 2000));
    } else {
      this.cycleActive = false;
      this.state = STATES.IDLE;
      this._closeAllValves();
      this._setPump(false);
      this._setGpio(GPIO.RELAY_K7_AUTO, false);
      this.currentZoneIndex = -1;
      this._log('cycle_complete', 'Sistema', 'Ciclo de rega completo — todas as zonas no setpoint', 'info');
      this._broadcast();
    }
  }

  _runTestSequence(index) {
    if (index >= this.zones.length) {
      // Teste concluído
      this.testCycleActive = false;
      this._closeAllValves();
      this._setPump(false);
      this.state = STATES.IDLE;
      this._log('test_complete', 'Ciclo de teste', 'Ciclo de teste concluído com sucesso', 'info');
      this._broadcast();
      return;
    }

    const zone = this.zones[index];
    zone.on = true;
    this._setGpio(GPIO.RELAY_K5_START, true);
    
    this._log('test_zone', `Teste · ${zone.name}`, `A testar ${zone.name} (4s)`, 'info', { zone_id: zone.id });
    this._broadcast();

    this._startWatchdog(10);

    this._addTimer(setTimeout(() => {
      zone.on = false;
      this._setGpio(GPIO.RELAY_K5_START, false);
      this.currentZoneIndex = index + 1;
      
      this._addTimer(setTimeout(() => {
        this._runTestSequence(this.currentZoneIndex);
      }, 1000));
    }, 4000));
  }

  _setPump(on) {
    this.pumpOn = on;
    this._setGpio(GPIO.RELAY_K5_START, on);
  }

  _closeAllValves() {
    this.zones.forEach(z => { z.on = false; });
    this._setGpio(GPIO.RELAY_K5_START, false);
  }

  _setGpio(pin, value) {
    this.gpio[pin] = value;
    if (this.onGpioChange) {
      this.onGpioChange(pin, value);
    }
  }

  _log(type, source, message, severity = 'info', metadata = null) {
    const entry = {
      id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      event_type: type,
      source,
      message,
      severity,
      metadata,
      created_at: new Date().toISOString(),
    };
    if (this.onLog) this.onLog(entry);
  }

  _addTimer(timer) {
    this.timers.push(timer);
  }

  _clearTimers() {
    this.timers.forEach(t => clearTimeout(t));
    this.timers = [];
    this._clearWatchdog();
  }

  // relayPin (opcional): GPIO.RELAY_K3_TIMER1 ou GPIO.RELAY_K4_TIMER2 —
  // identifica qual relé temporizador está armado nesta fase, para que o
  // alarme de disparo diga exatamente qual temporizador falhou.
  _startWatchdog(extraSeconds = 10, relayPin = null) {
    this._clearWatchdog();
    this.watchdogRelayPin = relayPin;
    const timeout = (this.watchdogTimeout + extraSeconds * 1000);
    this.watchdogTimer = setTimeout(() => {
      const relayLabel = relayPin === GPIO.RELAY_K3_TIMER1 ? 'K3 (delay da bomba)'
        : relayPin === GPIO.RELAY_K4_TIMER2 ? 'K4 (duração da rega)'
        : null;
      this._log('timer_relay_trip', 'Relé temporizador',
        relayLabel
          ? `Relé temporizador ${relayLabel} disparou — tempo máximo excedido, paragem de segurança forçada`
          : 'Temporizador de segurança excedido — a forçar paragem',
        'critical', { relay: relayLabel, relayPin });
      this._closeAllValves();
      this._setPump(false);
      this._setGpio(GPIO.RELAY_K3_TIMER1, false);
      this._setGpio(GPIO.RELAY_K4_TIMER2, false);
      this._setGpio(GPIO.RELAY_K7_AUTO, false);
      this.state = STATES.IDLE;
      this.cycleActive = false;
      this.testCycleActive = false;
      this.currentZoneIndex = -1;
      this.pendingZones = 0;
      this._clearTimers();
      this._broadcast();
    }, timeout);
  }

  _clearWatchdog() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.watchdogRelayPin = null;
  }

  _broadcast() {
    if (this.onStateChange) {
      this.onStateChange(this.getState());
    }
  }
}

module.exports = { ControlEngine, GPIO, STATES };
