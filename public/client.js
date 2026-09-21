(() => {
'use strict';
const $ = (id) => document.getElementById(id);

// =============================================================================
// Utilities
// =============================================================================
function fmt(n) {
  n = Math.floor(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'K';
  return String(n);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function toast(msg, info = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (info ? ' info' : '');
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

const UNIT_INFO = {
  city: { label: 'City', icon: '🏙️', desc: '+250K max troops', cost: (n) => Math.min(1e6, Math.pow(2, n) * 125000) },
  port: { label: 'Port', icon: '⚓', desc: '+gold, coast only', cost: (n) => Math.min(1e6, Math.pow(2, n) * 125000) },
  defense: { label: 'Defense Post', icon: '🛡️', desc: 'Attackers nearby lose 5x', cost: (n) => Math.min(250000, (n + 1) * 50000) },
  silo: { label: 'Missile Silo', icon: '🚀', desc: 'Launches nukes', cost: () => 1000000 },
  sam: { label: 'SAM', icon: '📡', desc: 'Shoots down nukes', cost: (n) => Math.min(3e6, (n + 1) * 1500000) },
};
const NUKE_INFO = {
  atom: { label: 'Atom Bomb', icon: '☢️', cost: 750000 },
  hydrogen: { label: 'Hydrogen Bomb', icon: '💥', cost: 5000000 },
};

// =============================================================================
// Networking
// =============================================================================
const net = {
  ws: null,
  token: sessionStorage.getItem('of_token') || '', // per-tab: refresh reconnects, new tab = new player
  name: localStorage.getItem('of_name') || '',
  id: null,
  connected: false,
  pendingJoin: null,
};
function send(obj) {
  if (net.ws && net.ws.readyState === 1) net.ws.send(JSON.stringify(obj));
}
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}`);
  net.ws = ws;
  ws.onopen = () => {
    net.connected = true;
    send({ t: 'hello', token: net.token, name: net.name || undefined });
  };
  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    handleMessage(m);
  };
  ws.onclose = () => {
    net.connected = false;
    $('menu-status').textContent = 'Disconnected from server, reconnecting…';
    setTimeout(connect, 2000);
  };
}

function handleMessage(m) {
  switch (m.t) {
    case 'welcome':
      net.token = m.token; sessionStorage.setItem('of_token', m.token);
      net.id = m.id;
      if (!net.name) { net.name = m.name; }
      $('name-input').value = net.name;
      $('menu-status').textContent = m.lan && m.lan.length ? `Friends on your network can join at http://${m.lan[0]}:${m.port}` : '';
      if (net.pendingJoin) { send({ t: 'join', code: net.pendingJoin }); net.pendingJoin = null; }
      else if (screen === 'menu') send({ t: 'list' });
      break;
    case 'lobbies': renderPublicList(m.lobbies); break;
    case 'lobby': lobby = m.lobby; if (screen !== 'game') show('lobby'); renderLobby(); break;
    case 'left': lobby = null; show('menu'); send({ t: 'list' }); break;
    case 'error': toast(m.msg); $('menu-status').textContent = m.msg; break;
    case 'toast': toast(m.msg); break;
    case 'chat': addChat(m.from, m.text); break;
    case 'start': startGame(m); break;
    case 'tick': applyTick(m); break;
    case 'ended': G.active = false; show('lobby'); if (lobby) renderLobby(); break;
    default: break;
  }
}

// =============================================================================
// Screens / menu / lobby
// =============================================================================
let screen = 'menu';
let lobby = null;
function show(name) {
  screen = name;
  for (const s of ['menu', 'lobby', 'game']) $('screen-' + s).classList.toggle('hidden', s !== name);
  if (name === 'game') { resizeCanvas(); }
}

function saveName() {
  const v = $('name-input').value.trim().slice(0, 20);
  if (v && v !== net.name) { net.name = v; localStorage.setItem('of_name', v); send({ t: 'setName', name: v }); }
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
let settingsTimer = null;
function isHost() { return lobby && lobby.players.some((p) => p.id === net.id && p.host); }
function renderLobby() {
  if (!lobby) return;
  $('lobby-name').textContent = lobby.name;
  $('lobby-code').textContent = lobby.code;
  $('lobby-count').textContent = `(${lobby.players.length}/${lobby.settings.maxHumans})`;
  $('lobby-player-list').innerHTML = lobby.players.map((p) => `<li><span>${esc(p.name)}${p.id === net.id ? ' (you)' : ''}</span><span class="muted">${p.host ? '👑 host' : ''}${p.online ? '' : ' · offline'}</span></li>`).join('');
  const host = isHost();
  $('btn-start').classList.toggle('hidden', !host);
  settingsForm.classList.toggle('readonly', !host);
  $('settings-note').textContent = host ? '' : '(only the host can change these)';
  if (document.activeElement && settingsForm.contains(document.activeElement)) return; // don't clobber while typing
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
    for (const el of settingsForm.elements) {
      if (!el.name) continue;
      s[el.name] = el.type === 'checkbox' ? el.checked : el.value;
    }
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
  for (const id of ['lobby-chat-log', 'event-log']) {
    const log = $(id);
    const d = document.createElement('div');
    d.innerHTML = `<b>${esc(from)}:</b> ${esc(text)}`;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
    while (log.children.length > 80) log.firstChild.remove();
  }
}
$('lobby-chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.value.trim()) { send({ t: 'chat', text: e.target.value }); e.target.value = ''; }
});

// =============================================================================
// Game state
// =============================================================================
const G = {
  active: false, W: 0, H: 0, numLand: 1, terrain: null, owner: null, fallout: null,
  players: new Map(), me: 0, tick: 0, phase: 'spawn', spawnLeft: 0, settings: null,
  units: [], attacks: [], boats: [], nukes: [], allyReqs: [], effects: [], winner: 0,
  labels: new Map(), lastLabelTick: -100,
};
const cam = { x: 0, y: 0, zoom: 2 };
window.__debug = { G, cam, net, get lobby() { return lobby; } }; // handy for debugging in devtools
const canvas = $('game-canvas');
const ctx = canvas.getContext('2d');
let terrainCanvas = null, ownerCanvas = null, ownerCtx = null, ownerImg = null, ownerDirty = false;
let ratio = 0.2;
let placement = null; // {kind:'build', unit} | {kind:'nuke', type}
let hoverTile = -1;
let spectating = false;

function me() { return G.players.get(G.me); }
function pname(sm) { const p = G.players.get(sm); return p ? p.name : (sm === 0 ? 'Unclaimed land' : '?'); }

function startGame(m) {
  const s = m.state;
  G.active = true;
  G.W = s.width; G.H = s.height; G.numLand = s.numLand;
  G.terrain = b64ToBytes(s.terrain);
  const ob = b64ToBytes(s.owner);
  G.owner = new Uint16Array(ob.buffer, ob.byteOffset, ob.byteLength / 2);
  G.fallout = b64ToBytes(s.fallout);
  G.me = m.you;
  G.tick = s.tick; G.phase = s.phase; G.spawnLeft = Math.max(0, s.spawnTicks - s.tick);
  G.settings = s.settings;
  G.players = new Map();
  for (const p of s.players) {
    const rgb = hexToRgb(p.color);
    G.players.set(p.sm, { ...p, rgb, dark: rgb.map((c) => Math.floor(c * 0.55)), troops: 0, gold: 0, tiles: 0, flags: 0, maxTroops: 0, allies: [] });
  }
  applyStats(s.stats);
  G.units = s.units || [];
  G.attacks = []; G.boats = []; G.nukes = []; G.allyReqs = []; G.effects = [];
  G.winner = s.winner || 0;
  spectating = false;
  placement = null;
  $('event-log').innerHTML = '';
  $('game-over').classList.add('hidden');
  buildTerrainCanvas();
  ownerCanvas = document.createElement('canvas'); ownerCanvas.width = G.W; ownerCanvas.height = G.H;
  ownerCtx = ownerCanvas.getContext('2d');
  ownerImg = ownerCtx.createImageData(G.W, G.H);
  for (let i = 0; i < G.W * G.H; i++) paintTile(i);
  ownerDirty = true;
  show('game');
  fitCamera();
  renderHotbar();
  renderHud();
  logEvent(G.phase === 'spawn' ? 'Choose your spawn location by clicking on land!' : 'Reconnected to the game.', 'good');
}

function buildTerrainCanvas() {
  terrainCanvas = document.createElement('canvas');
  terrainCanvas.width = G.W; terrainCanvas.height = G.H;
  const c = terrainCanvas.getContext('2d');
  const img = c.createImageData(G.W, G.H);
  const d = img.data;
  const W = G.W, H = G.H, T = G.terrain;
  for (let i = 0; i < W * H; i++) {
    const t = T[i];
    const k = i * 4;
    let r, g, b;
    if (t === 0) {
      // water: lighter near coasts
      let coast = false;
      const x = i % W, y = (i / W) | 0;
      for (let dy = -2; dy <= 2 && !coast; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < W && ny < H && T[ny * W + nx] !== 0) { coast = true; break; }
      }
      if (coast) { r = 52; g = 110; b = 150; } else { r = 28; g = 68; b = 110; }
      const v = ((x * 7 + y * 13) % 11) - 5;
      r += v; g += v; b += v;
    } else if (t === 1) { r = 96; g = 140; b = 74; }
    else if (t === 2) { r = 140; g = 140; b = 92; }
    else { r = 170; g = 168; b = 160; }
    // subtle noise so big areas aren't flat
    const n = ((i * 2654435761) >>> 0) % 13 - 6;
    d[k] = r + n; d[k + 1] = g + n; d[k + 2] = b + n; d[k + 3] = 255;
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
    if (G.fallout[i]) { d[k] = 70; d[k + 1] = 70; d[k + 2] = 70; d[k + 3] = 190; }
    else d[k + 3] = 0;
    return;
  }
  const p = G.players.get(o);
  if (!p) { d[k + 3] = 0; return; }
  if (isBorder(i)) { d[k] = p.dark[0]; d[k + 1] = p.dark[1]; d[k + 2] = p.dark[2]; d[k + 3] = 255; }
  else { d[k] = p.rgb[0]; d[k + 1] = p.rgb[1]; d[k + 2] = p.rgb[2]; d[k + 3] = 175; }
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
    p.troops = s[1]; p.gold = s[2]; p.tiles = s[3]; p.flags = s[4]; p.maxTroops = s[5]; p.allies = s[6] || [];
    p.spawned = !!(s[4] & 1); p.alive = !!(s[4] & 2); p.traitor = !!(s[4] & 4); p.offline = !!(s[4] & 8);
  }
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
  if (m.units) G.units = m.units;
  if (m.boats) G.boats = m.boats;
  if (m.nukes) G.nukes = m.nukes;
  if (m.allyReqs) G.allyReqs = m.allyReqs.filter((r) => r[1] === net.id).map((r) => r[0]);
  if (m.events) for (const e of m.events) handleEvent(e);
  if (m.winner !== undefined) G.winner = m.winner;
  if (prevPhase !== 'over' && G.phase === 'over') showGameOver();
  if (m.stats || m.attacks || m.allyReqs) renderHud();
  if (G.phase !== 'play' || m.stats) renderBanner();
}

function handleEvent(e) {
  switch (e.k) {
    case 'phase': logEvent('The game has begun. Expand!', 'good'); break;
    case 'attacked': logEvent(`${pname(e.by)} is attacking you with ${fmt(e.troops)} troops!`, 'bad'); break;
    case 'conquered': logEvent(`${pname(e.by)} conquered ${pname(e.p)}`, e.p === G.me ? 'bad' : (e.by === G.me ? 'good' : '')); break;
    case 'death': logEvent(`${pname(e.p)} was eliminated${e.by ? ' by ' + pname(e.by) : ''}`, e.p === G.me ? 'bad' : ''); if (e.p === G.me) { spectating = true; toast('You were eliminated. You are now spectating.'); } break;
    case 'nuke': logEvent(`☢️ ${pname(e.by)} launched a${e.type === 'hydrogen' ? ' HYDROGEN' : 'n atom'} bomb!`, 'bad'); break;
    case 'boom': G.effects.push({ x: e.x, y: e.y, r: e.type === 'hydrogen' ? 60 : 25, t0: performance.now(), dur: 1500 }); break;
    case 'samhit': logEvent(`${pname(e.by)}'s SAM shot down a nuke`, 'good'); G.effects.push({ x: e.x, y: e.y, r: 6, t0: performance.now(), dur: 700 }); break;
    case 'allyRequest': logEvent(`${pname(e.from)} requests an alliance`, 'good'); break;
    case 'allyRejected': logEvent(`${pname(e.by)} rejected your alliance request`); break;
    case 'allied': logEvent(`${pname(e.a)} and ${pname(e.b)} are now allies`, (e.a === G.me || e.b === G.me) ? 'good' : ''); break;
    case 'betrayed': logEvent(`${pname(e.by)} betrayed ${pname(e.p)}!`, e.p === G.me ? 'bad' : ''); break;
    case 'donate': logEvent(`${pname(e.from)} sent ${e.troops ? fmt(e.troops) + ' troops' : ''}${e.troops && e.gold ? ' and ' : ''}${e.gold ? fmt(e.gold) + ' gold' : ''} to ${pname(e.to)}`); break;
    case 'win': logEvent(`🏆 ${pname(e.p)} won the game!`, e.p === G.me ? 'good' : ''); break;
    default: break;
  }
}
function logEvent(text, cls = '') {
  const log = $('event-log');
  const d = document.createElement('div');
  d.className = cls; d.textContent = text;
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 60) log.firstChild.remove();
}

// =============================================================================
// HUD
// =============================================================================
function renderBanner() {
  const b = $('phase-banner');
  const p = me();
  if (G.phase === 'spawn') b.textContent = `Spawn phase — click land to choose your start · ${Math.ceil(G.spawnLeft / 10)}s`;
  else if (G.phase === 'over') b.textContent = `Game over — ${pname(G.winner)} won`;
  else if (p && !p.alive) b.textContent = 'You were eliminated — spectating';
  else b.textContent = '';
}
function renderHud() {
  const p = me();
  if (!p) return;
  $('me-name').textContent = p.name;
  $('me-name').style.color = p.color;
  $('me-troops').textContent = `${fmt(p.troops)} / ${fmt(p.maxTroops)}`;
  $('me-gold').textContent = fmt(p.gold);
  $('me-land').textContent = `${fmt(p.tiles)} tiles (${(100 * p.tiles / G.numLand).toFixed(1)}%)`;
  $('ratio-label').textContent = `${Math.round(ratio * 100)}% · ${fmt(p.troops * ratio)}`;
  // attacks
  const out = G.attacks.filter((a) => a[1] === G.me);
  const inc = G.attacks.filter((a) => a[2] === G.me);
  $('me-attacks').innerHTML =
    out.map((a) => `<div><span>⚔️ → ${esc(pname(a[2]))}: ${fmt(a[3])}</span><button class="small" data-retreat="${a[0]}">Retreat</button></div>`).join('') +
    inc.map((a) => `<div class="bad" style="color:#ff8a80"><span>⚔️ ← ${esc(pname(a[1]))}: ${fmt(a[3])}</span></div>`).join('');
  $('me-attacks').querySelectorAll('button').forEach((b) => { b.onclick = () => send({ t: 'retreat', id: Number(b.dataset.retreat) }); });
  // leaderboard
  const sorted = [...G.players.values()].filter((q) => q.spawned).sort((a, b) => b.tiles - a.tiles);
  const rows = sorted.slice(0, 12);
  if (!rows.includes(p)) rows.push(p);
  $('leaderboard').innerHTML = rows.map((q) => {
    const i = sorted.indexOf(q) + 1;
    const ally = p.allies.includes(q.sm) ? ' 🤝' : '';
    const tag = q.type === 'bot' ? ' <span class="muted">(bot)</span>' : q.type === 'nation' ? ' <span class="muted">(AI)</span>' : '';
    return `<tr class="${q === p ? 'me' : ''} ${q.alive ? '' : 'dead'}" data-sm="${q.sm}"><td>${i}</td><td><span class="swatch" style="background:${q.color}"></span>${esc(q.name)}${tag}${ally}${q.traitor ? ' 🗡️' : ''}</td><td>${(100 * q.tiles / G.numLand).toFixed(1)}%</td><td>${fmt(q.troops)}</td></tr>`;
  }).join('');
  $('leaderboard').querySelectorAll('tr').forEach((tr) => {
    tr.onclick = (ev) => { const sm = Number(tr.dataset.sm); if (sm !== G.me) openPlayerMenu(sm, ev.clientX, ev.clientY); };
  });
  // alliance requests
  $('ally-requests').innerHTML = G.allyReqs.map((sm) => `<div class="ally-card"><span>🤝 <b>${esc(pname(sm))}</b> wants an alliance</span><button class="small primary" data-acc="${sm}">Accept</button><button class="small" data-rej="${sm}">Reject</button></div>`).join('');
  $('ally-requests').querySelectorAll('button').forEach((b) => {
    b.onclick = () => { const sm = Number(b.dataset.acc ?? b.dataset.rej); send({ t: 'allyReply', p: sm, accept: b.dataset.acc !== undefined }); G.allyReqs = G.allyReqs.filter((x) => x !== sm); renderHud(); };
  });
  renderHotbar();
  $('btn-end-game').classList.toggle('hidden', !isHost());
}

function myUnitCount(type) { return G.units.filter((u) => u[1] === type && u[2] === G.me).length; }
function haveReadySilo() { return G.units.some((u) => u[1] === 'silo' && u[2] === G.me && u[5] === 0 && u[6] === 0); }
function renderHotbar() {
  const p = me();
  const bar = $('hotbar');
  const infinite = G.settings && G.settings.infiniteGold;
  const items = [];
  for (const [type, info] of Object.entries(UNIT_INFO)) {
    if (G.settings && G.settings.disableNukes && (type === 'silo' || type === 'sam')) continue;
    const cost = infinite ? 0 : info.cost(myUnitCount(type));
    items.push({ key: 'build:' + type, icon: info.icon, label: info.label, cost, can: p && p.gold >= cost, active: placement && placement.kind === 'build' && placement.unit === type });
  }
  if (!(G.settings && G.settings.disableNukes)) {
    for (const [type, info] of Object.entries(NUKE_INFO)) {
      const cost = infinite ? 0 : info.cost;
      items.push({ key: 'nuke:' + type, icon: info.icon, label: info.label, cost, can: p && p.gold >= cost && haveReadySilo(), active: placement && placement.kind === 'nuke' && placement.type === type });
    }
  }
  bar.innerHTML = items.map((it) => `<button data-key="${it.key}" class="${it.active ? 'active' : ''} ${it.can ? '' : 'cant'}" title="${it.label}"><span>${it.icon} ${it.label}</span><small>${fmt(it.cost)} gold</small></button>`).join('');
  bar.querySelectorAll('button').forEach((b) => {
    b.onclick = () => {
      const [kind, what] = b.dataset.key.split(':');
      if (placement && placement.kind === kind && (placement.unit === what || placement.type === what)) placement = null;
      else placement = kind === 'build' ? { kind, unit: what } : { kind, type: what };
      renderHotbar();
      if (placement) toast(`Click on the map to place ${kind === 'build' ? UNIT_INFO[what].label : NUKE_INFO[what].label} (Esc to cancel)`, true);
    };
  });
}
$('ratio').addEventListener('input', (e) => { ratio = Number(e.target.value) / 100; renderHud(); });
$('btn-lb-toggle').onclick = () => { const t = $('leaderboard'); t.classList.toggle('hidden'); $('btn-lb-toggle').textContent = t.classList.contains('hidden') ? '+' : '−'; };
$('game-chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { if (e.target.value.trim()) send({ t: 'chat', text: e.target.value }); e.target.value = ''; e.target.blur(); }
  if (e.key === 'Escape') e.target.blur();
  e.stopPropagation();
});
function showGameOver() {
  $('game-over').classList.remove('hidden');
  $('game-over-title').textContent = G.winner === G.me ? '🏆 Victory!' : 'Game over';
  $('game-over-text').textContent = `${pname(G.winner)} won the game.`;
  $('btn-back-lobby').textContent = isHost() ? 'End game & back to lobby' : 'Back to lobby';
}
$('btn-spectate').onclick = () => $('game-over').classList.add('hidden');
$('btn-end-game').onclick = () => { if (isHost() && confirm('End the game for everyone and return to the lobby?')) send({ t: 'endGame' }); };
$('btn-leave-game').onclick = () => { if (confirm('Leave this game?')) { G.active = false; send({ t: 'leave' }); } };
$('btn-back-lobby').onclick = () => { if (isHost()) send({ t: 'endGame' }); else { G.active = false; show('lobby'); renderLobby(); } };

// =============================================================================
// Context menus
// =============================================================================
const ctxEl = $('ctx-menu');
function closeCtx() { ctxEl.classList.add('hidden'); ctxEl.innerHTML = ''; }
function placeCtx(x, y) {
  ctxEl.classList.remove('hidden');
  const r = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  ctxEl.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
}
function playerActions(sm) {
  const p = me(), q = G.players.get(sm);
  if (!p || !q || !q.alive || !p.alive) return '';
  const allied = p.allies.includes(sm);
  let html = '';
  if (allied) {
    html += `<button data-act="donateT">Donate 10% troops <small>${fmt(p.troops * 0.1)}</small></button>`;
    html += `<button data-act="donateG">Donate 10% gold <small>${fmt(p.gold * 0.1)}</small></button>`;
    html += `<button data-act="break" class="danger">Break alliance <small>traitor 30s</small></button>`;
  } else {
    html += `<button data-act="ally">🤝 Request alliance</button>`;
  }
  return html;
}
function bindPlayerActions(sm) {
  ctxEl.querySelectorAll('button[data-act]').forEach((b) => {
    b.onclick = () => {
      const p = me();
      switch (b.dataset.act) {
        case 'ally': send({ t: 'ally', p: sm }); toast('Alliance request sent', true); break;
        case 'break': send({ t: 'breakAlly', p: sm }); break;
        case 'donateT': send({ t: 'donate', p: sm, troops: Math.floor(p.troops * 0.1) }); break;
        case 'donateG': send({ t: 'donate', p: sm, gold: Math.floor(p.gold * 0.1) }); break;
      }
      closeCtx();
    };
  });
}
function openPlayerMenu(sm, x, y) {
  const q = G.players.get(sm);
  if (!q) return;
  ctxEl.innerHTML = `<div class="title" style="color:${q.color}">${esc(q.name)}</div><div class="sub">${q.type} · ${fmt(q.troops)} troops · ${fmt(q.tiles)} tiles${q.traitor ? ' · TRAITOR' : ''}</div>${playerActions(sm)}<button data-close>Close</button>`;
  bindPlayerActions(sm);
  ctxEl.querySelector('[data-close]').onclick = closeCtx;
  placeCtx(x, y);
}

function openTileMenu(tile, x, y) {
  const p = me();
  if (!p) return;
  const t = G.terrain[tile];
  const o = G.owner[tile];
  const q = o ? G.players.get(o) : null;
  let html = '';
  if (t === 0) {
    html += `<div class="title">Water</div>`;
    if (!(G.settings && G.settings.disableBoats) && p.alive) html += `<button data-act="boat">🚢 Send boat to nearest coast <small>${fmt(p.troops * ratio)}</small></button>`;
  } else if (o === G.me) {
    html += `<div class="title" style="color:${p.color}">Your territory</div>`;
    const u = G.units.find((x) => x[3] === tile);
    if (u) html += `<div class="sub">${UNIT_INFO[u[1]].icon} ${UNIT_INFO[u[1]].label} lvl ${u[4]}${u[5] > 0 ? ' (building)' : ''}</div>`;
    html += `<div class="grid">`;
    for (const [type, info] of Object.entries(UNIT_INFO)) {
      if (G.settings && G.settings.disableNukes && (type === 'silo' || type === 'sam')) continue;
      const upgrade = u && u[1] === type && (type === 'city' || type === 'port');
      if (u && !upgrade) continue;
      const cost = (G.settings && G.settings.infiniteGold) ? 0 : info.cost(upgrade ? G.units.filter((x) => x[1] === type && x[2] === G.me).reduce((s, x) => s + x[4], 0) : myUnitCount(type));
      html += `<button data-build="${type}" ${p.gold < cost ? 'class="cant"' : ''} title="${info.desc}">${info.icon} ${upgrade ? 'Upgrade' : info.label}<br><small style="float:none">${fmt(cost)}</small></button>`;
    }
    html += `</div>`;
  } else {
    const name = q ? q.name : (G.fallout[tile] ? 'Nuclear fallout' : 'Unclaimed land');
    html += `<div class="title" style="color:${q ? q.color : '#ccc'}">${esc(name)}</div>`;
    if (q) html += `<div class="sub">${q.type} · ${fmt(q.troops)} troops · ${fmt(q.tiles)} tiles${q.traitor ? ' · TRAITOR' : ''}</div>`;
    if (p.alive) {
      if (q && p.allies.includes(o)) html += `<div class="sub">Allied — you cannot attack them.</div>`;
      else {
        html += `<button data-act="attack" class="primary">⚔️ Attack <small>${fmt(p.troops * ratio)} troops</small></button>`;
        if (!(G.settings && G.settings.disableBoats)) html += `<button data-act="boat">🚢 Boat attack <small>${fmt(p.troops * ratio)}</small></button>`;
      }
    }
    if (q) html += playerActions(o);
  }
  if (t !== 0 && o !== G.me && p.alive && !(G.settings && G.settings.disableNukes) && haveReadySilo()) {
    for (const [type, info] of Object.entries(NUKE_INFO)) {
      const cost = (G.settings && G.settings.infiniteGold) ? 0 : info.cost;
      html += `<button data-nuke="${type}" ${p.gold < cost ? 'class="cant"' : ''}>${info.icon} ${info.label} <small>${fmt(cost)}</small></button>`;
    }
  }
  html += `<button data-close>Close</button>`;
  ctxEl.innerHTML = html;
  ctxEl.querySelectorAll('button[data-act]').forEach((b) => {
    b.onclick = () => {
      switch (b.dataset.act) {
        case 'attack': send({ t: 'attack', tile, ratio }); break;
        case 'boat': send({ t: 'boat', tile, ratio }); break;
      }
      closeCtx();
    };
  });
  ctxEl.querySelectorAll('button[data-build]').forEach((b) => { b.onclick = () => { send({ t: 'build', unit: b.dataset.build, tile }); closeCtx(); }; });
  ctxEl.querySelectorAll('button[data-nuke]').forEach((b) => { b.onclick = () => { send({ t: 'nuke', type: b.dataset.nuke, tile }); closeCtx(); }; });
  if (q) bindPlayerActions(o);
  ctxEl.querySelector('[data-close]').onclick = closeCtx;
  placeCtx(x, y);
}

// =============================================================================
// Input
// =============================================================================
function resizeCanvas() {
  canvas.width = window.innerWidth * devicePixelRatio;
  canvas.height = window.innerHeight * devicePixelRatio;
}
window.addEventListener('resize', resizeCanvas);
let needFit = false;
function fitCamera() {
  const sw = window.innerWidth, sh = window.innerHeight;
  if (!(sw > 0 && sh > 0)) { needFit = true; return; } // hidden tab: retry on the first visible frame
  needFit = false;
  cam.zoom = Math.min(sw / G.W, sh / G.H) * 0.95;
  cam.x = (sw - G.W * cam.zoom) / 2;
  cam.y = (sh - G.H * cam.zoom) / 2;
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { resizeCanvas(); if (needFit) fitCamera(); } });
function screenToTile(sx, sy) {
  const wx = Math.floor((sx - cam.x) / cam.zoom), wy = Math.floor((sy - cam.y) / cam.zoom);
  if (wx < 0 || wy < 0 || wx >= G.W || wy >= G.H) return -1;
  return wy * G.W + wx;
}
let mouse = { down: false, button: 0, sx: 0, sy: 0, lastX: 0, lastY: 0, dragging: false };
canvas.addEventListener('mousedown', (e) => {
  mouse.down = true; mouse.button = e.button; mouse.sx = mouse.lastX = e.clientX; mouse.sy = mouse.lastY = e.clientY; mouse.dragging = false;
});
window.addEventListener('mousemove', (e) => {
  if (screen !== 'game') return;
  hoverTile = screenToTile(e.clientX, e.clientY);
  if (!mouse.down) return;
  const dx = e.clientX - mouse.lastX, dy = e.clientY - mouse.lastY;
  if (!mouse.dragging && Math.hypot(e.clientX - mouse.sx, e.clientY - mouse.sy) > 4) mouse.dragging = true;
  if (mouse.dragging) { cam.x += dx; cam.y += dy; }
  mouse.lastX = e.clientX; mouse.lastY = e.clientY;
});
window.addEventListener('mouseup', (e) => {
  if (!mouse.down) return;
  mouse.down = false;
  if (screen !== 'game' || mouse.dragging) return;
  if (e.target !== canvas) return;
  if (e.button === 2) { closeCtx(); placement = null; renderHotbar(); return; }
  if (e.button !== 0) return;
  onClick(e.clientX, e.clientY);
});
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const factor = Math.pow(1.0015, -e.deltaY);
  zoomAt(e.clientX, e.clientY, factor);
}, { passive: false });
function zoomAt(sx, sy, factor) {
  const nz = Math.min(40, Math.max(0.3, cam.zoom * factor));
  const f = nz / cam.zoom;
  cam.x = sx - (sx - cam.x) * f;
  cam.y = sy - (sy - cam.y) * f;
  cam.zoom = nz;
}
function onClick(sx, sy) {
  closeCtx();
  const tile = screenToTile(sx, sy);
  if (tile < 0) return;
  if (G.phase === 'spawn') {
    if (G.terrain[tile] === 0) return toast('Spawn must be on land');
    send({ t: 'spawn', tile });
    return;
  }
  if (placement) {
    if (placement.kind === 'build') send({ t: 'build', unit: placement.unit, tile });
    else send({ t: 'nuke', type: placement.type, tile });
    if (!keys.shift) { placement = null; renderHotbar(); }
    return;
  }
  openTileMenu(tile, sx + 8, sy + 8);
}
const keys = { shift: false };
window.addEventListener('keydown', (e) => {
  if (screen !== 'game') return;
  if (e.key === 'Shift') keys.shift = true;
  const typing = document.activeElement && document.activeElement.tagName === 'INPUT';
  if (typing) return;
  if (e.key === 'Enter') { $('game-chat-input').focus(); e.preventDefault(); return; }
  if (e.key === 'Escape') { closeCtx(); placement = null; renderHotbar(); return; }
  if (e.key === 'a' || e.key === 'A') { if (hoverTile >= 0 && G.phase === 'play') send({ t: 'attack', tile: hoverTile, ratio }); return; }
  if (e.key === 'b' || e.key === 'B') { if (hoverTile >= 0 && G.phase === 'play') send({ t: 'boat', tile: hoverTile, ratio }); return; }
  if (/^[0-9]$/.test(e.key)) { const n = e.key === '0' ? 100 : Number(e.key) * 10; ratio = n / 100; $('ratio').value = n; renderHud(); return; }
  if (e.key === '+' || e.key === '=') zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.25);
  if (e.key === '-') zoomAt(window.innerWidth / 2, window.innerHeight / 2, 0.8);
  const pan = 40;
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
  for (let i = 0; i < O.length; i++) {
    const o = O[i];
    if (o === 0) continue;
    sx[o] += i % W; sy[o] += (i / W) | 0; cnt[o]++;
  }
  G.labels = new Map();
  for (let o = 1; o < n; o++) if (cnt[o] > 0) G.labels.set(o, { x: sx[o] / cnt[o] + 0.5, y: sy[o] / cnt[o] + 0.5, n: cnt[o] });
}

function draw() {
  requestAnimationFrame(draw);
  if (screen !== 'game' || !G.active) return;
  if (needFit || canvas.width === 0) { resizeCanvas(); fitCamera(); if (needFit) return; }
  const dpr = devicePixelRatio;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#071019';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom, dpr * cam.x, dpr * cam.y);
  ctx.drawImage(terrainCanvas, 0, 0);
  if (ownerDirty) { ownerCtx.putImageData(ownerImg, 0, 0); ownerDirty = false; }
  ctx.drawImage(ownerCanvas, 0, 0);

  // spawn-phase: highlight own spawn / hover
  if (G.phase === 'spawn' && hoverTile >= 0) {
    ctx.strokeStyle = 'rgba(255,255,255,0.8)';
    ctx.lineWidth = 1 / cam.zoom;
    ctx.beginPath();
    ctx.arc(hoverTile % G.W + 0.5, Math.floor(hoverTile / G.W) + 0.5, 4.5, 0, Math.PI * 2);
    ctx.stroke();
  }
  // placement preview for nukes
  if (placement && placement.kind === 'nuke' && hoverTile >= 0) {
    const r = placement.type === 'hydrogen' ? 60 : 25, ri = placement.type === 'hydrogen' ? 40 : 10;
    const hx = hoverTile % G.W + 0.5, hy = Math.floor(hoverTile / G.W) + 0.5;
    ctx.lineWidth = 1 / cam.zoom;
    ctx.strokeStyle = 'rgba(255,60,60,0.9)'; ctx.beginPath(); ctx.arc(hx, hy, ri, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,60,60,0.5)'; ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI * 2); ctx.stroke();
  }

  // screen-space overlays
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const toScreen = (wx, wy) => [cam.x + wx * cam.zoom, cam.y + wy * cam.zoom];

  // labels
  if (G.tick - G.lastLabelTick >= 10) { computeLabels(); G.lastLabelTick = G.tick; }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (const [sm, l] of G.labels) {
    const p = G.players.get(sm);
    if (!p) continue;
    const size = Math.min(22, Math.sqrt(l.n) * cam.zoom * 0.35);
    if (size < 7) continue;
    const [x, y] = toScreen(l.x, l.y);
    if (x < -100 || y < -50 || x > window.innerWidth + 100 || y > window.innerHeight + 50) continue;
    ctx.font = `bold ${size}px system-ui, sans-serif`;
    ctx.lineWidth = Math.max(2, size / 5);
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.fillStyle = '#fff';
    ctx.strokeText(p.name, x, y - size * 0.55);
    ctx.fillText(p.name, x, y - size * 0.55);
    ctx.font = `${size * 0.85}px system-ui, sans-serif`;
    const troopsTxt = fmt(p.troops);
    ctx.strokeText(troopsTxt, x, y + size * 0.55);
    ctx.fillText(troopsTxt, x, y + size * 0.55);
  }

  // units
  const uSize = Math.max(7, Math.min(16, 3 * cam.zoom));
  for (const u of G.units) {
    const [, type, ownerSm, tile, level, building, cooldown] = u;
    const p = G.players.get(ownerSm);
    const [x, y] = toScreen(tile % G.W + 0.5, Math.floor(tile / G.W) + 0.5);
    if (x < -20 || y < -20 || x > window.innerWidth + 20 || y > window.innerHeight + 20) continue;
    ctx.beginPath();
    ctx.arc(x, y, uSize, 0, Math.PI * 2);
    ctx.fillStyle = p ? p.color : '#888';
    ctx.globalAlpha = building > 0 ? 0.5 : 1;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = cooldown > 0 ? '#ff5252' : '#111';
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = `${uSize * 1.2}px system-ui, sans-serif`;
    ctx.fillStyle = '#fff';
    ctx.fillText(UNIT_INFO[type] ? UNIT_INFO[type].icon : '?', x, y + 1);
    if (level > 1) {
      ctx.font = `bold ${uSize * 0.9}px system-ui, sans-serif`;
      ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
      ctx.strokeText(String(level), x + uSize * 0.8, y - uSize * 0.8);
      ctx.fillText(String(level), x + uSize * 0.8, y - uSize * 0.8);
    }
  }

  // boats
  for (const b of G.boats) {
    const [, ownerSm, bx, by, troops] = b;
    const p = G.players.get(ownerSm);
    const [x, y] = toScreen(bx + 0.5, by + 0.5);
    const s = Math.max(4, Math.min(10, 2 * cam.zoom));
    ctx.fillStyle = p ? p.color : '#fff';
    ctx.strokeStyle = '#000'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x - s, y - s * 0.6); ctx.lineTo(x + s, y - s * 0.6); ctx.lineTo(x + s * 0.6, y + s * 0.6); ctx.lineTo(x - s * 0.6, y + s * 0.6); ctx.closePath();
    ctx.fill(); ctx.stroke();
    if (cam.zoom > 1.5) {
      ctx.font = `bold ${Math.max(9, s * 1.1)}px system-ui, sans-serif`;
      ctx.fillStyle = '#fff'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
      ctx.strokeText(fmt(troops), x, y - s * 1.6); ctx.fillText(fmt(troops), x, y - s * 1.6);
    }
  }

  // nukes
  for (const nk of G.nukes) {
    const [, type, ownerSm, nx, ny, tx, ty] = nk;
    const p = G.players.get(ownerSm);
    const [x, y] = toScreen(nx + 0.5, ny + 0.5);
    const [gx, gy] = toScreen(tx + 0.5, ty + 0.5);
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,80,80,0.8)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(gx, gy); ctx.stroke();
    ctx.setLineDash([]);
    const r = (type === 'hydrogen' ? 60 : 25) * cam.zoom;
    ctx.beginPath(); ctx.arc(gx, gy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#ff5252'; ctx.fill(); ctx.strokeStyle = p ? p.color : '#fff'; ctx.lineWidth = 2; ctx.stroke();
  }

  // explosion effects
  const now = performance.now();
  G.effects = G.effects.filter((e) => now - e.t0 < e.dur);
  for (const e of G.effects) {
    const k = (now - e.t0) / e.dur;
    const [x, y] = toScreen(e.x + 0.5, e.y + 0.5);
    ctx.beginPath(); ctx.arc(x, y, e.r * cam.zoom * (0.3 + 0.7 * k), 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,${Math.floor(200 - 150 * k)},50,${0.6 * (1 - k)})`; ctx.fill();
    ctx.strokeStyle = `rgba(255,255,255,${1 - k})`; ctx.lineWidth = 2; ctx.stroke();
  }

  // attack markers: pulse on the target's label for own attacks is enough; draw source markers for boats' landing? skip
  if (G.phase === 'spawn') renderBanner();
}

// =============================================================================
// Boot
// =============================================================================
const m = location.pathname.match(/^\/g\/([A-Za-z0-9]{4,6})/);
if (m) { net.pendingJoin = m[1].toUpperCase(); history.replaceState(null, '', '/'); }
$('name-input').value = net.name;
connect();
requestAnimationFrame(draw);
// Keep free-tier hosts (Render etc.) from idling out mid-game: an HTTP ping every 4 minutes.
setInterval(() => { if (net.connected) fetch('/healthz').catch(() => {}); }, 4 * 60 * 1000);
})();
