const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawn } = require('child_process');
const { startRelayServer } = require('./server/relay-server');

let lobbyWindow = null;
const combatWindows = new Set();
let relayInstance = null;
let tunnelProcess = null;
let tunnelUrl = null;
let runtimeInfo = {
  relayHost: '127.0.0.1',
  relayPort: Number(process.env.TTRPG_PORT || 3000),
  relayUrl: null,
  tunnelUrl: null,
  tunnelActive: false,
  tunnelError: null,
};

function toWsUrl(httpUrl) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString().replace(/^http/, 'ws').replace(/\/$/, '');
}

function toLobbyUrl() {
  return pathToFileURL(path.join(__dirname, 'public', 'lobby.html')).href;
}

function toCombatUrl() {
  return pathToFileURL(path.join(__dirname, 'public', 'combat', 'index.html')).href;
}

function broadcastRuntimeUpdate() {
  const payload = { ...runtimeInfo };
  if (lobbyWindow && !lobbyWindow.isDestroyed()) {
    lobbyWindow.webContents.send('app:runtimeUpdate', payload);
  }
}

async function ensureRelayServer() {
  if (relayInstance) return relayInstance;
  const port = runtimeInfo.relayPort;
  relayInstance = await startRelayServer({
    port,
    host: runtimeInfo.relayHost,
  });
  runtimeInfo.relayPort = relayInstance.port;
  runtimeInfo.relayUrl = relayInstance.url;
  broadcastRuntimeUpdate();
  return relayInstance;
}

function stopTunnel() {
  if (tunnelProcess && !tunnelProcess.killed) {
    try { tunnelProcess.kill(); } catch {}
  }
  tunnelProcess = null;
  tunnelUrl = null;
  runtimeInfo.tunnelUrl = null;
  runtimeInfo.tunnelActive = false;
  runtimeInfo.tunnelError = null;
}

function maybeStartTunnel() {
  if (process.env.TTRPG_NO_TUNNEL === '1') return Promise.resolve(null);
  if (tunnelProcess) return Promise.resolve(tunnelUrl);
  const relayUrl = runtimeInfo.relayUrl;
  if (!relayUrl) return Promise.resolve(null);
  const binary = process.env.CLOUDFLARED_BIN || 'cloudflared';
  return new Promise((resolve) => {
    try {
      const child = spawn(binary, ['tunnel', '--url', relayUrl, '--no-autoupdate'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      tunnelProcess = child;
      runtimeInfo.tunnelActive = true;
      runtimeInfo.tunnelError = null;
      const seen = new Set();
      const consume = (data) => {
        const text = String(data || '');
        const urlMatch = text.match(/https:\/\/[-a-z0-9]+\.trycloudflare\.com/i);
        if (urlMatch && !seen.has(urlMatch[0])) {
          seen.add(urlMatch[0]);
          tunnelUrl = urlMatch[0];
          runtimeInfo.tunnelUrl = tunnelUrl;
          runtimeInfo.tunnelActive = true;
          broadcastRuntimeUpdate();
          resolve(tunnelUrl);
        }
        if (/error/i.test(text) && !runtimeInfo.tunnelUrl) {
          runtimeInfo.tunnelError = text.trim().slice(-400);
          broadcastRuntimeUpdate();
        }
      };
      child.stdout.on('data', consume);
      child.stderr.on('data', consume);
      child.on('exit', (code) => {
        if (!tunnelUrl) {
          runtimeInfo.tunnelActive = false;
          runtimeInfo.tunnelError = code === 0 ? null : `cloudflared exited with code ${code}`;
          broadcastRuntimeUpdate();
          resolve(null);
        }
        tunnelProcess = null;
      });
      child.on('error', (err) => {
        runtimeInfo.tunnelActive = false;
        runtimeInfo.tunnelError = err?.message || String(err);
        broadcastRuntimeUpdate();
        tunnelProcess = null;
        resolve(null);
      });
    } catch (err) {
      runtimeInfo.tunnelActive = false;
      runtimeInfo.tunnelError = err?.message || String(err);
      broadcastRuntimeUpdate();
      resolve(null);
    }
  });
}

function openCombatWindow({ mode, name, room, serverUrl }) {
  const win = new BrowserWindow({
    width: 1600,
    height: 1000,
    minWidth: 1280,
    minHeight: 800,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const params = new URLSearchParams({
    mode,
    name,
    room,
    ws: toWsUrl(serverUrl),
  });
  win.loadURL(`${toCombatUrl()}?${params.toString()}`);
  combatWindows.add(win);
  win.on('closed', () => combatWindows.delete(win));
  return win;
}

async function createRoom(serverUrl, hostName) {
  const res = await fetch(new URL('/api/rooms', serverUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: hostName || 'DM', hostName: hostName || 'DM' }),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Room creation failed: ${res.status} ${txt}`);
  }
  return res.json();
}

async function verifyRoom(serverUrl, room) {
  const res = await fetch(new URL(`/api/rooms/${encodeURIComponent(room)}`, serverUrl));
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Room lookup failed: ${res.status} ${txt}`);
  }
  return res.json();
}

function createLobbyWindow() {
  lobbyWindow = new BrowserWindow({
    width: 1020,
    height: 820,
    backgroundColor: '#1a1a2e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  lobbyWindow.loadURL(toLobbyUrl());
  lobbyWindow.on('closed', () => { lobbyWindow = null; });
  lobbyWindow.webContents.on('did-finish-load', broadcastRuntimeUpdate);
}

ipcMain.handle('app:getRuntimeInfo', async () => {
  await ensureRelayServer();
  return { ...runtimeInfo };
});

ipcMain.handle('session:create', async (_evt, payload) => {
  await ensureRelayServer();
  const serverUrl = String(payload?.serverUrl || runtimeInfo.relayUrl || 'http://127.0.0.1:3000').trim();
  const name = String(payload?.name || 'DM').trim() || 'DM';
  const data = await createRoom(serverUrl, name);
  const roomCode = data?.room?.code;
  if (!roomCode) throw new Error('Server did not return a room code.');
  const publicUrl = await maybeStartTunnel();
  openCombatWindow({ mode: 'host', name, room: roomCode, serverUrl });
  broadcastRuntimeUpdate();
  return { ok: true, room: data.room, serverUrl, publicUrl, runtime: { ...runtimeInfo } };
});

ipcMain.handle('session:join', async (_evt, payload) => {
  const serverUrl = String(payload?.serverUrl || runtimeInfo.relayUrl || 'http://127.0.0.1:3000').trim();
  const name = String(payload?.name || 'Player').trim() || 'Player';
  const room = String(payload?.room || '').trim().toUpperCase();
  if (!room) throw new Error('Enter a room code.');
  await verifyRoom(serverUrl, room);
  openCombatWindow({ mode: 'guest', name, room, serverUrl });
  return { ok: true, room, serverUrl, runtime: { ...runtimeInfo } };
});

ipcMain.handle('shell:openExternal', async (_evt, url) => {
  await shell.openExternal(url);
  return true;
});

app.whenReady().then(async () => {
  await ensureRelayServer();
  createLobbyWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createLobbyWindow();
  });
});

app.on('before-quit', () => {
  stopTunnel();
  if (relayInstance?.close) {
    try { relayInstance.close(); } catch {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
