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
const MAX_CHARGES = 10;

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
    guestFreeMoveEnabled: false,
    initiativeDisplayOrder: 'initiative',
    diceSettings: defaultDiceSettings(),
    diceState: null,
    latestDicePrompt: null,
    bagItems: [],
    bagWeightMultipliers: { fin: 0, nad: 0, kat: 0 },
    backgroundImageSrc: '',
    backgroundFillMode: 'stretch',
    overlayImageSrc: null,
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

function clampCharge(value) {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(MAX_CHARGES, n));
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
  const now = Date.now();
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
      hp: (p.type === 'player' || p.ownerId) ? p.hp : undefined,
      maxHp: (p.type === 'player' || p.ownerId) ? p.maxHp : undefined,
      charges: p.type === 'player' ? clampCharge(p.charges) : undefined,
      maxCharges: p.type === 'player' ? MAX_CHARGES : undefined,
      chargesTurnStartAdd: p.type === 'player' ? clampCharge(p.chargesTurnStartAdd) : undefined,
      chargesTurnEndAdd: p.type === 'player' ? clampCharge(p.chargesTurnEndAdd) : undefined,
      assignedTo: p.assignedTo || null,
      pingUntil: p.pingUntil || null,
      emoteKey: p.emoteKey || null,
      emoteDurationRemaining: (p.emoteUntil && p.emoteUntil > now) ? (p.emoteUntil - now) : (p.emoteUntil === null ? null : 0),
      emoteSrc: p.emoteSrc || null,
      emoteAnimated: !!p.emoteAnimated,
      emoteScale: p.emoteScale || 1,
      ownerId: p.ownerId || null,
      name: p.ownerId ? p.name : undefined,
      avatar: p.avatar || p.portrait || p.sprite || p.image || null,
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
    guestFreeMoveEnabled: room.state.guestFreeMoveEnabled,
    initiativeDisplayOrder: room.state.initiativeDisplayOrder,
    diceSettings: room.state.diceSettings,
    latestDicePrompt: room.state.latestDicePrompt,
    diceState: room.state.diceState,
    bagItems: (room.state.bagItems || []).filter(item => item?.visible !== false),
    bagWeightMultipliers: room.state.bagWeightMultipliers || { fin: 0, nad: 0, kat: 0 },
    customEmotes: room.state.customEmotes || null,
    customEnemyEmotes: room.state.customEnemyEmotes || null,
    roomCode: room.code,
    guestName: guestName || null,
    backgroundImageSrc: room.state.backgroundImageSrc || '',
    backgroundFillMode: room.state.backgroundFillMode || 'stretch',
    overlayImageSrc: room.state.overlayImageSrc || null,
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
    // Convert absolute emoteUntil to relative duration for clock-skew safety
    if (msg.type === 'state_echo' && msg.state && Array.isArray(msg.state.participants)) {
      const now = Date.now();
      const converted = { ...msg, state: { ...msg.state, participants: msg.state.participants.map(p => {
        if (p.emoteUntil === null || p.emoteUntil === undefined) return { ...p, emoteDurationRemaining: p.emoteUntil === null ? null : undefined, emoteUntil: undefined };
        const remaining = p.emoteUntil - now;
        return { ...p, emoteDurationRemaining: remaining > 0 ? remaining : 0, emoteUntil: undefined };
      })}};
      room.hostSocket.send(JSON.stringify(converted));
      return;
    }
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
    'guestDiceEnabled', 'guestDiceThrowEnabled', 'guestFreeMoveEnabled', 'initiativeDisplayOrder', 'diceSettings',
    'diceState', 'latestDicePrompt', 'bagItems', 'bagWeightMultipliers',
    'customEmotes', 'customEnemyEmotes',
    'backgroundImageSrc', 'backgroundFillMode', 'overlayImageSrc',
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

      if (msg.type === 'guest_bag_item_move' && ws.mode === 'guest') {
        const items = Array.isArray(room.state.bagItems) ? room.state.bagItems : [];
        const idx = items.findIndex(item => item && item.id === msg.itemId);
        if (idx === -1) {
          ws.send(JSON.stringify({ type: 'guest_bag_item_move_result', ok: false, reason: 'item_not_found' }));
          return;
        }

        const item = items[idx];
        if (item.visible === false) {
          ws.send(JSON.stringify({ type: 'guest_bag_item_move_result', ok: false, reason: 'not_visible' }));
          return;
        }

        const incoming = msg.location && typeof msg.location === 'object' ? msg.location : {};
        const nextKind = incoming.kind === 'canvas' ? 'canvas' : (incoming.kind === 'slot' ? 'slot' : 'bag');
        const nextBag = String(incoming.bagId || '').toLowerCase();
        const validBag = nextBag === 'fin' || nextBag === 'nad' || nextBag === 'kat';
        const bagKey = validBag ? nextBag : 'fin';
        const nextSlot = String(incoming.slotId || '').toLowerCase();
        const validSlot = [
          'head', 'hand1', 'hand2', 'torso', 'legs', 'feet', 'back',
          'accessoire1', 'accessoire2', 'extra1', 'extra2', 'extra3',
        ].includes(nextSlot);

        if (nextKind === 'slot') {
          const slotKey = validSlot ? nextSlot : 'head';
          const occupied = items.find((other, otherIdx) => (
            otherIdx !== idx
            && other
            && other.location
            && other.location.kind === 'slot'
            && String(other.location.bagId || 'fin').toLowerCase() === bagKey
            && String(other.location.slotId || '').toLowerCase() === slotKey
          ));
          if (occupied) {
            ws.send(JSON.stringify({ type: 'guest_bag_item_move_result', ok: false, reason: 'slot_occupied' }));
            return;
          }
        }

        const next = {
          ...item,
          location: {
            kind: nextKind === 'slot' ? 'slot' : nextKind,
            bagId: bagKey,
            slotId: nextKind === 'slot' ? (validSlot ? nextSlot : 'head') : null,
            x: Number.isFinite(Number(incoming.x)) ? Number(incoming.x) : 40,
            y: Number.isFinite(Number(incoming.y)) ? Number(incoming.y) : 40,
          },
        };

        items[idx] = next;
        room.state.bagItems = items;

        broadcastGuestState(room);
        sendToHost(room, { type: 'state_echo', state: room.state });
        ws.send(JSON.stringify({ type: 'guest_bag_item_move_result', ok: true }));
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

      if (msg.type === 'guest_emote_set' && ws.mode === 'guest') {
        const p = room.state.participants.find(pp => pp.id === msg.participantId);
        if (!p || p.type !== 'player') {
          ws.send(JSON.stringify({ type: 'guest_emote_result', ok: false, reason: 'participant_not_found' }));
          return;
        }
        if (p.assignedTo && !isAssignedTo(p, ws.name)) {
          ws.send(JSON.stringify({ type: 'guest_emote_result', ok: false, reason: 'not_your_token' }));
          return;
        }

        const key = String(msg.emoteKey || '').trim();
        if (!key) {
          ws.send(JSON.stringify({ type: 'guest_emote_result', ok: false, reason: 'bad_emote_key' }));
          return;
        }

        const durationRaw = Number.parseInt(msg.durationMs, 10);
        const durationMs = Number.isNaN(durationRaw) ? 1000 : Math.max(250, Math.min(60000, durationRaw));
        const loopsUntilInterrupt = !!msg.loop;
        p.emoteKey = key;
        p.emoteSrc = msg.emoteSrc || null;
        p.emoteAnimated = !!msg.emoteAnimated;
        p.emoteScale = Number(msg.emoteScale) || 1;
        p.emoteUntil = loopsUntilInterrupt ? null : (Date.now() + durationMs);

        broadcastGuestState(room);
        sendToHost(room, { type: 'state_echo', state: room.state });
        ws.send(JSON.stringify({ type: 'guest_emote_result', ok: true }));
        return;
      }

      if (msg.type === 'guest_emote_clear' && ws.mode === 'guest') {
        const p = room.state.participants.find(pp => pp.id === msg.participantId);
        if (!p || p.type !== 'player') {
          ws.send(JSON.stringify({ type: 'guest_emote_result', ok: false, reason: 'participant_not_found' }));
          return;
        }
        if (p.assignedTo && !isAssignedTo(p, ws.name)) {
          ws.send(JSON.stringify({ type: 'guest_emote_result', ok: false, reason: 'not_your_token' }));
          return;
        }

        p.emoteKey = null;
        p.emoteUntil = null;
        p.emoteSrc = null;
        p.emoteAnimated = false;
        p.emoteScale = 1;
        broadcastGuestState(room);
        sendToHost(room, { type: 'state_echo', state: room.state });
        ws.send(JSON.stringify({ type: 'guest_emote_result', ok: true }));
        return;
      }

      if (msg.type === 'charge_announce') {
        const text = String(msg.text || '').trim();
        if (!text) return;
        if (ws.mode === 'host') {
          broadcastToGuests(room, { type: 'charge_announce', text });
        } else {
          sendToHost(room, { type: 'charge_announce', text });
          broadcastToGuests(room, { type: 'charge_announce', text });
        }
        return;
      }

      if (msg.type === 'guest_charge_update' && ws.mode === 'guest') {
        const p = room.state.participants.find(pp => pp.id === msg.participantId);
        if (!p || p.type !== 'player') {
          ws.send(JSON.stringify({ type: 'guest_charge_update_result', ok: false, reason: 'participant_not_found' }));
          return;
        }
        if (p.assignedTo && !isAssignedTo(p, ws.name)) {
          ws.send(JSON.stringify({ type: 'guest_charge_update_result', ok: false, reason: 'not_your_token' }));
          return;
        }
        const before = clampCharge(p.charges);
        p.maxCharges = MAX_CHARGES;

        const mode = String(msg.mode || 'delta');
        if (mode === 'config') {
          const nextCurrent = Number.parseInt(msg.current, 10);
          const nextStart = Number.parseInt(msg.startGain, 10);
          const nextEnd = Number.parseInt(msg.endGain, 10);
          if (Number.isNaN(nextCurrent) && Number.isNaN(nextStart) && Number.isNaN(nextEnd)) {
            ws.send(JSON.stringify({ type: 'guest_charge_update_result', ok: false, reason: 'bad_payload', mode: 'config' }));
            return;
          }
          if (!Number.isNaN(nextCurrent)) p.charges = clampCharge(nextCurrent);
          else p.charges = before;
          if (!Number.isNaN(nextStart)) p.chargesTurnStartAdd = clampCharge(nextStart);
          else p.chargesTurnStartAdd = clampCharge(p.chargesTurnStartAdd);
          if (!Number.isNaN(nextEnd)) p.chargesTurnEndAdd = clampCharge(nextEnd);
          else p.chargesTurnEndAdd = clampCharge(p.chargesTurnEndAdd);
        } else {
          const delta = Number.parseInt(msg.delta, 10);
          if (Number.isNaN(delta) || delta === 0) {
            ws.send(JSON.stringify({ type: 'guest_charge_update_result', ok: false, reason: 'bad_delta', mode: 'delta' }));
            return;
          }
          p.charges = clampCharge(before + delta);
          p.chargesTurnStartAdd = clampCharge(p.chargesTurnStartAdd);
          p.chargesTurnEndAdd = clampCharge(p.chargesTurnEndAdd);
        }
        const after = clampCharge(p.charges);

        broadcastGuestState(room);
        sendToHost(room, { type: 'state_echo', state: room.state });
        ws.send(JSON.stringify({
          type: 'guest_charge_update_result',
          ok: true,
          before,
          after,
          mode,
          startGain: clampCharge(p.chargesTurnStartAdd),
          endGain: clampCharge(p.chargesTurnEndAdd),
        }));

        if (msg.announce !== false && before !== after) {
          const text = `${p.name}: charges ${before} → ${after} (player update)`;
          broadcastToGuests(room, { type: 'charge_announce', text });
          sendToHost(room, { type: 'charge_announce', text });
        }
        return;
      }

      if (msg.type === 'guest_end_turn' && ws.mode === 'guest') {
        const p = room.state.participants.find(pp => pp.id === msg.participantId);
        if (!p || p.type !== 'player') {
          ws.send(JSON.stringify({ type: 'guest_end_turn_result', ok: false, reason: 'participant_not_found' }));
          return;
        }
        if (p.assignedTo && !isAssignedTo(p, ws.name)) {
          ws.send(JSON.stringify({ type: 'guest_end_turn_result', ok: false, reason: 'not_your_token' }));
          return;
        }
        const turnP = room.state.participants[room.state.turnIndex];
        if (!turnP || turnP.id !== p.id) {
          ws.send(JSON.stringify({ type: 'guest_end_turn_result', ok: false, reason: 'not_your_turn' }));
          return;
        }
        sendToHost(room, { type: 'guest_end_turn_request', participantId: p.id, fromGuestName: ws.name || 'Guest' });
        ws.send(JSON.stringify({ type: 'guest_end_turn_result', ok: true, queued: true }));
        return;
      }

      if (msg.type === 'request_move' && ws.mode === 'guest') {
        const p = room.state.participants.find(pp => pp.id === msg.participantId);
        if (!p) {
          ws.send(JSON.stringify({ type: 'request_result', ok: false, reason: 'participant_not_found' }));
          return;
        }
        // Determine effective owner for assignment/turn checks
        const effectiveOwner = p.ownerId
          ? room.state.participants.find(pp => pp.id === p.ownerId)
          : p;
        const assignedTarget = effectiveOwner || p;
        if (assignedTarget.assignedTo && !isAssignedTo(assignedTarget, ws.name)) {
          ws.send(JSON.stringify({ type: 'request_result', ok: false, reason: 'not_your_token' }));
          return;
        }
        if (assignedTarget.assignedTo) {
          const turnP = room.state.participants[room.state.turnIndex];
          if (!turnP || (turnP.id !== assignedTarget.id && turnP.id !== p.id)) {
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

        if ((room.state.autoApproveIfWithinTolerance && distUnits <= allowedThisMove + room.state.moveToleranceUnits) || room.state.guestFreeMoveEnabled) {
          p.x = msg.target.x;
          p.y = msg.target.y;
          p.movedUnits = movedSoFar + distUnits;
          p.emoteKey = null;
          p.emoteUntil = null;
          p.emoteSrc = null;
          p.emoteAnimated = false;
          p.emoteScale = 1;
          broadcastGuestState(room);
          sendToHost(room, { type: 'state_echo', state: room.state });
          ws.send(JSON.stringify({ type: 'request_result', ok: true, autoApproved: true, reason: room.state.guestFreeMoveEnabled ? 'guest_free_move_enabled' : 'tolerance', newPos: { x: p.x, y: p.y } }));
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
        const requestId = msg.requestId || msg.id || null;
        const idx = room.pendingRequests.findIndex(r => (r.id || r.requestId) === requestId);
        if (idx === -1) {
          console.warn('[relay] approve_request not found', {
            room: room.code,
            requestId,
            pendingIds: room.pendingRequests.map(r => r.id || r.requestId || null),
          });
          return;
        }
        const req = room.pendingRequests.splice(idx, 1)[0];
        console.info('[relay] approve_request resolved', {
          room: room.code,
          requestId: req.id || req.requestId || requestId,
          approve: !!msg.approve,
          kind: req.requestType || req.kind || 'move',
        });
        if (msg.approve) {
          const p = room.state.participants.find(pp => pp.id === req.participantId);
          if (p) {
            p.x = req.target.x;
            p.y = req.target.y;
            p.movedUnits = (p.movedUnits || 0) + req.distUnits;
            p.emoteKey = null;
            p.emoteUntil = null;
            p.emoteSrc = null;
            p.emoteAnimated = false;
            p.emoteScale = 1;
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
        console.info('[relay] dice_request queued', {
          room: room.code,
          requestId: request.id || request.requestId || null,
          guest: request.fromGuestName || request.guestName || ws.name || 'Guest',
          expression: request.expression || '1d20',
        });
        room.pendingRequests = room.pendingRequests.filter(r => r.id !== request.id).concat(request);
        sendToHost(room, { type: 'dice_request', request });
        sendToHost(room, { type: 'pending_requests_update', requests: room.pendingRequests });
        return;
      }

      if (msg.type === 'dice_request_status' && ws.mode === 'host') {
        const requestId = msg.requestId || msg.id || null;
        if (requestId) {
          room.pendingRequests = room.pendingRequests.filter(r => (r.id || r.requestId) !== requestId);
        }
        console.info('[relay] dice_request_status', {
          room: room.code,
          requestId,
          approved: !!msg.approved,
          rollId: msg.rollId || null,
        });
        broadcastToGuests(room, { type: 'dice_request_status', requestId, approved: !!msg.approved, rollId: msg.rollId, reason: msg.reason || null });
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
