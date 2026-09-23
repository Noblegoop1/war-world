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
// Research effect markup from the server: {text|g} good for the owner, {text|r} a cost to the owner,
// {text|p} something done to other nations, {text|b} just bold. Everything else is escaped.
function fxMarkup(str) {
  return esc(str || '').replace(/\{([^|{}]+)\|([grpb])\}/g, (_, t, c) => `<b class="fx-${c}">${t}</b>`);
}
function showTip(html, x, y) {
  const t = $('tip');
  t.innerHTML = html;
  t.classList.remove('hidden');
  const w = t.offsetWidth, h = t.offsetHeight;
  t.style.left = `${clamp(x + 14, 6, window.innerWidth - w - 6)}px`;
  t.style.top = `${clamp(y - h - 10, 6, window.innerHeight - h - 6)}px`;
}
function hideTip() { $('tip').classList.add('hidden'); }
function fmtClock(ticks) { const sec = Math.max(0, Math.ceil(ticks / 10)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`; }

// =============================================================================
// Assets (OpenFront icons/sprites, CC BY-SA 4.0)
// =============================================================================
const ICON_FILES = {
  city: 'CityIconWhite', port: 'AnchorIcon', defense: 'ShieldIconWhite', silo: 'MissileSiloIconWhite', sam: 'SamLauncherIconWhite',
  factory: 'FactoryIconWhite', warship: 'BattleshipIconWhite', mine: 'ExplosionIconWhite',
  atom: 'NukeIconWhite', hydrogen: 'MushroomCloudIconWhite', sword: 'SwordIconWhite', boat: 'BoatIconWhite', ally: 'AllianceIconWhite',
  allyReq: 'AllianceRequestWhiteIcon', traitor: 'TraitorIconWhite', donateGold: 'DonateGoldIconWhite', donateTroop: 'DonateTroopIconWhite',
  build: 'BuildIconWhite', info: 'InfoIconSolidWhite', crown: 'CrownIcon', target: 'TargetIconWhite', troops: 'TroopIconWhite', x: 'XIcon',
  trade: 'TradeShipIconWhite', population: 'PopulationIconSolidWhite', explosion: 'ExplosionIconWhite', disconnected: 'DisconnectedIcon', back: 'XIcon',
  // supplied as raster art rather than the OpenFront SVG set, so they carry their extension
  airport: 'AirportIconWhite.png', airship: 'AirshipIconWhite.png',
};
const SPRITE_FILES = { transport: 'transportship', warship: 'warship', trade: 'tradeship', atom: 'atombomb', hydrogen: 'hydrogenbomb', samMissile: 'samMissile', trainEngine: 'trainEngine', trainCar: 'trainCarriage' };
const icons = {};
const iconURL = {};
const sprites = {};
const spriteCache = new Map();
function loadAssets() {
  const tasks = [];
  for (const [name, file] of Object.entries(ICON_FILES)) {
    tasks.push(new Promise((resolve) => {
      const im = new Image();
      im.onload = () => {
        const c = document.createElement('canvas'); c.width = 64; c.height = 64;
        const x = c.getContext('2d');
        // fit rather than stretch: the airship is twice as wide as it is tall and squashing it into a
        // square turns it into a balloon
        const k = Math.min(64 / im.width, 64 / im.height);
        const w = im.width * k, h = im.height * k;
        x.drawImage(im, (64 - w) / 2, (64 - h) / 2, w, h);
        if (name !== 'crown') { x.globalCompositeOperation = 'source-in'; x.fillStyle = '#fff'; x.fillRect(0, 0, 64, 64); }
        icons[name] = c; iconURL[name] = c.toDataURL(); resolve();
      };
      im.onerror = () => resolve();
      im.src = `/assets/icons/${file}${file.includes('.') ? '' : '.svg'}`;
    }));
  }
  for (const [name, file] of Object.entries(SPRITE_FILES)) {
    tasks.push(new Promise((resolve) => { const im = new Image(); im.onload = () => { sprites[name] = im; resolve(); }; im.onerror = () => resolve(); im.src = `/assets/sprites/${file}.png`; }));
  }
  return Promise.all(tasks);
}
// An icon recoloured to a nation's colour. Same trick the loader uses to force them white, just with
// the owner's colour instead, cached per colour.
const tintCache = new Map();
function tintedIcon(name, colorHex) {
  const key = `${name}|${colorHex}`;
  let c = tintCache.get(key);
  if (c) return c;
  const src = icons[name];
  if (!src) return null;
  c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
  const x = c.getContext('2d');
  x.drawImage(src, 0, 0);
  x.globalCompositeOperation = 'source-in';
  x.fillStyle = colorHex;
  x.fillRect(0, 0, c.width, c.height);
  tintCache.set(key, c);
  return c;
}
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

// ---- catalog (costs mirror server/game/config.js) ----
const UNIT_INFO = {
  city: { label: 'City', key: '1', desc: '+250K max troops. Build on it again to upgrade. Joins the rail network when a Factory is in range.', cost: (n) => Math.min(1e6, Math.pow(2, n) * 125000) },
  port: { label: 'Port', key: '2', desc: 'Sea coast only. Sends trade ships to other nations\' ports for gold; launches Warships.', cost: (n) => Math.min(1e6, Math.pow(2, n) * 125000) },
  factory: { label: 'Factory', key: '3', desc: 'Lays rail to every City/Port/Factory/Lab within 110 tiles and runs trains that pay gold on arrival (25K from other nations, 35K allies). Upgrade to level 2 to build Mechs — higher levels make tougher, longer-ranged Mechs.', cost: (n) => Math.min(1e6, Math.pow(2, n) * 125000) },
  defense: { label: 'Defense Post', key: '4', desc: 'Attackers within 30 tiles lose 5x troops and advance 3x slower. Shells enemy ships within 75 tiles.', cost: (n) => Math.min(250000, (n + 1) * 50000) },
  silo: { label: 'Missile Silo', key: '5', desc: 'Launches atom / hydrogen bombs (90 tick reload) and Bomber strikes.', cost: () => 1000000 },
  sam: { label: 'SAM Launcher', key: '6', desc: 'Shoots down nukes within 70 tiles.', cost: (n) => Math.min(3e6, (n + 1) * 1500000) },
  lab: { label: 'Research Lab', key: '7', desc: 'Needs 3 Cities, must be within rail range of a Factory and away from Cities. Offers 3 random doctrines; pick one (60s). Max 2 per game.', cost: () => 1000000 },
  wall: { label: 'Wall', key: '8', desc: 'Click-and-drag a line on your land: a 3-tile-thick wall, built block by block (slowest build). Snaps to the coast. Enemies must grind it down and can\'t pass behind it. Price climbs steeply. Nukes raze it.', cost: () => 0 },
  mech: { label: 'Mech', key: '9', desc: 'From a level-2 Factory. Click where it should patrol: it walks there, circles, shells hostile structures/mechs/land in range and stomps the ground — hit land turns NEUTRAL (troops must claim it). Slow, land-locked, super tanky; bleeds HP inside enemy land. Click it, then a tile, to move it.', cost: (n) => 2000000 + n * 2500000 },
  warship: { label: 'Warship', key: '0', desc: 'Needs a Port. Click water to set its patrol area (100 tiles): it hunts enemy boats, trade ships and warships with shells. Built at its Port\u2019s level (+35% health, +25% damage per level). You may field 3, plus 1 for every level-3 Port (2 for a level-4). Click it, then water, to move it.', cost: (n) => Math.min(1e6, (n + 1) * 250000) },
  submarine: { label: 'Submarine', key: '', desc: 'Invisible unless within 10 tiles of an enemy warship. Every 90s fires 3 missiles that each wreck one structure in 80 tiles and ignore SAMs.', cost: (n) => Math.min(2.5e6, (n + 1) * 625000), needs: 'submarine_warfare' },
  mine: { label: 'Naval Mine', key: '', desc: 'Place on the sea within 60 tiles of your port. Destroys any enemy ship or boat passing within 2 tiles.', cost: () => 50000, needs: 'naval_mines' },
  artillery: { label: 'Artillery Battery', key: '', desc: 'A static gun with 45-tile reach. It shells enemy Mechs first — this is the answer to a Mech parked on your border — and otherwise drops shells on the nearest attack coming at you. It never takes ground.', cost: (n) => Math.min(2500000, (n + 1) * 400000) },
  repair: { label: 'Repair Yard', key: '', desc: 'Heals your Mechs and rebuilds damaged wall tiles within 40 tiles. Put it behind the front, not on it.', cost: (n) => Math.min(2000000, (n + 1) * 500000), needs: 'field_engineering' },
  airport: { label: 'Airport', key: '', desc: 'One per nation, and enormously expensive. Flies Airships over SAMs, warships and coastal defenses to drop troops inland — the way into a nation that has sealed every other route. Your own SAMs cannot sit within 70 tiles of it unless you research Airbase Network.', cost: () => 8000000 },
  airship: { label: 'Airship', key: '', desc: 'Carries 5% of your troops (10% with Strategic Airlift) to any land tile in range. SAMs cannot touch it and warships cannot reach it; only an enemy Interceptor Screen can bring it down. Max 3 in the air, each one costs more than the last.', cost: (n) => 1000000 + n * 750000 },
  bomber: { label: 'Bomber Strike', key: '', desc: 'Click an enemy structure within 250 tiles of your silo: a bomber flies over and destroys it. Fighter Networks can shoot it down.', cost: () => 300000, needs: 'strategic_bombers' },
};
const NUKE_INFO = {
  cluster: { label: 'Cluster Strike', key: '', desc: 'Eight small missiles fired at once, scattering over ~20 tiles. A SAM stops one missile per reload, so a volley gets most of its load through an umbrella that would swallow a single bomb.', cost: 1500000, needs: 'cluster_munitions' },
  atom: { label: 'Atom Bomb', key: 'N', desc: 'Lobbed from your nearest silo. Destroys everything within 12 tiles, most within 30. SAMs can intercept it.', cost: 750000 },
  hydrogen: { label: 'Hydrogen Bomb', key: 'H', desc: 'Destroys everything within 80 tiles, most within 100.', cost: 5000000 },
};
const HOTBAR = ['city', 'port', 'factory', 'defense', 'silo', 'sam', 'lab', 'wall', 'mech', 'warship'];
const HOTBAR2 = ['artillery', 'repair', 'airport', 'airship', 'atom', 'hydrogen', 'cluster', 'submarine', 'mine', 'bomber'];
const ICON_FOR = { city: 'city', port: 'port', factory: 'factory', defense: 'defense', silo: 'silo', sam: 'sam', lab: 'info', wall: 'build', mech: 'target', warship: 'warship', submarine: 'warship', mine: 'mine', bomber: 'explosion', atom: 'atom', hydrogen: 'hydrogen', cluster: 'explosion', artillery: 'sword', repair: 'troops', airport: 'airport', airship: 'airship' };
let RESEARCH_DEFS = [];

// =============================================================================
// Networking
// =============================================================================
const net = { ws: null, token: sessionStorage.getItem('fr_token') || '', name: localStorage.getItem('fr_name') || '', id: null, connected: false, pendingJoin: null, maps: [] };
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
      // only worth saying when this page is served from the host's own machine, not from a hosting service
      const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(location.hostname);
      $('menu-status').textContent = local && m.lan && m.lan.length ? `Friends on your network can join at http://${m.lan[0]}:${m.port}` : '';
      if (net.pendingJoin) { send({ t: 'join', code: net.pendingJoin }); net.pendingJoin = null; }
      else if (screen === 'menu') send({ t: 'list' });
      break;
    case 'lobbies': renderPublicList(m.lobbies); break;
    case 'lobby': lobby = m.lobby; if (screen !== 'game') show('lobby'); renderLobby(); break;
    case 'left': lobby = null; G.active = false; show('menu'); send({ t: 'list' }); break;
    case 'error': toast(m.msg); $('menu-status').textContent = m.msg; $('loading').classList.add('hidden'); break;
    case 'toast': toast(m.msg, !!m.info); break;
    case 'chat': addChat(m.from, m.text); break;
    case 'start': startGame(m); break;
    case 'tick': applyTick(m); break;
    case 'ctl': G.ctl = { paused: m.paused, speed: m.speed }; renderTopRight(); break;
    case 'wallQuote': if (wallDraw) wallDraw.quote = m; break;
    case 'inspect': renderInspect(m); break;
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
  active: false, W: 0, H: 0, numLand: 1, terrain: null, owner: null, fallout: null, wall: null,
  players: new Map(), me: 0, tick: 0, phase: 'spawn', spawnLeft: 0, settings: null, mapName: '',
  units: [], attacks: [], boats: [], trade: [], nukes: [], ships: [], mechs: [], airships: [], shells: [], trains: [], rails: [], bombers: [],
  allyReqs: [], effects: [], winner: 0, labels: new Map(), lastLabelTick: -100, ctl: { paused: false, speed: 1 }, unitByTile: new Map(),
  lastPacketAt: 0,
};
const cam = { x: 0, y: 0, zoom: 1 };
const opts = { labels: true, structures: true, events: true };
window.__debug = { G, cam, net, get lobby() { return lobby; } };
const canvas = $('game-canvas');
const ctx = canvas.getContext('2d');
let terrainCanvas = null, ownerCanvas = null, ownerCtx = null, ownerImg = null, ownerDirty = false;
let ratio = 0.2;
let placement = null;   // {kind:'build', unit} | {kind:'nuke', type} | {kind:'wall'} | {kind:'mech', from}
let selected = null;    // { kind:'mech'|'ship', id }
let hoverTile = -1;
let pinnedCard = 0;
let spectating = false;
let mechFrom = -1;
// How close a click has to land to grab one of your own mobile units, in SCREEN pixels. Screen space is
// the point: the old tile-space radius shrank as you zoomed in, so at high zoom you could click the
// middle of a mech's icon and still hit the ground underneath it.
const PICK_RADIUS_PX = 30;
const MOBILE_KINDS = ['mech', 'warship', 'submarine'];
let hoverUnit = null;   // own mobile unit under the cursor, for the hover ring
let selection = [];     // several units selected by shift-dragging a box
let boxSelect = null;   // {x0,y0,x1,y1,kind} while dragging

function me() { return G.players.get(G.me); }
function pname(sm) { const p = G.players.get(sm); return p ? p.name : (sm === 0 ? 'Unclaimed land' : '?'); }
function flagBadge(q) {
  const swatch = `<span class=&quot;swatch&quot; style=&quot;background:${q.color}&quot;></span>`;
  if (q.flag) return `<img class="flag" src="/flags/${esc(q.flag)}.svg" alt="" onerror="this.outerHTML='${swatch}'">`;
  return `<span class="swatch" style="background:${q.color}"></span>`;
}
function tileX(i) { return i % G.W; }
function tileY(i) { return (i / G.W) | 0; }
function isLand(i) { const t = G.terrain[i]; return (t & 0x80) !== 0 && (t & 0x1f) !== 31; }
function isWater(i) { return (G.terrain[i] & 0x80) === 0; }
function myHas(id) { const p = me(); return !!(p && p.researches && p.researches.includes(id)); }

// Smooth motion: mobiles report a position every tick (100ms); we interpolate toward it on each frame.
const lerpState = new Map();
setInterval(() => {
  const cutoff = performance.now() - 5000;
  for (const [id, s] of lerpState) if ((s.seen ?? s.at) < cutoff) lerpState.delete(id);
}, 5000);
function lerpPos(id, x, y) {
  const now = performance.now();
  let s = lerpState.get(id);
  if (!s) { s = { x, y, tx: x, ty: y, at: now, seen: now }; lerpState.set(id, s); return [x, y]; }
  s.seen = now;
  if (s.tx !== x || s.ty !== y) { s.x = s.dx ?? s.tx; s.y = s.dy ?? s.ty; s.tx = x; s.ty = y; s.at = now; }
  const k = clamp((now - s.at) / 120, 0, 1);
  s.dx = s.x + (s.tx - s.x) * k; s.dy = s.y + (s.ty - s.y) * k;
  return [s.dx, s.dy];
}

function startGame(m) {
  const s = m.state;
  G.active = true;
  G.W = s.width; G.H = s.height; G.numLand = s.numLand; G.mapName = s.mapName || '';
  G.terrain = b64ToBytes(s.terrain);
  const ob = b64ToBytes(s.owner);
  G.owner = new Uint16Array(ob.buffer, ob.byteOffset, ob.byteLength / 2);
  G.fallout = b64ToBytes(s.fallout);
  G.wall = new Uint8Array(G.W * G.H);
  G.fort = null; G.fortKey = '';
  if (s.walls) { const wb = b64ToBytes(s.walls); const wh = new Uint16Array(wb.buffer, wb.byteOffset, wb.byteLength / 2); for (let i = 0; i < wh.length; i++) if (wh[i]) G.wall[i] = 1; }
  G.mechs = s.mechs || []; G.airships = []; G.rails = s.rails || []; G.ships = []; G.shells = []; G.trains = []; G.bombers = [];
  RESEARCH_DEFS = s.research || [];
  wallDraw = null; selected = null; mechFrom = -1; lerpState.clear();
  closeResearchPicker();
  G.me = m.you;
  G.tick = s.tick; G.phase = s.phase; G.spawnLeft = Math.max(0, s.spawnTicks - s.tick);
  G.settings = s.settings;
  G.ctl = m.ctl || { paused: false, speed: s.settings.gameSpeed };
  G.players = new Map();
  for (const p of s.players) {
    const rgb = hexToRgb(p.color);
    const border = darken(rgb, 0.125);
    G.players.set(p.sm, { ...p, rgb, border, borderHex: rgbToHex(border), troops: 0, gold: 0, tiles: 0, flags: 0, maxTroops: 0, allies: [], income: 0, researches: [] });
  }
  applyStats(s.stats);
  applyPrivate(m.me);
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
  rebuildFortified();
  for (let i = 0; i < G.W * G.H; i++) if (G.owner[i] || G.fallout[i] || G.wall[i]) paintTile(i);
  ownerDirty = true;
  show('game');
  needFit = true;
  renderHotbar(); renderHud(); renderTopRight(); renderBanner();
  logEvent(G.phase === 'spawn' ? 'Click on land to choose where you start.' : 'Reconnected to the game.', 'good');
}

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
// Which border tiles are covered by a defense post. Purely cosmetic and computed here rather than sent,
// since the client already knows every post's tile and range. Recomputed only when the set of posts
// changes, and only the affected discs get repainted.
function defensePostKey() {
  let k = '';
  for (const u of G.units) if (u[1] === 'defense' && u[5] === 0) k += u[3] + ':' + u[2] + ',';
  return k;
}
function rebuildFortified() {
  const key = defensePostKey();
  if (key === G.fortKey) return;
  const prev = G.fort;
  G.fortKey = key;
  const n = G.W * G.H;
  G.fort = new Uint16Array(n);
  const r = 30;
  const touched = [];
  for (const u of G.units) {
    if (u[1] !== 'defense' || u[5] !== 0) continue;
    const cx = tileX(u[3]), cy = tileY(u[3]);
    touched.push([cx, cy]);
    for (let dy = -r; dy <= r; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= G.H) continue;
      for (let dx = -r; dx <= r; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= G.W || dx * dx + dy * dy > r * r) continue;
        G.fort[y * G.W + x] = u[2];
      }
    }
  }
  if (!prev) return;   // first build: the initial full paint covers it
  // repaint anything whose fortified state changed
  for (let i = 0; i < n; i++) if (prev[i] !== G.fort[i] && G.owner[i]) paintTile(i);
  ownerDirty = true;
}
function isBorder(i) {
  const o = G.owner[i], W = G.W, x = i % W, y = (i / W) | 0;
  if (x === 0 || y === 0 || x === W - 1 || y === G.H - 1) return true;
  return G.owner[i - 1] !== o || G.owner[i + 1] !== o || G.owner[i - W] !== o || G.owner[i + W] !== o;
}
function paintTile(i) {
  const d = ownerImg.data, k = i * 4;
  const o = G.owner[i];
  // Irradiated ground reads as a sickly green-grey scar, on top of whoever owns it. It wears off.
  if (G.fallout[i]) {
    const lit = ((i % G.W) + ((i / G.W) | 0)) & 3;
    d[k] = 104 + lit * 6; d[k + 1] = 124 + lit * 8; d[k + 2] = 86 + lit * 4; d[k + 3] = o ? 215 : 195;
    return;
  }
  if (o === 0) { d[k + 3] = 0; return; }
  const p = G.players.get(o);
  if (!p) { d[k + 3] = 0; return; }
  if (G.wall[i]) { // wall: dark stone, lighter seam on the border of the wall band
    const edge = !(G.wall[i - 1] && G.wall[i + 1] && G.wall[i - G.W] && G.wall[i + G.W]);
    d[k] = edge ? 88 : 62; d[k + 1] = edge ? 88 : 62; d[k + 2] = edge ? 96 : 70; d[k + 3] = 255;
    return;
  }
  if (isBorder(i)) {
    // a border tile under one of its owner's defense posts is drawn as pale stone: it costs more
    // troops and more time to take (see defensePostBorderBonus on the server)
    if (G.fort && G.fort[i] === o) { d[k] = 226; d[k + 1] = 232; d[k + 2] = 240; d[k + 3] = 255; }
    else { d[k] = p.border[0]; d[k + 1] = p.border[1]; d[k + 2] = p.border[2]; d[k + 3] = 255; }
  }
  else { d[k] = p.rgb[0]; d[k + 1] = p.rgb[1]; d[k + 2] = p.rgb[2]; d[k + 3] = 150; }
}
function setTile(i, val) {
  G.owner[i] = val & 0x3fff;
  G.fallout[i] = val & 0x8000 ? 1 : 0;
  G.wall[i] = val & 0x4000 ? 1 : 0;
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
    const r = s[8] || [[], null, null];
    p.income2 = s[19] || null;   // [base, land, cities, peace, trade, train, conquest, plunder] per second
    p.wars = s[20] || [];        // nations this one has declared war on
    p.power = s[21] || null;     // [troops home, mechs, navy, silos, posts, research x, troops out]
    p.researches = r[0] || []; p.researching = r[1];
    p.atk = s[9] || 0; p.eco = s[10] || 0; p.walls = s[11] || 0; p.mechCount = s[12] || 0; p.warshipCount = s[13] || 0; p.subCount = s[14] || 0;
    p.deployed = s[15] || 0; p.airships = s[16] || 0; p.airshipsBuilt = s[17] || 0; p.maxResearch = s[18] || 2;
    p.spawned = !!(s[4] & 1); p.alive = !!(s[4] & 2); p.traitor = !!(s[4] & 4); p.offline = !!(s[4] & 8);
  }
}
function setUnits(list) {
  G.units = list;
  G.unitByTile = new Map();
  for (const u of list) G.unitByTile.set(u[3], u);
  rebuildFortified();
}
// Private state for this player only (the server never sends it to anyone else).
function applyPrivate(me) {
  if (!me) return;
  const p = G.players.get(G.me);
  if (!p) return;
  p.choices = me.choices || null;
  if (me.prices) G.myPrices = me.prices;
  if (me.caps) G.myCaps = me.caps;
  if (p.choices && p.choices.length && !researchPickerOpen && !researchDismissed) openResearchPicker(p.choices);
}
function applyTick(m) {
  if (!G.active) return;
  G.tick = m.tick;
  G.lastPacketAt = performance.now();
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
  if (m.mechs) G.mechs = m.mechs;
  if (m.airships) G.airships = m.airships;
  if (Array.isArray(m.ships)) G.ships = m.ships;
  if (m.shells) G.shells = m.shells;
  if (m.trains) G.trains = m.trains;
  if (m.bombers) G.bombers = m.bombers;
  if (m.rails) G.rails = m.rails;
  if (m.allyReqs) syncAllyRequests(m.allyReqs.filter((r) => r[1] === net.id).map((r) => r[0]));
  if (m.me) applyPrivate(m.me);
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
  const mine = (sm) => sm === G.me;
  switch (e.k) {
    case 'phase': logEvent('The game has begun. Expand!', 'good'); break;
    case 'attacked': logEvent(`<b>${esc(pname(e.by))}</b> is attacking you with ${fmt(e.troops)} troops`, 'bad'); break;
    case 'conquered': logEvent(`${esc(pname(e.by))} conquered ${esc(pname(e.p))}${e.gold ? ` (+${fmt(e.gold)} gold)` : ''}`, mine(e.p) ? 'bad' : (mine(e.by) ? 'good' : '')); break;
    case 'death': logEvent(`${esc(pname(e.p))} was eliminated${e.by ? ' by ' + esc(pname(e.by)) : ''}`, mine(e.p) ? 'bad' : ''); if (mine(e.p)) { spectating = true; $('spectate-banner').textContent = 'You were eliminated — spectating'; $('spectate-banner').classList.remove('hidden'); } break;
    case 'nuke': logEvent(`☢ ${esc(pname(e.by))} launched a${e.type === 'hydrogen' ? ' hydrogen' : 'n atom'} bomb${e.target ? ' at ' + esc(pname(e.target)) : ''}`, mine(e.target) ? 'bad' : ''); break;
    case 'boom': G.effects.push({ x: e.x, y: e.y, r: e.type === 'hydrogen' ? 100 : e.type === 'warhead' ? 18 : 30, t0: performance.now(), dur: 1800 }); break;
    case 'mirvSplit': logEvent('A MIRV split into warheads!', 'bad'); break;
    case 'warDeclared': logEvent(`⚔ <b>${esc(pname(e.by))}</b> declared war on <b>${esc(pname(e.on))}</b>`, mine(e.on) ? 'bad' : mine(e.by) ? 'good' : ''); break;
    case 'peace': logEvent(`🕊 ${esc(pname(e.by))} made peace with ${esc(pname(e.with))}`, mine(e.with) || mine(e.by) ? 'good' : ''); break;
    case 'decoy': logEvent(`${esc(pname(e.by))}'s SAM was fooled by a decoy`, mine(e.by) ? 'bad' : ''); G.effects.push({ x: e.x, y: e.y, r: 5, t0: performance.now(), dur: 600, ring: true }); break;
    case 'refitStart': if (mine(e.p)) logEvent(`A ${e.kind} is heading home to refit to level ${e.level}`); break;
    case 'refitDone': if (mine(e.p)) logEvent(`${e.kind === 'mech' ? 'Mech' : e.kind === 'warship' ? 'Warship' : 'Submarine'} refitted to <b>level ${e.level}</b>`, 'good'); break;
    case 'refitCancelled': if (mine(e.p)) logEvent(`Refit cancelled: ${esc(e.why || '')}`, 'bad'); break;
    case 'samhit': logEvent(`${esc(pname(e.by))}'s SAM shot down a nuke`, mine(e.by) ? 'good' : ''); G.effects.push({ x: e.x, y: e.y, r: 8, t0: performance.now(), dur: 700 }); break;
    case 'allyRequest': break;
    case 'allyRejected': logEvent(`${esc(pname(e.by))} rejected your alliance request`); break;
    case 'allied': logEvent(`${esc(pname(e.a))} and ${esc(pname(e.b))} are now allies`, (mine(e.a) || mine(e.b)) ? 'good' : ''); break;
    case 'betrayed': logEvent(`${esc(pname(e.by))} betrayed ${esc(pname(e.p))}!`, mine(e.p) ? 'bad' : ''); break;
    case 'donate': logEvent(`${esc(pname(e.from))} sent ${e.troops ? fmt(e.troops) + ' troops' : ''}${e.troops && e.gold ? ' and ' : ''}${e.gold ? fmt(e.gold) + ' gold' : ''} to ${esc(pname(e.to))}`, mine(e.to) ? 'good' : ''); break;
    case 'trade': logEvent(`Trade ship arrived: +${fmt(e.gold)} gold (with ${esc(pname(e.p))})`, 'good'); break;
    case 'train': logEvent(`Train delivered +${fmt(e.gold)} gold (to ${esc(pname(e.p))})`, 'good'); break;
    case 'win': logEvent(`🏆 ${esc(pname(e.p))} won the game!`, mine(e.p) ? 'good' : ''); break;
    case 'labBuilt': if (mine(e.p)) logEvent('Research Lab built — a choice of doctrines will appear when it is ready.', 'good'); break;
    case 'researchOffer': researchDismissed = false; openResearchPicker(e.choices); break;
    case 'researchStart': logEvent(`${esc(pname(e.p))} began researching <b>${esc(researchName(e.id))}</b>`, mine(e.p) ? 'good' : ''); break;
    case 'researchDone': logEvent(`${esc(pname(e.p))} completed <b>${esc(researchName(e.id))}</b>`, mine(e.p) ? 'good' : ''); if (mine(e.p)) renderHotbar(); break;
    case 'factoryUp': if (mine(e.p)) logEvent(`Factory upgraded to level ${e.level}${e.level === 2 ? ' — Mechs unlocked!' : ''}`, 'good'); break;
    case 'mech': logEvent(`${esc(pname(e.by))} deployed a <b>Mech</b>`, mine(e.by) ? 'good' : 'bad'); break;
    case 'mechLost': logEvent(`${esc(pname(e.p))} lost a Mech`, mine(e.p) ? 'bad' : 'good'); G.effects.push({ x: e.x, y: e.y, r: 6, t0: performance.now(), dur: 1200 }); break;
    case 'warship': if (mine(e.p)) logEvent('Warship launched', 'good'); break;
    case 'sub': if (mine(e.p)) logEvent('Submarine launched', 'good'); break;
    case 'sunk': logEvent(`${esc(pname(e.by))} sank ${esc(pname(e.p))}'s ${e.kind === 'boat' ? 'transport' : e.kind === 'trade' ? 'trade ship' : e.kind}${e.gold ? ` (+${fmt(e.gold)} gold)` : ''}`, mine(e.p) ? 'bad' : mine(e.by) ? 'good' : ''); G.effects.push({ x: e.x, y: e.y, r: 3, t0: performance.now(), dur: 900 }); break;
    case 'structHit': logEvent(`${esc(pname(e.p))}'s ${UNIT_INFO[e.type] ? UNIT_INFO[e.type].label : e.type} was destroyed`, mine(e.p) ? 'bad' : ''); G.effects.push({ x: e.x, y: e.y, r: 4, t0: performance.now(), dur: 900 }); break;
    case 'shellHit': G.effects.push({ x: e.x, y: e.y, r: 2.5, t0: performance.now(), dur: 500 }); break;
    case 'stomp': G.effects.push({ x: e.x, y: e.y, r: e.r, t0: performance.now(), dur: 500, ring: true }); break;
    case 'mine': logEvent(`${esc(pname(e.by))}'s mine destroyed a ship`, mine(e.by) ? 'good' : ''); G.effects.push({ x: e.x, y: e.y, r: 4, t0: performance.now(), dur: 900 }); break;
    case 'volley': logEvent(`${esc(pname(e.p))}'s submarine fired a missile volley`, mine(e.p) ? 'good' : 'bad'); break;
    case 'bomber': logEvent(`${esc(pname(e.by))} sent a bomber at ${esc(pname(e.target))}`, mine(e.target) ? 'bad' : ''); break;
    case 'airship': logEvent(`\u2708 ${esc(pname(e.by))} launched an airship${e.target ? ' at ' + esc(pname(e.target)) : ''}`, mine(e.target) ? 'bad' : mine(e.by) ? 'good' : ''); break;
    case 'airshipDown': logEvent(`${esc(pname(e.by))}'s interceptors shot down ${esc(pname(e.p))}'s airship`, mine(e.by) ? 'good' : mine(e.p) ? 'bad' : ''); G.effects.push({ x: e.x, y: e.y, r: 5, t0: performance.now(), dur: 900 }); break;
    case 'airdrop': logEvent(`\u2708 ${esc(pname(e.by))} dropped ${fmt(e.troops)} troops${e.p ? ' into ' + esc(pname(e.p)) : ''}`, mine(e.p) ? 'bad' : mine(e.by) ? 'good' : ''); G.effects.push({ x: e.x, y: e.y, r: 6, t0: performance.now(), dur: 1200, ring: true }); break;
    case 'researchLost': logEvent(`${esc(pname(e.p))} lost the lab working on <b>${esc(researchName(e.id))}</b> — research cancelled`, mine(e.p) ? 'bad' : ''); break;
    case 'bomberDown': logEvent(`${esc(pname(e.by))}'s fighters shot down a bomber`, mine(e.by) ? 'good' : ''); G.effects.push({ x: e.x, y: e.y, r: 4, t0: performance.now(), dur: 900 }); break;
    case 'deterrence': logEvent(`☢ ${esc(pname(e.by))}'s nuclear deterrence retaliated against ${esc(pname(e.at))}`, 'bad'); break;
    default: break;
  }
}
function researchName(id) { const r = RESEARCH_DEFS.find((x) => x.id === id); return r ? r.name : id; }
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
  // Troop growth slows down as you approach your cap (OpenFront's curve), so the rate goes amber once
  // the cap is what is holding you back rather than your land.
  const full = clamp(p.troops / Math.max(1, p.maxTroops), 0, 1);
  const inc = $('cp-income');
  inc.textContent = `+${fmt(p.income)}/s`;
  inc.classList.toggle('slowing', full >= 0.7);
  inc.title = full >= 0.7
    ? 'Troop growth is being throttled by your maximum — build Cities or take land to raise the cap'
    : 'Troops per second';
  // Solid = troops at home. Lighter = troops you have committed to attacks, boats and garrisons; they
  // are still yours and still counted in the total, they are just not home right now.
  const out = p.deployed || 0;
  const homePct = clamp(100 * p.troops / Math.max(1, p.maxTroops), 0, 100);
  const outPct = clamp(100 * out / Math.max(1, p.maxTroops), 0, 100 - homePct);
  $('cp-troops-text').textContent = out
    ? `${fmt(p.troops)} + ${fmt(out)} out / ${fmt(p.maxTroops)}`
    : `${fmt(p.troops)} / ${fmt(p.maxTroops)}`;
  $('cp-troops-fill').style.width = `${homePct}%`;
  const dep = $('cp-troops-out');
  dep.style.left = `${homePct}%`;
  dep.style.width = `${outPct}%`;
  $('cp-gold-amt').textContent = fmt(p.gold);
  const gi = p.income2;
  if (gi) {
    const total = gi[0] + gi[1] + gi[2] + gi[4] + gi[5] + gi[6] + gi[7];
    const rate = $('cp-gold-rate');
    rate.textContent = `+${fmt(total)}/s`;
    rate.classList.toggle('peace', !!gi[3]);
  }
  renderResearchPanel();
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
    const marks = (p && p.allies.includes(q.sm) ? ' 🤝' : '') + (q.traitor ? ' 🗡' : '') + (q.offline ? ' ⛔' : '');
    return `<tr class="${q === p ? 'me' : ''} ${q.alive ? '' : 'dead'}" data-sm="${q.sm}"><td>${i}</td><td>${flagBadge(q)}</td><td>${esc(q.name)}${marks}</td><td>${(100 * q.tiles / G.numLand).toFixed(1)}%</td><td>${fmt(q.troops)}</td><td>${fmt(q.gold)}</td></tr>`;
  }).join('');
  $('leaderboard').querySelectorAll('tr[data-sm]').forEach((tr) => { tr.onclick = () => { const sm = Number(tr.dataset.sm); pinnedCard = sm; renderPlayerCard(sm, true); centerOn(sm); }; });
}
function renderResearchPanel() {
  const p = me(), el = $('research-panel');
  if (!p || !p.researching) { el.classList.add('hidden'); return; }
  const [id, left, total] = p.researching;
  const done = total ? clamp(1 - left / total, 0, 1) : 0;
  el.innerHTML = `<div class="rp-row"><span>🔬 <b>${esc(researchName(id))}</b></span><span class="rp-time">${fmtClock(left)}</span></div><div class="rp-bar"><div style="width:${(done * 100).toFixed(1)}%"></div></div>`;
  el.classList.remove('hidden');
  const def = RESEARCH_DEFS.find((x) => x.id === id);
  el.onmousemove = (e) => def && showTip(`<div class="tip-h">${esc(def.name)}</div><div>${fxMarkup(def.short)}</div>`, e.clientX, e.clientY);
  el.onmouseleave = hideTip;
}
// What ATK POWER is made of, for any nation.
function atkTipHtml(q) {
  const pw = q && q.power;
  if (!pw) return '<div class="tip-h">ATK POWER</div><div>How hard this nation can hit right now.</div>';
  const [home, mechs, navy, silos, posts, mult, out] = pw;
  const rows = [['Troops at home', home], ['Mechs', mechs], ['Navy', navy], ['Missile silos', silos], ['Defense posts', posts]].filter(([, v]) => v > 0);
  return `<div class="tip-h">⚔ ATK POWER ${fmt(q.atk || 0)}</div><div class="tip-sub">How hard ${esc(q.name)} can hit right now. Troops out fighting don't count until they come home, so this drops mid-war.</div>`
    + `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${fmt(v)}</td></tr>`).join('')}`
    + (mult > 1 ? `<tr><td>Military doctrines</td><td><b class="fx-g">×${mult.toFixed(2)}</b></td></tr>` : '')
    + (out > 0 ? `<tr><td>Troops away fighting</td><td class="muted">${fmt(out)}</td></tr>` : '') + '</table>'
    + '<div class="tip-sub" style="margin-top:4px">A healthy mech counts ~700K (less while it fights); each warship 120K, sub 200K, silo 250K, post 40K.</div>';
}
function ecoTipHtml(q) {
  const inc = q && q.income2;
  if (!inc) return '<div class="tip-h">ECONOMY</div><div>Gold earned per second.</div>';
  const rows = [['Base', inc[0]], ['Land', inc[1]], ['Cities', inc[2]], ['Trade ships', inc[4]], ['Trains', inc[5]], ['Conquest', inc[6]], ['Plunder', inc[7]]].filter(([, v]) => v > 0);
  const total = rows.reduce((a, [, v]) => a + v, 0);
  const notes = [];
  if (inc[3]) notes.push('<b class="fx-g">Peace dividend ×1.3</b> (no attacks on nations for 90s)');
  if ((q.wars || []).length) notes.push('<b class="fx-r">War economy ×0.8</b> (declared war)');
  return `<div class="tip-h">💰 ECONOMY +${fmt(total)}/s</div><div class="tip-sub">Everything ${esc(q.name)} earns per second, averaged over the last half minute.</div>`
    + (notes.length ? `<div class="tip-sub">${notes.join(' · ')}</div>` : '')
    + `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>+${fmt(v)}/s</td></tr>`).join('')}</table>`;
}
// Where your gold comes from, on hover over the gold box.
function goldTipHtml(p) {
  const inc = p.income2;
  if (!inc) return '';
  const rows = [['Base', inc[0]], ['Land', inc[1]], ['Cities', inc[2]], ['Trade ships', inc[4]], ['Trains', inc[5]], ['Conquest', inc[6]], ['Plunder', inc[7]]].filter(([, v]) => v > 0);
  const total = rows.reduce((a, [, v]) => a + v, 0);
  return `<div class="tip-h">Income +${fmt(total)}/s</div>`
    + (inc[3] ? '<div class="tip-sub"><b class="fx-g">Peace dividend ×1.3</b> on base, land and cities — you haven\u2019t attacked a nation in 90s</div>' : '<div class="tip-sub">Stop attacking nations for 90s to earn a <b class="fx-g">×1.3</b> peace dividend</div>')
    + `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>+${fmt(v)}/s</td></tr>`).join('')}</table>`
    + '<div class="tip-sub" style="margin-top:4px">Cities pay more every level; land pays by its square root.</div>';
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
function myUnitLevels(type) { let n = 0; for (const u of G.units) if (u[1] === type && u[2] === G.me && u[5] === 0) n += u[4]; return n; }
function haveReadySilo() { return G.units.some((u) => u[1] === 'silo' && u[2] === G.me && u[5] === 0 && u[6] === 0); }
function haveLevel2Factory() { return G.units.some((u) => u[1] === 'factory' && u[2] === G.me && u[5] === 0 && u[4] >= 2); }
function havePort() { return G.units.some((u) => u[1] === 'port' && u[2] === G.me && u[5] === 0); }
function itemCost(key) {
  const p = me();
  if (G.settings && G.settings.infiniteGold) return 0;
  // The server sends what things cost *you* right now (doctrines, counts and levels applied). Use it;
  // the formulas below are only a fallback for the first frame before it arrives.
  if (G.myPrices && key !== 'wall' && G.myPrices[key] !== undefined) return G.myPrices[key];
  if (key === 'airship') return UNIT_INFO.airship.cost(p ? p.airshipsBuilt || 0 : 0);
  if (key === 'airport') return 8000000;
  const disc = myHas('mass_production') ? 0.85 : 1;
  if (key === 'wall') return wallDraw && wallDraw.quote ? wallDraw.quote.cost : 0;
  if (key === 'mech') return UNIT_INFO.mech.cost(p ? p.mechCount || 0 : 0) * (myHas('mech_production') ? 0.6 : 1) * (myHas('military_industrial') ? 0.75 : 1) * disc;
  if (key === 'warship') { const n = p ? p.warshipCount || 0 : 0; return (UNIT_INFO.warship.cost(n) + (myHas('coastal_bombardment') ? 300000 * Math.floor(n / 10) : 0)) * disc; }
  if (key === 'submarine') return UNIT_INFO.submarine.cost(p ? p.subCount || 0 : 0) * disc;
  if (key === 'atom') return myHas('tactical_nukes') ? 400000 : 750000;
  if (key === 'hydrogen') return NUKE_INFO.hydrogen.cost;
  if (key === 'cluster') return NUKE_INFO.cluster.cost;
  if (key === 'port' || key === 'factory') return UNIT_INFO[key].cost(myUnitCount('port') + myUnitCount('factory')) * disc;
  return (UNIT_INFO[key] ? UNIT_INFO[key].cost(myUnitCount(key)) : 0) * disc;
}
function itemAvailable(key) {
  const p = me();
  if (!p) return false;
  const info = UNIT_INFO[key] || NUKE_INFO[key];
  if (info && info.needs && !myHas(info.needs)) return false;
  const nukesOff = G.settings && G.settings.disableNukes;
  if (nukesOff && ['silo', 'sam', 'atom', 'hydrogen', 'cluster', 'bomber'].includes(key)) return false;
  if (G.settings && G.settings.disableBoats && ['warship', 'submarine', 'mine'].includes(key)) return false;
  return true;
}
function itemCan(key) {
  const p = me();
  if (!p || !itemAvailable(key)) return false;
  const cost = itemCost(key);
  if (p.gold < cost) return false;
  if (key === 'lab' && (myUnitCount('city') < 3 || (p.researches.length + (p.researching ? 1 : 0) >= 2))) return false;
  if (key === 'mech' && !haveLevel2Factory()) return false;
  if ((key === 'warship' || key === 'submarine') && !havePort()) return false;
  if ((key === 'atom' || key === 'hydrogen' || key === 'cluster') && !haveReadySilo()) return false;
  if (key === 'bomber' && !myUnitCount('silo')) return false;
  if (key === 'airship' && !myUnitCount('airport')) return false;
  if (key === 'airport' && myUnitCount('airport') >= 1) return false;
  return true;
}
function isActivePlacement(key) {
  if (!placement) return false;
  if (placement.kind === 'wall') return key === 'wall';
  if (placement.kind === 'nuke') return placement.type === key;
  if (placement.kind === 'airship') return key === 'airship';
  return placement.unit === key;
}
function renderHotbar() {
  const p = me();
  const row = (keys) => keys.filter((k) => itemAvailable(k)).map((key) => {
    const info = UNIT_INFO[key] || NUKE_INFO[key];
    const count = key === 'airship' ? (p ? p.airships || 0 : 0)
      : key === 'mech' ? (p ? p.mechCount || 0 : 0) : key === 'warship' ? (p ? p.warshipCount || 0 : 0) : key === 'submarine' ? (p ? p.subCount || 0 : 0) : key === 'wall' ? (p ? p.walls || 0 : 0) : UNIT_INFO[key] && !['bomber'].includes(key) ? myUnitCount(key) : '';
    return `<div class="hb ${isActivePlacement(key) ? 'active' : ''} ${itemCan(key) ? '' : 'cant'}" data-key="${key}"><span class="key">${info.key}</span><img src="${iconURL[ICON_FOR[key] || key] || ''}" alt=""><span class="count">${count}</span></div>`;
  }).join('');
  const html = row(HOTBAR) + `<div class="hb-sep"></div>` + row(HOTBAR2);
  const bar = $('hotbar');
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
  const costTxt = key === 'wall' ? 'from ~700 gold per tile (3 thick), climbing steeply' : `${fmt(itemCost(key))} gold`;
  let extra = '';
  if (key === 'mech' && !haveLevel2Factory()) extra = '<div class="bad">Needs a level-2 Factory</div>';
  if ((key === 'warship' || key === 'submarine') && !havePort()) extra = '<div class="bad">Needs a Port</div>';
  $('hotbar-tip').innerHTML = `<b>${info.label} ${info.key ? `<span class="muted">[${info.key}]</span>` : ''}</b>${esc(info.desc)}${extra}<div class="cost">${costTxt}</div>`;
  $('hotbar-tip').classList.remove('hidden');
}
function togglePlacement(key) {
  if (!itemAvailable(key)) return;
  const same = isActivePlacement(key);
  wallDraw = null; selected = null;
  if (same) { placement = null; renderHotbar(); return; }
  if (key === 'wall') placement = { kind: 'wall' };
  else if (key === 'airship') placement = { kind: 'airship' };
  else if (NUKE_INFO[key]) placement = { kind: 'nuke', type: key };
  else if (key === 'mech') placement = { kind: 'build', unit: 'mech', from: mechFrom };
  else placement = { kind: 'build', unit: key };
  renderHotbar();
  const label = (UNIT_INFO[key] || NUKE_INFO[key]).label;
  const hint = key === 'wall' ? 'Wall mode: click-and-drag on your land to draw a wall (Esc to cancel)'
    : key === 'mech' ? 'Click where the Mech should patrol (shift-click one of your level-2 factories first to choose where it builds). Esc cancels.'
    : key === 'warship' || key === 'submarine' ? `Click water to set the ${label}'s patrol point (launches from your nearest port)`
    : key === 'bomber' ? 'Click an enemy structure to bomb it'
    : `Click on the map to place ${label} (Esc to cancel)`;
  toast(hint, true);
}
$('ratio').addEventListener('input', (e) => { ratio = Number(e.target.value) / 100; renderHud(); });
function setRatio(r) { ratio = clamp(r, 0.01, 1); $('ratio').value = Math.round(ratio * 100); renderHud(); }

// player card (top center)
function playerCardHtml(sm) {
  const q = G.players.get(sm), p = me();
  if (!q) return '';
  const counts = {};
  for (const u of G.units) if (u[2] === sm) counts[u[1]] = (counts[u[1]] || 0) + 1;
  const rel = p && p.sm !== sm ? (p.allies.includes(sm) ? ' · <span style="color:#b9f6ca">Ally</span>' : '') : (p && p.sm === sm ? ' · You' : '');
  let html = `<div class="pc-head">${flagBadge(q)}<span>${esc(q.name)}</span><span class="muted" style="font-weight:400;font-size:12px">${q.type === 'nation' ? 'Nation' : q.type === 'bot' ? 'Tribe' : 'Player'}${rel}${q.traitor ? ' · <span style="color:#ff9e93">Traitor</span>' : ''}${q.alive ? '' : ' · Eliminated'}</span>${G.leaderSm === sm ? ' 👑' : ''}</div>`;
  html += `<div class="pc-power"><div class="pw atk" data-tip="atk"><span class="pw-l">⚔ ATK POWER</span><span class="pw-v">${fmt(q.atk || 0)}</span></div><div class="pw eco" data-tip="eco"><span class="pw-l">💰 ECONOMY</span><span class="pw-v">${fmt(q.eco || 0)}/s</span></div></div>`;
  // declared wars, both ways
  const theyOnMe = p && (q.wars || []).includes(p.sm), meOnThem = p && (p.wars || []).includes(sm);
  if (meOnThem || theyOnMe || (q.wars || []).length) {
    const parts = [];
    if (meOnThem) parts.push('<b class="fx-r">You are at war with them</b>');
    if (theyOnMe) parts.push('<b class="fx-r">They declared war on you</b>');
    const others = (q.wars || []).filter((x) => !p || x !== p.sm).map((x) => esc(pname(x)));
    if (others.length) parts.push(`at war with ${others.join(', ')}`);
    html += `<div class="pc-war">⚔ ${parts.join(' · ')}</div>`;
  }
  html += `<div class="pc-stats"><span>💰 <b>${fmt(q.gold)}</b></span><span>⚔ <b>${fmt(q.troops)}</b> / ${fmt(q.maxTroops)}</span><span>🗺 <b>${(100 * q.tiles / G.numLand).toFixed(1)}%</b> (${fmt(q.tiles)})</span><span title="Troops gained per second">📈 +${fmt(q.income)} troops/s</span></div>`;
  let uhtml = ['city', 'port', 'factory', 'defense', 'artillery', 'repair', 'silo', 'sam', 'lab', 'mine'].filter((k) => counts[k]).map((k) => `<span title="${UNIT_INFO[k].label}"><img src="${iconURL[ICON_FOR[k] || k] || ''}" alt="">${counts[k]}</span>`).join('');
  if (q.mechCount) uhtml += `<span title="Mechs"><img src="${iconURL.target || ''}" alt="">${q.mechCount} mech</span>`;
  if (q.warshipCount) uhtml += `<span title="Warships"><img src="${iconURL.warship || ''}" alt="">${q.warshipCount}</span>`;
  if (q.subCount && (q.sm === G.me || (p && p.allies.includes(q.sm)))) uhtml += `<span title="Submarines">🌊 ${q.subCount} sub</span>`;
  if (q.walls) uhtml += `<span title="Wall tiles"><img src="${iconURL.build || ''}" alt="">${q.walls} wall</span>`;
  if (uhtml) html += `<div class="pc-units">${uhtml}</div>`;
  const rs = (q.researches || []).map((id) => `<span class="rs done" data-rid="${esc(id)}">${esc(researchName(id))}</span>`).join('');
  const rp = q.researching ? `<span class="rs prog">${esc(researchName(q.researching[0]))} · ${Math.ceil(q.researching[1] / 10)}s</span>` : '';
  if (rs || rp) html += `<div class="pc-research">🔬 ${rs}${rp}</div>`;
  if (p && p.alive && q.alive && p.sm !== sm) {
    html += `<div class="pc-actions">`;
    if (p.allies.includes(sm)) html += `<button data-act="donateT">Donate 10% troops</button><button data-act="donateG">Donate 10% gold</button><button data-act="break" class="danger">Break alliance</button>`;
    else {
      html += `<button data-act="ally">🤝 Request alliance</button>`;
      html += (p.wars || []).includes(sm) ? `<button data-act="peace">🕊 Make peace</button>` : `<button data-act="war" class="danger">⚔ Declare war</button>`;
    }
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
  card.querySelectorAll('button[data-act]').forEach((b) => { b.onclick = () => playerAction(sm, b.dataset.act); });
  const q = G.players.get(sm);
  card.querySelectorAll('.pw[data-tip]').forEach((el) => {
    el.onmousemove = (e) => showTip(el.dataset.tip === 'atk' ? atkTipHtml(q) : ecoTipHtml(q), e.clientX, e.clientY);
    el.onmouseleave = hideTip;
  });
  card.querySelectorAll('.rs[data-rid]').forEach((el) => {
    const def = RESEARCH_DEFS.find((r) => r.id === el.dataset.rid);
    if (!def) return;
    el.onmousemove = (e) => showTip(`<div class="tip-h">${esc(def.name)}</div><div>${fxMarkup(def.short)}</div>`, e.clientX, e.clientY);
    el.onmouseleave = hideTip;
  });
}
function playerAction(sm, act) {
  const p = me();
  switch (act) {
    case 'ally': send({ t: 'ally', p: sm }); toast('Alliance request sent', true); break;
    case 'war':
      if (confirm(`Declare war on ${pname(sm)}?\n\nYour attacks on them carry 15% more troops, but your gold income drops by 20% while the war lasts (at least 60 seconds).`)) send({ t: 'declareWar', p: sm });
      break;
    case 'peace': send({ t: 'makePeace', p: sm }); break;
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
// Research picker (TFT-augment style)
// =============================================================================
let researchPickerOpen = false, researchDismissed = false;
function openResearchPicker(choices) {
  if (!choices || !choices.length) return;
  researchPickerOpen = true;
  const el = $('research-picker');
  const cards = choices.map((id) => {
    const r = RESEARCH_DEFS.find((x) => x.id === id) || { id, name: id, desc: '', tags: [] };
    const tag = (r.tags && r.tags[0]) || 'misc';
    const mins = [0, 3, 4, 5][r.tier || 2];
    return `<div class="rcard tag-${tag}" data-id="${esc(id)}"><div class="rcard-tag">${esc(r.tags.join(' · ').toUpperCase())}</div><div class="rcard-name">${esc(r.name)}</div><div class="rcard-short">${fxMarkup(r.short)}</div><div class="rcard-desc">${esc(r.desc)}</div><div class="rcard-time">~${mins} min at a level-1 lab</div><button class="primary">Research</button></div>`;
  }).join('');
  el.innerHTML = `<div class="rp-inner"><div class="rp-head"><h2>Choose a Doctrine</h2><span class="muted">Doctrines take 3–5 minutes (less in an upgraded lab). Each lab you own gives two.</span></div><div class="rp-cards">${cards}</div><div class="muted small-text">Press Esc to decide later — the lab keeps the offer open (right-click your land → Research!).</div></div>`
    + `<button id="rp-toggle" class="rp-toggle">Hide doctrines</button>`;
  el.querySelectorAll('.rcard').forEach((c) => { c.onclick = () => { if (el.classList.contains('rp-collapsed')) return; send({ t: 'research', id: c.dataset.id }); closeResearchPicker(); toast(`Researching ${researchName(c.dataset.id)}…`, true); }; });
  // Hide the cards to look around the map before choosing; the map is fully usable while they are hidden.
  $('rp-toggle').onclick = (e) => {
    e.stopPropagation();
    const hide = !el.classList.contains('rp-collapsed');
    el.classList.toggle('rp-collapsed', hide);
    $('rp-toggle').textContent = hide ? 'Show doctrines' : 'Hide doctrines';
  };
  el.classList.remove('rp-collapsed');
  el.classList.remove('hidden');
}
function closeResearchPicker() { if (researchPickerOpen) researchDismissed = true; researchPickerOpen = false; $('research-picker').classList.add('hidden'); $('research-picker').classList.remove('rp-collapsed'); }

// =============================================================================
// Radial menu (right-click)
// =============================================================================
const radialEl = $('radial');
function closeRadial() { radialEl.classList.add('hidden'); radialEl.innerHTML = ''; }
function radialItems(items, center, sx, sy) {
  radialEl.innerHTML = '';
  radialEl.style.left = sx + 'px'; radialEl.style.top = sy + 'px';
  const c = document.createElement('div');
  c.className = 'radial-center';
  c.innerHTML = center.html;
  c.onclick = (e) => { e.stopPropagation(); if (center.onClick) center.onClick(); else closeRadial(); };
  radialEl.appendChild(c);
  const R = items.length > 7 ? 96 : 78;
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
function unitLabel(u) { return `${UNIT_INFO[u[1]] ? UNIT_INFO[u[1]].label : u[1]}${u[4] > 1 ? ' L' + u[4] : ''}`; }
// Right-clicking one of your own mechs opens its orders instead of the ground menu.
const MECH_MODES = [
  { id: 'hold', icon: 'target', label: 'Hold position', desc: 'Sit on the patrol point and circle it. This is what a plain click sets.' },
  { id: 'roam', icon: 'boat', label: 'Roam border', desc: 'Walk your own border, favouring the stretch nearest a hostile neighbour.' },
  { id: 'defend', icon: 'defense', label: 'Auto-defend', desc: 'Answer incoming attacks: nearest first, then whoever is throwing the most troops.' },
  { id: 'assault', icon: 'sword', label: 'Auto-assault…', desc: 'March into one nation and keep wrecking whatever comes in range. Pick the nation next.' },
];
function mechById(id) { return G.mechs.find((m) => m[0] === id); }
// ---- Info panel: the server computes the numbers, we just lay them out and refresh ----
let inspectQuery = null, inspectTimer = null;
function openInspect(q) {
  inspectQuery = q;
  send({ t: 'inspect', ...q });
  clearInterval(inspectTimer);
  inspectTimer = setInterval(() => { if (inspectQuery) send({ t: 'inspect', ...inspectQuery }); }, 1000);
}
function closeInspect() { inspectQuery = null; clearInterval(inspectTimer); $('inspect-panel').classList.add('hidden'); }
function renderInspect(msg) {
  if (!inspectQuery || JSON.stringify(msg.q.kind) !== JSON.stringify(inspectQuery.kind)) return;
  const el = $('inspect-panel');
  if (!msg.info) { el.innerHTML = '<div class="ip-head"><span class="ip-title">Gone</span><button class="icon-btn" id="ip-close">✕</button></div><div class="muted">It no longer exists.</div>'; }
  else {
    const i = msg.info;
    el.innerHTML = `<div class="ip-head"><div><div class="ip-title">${esc(i.title)}</div><div class="ip-sub">${esc(i.sub || '')}</div></div><button class="icon-btn" id="ip-close">✕</button></div>`
      + `<table>${i.rows.map(([k, v, tone]) => `<tr><td>${esc(k)}</td><td class="${tone || ''}">${esc(v)}</td></tr>`).join('')}</table>`;
  }
  el.classList.remove('hidden');
  $('ip-close').onclick = closeInspect;
}
function openShipRadial(ship, sx, sy) {
  const s = G.ships.find((x) => x[0] === ship.id);
  if (!s) return;
  const lvl = s[10] || 1, refitting = !!s[11];
  const items = [
    { icon: 'info', label: 'Info', onClick: () => { closeRadial(); openInspect({ kind: ship.kind, id: ship.id }); } },
    { icon: 'build', label: refitting ? 'Cancel refit' : 'Refit at port', title: 'Sail home and refit up to your best Port\u2019s level (30s in the yard, fully repaired)', onClick: () => { closeRadial(); send({ t: 'refit', kind: ship.kind, id: ship.id }); } },
    { icon: 'x', label: 'Move', onClick: () => { closeRadial(); selected = ship; toast('Click water to send it there', true); } },
  ];
  radialItems(items, { html: `<b>${ship.kind === 'warship' ? 'Warship' : 'Sub'} L${lvl}</b><span class="muted">${refitting ? 'refitting' : fmt(s[5]) + ' HP'}</span>` }, sx, sy);
}
// Anyone's unit near a screen point (for Info on enemy units), mechs first.
function nearestAnyMobileAt(sx, sy, maxPx = PICK_RADIUS_PX) {
  let best = null, bd = maxPx * maxPx;
  const test = (kind, id, wx, wy) => { const x = cam.x + wx * cam.zoom, y = cam.y + wy * cam.zoom; const d = (x - sx) ** 2 + (y - sy) ** 2; if (d < bd) { bd = d; best = { kind, id }; } };
  for (const m of G.mechs) test('mech', m[0], m[2], m[3]);
  for (const s of G.ships) test(s[1], s[0], s[3], s[4]);
  return best;
}
function openMechRadial(mech, sx, sy) {
  const id = mech[0], mode = mech[9 + 2] || 'hold';
  const items = MECH_MODES.map((m) => ({
    icon: m.icon,
    label: m.label,
    title: m.desc,
    cls: mode === m.id ? 'build' : '',
    onClick: () => {
      closeRadial();
      if (m.id === 'assault') { placement = { kind: 'assault', id }; renderHotbar(); toast('Click a nation\u2019s land to send this Mech at them', true); return; }
      send({ t: 'mechMode', id, mode: m.id });
    },
  }));
  items.push({ icon: 'troops', label: 'All mechs: this order', title: 'Apply the order you pick next to every mech you own', onClick: () => { closeRadial(); placement = { kind: 'allMechs' }; toast('Right-click any mech and pick an order — it will apply to all of them', true); } });
  items.push({ icon: 'x', label: 'Move here instead', onClick: () => { closeRadial(); selected = { kind: 'mech', id }; toast('Click where it should go', true); } });
  items.push({ icon: 'info', label: 'Info', onClick: () => { closeRadial(); openInspect({ kind: 'mech', id }); } });
  items.push({ icon: 'factory', label: mech[13] ? 'Cancel refit' : 'Refit', title: 'Walk home to your best Factory and refit up to its level (30s, fully repaired)', onClick: () => { closeRadial(); send({ t: 'refit', kind: 'mech', id }); } });
  const cur = MECH_MODES.find((m) => m.id === mode);
  radialItems(items, { html: `<b>Mech L${mech[7]}</b><span class="muted">${esc(cur ? cur.label : mode)}</span>` }, sx, sy);
}
// Nearest structure to a screen point, within the same generous radius used for mobile units.
function nearestStructureAt(sx, sy, maxPx = PICK_RADIUS_PX) {
  let best = null, bd = maxPx * maxPx;
  for (const u of G.units) {
    const x = cam.x + (tileX(u[3]) + 0.5) * cam.zoom, y = cam.y + (tileY(u[3]) + 0.5) * cam.zoom;
    const d = (x - sx) ** 2 + (y - sy) ** 2;
    if (d < bd) { bd = d; best = u; }
  }
  return best;
}
function openRadial(tile, sx, sy) {
  const p = me();
  if (!p) return;
  // ...and the same when you right-click for the build/upgrade menu
  const near = nearestStructureAt(sx, sy);
  if (near && near[3] !== tile && G.owner[near[3]] === G.me) tile = near[3];
  // your own mech under the cursor takes priority over whatever tile it is standing on
  const own = nearestOwnMobileAt(sx, sy);
  if (own && own.kind === 'mech') { const m = mechById(own.id); if (m) return openMechRadial(m, sx, sy); }
  if (own && (own.kind === 'warship' || own.kind === 'submarine')) return openShipRadial(own, sx, sy);
  // someone else's unit: all you can do is look at it
  const theirs = nearestAnyMobileAt(sx, sy);
  if (theirs) {
    radialItems([{ icon: 'info', label: 'Info', onClick: () => { closeRadial(); openInspect({ kind: theirs.kind, id: theirs.id }); } }],
      { html: `<b>${theirs.kind === 'mech' ? 'Mech' : theirs.kind === 'warship' ? 'Warship' : 'Submarine'}</b><span class="muted">enemy</span>` }, sx, sy);
    return;
  }
  const o = G.owner[tile];
  const q = o ? G.players.get(o) : null;
  const land = isLand(tile);
  const items = [];
  const boatsOff = G.settings && G.settings.disableBoats;
  const u = G.unitByTile.get(tile);
  const ownerName = !land ? 'Water' : q ? q.name : (G.fallout[tile] ? 'Fallout' : 'Unclaimed');
  const center = { html: `<b>${esc(u ? unitLabel(u) : ownerName)}</b><span class="muted">${u ? esc(ownerName) : q ? fmt(q.troops) + ' troops' : land ? 'land' : ''}</span>` };
  if (o === G.me && land) {
    items.push({ icon: 'build', label: 'Build', cls: 'build', onClick: () => openBuildRadial(tile, sx, sy) });
    if (u && (u[1] === 'city' || u[1] === 'port' || u[1] === 'factory' || u[1] === 'lab')) {
      const maxLv = 3 + ((u[1] === 'city' && myHas('megacity')) || (u[1] === 'factory' && myHas('heavy_industry')) ? 1 : 0);
      const atMax = u[4] >= maxLv;
      const label = atMax ? `Max level (${u[4]})` : u[1] === 'factory' && u[4] === 1 ? 'Upgrade (unlocks Mechs)' : u[1] === 'lab' ? 'Upgrade (faster research)' : 'Upgrade';
      items.push({ icon: ICON_FOR[u[1]] || u[1], label, cost: atMax ? undefined : u[1] === 'lab' ? 1500000 * u[4] : itemCost(u[1]), disabled: atMax, onClick: () => { send({ t: 'build', unit: u[1], tile }); closeRadial(); } });
    }
    if (u && (u[1] === 'factory' || u[1] === 'port')) items.push({ icon: 'build', label: 'Recall for refit', title: `Bring every ${u[1] === 'factory' ? 'Mech' : 'Warship and Submarine'} below level ${u[4]} home to refit`, onClick: () => { send({ t: 'recall', tile }); closeRadial(); } });
    if (u) items.push({ icon: 'info', label: 'Building info', onClick: () => { closeRadial(); openInspect({ kind: 'building', tile }); } });
    if (u && u[1] === 'factory' && u[4] >= 2) items.push({ icon: 'target', label: 'Deploy Mech from here', cost: itemCost('mech'), disabled: !itemCan('mech'), onClick: () => { mechFrom = tile; placement = { kind: 'build', unit: 'mech', from: tile }; renderHotbar(); closeRadial(); toast('Now click where the Mech should patrol', true); } });
    if (u && u[1] === 'defense' && myHas('defensive_position')) items.push({ icon: 'troops', label: 'Garrison 10% troops', onClick: () => { send({ t: 'reinforce', tile }); closeRadial(); } });
    if (p.choices && p.choices.length) items.push({ icon: 'info', label: 'Research!', cls: 'build', onClick: () => { researchDismissed = false; openResearchPicker(p.choices); closeRadial(); } });
    if (!u) items.push({ icon: 'target', label: 'Deploy Mech', cost: itemCost('mech'), disabled: !itemCan('mech'), title: UNIT_INFO.mech.desc, onClick: () => { send({ t: 'build', unit: 'mech', tile, from: mechFrom }); closeRadial(); } });
    items.push({ icon: 'build', label: 'Draw Wall', title: UNIT_INFO.wall.desc, onClick: () => { closeRadial(); if (!placement || placement.kind !== 'wall') togglePlacement('wall'); } });
    items.push({ icon: 'info', label: 'Info', onClick: () => { pinnedCard = G.me; renderPlayerCard(G.me, true); closeRadial(); } });
  } else if (!land) {
    if (!boatsOff && p.alive) {
      items.push({ icon: 'boat', label: `Boat ${fmt(p.troops * ratio)}`, onClick: () => { send({ t: 'boat', tile, ratio }); closeRadial(); } });
      if (itemAvailable('warship')) items.push({ icon: 'warship', label: 'Warship here', cost: itemCost('warship'), disabled: !itemCan('warship'), title: UNIT_INFO.warship.desc, onClick: () => { send({ t: 'build', unit: 'warship', tile }); closeRadial(); } });
      if (itemAvailable('submarine')) items.push({ icon: 'warship', label: 'Submarine here', cost: itemCost('submarine'), disabled: !itemCan('submarine'), onClick: () => { send({ t: 'build', unit: 'submarine', tile }); closeRadial(); } });
      if (itemAvailable('mine')) items.push({ icon: 'mine', label: 'Naval Mine', cost: itemCost('mine'), disabled: !itemCan('mine'), onClick: () => { send({ t: 'build', unit: 'mine', tile }); closeRadial(); } });
      if (myHas('amphibious_mech')) items.push({ icon: 'target', label: 'Deploy Mech', cost: itemCost('mech'), disabled: !itemCan('mech'), onClick: () => { send({ t: 'build', unit: 'mech', tile, from: mechFrom }); closeRadial(); } });
    }
    const ship = nearestOwnMobileAt(sx, sy, 60);
    if (ship) items.push({ icon: ship.kind === 'mech' ? 'target' : 'warship', label: `Move ${ship.kind}`, onClick: () => { selected = ship; closeRadial(); toast('Click where it should go', true); } });
  } else {
    if (p.alive && !(q && p.allies.includes(o))) {
      items.push({ icon: 'sword', label: `Attack ${fmt(p.troops * ratio)}`, cls: 'attack', onClick: () => { send({ t: 'attack', tile, ratio }); closeRadial(); } });
      if (!boatsOff) items.push({ icon: 'boat', label: `Boat ${fmt(p.troops * ratio)}`, onClick: () => { send({ t: 'boat', tile, ratio }); closeRadial(); } });
    }
    if (q && q.alive && p.alive) {
      if (p.allies.includes(o)) {
        items.push({ icon: 'donateTroop', label: 'Donate troops', onClick: () => { playerAction(o, 'donateT'); closeRadial(); } });
        items.push({ icon: 'donateGold', label: 'Donate gold', onClick: () => { playerAction(o, 'donateG'); closeRadial(); } });
        items.push({ icon: 'traitor', label: 'Break alliance', onClick: () => { playerAction(o, 'break'); closeRadial(); } });
      } else {
        items.push({ icon: 'ally', label: 'Alliance', onClick: () => { playerAction(o, 'ally'); closeRadial(); } });
        if (q.type !== 'bot') {
          if ((p.wars || []).includes(o)) items.push({ icon: 'ally', label: 'Make peace', onClick: () => { playerAction(o, 'peace'); closeRadial(); } });
          else items.push({ icon: 'sword', label: 'Declare war', cls: 'attack', title: 'Your attacks on them carry +15% troops; your gold income is 20% lower while the war lasts', onClick: () => { closeRadial(); playerAction(o, 'war'); } });
        }
      }
    }
    if (p.alive && itemAvailable('atom') && haveReadySilo()) {
      items.push({ icon: 'atom', label: 'Atom bomb', cost: itemCost('atom'), disabled: p.gold < itemCost('atom'), onClick: () => { send({ t: 'nuke', type: 'atom', tile }); closeRadial(); } });
      items.push({ icon: 'hydrogen', label: 'H-bomb', cost: itemCost('hydrogen'), disabled: p.gold < itemCost('hydrogen'), onClick: () => { send({ t: 'nuke', type: 'hydrogen', tile }); closeRadial(); } });
    }
    if (p.alive && u && q && !p.allies.includes(o) && itemAvailable('bomber')) items.push({ icon: 'explosion', label: 'Bomber strike', cost: itemCost('bomber'), disabled: !itemCan('bomber'), onClick: () => { send({ t: 'build', unit: 'bomber', tile }); closeRadial(); } });
    { const m = nearestOwnMobileAt(sx, sy, 60); if (m) items.push({ icon: m.kind === 'mech' ? 'target' : 'warship', label: `Move ${m.kind}`, onClick: () => { selected = m; closeRadial(); toast('Click where it should go', true); } }); }
    if (u) items.push({ icon: 'info', label: 'Building info', onClick: () => { closeRadial(); openInspect({ kind: 'building', tile }); } });
    if (q) items.push({ icon: 'population', label: 'Nation info', onClick: () => { pinnedCard = o; renderPlayerCard(o, true); closeRadial(); } });
  }
  if (!items.length) items.push({ icon: 'x', label: 'Close', onClick: closeRadial });
  radialItems(items, center, sx, sy);
}
function openBuildRadial(tile, sx, sy) {
  const items = [];
  for (const key of ['city', 'port', 'factory', 'defense', 'artillery', 'repair', 'silo', 'sam', 'lab']) {
    if (!itemAvailable(key)) continue;
    items.push({ icon: ICON_FOR[key] || key, label: UNIT_INFO[key].label, cost: itemCost(key), disabled: !itemCan(key), title: UNIT_INFO[key].desc, onClick: () => { send({ t: 'build', unit: key, tile }); closeRadial(); } });
  }
  radialItems(items, { html: `<b>Build</b><span class="muted">back</span>`, onClick: () => openRadial(tile, sx, sy) }, sx, sy);
}
// Find one of your own mobile units near a point on SCREEN. Screen space matters here: a mech is drawn
// up to 24px across whatever the zoom is, so a tile-space radius made the icon unclickable when zoomed
// in (you would hit the ground underneath it) and grabbed the wrong unit when zoomed out. We also match
// against the interpolated position the unit is drawn at, not the last position the server sent.
function nearestOwnMobileAt(sx, sy, maxPx = PICK_RADIUS_PX) {
  let best = null, bd = maxPx * maxPx;
  const check = (kind, id, wx, wy, key, pad) => {
    const [lx, ly] = lerpPeek(key, wx, wy);
    const dx = (cam.x + lx * cam.zoom) - sx, dy = (cam.y + ly * cam.zoom) - sy;
    const d = dx * dx + dy * dy;
    const lim = Math.max(maxPx, pad) ** 2;
    if (d < lim && d < bd) { bd = d; best = { kind, id }; }
  };
  // mechs first and with a bigger pad: they are the big slow thing you actually want to grab
  for (const m of G.mechs) if (m[1] === G.me) check('mech', m[0], m[2], m[3], 'mech' + m[0], clamp(7 * cam.zoom, 9, 24) + 10);
  for (const s of G.ships) if (s[2] === G.me) check(s[1], s[0], s[3], s[4], 'ship' + s[0], 18);
  return best;
}
// Read back where a unit is currently being drawn without disturbing the interpolation state.
function lerpPeek(id, x, y) {
  const st = lerpState.get(id);
  if (!st) return [x, y];
  return [st.dx ?? st.tx ?? x, st.dy ?? st.ty ?? y];
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
// ---- wall drawing: press on your land, drag a polyline (waypoints every few tiles), release to build ----
let wallDraw = null;
let lastQuoteAt = 0;
function updateWallQuote(force) {
  if (!wallDraw) return;
  const now = performance.now();
  if (!force && now - lastQuoteAt < 150) return;
  lastQuoteAt = now;
  send({ t: 'wallQuote', tiles: wallDraw.pts });
}
canvas.addEventListener('mousedown', (e) => {
  mouse.down = true; mouse.button = e.button; mouse.sx = mouse.lastX = e.clientX; mouse.sy = mouse.lastY = e.clientY; mouse.dragging = false;
  // Shift-drag is always a selection box, never a build. With a unit button armed it selects that kind
  // of unit, so "mech" + shift-drag grabs your mechs and leaves your warships alone.
  if (e.button === 0 && e.shiftKey && G.phase === 'play') {
    const kind = placement && placement.kind === 'build' && MOBILE_KINDS.includes(placement.unit) ? placement.unit : null;
    boxSelect = { x0: e.clientX, y0: e.clientY, x1: e.clientX, y1: e.clientY, kind };
    return;
  }
  if (e.button === 0 && placement && placement.kind === 'wall' && G.phase === 'play') {
    const t = screenToTile(e.clientX, e.clientY);
    if (t >= 0 && G.owner[t] === G.me) { wallDraw = { pts: [t], quote: null }; updateWallQuote(true); }
    else toast('Start the wall on your own land');
  }
});
window.addEventListener('mousemove', (e) => {
  mouse.x = e.clientX; mouse.y = e.clientY;
  if (screen !== 'game') return;
  hoverTile = e.target === canvas ? screenToTile(e.clientX, e.clientY) : -1;
  hoverUnit = hoverTile >= 0 && !placement ? nearestOwnMobileAt(e.clientX, e.clientY) : null;
  canvas.style.cursor = hoverUnit ? 'pointer' : '';
  if (!mouse.down) return;
  if (boxSelect) { boxSelect.x1 = e.clientX; boxSelect.y1 = e.clientY; return; }
  if (wallDraw) {
    if (hoverTile >= 0) {
      const last = wallDraw.pts[wallDraw.pts.length - 1];
      const d = Math.hypot(tileX(hoverTile) - tileX(last), tileY(hoverTile) - tileY(last));
      if (d >= 3) { wallDraw.pts.push(hoverTile); if (wallDraw.pts.length > 200) wallDraw.pts.shift(); updateWallQuote(false); }
    }
    return;
  }
  const dx = e.clientX - mouse.lastX, dy = e.clientY - mouse.lastY;
  if (!mouse.dragging && Math.hypot(e.clientX - mouse.sx, e.clientY - mouse.sy) > 5) mouse.dragging = true;
  if (mouse.dragging) { cam.x += dx; cam.y += dy; }
  mouse.lastX = e.clientX; mouse.lastY = e.clientY;
});
window.addEventListener('mouseup', (e) => {
  if (!mouse.down) return;
  mouse.down = false;
  if (boxSelect) {
    const b = boxSelect; boxSelect = null;
    const lo = (a, c) => Math.min(a, c), hi = (a, c) => Math.max(a, c);
    const x0 = lo(b.x0, b.x1), x1 = hi(b.x0, b.x1), y0 = lo(b.y0, b.y1), y1 = hi(b.y0, b.y1);
    if (x1 - x0 < 4 && y1 - y0 < 4) return;
    const hits = [];
    const add = (kind, id, wx, wy, key) => {
      if (b.kind && b.kind !== kind) return;
      const [lx, ly] = lerpPeek(key, wx, wy);
      const x = cam.x + lx * cam.zoom, y = cam.y + ly * cam.zoom;
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1) hits.push({ kind, id });
    };
    for (const m of G.mechs) if (m[1] === G.me) add('mech', m[0], m[2], m[3], 'mech' + m[0]);
    for (const sh of G.ships) if (sh[2] === G.me) add(sh[1], sh[0], sh[3], sh[4], 'ship' + sh[0]);
    selection = hits;
    selected = hits.length === 1 ? hits[0] : null;
    if (hits.length) {
      placement = null; renderHotbar();
      const kinds = {};
      for (const h of hits) kinds[h.kind] = (kinds[h.kind] || 0) + 1;
      toast(`Selected ${Object.entries(kinds).map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`).join(', ')} — click to order them`, true);
    } else toast('Nothing selected');
    return;
  }
  if (wallDraw) {
    if (hoverTile >= 0 && hoverTile !== wallDraw.pts[wallDraw.pts.length - 1]) wallDraw.pts.push(hoverTile);
    send({ t: 'wall', tiles: wallDraw.pts });
    wallDraw = null;
    return;
  }
  if (screen !== 'game' || mouse.dragging || e.target !== canvas) return;
  if (e.button === 0) onLeftClick(e.clientX, e.clientY, e.shiftKey);
  else if (e.button === 2) onRightClick(e.clientX, e.clientY);
});
// no browser context menu anywhere in the game (OpenFront does the same)
document.addEventListener('contextmenu', (e) => { if (screen === 'game') e.preventDefault(); });
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
  if (G.phase === 'spawn') { if (!isLand(tile)) return toast('Spawn must be on land'); send({ t: 'spawn', tile }); return; }
  const p = me();
  if (!p || !p.alive) return;
  // a selected mech/ship (or a whole box of them): this click is the move order
  if (selection.length > 1) {
    for (const u of selection) send({ t: u.kind === 'mech' ? 'moveMech' : 'moveShip', id: u.id, tile });
    toast(`${selection.length} units ordered`, true);
    selection = []; selected = null;
    return;
  }
  if (selected) { send({ t: selected.kind === 'mech' ? 'moveMech' : 'moveShip', id: selected.id, tile }); selected = null; selection = []; return; }
  if (placement) {
    if (placement.kind === 'wall') return;
    if (placement.kind === 'assault') {
      const o = G.owner[tile];
      if (!o || o === G.me) return toast('Click land belonging to the nation you want assaulted');
      send({ t: 'mechMode', id: placement.id, mode: 'assault', target: o });
      placement = null; renderHotbar();
      return;
    }
    if (placement.kind === 'airship') { send({ t: 'airship', tile }); if (!keys.shift) { placement = null; renderHotbar(); } return; }
    if (placement.kind === 'build') {
      if (placement.unit === 'mech' && shift) { const u = G.unitByTile.get(tile); if (u && u[1] === 'factory' && u[2] === G.me && u[4] >= 2) { mechFrom = tile; placement.from = tile; toast('Mechs will build at this factory', true); return; } }
      send({ t: 'build', unit: placement.unit, tile, from: placement.from ?? -1 });
    } else send({ t: 'nuke', type: placement.type, tile });
    if (!keys.shift) { placement = null; renderHotbar(); }
    return;
  }
  // click near one of your mobile units selects it
  const mob = nearestOwnMobileAt(sx, sy);
  if (mob) { selected = mob; toast(`${mob.kind} selected — click where it should go, or right-click it for orders (Esc to cancel)`, true); return; }
  // A structure under the cursor is almost always what you meant to click, so snap to the nearest one
  // within a comfortable pixel radius instead of making the player zoom in to hit a 6px hexagon.
  const structure = nearestStructureAt(sx, sy);
  if (structure && structure[2] === G.me) { openRadial(structure[3], sx, sy); return; }
  const o = G.owner[tile];
  if (o === G.me) { if (!shift) openRadial(tile, sx, sy); return; }
  if (!isLand(tile)) { if (!(G.settings && G.settings.disableBoats)) send({ t: 'boat', tile, ratio }); return; }
  if (o && p.allies.includes(o)) { toast(`${pname(o)} is your ally`); return; }
  send({ t: 'attack', tile, ratio, focus: tile });
}
function onRightClick(sx, sy) {
  if (selected || selection.length) { selected = null; selection = []; return; }
  if (placement) { placement = null; wallDraw = null; renderHotbar(); return; }
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
  if (e.key === 'Escape') { closeInspect(); hideTip(); closeRadial(); closeResearchPicker(); placement = null; wallDraw = null; selected = null; selection = []; boxSelect = null; renderHotbar(); pinnedCard = 0; $('player-card').classList.add('hidden'); $('settings-popup').classList.add('hidden'); return; }
  if (k === 'a') { if (hoverTile >= 0 && G.phase === 'play') send({ t: 'attack', tile: hoverTile, ratio, focus: hoverTile }); return; }
  if (k === 'b') { if (hoverTile >= 0 && G.phase === 'play') send({ t: 'boat', tile: hoverTile, ratio }); return; }
  if (k === 'r') { const inc = G.attacks.filter((a) => a[2] === G.me); if (inc.length) send({ t: 'attackPlayer', p: inc[inc.length - 1][1], ratio }); return; }
  if (k === 'c') { centerOn(G.me); return; }
  if (k === 'n') { togglePlacement('atom'); return; }
  if (k === 'h') { togglePlacement('hydrogen'); return; }
  if (/^[0-9]$/.test(e.key)) { const idx = e.key === '0' ? 9 : Number(e.key) - 1; const key = HOTBAR[idx]; if (key) togglePlacement(key); return; }
  if (e.key === '+' || e.key === '=') zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.25);
  if (e.key === '-') zoomAt(window.innerWidth / 2, window.innerHeight / 2, 0.8);
  if (e.key === '[') setRatio(ratio - 0.05);
  if (e.key === ']') setRatio(ratio + 0.05);
  const pan = 60;
  if (e.key === 'ArrowLeft') cam.x += pan; if (e.key === 'ArrowRight') cam.x -= pan;
  if (e.key === 'ArrowUp') cam.y += pan; if (e.key === 'ArrowDown') cam.y -= pan;
});
window.addEventListener('keyup', (e) => { if (e.key === 'Shift') keys.shift = false; });
// Expansion pull: tell the server where the mouse is while we have attacks running.
setInterval(() => { if (G.active && G.phase === 'play' && hoverTile >= 0 && G.attacks.some((a) => a[1] === G.me)) send({ t: 'focus', tile: hoverTile }); }, 400);

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
  if (type === 'mine') { ctx.arc(x, y, r * 0.7, 0, Math.PI * 2); return; }
  const sides = type === 'port' ? 5 : type === 'defense' ? 8 : type === 'silo' ? 3 : type === 'sam' ? 4 : type === 'lab' ? 7 : type === 'artillery' ? 3 : type === 'repair' ? 4 : type === 'airport' ? 4 : 6;
  const rot = type === 'port' || type === 'silo' || type === 'lab' ? -Math.PI / 2 : type === 'artillery' ? Math.PI / 2 : type === 'defense' ? Math.PI / 8 : type === 'sam' || type === 'repair' ? Math.PI / 4 : Math.PI / 6;
  for (let i = 0; i < sides; i++) {
    const a = rot + (i / sides) * Math.PI * 2;
    const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}
function bezierPoint(p0, p1, p2, p3, t) {
  const u = 1 - t;
  return [u * u * u * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t * t * t * p3[0], u * u * u * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t * t * t * p3[1]];
}
let lastHoverCardTile = -2;
function draw() {
  requestAnimationFrame(draw);
  if (screen !== 'game' || !G.active) return;
  if (needFit || canvas.width <= 1) { resizeCanvas(); fitCamera(); if (needFit) return; }
  const dpr = devicePixelRatio;
  const sw = window.innerWidth, sh = window.innerHeight;
  const now = performance.now();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#3c3c3c';
  ctx.fillRect(0, 0, sw, sh);
  ctx.setTransform(dpr * cam.zoom, 0, 0, dpr * cam.zoom, dpr * cam.x, dpr * cam.y);
  ctx.imageSmoothingEnabled = cam.zoom < 1;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(terrainCanvas, 0, 0);
  if (ownerDirty) { ownerCtx.putImageData(ownerImg, 0, 0); ownerDirty = false; }
  ctx.drawImage(ownerCanvas, 0, 0);

  // rails (world space)
  if (G.rails.length) {
    ctx.lineWidth = Math.max(0.6, 1.2 / Math.sqrt(cam.zoom));
    ctx.strokeStyle = 'rgba(70,50,30,0.85)';
    ctx.lineCap = 'round';
    for (const r of G.rails) {
      const tiles = r[3];
      ctx.beginPath();
      for (let i = 0; i < tiles.length; i++) { const x = tileX(tiles[i]) + 0.5, y = tileY(tiles[i]) + 0.5; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
    }
    if (cam.zoom > 2) { // sleepers
      ctx.strokeStyle = 'rgba(40,30,20,0.6)'; ctx.lineWidth = 0.15;
      for (const r of G.rails) { const tiles = r[3]; for (let i = 0; i < tiles.length; i += 3) { const x = tileX(tiles[i]) + 0.5, y = tileY(tiles[i]) + 0.5; ctx.beginPath(); ctx.moveTo(x - 0.5, y - 0.5); ctx.lineTo(x + 0.5, y + 0.5); ctx.stroke(); } }
    }
  }
  // spawn preview / placement ghosts
  if (G.phase === 'spawn' && hoverTile >= 0 && isLand(hoverTile)) {
    ctx.fillStyle = 'rgba(255, 213, 79, 0.45)'; ctx.strokeStyle = 'rgba(255, 213, 79, 0.9)'; ctx.lineWidth = 1.5 / cam.zoom;
    ctx.beginPath(); ctx.arc(tileX(hoverTile) + 0.5, tileY(hoverTile) + 0.5, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }
  // Aiming a missile shows every SAM umbrella on the map; anything mech-related shows every mech's
  // ground-holding radius. Red for rivals, blue for you and your allies.
  const aimingMissile = placement && (placement.kind === 'nuke' || (placement.kind === 'build' && (placement.unit === 'bomber' || placement.unit === 'airship')) || placement.kind === 'airship');
  const mechContext = aimingMissile || (placement && ((placement.kind === 'build' && placement.unit === 'mech') || placement.kind === 'assault')) || (selected && selected.kind === 'mech') || selection.some((u) => u.kind === 'mech');
  const friendly = (sm) => { const p = me(); return sm === G.me || (p && p.allies.includes(sm)); };
  if (aimingMissile) {
    ctx.lineWidth = 1.4 / cam.zoom;
    for (const u of G.units) {
      if (u[1] !== 'sam' || u[5] > 0) continue;
      const owner = G.players.get(u[2]);
      const r = 70 + (owner && owner.researches && owner.researches.includes('fighter_networks') ? 30 : 0);
      ctx.strokeStyle = friendly(u[2]) ? 'rgba(120, 190, 255, 0.75)' : (u[6] > 0 ? 'rgba(255, 140, 120, 0.35)' : 'rgba(255, 90, 80, 0.85)');
      ctx.setLineDash(u[6] > 0 ? [4 / cam.zoom, 4 / cam.zoom] : []);   // dashed while reloading
      ctx.beginPath(); ctx.arc(tileX(u[3]) + 0.5, tileY(u[3]) + 0.5, r, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  if (mechContext) {
    ctx.lineWidth = 1.2 / cam.zoom;
    for (const mch of G.mechs) {
      const [lx, ly] = lerpPeek('mech' + mch[0], mch[2], mch[3]);
      ctx.strokeStyle = friendly(mch[1]) ? 'rgba(120, 200, 255, 0.55)' : 'rgba(255, 110, 100, 0.7)';
      ctx.setLineDash([6 / cam.zoom, 5 / cam.zoom]);
      ctx.beginPath(); ctx.arc(lx, ly, 30, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
  if (placement && placement.kind === 'nuke' && placement.type === 'cluster' && hoverTile >= 0) {
    const hx = tileX(hoverTile) + 0.5, hy = tileY(hoverTile) + 0.5;
    ctx.fillStyle = 'rgba(255,120,60,0.12)'; ctx.beginPath(); ctx.arc(hx, hy, 26, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,140,80,0.9)'; ctx.lineWidth = 1.5 / cam.zoom; ctx.beginPath(); ctx.arc(hx, hy, 26, 0, Math.PI * 2); ctx.stroke();
  }
  if (placement && placement.kind === 'nuke' && placement.type !== 'cluster' && hoverTile >= 0) {
    const tact = myHas('tactical_nukes');
    const inner = placement.type === 'hydrogen' ? 80 : tact ? 8 : 12, outer = placement.type === 'hydrogen' ? 100 : tact ? 16 : 30;
    const hx = tileX(hoverTile) + 0.5, hy = tileY(hoverTile) + 0.5;
    ctx.lineWidth = 1.5 / cam.zoom;
    ctx.fillStyle = 'rgba(255,60,60,0.15)'; ctx.beginPath(); ctx.arc(hx, hy, outer, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,60,60,0.9)'; ctx.beginPath(); ctx.arc(hx, hy, inner, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,60,60,0.5)'; ctx.beginPath(); ctx.arc(hx, hy, outer, 0, Math.PI * 2); ctx.stroke();
  }
  if (wallDraw) {
    const q = wallDraw.quote;
    const ok = !q || (q.ok && q.afford);
    ctx.fillStyle = ok ? 'rgba(120, 220, 120, 0.6)' : 'rgba(240, 80, 80, 0.6)';
    if (q && q.ok && q.tiles) for (const t of q.tiles) ctx.fillRect(tileX(t), tileY(t), 1, 1);
    else for (const t of wallDraw.pts) ctx.fillRect(tileX(t) - 1, tileY(t) - 1, 3, 3);
  } else if (placement && placement.kind === 'wall' && hoverTile >= 0) {
    ctx.fillStyle = G.owner[hoverTile] === G.me ? 'rgba(120, 220, 120, 0.55)' : 'rgba(240, 80, 80, 0.5)';
    ctx.fillRect(tileX(hoverTile) - 1, tileY(hoverTile) - 1, 3, 3);
  }
  if (placement && placement.kind === 'build' && (placement.unit === 'artillery' || placement.unit === 'repair' || placement.unit === 'defense') && hoverTile >= 0) {
    const rr = placement.unit === 'artillery' ? 45 : placement.unit === 'repair' ? 40 : 30;
    ctx.strokeStyle = 'rgba(150, 220, 255, 0.75)'; ctx.lineWidth = 1.5 / cam.zoom;
    ctx.beginPath(); ctx.arc(tileX(hoverTile) + 0.5, tileY(hoverTile) + 0.5, rr, 0, Math.PI * 2); ctx.stroke();
  }
  if (placement && placement.kind === 'build' && (placement.unit === 'mech' || placement.unit === 'warship' || placement.unit === 'submarine') && hoverTile >= 0) {
    const okTile = placement.unit === 'mech' ? (isLand(hoverTile) || myHas('amphibious_mech')) : isWater(hoverTile);
    ctx.strokeStyle = okTile ? 'rgba(120,220,120,0.9)' : 'rgba(240,80,80,0.9)'; ctx.lineWidth = 1.5 / cam.zoom;
    ctx.beginPath(); ctx.arc(tileX(hoverTile) + 0.5, tileY(hoverTile) + 0.5, placement.unit === 'mech' ? 6 : 50, 0, Math.PI * 2); ctx.stroke();
  }
  if (placement && placement.kind === 'assault' && hoverTile >= 0) {
    const o = G.owner[hoverTile];
    ctx.strokeStyle = o && o !== G.me ? 'rgba(255,120,110,0.9)' : 'rgba(240,80,80,0.4)';
    ctx.lineWidth = 2 / cam.zoom;
    ctx.beginPath(); ctx.arc(tileX(hoverTile) + 0.5, tileY(hoverTile) + 0.5, 8, 0, Math.PI * 2); ctx.stroke();
  }
  if (selected && hoverTile >= 0) { ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1.5 / cam.zoom; ctx.beginPath(); ctx.arc(tileX(hoverTile) + 0.5, tileY(hoverTile) + 0.5, selected.kind === 'mech' ? 6 : 50, 0, Math.PI * 2); ctx.stroke(); }

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
      const rr = type === 'mine' ? r * 0.7 : r;
      shapePath(type, x, y, rr);
      ctx.fillStyle = type === 'mine' ? '#222' : rgbToHex(darken(p.rgb, 0.05));
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, r / 6);
      ctx.strokeStyle = cooldown > 0 ? '#ff5252' : p.borderHex;
      ctx.stroke();
      const ic = icons[ICON_FOR[type] || type];
      if (ic && r >= 7 && type !== 'mine') { const s = rr * 1.15; ctx.drawImage(ic, x - s / 2, y - s / 2, s, s); }
      ctx.globalAlpha = 1;
      if (level > 1 && r >= 8) {
        ctx.font = `bold ${Math.max(9, r * 0.8)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(x + r * 0.8, y - r * 0.8, r * 0.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(String(level), x + r * 0.8, y - r * 0.8 + 0.5);
      }
      if (building > 0) {
        const total = { city: 20, port: 50, defense: 50, silo: 100, sam: 300, lab: 100, factory: 60, artillery: 90, repair: 70 }[type] || 20;
        ctx.beginPath(); ctx.arc(x, y, r + 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - building / total)); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke();
      }
      if (type === 'lab' && cooldown > 0 && building === 0) { ctx.beginPath(); ctx.arc(x, y, r + 3, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (1 - cooldown / 1050)); ctx.strokeStyle = '#9ad0ff'; ctx.lineWidth = 2.5; ctx.stroke(); }
    }
  }
  // trains
  for (const t of G.trains) {
    const p = G.players.get(t[1]);
    const col = p ? p.color : '#fff';
    const draw1 = (wx, wy, engine) => {
      const [x, y] = toScreen(wx, wy);
      if (!visible(x, y)) return;
      const c = coloredSprite(engine ? 'trainEngine' : 'trainCar', col, p ? p.borderHex : '#000');
      const s = clamp(6 * cam.zoom, 5, 22);
      if (c) { ctx.imageSmoothingEnabled = false; ctx.drawImage(c, x - s / 2, y - s / 2, s, s); }
      else { ctx.fillStyle = engine ? '#222' : col; ctx.fillRect(x - s / 2, y - s / 3, s, s * 0.66); }
    };
    for (const c of t[4]) draw1(c[0], c[1], false);
    const [ex, ey] = lerpPos('train' + t[0], t[2], t[3]);
    draw1(ex, ey, true);
  }
  // ships & boats
  const drawSprite = (name, ownerSm, wx, wy, scale, key) => {
    const p = G.players.get(ownerSm);
    const c = coloredSprite(name, p ? p.color : '#ffffff', p ? p.borderHex : '#000000');
    const [lx, ly] = key ? lerpPos(key, wx, wy) : [wx, wy];
    const [x, y] = toScreen(lx, ly);
    if (!visible(x, y)) return null;
    if (!c) { ctx.fillStyle = p ? p.color : '#fff'; ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); return [x, y]; }
    const s = clamp(c.width * cam.zoom * scale, c.width * 1.5, c.width * 6);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(c, x - s / 2, y - s / 2, s, s);
    return [x, y];
  };
  for (const s of G.trade) drawSprite('trade', s[1], s[2], s[3], 1.2, 'trade' + s[0]);
  for (const b of G.boats) {
    const pos = drawSprite('transport', b[1], b[2], b[3], 1.4, 'boat' + b[0]);
    if (pos && cam.zoom > 1.2) { ctx.font = `bold ${clamp(4 * cam.zoom, 10, 14)}px system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillStyle = '#fff'; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.lineWidth = 3; ctx.strokeText(fmt(b[4]), pos[0], pos[1] - 8); ctx.fillText(fmt(b[4]), pos[0], pos[1] - 8); }
  }
  for (const s of G.ships) {
    const [id, kind, ownerSm, wx, wy, hp, maxHp, , volley] = s;
    const p = G.players.get(ownerSm);
    const [lx, ly] = lerpPos('ship' + id, wx, wy);
    const [x, y] = toScreen(lx, ly);
    if (!visible(x, y)) continue;
    const isSel = (selected && selected.id === id) || selection.some((u) => u.id === id);
    if (kind === 'warship') { drawSprite('warship', ownerSm, lx, ly, 1.4); }
    else { // submarine: dark ellipse in owner colour outline
      const r = clamp(5 * cam.zoom, 6, 18);
      ctx.beginPath(); ctx.ellipse(x, y, r, r * 0.45, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(20,25,35,0.85)'; ctx.fill(); ctx.strokeStyle = p ? p.color : '#fff'; ctx.lineWidth = 1.5; ctx.stroke();
      const bw = r * 2, bh = 3; ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(x - bw / 2, y + r * 0.6 + 2, bw, bh);
      ctx.fillStyle = '#67e8f9'; ctx.fillRect(x - bw / 2, y + r * 0.6 + 2, bw * (1 - clamp((volley || 0) / 900, 0, 1)), bh);
    }
    if (hp < maxHp) { const bw = clamp(6 * cam.zoom, 12, 30), bh = 3; ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(x - bw / 2, y - 12, bw, bh); ctx.fillStyle = hp / maxHp > 0.5 ? '#4caf50' : '#e53935'; ctx.fillRect(x - bw / 2, y - 12, bw * clamp(hp / maxHp, 0, 1), bh); }
    if ((s[10] || 1) > 1 || s[11]) {
      ctx.font = 'bold 10px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const tag = s[11] ? 'REFIT' : `L${s[10]}`;
      const w2 = ctx.measureText(tag).width + 6;
      ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(x - w2 / 2, y + 9, w2, 12);
      ctx.fillStyle = s[11] ? '#ffd166' : '#fff'; ctx.fillText(tag, x, y + 15);
    }
    if (isSel) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]); }
    else if (hoverUnit && hoverUnit.id === id) { ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 13, 0, Math.PI * 2); ctx.stroke(); }
  }
  // shells / missiles
  for (const s of G.shells) {
    const [id, ownerSm, wx, wy, , , kind] = s;
    const [lx, ly] = lerpPos('shell' + id, wx, wy);
    const [x, y] = toScreen(lx, ly);
    if (!visible(x, y)) continue;
    const p = G.players.get(ownerSm);
    ctx.beginPath(); ctx.arc(x, y, kind === 'sub' ? 3.5 : kind === 'mech' ? 3 : 2, 0, Math.PI * 2);
    ctx.fillStyle = kind === 'sub' ? '#67e8f9' : kind === 'mech' ? '#ffb347' : kind === 'bombard' ? '#ff7043' : '#fff'; ctx.fill();
    ctx.strokeStyle = p ? p.color : '#000'; ctx.lineWidth = 1; ctx.stroke();
  }
  // bombers
  for (const b of G.bombers) {
    const [id, ownerSm, wx, wy, tx, ty] = b;
    const [lx, ly] = lerpPos('bomber' + id, wx, wy);
    const [x, y] = toScreen(lx, ly);
    if (!visible(x, y)) continue;
    const p = G.players.get(ownerSm);
    const ang = Math.atan2(ty - ly, tx - lx), s = clamp(5 * cam.zoom, 8, 20);
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    ctx.beginPath(); ctx.moveTo(s, 0); ctx.lineTo(-s * 0.7, s * 0.6); ctx.lineTo(-s * 0.3, 0); ctx.lineTo(-s * 0.7, -s * 0.6); ctx.closePath();
    ctx.fillStyle = p ? p.color : '#fff'; ctx.fill(); ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();
  }
  // airships: a fat lozenge with a troop count, deliberately unlike any boat
  for (const a of G.airships) {
    const [id, ownerSm, ax, ay, tx, ty, troops] = a;
    const q = G.players.get(ownerSm);
    const [lx, ly] = lerpPos('air' + id, ax, ay);
    const [x, y] = toScreen(lx, ly);
    if (!visible(x, y)) continue;
    // the blimp points where it is going; a dark copy underneath gives it an outline against the sea
    const ang = Math.atan2(ty - ly, tx - lx);
    const flip = Math.abs(ang) > Math.PI / 2;   // keep the nose forward instead of flying upside down
    const size = clamp(11 * cam.zoom, 18, 44);
    const body = tintedIcon('airship', q ? q.color : '#ffffff');
    const shade = tintedIcon('airship', '#11151b');
    ctx.save(); ctx.translate(x, y); ctx.rotate(flip ? ang + Math.PI : ang); if (flip) ctx.scale(1, -1);
    if (shade) ctx.drawImage(shade, -size / 2 - 1.5, -size / 2 - 1.5, size + 3, size + 3);
    if (body) ctx.drawImage(body, -size / 2, -size / 2, size, size);
    ctx.restore();
    if (cam.zoom > 1) {
      ctx.font = `bold ${clamp(4 * cam.zoom, 10, 15)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.fillStyle = '#fff';
      const off = clamp(11 * cam.zoom, 18, 44) * 0.3;
      ctx.strokeText(fmt(troops), x, y - off); ctx.fillText(fmt(troops), x, y - off);
    }
  }
  // nukes on their arcs
  for (const nk of G.nukes) {
    const [id, type, ownerSm, nx, ny, tx, ty, sx0, sy0] = nk;
    const p = G.players.get(ownerSm);
    const p0 = [sx0 + 0.5, sy0 + 0.5], p3 = [tx + 0.5, ty + 0.5];
    const dx = p3[0] - p0[0], dy = p3[1] - p0[1], dist = Math.hypot(dx, dy), hgt = Math.max(dist / 3, type === 'warhead' ? 12 : 50);
    const p1 = [p0[0] + dx / 4, p0[1] + dy / 4 - hgt], p2 = [p0[0] + (3 * dx) / 4, p0[1] + (3 * dy) / 4 - hgt];
    ctx.setLineDash([4, 5]); ctx.strokeStyle = 'rgba(255,80,80,0.55)'; ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 0; i <= 24; i++) { const [bx, by] = bezierPoint(p0, p1, p2, p3, i / 24); const [x, y] = toScreen(bx, by); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke(); ctx.setLineDash([]);
    const [gx, gy] = toScreen(p3[0], p3[1]);
    const rr = (type === 'hydrogen' ? 100 : type === 'warhead' ? 18 : myHas('tactical_nukes') && ownerSm === G.me ? 16 : 30) * cam.zoom;
    ctx.strokeStyle = 'rgba(255,80,80,0.8)'; ctx.beginPath(); ctx.arc(gx, gy, rr, 0, Math.PI * 2); ctx.stroke();
    const [lx, ly] = lerpPos('nuke' + id, nx, ny);
    drawSprite(type === 'hydrogen' ? 'hydrogen' : 'atom', ownerSm, lx, ly, 1.6);
    void p;
  }
  // effects
  G.effects = G.effects.filter((e) => now - e.t0 < e.dur);
  for (const e of G.effects) {
    const k = (now - e.t0) / e.dur;
    const [x, y] = toScreen(e.x + 0.5, e.y + 0.5);
    ctx.beginPath(); ctx.arc(x, y, Math.max(4, e.r * cam.zoom * (e.ring ? 1 : 0.3 + 0.7 * k)), 0, Math.PI * 2);
    if (!e.ring) { ctx.fillStyle = `rgba(255,${Math.floor(200 - 150 * k)},50,${0.55 * (1 - k)})`; ctx.fill(); }
    ctx.strokeStyle = `rgba(255,255,255,${1 - k})`; ctx.lineWidth = 2; ctx.stroke();
  }
  // mechs
  for (const mch of G.mechs) {
    const [id, ownerSm, mx, my, hp, maxHp, engaged, level, patrol, cannon, range, mode] = mch;
    const p = G.players.get(ownerSm);
    const [lx, ly] = lerpPos('mech' + id, mx, my);
    const [x, y] = toScreen(lx, ly);
    if (!visible(x, y)) continue;
    const r = clamp(7 * cam.zoom, 9, 24);
    const isSel = (selected && selected.kind === 'mech' && selected.id === id) || selection.some((u) => u.kind === 'mech' && u.id === id);
    const isHover = hoverUnit && hoverUnit.kind === 'mech' && hoverUnit.id === id;
    // the ground a mech holds: attacks inside this bleed 3x troops and crawl (config mechAuraRange)
    if (ownerSm === G.me && (isSel || isHover)) {
      ctx.beginPath(); ctx.arc(x, y, 30 * cam.zoom, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(120, 200, 255, 0.07)'; ctx.fill();
      ctx.strokeStyle = 'rgba(120, 200, 255, 0.35)'; ctx.setLineDash([6, 6]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]);
    }
    if (isHover && !isSel) { ctx.beginPath(); ctx.arc(x, y, r + 6, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 2; ctx.stroke(); }
    if (engaged) { ctx.beginPath(); ctx.arc(x, y, r * 1.5 + 2 * Math.sin(now / 120), 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,80,80,0.8)'; ctx.lineWidth = 2; ctx.stroke(); }
    if (isSel || (ownerSm === G.me && cam.zoom > 3)) { ctx.beginPath(); ctx.arc(x, y, range * cam.zoom, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1; ctx.stroke(); ctx.setLineDash([]); }
    shapePath('factory', x, y, r);
    ctx.fillStyle = '#23262d'; ctx.fill();
    ctx.lineWidth = Math.max(2, r / 5); ctx.strokeStyle = isSel ? '#fff' : (p ? p.color : '#fff'); ctx.stroke();
    const ic = icons.target;
    if (ic) { const s = r * 1.2; ctx.drawImage(ic, x - s / 2, y - s / 2, s, s); }
    if (level > 2) { ctx.font = `bold ${Math.max(9, r * 0.7)}px system-ui`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(x + r * 0.8, y - r * 0.8, r * 0.45, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff'; ctx.fillText(String(level), x + r * 0.8, y - r * 0.8 + 0.5); }
    const bw = r * 2.2, bh = Math.max(3, r / 4);
    ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(x - bw / 2, y - r - bh - 3, bw, bh);
    ctx.fillStyle = hp / maxHp > 0.5 ? '#4caf50' : hp / maxHp > 0.25 ? '#f5c542' : '#e53935';
    ctx.fillRect(x - bw / 2, y - r - bh - 3, bw * clamp(hp / maxHp, 0, 1), bh);
    if (ownerSm === G.me) { ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(x - bw / 2, y + r + 3, bw, 2); ctx.fillStyle = '#ffb347'; ctx.fillRect(x - bw / 2, y + r + 3, bw * (1 - clamp(cannon / 60, 0, 1)), 2); }
    if (ownerSm === G.me && (mch[13] || (mode && mode !== 'hold')) && r >= 9) {
      const tag = mch[13] ? 'REFIT' : { roam: 'ROAM', defend: 'DEFEND', assault: 'ASSAULT' }[mode] || '';
      if (tag) {
        ctx.font = `bold ${Math.max(8, r * 0.5)}px "Segoe UI", system-ui, sans-serif`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const w = ctx.measureText(tag).width + 8;
        ctx.fillStyle = 'rgba(0,0,0,0.65)';
        ctx.fillRect(x - w / 2, y + r + 5, w, r * 0.62);
        ctx.fillStyle = mch[13] ? '#ffd166' : mode === 'assault' ? '#ff9e93' : mode === 'defend' ? '#9ad0ff' : '#b9f6ca';
        ctx.fillText(tag, x, y + r + 5 + r * 0.31);
      }
    }
    if (ownerSm === G.me && patrol >= 0 && (isSel || cam.zoom > 2)) { const [px, py] = toScreen(tileX(patrol) + 0.5, tileY(patrol) + 0.5); ctx.setLineDash([2, 4]); ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(px, py); ctx.stroke(); ctx.setLineDash([]); }
  }
  // attack front markers (OpenFront: crossed swords + troops at the edge of the attack)
  if (cam.zoom > 0.35) {
    for (const a of G.attacks) {
      const [id, atk, tgt, troops, , fx, fy] = a;
      if (fx < 0 || fy < 0) continue;
      const involved = atk === G.me || tgt === G.me;
      if (!involved && cam.zoom < 1.5) continue;
      const [lx, ly] = lerpPos('atk' + id, fx, fy);
      const [x, y] = toScreen(lx + 0.5, ly + 0.5);
      if (!visible(x, y)) continue;
      const s = clamp(7 * cam.zoom, 14, 26);
      ctx.globalAlpha = involved ? 1 : 0.6;
      const ic = icons.sword;
      if (ic) { ctx.drawImage(ic, x - s / 2, y - s, s, s); }
      ctx.font = `bold ${clamp(5 * cam.zoom, 12, 18)}px "Segoe UI", system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      const txt = (tgt === G.me ? '+' : '') + fmt(troops);
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.fillStyle = tgt === G.me ? '#ff9e93' : atk === G.me ? '#fff' : '#ddd';
      ctx.strokeText(txt, x, y + 1); ctx.fillText(txt, x, y + 1);
      ctx.globalAlpha = 1;
    }
  }
  // wall drawing cost label
  if (wallDraw && wallDraw.quote) {
    const q = wallDraw.quote;
    const txt = q.ok ? `${q.tiles.length} tiles · ${fmt(q.cost)} gold${q.afford ? '' : ' (not enough gold)'}` : q.reason;
    ctx.font = 'bold 13px "Segoe UI", system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    const w = ctx.measureText(txt).width + 12;
    ctx.fillStyle = q.ok && q.afford ? 'rgba(20,60,20,0.9)' : 'rgba(80,20,20,0.9)';
    ctx.fillRect(mouse.x + 12, mouse.y - 30, w, 22);
    ctx.fillStyle = '#fff'; ctx.fillText(txt, mouse.x + 18, mouse.y - 12);
  }
  // selection box
  if (boxSelect) {
    const x = Math.min(boxSelect.x0, boxSelect.x1), y = Math.min(boxSelect.y0, boxSelect.y1);
    const w = Math.abs(boxSelect.x1 - boxSelect.x0), h = Math.abs(boxSelect.y1 - boxSelect.y0);
    ctx.fillStyle = 'rgba(120, 200, 255, 0.12)'; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(160, 220, 255, 0.9)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
    ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
    if (boxSelect.kind) {
      ctx.font = 'bold 12px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#cfe8ff'; ctx.fillText(`selecting ${boxSelect.kind}s`, x + 2, y - 3);
    }
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
      ctx.lineWidth = Math.max(2, size / 6); ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.fillStyle = '#111';
      ctx.strokeText(p.name, x, y - size * 0.5); ctx.fillText(p.name, x, y - size * 0.5);
      ctx.font = `${size * 0.85}px "Segoe UI", system-ui, sans-serif`;
      const t = fmt(p.troops);
      ctx.strokeText(t, x, y + size * 0.55); ctx.fillText(t, x, y + size * 0.55);
      let ix = x - ctx.measureText(p.name).width / 2 - size * 0.8;
      if (sm === G.leaderSm && icons.crown) { const s = size * 1.1; ctx.drawImage(icons.crown, x - s / 2, y - size * 0.5 - size * 0.55 - s, s, s); }
      if (p.traitor && icons.traitor) { const s = size * 0.9; ctx.drawImage(icons.traitor, ix - s, y - size * 0.5 - s / 2, s, s); ix -= s + 2; }
      if (myAllies.includes(sm) && icons.ally) { const s = size * 0.9; ctx.drawImage(icons.ally, ix - s, y - size * 0.5 - s / 2, s, s); }
    }
  }
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
$('cp-gold').addEventListener('mousemove', (e) => { const p = me(); if (p) showTip(goldTipHtml(p), e.clientX, e.clientY); });
$('cp-gold').addEventListener('mouseleave', hideTip);
connect();
requestAnimationFrame(draw);
setInterval(() => { if (net.connected) fetch('/healthz').catch(() => {}); }, 4 * 60 * 1000);
})();
