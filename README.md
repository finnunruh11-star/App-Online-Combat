# TTRPG Combat Desktop App

This version starts the relay server from inside the Electron app. You open the app, it boots the lobby, and the host flow can create a room without running `node server.js` by hand.

## What is included

- `main.js` / `preload.js` — Electron launcher and desktop bridge
- `server/relay-server.js` — embedded room relay and sync server
- `public/lobby.html` — session lobby for host and guests
- `public/combat/` — the combat UI and dice engine

## Install

1. Install Node.js 20 or newer.
2. In this folder, run:

```bash
npm install
```

## Run the desktop app

```bash
npm start
```

The app opens the lobby and starts the embedded relay automatically.

## Host flow

1. Enter your name.
2. Click **Create session**.
3. The app creates a room and opens the combat window.
4. If `cloudflared` is installed, the app will also try to expose a public invite URL automatically.
5. Share the room code, and if available the public URL, with your friends.

## Guest flow

1. Enter the same relay URL.
2. Enter your name.
3. Enter the room code.
4. Click **Join session**.

## Mobile access

The relay also serves a browser version of the lobby and combat screen.

### Same Wi-Fi network

1. Start the desktop app on the host computer and create a room.
2. Find the host computer's local IPv4 address with `ipconfig`.
3. On the phone, open `http://HOST_IP:3000` (for example, `http://192.168.1.25:3000`).
4. Enter the room code and player name, then join.

Windows may ask for firewall access the first time. Allow Node.js/TTRPG Combat on private networks so phones on the same Wi-Fi can connect.

### Over the internet

Install `cloudflared` before starting the desktop app. Create a room and share the generated `https://...trycloudflare.com` invite URL plus the room code. That URL now opens the browser lobby directly.

The mobile combat view keeps the battlefield full-width and provides four bottom actions:

- **Move**: select your token, tap a destination, then submit the move. Hosts can toggle drag-to-move.
- **Measure**: select a token, tap Measure, then drag across the battlefield.
- **Dice**: opens the compact dice roller.
- **Initiative**: opens the initiative list.

## Packaging

To build an installer or standalone package:

```bash
npm run dist
```

That uses `electron-builder` and writes output into `dist/`.

## Notes

- The app still needs a reachable relay URL for friends who are not on the same network.
- If you want fully remote sessions, install `cloudflared` or point everyone at the same hosted relay.
- The dice and guest prompt paths were patched so prompted guest rolls can go back to the table instead of becoming approval requests.
