const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = Number(process.env.PORT || 3000);
const DEFAULT_ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 1000 * 60 * 60 * 24);

const rooms = new Map();

function randomCode(len = 6) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function defaultDiceSettings() {
  return {
    randomizeColors: true,
    diceColor: '#f7f8fd',
    dieScale: 1,
    launchVelocity: 9,
    launchSpin: 12,
    bounciness: 0.22,
  };
}

function defaultGameState() {
  return {
    participants: [],
    objects: [],
    turnIndex: 0,
    canvasWidth: 900,
    canvasHeight: 700,
    pixelsPerUnit: 20,
    moveToleranceUnits: 0.25,
    autoApproveIfWithinTolerance: true,
    guestDrawEnabled: false,
    guestInitiativeEnabled: false,
    guestDiceEnabled: false,
    guestDiceThrowEnabled: false,
    initiativeDisplayOrder: 'initiative',
    diceSettings: defaultDiceSettings(),
    diceState: null,
    latestDicePrompt: null,
  };
}

function createRoom(code = randomCode()) {
  const normalized = String(code || '').trim().toUpperCase();
  const room = {
    code: normalized || randomCode(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    hostSocket: null,
    hostName: null,
    guests: new Set(),
    pendingRequests: [],
    state: defaultGameState(),
    cleanupTimer: null,
  };
  rooms.set(room.code, room);
  return room;
}

function getRoom(code, createIfMissing = false) {
  const normalized = String(code || '').trim().toUpperCase();
  if (!normalized) return null;
  let room = rooms.get(normalized);
  if (!room && createIfMissing) room = createRoom(normalized);
  return room || null;
}

function isAssignedTo(participant, guestName) {
  if (!participant?.assignedTo) return false;
  if (Array.isArray(participant.assignedTo)) return participant.assignedTo.includes(guestName);
  return participant.assignedTo === guestName;
}

function roomSnapshot(room) {
  return {
    code: room.code,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    hostConnected: !!room.hostSocket,
    hostName: room.hostName,
    guestCount: room.guests.size,
    pendingCount: room.pendingRequests.length,
    state: room.state,
  };
}

function maskStateForGuest(room, guestName) {
  const current = room.state.participants[room.state.turnIndex];
  return {
    participants: room.state.participants.map(p => ({
      id: p.id,
      type: p.type,
      x: p.x,
      y: p.y,
      radius: p.radius || 15,
      color: p.color || (p.type === 'player' ? '#6366f1' : '#e05252'),
      publicDisplayName: p.type === 'player' ? p.name : null,
      movedUnits: p.movedUnits || 0,
      speed: p.speed || 0,
      hp: p.type === 'player' ? p.hp : undefined,
      maxHp: p.type === 'player' ? p.maxHp : undefined,
      assignedTo: p.assignedTo || null,
      pingUntil: p.pingUntil || null,
    })),
    objects: room.state.objects,
    turnIndex: room.state.turnIndex,
    publicTurnName: current ? (current.type === 'player' ? current.name : 'Enemy Turn') : null,
    canvasWidth: room.state.canvasWidth,
    canvasHeight: room.state.canvasHeight,
    pixelsPerUnit: room.state.pixelsPerUnit,
    guestDrawEnabled: room.state.guestDrawEnabled,
    guestInitiativeEnabled: room.state.guestInitiativeEnabled,
    guestDiceEnabled: room.state.guestDiceEnabled,
    guestDiceThrowEnabled: room.state.guestDiceThrowEnabled,
    initiativeDisplayOrder: room.state.initiativeDisplayOrder,
    diceSettings: room.state.diceSettings,
    latestDicePrompt: room.state.latestDicePrompt,
    diceState: room.state.diceState,
    roomCode: room.code,
    guestName: guestName || null,
  };
}

function broadcastToGuests(room, msg) {
  const payload = JSON.stringify(msg);
  for (const ws of room.guests) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function broadcastGuestState(room) {
  for (const ws of room.guests) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    ws.send(JSON.stringify({ type: 'guest_state', state: maskStateForGuest(room, ws.name) }));
  }
}

function sendToHost(room, msg) {
  if (room.hostSocket && room.hostSocket.readyState === WebSocket.OPEN) {
    room.hostSocket.send(JSON.stringify(msg));
  }
}

function touchRoom(room) {
  room.updatedAt = Date.now();
}

function scheduleCleanup(room) {
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    const still = rooms.get(room.code);
    if (!still) return;
    if (still.hostSocket || still.guests.size) return;
    if (Date.now() - still.updatedAt < DEFAULT_ROOM_TTL_MS) return;
    rooms.delete(room.code);
  }, Math.min(DEFAULT_ROOM_TTL_MS, 60_000));
}

function updateStateFromHost(room, msg) {
  const src = msg.state && typeof msg.state === 'object' ? msg.state : msg;
  const keys = [
    'participants', 'objects', 'turnIndex', 'canvasWidth', 'canvasHeight', 'pixelsPerUnit',
    'moveToleranceUnits', 'autoApproveIfWithinTolerance', 'guestDrawEnabled', 'guestInitiativeEnabled',
    'guestDiceEnabled', 'guestDiceThrowEnabled', 'initiativeDisplayOrder', 'diceSettings',
    'diceState', 'latestDicePrompt',
  ];
  for (const key of keys) {
    if (src[key] !== undefined) room.state[key] = deepClone(src[key]);
  }
  touchRoom(room);
}

app.get('/api/health', (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.post('/api/rooms', (req, res) => {
  const requested = String(req.body?.room || req.body?.code || '').trim().toUpperCase();
  let room = requested ? getRoom(requested, true) : createRoom();
  if (room.hostSocket) {
    room = createRoom();
  }
  room.hostName = String(req.body?.hostName || req.body?.name || 'DM').trim() || 'DM';
  room.state = defaultGameState();
  room.pendingRequests = [];
  touchRoom(room);
  res.json({ ok: true, room: roomSnapshot(room) });
});

app.get('/api/rooms/:code', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) {
    res.status(404).json({ ok: false, error: 'room_not_found' });
    return;
  }
  res.json({ ok: true, room: roomSnapshot(room) });
});

app.delete('/api/rooms/:code', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) {
    res.status(404).json({ ok: false, error: 'room_not_found' });
    return;
  }
  if (room.hostSocket && room.hostSocket.readyState === WebSocket.OPEN) {
    room.hostSocket.close();
  }
  for (const ws of room.guests) {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }
  rooms.delete(room.code);
  res.json({ ok: true });
});

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      console.error('Invalid message JSON:', err);
      return;
    }

    try {
      if (msg.type === 'hello') {
        ws.mode = msg.mode;
        ws.name = msg.name || null;
        ws.roomCode = String(msg.room || msg.roomCode || '').trim().toUpperCase();

        let room = getRoom(ws.roomCode, msg.mode === 'host');
        if (!room) {
          ws.send(JSON.stringify({ type: 'room_not_found', room: ws.roomCode || null }));
          ws.close();
          return;
        }

        if (msg.mode === 'host') {
          if (room.hostSocket && room.hostSocket !== ws) {
            room.hostSocket.send(JSON.stringify({ type: 'host_disconnected', reason: 'replaced' }));
            room.hostSocket = null;
          }
          room.hostSocket = ws;
          room.hostName = ws.name || 'DM';
          ws.room = room;
          touchRoom(room);
          ws.send(JSON.stringify({ type: 'host_ack', state: room.state, pendingRequests: room.pendingRequests, room: roomSnapshot(room) }));
          broadcastGuestState(room);
          return;
        }

        ws.room = room;
        room.guests.add(ws);
        touchRoom(room);
        ws.send(JSON.stringify({ type: 'guest_state', state: maskStateForGuest(room, ws.name), guestName: ws.name, room: roomSnapshot(room) }));
        sendToHost(room, { type: 'guest_connected', name: ws.name, room: roomSnapshot(room) });
        return;
      }

      const room = ws.room || (ws.roomCode ? getRoom(ws.roomCode) : null);
      if (!room) return;
      touchRoom(room);

      if (msg.type === 'state_request' && ws.mode === 'guest') {
        ws.send(JSON.stringify({ type: 'guest_state', state: maskStateForGuest(room, ws.name) }));
        return;
      }

      if ((msg.type === 'host_full_update' || msg.type === 'state_echo') && ws.mode === 'host') {
        updateStateFromHost(room, msg);
        broadcastGuestState(room);
        sendToHost(room, { type: 'state_echo', state: room.state });
        return;
      }

      if (msg.type === 'guest_draw' && ws.mode === 'guest') {
        if (!room.state.guestDrawEnabled) {
          ws.send(JSON.stringify({ type: 'draw_rejected' }));
          return;
        }
        const obj = msg.object;
        if (!obj || !obj.id || !obj.type) return;
        obj.guestDrawn = true;
        obj.drawnBy = ws.name;
        const idx = room.state.objects.findIndex(o => o.id === obj.id);
        if (idx !== -1) room.state.objects[idx] = obj;
        else room.state.objects.push(obj);
        broadcastGuestState(room);
        sendToHost(room, { type: 'state_echo', state: room.state });
        return;
      }

      if (msg.type === 'guest_clear_mine' && ws.mode === 'guest') {
        room.state.objects = room.state.objects.filter(o => !(o.guestDrawn && o.drawnBy === ws.name));
        broadcastGuestState(room);
        sendToHost(room, { type: 'state_echo', state: room.state });
        return;
      }

      if (msg.type === 'guest_delete_object' && ws.mode === 'guest') {
        if (!room.state.guestDrawEnabled) return;
        room.state.objects = room.state.objects.filter(o => !(o.id === msg.id && o.drawnBy === ws.name));
        broadcastGuestState(room);
        sendToHost(room, { type: 'state_echo', state: room.state });
        return;
      }

      if (msg.type === 'map_ping') {
        const payload = JSON.stringify({
          type: 'map_ping',
          x: msg.x,
          y: msg.y,
          pingIndex: msg.pingIndex,
          label: msg.label,
          fromName: msg.fromName,
          pingId: msg.pingId,
        });
        for (const c of wss.clients) {
          if (c !== ws && c.readyState === WebSocket.OPEN && c.room === room) c.send(payload);
        }
        return;
      }

      if (msg.type === 'guest_ping' && ws.mode === 'guest') {
        const p = room.state.participants.find(pp => pp.id === msg.participantId);
        if (!p) return;
        p.pingUntil = Date.now() + 3000;
        broadcastGuestState(room);
        sendToHost(room, { type: 'state_echo', state: room.state });
        return;
      }

      if (msg.type === 'request_move' && ws.mode === 'guest') {
        const p = room.state.participants.find(pp => pp.id === msg.participantId);
        if (!p) {
          ws.send(JSON.stringify({ type: 'request_result', ok: false, reason: 'participant_not_found' }));
          return;
        }
        if (p.assignedTo && !isAssignedTo(p, ws.name)) {
          ws.send(JSON.stringify({ type: 'request_result', ok: false, reason: 'not_your_token' }));
          return;
        }
        if (p.assignedTo) {
          const turnP = room.state.participants[room.state.turnIndex];
          if (!turnP || turnP.id !== p.id) {
            ws.send(JSON.stringify({ type: 'request_result', ok: false, reason: 'not_your_turn' }));
            return;
          }
        }

        const dx = msg.target.x - p.x;
        const dy = msg.target.y - p.y;
        const centerDist = Math.sqrt(dx * dx + dy * dy);
        const edgeDist = Math.max(0, centerDist - (p.radius || 15));
        const distUnits = edgeDist / room.state.pixelsPerUnit;
        const extraUnits = msg.extraUnits || 0;
        const movedSoFar = p.movedUnits || 0;
        const remaining = Math.max(0, (p.speed || 0) - movedSoFar);
        const allowedThisMove = remaining + extraUnits;

        if (room.state.autoApproveIfWithinTolerance && distUnits <= allowedThisMove + room.state.moveToleranceUnits) {
          p.x = msg.target.x;
          p.y = msg.target.y;
          p.movedUnits = movedSoFar + distUnits;
          broadcastGuestState(room);
          sendToHost(room, { type: 'state_echo', state: room.state });
          ws.send(JSON.stringify({ type: 'request_result', ok: true, autoApproved: true, newPos: { x: p.x, y: p.y } }));
          return;
        }

        const request = {
          id: `req_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          fromGuestName: ws.name || 'Guest',
          participantId: p.id,
          participantName: p.name,
          target: msg.target,
          extraUnits,
          distUnits,
          remaining,
          allowedUnits: allowedThisMove,
          timestamp: Date.now(),
          requestType: 'move',
          kind: 'move',
        };
        room.pendingRequests.push(request);
        sendToHost(room, { type: 'pending_requests_update', requests: room.pendingRequests });
        ws.send(JSON.stringify({ type: 'request_result', ok: null, queued: true, requestId: request.id }));
        return;
      }

      if (msg.type === 'approve_request' && ws.mode === 'host') {
        const idx = room.pendingRequests.findIndex(r => r.id === msg.requestId);
        if (idx === -1) return;
        const req = room.pendingRequests.splice(idx, 1)[0];
        if (msg.approve) {
          const p = room.state.participants.find(pp => pp.id === req.participantId);
          if (p) {
            p.x = req.target.x;
            p.y = req.target.y;
            p.movedUnits = (p.movedUnits || 0) + req.distUnits;
          }
          broadcastGuestState(room);
          sendToHost(room, { type: 'state_echo', state: room.state });
          broadcastToGuests(room, { type: 'request_resolved', requestId: req.id, approved: true, participantId: req.participantId, newPos: req.target });
        } else {
          broadcastToGuests(room, { type: 'request_resolved', requestId: req.id, approved: false, participantId: req.participantId });
        }
        sendToHost(room, { type: 'pending_requests_update', requests: room.pendingRequests });
        return;
      }


if (msg.type === 'dice_roll_prompt' && ws.mode === 'host') {
  room.state.latestDicePrompt = {
    id: msg.id || msg.promptId || msg.prompt?.id || `prompt_${Date.now()}`,
    expression: String(msg.expression || msg.prompt?.expression || '1d20').trim() || '1d20',
    createdAt: msg.createdAt || Date.now(),
  };
  const promptPayload = { type: 'dice_roll_prompt', prompt: room.state.latestDicePrompt, expression: room.state.latestDicePrompt.expression, id: room.state.latestDicePrompt.id, source: 'host' };
  sendToHost(room, { type: 'state_echo', state: room.state });
  broadcastToGuests(room, promptPayload);
  broadcastGuestState(room);
  return;
}

      if (msg.type === 'dice_request' && ws.mode === 'guest') {
        const request = {
          ...(msg.request || msg),
          id: (msg.request && msg.request.id) || msg.id || `dice_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
          requestType: 'dice',
          kind: 'dice',
          fromGuestName: ws.name || 'Guest',
          guestName: ws.name || 'Guest',
          timestamp: Date.now(),
        };
        room.pendingRequests = room.pendingRequests.filter(r => r.id !== request.id).concat(request);
        sendToHost(room, { type: 'dice_request', request });
        sendToHost(room, { type: 'pending_requests_update', requests: room.pendingRequests });
        return;
      }

      if (msg.type === 'dice_request_status' && ws.mode === 'host') {
        room.pendingRequests = room.pendingRequests.filter(r => r.id !== msg.requestId);
        broadcastToGuests(room, { type: 'dice_request_status', requestId: msg.requestId, approved: !!msg.approved, rollId: msg.rollId, reason: msg.reason || null });
        sendToHost(room, { type: 'pending_requests_update', requests: room.pendingRequests });
        return;
      }

      if (msg.type === 'dice_roll_start' && ws.mode === 'host') {
        room.state.diceState = deepClone(msg);
        room.state.latestDicePrompt = msg.prompt || room.state.latestDicePrompt;
        sendToHost(room, { type: 'state_echo', state: room.state });
        broadcastToGuests(room, { type: 'dice_roll_start', ...msg });
        broadcastGuestState(room);
        return;
      }

      if (msg.type === 'dice_roll_state' && ws.mode === 'host') {
        room.state.diceState = deepClone(msg.state || msg);
        sendToHost(room, { type: 'state_echo', state: room.state });
        broadcastToGuests(room, { type: 'dice_roll_state', ...msg });
        return;
      }

      if (msg.type === 'dice_roll_result' && ws.mode === 'host') {
        room.state.diceState = deepClone(msg);
        if (msg.promptId || msg.prompt) room.state.latestDicePrompt = null;
        sendToHost(room, { type: 'state_echo', state: room.state });
        broadcastToGuests(room, { type: 'dice_roll_result', ...msg });
        broadcastGuestState(room);
        return;
      }

      if (msg.type === 'dice_clear' && ws.mode === 'host') {
        room.state.diceState = { cleared: true };
        sendToHost(room, { type: 'state_echo', state: room.state });
        broadcastToGuests(room, { type: 'dice_clear', ...msg });
        broadcastGuestState(room);
        return;
      }

      if (msg.type === 'request_result' || msg.type === 'request_resolved') {
        // legacy passthrough; keep silent
        return;
      }
    } catch (err) {
      console.error('Message handling error:', err);
    }
  });

  ws.on('close', () => {
    const room = ws.room;
    if (!room) return;
    if (ws.mode === 'host' && room.hostSocket === ws) {
      room.hostSocket = null;
      room.hostName = null;
      broadcastToGuests(room, { type: 'host_disconnected' });
    } else if (ws.mode === 'guest') {
      room.guests.delete(ws);
      sendToHost(room, { type: 'guest_disconnected', name: ws.name });
    }
    touchRoom(room);
    scheduleCleanup(room);
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping(() => {});
  }
}, 30_000);

function startRelayServer({ port = PORT, host = '127.0.0.1' } = {}) {
  return new Promise((resolve) => {
    const listener = server.listen(port, host, () => {
      const address = listener.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      const actualHost = typeof address === 'object' && address && address.address && address.address !== '::' ? address.address : host;
      console.log(`Relay server running on http://${actualHost}:${actualPort}`);
      resolve({
        app,
        server,
        wss,
        rooms,
        port: actualPort,
        host: actualHost,
        url: `http://${actualHost}:${actualPort}`,
        close: () => new Promise((r) => listener.close(() => r())),
      });
    });
  });
}

if (require.main === module) {
  startRelayServer();
}

module.exports = { startRelayServer, app, server, wss, rooms };
