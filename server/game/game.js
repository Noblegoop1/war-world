'use strict';
// Authoritative game simulation. Runs on the server at 10 ticks/second.
// Core: players, land ownership, spawning, attacks, alliances, serialization.
// Other systems are mixed in from their modules (see the bottom of this file).
const { Rng, hashString } = require('./rng');
const {
  TerrainType, PlayerType, UnitType, STRUCTURE_TYPES, NukeType, Config, within, TICKS_PER_SECOND,
  HUMAN_COLORS, NATION_COLORS, BOT_COLORS, RESEARCH, RESEARCH_BY_ID,
} = require('./config');
const { IS_LAND, OCEAN, MAG_MASK, IMPASSABLE } = require('./maps');
const R = require('./research').effects;

// ---------------------------------------------------------------------------
class Heap {
  constructor() { this.p = []; this.v = []; }
  get size() { return this.v.length; }
  clear() { this.p.length = 0; this.v.length = 0; }
  push(value, prio) {
    const p = this.p, v = this.v;
    let i = v.length;
    p.push(prio); v.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (p[parent] <= p[i]) break;
      [p[parent], p[i]] = [p[i], p[parent]];
      [v[parent], v[i]] = [v[i], v[parent]];
      i = parent;
    }
  }
  pop() {
    const p = this.p, v = this.v;
    const top = v[0];
    const lastP = p.pop(), lastV = v.pop();
    if (v.length > 0) {
      p[0] = lastP; v[0] = lastV;
      let i = 0;
      const n = v.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < n && p[l] < p[m]) m = l;
        if (r < n && p[r] < p[m]) m = r;
        if (m === i) break;
        [p[m], p[i]] = [p[i], p[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

const GENERIC_NATION_NAMES = [
  'Valoria', 'Kestria', 'Norvane', 'Ostmark', 'Thalassa', 'Bruma', 'Cinder', 'Dravos', 'Elmara', 'Fenwick',
  'Garrow', 'Halcyon', 'Ivaria', 'Jorvik', 'Korrath', 'Lumen', 'Meridia', 'Nyxos', 'Orlan', 'Pellucid',
  'Quorra', 'Rhoswen', 'Solmar', 'Tarquin', 'Ulmere', 'Vireo', 'Wexley', 'Xantho', 'Yarrow', 'Zephyra',
  'Arden', 'Belmont', 'Calder', 'Dunmore', 'Ecliptia', 'Farrago', 'Glimmer', 'Hollow', 'Isolde', 'Juno',
];
const BOT_NAMES = [
  'Reed Clan', 'Ash Tribe', 'Stone Folk', 'River Band', 'Moss Kin', 'Fern People', 'Dust Nomads', 'Salt Tribe',
  'Pine Clan', 'Ember Kin', 'Frost Folk', 'Clay Band', 'Marsh Tribe', 'Crag Clan', 'Hollow Kin', 'Dune Folk',
  'Oak Clan', 'Wolf Tribe', 'Hawk People', 'Bear Kin', 'Elk Band', 'Raven Folk', 'Boar Clan', 'Fox Tribe',
];

class Player {
  constructor(game, { id, smallID, name, type, color, flag }) {
    this.game = game;
    this.id = id;
    this.smallID = smallID;
    this.name = name;
    this.type = type;
    this.color = color;
    this.flag = flag || '';
    this.troops = 0;
    this.gold = 0;
    this.tiles = new Set();
    this.border = new Set();
    this.units = [];          // fixed structures
    this.spawned = false;
    this.spawnTile = null;
    this.spawnTick = 0;
    this.deathTick = 0;
    this.allies = new Set();
    this.traitorUntil = 0;
    this.relations = new Map();
    this.disconnected = false;
    this.outgoingAttacks = [];
    this.incomingAttacks = [];
    this.boats = [];
    this.warships = [];
    this.subs = [];
    this.mechs = [];
    this.airships = [];
    this.airshipsBuilt = 0;
    this.ai = null;
    this.conqueredBy = null;
    this.nationSpawn = null;
    this.goldEarned = 0;
    this.researches = new Set();
    this.research = null;          // { id, doneTick, labId }
    this.pendingChoices = null;    // { labId, choices }
    this.goldRate = 0;
    this.numWallTiles = 0;
    this.wallQueue = [];           // blocks under construction, built one at a time
    this.focusTile = -1;           // where the player wants expansion pulled toward (mouse / AI intent)
    this.connectedFactories = 0;
    this.lastNukedBy = null;
  }
  get numTiles() { return this.tiles.size; }
  get alive() { return this.spawned && this.tiles.size > 0; }
  researchCount() { return this.researches.size + (this.research ? 1 : 0); }
  isTraitor() { return this.game.tick < this.traitorUntil; }
  isFriendly(other) { return other === this || this.allies.has(other.id); }
  unitsOf(type) { return this.units.filter((u) => u.type === type); }
  completedUnitsOf(type) { return this.units.filter((u) => u.type === type && u.constructionLeft === 0); }
  unitLevels(type) { return this.completedUnitsOf(type).reduce((s, u) => s + u.level, 0); }
  cityLevels() { return this.unitLevels(UnitType.CITY); }
  addTroops(n) { this.troops = Math.max(0, this.troops + n); }
  removeTroops(n) { const r = Math.min(this.troops, Math.max(0, Math.floor(n))); this.troops -= r; return r; }
  addGold(n) { this.gold += n; this.goldEarned += n; }
  removeGold(n) { const r = Math.min(this.gold, Math.max(0, n)); this.gold -= r; return r; }
  relation(other) { return this.relations.get(other.id) ?? 0; }
  updateRelation(other, delta) { this.relations.set(other.id, within(this.relation(other) + delta, -100, 100)); }
  isAttacking() { return this.outgoingAttacks.some((a) => a.target && !a.done); }
}

// Directional expansion lean (see attackAddNeighbors). FOCUS_PULL scales the terrain term by
// +-FOCUS_PULL, which is +-20% on an ordinary tile's priority; a focus closer than
// FOCUS_MIN_DISTANCE tiles to the attack's origin is ignored as noise.
const FOCUS_PULL = 0.4;
// Unclaimed-landmass scan (see neutralRegions): how often to redo it, and the smallest patch worth a boat.
const REGION_SCAN_INTERVAL = 300;
const MIN_REGION_SIZE = 60;
// Attack marker (the crossed swords + troop count). We keep the last FRONT_SAMPLE conquests and put the
// marker on whichever of them sits nearest their centre, so it always lands on ground the attack is
// actually taking. A plain average drifts into the middle of the defender when a front wraps around them.
// Radiation decays one step every FALLOUT_DECAY_INTERVAL ticks (see addFallout / tickFallout).
const FALLOUT_DECAY_INTERVAL = 10;
const FRONT_SAMPLE = 48;
const FRONT_SMOOTHING = 0.3;
const FOCUS_MIN_DISTANCE = 8;

class Attack {
  constructor(id, attacker, target, troops, sourceTile) {
    this.id = id;
    this.attacker = attacker;
    this.target = target; // Player | null
    this.troops = troops;
    this.sourceTile = sourceTile;
    this.border = new Set();
    this.heap = new Heap();
    this.retreated = false;
    this.done = false;
    this.rng = new Rng(id * 7919 + 13);
    this.nbuf = [0, 0, 0, 0];
    this.nbuf2 = [0, 0, 0, 0];
    this.originX = 0; this.originY = 0;
    this.focus = -1;
    this.fdx = 0; this.fdy = 0; // unit vector origin -> focus, 0,0 when there is no focus
    this.frontX = 0; this.frontY = 0; // running centroid of this tick's conquests
    this.frontN = 0;
    this.recent = new Int32Array(FRONT_SAMPLE).fill(-1); // ring of the last conquests
    this.recentI = 0;
    this.markX = -1; this.markY = -1;  // smoothed marker position, always on a tile we actually took
  }
  // Cache the pull direction; recomputed whenever the focus or the origin changes.
  setFocusTile(g, tile) {
    this.focus = tile;
    this.fdx = 0; this.fdy = 0;
    if (tile < 0 || tile >= g.terrain.length) return;
    const dx = g.x(tile) - this.originX, dy = g.y(tile) - this.originY;
    const len = Math.hypot(dx, dy);
    if (len > FOCUS_MIN_DISTANCE) { this.fdx = dx / len; this.fdy = dy / len; }
  }
}

const { newId } = require('./ids');

class Game {
  constructor(settings, map) {
    this.settings = settings;
    this.config = new Config(settings);
    this.map = map;
    this.width = map.width;
    this.height = map.height;
    this.terrain = map.terrain;
    this.numLand = map.numLand;
    this.owner = new Uint16Array(this.width * this.height);
    this.fallout = new Uint8Array(this.width * this.height);
    this.falloutTiles = new Set();
    this.buildLandmasses();
    this.wallHp = new Uint16Array(this.width * this.height);
    this.numFallout = 0;
    this.rng = new Rng((map.seed ^ 0x5bd1e995) >>> 0);
    this.tick = 0;
    this.phase = 'spawn';
    this.players = [];
    this.playersBySmall = [null];
    this.playersById = new Map();
    this.attacks = [];
    this.units = [];
    this.unitByTile = new Map();
    this.boats = [];
    this.tradeShips = [];
    this.warships = [];
    this.subs = [];
    this.mechs = [];
    this.airships = [];
    this.shells = [];
    this.trains = [];
    this.rails = [];
    this.railAdj = new Map();
    this.railsChanged = true;
    this.nukes = [];
    this.bombers = [];
    this.allianceRequests = new Map();
    this.events = [];
    this.changedTiles = [];
    this.unitsChanged = true;
    this.winner = null;
    this.winTick = 0;
    this.spawnTicks = this.config.numSpawnPhaseTicks();
    this.usedNames = new Set();
    this.nbuf = [0, 0, 0, 0];
    this.tradePathCache = new Map();
    this.colorCounters = { human: 0, nation: 0, bot: 0 };
    this.pathBudget = 0; // expensive path searches allowed this tick
  }

  // ---- tile helpers ------------------------------------------------------
  x(i) { return i % this.width; }
  y(i) { return (i / this.width) | 0; }
  ref(x, y) { return y * this.width + x; }
  valid(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }
  get nbufA() { return this._nbufA || (this._nbufA = [0, 0, 0, 0]); }
  isLand(i) { const t = this.terrain[i]; return (t & IS_LAND) !== 0 && (t & MAG_MASK) !== IMPASSABLE; }
  isWater(i) { return (this.terrain[i] & IS_LAND) === 0; }
  isOcean(i) { return (this.terrain[i] & (IS_LAND | OCEAN)) === OCEAN; }
  terrainType(i) {
    const t = this.terrain[i];
    if (!(t & IS_LAND)) return TerrainType.WATER;
    const m = t & MAG_MASK;
    return m < 10 ? TerrainType.PLAINS : m < 20 ? TerrainType.HIGHLAND : TerrainType.MOUNTAIN;
  }
  neighbors4(i, out) {
    const w = this.width, x = i % w, y = (i / w) | 0;
    let n = 0;
    if (x > 0) out[n++] = i - 1;
    if (x < w - 1) out[n++] = i + 1;
    if (y > 0) out[n++] = i - w;
    if (y < this.height - 1) out[n++] = i + w;
    return n;
  }
  isShore(i) {
    if (!this.isLand(i)) return false;
    const b = this.nbuf, n = this.neighbors4(i, b);
    for (let k = 0; k < n; k++) if (this.isWater(b[k])) return true;
    return false;
  }
  isOceanShore(i) {
    if (!this.isLand(i)) return false;
    const b = this.nbuf, n = this.neighbors4(i, b);
    for (let k = 0; k < n; k++) if (this.isOcean(b[k])) return true;
    return false;
  }
  dist(a, b) { const dx = this.x(a) - this.x(b), dy = this.y(a) - this.y(b); return Math.sqrt(dx * dx + dy * dy); }
  distXY(x1, y1, x2, y2) { return Math.hypot(x1 - x2, y1 - y2); }
  ownerOf(i) { return this.playersBySmall[this.owner[i]] || null; }
  tileAt(x, y) { return this.ref(Math.floor(x), Math.floor(y)); }
  randomTileOf(set, rng) {
    if (set.size === 0) return null;
    let skip = rng.int(0, Math.min(set.size - 1, 5000));
    for (const t of set) { if (skip-- <= 0) return t; }
    return null;
  }
  hostile(a, b) { return a && b && a !== b && !a.isFriendly(b); }

  // ---- players -------------------------------------------------------------
  addPlayer({ id, name, type, flag }) {
    const smallID = this.playersBySmall.length;
    const palette = type === PlayerType.BOT ? BOT_COLORS : type === PlayerType.NATION ? NATION_COLORS : HUMAN_COLORS;
    const key = type === PlayerType.BOT ? 'bot' : type === PlayerType.NATION ? 'nation' : 'human';
    const idx = this.colorCounters[key]++;
    const color = key === 'human' ? palette[(idx * 7) % palette.length] : palette[idx % palette.length];
    let finalName = name;
    let k = 2;
    while (this.usedNames.has(finalName)) finalName = `${name} ${k++}`;
    this.usedNames.add(finalName);
    const p = new Player(this, { id, smallID, name: finalName, type, color, flag });
    this.players.push(p);
    this.playersBySmall.push(p);
    this.playersById.set(id, p);
    p.gold = this.settings.startingGold;
    return p;
  }
  addAIPlayers(NationAI, BotAI) {
    const manifestNations = [...(this.map.nations || [])];
    for (let i = manifestNations.length - 1; i > 0; i--) { const j = this.rng.int(0, i); [manifestNations[i], manifestNations[j]] = [manifestNations[j], manifestNations[i]]; }
    for (let i = 0; i < this.settings.nations; i++) {
      const mn = manifestNations[i];
      const name = mn ? mn.name : GENERIC_NATION_NAMES[i % GENERIC_NATION_NAMES.length];
      const p = this.addPlayer({ id: `nation-${i + 1}`, name, type: PlayerType.NATION, flag: mn ? mn.flag : '' });
      if (mn) p.nationSpawn = { x: mn.x, y: mn.y };
      p.ai = new NationAI(this, p, (hashString(p.id) ^ this.map.seed) >>> 0);
    }
    for (let i = 0; i < this.settings.bots; i++) {
      const p = this.addPlayer({ id: `bot-${i + 1}`, name: BOT_NAMES[i % BOT_NAMES.length], type: PlayerType.BOT });
      p.ai = new BotAI(this, p, (hashString(p.id) ^ this.map.seed) >>> 0);
    }
  }
  player(id) { return this.playersById.get(id) || null; }

  // ---- landmasses ----------------------------------------------------------
  // Every land tile gets the id of the continent/island it belongs to. Land connectivity never changes,
  // so this is computed once. It is what tells an attack order "you can walk there" versus "you need a
  // boat" - the old test was whether the player touched *any* neutral land anywhere, which sent boats
  // across your own continent.
  buildLandmasses() {
    const n = this.width * this.height;
    this.landmass = new Int32Array(n).fill(-1);
    const queue = new Int32Array(n);
    const b = [0, 0, 0, 0];
    let id = 0;
    for (let start = 0; start < n; start++) {
      if (this.landmass[start] !== -1 || !this.isLand(start)) continue;
      let head = 0, tail = 0;
      queue[tail++] = start; this.landmass[start] = id;
      while (head < tail) {
        const t = queue[head++];
        const m = this.neighbors4(t, b);   // 4-connected, matching how attacks actually spread
        for (let k = 0; k < m; k++) {
          const nb = b[k];
          if (this.landmass[nb] !== -1 || !this.isLand(nb)) continue;
          this.landmass[nb] = id;
          queue[tail++] = nb;
        }
      }
      id++;
    }
    this.numLandmasses = id;
  }
  // Does this player hold ground on the same landmass as `tile`? Sampled from their border, which is
  // where an attack would start from anyway.
  onSameLandmass(p, tile) {
    if (!this.landmass) return false;
    const want = this.landmass[tile];
    if (want < 0) return false;
    for (const t of p.border) if (this.landmass[t] === want) return true;
    return false;
  }

  // ---- fallout -------------------------------------------------------------
  // Radiation is a countdown, not a flag: a blast site is poisonous for a while and then usable again.
  // Without the decay a nuked border stays a permanent no-man's land and the map slowly rots.
  addFallout(tile, ticks) {
    if (!this.fallout[tile]) this.numFallout++;
    this.fallout[tile] = Math.max(this.fallout[tile], Math.min(255, Math.ceil(ticks / FALLOUT_DECAY_INTERVAL)));
    this.falloutTiles.add(tile);
    this.changedTiles.push(tile);
  }
  clearFallout(tile) {
    if (!this.fallout[tile]) return;
    this.fallout[tile] = 0;
    this.numFallout--;
    this.falloutTiles.delete(tile);
  }
  tickFallout() {
    if (this.tick % FALLOUT_DECAY_INTERVAL !== 0 || !this.falloutTiles.size) return;
    for (const t of this.falloutTiles) {
      if (--this.fallout[t] > 0) continue;
      this.fallout[t] = 0;
      this.numFallout--;
      this.falloutTiles.delete(t);
      this.changedTiles.push(t);
    }
  }

  // ---- ownership -----------------------------------------------------------
  conquer(p, tile) {
    const prevSm = this.owner[tile];
    if (prevSm === p.smallID) return;
    if (prevSm !== 0) { const prev = this.playersBySmall[prevSm]; prev.tiles.delete(tile); prev.border.delete(tile); }
    this.owner[tile] = p.smallID;
    if (this.fallout[tile]) this.clearFallout(tile);   // taking the ground cleans it up
    if (this.wallHp[tile]) this.clearWallTile(tile);
    p.tiles.add(tile);
    this.changedTiles.push(tile);
    this.updateBorder(tile);
    const b = this.nbuf, n = this.neighbors4(tile, b);
    for (let k = 0; k < n; k++) this.updateBorder(b[k]);
    const u = this.unitByTile.get(tile);
    if (u && u.owner !== p) {
      if (u.type === UnitType.DEFENSE_POST || u.type === UnitType.MINE) this.removeUnit(u);
      else this.transferUnit(u, p);
    }
  }
  relinquish(tile) {
    const prevSm = this.owner[tile];
    if (prevSm === 0) return;
    const prev = this.playersBySmall[prevSm];
    prev.tiles.delete(tile);
    prev.border.delete(tile);
    this.owner[tile] = 0;
    if (this.wallHp[tile]) this.clearWallTile(tile);
    this.changedTiles.push(tile);
    const b = this.nbuf, n = this.neighbors4(tile, b);
    for (let k = 0; k < n; k++) this.updateBorder(b[k]);
  }
  updateBorder(tile) {
    const sm = this.owner[tile];
    if (sm === 0) return;
    const p = this.playersBySmall[sm];
    const b = [0, 0, 0, 0];
    const n = this.neighbors4(tile, b);
    let isBorder = n < 4;
    for (let k = 0; k < n && !isBorder; k++) if (this.owner[b[k]] !== sm) isBorder = true;
    if (isBorder) p.border.add(tile); else p.border.delete(tile);
  }
  transferUnit(u, to) {
    if (u.type === UnitType.LAB) this.onLabLost(u);   // captured labs stop working for their old owner
    const from = u.owner;
    if (from) from.units = from.units.filter((x) => x !== u);
    u.owner = to;
    to.units.push(u);
    this.unitsChanged = true;
    this.onStationOwnerChanged(u);
  }
  removeUnit(u) {
    if (u.type === UnitType.LAB) this.onLabLost(u);
    if (u.owner) u.owner.units = u.owner.units.filter((x) => x !== u);
    this.units = this.units.filter((x) => x !== u);
    this.unitByTile.delete(u.tile);
    this.unitsChanged = true;
    this.onUnitRemoved(u);
  }
  neighborsOf(p) {
    const set = new Set();
    let touchesNeutral = false;
    const b = [0, 0, 0, 0];
    for (const t of p.border) {
      const n = this.neighbors4(t, b);
      for (let k = 0; k < n; k++) {
        const nb = b[k];
        if (!this.isLand(nb)) continue;
        const o = this.owner[nb];
        if (o === 0) touchesNeutral = true;   // includes irradiated ground: it is free land, just nasty to cross
        else if (o !== p.smallID) set.add(this.playersBySmall[o]);
      }
    }
    return { players: [...set], touchesNeutral };
  }
  // Centroid of a player's territory (sampled for big empires).
  centroid(p) {
    let sx = 0, sy = 0, n = 0, skip = Math.max(1, Math.floor(p.tiles.size / 2000)), i = 0;
    for (const t of p.tiles) { if (i++ % skip) continue; sx += this.x(t); sy += this.y(t); n++; }
    return n ? { x: sx / n, y: sy / n } : null;
  }

  // ---- spawning --------------------------------------------------------------
  getSpawnTiles(center) {
    const r = this.config.spawnRadius();
    const out = [];
    const seen = new Set([center]);
    const queue = [[center, 0]];
    const b = [0, 0, 0, 0];
    while (queue.length) {
      const [t, d] = queue.shift();
      if (!this.isLand(t) || this.owner[t] !== 0) continue;
      out.push(t);
      if (d >= r) continue;
      const n = this.neighbors4(t, b);
      for (let k = 0; k < n; k++) if (!seen.has(b[k])) { seen.add(b[k]); queue.push([b[k], d + 1]); }
    }
    return out;
  }
  spawn(p, tile) {
    if (this.phase !== 'spawn') return false;
    if (!this.isLand(tile)) return false;
    if (this.owner[tile] !== 0 && this.owner[tile] !== p.smallID) return false;
    for (const t of [...p.tiles]) this.relinquish(t);
    const tiles = this.getSpawnTiles(tile);
    if (tiles.length < 5) return false;
    for (const t of tiles) this.conquer(p, t);
    if (!p.spawned) { p.spawned = true; p.troops = this.config.startTroops(p.type); }
    p.spawnTile = tile;
    p.spawnTick = this.tick;
    return true;
  }
  randomSpawnTile(minDist, near = null, delta = 25) {
    for (let tries = 0; tries < 300; tries++) {
      let t;
      if (near) {
        const x = this.rng.int(near.x - delta, near.x + delta), y = this.rng.int(near.y - delta, near.y + delta);
        if (!this.valid(x, y)) continue;
        t = this.ref(x, y);
      } else t = this.rng.int(0, this.terrain.length - 1);
      if (!this.isLand(t) || this.owner[t] !== 0) continue;
      if (this.terrainType(t) === TerrainType.MOUNTAIN && this.rng.chance(2)) continue;
      let ok = true;
      if (minDist > 0) {
        for (const o of this.players) if (o.spawned && o.spawnTile !== null && this.dist(o.spawnTile, t) < minDist) { ok = false; break; }
      }
      if (ok) return t;
    }
    return null;
  }

  // ---- main loop -------------------------------------------------------------
  step() {
    this.tick++;
    if (this.phase === 'over') return;
    if (this.phase === 'spawn') {
      for (const p of this.players) if (p.ai) p.ai.tick();
      if (this.tick >= this.spawnTicks) this.endSpawnPhase();
      return;
    }
    this.pathBudget = 3;
    for (const p of this.players) {
      if (!p.alive) continue;
      p.addTroops(this.config.troopIncreaseRate(p));
      const g = this.config.goldAdditionRate(p, p.isAttacking());
      p.goldRate = g;
      p.addGold(g);
    }
    for (const u of this.units) {
      if (u.constructionLeft > 0) { u.constructionLeft--; if (u.constructionLeft === 0) { this.unitsChanged = true; this.onUnitCompleted(u); } }
      if (u.cooldown > 0) { u.cooldown--; if (u.cooldown === 0) this.unitsChanged = true; }
    }
    this.tickAttacks();
    this.tickWalls();
    this.tickBoats();
    this.tickTrade();
    this.tickTrains();
    this.tickWarships();
    this.tickSubs();
    this.tickMines();
    this.tickMechs();
    this.tickAirships();
    this.tickShells();
    this.tickNukes();
    this.tickBombers();
    this.tickResearch();
    this.tickDefensePosts();
    this.tickArtillery();
    this.tickRepairYards();
    this.tickFallout();
    this.expireAllianceRequests();
    for (const p of this.players) if (p.ai && p.alive) p.ai.tick();
    this.checkDeaths();
    if (this.tick % 10 === 0) this.checkWin();
  }
  endSpawnPhase() {
    for (const p of this.players) {
      if (!p.spawned) {
        const t = this.randomSpawnTile(p.type === PlayerType.HUMAN ? 10 : this.config.minDistanceBetweenPlayers(), p.nationSpawn);
        if (t !== null) this.spawn(p, t);
      }
    }
    this.phase = 'play';
    this.events.push({ k: 'phase', phase: 'play' });
  }
  checkDeaths() {
    for (const p of this.players) {
      if (p.spawned && p.tiles.size === 0 && p.deathTick === 0) {
        p.deathTick = this.tick;
        for (const a of p.outgoingAttacks) a.done = true;
        for (const u of [...p.units]) this.removeUnit(u);
        for (const m of p.mechs) m.done = true;
      for (const a of p.airships) a.done = true;
        for (const w of p.warships) w.done = true;
        for (const s of p.subs) s.done = true;
        this.events.push({ k: 'death', p: p.smallID, by: p.conqueredBy ? p.conqueredBy.smallID : 0 });
      }
    }
  }
  checkWin() {
    const need = this.config.percentageTilesOwnedToWin() / 100 * this.numLand;
    let best = null;
    for (const p of this.players) if (p.alive && (best === null || p.tiles.size > best.tiles.size)) best = p;
    if (!best) return;
    const aliveCount = this.players.filter((p) => p.alive).length;
    if (best.tiles.size >= need || (aliveCount === 1 && this.tick > this.spawnTicks + 100)) {
      this.phase = 'over';
      this.winner = best;
      this.winTick = this.tick;
      this.events.push({ k: 'win', p: best.smallID });
    }
  }

  // ---- attacks ----------------------------------------------------------------
  canAttack(p, target) {
    if (!p.alive) return false;
    if (target === p) return false;
    if (target && !target.alive) return false;
    if (target && p.isFriendly(target)) return false;
    if (target && target.type === PlayerType.HUMAN && this.tick - target.spawnTick < this.config.spawnImmunityTicks()) return false;
    return true;
  }
  sendAttack(p, target, troops, sourceTile = null, focusTile = -1) {
    if (!this.canAttack(p, target)) return null;
    troops = Math.min(p.troops, Math.floor(troops));
    if (troops < 1) return null;
    p.removeTroops(troops);
    const a = new Attack(newId(), p, target, troops, sourceTile);
    const c = sourceTile !== null ? { x: this.x(sourceTile), y: this.y(sourceTile) } : (this.centroid(p) || { x: 0, y: 0 });
    a.originX = c.x; a.originY = c.y;
    a.setFocusTile(this, focusTile >= 0 ? focusTile : p.focusTile);
    if (target) {
      const delta = { easy: -60, medium: -70, hard: -80, impossible: -100 }[this.settings.difficulty] || -70;
      target.updateRelation(p, delta);
      this.allianceRequests.delete(`${target.id}|${p.id}`);
    }
    if (sourceTile !== null) this.attackAddNeighbors(a, sourceTile);
    else this.attackRefreshBorder(a);
    if (target) {
      for (const inc of p.incomingAttacks) {
        if (inc.attacker === target && !inc.done) {
          if (inc.troops > a.troops) { inc.troops -= a.troops; a.done = true; return null; }
          a.troops -= inc.troops; inc.done = true;
        }
      }
    }
    if (sourceTile === null) {
      for (const out of p.outgoingAttacks) {
        if (!out.done && out.target === target && out.sourceTile === null) { a.troops += out.troops; out.done = true; a.setFocusTile(this, focusTile >= 0 ? focusTile : out.focus); }
      }
    }
    this.attacks.push(a);
    p.outgoingAttacks.push(a);
    if (target) {
      target.incomingAttacks.push(a);
      if (target.type === PlayerType.HUMAN) this.events.push({ k: 'attacked', to: target.id, by: p.smallID, troops: a.troops });
    }
    return a;
  }
  retreatAttack(p, attackId) {
    const a = this.attacks.find((x) => x.id === attackId && x.attacker === p);
    if (a && !a.done) a.retreated = true;
  }
  setFocus(p, tile) {
    p.focusTile = tile;
    for (const a of p.outgoingAttacks) if (!a.done) a.setFocusTile(this, tile);
  }
  attackRefreshBorder(a) {
    a.heap.clear();
    a.border.clear();
    for (const t of a.attacker.border) this.attackAddNeighbors(a, t);
  }
  // OpenFront's priority: (rand 0-7 + 10) * (1 - ownedNeighbours*0.5 + terrain/2) + tick. Tiles hugging the
  // existing front go first, so the wave stays coherent. War World adds a directional pull (~20%) toward
  // the player's focus tile (mouse position for humans, chosen direction for AI).
  // OpenFront's frontier rule, unchanged: every tile of the target that touches the tile we just took
  // is (re-)queued with
  //     priority = (rand(0..7) + 10) * (1 - numOwnedByMe * 0.5 + mag / 2) + tick
  // Two things fall out of that and they are what make the territory look the way it does:
  //  * a tile with 3-4 of its neighbours already ours scores <= 0, so it is taken *this* tick — dents
  //    in the front fill themselves in before the front moves on, which is what keeps the edge smooth;
  //  * everything else lands 10-17 ticks in the future, so the front advances as a timed wave rather
  //    than a race, and rough terrain rides at the back of it.
  // Re-queueing (rather than skipping tiles already on the border) is deliberate: a tile's priority has
  // to improve as more of its neighbours fall, or the first estimate freezes the shape.
  attackAddNeighbors(a, tile) {
    const targetSm = a.target ? a.target.smallID : 0;
    const mySm = a.attacker.smallID;
    const n = this.neighbors4(tile, a.nbuf);
    for (let i = 0; i < n; i++) {
      const nb = a.nbuf[i];
      if (!this.isLand(nb) || this.owner[nb] !== targetSm) continue;
      a.border.add(nb);
      let numOwnedByMe = 0;
      const m = this.neighbors4(nb, a.nbuf2);
      for (let j = 0; j < m; j++) if (this.owner[a.nbuf2[j]] === mySm) numOwnedByMe++;
      const tt = this.terrainType(nb);
      let mag = tt === TerrainType.MOUNTAIN ? 2 : tt === TerrainType.HIGHLAND ? 1.5 : 1;
      if (a.fdx !== 0 || a.fdy !== 0) {
        // Directional lean (ours, not OpenFront's): toward the focus a tile counts as easier ground,
        // away from it as rougher. Riding on `mag` keeps it inside OpenFront's own term, so it can
        // never outrank the concavity fill above — the front still smooths itself, it just leans.
        // +-FOCUS_PULL/2 on mag/2 works out to +-20% on the priority of an ordinary plains tile.
        const dx = this.x(nb) - a.originX, dy = this.y(nb) - a.originY;
        const d = Math.hypot(dx, dy);
        if (d > 0) mag *= 1 - FOCUS_PULL * ((dx * a.fdx + dy * a.fdy) / d);
      }
      a.heap.push(nb, (a.rng.int(0, 7) + 10) * (1 - numOwnedByMe * 0.5 + mag / 2) + this.tick);
    }
  }
  // Unclaimed landmasses, as connected components of neutral land. Nations use this to decide where to
  // colonise — an empty continent like Greenland or Antarctica is worth a boat even when it is far away,
  // and an island nobody borders is worth more than the same area wedged between two empires.
  // One shared scan for every AI, refreshed every REGION_SCAN_INTERVAL ticks.
  neutralRegions() {
    if (this.regionsCache && this.tick - this.regionsTick < REGION_SCAN_INTERVAL) return this.regionsCache;
    this.regionsTick = this.tick;
    const W = this.width, H = this.height, n = W * H;
    if (!this.regionSeen || this.regionSeen.length !== n) this.regionSeen = new Uint8Array(n);
    const seen = this.regionSeen;
    seen.fill(0);
    const regions = [];
    const queue = new Int32Array(n);
    const b = [0, 0, 0, 0];
    for (let start = 0; start < n; start++) {
      if (seen[start] || !this.isLand(start) || this.owner[start] !== 0) continue;
      let head = 0, tail = 0;
      queue[tail++] = start; seen[start] = 1;
      let size = 0, sx = 0, sy = 0, hostile = 0, edge = 0;
      const shores = [];
      while (head < tail) {
        const t = queue[head++];
        size++; sx += t % W; sy += (t / W) | 0;
        if (this.isOceanShore(t) && shores.length < 64 && (size & 7) === 1) shores.push(t);
        const m = this.neighbors4(t, b);
        if (m < 4) edge++;
        for (let k = 0; k < m; k++) {
          const nb = b[k];
          if (seen[nb]) continue;
          if (!this.isLand(nb)) { edge++; continue; }
          if (this.owner[nb] !== 0) { hostile++; continue; } // touches somebody's territory
          seen[nb] = 1; queue[tail++] = nb;
        }
      }
      if (size < MIN_REGION_SIZE || !shores.length) continue;
      regions.push({ size, cx: sx / size, cy: sy / size, shores, hostile, edge });
    }
    regions.sort((a, b2) => b2.size - a.size);
    this.regionsCache = regions.slice(0, 24);
    return this.regionsCache;
  }
  // A mech holds ground like a defense post: attacks near one bleed harder and crawl.
  hasMechNearby(owner, tile) {
    if (!owner.mechs.length) return false;
    const r = this.config.mechAuraRange(), x = this.x(tile), y = this.y(tile);
    for (const m of owner.mechs) {
      if (m.done) continue;
      if (Math.abs(m.x - x) > r || Math.abs(m.y - y) > r) continue;
      if ((m.x - x) ** 2 + (m.y - y) ** 2 <= r * r) return true;
    }
    return false;
  }
  hasDefensePostNearby(owner, tile) {
    const r = this.config.defensePostRange();
    for (const u of owner.units) {
      if (u.type !== UnitType.DEFENSE_POST || u.constructionLeft > 0) continue;
      if (this.dist(u.tile, tile) <= r) return true;
    }
    return false;
  }
  finishAttack(a, returnTroops, malusPercent = 0) {
    a.done = true;
    if (returnTroops) a.attacker.addTroops(a.troops * (1 - malusPercent / 100));
  }
  tickAttacks() {
    const cfg = this.config;
    for (const a of this.attacks) {
      if (a.done) continue;
      const attacker = a.attacker, target = a.target;
      if (!attacker.alive) { a.done = true; continue; }
      if (a.retreated) { this.finishAttack(a, true, target ? 25 : 0); continue; }
      if (target && (!target.alive || attacker.isFriendly(target))) { this.finishAttack(a, true, 0); continue; }
      const targetSm = target ? target.smallID : 0;
      const mySm = attacker.smallID;
      const borderSize = a.border.size + a.rng.int(0, 5);
      let tickBudget = 1;
      let troops = a.troops;
      const speedMult = R.attackSpeedMultiplier(attacker);
      const lossMult = R.attackerLossMultiplier(attacker, !!target);
      while (tickBudget > 0) {
        if (troops < 1) { a.troops = 0; a.done = true; break; }
        if (a.heap.size === 0) {
          this.attackRefreshBorder(a);
          if (a.heap.size === 0) { a.troops = troops; this.finishAttack(a, true, 0); break; }
        }
        const tile = a.heap.pop();
        a.border.delete(tile);
        if (this.owner[tile] !== targetSm || !this.isLand(tile)) continue;
        let onBorder = false;
        const n = this.neighbors4(tile, a.nbuf);
        for (let i = 0; i < n; i++) if (this.owner[a.nbuf[i]] === mySm) { onBorder = true; break; }
        if (!onBorder) continue;
        // Walls: grind the segment down; tiles behind it stay unreachable until it falls.
        if (this.wallHp[tile] > 0) {
          const wallMult = target ? R.wallDamageMultiplier(target) : 1;
          const dmg = Math.min(this.wallHp[tile], (300 + troops * 0.02) * wallMult);
          this.wallHp[tile] -= dmg;
          troops -= dmg * 0.02;
          a.troops = troops;
          tickBudget -= 0.5;
          if (this.wallHp[tile] <= 0) { this.clearWallTile(tile); a.heap.push(tile, this.tick); a.border.add(tile); }
          else { a.heap.push(tile, this.tick + 3); a.border.add(tile); }
          a.recent[a.recentI++ % FRONT_SAMPLE] = tile;
          continue;
        }
        this.attackAddNeighbors(a, tile);
        const res = cfg.attackLogic({
          terrain: this.terrainType(tile),
          attackTroops: troops,
          attacker: { type: attacker.type, numTiles: attacker.numTiles },
          defender: target ? { type: target.type, numTiles: target.numTiles, troops: target.troops, isTraitor: target.isTraitor() } : null,
          defenderHasDefensePost: target ? this.hasDefensePostNearby(target, tile) : false,
          isDefenderBorder: target ? target.border.has(tile) : false,
          defenderHasMech: target ? this.hasMechNearby(target, tile) : false,
          falloutRatio: this.fallout[tile] ? this.numFallout / this.numLand : null,
          borderSize,
          attackSpeedMult: speedMult,
          attackerLossMult: lossMult,
        });
        tickBudget -= res.tickFraction;
        troops -= res.attackerTroopLoss;
        a.troops = troops;
        if (target) target.removeTroops(res.defenderTroopLoss);
        const mech = target ? this.mechAtTile(tile) : null;
        if (mech && mech.owner === target) { // troops overrunning a mech chip it and get mauled
          mech.hp -= troops * 0.002;
          troops -= Math.min(troops * 0.3, 3000);
          a.troops = troops;
        }
        this.conquer(attacker, tile);
        a.recent[a.recentI++ % FRONT_SAMPLE] = tile;
        if (target) { this.handleDeadDefender(attacker, target); if (!target.alive) break; }
      }
      a.troops = Math.max(0, troops);
      this.updateAttackMarker(a);
    }
    if (this.attacks.some((a) => a.done)) {
      this.attacks = this.attacks.filter((a) => !a.done);
      for (const p of this.players) {
        p.outgoingAttacks = p.outgoingAttacks.filter((a) => !a.done);
        p.incomingAttacks = p.incomingAttacks.filter((a) => !a.done);
      }
    }
  }
  // Put the marker on the tile nearest the centre of our recent conquests, then ease towards it. The
  // snap is what keeps it on the front line; the easing is what stops it teleporting between fronts.
  updateAttackMarker(a) {
    let n = 0, sx = 0, sy = 0;
    for (let i = 0; i < FRONT_SAMPLE; i++) {
      const t = a.recent[i];
      if (t < 0) continue;
      sx += this.x(t); sy += this.y(t); n++;
    }
    if (!n) return;
    const mx = sx / n, my = sy / n;
    let bestX = -1, bestY = -1, bd = Infinity;
    for (let i = 0; i < FRONT_SAMPLE; i++) {
      const t = a.recent[i];
      if (t < 0) continue;
      const x = this.x(t), y = this.y(t);
      const d = (x - mx) ** 2 + (y - my) ** 2;
      if (d < bd) { bd = d; bestX = x; bestY = y; }
    }
    if (bestX < 0) return;
    if (a.markX < 0) { a.markX = bestX; a.markY = bestY; return; }
    a.markX += (bestX - a.markX) * FRONT_SMOOTHING;
    a.markY += (bestY - a.markY) * FRONT_SMOOTHING;
  }
  handleDeadDefender(attacker, target) {
    if (target.tiles.size === 0 || target.tiles.size >= this.config.conquerThresholdTiles()) return;
    this.conquerPlayer(attacker, target);
  }
  conquerPlayer(conqueror, target) {
    if (!target.alive) return;
    const gold = this.config.conquerGoldAmount(target);
    target.removeGold(Math.min(target.gold, gold));
    conqueror.addGold(gold);
    target.conqueredBy = conqueror;
    for (const t of [...target.tiles]) this.conquer(conqueror, t);
    for (const u of [...target.units]) this.transferUnit(u, conqueror);
    for (const b of target.boats) b.done = true;
    for (const a of target.outgoingAttacks) a.done = true;
    for (const id of target.allies) { const o = this.player(id); if (o) o.allies.delete(target.id); }
    target.allies.clear();
    this.events.push({ k: 'conquered', p: target.smallID, by: conqueror.smallID, gold });
  }

  // ---- alliances ------------------------------------------------------------------
  requestAlliance(from, to) {
    if (!from.alive || !to.alive || from === to) return false;
    if (from.allies.has(to.id)) return false;
    const key = `${from.id}|${to.id}`;
    if (this.allianceRequests.has(key)) return false;
    if (this.allianceRequests.has(`${to.id}|${from.id}`)) { this.allianceRequests.delete(`${to.id}|${from.id}`); this.acceptAlliance(to, from); return true; }
    this.allianceRequests.set(key, { from, to, tick: this.tick });
    if (to.type === PlayerType.HUMAN) this.events.push({ k: 'allyRequest', to: to.id, from: from.smallID });
    return true;
  }
  replyAlliance(to, from, accept) {
    const key = `${from.id}|${to.id}`;
    const req = this.allianceRequests.get(key);
    if (!req) return false;
    this.allianceRequests.delete(key);
    if (accept) this.acceptAlliance(from, to);
    else { from.updateRelation(to, -10); if (from.type === PlayerType.HUMAN) this.events.push({ k: 'allyRejected', to: from.id, by: to.smallID }); }
    return true;
  }
  acceptAlliance(a, b) {
    a.allies.add(b.id); b.allies.add(a.id);
    a.updateRelation(b, 30); b.updateRelation(a, 30);
    for (const atk of this.attacks) {
      if (!atk.done && ((atk.attacker === a && atk.target === b) || (atk.attacker === b && atk.target === a))) atk.retreated = true;
    }
    this.events.push({ k: 'allied', a: a.smallID, b: b.smallID });
  }
  breakAlliance(breaker, other) {
    if (!breaker.allies.has(other.id)) return false;
    breaker.allies.delete(other.id); other.allies.delete(breaker.id);
    breaker.traitorUntil = this.tick + this.config.traitorDurationTicks();
    other.updateRelation(breaker, -100);
    this.events.push({ k: 'betrayed', by: breaker.smallID, p: other.smallID });
    return true;
  }
  expireAllianceRequests() {
    for (const [k, r] of this.allianceRequests) if (this.tick - r.tick > this.config.allianceRequestTimeoutTicks()) this.allianceRequests.delete(k);
  }
  donate(from, to, troops, gold) {
    if (!from.alive || !to.alive || !from.allies.has(to.id)) return false;
    troops = Math.max(0, Math.floor(troops || 0)); gold = Math.max(0, Math.floor(gold || 0));
    const t = from.removeTroops(troops); to.addTroops(t);
    const g = from.removeGold(gold); to.addGold(g);
    if (t > 0 || g > 0) this.events.push({ k: 'donate', from: from.smallID, to: to.smallID, troops: t, gold: g });
    return true;
  }

  // ---- power stats (nation info card) ------------------------------------------------
  attackPower(p) {
    let v = p.troops;
    for (const m of p.mechs) v += (m.engaged ? 250000 : 700000) * (m.hp / m.maxHp);
    v += p.warships.filter((w) => !w.done).length * 120000 + p.subs.filter((s) => !s.done).length * 200000;
    v += p.completedUnitsOf(UnitType.SILO).length * 250000;
    v += p.completedUnitsOf(UnitType.DEFENSE_POST).length * 40000;
    for (const id of p.researches) if (RESEARCH_BY_ID[id] && RESEARCH_BY_ID[id].tags.some((t) => t === 'mech' || t === 'aggro' || t === 'defense' || t === 'nuke')) v *= 1.06;
    return Math.floor(v);
  }
  economyPower(p) {
    let v = p.goldRate * TICKS_PER_SECOND;
    v += p.unitLevels(UnitType.PORT) * 800 * R.tradeGoldMultiplier(p);
    v += p.unitLevels(UnitType.FACTORY) * 600 * R.trainGoldMultiplier(p);
    v += p.numTiles * 0.02;
    if (p.researches.has('mass_production')) v *= 1.15;
    return Math.floor(v);
  }

  // ---- serialization ----------------------------------------------------------------
  playerInfo(p) { return { id: p.id, sm: p.smallID, name: p.name, type: p.type, color: p.color, flag: p.flag }; }
  b64(arr) { return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64'); }
  fullState() {
    return {
      tick: this.tick, phase: this.phase, spawnTicks: this.spawnTicks,
      width: this.width, height: this.height, numLand: this.numLand, mapName: this.map.name,
      terrain: this.b64(this.terrain), owner: this.b64(this.owner), fallout: this.b64(this.fallout), walls: this.b64(this.wallHp),
      players: this.players.map((p) => this.playerInfo(p)),
      stats: this.statsPacket(), units: this.unitsPacket(), mechs: this.mechsPacket(), rails: this.railsPacket(),
      research: RESEARCH, settings: this.settings, winner: this.winner ? this.winner.smallID : 0,
    };
  }
  statsPacket() {
    const cfg = this.config;
    return this.players.map((p) => [
      p.smallID, Math.floor(p.troops), Math.floor(p.gold), p.numTiles,
      (p.spawned ? 1 : 0) | (p.alive ? 2 : 0) | (p.isTraitor() ? 4 : 0) | (p.disconnected ? 8 : 0),
      Math.floor(cfg.maxTroops(p)), [...p.allies].map((id) => this.player(id)?.smallID || 0),
      Math.floor(p.alive ? cfg.troopIncreaseRate(p) * TICKS_PER_SECOND : 0),
      [[...p.researches], p.research ? [p.research.id, Math.max(0, p.research.doneTick - this.tick)] : null, p.type === PlayerType.HUMAN && p.pendingChoices ? p.pendingChoices.choices : null],
      this.attackPower(p), this.economyPower(p), p.numWallTiles, p.mechs.length,
      p.warships.filter((w) => !w.done).length, p.subs.filter((s) => !s.done).length,
      Math.floor(this.troopsDeployed(p)),
      p.airships.filter((a) => !a.done).length, p.airshipsBuilt || 0, cfg.maxResearchesPerPlayer(p),
    ]);
  }
  // Troops that have left home but still belong to this player: attacks in progress, boats in transit and
  // garrisons sitting in defense posts. The client shows these as the lighter part of the troop bar.
  troopsDeployed(p) {
    let n = 0;
    for (const a of p.outgoingAttacks) if (!a.done) n += a.troops;
    for (const b of p.boats) if (!b.done) n += b.troops;
    for (const u of p.units) n += u.garrison || 0;
    return n;
  }
  unitsPacket() { return this.units.map((u) => [u.id, u.type, u.owner.smallID, u.tile, u.level, u.constructionLeft, u.cooldown, u.garrison || 0, u.station ? 1 : 0]); }
  attacksPacket() {
    return this.attacks.filter((a) => !a.done).map((a) => [
      a.id, a.attacker.smallID, a.target ? a.target.smallID : 0, Math.floor(a.troops), a.sourceTile ?? -1,
      this.r1(a.markX), this.r1(a.markY),
    ]);
  }
  r1(v) { return Math.round(v * 10) / 10; }
  boatsPacket() { return this.boats.filter((b) => !b.done).map((b) => [b.id, b.owner.smallID, this.r1(b.x), this.r1(b.y), Math.floor(b.troops), b.target ? b.target.smallID : 0]); }
  tradePacket() { return this.tradeShips.filter((s) => !s.done).map((s) => [s.id, s.owner.smallID, this.r1(s.x), this.r1(s.y)]); }
  shipsPacket(viewer) {
    const out = [];
    for (const w of this.warships) if (!w.done) out.push([w.id, 'warship', w.owner.smallID, this.r1(w.x), this.r1(w.y), Math.round(w.hp), this.config.warshipHp(), w.patrol]);
    for (const s of this.subs) {
      if (s.done) continue;
      const mine = viewer && (s.owner === viewer || s.owner.isFriendly(viewer));
      if (!mine && !s.detected) continue; // invisible unless detected
      out.push([s.id, 'submarine', s.owner.smallID, this.r1(s.x), this.r1(s.y), Math.round(s.hp), this.config.submarineHp(), s.patrol, Math.max(0, s.volleyReady - this.tick), s.detected ? 1 : 0]);
    }
    return out;
  }
  mechsPacket() { return this.mechs.filter((m) => !m.done).map((m) => [m.id, m.owner.smallID, this.r1(m.x), this.r1(m.y), Math.round(m.hp), Math.round(m.maxHp), m.engaged ? 1 : 0, m.level, m.patrol, Math.max(0, m.cannonReady - this.tick), m.range, m.mode, m.orderTarget]); }
  shellsPacket() { return this.shells.map((s) => [s.id, s.owner.smallID, this.r1(s.x), this.r1(s.y), this.r1(s.tx), this.r1(s.ty), s.kind]); }
  trainsPacket() { return this.trains.filter((t) => !t.done).map((t) => [t.id, t.owner.smallID, this.r1(t.x), this.r1(t.y), t.cars.map((c) => [this.r1(c.x), this.r1(c.y)])]); }
  railsPacket() { return this.rails.map((r) => [r.id, r.a.id, r.b.id, r.tiles]); }
  nukesPacket() { return this.nukes.map((n) => [n.id, n.type, n.owner.smallID, this.r1(n.x), this.r1(n.y), n.tx, n.ty, n.sx, n.sy]); }
  bombersPacket() { return this.bombers.map((b) => [b.id, b.owner.smallID, this.r1(b.x), this.r1(b.y), this.r1(b.tx), this.r1(b.ty)]); }
  drainTickPacket() {
    const tiles = [];
    if (this.changedTiles.length) {
      const seen = new Set();
      for (const t of this.changedTiles) {
        if (seen.has(t)) continue;
        seen.add(t);
        tiles.push(t, this.owner[t] | (this.fallout[t] ? 0x8000 : 0) | (this.wallHp[t] ? 0x4000 : 0));
      }
      this.changedTiles.length = 0;
    }
    const pkt = { t: 'tick', tick: this.tick, phase: this.phase, tiles };
    if (this.events.length) { pkt.events = this.events; this.events = []; }
    if (this.tick % 5 === 0 || this.phase === 'over') pkt.stats = this.statsPacket();
    if (this.attacks.length) pkt.attacks = this.attacksPacket();   // every tick: the marker has to glide
    else if (this.tick % 5 === 0) pkt.attacks = [];
    const mobile = this.airships.length || this.boats.length || this.nukes.length || this.tradeShips.length || this.warships.length || this.subs.length || this.shells.length || this.trains.length || this.bombers.length;
    if (mobile || this.tick % 5 === 0) {
      pkt.boats = this.boatsPacket(); pkt.nukes = this.nukesPacket(); pkt.trade = this.tradePacket();
      pkt.shells = this.shellsPacket(); pkt.trains = this.trainsPacket(); pkt.bombers = this.bombersPacket();
      pkt.ships = true; // filled per client (submarine visibility)
    }
    if (this.mechs.length || this.tick % 20 === 0) pkt.mechs = this.mechsPacket();
    if (this.airships.length || this.tick % 20 === 0) pkt.airships = this.airshipsPacket();
    if (this.unitsChanged || this.tick % 50 === 0) { pkt.units = this.unitsPacket(); this.unitsChanged = false; }
    if (this.railsChanged) { pkt.rails = this.railsPacket(); this.railsChanged = false; }
    if (this.phase === 'spawn') pkt.spawnLeft = this.spawnTicks - this.tick;
    if (this.phase === 'over') pkt.winner = this.winner ? this.winner.smallID : 0;
    const reqs = [];
    for (const r of this.allianceRequests.values()) if (r.to.type === PlayerType.HUMAN) reqs.push([r.from.smallID, r.to.id]);
    if (reqs.length || this.tick % 10 === 0) pkt.allyReqs = reqs;
    return pkt;
  }
}

// ---- mix in the other systems ----
Object.assign(Game.prototype, require('./units'), require('./navy'), require('./rails'), require('./mechs'), require('./nukes'), require('./air'));

module.exports = { Game, Player, PlayerType, UnitType, NukeType, newId };
