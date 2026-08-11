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
    this._log('system_start', 'Sistema', 'Sistema iniciado — bomba ligada', 'info', { pumpDelay: pumpDelaySec });

    // Fase 1: delay da bomba
    this._startWatchdog(pumpDelaySec + 15);
    this._addTimer(setTimeout(() => {
      this.state = STATES.WATERING;
      this.currentZoneIndex = 0;
      this.cycleActive = true;
      this._log('watering_start', 'Sistema', 'Ciclo de rega iniciado', 'info');
      this._waterNextZone();
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
    this.cycleActive = false;
    this.testCycleActive = false;
    this.currentZoneIndex = -1;

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
    this.cycleActive = false;
    this.testCycleActive = false;
    this.currentZoneIndex = -1;
    
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
  // ── Simulação de sensores ──
  updateSensors() {
    this.zones.forEach(z => {
      // Se a zona está a regar, humidade sobe
      if (z.on) {
        z.moisture = Math.min(99, z.moisture + (Math.random() * 2 + 1));
      } else {
        // Humidade desce lentamente
        z.moisture = Math.max(5, z.moisture - (Math.random() * 0.3));
      }
      z.moisture = Math.round(z.moisture);
      
      // Atualizar GPIO virtual do sensor
      const sensorGpio = z.sensorId === 'B1' ? GPIO.SENSOR_B1 : 
                         z.sensorId === 'B2' ? GPIO.SENSOR_B2 : null;
      if (sensorGpio !== null) {
        this.gpio[sensorGpio] = z.moisture;
      }
      
      if (this.onSensorUpdate) {
        this.onSensorUpdate(z.sensorId, z.moisture);
      }
    });
  }

  // ── Update sensor from real device (ESP32 telemetry) ──
  updateDeviceSensor(sensorId, moisture) {
    const zone = this.zones.find(z => z.sensorId === sensorId);
    if (!zone) return;
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

  // ── Verificação do ciclo automático (com schedules) ──
  checkAutoCycle() {
    // Only run in auto mode when a cycle is active
    if (!this.autoMode || !this.cycleActive) return;
    
    // If not watering, check if it's time to start based on schedules
    if (this.state === STATES.IDLE && this.zones.length > 0) {
      if (this._shouldWaterNow()) {
        this.start(5);
      }
      return;
    }

    if (this.state !== STATES.WATERING) return;
    
    // Cycle complete — check if we should continue or stop
    const allDone = this.currentZoneIndex >= this.zones.length;
    if (allDone) {
      // Check if any zone still needs watering based on moisture vs target
      const needsWater = this.zones.some(z => z.moisture < z.target);
      if (needsWater) {
        this.currentZoneIndex = 0;
        this._log('cycle_continue', 'Sistema', 'Ciclo de rega — algumas zonas ainda abaixo do setpoint', 'info');
        this._waterNextZone();
      } else {
        // All zones satisfied — stop the cycle
        this.cycleActive = false;
        this.state = STATES.IDLE;
        this._closeAllValves();
        this._setPump(false);
        this._setGpio(GPIO.RELAY_K7_AUTO, false);
        this._log('cycle_complete', 'Sistema', 'Ciclo de rega completo — todas as zonas no setpoint', 'info');
        this._broadcast();
      }
    }
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
      })),
      gpio: { ...this.gpio },
      currentZoneIndex: this.currentZoneIndex,
      cycleActive: this.cycleActive,
      testCycleActive: this.testCycleActive,
      startTime: this.startTime,
    };
  }

  // ── Internals ──
  _waterNextZone() {
    if (this.currentZoneIndex >= this.zones.length) {
      this.currentZoneIndex = 0;
    }

    const zone = this.zones[this.currentZoneIndex];
    if (!zone) return;

    // Abrir válvula da zona
    zone.on = true;
    this._setGpio(GPIO.RELAY_K5_START, true);
    const duration = zone.waterDuration || 30;
    
    this._log('zone_watering', `${zone.name} · Válvula ${zone.id}`, 
      `A regar ${zone.name} durante ${duration}s`, 'info', { zone_id: zone.id, duration });

    this._broadcast();

    // Temporizador da válvula
    // Start watchdog for this zone
    this._startWatchdog(duration + 10);

    this._addTimer(setTimeout(() => {
      zone.on = false;
      this._setGpio(GPIO.RELAY_K5_START, false);
      zone.lastWatered = new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' });
      
      this._log('zone_done', `${zone.name} · Válvula ${zone.id}`, 
        `Rega de ${zone.name} concluída`, 'info', { zone_id: zone.id });

      this.currentZoneIndex++;
      this._broadcast();

      // Esperar 2s entre zonas
      this._addTimer(setTimeout(() => {
        if (this.testCycleActive) {
          this._runTestSequence(this.currentZoneIndex);
        } else if (this.cycleActive) {
          this._waterNextZone();
        }
      }, 2000));
    }, duration * 1000));
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

  _startWatchdog(extraSeconds = 10) {
    this._clearWatchdog();
    const timeout = (this.watchdogTimeout + extraSeconds * 1000);
    this.watchdogTimer = setTimeout(() => {
      this._log('watchdog_triggered', 'Watchdog', 
        `Timeout de segurança excedido — a forçar paragem`, 'critical');
      this._closeAllValves();
      this._setPump(false);
      this.state = STATES.IDLE;
      this.cycleActive = false;
      this.testCycleActive = false;
      this.currentZoneIndex = -1;
      this._clearTimers();
      this._broadcast();
    }, timeout);
  }

  _clearWatchdog() {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  _broadcast() {
    if (this.onStateChange) {
      this.onStateChange(this.getState());
    }
  }
}

module.exports = { ControlEngine, GPIO, STATES };
