'use strict';
// HTTP static file server + WebSocket lobby/game server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const { Game } = require('./game/game');
const { generateMap } = require('./game/map');
const { NationAI, BotAI } = require('./game/ai');
const { sanitizeSettings, MAP_SIZES, PlayerType, TICKS_PER_SECOND } = require('./game/config');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.json': 'application/json',
};

// ---- HTTP ------------------------------------------------------------------
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath.startsWith('/g/')) urlPath = '/index.html'; // join links: /g/CODE
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

// ---- Lobbies -----------------------------------------------------------------
const lobbies = new Map(); // code -> Lobby
const clients = new Map(); // token -> Client

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    let c = '';
    for (let i = 0; i < 5; i++) c += chars[crypto.randomInt(chars.length)];
    if (!lobbies.has(c)) return c;
  }
}

class Client {
  constructor(token) {
    this.token = token;
    this.id = crypto.randomBytes(6).toString('hex');
    this.name = 'Player';
    this.ws = null;
    this.lobby = null;
    this.player = null; // in-game Player
    this.lastSeen = Date.now();
  }
  send(obj) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(JSON.stringify(obj)); } catch (_) { /* ignore */ }
    }
  }
}

class Lobby {
  constructor(host, settings) {
    this.code = makeCode();
    this.host = host;
    this.settings = settings;
    this.clients = new Set([host]);
    this.game = null;
    this.timer = null;
    this.createdAt = Date.now();
    this.chat = [];
    this.tickAccumulator = 0;
  }
  get inGame() { return this.game !== null; }
  summary() {
    return {
      code: this.code,
      name: this.settings.name,
      host: this.host.name,
      players: [...this.clients].map((c) => ({ id: c.id, name: c.name, host: c === this.host, online: !!(c.ws && c.ws.readyState === 1) })),
      settings: this.settings,
      inGame: this.inGame,
    };
  }
  broadcast(obj, filter) {
    const s = JSON.stringify(obj);
    for (const c of this.clients) {
      if (filter && !filter(c)) continue;
      if (c.ws && c.ws.readyState === 1) { try { c.ws.send(s); } catch (_) { /* ignore */ } }
    }
  }
  broadcastLobby() { this.broadcast({ t: 'lobby', lobby: this.summary() }); }

  start() {
    if (this.game) return;
    const s = this.settings;
    const [w, h] = MAP_SIZES[s.mapSize];
    const seed = s.seed || crypto.randomInt(1, 2147483647);
    const map = generateMap(w, h, seed, s.mapType);
    const game = new Game({ ...s, seed }, map);
    for (const c of this.clients) {
      c.player = game.addPlayer({ id: c.id, name: c.name, type: PlayerType.HUMAN });
    }
    game.addAIPlayers(NationAI, BotAI);
    this.game = game;
    const full = game.fullState();
    for (const c of this.clients) c.send({ t: 'start', code: this.code, you: c.player.smallID, state: full });
    this.lastTime = Date.now();
    this.timer = setInterval(() => this.loop(), 1000 / TICKS_PER_SECOND);
    console.log(`[${this.code}] game started: ${w}x${h} seed=${seed} humans=${this.clients.size} nations=${s.nations} bots=${s.bots}`);
  }

  loop() {
    const game = this.game;
    if (!game) return;
    // gameSpeed > 1 runs extra sim ticks per real tick
    this.tickAccumulator += this.settings.gameSpeed;
    let steps = 0;
    while (this.tickAccumulator >= 1 && steps < 4) {
      this.tickAccumulator -= 1;
      steps++;
      const t0 = Date.now();
      try { game.step(); } catch (e) { console.error('sim error', e); }
      const pkt = game.drainTickPacket();
      const dt = Date.now() - t0;
      if (dt > 80) console.warn(`[${this.code}] slow tick ${dt}ms`);
      this.sendTick(pkt);
    }
    if (game.phase === 'over' && game.tick - game.winTick > 30 * TICKS_PER_SECOND * 2) {
      this.endGame();
    }
  }

  sendTick(pkt) {
    const events = pkt.events;
    const targeted = events && events.some((e) => e.to);
    if (!targeted) { this.broadcast(pkt); return; }
    // some events are private (e.g. "X is attacking you"): filter per client
    for (const c of this.clients) {
      if (!c.ws || c.ws.readyState !== 1) continue;
      pkt.events = events.filter((e) => !e.to || e.to === c.id);
      c.send(pkt);
    }
    pkt.events = events;
  }

  endGame() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.game = null;
    for (const c of this.clients) c.player = null;
    this.broadcast({ t: 'ended' });
    this.broadcastLobby();
  }

  removeClient(c) {
    this.clients.delete(c);
    c.lobby = null;
    if (c.player) { c.player.disconnected = true; c.player = null; }
    if (this.clients.size === 0) {
      if (this.timer) clearInterval(this.timer);
      lobbies.delete(this.code);
      console.log(`[${this.code}] closed`);
      return;
    }
    if (this.host === c) this.host = [...this.clients][0];
    this.broadcastLobby();
  }

  handleIntent(c, m) {
    const g = this.game, p = c.player;
    if (!g || !p) return;
    const tile = Number.isInteger(m.tile) && m.tile >= 0 && m.tile < g.terrain.length ? m.tile : null;
    const ratio = Math.min(1, Math.max(0.01, Number(m.ratio) || 0.2));
    switch (m.t) {
      case 'spawn':
        if (tile !== null && !g.spawn(p, tile)) c.send({ t: 'toast', msg: 'Cannot spawn there' });
        break;
      case 'attack': {
        if (tile === null || !p.alive) return;
        const target = g.ownerOf(tile);
        if (!g.isLand(tile)) return;
        if (target === p) return;
        if (target && p.isFriendly(target)) return c.send({ t: 'toast', msg: `You are allied with ${target.name}` });
        // bordering by land? otherwise it must be a boat
        const { players } = g.neighborsOf(p);
        const borders = target ? players.includes(target) : g.neighborsOf(p).touchesNeutral;
        if (borders) {
          const troops = g.config.attackAmount(p, ratio);
          if (!g.sendAttack(p, target, troops)) c.send({ t: 'toast', msg: 'Cannot attack' });
        } else {
          this.handleIntent(c, { t: 'boat', tile, ratio });
        }
        break;
      }
      case 'boat': {
        if (tile === null) return;
        const troops = g.config.attackAmount(p, ratio);
        if (g.settings.disableBoats) return c.send({ t: 'toast', msg: 'Boats are disabled' });
        if (!g.sendBoat(p, tile, troops)) c.send({ t: 'toast', msg: 'No sea route for a boat (max 3 boats, need a coast on both ends)' });
        break;
      }
      case 'retreat':
        g.retreatAttack(p, Number(m.id));
        break;
      case 'build': {
        if (tile === null) return;
        const r = g.build(p, String(m.unit), tile);
        if (!r.ok) c.send({ t: 'toast', msg: r.reason });
        break;
      }
      case 'nuke': {
        if (tile === null) return;
        const r = g.launchNuke(p, String(m.type), tile);
        if (!r.ok) c.send({ t: 'toast', msg: r.reason });
        break;
      }
      case 'ally': {
        const o = g.playersBySmall[Number(m.p)];
        if (o && o !== p) { if (!g.requestAlliance(p, o)) c.send({ t: 'toast', msg: 'Alliance request not possible' }); }
        break;
      }
      case 'allyReply': {
        const o = g.playersBySmall[Number(m.p)];
        if (o) g.replyAlliance(p, o, !!m.accept);
        break;
      }
      case 'breakAlly': {
        const o = g.playersBySmall[Number(m.p)];
        if (o) g.breakAlliance(p, o);
        break;
      }
      case 'donate': {
        const o = g.playersBySmall[Number(m.p)];
        if (o) g.donate(p, o, Number(m.troops) || 0, Number(m.gold) || 0);
        break;
      }
      default:
        break;
    }
  }
}

function publicLobbies() {
  return [...lobbies.values()].filter((l) => l.settings.public && !l.inGame).map((l) => ({ code: l.code, name: l.settings.name, host: l.host.name, players: l.clients.size, max: l.settings.maxHumans }));
}

// ---- WebSocket ----------------------------------------------------------------
const MAX_LOBBIES = Number(process.env.MAX_LOBBIES) || 50;
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });

wss.on('connection', (ws) => {
  let client = null;
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || typeof m !== 'object') return;

    if (m.t === 'hello') {
      const token = typeof m.token === 'string' && m.token.length >= 8 && m.token.length <= 64 ? m.token : crypto.randomBytes(16).toString('hex');
      client = clients.get(token);
      if (!client) { client = new Client(token); clients.set(token, client); }
      if (client.ws && client.ws !== ws) { try { client.ws.close(); } catch (_) { /* */ } }
      client.ws = ws;
      client.lastSeen = Date.now();
      if (typeof m.name === 'string' && m.name.trim()) client.name = m.name.trim().slice(0, 20);
      client.send({ t: 'welcome', token, id: client.id, name: client.name, lan: lanAddresses(), port: PORT });
      // reconnect into an ongoing lobby/game
      if (client.lobby) {
        const l = client.lobby;
        if (l.game && client.player) {
          client.player.disconnected = false;
          client.send({ t: 'lobby', lobby: l.summary() });
          client.send({ t: 'start', code: l.code, you: client.player.smallID, state: l.game.fullState() });
        } else {
          client.send({ t: 'lobby', lobby: l.summary() });
        }
        l.broadcastLobby();
      }
      return;
    }
    if (!client) return;
    client.lastSeen = Date.now();

    switch (m.t) {
      case 'setName':
        if (typeof m.name === 'string' && m.name.trim()) client.name = m.name.trim().slice(0, 20);
        if (client.lobby) client.lobby.broadcastLobby();
        break;
      case 'list':
        client.send({ t: 'lobbies', lobbies: publicLobbies() });
        break;
      case 'create': {
        if (lobbies.size >= MAX_LOBBIES) return client.send({ t: 'error', msg: 'Server is full, try again later' });
        if (client.lobby) client.lobby.removeClient(client);
        const lobby = new Lobby(client, sanitizeSettings(m.settings));
        lobbies.set(lobby.code, lobby);
        client.lobby = lobby;
        lobby.broadcastLobby();
        console.log(`[${lobby.code}] created by ${client.name}`);
        break;
      }
      case 'join': {
        const code = String(m.code || '').toUpperCase().trim();
        const lobby = lobbies.get(code);
        if (!lobby) return client.send({ t: 'error', msg: `No game with code ${code}` });
        if (client.lobby === lobby) return lobby.broadcastLobby();
        if (client.lobby) client.lobby.removeClient(client);
        if (lobby.inGame) return client.send({ t: 'error', msg: 'That game already started' });
        if (lobby.clients.size >= lobby.settings.maxHumans) return client.send({ t: 'error', msg: 'That game is full' });
        lobby.clients.add(client);
        client.lobby = lobby;
        lobby.broadcastLobby();
        break;
      }
      case 'leave':
        if (client.lobby) client.lobby.removeClient(client);
        client.send({ t: 'left' });
        break;
      case 'settings':
        if (client.lobby && client.lobby.host === client && !client.lobby.inGame) {
          client.lobby.settings = sanitizeSettings(m.settings);
          client.lobby.broadcastLobby();
        }
        break;
      case 'start':
        if (client.lobby && client.lobby.host === client && !client.lobby.inGame) client.lobby.start();
        break;
      case 'chat': {
        const l = client.lobby;
        if (!l) return;
        const text = String(m.text || '').slice(0, 200).trim();
        if (!text) return;
        l.broadcast({ t: 'chat', from: client.name, text });
        break;
      }
      case 'endGame':
        if (client.lobby && client.lobby.host === client && client.lobby.inGame) client.lobby.endGame();
        break;
      default:
        if (client.lobby) client.lobby.handleIntent(client, m);
    }
  });
  ws.on('close', () => {
    if (!client || client.ws !== ws) return;
    client.ws = null;
    if (client.player) client.player.disconnected = true;
    if (client.lobby) client.lobby.broadcastLobby();
  });
});

// Drop clients that have been gone for a long time.
setInterval(() => {
  const now = Date.now();
  for (const [token, c] of clients) {
    if (!c.ws && now - c.lastSeen > 10 * 60 * 1000) {
      if (c.lobby) c.lobby.removeClient(c);
      clients.delete(token);
    }
  }
}, 60 * 1000);

function lanAddresses() {
  const out = [];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

server.listen(PORT, () => {
  console.log(`OpenFront-lite server running:`);
  console.log(`  local:  http://localhost:${PORT}`);
  for (const a of lanAddresses()) console.log(`  LAN:    http://${a}:${PORT}`);
});
