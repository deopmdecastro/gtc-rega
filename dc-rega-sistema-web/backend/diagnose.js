/**
 * GTC Rega — Script de diagnóstico rápido
 * 
 * Uso: node diagnose.js
 * 
 * Mostra o estado atual da conexão com o ESP32-S3,
 * sensores, eventos recentes e modo de operação.
 */

const http = require('http');

const BASE = 'http://localhost:3000';

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('\n🔍 GTC Rega — Diagnóstico de Conexão ESP32-S3\n');
  console.log('═'.repeat(55));

  // 1. Health
  try {
    const health = await get('/api/health');
    console.log('\n📡 BACKEND');
    console.log(`   Estado:         ${health.ok ? '✅ OK' : '❌ Erro'}`);
    console.log(`   Uptime backend: ${Math.round(health.uptime)}s`);
    console.log(`   Engine state:   ${health.engineState}`);
    console.log(`   Zones:          ${health.zones}`);
    console.log(`   Cycle active:   ${health.cycleActive}`);
    console.log(`   Device online:  ${health.deviceOnline ? '🟢 SIM' : '⚫ NÃO (simulação)'}`);
    if (health.deviceInfo) {
      console.log(`   Device ID:      ${health.deviceInfo.deviceId || '—'}`);
      console.log(`   Firmware:       ${health.deviceInfo.firmware || '—'}`);
      console.log(`   IP:             ${health.deviceInfo.ip || '—'}`);
      console.log(`   RSSI:           ${health.deviceInfo.rssi ?? '—'} dBm`);
    }
  } catch (e) {
    console.log('\n❌ Backend não está a correr!');
    console.log('   Inicia com: cd dc-rega-sistema-web/backend && npm start');
    return;
  }

  // 2. Device status
  try {
    const status = await get('/api/device/status');
    console.log('\n🔌 DISPOSITIVO');
    console.log(`   Online:         ${status.deviceOnline ? '🟢 SIM' : '⚫ NÃO'}`);
    console.log(`   Último contacto: ${status.lastContact || 'nunca'}`);
    if (status.deviceInfo) {
      console.log(`   Device ID:      ${status.deviceInfo.deviceId || '—'}`);
      console.log(`   Firmware:       ${status.deviceInfo.firmware || '—'}`);
      console.log(`   IP:             ${status.deviceInfo.ip || '—'}`);
      console.log(`   Uptime ESP32:   ${status.deviceInfo.uptime || 0}s (${Math.round((status.deviceInfo.uptime||0)/60)}min)`);
    }
    console.log('\n📊 SENSORES');
    if (status.sensors && status.sensors.length > 0) {
      status.sensors.forEach(s => {
        const icon = s.stale ? '⚠️' : '✅';
        const ago = s.lastSeen ? `${Math.round((Date.now() - s.lastSeen)/1000)}s atrás` : 'nunca';
        console.log(`   ${icon} ${s.sensorId}: ${s.stale ? 'SEM SINAL ⚠️' : 'OK'} (visto há ${ago})`);
      });
    } else {
      console.log('   Nenhum sensor configurado');
    }
  } catch (e) {
    console.log('   Erro ao consultar:', e.message);
  }

  // 3. Eventos recentes
  try {
    const events = await get('/api/events?limit=5');
    console.log('\n📋 ÚLTIMOS 5 EVENTOS');
    if (Array.isArray(events) && events.length > 0) {
      events.forEach(ev => {
        const time = new Date(ev.created_at).toLocaleTimeString('pt-PT');
        const sev = ev.severity === 'critical' ? '🔴' : ev.severity === 'warning' ? '🟡' : '🔵';
        console.log(`   ${sev} [${time}] ${ev.event_type}: ${ev.message}`);
      });
    } else {
      console.log('   Nenhum evento registado');
    }
  } catch (e) {
    console.log('   Erro:', e.message);
  }

  // 4. Control state
  try {
    const state = await get('/api/control/state');
    console.log('\n🎛️ CONTROLADOR');
    console.log(`   Estado:         ${state.state}`);
    console.log(`   Bomba:          ${state.pump ? '🟢 LIGADA' : '⚫ DESLIGADA'}`);
    console.log(`   Modo:           ${state.autoMode ? '🔄 AUTOMÁTICO' : '🖐️ MANUAL'}`);
    console.log(`   Ciclo ativo:    ${state.cycleActive ? 'Sim' : 'Não'}`);
    if (state.zones) {
      state.zones.forEach(z => {
        console.log(`   ${z.name} (${z.sensorId}): ${z.moisture}% | Válvula: ${z.on ? 'ABERTA' : 'FECHADA'} | Setpoint: ${z.target}%`);
      });
    }
  } catch (e) {
    console.log('   Erro:', e.message);
  }

  // 5. Resumo
  console.log('\n' + '═'.repeat(55));
  const status = await get('/api/device/status').catch(() => ({ deviceOnline: false }));
  if (status.deviceOnline) {
    console.log('✅ RESULTADO: Interface está a consumir DADOS REAIS do ESP32-S3');
    console.log(`   Dispositivo: ${status.deviceInfo?.deviceId || 'desconhecido'}`);
    console.log(`   Firmware:    ${status.deviceInfo?.firmware || '?'}`);
  } else {
    console.log('⚫ RESULTADO: Interface está em MODO SIMULAÇÃO');
    console.log('   Liga o ESP32-S3 e configura GTC_SERVER_HOST no config.h');
    console.log('   para o IP desta máquina.');
  }
  console.log('═'.repeat(55) + '\n');
}

main().catch(console.error);
