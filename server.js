const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const path = require('path');

// ── Config ────────────────────────────────────
const PORT = process.env.PORT || 3000;
const ROOM_PASSWORD = process.env.ROOM_PASSWORD || 'changeme';
const TURN_SECRET = process.env.TURN_SECRET || 'turn-secret';
const TURN_DOMAIN = process.env.TURN_DOMAIN || 'turn.localhost';
const TURN_PORT = process.env.TURN_PORT || '5349';

// ── Express ───────────────────────────────────
const app = express();
const server = http.createServer(app);

app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', users: clients.size });
});

// Generate time-limited TURN credentials (HMAC-based, matches coturn use-auth-secret)
app.get('/turn-credentials', (req, res) => {
  const password = req.query.password;
  if (password !== ROOM_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const ttl = 86400; // 24 hours
  const timestamp = Math.floor(Date.now() / 1000) + ttl;
  const username = `${timestamp}:relay`;
  const hmac = crypto.createHmac('sha1', TURN_SECRET);
  hmac.update(username);
  const credential = hmac.digest('base64');

  res.json({
    iceServers: [
      // Public STUN servers — free, enables direct peer-to-peer when not blocked
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
      // TURN relay — required for UAE/restricted networks (TLS disguises as HTTPS)
      {
        urls: [
          `turns:${TURN_DOMAIN}:${TURN_PORT}?transport=tcp`,
          `turn:${TURN_DOMAIN}:${TURN_PORT}?transport=tcp`,
        ],
        username,
        credential,
      },
    ],
    // Don't force relay — WebRTC tries direct first, falls back to TURN automatically
  });
});

// ── WebSocket Signaling ───────────────────────
const wss = new WebSocketServer({ noServer: true });
const clients = new Map(); // id → WebSocket

server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const password = url.searchParams.get('password');

  if (password !== ROOM_PASSWORD) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

wss.on('connection', (ws) => {
  const id = crypto.randomUUID();

  // Tell the new user their ID + who's already in the room
  const existingUsers = Array.from(clients.keys());
  ws.send(JSON.stringify({ type: 'welcome', id, users: existingUsers }));

  // Tell everyone else about the new user
  broadcast({ type: 'user-joined', id }, id);

  clients.set(id, ws);
  console.log(`+ ${id.slice(0, 8)} joined (${clients.size} online)`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (!msg.target) return;

      const target = clients.get(msg.target);
      if (target && target.readyState === 1) {
        target.send(JSON.stringify({ ...msg, from: id }));
      }
    } catch (e) {
      console.error('Bad message:', e.message);
    }
  });

  ws.on('close', () => {
    clients.delete(id);
    broadcast({ type: 'user-left', id });
    console.log(`- ${id.slice(0, 8)} left (${clients.size} online)`);
  });

  ws.on('error', (err) => {
    console.error(`WS error ${id.slice(0, 8)}:`, err.message);
  });
});

function broadcast(msg, excludeId) {
  const data = JSON.stringify(msg);
  for (const [id, ws] of clients) {
    if (id !== excludeId && ws.readyState === 1) {
      ws.send(data);
    }
  }
}

// ── Start ─────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Relay signaling server on :${PORT}`);
});
