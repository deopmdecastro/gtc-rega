/**
 * GTC Rega — Control Engine
 *
 * Máquina de estados do controlador de rega.
 * Simula GPIOs lógicos (níveis no ESP32-S3 e no MCP23017), temporizadores,
 * sensores DHT22 e ciclo automático. As saídas devolvidas ao firmware são
 * indexadas pelos mesmos números lógicos dos pinos do MCP23017 (0..15).
 *
 * Estados do sistema:
 *   IDLE       → parado, aguardando comando
 *   STARTING   → motor ligado, aguardando delay antes de abrir válvulas
 *   WATERING   → zona(s) ativa(s) a regar (temporizador)
 *   STOPPING   → a fechar válvulas e desligar motor
 *   EMERGENCY  → paragem de emergência (tudo desligado, requer reset)
 */

// ── Mapa de pinos lógicos (coerente com firmware/src/config.h) ──
// Índice  | Pino MCP   | Função no quadro GTC Rega              | Tipo
//   0     | PA0        | 9-E6  MOTOR ON                         | saída
//   1     | PA1        | 9-D6  AUTO GTC                         | saída
//   2     | PA2        | 8-E6  STO/EMERG GTC                    | saída
//   3     | PA3        | 8-E6  ON GTC                           | saída
//   4     | PA4        | 8-E6  Temp. Tempo de Rega              | saída
//   5     | PA5        | 8-D6  Temp. Delay Bom/Val              | saída
//   6     | PA6        | 8-D6  Out Sensor 2                     | saída
//   7     | PA7        |      Out Sensor 1                      | saída
//   8     | PB0        | 9-E6  RELE TEMP-ON                     | saída
//  14     | PB6        |      Sinal da bomba ON (24 V, opto)    | entrada
//  15     | PB7        |      Sinal da Relé Temp ON (24 V)      | entrada
//
// GPIOs diretas do ESP32-S3:
//  21     | DHT22 #1 (SDA) — sensor T/H
//  14     | DHT22 #2 (SDA) — sensor T/H
//  16     | I2C SCL → MCP23017
//  18     | I2C SDA → MCP23017
//
// (IO02 e IO03 ficam livres — não interferem com o boot do ESP32-S3)

const GPIO = {
  // Saídas (MCP23017 porto A e PB0)
  MCP_OUT_MOTOR:        0,
  MCP_OUT_AUTO:         1,
  MCP_OUT_STO_EMERG:    2,
  MCP_OUT_ON_GTC:       3,
  MCP_OUT_TIME_REG:     4,
  MCP_OUT_TIME_DELAY:   5,
  MCP_OUT_SENSOR_2:     6,
  MCP_OUT_SENSOR_1:     7,
  MCP_OUT_RELE_TEMP:    8,
  // Entradas via optocopladores (PB6, PB7)
  MCP_IN_BOMBA_ON:     14,
  MCP_IN_RELE_TEMP:    15,
  // GPIOs diretas do ESP32-S3
  ESP_DHT1:            21,
  ESP_DHT2:            14,
  ESP_I2C_SCL:         16,
  ESP_I2C_SDA:         18,
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
    this.motorOn = false;
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
    this.pumpDelay = 5;

    // Última leitura DHT22 recebida do ESP32
    this.dht1 = { temperature: 0, humidity: 0, ok: false, lastSeen: 0 };
    this.dht2 = { temperature: 0, humidity: 0, ok: false, lastSeen: 0 };

    // GPIO virtual states (índices 0..15 conforme config.h do firmware)
    this.gpio = {
      [GPIO.MCP_OUT_MOTOR]:      false,
      [GPIO.MCP_OUT_AUTO]:       false,
      [GPIO.MCP_OUT_STO_EMERG]:  false,
      [GPIO.MCP_OUT_ON_GTC]:     false,
      [GPIO.MCP_OUT_TIME_REG]:   false,
      [GPIO.MCP_OUT_TIME_DELAY]: false,
      [GPIO.MCP_OUT_SENSOR_2]:  false,
      [GPIO.MCP_OUT_SENSOR_1]:  false,
      [GPIO.MCP_OUT_RELE_TEMP]:  false,
      [GPIO.MCP_IN_BOMBA_ON]:    false,
      [GPIO.MCP_IN_RELE_TEMP]:   false,
    };

    // Callbacks
    this.onStateChange = null;   // (state) => void
    this.onLog = null;           // (entry) => void
    this.onGpioChange = null;    // (gpio, value) => void
    this.onSensorUpdate = null;  // (sensorId, payload) => void

    this.watchdogRelayPin = null;

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

  restoreState(saved) {
    if (!saved || !saved.controlState) return;
    const cs = saved.controlState;
    this.state = cs.state || STATES.IDLE;
    this.motorOn = cs.pump || cs.motor || false;
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
    this.pumpDelay = cs.pumpDelay || 5;
    if (cs.gpio) {
      Object.entries(cs.gpio).forEach(([k, v]) => {
        this.gpio[parseInt(k)] = v;
      });
    }
    if (this.state === STATES.STARTING || this.state === STATES.STOPPING) {
      this.state = STATES.IDLE;
      this.motorOn = false;
      this.zones.forEach(z => { z.on = false; });
      this.cycleActive = false;
      this.testCycleActive = false;
    }
    this._broadcast();
  }

  updateZones(zonesConfig) {
    const oldMap = new Map(this.zones.map(z => [z.id, z]));
    this.zones = zonesConfig.map(z => {
      const old = oldMap.get(z.id);
      const merged = {
        ...z,
        on: old ? old.on : false,
        moisture: old ? old.moisture : (z.moisture || 50),
      };
      if (!merged.schedules && old && old.schedules) merged.schedules = old.schedules;
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
  start(pumpDelaySec = this.pumpDelay) {
    if (this.state === STATES.EMERGENCY) {
      this._log('start_blocked', 'Sistema', 'Start bloqueado — sistema em emergência', 'warning');
      return false;
    }
    if (this.state !== STATES.IDLE) {
      this._log('start_blocked', 'Sistema', 'Start bloqueado — sistema já em operação', 'warning');
      return false;
    }

    this.pumpDelay = pumpDelaySec;
    this._ensureSchedules();
    this._clearTimers();
    this.state = STATES.STARTING;
    this.startTime = Date.now();
    this._setMotor(true);
    this._setGpio(GPIO.MCP_OUT_AUTO, true);
    // K3 — relé temporizador do delay de arranque do motor
    this._setGpio(GPIO.MCP_OUT_TIME_REG, true);
    this._log('system_start', 'Sistema',
      `Sistema iniciado — motor ligado, a aguardar ${pumpDelaySec}s (PA4) antes de abrir as válvulas`,
      'info', { pumpDelay: pumpDelaySec });

    // Fase 1: delay do motor (temporizado pelo output PA4)
    this._startWatchdog(pumpDelaySec + 15, GPIO.MCP_OUT_TIME_REG);
    this._addTimer(setTimeout(() => {
      this._setGpio(GPIO.MCP_OUT_TIME_REG, false);
      this.state = STATES.WATERING;
      this.cycleActive = true;
      this._log('watering_start', 'Sistema', 'Delay do motor concluído — todas as válvulas abertas em simultâneo', 'info');
      this._waterAllZones();
    }, pumpDelaySec * 1000));

    this._broadcast();
    return true;
  }

  stop() {
    this._clearTimers();
    this._clearWatchdog();
    this.state = STATES.STOPPING;
    this._closeAllValves();
    this._setMotor(false);
    this._setGpio(GPIO.MCP_OUT_AUTO, false);
    this._setGpio(GPIO.MCP_OUT_TIME_REG, false);
    this._setGpio(GPIO.MCP_OUT_TIME_DELAY, false);
    this._setGpio(GPIO.MCP_OUT_STO_EMERG, false);
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
    this._setMotor(false);

    // Desligar todas as saídas lógicas
    Object.values(GPIO).forEach(g => {
      if (this.gpio[g] === true) this._setGpio(g, false);
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
    this._setMotor(false);
    this._setGpio(GPIO.MCP_OUT_TIME_REG, false);
    this._setGpio(GPIO.MCP_OUT_TIME_DELAY, false);
    this.cycleActive = false;
    this.testCycleActive = false;
    this.currentZoneIndex = -1;
    this.pendingZones = 0;

    this.zones.forEach(z => { z.moisture = Math.max(20, Math.min(90, Math.round(z.moisture))); });

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
    this._setMotor(true);
    this._log('test_cycle', 'Ciclo de teste', 'Ciclo de teste iniciado — verificação de motor e válvulas', 'info');
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
    if (zone.on) {
      this._setGpio(GPIO.MCP_OUT_SENSOR_1, true); // demo: ON sinaliza "sensor 1 ativo"
    } else {
      const anyOn = this.zones.some(z => z.on);
      if (!anyOn) this._setGpio(GPIO.MCP_OUT_SENSOR_1, false);
    }
    this._log('zone_toggle',
      `${zone.name} · Válvula ${zone.id}`,
      zone.on ? `Válvula ${zone.id} aberta (manual)` : `Válvula ${zone.id} fechada (manual)`,
      'info', { zone_id: zone.id, state: zone.on });
    this._broadcast();
    return true;
  }

  togglePump() {
    if (this.state === STATES.EMERGENCY) return false;
    this._setMotor(!this.motorOn);
    this._log('pump_toggle', 'Motor (PA0)', this.motorOn ? 'Motor ligado (manual)' : 'Motor desligado (manual)', 'info');
    this._broadcast();
    return true;
  }

  setAutoMode(mode) {
    this.autoMode = mode;
    this._setGpio(GPIO.MCP_OUT_AUTO, mode);
    this._log('mode_change', 'Modo de operação (PA1)', mode ? 'Modo automático ativado' : 'Modo manual ativado', 'info');
    this._broadcast();
  }

  // ── Telemetria: DHT22 (ESP32-S3 IO21 e IO14) ──
  updateDeviceDht(sensorId, payload) {
    const now = Date.now();
    if (sensorId === 'DHT1') {
      this.dht1 = { ...this.dht1, ...payload, lastSeen: now };
    } else if (sensorId === 'DHT2') {
      this.dht2 = { ...this.dht2, ...payload, lastSeen: now };
    }
    this._broadcast();
    if (this.onSensorUpdate) this.onSensorUpdate(sensorId, payload);
  }

  // ── Telemetria: sinais opto (PB6/PB7 — feedback 24 V) ──
  updateDeviceFeedback({ bombaRunning, releTempOn }) {
    if (typeof bombaRunning === 'boolean') this._setGpioIfChanged(GPIO.MCP_IN_BOMBA_ON, bombaRunning, false);
    if (typeof releTempOn === 'boolean')   this._setGpioIfChanged(GPIO.MCP_IN_RELE_TEMP, releTempOn, false);
  }

  // Helper
  _setGpioIfChanged(pin, value, emitChange) {
    if (this.gpio[pin] !== value) {
      this.gpio[pin] = value;
      if (emitChange && this.onGpioChange) this.onGpioChange(pin, value);
    }
  }

  // ── Estado atual (para API) ──
  getState() {
    return {
      state: this.state,
      motor: this.motorOn,
      pump: this.motorOn,
      autoMode: this.autoMode,
      pumpDelay: this.pumpDelay,
      dht1: this.dht1,
      dht2: this.dht2,
      zones: this.zones.map(z => ({
        id: z.id,
        sensorId: z.sensorId,
        name: z.name,
        moisture: z.moisture,
        target: z.target,
        lastWatered: z.lastWatered || '—',
        on: z.on,
        waterDuration: z.waterDuration || 30,
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

  // ── Verificação do ciclo automático (com schedules) ──
  checkAutoCycle() {
    if (!this.autoMode) return;
    if (this.state === STATES.IDLE && this.zones.length > 0) {
      if (this._shouldWaterNow()) this.start(this.pumpDelay);
      return;
    }
  }

  _shouldWaterNow() {
    const now = new Date();
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const today = dayNames[now.getDay()];
    const currentMin = now.getHours() * 60 + now.getMinutes();
    for (const zone of this.zones) {
      if (!zone.schedules) continue;
      const sched = zone.schedules[today];
      if (!sched || !sched.enabled) continue;
      const schedMin = sched.hour * 60 + sched.minute;
      if (Math.abs(currentMin - schedMin) <= 3 && zone.moisture < zone.target) {
        this._log('schedule_trigger', zone.name,
          `Horário programado (${String(sched.hour).padStart(2,'0')}:${String(sched.minute).padStart(2,'0')}) — humidade ${zone.moisture}% < ${zone.target}%`,
          'info', { zone_id: zone.id, schedule: `${sched.hour}:${sched.minute}`, moisture: zone.moisture, target: zone.target });
        return true;
      }
    }
    return false;
  }

  // ── Internals ──
  _waterAllZones() {
    if (this.zones.length === 0) {
      this._log('watering_skip', 'Sistema', 'Sem zonas configuradas — ciclo terminado', 'warning');
      this.cycleActive = false;
      this.state = STATES.IDLE;
      this._setMotor(false);
      this._setGpio(GPIO.MCP_OUT_AUTO, false);
      this._broadcast();
      return;
    }

    this.currentZoneIndex = 0;
    this.pendingZones = this.zones.length;

    // PA5 — relé temporizador da duração de rega (armado enquanto houver
    // pelo menos uma válvula aberta)
    this._setGpio(GPIO.MCP_OUT_TIME_DELAY, true);
    this._setGpio(GPIO.MCP_OUT_SENSOR_1, true);

    const maxDuration = Math.max(...this.zones.map(z => z.waterDuration || 30));
    this._startWatchdog(maxDuration + 10, GPIO.MCP_OUT_TIME_DELAY);

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
        if (this.pendingZones === 0) this._onAllZonesDone();
      }, duration * 1000));
    });
    this._broadcast();
  }

  _onAllZonesDone() {
    this._setGpio(GPIO.MCP_OUT_TIME_DELAY, false);
    this._setGpio(GPIO.MCP_OUT_SENSOR_1, false);

    if (this.testCycleActive) return;

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
      this._setMotor(false);
      this._setGpio(GPIO.MCP_OUT_AUTO, false);
      this.currentZoneIndex = -1;
      this._log('cycle_complete', 'Sistema', 'Ciclo de rega completo — todas as zonas no setpoint', 'info');
      this._broadcast();
    }
  }

  _runTestSequence(index) {
    if (index >= this.zones.length) {
      this.testCycleActive = false;
      this._closeAllValves();
      this._setMotor(false);
      this.state = STATES.IDLE;
      this._log('test_complete', 'Ciclo de teste', 'Ciclo de teste concluído com sucesso', 'info');
      this._broadcast();
      return;
    }

    const zone = this.zones[index];
    zone.on = true;
    this._setGpio(GPIO.MCP_OUT_SENSOR_1, true);
    this._log('test_zone', `Teste · ${zone.name}`, `A testar ${zone.name} (4s)`, 'info', { zone_id: zone.id });
    this._broadcast();
    this._startWatchdog(10);

    this._addTimer(setTimeout(() => {
      zone.on = false;
      this._setGpio(GPIO.MCP_OUT_SENSOR_1, false);
      this.currentZoneIndex = index + 1;
      this._addTimer(setTimeout(() => {
        this._runTestSequence(this.currentZoneIndex);
      }, 1000));
    }, 4000));
  }

  _setMotor(on) {
    this.motorOn = on;
    this._setGpio(GPIO.MCP_OUT_MOTOR, on);
  }

  _closeAllValves() {
    this.zones.forEach(z => { z.on = false; });
    this._setGpio(GPIO.MCP_OUT_SENSOR_1, false);
  }

  _setGpio(pin, value) {
    this.gpio[pin] = value;
    if (this.onGpioChange) this.onGpioChange(pin, value);
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

  _addTimer(timer) { this.timers.push(timer); }
  _clearTimers() { this.timers.forEach(t => clearTimeout(t)); this.timers = []; this._clearWatchdog(); }

  _startWatchdog(extraSeconds = 10, relayPin = null) {
    this._clearWatchdog();
    this.watchdogRelayPin = relayPin;
    const timeout = (this.watchdogTimeout + extraSeconds * 1000);
    this.watchdogTimer = setTimeout(() => {
      const relayLabel = relayPin === GPIO.MCP_OUT_TIME_REG   ? 'PA4 (Temp. Tempo de Rega)'
                       : relayPin === GPIO.MCP_OUT_TIME_DELAY ? 'PA5 (Temp. Delay Bom/Val)'
                       : null;
      this._log('timer_relay_trip', 'Relé temporizador',
        relayLabel
          ? `Relé ${relayLabel} disparou — tempo máximo excedido, paragem de segurança forçada`
          : 'Temporizador de segurança excedido — a forçar paragem',
        'critical', { relay: relayLabel, relayPin });
      this._closeAllValves();
      this._setMotor(false);
      this._setGpio(GPIO.MCP_OUT_TIME_REG, false);
      this._setGpio(GPIO.MCP_OUT_TIME_DELAY, false);
      this._setGpio(GPIO.MCP_OUT_AUTO, false);
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
    if (this.watchdogTimer) clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
    this.watchdogRelayPin = null;
  }

  _broadcast() {
    if (this.onStateChange) this.onStateChange(this.getState());
  }
}

module.exports = { ControlEngine, GPIO, STATES };
