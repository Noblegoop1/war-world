(() => {
'use strict';
const $ = (id) => document.getElementById(id);

// =============================================================================
// Utilities
// =============================================================================
function fmt(n) {
  n = Math.floor(n || 0);
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(abs >= 1e7 ? 1 : 2) + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(abs >= 1e4 ? 0 : 1) + 'K';
  return String(n);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHex([r, g, b]) { return '#' + [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join(''); }
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0); else if (max === g) h = (b - r) / d + 2; else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
function darken(rgb, amount) { const hsl = rgbToHsl(rgb); hsl[2] = Math.max(0, hsl[2] - amount); return hslToRgb(hsl).map(Math.round); }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(msg, info = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (info ? ' info' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

// =============================================================================
// Assets (OpenFront icons/sprites, CC BY-SA 4.0)
// =============================================================================
const ICON_FILES = {
  city: 'CityIconWhite', port: 'AnchorIcon', defense: 'ShieldIconWhite', silo: 'MissileSiloIconWhite', sam: 'SamLauncherIconWhite',
  atom: 'NukeIconWhite', hydrogen: 'MushroomCloudIconWhite', sword: 'SwordIconWhite', boat: 'BoatIconWhite', ally: 'AllianceIconWhite',
  allyReq: 'AllianceRequestWhiteIcon', traitor: 'TraitorIconWhite', donateGold: 'DonateGoldIconWhite', donateTroop: 'DonateTroopIconWhite',
  build: 'BuildIconWhite', info: 'InfoIconSolidWhite', crown: 'CrownIcon', target: 'TargetIconWhite', troops: 'TroopIconWhite', x: 'XIcon',
  trade: 'TradeShipIconWhite', population: 'PopulationIconSolidWhite', explosion: 'ExplosionIconWhite', disconnected: 'DisconnectedIcon', back: 'XIcon',
};
const SPRITE_FILES = { transport: 'transportship', warship: 'warship', trade: 'tradeship', atom: 'atombomb', hydrogen: 'hydrogenbomb', samMissile: 'samMissile' };
const icons = {};     // name -> white silhouette canvas (64x64)
const iconURL = {};   // name -> data URL for <img>
const sprites = {};   // name -> Image
const spriteCache = new Map();
function loadAssets() {
  const tasks = [];
  for (const [name, file] of Object.entries(ICON_FILES)) {
    tasks.push(new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas'); c.width = 64; c.height = 64;
        const x = c.getContext('2d');
        x.drawImage(im, 0, 0, 64, 64);
        if (name !== 'crown') { x.globalCompositeOperation = 'source-in'; x.fillStyle = '#fff'; x.fillRect(0, 0, 64, 64); }
        icons[name] = c;
        iconURL[name] = c.toDataURL();
        resolve();
      };
      im.onerror = () => resolve();
      im.src = `/assets/icons/${file}.svg`;
    }));
  }
  for (const [name, file] of Object.entries(SPRITE_FILES)) {
    tasks.push(new Promise((resolve) => {
      const im = new Image();
      im.onload = () => { sprites[name] = im; resolve(); };
      im.onerror = () => resolve();
      im.src = `/assets/sprites/${file}.png`;
    }));
  }
  return Promise.all(tasks);
}
// Colorize a sprite the OpenFront way: grey 180 -> territory color, 70 -> border color, 130 -> highlight.
function coloredSprite(name, colorHex, borderHex) {
  const key = `${name}|${colorHex}`;
  let c = spriteCache.get(key);
  if (c) return c;
  const im = sprites[name];
  if (!im) return null;
  c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
  const x = c.getContext('2d');
  x.drawImage(im, 0, 0);
  const d = x.getImageData(0, 0, c.width, c.height);
  const a = hexToRgb(colorHex), b = hexToRgb(borderHex), h = [255, 213, 79];
  for (let i = 0; i < d.data.length; i += 4) {
    const r = d.data[i], g = d.data[i + 1], bl = d.data[i + 2];
    let t = null;
    if (r === 180 && g === 180 && bl === 180) t = a; else if (r === 70 && g === 70 && bl === 70) t = b; else if (r === 130 && g === 130 && bl === 130) t = h;
    if (t) { d.data[i] = t[0]; d.data[i + 1] = t[1]; d.data[i + 2] = t[2]; }
  }
  x.putImageData(d, 0, 0);
  spriteCache.set(key, c);
  return c;
}

const UNIT_INFO = {
  city: { label: 'City', key: '1', desc: '+250K max troops. Build on it again to upgrade.', cost: (n) => Math.min(1e6, Math.pow(2, n) * 125000) },
  port: { label: 'Port', key: '2', desc: 'Sea coast only. Sends trade ships to other players\' ports for gold (both sides earn).', cost: (n) => Math.min(1e6, Math.pow(2, n) * 125000) },
  defense: { label: 'Defense Post', key: '3', desc: 'Attackers within 30 tiles lose 5x troops and advance 3x slower.', cost: (n) => Math.min(250000, (n + 1) * 50000) },
  silo: { label: 'Missile Silo', key: '4', desc: 'Launches atom and hydrogen bombs (90 tick reload).', cost: () => 1000000 },
  sam: { label: 'SAM Launcher', key: '5', desc: 'Shoots down nukes within 70 tiles.', cost: (n) => Math.min(3e6, (n + 1) * 1500000) },
};
const NUKE_INFO = {
  atom: { label: 'Atom Bomb', key: '6', desc: 'Destroys everything within 12 tiles, most within 30. Needs a ready silo.', cost: 750000 },
  hydrogen: { label: 'Hydrogen Bomb', key: '7', desc: 'Destroys everything within 80 tiles, most within 100. Needs a ready silo.', cost: 5000000 },
};
const HOTBAR = ['city', 'port', 'defense', 'silo', 'sam', 'atom', 'hydrogen'];

// =============================================================================
// Networking
// =============================================================================
const net = {
  ws: null,
  token: sessionStorage.getItem('fr_token') || '',
  name: localStorage.getItem('fr_name') || '',
  id: null, connected: false, pendingJoin: null, maps: [],
};
function send(obj) { if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(obj)); }
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  net.ws = ws;
  ws.onopen = () => { net.connected = true; send({ t: 'hello', token: net.token, name: net.name || undefined }); };
  ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch (_) { return; } handleMessage(m); };
  ws.onclose = () => { net.connected = false; $('menu-status').textContent = 'Disconnected from server, reconnecting…'; setTimeout(connect, 2000); };
}
function handleMessage(m) {
  switch (m.t) {
    case 'welcome':
      net.token = m.token; sessionStorage.setItem('fr_token', m.token);
      net.id = m.id;
      if (!net.name) net.name = m.name;
      net.maps = m.maps || [];
      fillMapSelect();
      $('name-input').value = net.name;
      $('menu-status').textContent = m.lan && m.lan.length ? `Friends on your network can join at http://${m.lan[0]}:${m.port}` : '';
      if (net.pendingJoin) { send({ t: 'join', code: net.pendingJoin }); net.pendingJoin = null; }
      else if (screen === 'menu') send({ t: 'list' });
      break;
    case 'lobbies': renderPublicList(m.lobbies); break;
    case 'lobby': lobby = m.lobby; if (screen !== 'game') show('lobby'); renderLobby(); break;
    case 'left': lobby = null; G.active = false; show('menu'); send({ t: 'list' }); break;
    case 'error': toast(m.msg); $('menu-status').textContent = m.msg; $('loading').classList.add('hidden'); break;
    case 'toast': toast(m.msg); break;
    case 'chat': addChat(m.from, m.text); break;
    case 'start': startGame(m); break;
    case 'tick': applyTick(m); break;
    case 'ctl': G.ctl = { paused: m.paused, speed: m.speed }; renderTopRight(); break;
    case 'ended': G.active = false; show('lobby'); if (lobby) renderLobby(); break;
    default: break;
  }
}

// =============================================================================
// Screens: menu + lobby
// =============================================================================
let screen = 'menu';
let lobby = null;
function show(name) {
  screen = name;
  for (const s of ['menu', 'lobby', 'game']) $('screen-' + s).classList.toggle('hidden', s !== name);
  if (name === 'game') resizeCanvas();
}
function saveName() {
  const v = $('name-input').value.trim().slice(0, 20);
  if (v && v !== net.name) { net.name = v; localStorage.setItem('fr_name', v); send({ t: 'setName', name: v }); }
}
$('name-input').addEventListener('change', saveName);
$('btn-create').onclick = () => { saveName(); send({ t: 'create', settings: { name: `${net.name || 'Player'}'s game` } }); };
$('btn-join').onclick = () => { saveName(); const code = $('join-code').value.trim().toUpperCase(); if (code) send({ t: 'join', code }); };
$('join-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-join').click(); });
$('btn-refresh').onclick = () => send({ t: 'list' });
function renderPublicList(list) {
  const el = $('public-list');
  if (!list || !list.length) { el.innerHTML = '<div class="muted">No public games right now.</div>'; return; }
  el.innerHTML = list.map((l) => `<div class="item"><span><b>${esc(l.name)}</b> <span class="muted">by ${esc(l.host)} · ${l.players}/${l.max}</span></span><button class="small" data-code="${l.code}">Join</button></div>`).join('');
  el.querySelectorAll('button').forEach((b) => { b.onclick = () => { saveName(); send({ t: 'join', code: b.dataset.code }); }; });
}
const settingsForm = $('settings-form');
function fillMapSelect() {
  const sel = settingsForm.elements.map;
  const cur = sel.value;
  sel.innerHTML = net.maps.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
  if (cur) sel.value = cur;
}
let settingsTimer = null;
function isHost() { return !!(lobby && lobby.players.some((p) => p.id === net.id && p.host)); }
function renderLobby() {
  if (!lobby) return;
  $('lobby-name').textContent = lobby.name;
  $('lobby-code').textContent = lobby.code;
  $('lobby-count').textContent = `(${lobby.players.length}/${lobby.settings.maxHumans})`;
  $('lobby-player-list').innerHTML = lobby.players.map((p) => `<li><span>${esc(p.name)}${p.id === net.id ? ' (you)' : ''}</span><span class="muted">${p.host ? '👑 host' : ''}${p.online ? '' : ' · offline'}</span></li>`).join('');
  const host = isHost();
  $('btn-start').classList.toggle('hidden', !host);
  $('btn-start').disabled = !!lobby.starting;
  $('btn-start').textContent = lobby.starting ? 'Loading map…' : 'Start game';
  settingsForm.classList.toggle('readonly', !host);
  $('settings-note').textContent = host ? '' : '(only the host can change these)';
  if (document.activeElement && settingsForm.contains(document.activeElement)) return;
  for (const [k, v] of Object.entries(lobby.settings)) {
    const input = settingsForm.elements[k];
    if (!input) continue;
    if (input.type === 'checkbox') input.checked = !!v; else input.value = v;
  }
}
settingsForm.addEventListener('input', () => {
  if (!isHost()) return;
  clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => {
    const s = {};
    for (const el of settingsForm.elements) { if (!el.name) continue; s[el.name] = el.type === 'checkbox' ? el.checked : el.value; }
    send({ t: 'settings', settings: s });
  }, 300);
});
$('btn-start').onclick = () => send({ t: 'start' });
$('btn-leave').onclick = () => send({ t: 'leave' });
$('btn-copy').onclick = () => {
  const url = `${location.origin}/g/${lobby.code}`;
  navigator.clipboard?.writeText(url).then(() => toast('Invite link copied: ' + url, true), () => prompt('Invite link', url));
};
function addChat(from, text) {
  const log = $('lobby-chat-log');
  const d = document.createElement('div');
  d.innerHTML = `<b>${esc(from)}:</b> ${esc(text)}`;
  log.appendChild(d); log.scrollTop = log.scrollHeight;
  while (log.children.length > 80) log.firstChild.remove();
  if (G.active) logEvent(`<b>${esc(from)}:</b> ${esc(text)}`, 'chat');
}
$('lobby-chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.value.trim()) { send({ t: 'chat', text: e.target.value }); e.target.value = ''; } });

// =============================================================================
// Game state
// =============================================================================
const G = {
  active: false, W: 0, H: 0, numLand: 1, terrain: null, owner: null, fallout: null,
  players: new Map(), me: 0, tick: 0, phase: 'spawn', spawnLeft: 0, settings: null, mapName: '',
  units: [], attacks: [], boats: [], trade: [], nukes: [], allyReqs: [], effects: [], winner: 0,
  labels: new Map(), lastLabelTick: -100, ctl: { paused: false, speed: 1 }, unitByTile: new Map(),
};
const cam = { x: 0, y: 0, zoom: 1 };
const opts = { labels: true, structures: true, events: true };
window.__debug = { G, cam, net, get lobby() { return lobby; } };
const canvas = $('game-canvas');
const ctx = canvas.getContext('2d');
let terrainCanvas = null, ownerCanvas = null, ownerCtx = null, ownerImg = null, ownerDirty = false;
let ratio = 0.2;
let placement = null; // {kind:'build', unit} | {kind:'nuke', type}
let hoverTile = -1;
let pinnedCard = 0; // smallID pinned in the player card
let spectating = false;

function me() { return G.players.get(G.me); }
function pname(sm) { const p = G.players.get(sm); return p ? p.name : (sm === 0 ? 'Unclaimed land' : '?'); }
// Only 2-letter country codes exist as flags; US-state names (Texas, Alaska) don't.
function flagBadge(q) {
  const swatch = `<span class=&quot;swatch&quot; style=&quot;background:${q.color}&quot;></span>`;
  if (q.flag) return `<img class="flag" src="/flags/${esc(q.flag)}.svg" alt="" onerror="this.outerHTML='${swatch}'">`;
  return `<span class="swatch" style="background:${q.color}"></span>`;
}
function tileX(i) { return i % G.W; }
function tileY(i) { return (i / G.W) | 0; }
function isLand(i) { const t = G.terrain[i]; return (t & 0x80) !== 0 && (t & 0x1f) !== 31; }
function isWater(i) { return (G.terrain[i] & 0x80) === 0; }

function startGame(m) {
  const s = m.state;
  G.active = true;
  G.W = s.width; G.H = s.height; G.numLand = s.numLand; G.mapName = s.mapName || '';
  G.terrain = b64ToBytes(s.terrain);
  const ob = b64ToBytes(s.owner);
  G.owner = new Uint16Array(ob.buffer, ob.byteOffset, ob.byteLength / 2);
  G.fallout = b64ToBytes(s.fallout);
  G.me = m.you;
  G.tick = s.tick; G.phase = s.phase; G.spawnLeft = Math.max(0, s.spawnTicks - s.tick);
  G.settings = s.settings;
  G.ctl = m.ctl || { paused: false, speed: s.settings.gameSpeed };
  G.players = new Map();
  for (const p of s.players) {
    const rgb = hexToRgb(p.color);
    const border = darken(rgb, 0.125);
    G.players.set(p.sm, { ...p, rgb, border, borderHex: rgbToHex(border), troops: 0, gold: 0, tiles: 0, flags: 0, maxTroops: 0, allies: [], income: 0 });
  }
  applyStats(s.stats);
  setUnits(s.units || []);
  G.attacks = []; G.boats = []; G.trade = []; G.nukes = []; G.allyReqs = []; G.effects = [];
  G.winner = s.winner || 0;
  G.labels = new Map(); G.lastLabelTick = -100;
  spectating = false; placement = null; pinnedCard = 0;
  $('spectate-banner').classList.add('hidden');
  $('player-card').classList.add('hidden');
  allyReqEls.clear();
  $('event-log').innerHTML = '';
  $('game-over').classList.add('hidden');
  $('loading').classList.add('hidden');
  buildTerrainCanvas();
  ownerCanvas = document.createElement('canvas'); ownerCanvas.width = G.W; ownerCanvas.height = G.H;
  ownerCtx = ownerCanvas.getContext('2d');
  ownerImg = ownerCtx.createImageData(G.W, G.H);
  for (let i = 0; i < G.W * G.H; i++) if (G.owner[i] || G.fallout[i]) paintTile(i);
  ownerDirty = true;
  show('game');
  needFit = true;
  renderHotbar(); renderHud(); renderTopRight(); renderBanner();
  logEvent(G.phase === 'spawn' ? 'Click on land to choose where you start.' : 'Reconnected to the game.', 'good');
}

// Terrain colors exactly as OpenFront's TerrainPass (render-settings defaults).
function buildTerrainCanvas() {
  terrainCanvas = document.createElement('canvas');
  terrainCanvas.width = G.W; terrainCanvas.height = G.H;
  const c = terrainCanvas.getContext('2d');
  const img = c.createImageData(G.W, G.H);
  const d = img.data;
  const T = G.terrain;
  const ocean = [71, 133, 181], sand = [204, 203, 158], plains = [190, 220, 138], highland = [220, 203, 158], mountain = [230, 230, 230], bgc = [60, 60, 60];
  for (let i = 0; i < T.length; i++) {
    const tb = T[i];
    const land = (tb & 0x80) !== 0, shore = (tb & 0x40) !== 0, mag = tb & 0x1f;
    let r, g, b;
    if (land && mag === 31) { [r, g, b] = bgc; }
    else if (land && shore) { [r, g, b] = sand; }
    else if (land) {
      if (mag < 10) { r = plains[0]; g = plains[1] - 2 * mag; b = plains[2]; }
      else if (mag < 20) { const m = mag - 10; r = Math.min(255, highland[0] + 2 * m); g = Math.min(255, highland[1] + 2 * m); b = Math.min(255, highland[2] + 2 * m); }
      else { const m = Math.floor(mag / 2); r = Math.min(255, mountain[0] + m); g = Math.min(255, mountain[1] + m); b = Math.min(255, mountain[2] + m); }
    } else if (shore) { r = Math.round(0.7 * ocean[0] + 76.5); g = Math.round(0.7 * ocean[1] + 76.5); b = Math.round(0.7 * ocean[2] + 76.5); }
    else { const m = Math.min(mag, 10); r = Math.max(0, ocean[0] - m); g = Math.max(0, ocean[1] - m); b = Math.max(0, ocean[2] - m); }
    const k = i * 4;
    d[k] = r; d[k + 1] = g; d[k + 2] = b; d[k + 3] = 255;
  }
  c.putImageData(img, 0, 0);
}
function isBorder(i) {
  const o = G.owner[i], W = G.W, x = i % W, y = (i / W) | 0;
  if (x === 0 || y === 0 || x === W - 1 || y === G.H - 1) return true;
  return G.owner[i - 1] !== o || G.owner[i + 1] !== o || G.owner[i - W] !== o || G.owner[i + W] !== o;
}
function paintTile(i) {
  const d = ownerImg.data, k = i * 4;
  const o = G.owner[i];
  if (o === 0) {
    if (G.fallout[i]) { d[k] = 96; d[k + 1] = 86; d[k + 2] = 106; d[k + 3] = 185; } else d[k + 3] = 0;
    return;
  }
  const p = G.players.get(o);
  if (!p) { d[k + 3] = 0; return; }
  if (isBorder(i)) { d[k] = p.border[0]; d[k + 1] = p.border[1]; d[k + 2] = p.border[2]; d[k + 3] = 255; }
  else { d[k] = p.rgb[0]; d[k + 1] = p.rgb[1]; d[k + 2] = p.rgb[2]; d[k + 3] = 150; }
}
function setTile(i, val) {
  G.owner[i] = val & 0x7fff;
  G.fallout[i] = val & 0x8000 ? 1 : 0;
  const W = G.W, x = i % W, y = (i / W) | 0;
  paintTile(i);
  if (x > 0) paintTile(i - 1);
  if (x < W - 1) paintTile(i + 1);
  if (y > 0) paintTile(i - W);
  if (y < G.H - 1) paintTile(i + W);
  ownerDirty = true;
}
function applyStats(stats) {
  if (!stats) return;
  for (const s of stats) {
    const p = G.players.get(s[0]);
    if (!p) continue;
    p.troops = s[1]; p.gold = s[2]; p.tiles = s[3]; p.flags = s[4]; p.maxTroops = s[5]; p.allies = s[6] || []; p.income = s[7] || 0;
    p.spawned = !!(s[4] & 1); p.alive = !!(s[4] & 2); p.traitor = !!(s[4] & 4); p.offline = !!(s[4] & 8);
  }
}
function setUnits(list) {
  G.units = list;
  G.unitByTile = new Map();
  for (const u of list) G.unitByTile.set(u[3], u);
}
function applyTick(m) {
  if (!G.active) return;
  G.tick = m.tick;
  const prevPhase = G.phase;
  G.phase = m.phase;
  if (m.spawnLeft !== undefined) G.spawnLeft = m.spawnLeft;
  if (m.tiles) for (let i = 0; i < m.tiles.length; i += 2) setTile(m.tiles[i], m.tiles[i + 1]);
  if (m.stats) applyStats(m.stats);
  if (m.attacks) G.attacks = m.attacks;
  if (m.units) setUnits(m.units);
  if (m.boats) G.boats = m.boats;
  if (m.trade) G.trade = m.trade;
  if (m.nukes) G.nukes = m.nukes;
  if (m.allyReqs) syncAllyRequests(m.allyReqs.filter((r) => r[1] === net.id).map((r) => r[0]));
  if (m.events) for (const e of m.events) handleEvent(e);
  if (m.winner !== undefined) G.winner = m.winner;
  if (prevPhase !== 'over' && G.phase === 'over') showGameOver();
  if (prevPhase === 'spawn' && G.phase === 'play') renderBanner();
  if (m.stats || m.attacks) renderHud();
  if (G.phase === 'spawn') renderBanner();
}

// =============================================================================
// Events
// =============================================================================
function handleEvent(e) {
  switch (e.k) {
    case 'phase': logEvent('The game has begun. Expand!', 'good'); break;
    case 'attacked': logEvent(`<b>${esc(pname(e.by))}</b> is attacking you with ${fmt(e.troops)} troops`, 'bad'); break;
    case 'conquered': logEvent(`${esc(pname(e.by))} conquered ${esc(pname(e.p))}`, e.p === G.me ? 'bad' : (e.by === G.me ? 'good' : '')); break;
    case 'death': logEvent(`${esc(pname(e.p))} was eliminated${e.by ? ' by ' + esc(pname(e.by)) : ''}`, e.p === G.me ? 'bad' : ''); if (e.p === G.me) { spectating = true; $('spectate-banner').textContent = 'You were eliminated — spectating'; $('spectate-banner').classList.remove('hidden'); } break;
    case 'nuke': logEvent(`☢ ${esc(pname(e.by))} launched a${e.type === 'hydrogen' ? ' hydrogen' : 'n atom'} bomb${e.target ? ' at ' + esc(pname(e.target)) : ''}`, e.target === G.me ? 'bad' : ''); break;
    case 'boom': G.effects.push({ x: e.x, y: e.y, r: e.type === 'hydrogen' ? 100 : 30, t0: performance.now(), dur: 1800 }); break;
    case 'samhit': logEvent(`${esc(pname(e.by))}'s SAM shot down a nuke`, e.by === G.me ? 'good' : ''); G.effects.push({ x: e.x, y: e.y, r: 8, t0: performance.now(), dur: 700 }); break;
    case 'allyRequest': break; // handled by syncAllyRequests
    case 'allyRejected': logEvent(`${esc(pname(e.by))} rejected your alliance request`); break;
    case 'allied': logEvent(`${esc(pname(e.a))} and ${esc(pname(e.b))} are now allies`, (e.a === G.me || e.b === G.me) ? 'good' : ''); break;
    case 'betrayed': logEvent(`${esc(pname(e.by))} betrayed ${esc(pname(e.p))}!`, e.p === G.me ? 'bad' : ''); break;
    case 'donate': logEvent(`${esc(pname(e.from))} sent ${e.troops ? fmt(e.troops) + ' troops' : ''}${e.troops && e.gold ? ' and ' : ''}${e.gold ? fmt(e.gold) + ' gold' : ''} to ${esc(pname(e.to))}`, e.to === G.me ? 'good' : ''); break;
    case 'trade': logEvent(`Trade ship arrived: +${fmt(e.gold)} gold (with ${esc(pname(e.p))})`, 'good'); break;
    case 'win': logEvent(`🏆 ${esc(pname(e.p))} won the game!`, e.p === G.me ? 'good' : ''); break;
    default: break;
  }
}
function logEvent(html, cls = '', buttons = null) {
  const log = $('event-log');
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = `<span>${html}</span>`;
  if (buttons) {
    const wrap = document.createElement('span');
    for (const b of buttons) { const btn = document.createElement('button'); btn.textContent = b.label; btn.className = b.cls || ''; btn.onclick = () => { b.onClick(); d.remove(); }; wrap.appendChild(btn); }
    d.appendChild(wrap);
  }
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 40) log.firstChild.remove();
  return d;
}
const allyReqEls = new Map();
function syncAllyRequests(list) {
  for (const sm of list) {
    if (allyReqEls.has(sm)) continue;
    const el = logEvent(`<b>${esc(pname(sm))}</b> requests an alliance`, 'req', [
      { label: 'Accept', cls: 'primary', onClick: () => { send({ t: 'allyReply', p: sm, accept: true }); allyReqEls.delete(sm); } },
      { label: 'Reject', onClick: () => { send({ t: 'allyReply', p: sm, accept: false }); allyReqEls.delete(sm); } },
    ]);
    allyReqEls.set(sm, el);
  }
  for (const [sm, el] of allyReqEls) if (!list.includes(sm)) { el.remove(); allyReqEls.delete(sm); }
}

// =============================================================================
// HUD
// =============================================================================
function renderBanner() {
  const b = $('phase-banner');
  if (G.phase === 'spawn') { b.textContent = `Choose your spawn — click on land · ${Math.ceil(G.spawnLeft / 10)}s`; b.classList.remove('hidden'); }
  else if (G.phase === 'over') { b.textContent = `Game over — ${pname(G.winner)} won`; b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}
function renderTopRight() {
  const host = isHost();
  $('btn-pause').classList.toggle('active', !!G.ctl.paused);
  $('btn-pause').textContent = G.ctl.paused ? '▶' : '⏸';
  $('btn-pause').disabled = !host;
  $('btn-speed').disabled = !host;
  $('btn-speed').textContent = G.ctl.speed === 1 ? '⏩' : `${G.ctl.speed}×`;
  $('host-controls').classList.toggle('hidden', !host);
  $('opt-speed').value = String(G.ctl.speed);
}
function updateTimer() {
  const secs = Math.max(0, Math.floor((G.tick - (G.settings ? G.settings.spawnPhaseSeconds * 10 : 0)) / 10));
  const mm = String(Math.floor(secs / 60)).padStart(2, '0'), ss = String(secs % 60).padStart(2, '0');
  $('game-timer').textContent = (G.ctl.paused ? '⏸ ' : '') + `${mm}:${ss}`;
}
function renderHud() {
  const p = me();
  if (!p) return;
  // control panel
  $('cp-income').textContent = `+${fmt(p.income)}/s`;
  $('cp-troops-text').textContent = `${fmt(p.troops)} / ${fmt(p.maxTroops)}`;
  $('cp-troops-fill').style.width = `${clamp(100 * p.troops / Math.max(1, p.maxTroops), 0, 100)}%`;
  $('cp-gold').textContent = fmt(p.gold);
  $('ratio-label').textContent = `⚔ ${Math.round(ratio * 100)}% (${fmt(p.troops * ratio)})`;
  renderLeaderboard();
  renderAttacks();
  renderHotbar();
  if (pinnedCard) renderPlayerCard(pinnedCard, true);
}
function renderLeaderboard() {
  const p = me();
  const sorted = [...G.players.values()].filter((q) => q.spawned).sort((a, b) => b.tiles - a.tiles);
  G.leaderSm = sorted.length && sorted[0].tiles > 0 ? sorted[0].sm : 0;
  const rows = sorted.slice(0, 10);
  if (p && !rows.includes(p)) rows.push(p);
  $('leaderboard').innerHTML = `<tr><th>#</th><th></th><th>Player</th><th>Land</th><th>Troops</th><th>Gold</th></tr>` + rows.map((q) => {
    const i = sorted.indexOf(q) + 1;
    const badge = flagBadge(q);
    const marks = (p && p.allies.includes(q.sm) ? ' 🤝' : '') + (q.traitor ? ' 🗡' : '') + (q.offline ? ' ⛔' : '');
    return `<tr class="${q === p ? 'me' : ''} ${q.alive ? '' : 'dead'}" data-sm="${q.sm}"><td>${i}</td><td>${badge}</td><td>${esc(q.name)}${marks}</td><td>${(100 * q.tiles / G.numLand).toFixed(1)}%</td><td>${fmt(q.troops)}</td><td>${fmt(q.gold)}</td></tr>`;
  }).join('');
  $('leaderboard').querySelectorAll('tr[data-sm]').forEach((tr) => {
    tr.onclick = () => { const sm = Number(tr.dataset.sm); pinnedCard = sm; renderPlayerCard(sm, true); centerOn(sm); };
  });
}
function renderAttacks() {
  const out = G.attacks.filter((a) => a[1] === G.me);
  const inc = G.attacks.filter((a) => a[2] === G.me);
  const panel = $('attacks-panel');
  if (!out.length && !inc.length) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  panel.innerHTML =
    out.map((a) => `<div><span>⚔ Attacking <b>${esc(pname(a[2]))}</b> · ${fmt(a[3])}</span><button class="small" data-retreat="${a[0]}">Retreat</button></div>`).join('') +
    inc.map((a) => `<div class="in"><span>⚔ <b>${esc(pname(a[1]))}</b> attacks you · ${fmt(a[3])}</span></div>`).join('');
  panel.querySelectorAll('button').forEach((b) => { b.onclick = () => send({ t: 'retreat', id: Number(b.dataset.retreat) }); });
}
function myUnitCount(type) { let n = 0; for (const u of G.units) if (u[1] === type && u[2] === G.me) n++; return n; }
function haveReadySilo() { return G.units.some((u) => u[1] === 'silo' && u[2] === G.me && u[5] === 0 && u[6] === 0); }
function itemCost(key) {
  const infinite = G.settings && G.settings.infiniteGold;
  if (infinite) return 0;
  return UNIT_INFO[key] ? UNIT_INFO[key].cost(myUnitCount(key)) : NUKE_INFO[key].cost;
}
function renderHotbar() {
  const p = me();
  const bar = $('hotbar');
  const nukesOff = G.settings && G.settings.disableNukes;
  const html = HOTBAR.map((key) => {
    if (nukesOff && (key === 'silo' || key === 'sam' || NUKE_INFO[key])) return '';
    const info = UNIT_INFO[key] || NUKE_INFO[key];
    const cost = itemCost(key);
    const can = p && p.gold >= cost && (!NUKE_INFO[key] || haveReadySilo());
    const active = placement && ((placement.kind === 'build' && placement.unit === key) || (placement.kind === 'nuke' && placement.type === key));
    const count = UNIT_INFO[key] ? myUnitCount(key) : '';
    return `<div class="hb ${active ? 'active' : ''} ${can ? '' : 'cant'}" data-key="${key}"><span class="key">${info.key}</span><img src="${iconURL[key] || ''}" alt=""><span class="count">${count}</span></div>`;
  }).join('');
  if (bar.dataset.html !== html) {
    bar.innerHTML = html;
    bar.dataset.html = html;
    bar.querySelectorAll('.hb').forEach((b) => {
      b.onclick = () => togglePlacement(b.dataset.key);
      b.onmouseenter = () => showHotbarTip(b.dataset.key);
      b.onmouseleave = () => $('hotbar-tip').classList.add('hidden');
    });
  }
}
function showHotbarTip(key) {
  const info = UNIT_INFO[key] || NUKE_INFO[key];
  $('hotbar-tip').innerHTML = `<b>${info.label} <span class="muted">[${info.key}]</span></b>${esc(info.desc)}<div class="cost">${fmt(itemCost(key))} gold</div>`;
  $('hotbar-tip').classList.remove('hidden');
}
function togglePlacement(key) {
  const kind = UNIT_INFO[key] ? 'build' : 'nuke';
  if (placement && ((placement.kind === 'build' && placement.unit === key) || (placement.kind === 'nuke' && placement.type === key))) placement = null;
  else placement = kind === 'build' ? { kind, unit: key } : { kind, type: key };
  renderHotbar();
  if (placement) toast(`Click on the map to place ${(UNIT_INFO[key] || NUKE_INFO[key]).label} (Esc to cancel)`, true);
}
$('ratio').addEventListener('input', (e) => { ratio = Number(e.target.value) / 100; renderHud(); });
function setRatio(r) { ratio = clamp(r, 0.01, 1); $('ratio').value = Math.round(ratio * 100); renderHud(); }

// player card (top center)
function playerCardHtml(sm) {
  const q = G.players.get(sm), p = me();
  if (!q) return '';
  const counts = {};
  for (const u of G.units) if (u[2] === sm) counts[u[1]] = (counts[u[1]] || 0) + 1;
  const badge = flagBadge(q);
  const rel = p && p.sm !== sm ? (p.allies.includes(sm) ? ' · <span style="color:#b9f6ca">Ally</span>' : '') : (p && p.sm === sm ? ' · You' : '');
  let html = `<div class="pc-head">${badge}<span>${esc(q.name)}</span><span class="muted" style="font-weight:400;font-size:12px">${q.type === 'nation' ? 'Nation' : q.type === 'bot' ? 'Bot' : 'Player'}${rel}${q.traitor ? ' · <span style="color:#ff9e93">Traitor</span>' : ''}${q.alive ? '' : ' · Eliminated'}</span>${G.leaderSm === sm ? ' 👑' : ''}</div>`;
  html += `<div class="pc-stats"><span>💰 <b>${fmt(q.gold)}</b></span><span>⚔ <b>${fmt(q.troops)}</b> / ${fmt(q.maxTroops)}</span><span>🗺 <b>${(100 * q.tiles / G.numLand).toFixed(1)}%</b> (${fmt(q.tiles)})</span><span>📈 +${fmt(q.income)}/s</span></div>`;
  const uhtml = Object.keys(UNIT_INFO).filter((k) => counts[k]).map((k) => `<span><img src="${iconURL[k] || ''}" alt="">${counts[k]}</span>`).join('');
  if (uhtml) html += `<div class="pc-units">${uhtml}</div>`;
  if (p && p.alive && q.alive && p.sm !== sm) {
    html += `<div class="pc-actions">`;
    if (p.allies.includes(sm)) {
      html += `<button data-act="donateT">Donate 10% troops</button><button data-act="donateG">Donate 10% gold</button><button data-act="break" class="danger">Break alliance</button>`;
    } else html += `<button data-act="ally">🤝 Request alliance</button>`;
    html += `<button data-act="focus">Find</button></div>`;
  }
  return html;
}
function renderPlayerCard(sm, pinned) {
  const card = $('player-card');
  if (!sm || !G.players.has(sm)) { card.classList.add('hidden'); return; }
  card.innerHTML = playerCardHtml(sm) + (pinned ? `<button class="icon-btn" data-act="close" style="position:absolute;top:2px;right:4px">✕</button>` : '');
  card.style.position = 'relative';
  card.classList.remove('hidden');
  card.querySelectorAll('button[data-act]').forEach((b) => { b.onclick = () => { playerAction(sm, b.dataset.act); }; });
}
function playerAction(sm, act) {
  const p = me();
  switch (act) {
    case 'ally': send({ t: 'ally', p: sm }); toast('Alliance request sent', true); break;
    case 'break': if (confirm(`Break the alliance with ${pname(sm)}? You will be marked as a traitor for 30s.`)) send({ t: 'breakAlly', p: sm }); break;
    case 'donateT': send({ t: 'donate', p: sm, troops: Math.floor(p.troops * 0.1) }); break;
    case 'donateG': send({ t: 'donate', p: sm, gold: Math.floor(p.gold * 0.1) }); break;
    case 'focus': centerOn(sm); break;
    case 'close': pinnedCard = 0; $('player-card').classList.add('hidden'); break;
  }
}
function centerOn(sm) {
  const l = G.labels.get(sm);
  if (!l) return;
  cam.x = window.innerWidth / 2 - l.x * cam.zoom;
  cam.y = window.innerHeight / 2 - l.y * cam.zoom;
}

// top-right buttons
$('btn-pause').onclick = () => { if (isHost()) send({ t: 'pause', on: !G.ctl.paused }); };
$('btn-speed').onclick = () => { if (!isHost()) return; const steps = [0.5, 1, 1.5, 2, 3]; const i = steps.indexOf(G.ctl.speed); send({ t: 'speed', v: steps[(i + 1) % steps.length] }); };
$('opt-speed').addEventListener('change', (e) => send({ t: 'speed', v: Number(e.target.value) }));
$('btn-settings').onclick = () => $('settings-popup').classList.toggle('hidden');
$('btn-fullscreen').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.(); };
$('btn-exit').onclick = () => { if (confirm('Leave this game?')) { G.active = false; send({ t: 'leave' }); } };
$('btn-end-game').onclick = () => { if (isHost() && confirm('End the game for everyone and return to the lobby?')) send({ t: 'endGame' }); };
$('opt-labels').addEventListener('change', (e) => { opts.labels = e.target.checked; });
$('opt-structures').addEventListener('change', (e) => { opts.structures = e.target.checked; });
$('opt-events').addEventListener('change', (e) => { opts.events = e.target.checked; $('events-panel').classList.toggle('hidden', !opts.events); });
$('btn-lb-toggle').onclick = () => { const t = $('leaderboard'); t.classList.toggle('hidden'); $('btn-lb-toggle').textContent = t.classList.contains('hidden') ? '+' : '−'; };
$('btn-ev-toggle').onclick = () => { const t = $('event-log'); t.classList.toggle('hidden'); $('btn-ev-toggle').textContent = t.classList.contains('hidden') ? '+' : '−'; };
$('btn-chat').onclick = () => openChat();
function openChat() { $('chat-row').classList.remove('hidden'); $('game-chat-input').focus(); }
$('game-chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { if (e.target.value.trim()) send({ t: 'chat', text: e.target.value }); e.target.value = ''; e.target.blur(); $('chat-row').classList.add('hidden'); }
  if (e.key === 'Escape') { e.target.value = ''; e.target.blur(); $('chat-row').classList.add('hidden'); }
  e.stopPropagation();
});
function showGameOver() {
  $('game-over').classList.remove('hidden');
  $('game-over-title').textContent = G.winner === G.me ? '🏆 Victory!' : 'Game over';
  $('game-over-text').textContent = `${pname(G.winner)} won the game.`;
  $('btn-back-lobby').textContent = isHost() ? 'End game & back to lobby' : 'Back to lobby';
}
$('btn-spectate').onclick = () => $('game-over').classList.add('hidden');
$('btn-back-lobby').onclick = () => { if (isHost()) send({ t: 'endGame' }); else { G.active = false; show('lobby'); renderLobby(); } };

// =============================================================================
// Radial menu (right-click)
// =============================================================================
const radialEl = $('radial');
let radialTile = -1;
function closeRadial() { radialEl.classList.add('hidden'); radialEl.innerHTML = ''; radialTile = -1; }
function radialItems(items, center, sx, sy) {
  radialEl.innerHTML = '';
  radialEl.style.left = sx + 'px'; radialEl.style.top = sy + 'px';
  const c = document.createElement('div');
  c.className = 'radial-center';
  c.innerHTML = center.html;
  c.onclick = (e) => { e.stopPropagation(); if (center.onClick) center.onClick(); else closeRadial(); };
  radialEl.appendChild(c);
  const R = 78;
  const n = items.length;
  items.forEach((it, i) => {
    const ang = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const el = document.createElement('div');
    el.className = 'radial-item ' + (it.cls || '') + (it.disabled ? ' disabled' : '');
    el.style.left = (Math.cos(ang) * R) + 'px';
    el.style.top = (Math.sin(ang) * R) + 'px';
    el.innerHTML = `<img src="${iconURL[it.icon] || ''}" alt=""><span class="lbl">${esc(it.label)}</span>${it.cost !== undefined ? `<span class="cost">${fmt(it.cost)}</span>` : ''}`;
    el.title = it.title || it.label;
    el.onclick = (e) => { e.stopPropagation(); if (it.disabled) return; it.onClick(); };
    radialEl.appendChild(el);
  });
  radialEl.classList.remove('hidden');
}
function openRadial(tile, sx, sy) {
  const p = me();
  if (!p) return;
  radialTile = tile;
  const o = G.owner[tile];
  const q = o ? G.players.get(o) : null;
  const land = isLand(tile);
  const items = [];
  const nukesOff = G.settings && G.settings.disableNukes, boatsOff = G.settings && G.settings.disableBoats;
  const ownerName = !land ? 'Water' : q ? q.name : (G.fallout[tile] ? 'Fallout' : 'Unclaimed');
  const center = { html: `<b>${esc(ownerName)}</b><span class="muted">${q ? fmt(q.troops) + ' troops' : land ? 'land' : ''}</span>` };
  if (o === G.me && land) {
    items.push({ icon: 'build', label: 'Build', cls: 'build', onClick: () => openBuildRadial(tile, sx, sy) });
    const u = G.unitByTile.get(tile);
    if (u && (u[1] === 'city' || u[1] === 'port')) items.push({ icon: u[1], label: 'Upgrade', cost: itemCost(u[1]), onClick: () => { send({ t: 'build', unit: u[1], tile }); closeRadial(); } });
    items.push({ icon: 'info', label: 'Info', onClick: () => { pinnedCard = G.me; renderPlayerCard(G.me, true); closeRadial(); } });
  } else {
    if (land && p.alive && !(q && p.allies.includes(o))) {
      items.push({ icon: 'sword', label: `Attack ${fmt(p.troops * ratio)}`, cls: 'attack', onClick: () => { send({ t: 'attack', tile, ratio }); closeRadial(); } });
    }
    if (!boatsOff && p.alive && !(q && p.allies.includes(o))) items.push({ icon: 'boat', label: `Boat ${fmt(p.troops * ratio)}`, onClick: () => { send({ t: 'boat', tile, ratio }); closeRadial(); } });
    if (q && q.alive && p.alive) {
      if (p.allies.includes(o)) {
        items.push({ icon: 'donateTroop', label: 'Donate troops', onClick: () => { playerAction(o, 'donateT'); closeRadial(); } });
        items.push({ icon: 'donateGold', label: 'Donate gold', onClick: () => { playerAction(o, 'donateG'); closeRadial(); } });
        items.push({ icon: 'traitor', label: 'Break alliance', onClick: () => { playerAction(o, 'break'); closeRadial(); } });
      } else items.push({ icon: 'ally', label: 'Alliance', onClick: () => { playerAction(o, 'ally'); closeRadial(); } });
    }
    if (land && !nukesOff && p.alive && haveReadySilo()) {
      items.push({ icon: 'atom', label: 'Atom bomb', cost: itemCost('atom'), disabled: p.gold < itemCost('atom'), onClick: () => { send({ t: 'nuke', type: 'atom', tile }); closeRadial(); } });
      items.push({ icon: 'hydrogen', label: 'H-bomb', cost: itemCost('hydrogen'), disabled: p.gold < itemCost('hydrogen'), onClick: () => { send({ t: 'nuke', type: 'hydrogen', tile }); closeRadial(); } });
    }
    if (q) items.push({ icon: 'info', label: 'Info', onClick: () => { pinnedCard = o; renderPlayerCard(o, true); closeRadial(); } });
  }
  if (!items.length) items.push({ icon: 'x', label: 'Close', onClick: closeRadial });
  radialItems(items, center, sx, sy);
}
function openBuildRadial(tile, sx, sy) {
  const p = me();
  const nukesOff = G.settings && G.settings.disableNukes;
  const items = [];
  for (const key of Object.keys(UNIT_INFO)) {
    if (nukesOff && (key === 'silo' || key === 'sam')) continue;
    const cost = itemCost(key);
    items.push({ icon: key, label: UNIT_INFO[key].label, cost, disabled: p.gold < cost, title: UNIT_INFO[key].desc, onClick: () => { send({ t: 'build', unit: key, tile }); closeRadial(); } });
  }
  radialItems(items, { html: `<b>Build</b><span class="muted">back</span>`, onClick: () => openRadial(tile, sx, sy) }, sx, sy);
}

// =============================================================================
// Input
// =============================================================================
function resizeCanvas() { canvas.width = Math.max(1, window.innerWidth * devicePixelRatio); canvas.height = Math.max(1, window.innerHeight * devicePixelRatio); }
window.addEventListener('resize', resizeCanvas);
let needFit = false;
function fitCamera() {
  const sw = window.innerWidth, sh = window.innerHeight;
  if (!(sw > 0 && sh > 0) || !G.W) { needFit = true; return; }
  needFit = false;
  cam.zoom = Math.min(sw / G.W, sh / G.H) * 0.98;
  cam.x = (sw - G.W * cam.zoom) / 2;
  cam.y = (sh - G.H * cam.zoom) / 2;
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { resizeCanvas(); if (needFit) fitCamera(); } });
function screenToTile(sx, sy) {
  const wx = Math.floor((sx - cam.x) / cam.zoom), wy = Math.floor((sy - cam.y) / cam.zoom);
  if (wx < 0 || wy < 0 || wx >= G.W || wy >= G.H) return -1;
  return wy * G.W + wx;
}
const mouse = { down: false, button: 0, sx: 0, sy: 0, lastX: 0, lastY: 0, dragging: false, x: 0, y: 0 };
canvas.addEventListener('mousedown', (e) => {
  mouse.down = true; mouse.button = e.button; mouse.sx = mouse.lastX = e.clientX; mouse.sy = mouse.lastY = e.clientY; mouse.dragging = false;
});
window.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (screen !== 'game') return;
  hoverTile = e.target === canvas ? screenToTile(e.clientX, e.clientY) : -1;
  if (!mouse.down) return;
  const dx = e.clientX - mouse.lastX, dy = e.clientY - mouse.lastY;
  if (!mouse.dragging && Math.hypot(e.clientX - mouse.sx, e.clientY - mouse.sy) > 5) mouse.dragging = true;
  if (mouse.dragging) { cam.x += dx; cam.y += dy; }
  mouse.lastX = e.clientX; mouse.lastY = e.clientY;
});
window.addEventListener('mouseup', (e) => {
  if (!mouse.down) return;
  mouse.down = false;
  if (screen !== 'game' || mouse.dragging || e.target !== canvas) return;
  if (e.button === 0) onLeftClick(e.clientX, e.clientY, e.shiftKey);
  else if (e.button === 2) onRightClick(e.clientX, e.clientY);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.shiftKey) { setRatio(ratio - Math.sign(e.deltaY) * 0.05); return; }
  zoomAt(e.clientX, e.clientY, Math.pow(1.0015, -e.deltaY));
}, { passive: false });
function zoomAt(sx, sy, factor) {
  const nz = clamp(cam.zoom * factor, 0.15, 40);
  const f = nz / cam.zoom;
  cam.x = sx - (sx - cam.x) * f;
  cam.y = sy - (sy - cam.y) * f;
  cam.zoom = nz;
}
function onLeftClick(sx, sy, shift) {
  closeRadial();
  $('settings-popup').classList.add('hidden');
  const tile = screenToTile(sx, sy);
  if (tile < 0) return;
  if (G.phase === 'spawn') {
    if (!isLand(tile)) return toast('Spawn must be on land');
    send({ t: 'spawn', tile });
    return;
  }
  if (placement) {
    if (placement.kind === 'build') send({ t: 'build', unit: placement.unit, tile });
    else send({ t: 'nuke', type: placement.type, tile });
    if (!keys.shift) { placement = null; renderHotbar(); }
    return;
  }
  const p = me();
  if (!p || !p.alive) return;
  const o = G.owner[tile];
  if (o === G.me) { if (!shift) openRadial(tile, sx, sy); return; }
  if (!isLand(tile)) { if (!(G.settings && G.settings.disableBoats)) send({ t: 'boat', tile, ratio }); return; }
  if (o && p.allies.includes(o)) { toast(`${pname(o)} is your ally`); return; }
  send({ t: 'attack', tile, ratio }); // server falls back to a boat when not reachable by land
}
function onRightClick(sx, sy) {
  if (placement) { placement = null; renderHotbar(); return; }
  if (!radialEl.classList.contains('hidden')) { closeRadial(); return; }
  const tile = screenToTile(sx, sy);
  if (tile < 0 || G.phase === 'spawn') return;
  openRadial(tile, sx, sy);
}
const keys = { shift: false };
window.addEventListener('keydown', (e) => {
  if (screen !== 'game') return;
  if (e.key === 'Shift') keys.shift = true;
  const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT');
  if (typing) return;
  const k = e.key.toLowerCase();
  if (e.key === 'Enter') { openChat(); e.preventDefault(); return; }
  if (e.key === 'Escape') { closeRadial(); placement = null; renderHotbar(); pinnedCard = 0; $('player-card').classList.add('hidden'); $('settings-popup').classList.add('hidden'); return; }
  if (k === 'a') { if (hoverTile >= 0 && G.phase === 'play') send({ t: 'attack', tile: hoverTile, ratio }); return; }
  if (k === 'b') { if (hoverTile >= 0 && G.phase === 'play') send({ t: 'boat', tile: hoverTile, ratio }); return; }
  if (k === 'r') { const inc = G.attacks.filter((a) => a[2] === G.me); if (inc.length) { const a = inc[inc.length - 1]; const l = G.labels.get(a[1]); send({ t: 'attackPlayer', p: a[1], ratio }); void l; } return; }
  if (k === 'c') { centerOn(G.me); return; }
  if (/^[1-9]$/.test(e.key)) { const key = HOTBAR[Number(e.key) - 1]; if (key) togglePlacement(key); return; }
  if (e.key === '+' || e.key === '=') zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.25);
  if (e.key === '-') zoomAt(window.innerWidth / 2, window.innerHeight / 2, 0.8);
  if (e.key === '[') setRatio(ratio - 0.05);
  if (e.key === ']') setRatio(ratio + 0.05);
  const pan = 60;
  if (e.key === 'ArrowLeft') cam.x += pan; if (e.key === 'ArrowRight') cam.x -= pan;
  if (e.key === 'ArrowUp') cam.y += pan; if (e.key === 'ArrowDown') cam.y -= pan;
});
window.addEventListener('keyup', (e) => { if (e.key === 'Shift') keys.shift = false; });

// =============================================================================
// Rendering
// =============================================================================
function computeLabels() {
  const n = G.players.size + 1;
  const sx = new Float64Array(n), sy = new Float64Array(n), cnt = new Float64Array(n);
  const W = G.W, O = G.owner;
  for (let i = 0; i < O.length; i++) { const o = O[i]; if (o === 0) continue; sx[o] += i % W; sy[o] += (i / W) | 0; cnt[o]++; }
  G.labels = new Map();
  for (let o = 1; o < n; o++) if (cnt[o] > 0) G.labels.set(o, { x: sx[o] / cnt[o] + 0.5, y: sy[o] / cnt[o] + 0.5, n: cnt[o] });
}
function shapePath(type, x, y, r) {
  ctx.beginPath();
  if (type === 'city') { ctx.arc(x, y, r, 0, Math.PI * 2); return; }
  const sides = type === 'port' ? 5 : type === 'defense' ? 8 : type === 'silo' ? 3 : type === 'sam' ? 4 : 6;
  const rot = type === 'port' || type === 'silo' ? -Math.PI / 2 : type === 'defense' ? Math.PI / 8 : type === 'sam' ? Math.PI / 4 : Math.PI / 6;
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}
let lastHoverCardTile = -2;
function draw() {
  requestAnimationFrame(draw);
  if (screen !== 'game' || !G.active) return;
  if (needFit || canvas.width <= 1) { resizeCanvas(); fitCamera(); if (needFit) return; }
  const dpr = devicePixelRatio;
  const sw = window.innerWidth, sh = window.innerHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#3c3c3c';
  ctx.fillRect(0, 0, sw, sh);
  ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom, dpr * cam.x, dpr * cam.y);
  ctx.imageSmoothingEnabled = cam.zoom < 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(terrainCanvas, 0, 0);
  if (ownerDirty) { ownerCtx.putImageData(ownerImg, 0, 0); ownerDirty = false; }
  ctx.drawImage(ownerCanvas, 0, 0);

  // spawn preview / placement ghosts (world space)
  if (G.phase === 'spawn' && hoverTile >= 0 && isLand(hoverTile)) {
    ctx.fillStyle = 'rgba(255, 213, 79, 0.45)';
    ctx.strokeStyle = 'rgba(255, 213, 79, 0.9)';
    ctx.lineWidth = 1.5 / cam.zoom;
    ctx.beginPath(); ctx.arc(tileX(hoverTile) + 0.5, tileY(hoverTile) + 0.5, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  if (placement && placement.kind === 'nuke' && hoverTile >= 0) {
    const inner = placement.type === 'hydrogen' ? 80 : 12, outer = placement.type === 'hydrogen' ? 100 : 30;
    const hx = tileX(hoverTile) + 0.5, hy = tileY(hoverTile) + 0.5;
    ctx.lineWidth = 1.5 / cam.zoom;
    ctx.fillStyle = 'rgba(255,60,60,0.15)'; ctx.beginPath(); ctx.arc(hx, hy, outer, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,60,60,0.9)'; ctx.beginPath(); ctx.arc(hx, hy, inner, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,60,60,0.5)'; ctx.beginPath(); ctx.arc(hx, hy, outer, 0, Math.PI * 2); ctx.stroke();
  }

  // ---- screen space ----
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const toScreen = (wx, wy) => [cam.x + wx * cam.zoom, cam.y + wy * cam.zoom];
  const visible = (x, y, m = 40) => x > -m && y > -m && x < sw + m && y < sh + m;
  if (G.tick - G.lastLabelTick >= 20) { computeLabels(); G.lastLabelTick = G.tick; }

  // structures
  if (opts.structures) {
    const r = clamp(5.5 * cam.zoom, 6, 18);
    for (const u of G.units) {
      const [, type, ownerSm, tile, level, building, cooldown] = u;
      const p = G.players.get(ownerSm);
      if (!p) continue;
      const [x, y] = toScreen(tile % G.W + 0.5, Math.floor(tile / G.W) + 0.5);
      if (!visible(x, y)) continue;
      ctx.globalAlpha = building > 0 ? 0.55 : 1;
      shapePath(type, x, y, r);
      ctx.fillStyle = rgbToHex(darken(p.rgb, 0.05));
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, r / 6);
      ctx.strokeStyle = cooldown > 0 ? '#ff5252' : p.borderHex;
      ctx.stroke();
      const ic = icons[type];
      if (ic && r >= 7) { const s = r * 1.15; ctx.drawImage(ic, x - s / 2, y - s / 2, s, s); }
      ctx.globalAlpha = 1;
      if (level > 1 && r >= 8) {
        ctx.font = `bold ${Math.max(9, r * 0.8)}px system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(x + r * 0.8, y - r * 0.8, r * 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(String(level), x + r * 0.8, y - r * 0.8 + 0.5);
      }
      if (building > 0) {
        const total = { city: 20, port: 50, defense: 50, silo: 100, sam: 300 }[type] || 20;
        ctx.beginPath(); ctx.arc(x, y, r + 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - building / total));
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
  }
  // ships
  const drawSprite = (name, ownerSm, wx, wy, scale) => {
    const p = G.players.get(ownerSm);
    const c = coloredSprite(name, p ? p.color : '#ffffff', p ? p.borderHex : '#000000');
    const [x, y] = toScreen(wx + 0.5, wy + 0.5);
    if (!visible(x, y)) return null;
    if (!c) { ctx.fillStyle = p ? p.color : '#fff'; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); return [x, y]; }
    const s = clamp(c.width * cam.zoom * scale, c.width * 1.5, c.width * 6);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(c, x - s / 2, y - s / 2, s, s);
    return [x, y];
  };
  for (const s of G.trade) drawSprite('trade', s[1], s[2], s[3], 1.2);
  for (const b of G.boats) {
    const pos = drawSprite('transport', b[1], b[2], b[3], 1.4);
    if (pos && cam.zoom > 1.2) {
      ctx.font = `bold ${clamp(4 * cam.zoom, 10, 14)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3;
      ctx.strokeText(fmt(b[4]), pos[0], pos[1] - 8); ctx.fillText(fmt(b[4]), pos[0], pos[1] - 8);
    }
  }
  // nukes
  for (const nk of G.nukes) {
    const [, type, ownerSm, nx, ny, tx, ty, sx0, sy0] = nk;
    const [gx, gy] = toScreen(tx + 0.5, ty + 0.5);
    const [ox, oy] = toScreen(sx0 + 0.5, sy0 + 0.5);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,80,80,0.6)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(gx, gy); ctx.stroke();
    ctx.setLineDash([]);
    const r = (type === 'hydrogen' ? 100 : 30) * cam.zoom;
    ctx.strokeStyle = 'rgba(255,80,80,0.8)'; ctx.beginPath(); ctx.arc(gx, gy, r, 0, Math.PI * 2); ctx.stroke();
    drawSprite(type === 'hydrogen' ? 'hydrogen' : 'atom', ownerSm, nx, ny, 1.6);
  }
  // explosions
  const now = performance.now();
  G.effects = G.effects.filter((e) => now - e.t0 < e.dur);
  for (const e of G.effects) {
    const k = (now - e.t0) / e.dur;
    const [x, y] = toScreen(e.x + 0.5, e.y + 0.5);
    ctx.beginPath(); ctx.arc(x, y, Math.max(6, e.r * cam.zoom * (0.3 + 0.7 * k)), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,${Math.floor(200 - 150 * k)},50,${0.55 * (1 - k)})`; ctx.fill();
    ctx.strokeStyle = `rgba(255,255,255,${1 - k})`; ctx.lineWidth = 2; ctx.stroke();
  }
  // labels
  if (opts.labels) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const myAllies = me() ? me().allies : [];
    for (const [sm, l] of G.labels) {
      const p = G.players.get(sm);
      if (!p) continue;
      const size = Math.min(26, Math.sqrt(l.n) * cam.zoom * 0.22);
      if (size < 7) continue;
      const [x, y] = toScreen(l.x, l.y);
      if (!visible(x, y, 120)) continue;
      ctx.font = `bold ${size}px "Segoe UI", system-ui, sans-serif`;
      ctx.lineWidth = Math.max(2, size / 6);
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.fillStyle = '#111';
      ctx.strokeText(p.name, x, y - size * 0.5);
      ctx.fillText(p.name, x, y - size * 0.5);
      ctx.font = `${size * 0.85}px "Segoe UI", system-ui, sans-serif`;
      const t = fmt(p.troops);
      ctx.strokeText(t, x, y + size * 0.55);
      ctx.fillText(t, x, y + size * 0.55);
      let ix = x - ctx.measureText(p.name).width / 2 - size * 0.8;
      if (sm === G.leaderSm && icons.crown) { const s = size * 1.1; ctx.drawImage(icons.crown, x - s / 2, y - size * 0.5 - size * 0.55 - s, s, s); }
      if (p.traitor && icons.traitor) { const s = size * 0.9; ctx.drawImage(icons.traitor, ix - s, y - size * 0.5 - s / 2, s, s); ix -= s + 2; }
      if (myAllies.includes(sm) && icons.ally) { const s = size * 0.9; ctx.drawImage(icons.ally, ix - s, y - size * 0.5 - s / 2, s, s); }
    }
  }
  // hover player card (not pinned)
  if (!pinnedCard) {
    const o = hoverTile >= 0 ? G.owner[hoverTile] : 0;
    if (o !== lastHoverCardTile) { lastHoverCardTile = o; if (o) renderPlayerCard(o, false); else $('player-card').classList.add('hidden'); }
  }
  updateTimer();
}

// =============================================================================
// Boot
// =============================================================================
const m = location.pathname.match(/^\/g\/([A-Za-z0-9]{4,6})/);
if (m) { net.pendingJoin = m[1].toUpperCase(); history.replaceState(null, '', '/'); }
$('name-input').value = net.name;
loadAssets().then(() => { renderHotbar(); });
connect();
requestAnimationFrame(draw);
setInterval(() => { if (net.connected) fetch('/healthz').catch(() => {}); }, 4 * 60 * 1000);
})();
