'use strict';
// HTTP static file server + WebSocket lobby/game server.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const { Game } = require('./game/game');
const maps = require('./game/maps');
const { NationAI, BotAI } = require('./game/ai');
const { sanitizeSettings, PlayerType, TICKS_PER_SECOND } = require('./game/config');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// Messages a single client may send: a sustained rate and a short burst. Far above anything a human does
// (the client sends a focus update every 400ms plus clicks), low enough that a broken or hostile client
// can't starve the tick loop for everyone else.
const RATE_PER_SEC = 40;
const RATE_BURST = 120;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.json': 'application/json',
};

// ---- HTTP ------------------------------------------------------------------
const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (urlPath.startsWith('/flags/')) return serveFlag(urlPath.slice(7), res);
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

// Country flags for nations (OpenFront assets, CC BY-SA 4.0) - fetched once and cached on disk.
const FLAG_DIR = path.join(__dirname, 'maps-cache', 'flags');
function serveFlag(name, res) {
  if (!/^[A-Za-z0-9_-]{1,32}\.svg$/.test(name)) { res.writeHead(404); return res.end(); }
  const file = path.join(FLAG_DIR, name);
  const send = (data) => { res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }); res.end(data); };
  fs.readFile(file, (err, data) => {
    if (!err) return send(data);
    fetch(`https://raw.githubusercontent.com/openfrontio/OpenFrontIO/${maps.ASSET_COMMIT}/resources/flags/${name}`)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((buf) => { const b = Buffer.from(buf); fs.mkdirSync(FLAG_DIR, { recursive: true }); fs.writeFile(file, b, () => {}); send(b); })
      .catch(() => { res.writeHead(404); res.end(); });
  });
}

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
    // token bucket: a client that floods us gets its excess dropped instead of lagging everyone's ticks
    this.tokens = RATE_BURST;
    this.tokensAt = Date.now();
    this.warnedAt = 0;
  }
  allow() {
    const now = Date.now();
    this.tokens = Math.min(RATE_BURST, this.tokens + ((now - this.tokensAt) / 1000) * RATE_PER_SEC);
    this.tokensAt = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    if (now - this.warnedAt > 5000) { this.warnedAt = now; this.send({ t: 'toast', msg: 'Slow down — too many actions per second' }); }
    return false;
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
    this.paused = false;
    this.starting = false;
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
      starting: this.starting,
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

  async start() {
    if (this.game || this.starting) return;
    this.starting = true;
    this.broadcastLobby();
    const s = this.settings;
    const seed = s.seed || crypto.randomInt(1, 2147483647);
    let map;
    try {
      map = await maps.loadMap(s.map, { compact: s.mapSize === 'compact', seed });
    } catch (e) {
      console.error(`[${this.code}] map load failed`, e);
      this.starting = false;
      this.broadcast({ t: 'error', msg: `Could not load map "${s.map}": ${e.message}` });
      this.broadcastLobby();
      return;
    }
    if (this.clients.size === 0) { this.starting = false; return; }
    const game = new Game({ ...s, seed }, map);
    for (const c of this.clients) {
      c.player = game.addPlayer({ id: c.id, name: c.name, type: PlayerType.HUMAN });
    }
    game.addAIPlayers(NationAI, BotAI);
    this.game = game;
    this.starting = false;
    this.paused = false;
    for (const c of this.clients) c.send(this.startPayload(c));
    this.timer = setInterval(() => this.loop(), 1000 / TICKS_PER_SECOND);
    console.log(`[${this.code}] game started: ${map.id} ${map.width}x${map.height} seed=${seed} humans=${this.clients.size} nations=${s.nations} bots=${s.bots}`);
  }
  ctl() { return { t: 'ctl', paused: this.paused, speed: this.settings.gameSpeed }; }

  loop() {
    try { this.loopInner(); } catch (e) { console.error(`[${this.code}] loop error`, e); }
  }
  loopInner() {
    const game = this.game;
    if (!game || this.paused) return;
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

  // Most of a tick is the same for everyone and is serialised once. The parts that differ per player -
  // events addressed to them, submarines and mines they are allowed to see, their own research offer -
  // are appended per client. Nothing private ever goes into the shared part.
  sendTick(pkt) {
    const g = this.game;
    const events = pkt.events || [];
    const shipsDue = pkt.ships === true;
    const unitsDue = !!pkt.units;
    const shared = { ...pkt };
    delete shared.events; delete shared.ships; delete shared.units;
    const body = JSON.stringify(shared);
    const head = body.slice(0, -1);                    // '{...' without the closing brace
    const publicEvents = events.filter((e) => !e.to);
    const publicJson = publicEvents.length ? JSON.stringify(publicEvents) : null;
    const hasPrivate = publicEvents.length !== events.length;
    const privateInfo = pkt.stats !== undefined;     // refresh private state alongside the stats cadence
    for (const c of this.clients) {
      if (!c.ws || c.ws.readyState !== 1) continue;
      let s = head;
      if (hasPrivate) {
        const mine = events.filter((e) => !e.to || e.to === c.id);
        if (mine.length) s += ',"events":' + JSON.stringify(mine);
      } else if (publicJson) s += ',"events":' + publicJson;
      if (shipsDue) s += ',"ships":' + JSON.stringify(g.shipsPacket(c.player));
      if (unitsDue) s += ',"units":' + JSON.stringify(g.unitsPacket(c.player));
      if (privateInfo && c.player) s += ',"me":' + JSON.stringify(g.privatePacket(c.player));
      s += '}';
      try { c.ws.send(s); } catch (_) { /* ignore */ }
    }
  }
  startPayload(c) {
    const g = this.game;
    const state = g.fullState(c.player);
    return { t: 'start', code: this.code, you: c.player.smallID, state, me: g.privatePacket(c.player), ctl: this.ctl() };
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
    if (this.host === c) this.host = [...this.clients].find((x) => x.ws && x.ws.readyState === 1) || [...this.clients][0];
    this.broadcastLobby();
  }
  // A host who drops mid-game would leave nobody able to pause, change speed or end it.
  // Hand host to someone still connected; if the old host comes back they play on as a normal player.
  hostWentAway(c) {
    if (this.host !== c) return;
    const next = [...this.clients].find((x) => x !== c && x.ws && x.ws.readyState === 1);
    if (!next) return;
    this.host = next;
    this.broadcast({ t: 'toast', msg: `${next.name} is now the host`, info: true });
    this.broadcastLobby();
    if (this.inGame) this.broadcast(this.ctl());
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
        // Walk if we can, sail only if we must. Sharing a landmass is the test: standing on the same
        // continent as the tile you clicked means an attack can reach it on foot, even when our border
        // does not touch it yet. The old test asked whether we bordered them *anywhere*, so clicking
        // across your own continent put troops on a boat.
        const { players } = g.neighborsOf(p);
        const bordersTarget = target ? players.includes(target) : g.neighborsOf(p).touchesNeutral;
        const borders = bordersTarget || g.onSameLandmass(p, tile);
        if (borders) {
          const troops = g.config.attackAmount(p, ratio);
          if (!g.sendAttack(p, target, troops, null, Number.isInteger(m.focus) ? m.focus : -1)) c.send({ t: 'toast', msg: 'Cannot attack' });
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
      case 'attackPlayer': {
        // attack a player by id: by land if we border them, otherwise by boat to their nearest coast
        const o = g.playersBySmall[Number(m.p)];
        if (!o || o === p || !p.alive || !o.alive || p.isFriendly(o)) return;
        const troops = g.config.attackAmount(p, ratio);
        if (g.neighborsOf(p).players.includes(o)) { if (!g.sendAttack(p, o, troops)) c.send({ t: 'toast', msg: 'Cannot attack' }); }
        else {
          let sent = false;
          for (const t of o.border) { if (g.isShore(t) && g.sendBoat(p, t, troops)) { sent = true; break; } }
          if (!sent) c.send({ t: 'toast', msg: `No way to reach ${o.name}` });
        }
        break;
      }
      case 'build': {
        if (tile === null) return;
        const unit = String(m.unit);
        let r;
        if (unit === 'mech') r = g.buildMech(p, tile, Number.isInteger(m.from) ? m.from : -1);
        else if (unit === 'warship') r = g.buildWarship(p, tile);
        else if (unit === 'submarine') r = g.buildSub(p, tile);
        else if (unit === 'bomber') r = g.launchBomber(p, tile);
        else r = g.build(p, unit, tile);
        if (!r.ok) c.send({ t: 'toast', msg: r.reason });
        break;
      }
      case 'moveMech': { const r = g.moveMech(p, Number(m.id), tile); if (!r.ok) c.send({ t: 'toast', msg: r.reason }); break; }
      case 'moveShip': { const r = g.moveShip(p, Number(m.id), tile); if (!r.ok) c.send({ t: 'toast', msg: r.reason }); break; }
      case 'airship': {
        if (tile === null) return;
        const r = g.launchAirship(p, tile);
        if (!r.ok) c.send({ t: 'toast', msg: r.reason });
        break;
      }
      case 'inspect': {
        const q = { kind: String(m.kind || ''), id: Number(m.id) || 0, tile: tile ?? -1 };
        c.send({ t: 'inspect', q, info: g.inspect(p, q) });
        break;
      }
      case 'refit': {
        const r = g.refitUnit(p, String(m.kind || ''), Number(m.id) || 0);
        c.send({ t: 'toast', msg: r.ok ? (r.cancelled ? 'Refit cancelled' : 'Heading home for a refit') : r.reason, info: r.ok });
        break;
      }
      case 'recall': {
        if (tile === null) return;
        const r = g.recallForRefit(p, tile);
        c.send({ t: 'toast', msg: r.ok ? `${r.count} unit${r.count > 1 ? 's' : ''} recalled for refit` : r.reason, info: r.ok });
        break;
      }
      case 'mechMode': {
        const r = g.setMechMode(p, Number(m.id) || 0, String(m.mode), Number(m.target) || 0);
        if (!r.ok) c.send({ t: 'toast', msg: r.reason });
        else c.send({ t: 'toast', msg: `${r.count} mech${r.count > 1 ? 's' : ''} set to ${r.mode}${r.target ? ' ' + (g.playersBySmall[r.target] || {}).name : ''}`, info: true });
        break;
      }
      case 'reinforce': { if (tile === null) return; const r = g.reinforcePost(p, tile); if (!r.ok) c.send({ t: 'toast', msg: r.reason }); else c.send({ t: 'toast', msg: `Garrisoned ${r.added.toLocaleString()} troops`, info: true }); break; }
      case 'focus': { if (tile !== null) g.setFocus(p, tile); break; }
      case 'wall': {
        // a drawn polyline of waypoints; the server expands it to 3-thick blocks with coast snapping
        const tiles = Array.isArray(m.tiles) ? m.tiles.slice(0, 200).map(Number) : [];
        const r = g.buildWall(p, tiles);
        if (!r.ok) c.send({ t: 'toast', msg: r.reason });
        break;
      }
      case 'wallQuote': {
        const tiles = Array.isArray(m.tiles) ? m.tiles.slice(0, 200).map(Number) : [];
        const r = g.planWall(p, tiles);
        c.send({ t: 'wallQuote', ok: r.ok, cost: r.ok ? r.cost : 0, reason: r.reason || '', tiles: r.ok ? r.tiles : [], afford: r.ok ? p.gold >= r.cost : false });
        break;
      }
      case 'research': {
        const r = g.pickResearch(p, String(m.id));
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
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024, perMessageDeflate: { threshold: 8192 } });

wss.on('connection', (ws) => {
  let client = null;
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch (_) { return; }
    if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return;
    if (client && !client.allow()) return;
    try { onMessage(m); } catch (e) {
      // A throw here would be an uncaught exception in an event handler, which takes the whole process -
      // every lobby on the server - down with it. Log it and carry on.
      console.error('message error', m && m.t, e);
    }
  });
  const onMessage = (m) => {

    if (m.t === 'hello') {
      const token = typeof m.token === 'string' && m.token.length >= 8 && m.token.length <= 64 ? m.token : crypto.randomBytes(16).toString('hex');
      client = clients.get(token);
      if (!client) { client = new Client(token); clients.set(token, client); }
      if (client.ws && client.ws !== ws) { try { client.ws.close(); } catch (_) { /* */ } }
      client.ws = ws;
      client.lastSeen = Date.now();
      if (typeof m.name === 'string' && m.name.trim()) client.name = m.name.trim().slice(0, 20);
      client.send({ t: 'welcome', token, id: client.id, name: client.name, lan: lanAddresses(), port: PORT, maps: maps.catalog() });
      // reconnect into an ongoing lobby/game
      if (client.lobby) {
        const l = client.lobby;
        if (l.game && client.player) {
          client.player.disconnected = false;
          client.send({ t: 'lobby', lobby: l.summary() });
          client.send(l.startPayload(client));
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
        const lobby = new Lobby(client, sanitizeSettings(m.settings, maps.isValidMapId));
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
          client.lobby.settings = sanitizeSettings(m.settings, maps.isValidMapId);
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
      case 'pause':
        if (client.lobby && client.lobby.host === client && client.lobby.inGame) {
          client.lobby.paused = !!m.on;
          client.lobby.broadcast(client.lobby.ctl());
        }
        break;
      case 'speed':
        if (client.lobby && client.lobby.host === client && client.lobby.inGame) {
          const v = Number(m.v);
          if ([0.5, 1, 1.5, 2, 3].includes(v)) { client.lobby.settings.gameSpeed = v; client.lobby.broadcast(client.lobby.ctl()); }
        }
        break;
      default:
        if (client.lobby) client.lobby.handleIntent(client, m);
    }
  };
  ws.on('close', () => {
    if (!client || client.ws !== ws) return;
    client.ws = null;
    if (client.player) client.player.disconnected = true;
    if (client.lobby) { client.lobby.hostWentAway(client); client.lobby.broadcastLobby(); }
  });
  ws.on('error', () => { /* the close handler does the bookkeeping */ });
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
  console.log(`War World server running:`);
  console.log(`  local:  http://localhost:${PORT}`);
  for (const a of lanAddresses()) console.log(`  LAN:    http://${a}:${PORT}`);
});
