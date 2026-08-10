const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

let state = {
  mode: 'automatic',
  pump: false,
  zone1: false,
  zone2: false,
  humidity: { zone1: 62, zone2: 58 }
};

app.get('/api/status', (req, res) => {
  res.json(state);
});

app.post('/api/command', (req, res) => {
  const { command } = req.body || {};
  if (command === 'START') {
    state.pump = true;
    state.zone1 = true;
    state.zone2 = false;
  } else if (command === 'STOP') {
    state.pump = false;
    state.zone1 = false;
    state.zone2 = false;
  } else if (command === 'RESET') {
    state = { ...state, pump: false, zone1: false, zone2: false };
  }

  // Simulate sensor change when zones are active
  if (state.zone1) state.humidity.zone1 = Math.max(0, state.humidity.zone1 - 10);
  if (state.zone2) state.humidity.zone2 = Math.max(0, state.humidity.zone2 - 10);

  io.emit('update', state);
  res.json(state);
});

io.on('connection', (socket) => {
  socket.emit('update', state);
});

const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Mock API listening on ${port}`);
});
