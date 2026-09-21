'use strict';
// Authoritative game simulation. Runs on the server at 10 ticks/second.
const { Rng, hashString } = require('./rng');
const {
  TerrainType, PlayerType, UnitType, NukeType, Config, within, TICKS_PER_SECOND,
} = require('./config');

// ---------------------------------------------------------------------------
// Small binary min-heap of (priority, value) pairs used by attacks.
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

// ---------------------------------------------------------------------------
const PALETTE = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6',
  '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9a6324', '#fffac8', '#800000', '#aaffc3',
  '#808000', '#ffd8b1', '#000075', '#a9a9a9', '#ff6e40', '#00c853', '#ffab00', '#2962ff',
  '#d500f9', '#00bfa5', '#c6ff00', '#ff1744', '#6200ea', '#64dd17', '#ff9100', '#00b8d4',
];
const BOT_COLORS = ['#8d99ae', '#a0a0a0', '#b0a08a', '#9ab0a0', '#a89ab0', '#b09a9a', '#9aa0b0', '#a8b09a'];

const NATION_NAMES = [
  'Valoria', 'Kestria', 'Norvane', 'Ostmark', 'Thalassa', 'Bruma', 'Cinder', 'Dravos', 'Elmara', 'Fenwick',
  'Garrow', 'Halcyon', 'Ivaria', 'Jorvik', 'Korrath', 'Lumen', 'Meridia', 'Nyxos', 'Orlan', 'Pellucid',
  'Quorra', 'Rhoswen', 'Solmar', 'Tarquin', 'Ulmere', 'Vireo', 'Wexley', 'Xantho', 'Yarrow', 'Zephyra',
  'Arden', 'Belmont', 'Calder', 'Dunmore', 'Ecliptia', 'Farrago', 'Glimmer', 'Hollow', 'Isolde', 'Juno',
];
const BOT_NAMES = [
  'Reed Clan', 'Ash Tribe', 'Stone Folk', 'River Band', 'Moss Kin', 'Fern People', 'Dust Nomads', 'Salt Tribe',
  'Pine Clan', 'Ember Kin', 'Frost Folk', 'Clay Band', 'Marsh Tribe', 'Crag Clan', 'Hollow Kin', 'Dune Folk',
];

class Player {
  constructor(game, { id, smallID, name, type, color }) {
    this.game = game;
    this.id = id;
    this.smallID = smallID;
    this.name = name;
    this.type = type;
    this.color = color;
    this.troops = 0;
    this.gold = 0;
    this.tiles = new Set();
    this.border = new Set();
    this.units = [];
    this.spawned = false;
    this.spawnTile = null;
    this.spawnTick = 0;
    this.deathTick = 0;
    this.allies = new Set(); // player ids
    this.traitorUntil = 0;
    this.relations = new Map(); // playerId -> -100..100 (AI only)
    this.disconnected = false;
    this.outgoingAttacks = [];
    this.incomingAttacks = [];
    this.boats = [];
    this.ai = null;
    this.conqueredBy = null;
  }
  get numTiles() { return this.tiles.size; }
  get alive() { return this.spawned && this.tiles.size > 0; }
  isTraitor() { return this.game.tick < this.traitorUntil; }
  isFriendly(other) { return other === this || this.allies.has(other.id); }
  unitsOf(type) { return this.units.filter((u) => u.type === type); }
  completedUnitsOf(type) { return this.units.filter((u) => u.type === type && u.constructionLeft === 0); }
  unitLevels(type) { return this.completedUnitsOf(type).reduce((s, u) => s + u.level, 0); }
  cityLevels() { return this.unitLevels(UnitType.CITY); }
  addTroops(n) { this.troops = Math.max(0, this.troops + n); }
  removeTroops(n) { const r = Math.min(this.troops, Math.max(0, Math.floor(n))); this.troops -= r; return r; }
  addGold(n) { this.gold += n; }
  removeGold(n) { const r = Math.min(this.gold, Math.max(0, n)); this.gold -= r; return r; }
  relation(other) { return this.relations.get(other.id) ?? 0; }
  updateRelation(other, delta) {
    this.relations.set(other.id, within(this.relation(other) + delta, -100, 100));
  }
}

class Attack {
  constructor(id, attacker, target, troops, sourceTile) {
    this.id = id;
    this.attacker = attacker;
    this.target = target; // Player | null (terra nullius)
    this.troops = troops;
    this.sourceTile = sourceTile;
    this.border = new Set();
    this.heap = new Heap();
    this.retreated = false;
    this.done = false;
    this.rng = new Rng(id * 7919 + 13);
    this.nbuf = [0, 0, 0, 0];
    this.nbuf2 = [0, 0, 0, 0];
  }
}

let nextId = 1;

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
    this.numFallout = 0;
    this.rng = new Rng(map.seed ^ 0x5bd1e995);
    this.tick = 0;
    this.phase = 'spawn'; // spawn | play | over
    this.players = [];
    this.playersBySmall = [null];
    this.playersById = new Map();
    this.attacks = [];
    this.boats = [];
    this.units = [];
    this.unitByTile = new Map();
    this.nukes = [];
    this.allianceRequests = new Map(); // "from|to" -> {from,to,tick}
    this.events = [];
    this.changedTiles = [];
    this.unitsChanged = true;
    this.winner = null;
    this.winTick = 0;
    this.spawnTicks = this.config.numSpawnPhaseTicks();
    this.usedNames = new Set();
    this.nbuf = [0, 0, 0, 0];
  }

  // ---- tile helpers ------------------------------------------------------
  x(i) { return i % this.width; }
  y(i) { return (i / this.width) | 0; }
  ref(x, y) { return y * this.width + x; }
  valid(x, y) { return x >= 0 && y >= 0 && x < this.width && y < this.height; }
  isLand(i) { return this.terrain[i] !== TerrainType.WATER; }
  isWater(i) { return this.terrain[i] === TerrainType.WATER; }
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
  dist(a, b) {
    const dx = this.x(a) - this.x(b), dy = this.y(a) - this.y(b);
    return Math.sqrt(dx * dx + dy * dy);
  }
  ownerOf(i) { return this.playersBySmall[this.owner[i]] || null; }
  // Random tile of a set without copying it into an array.
  randomTileOf(set, rng) {
    if (set.size === 0) return null;
    let skip = rng.int(0, Math.min(set.size - 1, 5000));
    for (const t of set) { if (skip-- <= 0) return t; }
    return null;
  }

  // ---- players -------------------------------------------------------------
  addPlayer({ id, name, type }) {
    const smallID = this.playersBySmall.length;
    let color;
    if (type === PlayerType.BOT) color = BOT_COLORS[smallID % BOT_COLORS.length];
    else color = PALETTE[(this.players.filter((p) => p.type !== PlayerType.BOT).length) % PALETTE.length];
    let finalName = name;
    let k = 2;
    while (this.usedNames.has(finalName)) finalName = `${name} ${k++}`;
    this.usedNames.add(finalName);
    const p = new Player(this, { id, smallID, name: finalName, type, color });
    this.players.push(p);
    this.playersBySmall.push(p);
    this.playersById.set(id, p);
    p.gold = this.settings.startingGold;
    return p;
  }

  addAIPlayers(NationAI, BotAI) {
    for (let i = 0; i < this.settings.nations; i++) {
      const name = NATION_NAMES[i % NATION_NAMES.length];
      const p = this.addPlayer({ id: `nation-${i + 1}`, name, type: PlayerType.NATION });
      p.ai = new NationAI(this, p, hashString(p.id) ^ this.map.seed);
    }
    for (let i = 0; i < this.settings.bots; i++) {
      const name = BOT_NAMES[i % BOT_NAMES.length];
      const p = this.addPlayer({ id: `bot-${i + 1}`, name, type: PlayerType.BOT });
      p.ai = new BotAI(this, p, hashString(p.id) ^ this.map.seed);
    }
  }

  player(id) { return this.playersById.get(id) || null; }

  // ---- ownership -----------------------------------------------------------
  conquer(p, tile) {
    const prevSm = this.owner[tile];
    if (prevSm === p.smallID) return;
    if (prevSm !== 0) {
      const prev = this.playersBySmall[prevSm];
      prev.tiles.delete(tile);
      prev.border.delete(tile);
    }
    this.owner[tile] = p.smallID;
    if (this.fallout[tile]) { this.fallout[tile] = 0; this.numFallout--; }
    p.tiles.add(tile);
    this.changedTiles.push(tile);
    this.updateBorder(tile);
    const b = this.nbuf, n = this.neighbors4(tile, b);
    for (let k = 0; k < n; k++) this.updateBorder(b[k]);
    // capture structures on the tile
    const u = this.unitByTile.get(tile);
    if (u && u.owner !== p) this.transferUnit(u, p);
  }
  relinquish(tile) {
    const prevSm = this.owner[tile];
    if (prevSm === 0) return;
    const prev = this.playersBySmall[prevSm];
    prev.tiles.delete(tile);
    prev.border.delete(tile);
    this.owner[tile] = 0;
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
    const from = u.owner;
    if (from) from.units = from.units.filter((x) => x !== u);
    u.owner = to;
    to.units.push(u);
    this.unitsChanged = true;
  }
  removeUnit(u) {
    if (u.owner) u.owner.units = u.owner.units.filter((x) => x !== u);
    this.units = this.units.filter((x) => x !== u);
    this.unitByTile.delete(u.tile);
    this.unitsChanged = true;
  }

  // Players whose territory touches p's territory by land.
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
        if (o === 0) { if (!this.fallout[nb]) touchesNeutral = true; }
        else if (o !== p.smallID) set.add(this.playersBySmall[o]);
      }
    }
    return { players: [...set], touchesNeutral };
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
    // clear previous spawn
    for (const t of [...p.tiles]) this.relinquish(t);
    const tiles = this.getSpawnTiles(tile);
    if (tiles.length < 5) return false;
    for (const t of tiles) this.conquer(p, t);
    if (!p.spawned) {
      p.spawned = true;
      p.troops = this.config.startTroops(p.type);
    }
    p.spawnTile = tile;
    p.spawnTick = this.tick;
    return true;
  }

  randomSpawnTile(minDist) {
    for (let tries = 0; tries < 300; tries++) {
      const t = this.rng.int(0, this.terrain.length - 1);
      if (!this.isLand(t) || this.owner[t] !== 0) continue;
      if (this.terrain[t] === TerrainType.MOUNTAIN && this.rng.chance(2)) continue;
      let ok = true;
      if (minDist > 0) {
        for (const o of this.players) {
          if (o.spawned && o.spawnTile !== null && this.dist(o.spawnTile, t) < minDist) { ok = false; break; }
        }
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

    // economy
    for (const p of this.players) {
      if (!p.alive) continue;
      p.addTroops(this.config.troopIncreaseRate(p));
      p.addGold(this.config.goldAdditionRate(p));
    }
    // construction & cooldowns
    for (const u of this.units) {
      if (u.constructionLeft > 0) { u.constructionLeft--; if (u.constructionLeft === 0) this.unitsChanged = true; }
      if (u.cooldown > 0) { u.cooldown--; if (u.cooldown === 0) this.unitsChanged = true; }
    }
    this.tickAttacks();
    this.tickBoats();
    this.tickNukes();
    this.expireAllianceRequests();
    for (const p of this.players) if (p.ai && p.alive) p.ai.tick();
    this.checkDeaths();
    if (this.tick % 10 === 0) this.checkWin();
  }

  endSpawnPhase() {
    for (const p of this.players) {
      if (!p.spawned) {
        const t = this.randomSpawnTile(p.type === PlayerType.HUMAN ? 10 : this.config.minDistanceBetweenPlayers());
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

  sendAttack(p, target, troops, sourceTile = null) {
    if (!this.canAttack(p, target)) return null;
    troops = Math.min(p.troops, Math.floor(troops));
    if (troops < 1) return null;
    p.removeTroops(troops);
    const a = new Attack(nextId++, p, target, troops, sourceTile);
    if (target) {
      // attacking someone sours the relationship and cancels their alliance request
      const delta = { easy: -60, medium: -70, hard: -80, impossible: -100 }[this.settings.difficulty] || -70;
      target.updateRelation(p, delta);
      this.allianceRequests.delete(`${target.id}|${p.id}`);
    }
    if (sourceTile !== null) this.attackAddNeighbors(a, sourceTile);
    else this.attackRefreshBorder(a);

    // opposing attacks between the same two players cancel out
    if (target) {
      for (const inc of p.incomingAttacks) {
        if (inc.attacker === target && !inc.done) {
          if (inc.troops > a.troops) { inc.troops -= a.troops; a.done = true; return null; }
          a.troops -= inc.troops; inc.done = true;
        }
      }
    }
    // merge with existing land attack on the same target
    if (sourceTile === null) {
      for (const out of p.outgoingAttacks) {
        if (!out.done && out.target === target && out.sourceTile === null) {
          a.troops += out.troops; out.done = true;
        }
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

  attackRefreshBorder(a) {
    a.heap.clear();
    a.border.clear();
    for (const t of a.attacker.border) this.attackAddNeighbors(a, t);
  }

  attackAddNeighbors(a, tile) {
    const targetSm = a.target ? a.target.smallID : 0;
    const mySm = a.attacker.smallID;
    const n = this.neighbors4(tile, a.nbuf);
    for (let i = 0; i < n; i++) {
      const nb = a.nbuf[i];
      if (this.isWater(nb) || this.owner[nb] !== targetSm) continue;
      if (a.border.has(nb)) continue;
      a.border.add(nb);
      let numOwnedByMe = 0;
      const m = this.neighbors4(nb, a.nbuf2);
      for (let j = 0; j < m; j++) if (this.owner[a.nbuf2[j]] === mySm) numOwnedByMe++;
      const mag = this.terrain[nb] === TerrainType.MOUNTAIN ? 2 : this.terrain[nb] === TerrainType.HIGHLAND ? 1.5 : 1;
      const prio = (a.rng.int(0, 7) + 10) * (1 - numOwnedByMe * 0.5 + mag / 2) + this.tick;
      a.heap.push(nb, prio);
    }
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
    if (returnTroops) {
      const deaths = a.troops * (malusPercent / 100);
      a.attacker.addTroops(a.troops - deaths);
    }
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
        this.attackAddNeighbors(a, tile);
        const res = cfg.attackLogic({
          terrain: this.terrain[tile],
          attackTroops: troops,
          attacker: { type: attacker.type, numTiles: attacker.numTiles },
          defender: target ? { type: target.type, numTiles: target.numTiles, troops: target.troops, isTraitor: target.isTraitor() } : null,
          defenderHasDefensePost: target ? this.hasDefensePostNearby(target, tile) : false,
          falloutRatio: this.fallout[tile] ? this.numFallout / this.numLand : null,
          borderSize,
        });
        tickBudget -= res.tickFraction;
        troops -= res.attackerTroopLoss;
        a.troops = troops;
        if (target) target.removeTroops(res.defenderTroopLoss);
        this.conquer(attacker, tile);
        if (target) this.handleDeadDefender(attacker, target);
        if (target && !target.alive) { break; }
      }
      a.troops = Math.max(0, troops);
    }
    if (this.attacks.some((a) => a.done)) {
      this.attacks = this.attacks.filter((a) => !a.done);
      for (const p of this.players) {
        p.outgoingAttacks = p.outgoingAttacks.filter((a) => !a.done);
        p.incomingAttacks = p.incomingAttacks.filter((a) => !a.done);
      }
    }
  }

  // When a defender gets very small, the attacker takes them over entirely.
  handleDeadDefender(attacker, target) {
    if (target.tiles.size === 0 || target.tiles.size >= 100) return;
    this.conquerPlayer(attacker, target);
  }

  conquerPlayer(conqueror, target) {
    if (!target.alive) return;
    const gold = this.config.conquerGoldAmount(target);
    target.removeGold(gold);
    conqueror.addGold(gold);
    target.conqueredBy = conqueror;
    for (const t of [...target.tiles]) this.conquer(conqueror, t);
    for (const u of [...target.units]) this.transferUnit(u, conqueror);
    for (const b of target.boats) b.done = true;
    for (const a of target.outgoingAttacks) a.done = true;
    for (const id of target.allies) { const o = this.player(id); if (o) o.allies.delete(target.id); }
    target.allies.clear();
    this.events.push({ k: 'conquered', p: target.smallID, by: conqueror.smallID });
  }

  // ---- boats ------------------------------------------------------------------
  // Up to `limit` shore tiles owned by ownerSm, nearest-first (BFS) from start.
  shoreTilesNear(start, ownerSm, limit = 8, maxDepth = 120) {
    const out = [];
    if (this.isLand(start) && this.owner[start] === ownerSm && this.isShore(start)) out.push(start);
    const seen = new Set([start]);
    let frontier = [start];
    const b = [0, 0, 0, 0];
    for (let d = 0; d < maxDepth && frontier.length && out.length < limit; d++) {
      const next = [];
      for (const t of frontier) {
        const n = this.neighbors4(t, b);
        for (let k = 0; k < n; k++) {
          const nb = b[k];
          if (seen.has(nb)) continue;
          seen.add(nb);
          if (this.isLand(nb) && this.owner[nb] === ownerSm) {
            if (this.isShore(nb)) { out.push(nb); if (out.length >= limit) break; }
            next.push(nb);
          }
        }
        if (out.length >= limit) break;
      }
      frontier = next;
    }
    return out;
  }

  // Multi-source BFS over water from the water next to dst until we touch water next to the attacker's coast.
  findBoatPath(attacker, dst) {
    const w = this.width;
    const parent = new Int32Array(this.terrain.length).fill(-1);
    const b = [0, 0, 0, 0];
    const queue = [];
    let n = this.neighbors4(dst, b);
    for (let k = 0; k < n; k++) if (this.isWater(b[k])) { parent[b[k]] = b[k]; queue.push(b[k]); }
    const mySm = attacker.smallID;
    let head = 0;
    while (head < queue.length) {
      const t = queue[head++];
      n = this.neighbors4(t, b);
      for (let k = 0; k < n; k++) {
        const nb = b[k];
        if (this.isLand(nb)) {
          if (this.owner[nb] === mySm) {
            // found our coast: build path from nb's water neighbour t back to dst
            const path = [];
            let cur = t;
            while (parent[cur] !== cur) { path.push(cur); cur = parent[cur]; }
            path.push(cur);
            path.push(dst);
            return { src: nb, path };
          }
          continue;
        }
        if (parent[nb] !== -1) continue;
        parent[nb] = t;
        queue.push(nb);
      }
    }
    return null;
  }

  sendBoat(p, clickedTile, troops) {
    if (!p.alive || this.settings.disableBoats) return null;
    if (p.boats.filter((x) => !x.done).length >= this.config.boatMaxNumber()) return null;
    // resolve the landing tile: nearest coast of the clicked owner that has a sea route to us
    let landTile = clickedTile;
    if (!this.isLand(clickedTile)) {
      // clicked water: pick the nearest land that isn't ours
      landTile = null;
      const seen = new Set([clickedTile]);
      let frontier = [clickedTile];
      const b = [0, 0, 0, 0];
      for (let d = 0; d < 60 && landTile === null && frontier.length; d++) {
        const next = [];
        for (const t of frontier) {
          const n = this.neighbors4(t, b);
          for (let k = 0; k < n; k++) {
            const nb = b[k];
            if (seen.has(nb)) continue;
            seen.add(nb);
            if (this.isLand(nb)) { if (this.owner[nb] !== p.smallID) { landTile = nb; break; } }
            else next.push(nb);
          }
          if (landTile !== null) break;
        }
        frontier = next;
      }
      if (landTile === null) return null;
    }
    const target = this.ownerOf(landTile);
    if (target === p) return null;
    if (!this.canAttack(p, target)) return null;
    let found = null, dst = null;
    for (const cand of this.shoreTilesNear(landTile, this.owner[landTile])) {
      found = this.findBoatPath(p, cand);
      if (found) { dst = cand; break; }
    }
    if (!found) return null;
    troops = Math.min(p.troops, Math.floor(troops));
    if (troops < 1) return null;
    p.removeTroops(troops);
    const boat = {
      id: nextId++, owner: p, target, troops, path: found.path, idx: 0, dst, done: false,
      x: this.x(found.path[0]), y: this.y(found.path[0]),
    };
    p.boats.push(boat);
    this.boats.push(boat);
    return boat;
  }

  tickBoats() {
    const speed = this.config.boatSpeed();
    for (const b of this.boats) {
      if (b.done) continue;
      if (!b.owner.alive) { b.done = true; continue; }
      b.idx = Math.min(b.path.length - 1, b.idx + speed);
      const t = b.path[b.idx];
      b.x = this.x(t); b.y = this.y(t);
      if (b.idx >= b.path.length - 1) {
        b.done = true;
        const dst = b.dst;
        const ownerNow = this.ownerOf(dst);
        if (ownerNow === b.owner) { b.owner.addTroops(b.troops); continue; }
        if (ownerNow && b.owner.isFriendly(ownerNow)) { b.owner.addTroops(b.troops); continue; }
        if (ownerNow && !this.canAttack(b.owner, ownerNow)) { b.owner.addTroops(b.troops); continue; }
        // land: take the beach tile, then push inland from it
        if (ownerNow) ownerNow.removeTroops(ownerNow.troops / Math.max(1, ownerNow.numTiles));
        this.conquer(b.owner, dst);
        b.owner.addTroops(b.troops);
        const a = this.sendAttack(b.owner, ownerNow, b.troops, dst);
        if (!a) { /* troops stay home */ }
        if (ownerNow) this.handleDeadDefender(b.owner, ownerNow);
      }
    }
    if (this.boats.some((b) => b.done)) {
      this.boats = this.boats.filter((b) => !b.done);
      for (const p of this.players) p.boats = p.boats.filter((b) => !b.done);
    }
  }

  // ---- structures ---------------------------------------------------------------
  unitAt(tile) { return this.unitByTile.get(tile) || null; }

  canBuild(p, type, tile) {
    if (!p.alive) return { ok: false, reason: 'dead' };
    if (!Object.values(UnitType).includes(type)) return { ok: false, reason: 'bad type' };
    if (this.owner[tile] !== p.smallID) return { ok: false, reason: 'You must own the tile' };
    if (type === UnitType.PORT && !this.isShore(tile)) return { ok: false, reason: 'Ports must be built on the coast' };
    if (this.settings.disableNukes && (type === UnitType.SILO || type === UnitType.SAM)) return { ok: false, reason: 'Nukes are disabled' };
    const existing = this.unitAt(tile);
    let upgrade = null;
    if (existing) {
      if (existing.owner === p && existing.type === type && (type === UnitType.CITY || type === UnitType.PORT) && existing.constructionLeft === 0) upgrade = existing;
      else return { ok: false, reason: 'Tile already has a structure' };
    } else {
      for (const u of this.units) {
        if (Math.abs(this.x(u.tile) - this.x(tile)) <= 2 && Math.abs(this.y(u.tile) - this.y(tile)) <= 2) {
          return { ok: false, reason: 'Too close to another structure' };
        }
      }
    }
    const count = upgrade ? p.unitLevels(type) : p.unitsOf(type).length;
    const cost = this.config.unitCost(type, count, p);
    if (p.gold < cost) return { ok: false, reason: `Not enough gold (need ${cost})` };
    return { ok: true, cost, upgrade };
  }

  build(p, type, tile) {
    const c = this.canBuild(p, type, tile);
    if (!c.ok) return c;
    p.removeGold(c.cost);
    if (c.upgrade) {
      c.upgrade.level++;
    } else {
      const u = { id: nextId++, type, owner: p, tile, level: 1, constructionLeft: this.config.constructionTicks(type), cooldown: 0 };
      this.units.push(u);
      this.unitByTile.set(tile, u);
      p.units.push(u);
    }
    this.unitsChanged = true;
    return c;
  }

  // ---- nukes ------------------------------------------------------------------
  canLaunchNuke(p, type, tile) {
    if (!p.alive) return { ok: false, reason: 'dead' };
    if (this.settings.disableNukes) return { ok: false, reason: 'Nukes are disabled' };
    if (!Object.values(NukeType).includes(type)) return { ok: false, reason: 'bad type' };
    if (!this.isLand(tile)) return { ok: false, reason: 'Target must be land' };
    const silo = p.units.find((u) => u.type === UnitType.SILO && u.constructionLeft === 0 && u.cooldown === 0);
    if (!silo) return { ok: false, reason: 'You need a ready Missile Silo' };
    const cost = this.config.nukeCost(type, p);
    if (p.gold < cost) return { ok: false, reason: `Not enough gold (need ${cost})` };
    // pick the closest ready silo
    let best = silo, bestD = this.dist(silo.tile, tile);
    for (const u of p.units) {
      if (u.type === UnitType.SILO && u.constructionLeft === 0 && u.cooldown === 0) {
        const d = this.dist(u.tile, tile);
        if (d < bestD) { best = u; bestD = d; }
      }
    }
    return { ok: true, cost, silo: best };
  }

  launchNuke(p, type, tile) {
    const c = this.canLaunchNuke(p, type, tile);
    if (!c.ok) return c;
    p.removeGold(c.cost);
    c.silo.cooldown = this.config.siloCooldownTicks();
    this.unitsChanged = true;
    const nuke = {
      id: nextId++, type, owner: p, x: this.x(c.silo.tile), y: this.y(c.silo.tile),
      tx: this.x(tile), ty: this.y(tile), target: tile, done: false,
    };
    this.nukes.push(nuke);
    this.events.push({ k: 'nuke', type, by: p.smallID, tile });
    return c;
  }

  tickNukes() {
    const speed = this.config.nukeSpeed();
    for (const nk of this.nukes) {
      if (nk.done) continue;
      // SAM interception
      let intercepted = false;
      for (const u of this.units) {
        if (u.type !== UnitType.SAM || u.constructionLeft > 0 || u.cooldown > 0) continue;
        if (u.owner === nk.owner || u.owner.isFriendly(nk.owner)) continue;
        const dx = this.x(u.tile) - nk.x, dy = this.y(u.tile) - nk.y;
        if (dx * dx + dy * dy <= this.config.samRange() ** 2) {
          u.cooldown = this.config.samCooldownTicks();
          this.unitsChanged = true;
          intercepted = true;
          this.events.push({ k: 'samhit', by: u.owner.smallID, x: nk.x, y: nk.y });
          break;
        }
      }
      if (intercepted) { nk.done = true; continue; }
      const dx = nk.tx - nk.x, dy = nk.ty - nk.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= speed) { nk.x = nk.tx; nk.y = nk.ty; nk.done = true; this.detonate(nk); }
      else { nk.x += (dx / d) * speed; nk.y += (dy / d) * speed; }
    }
    this.nukes = this.nukes.filter((n) => !n.done);
  }

  detonate(nk) {
    const { inner, outer } = this.config.nukeMagnitude(nk.type);
    const cx = nk.tx, cy = nk.ty;
    const hitTiles = new Map(); // smallID -> count
    const before = new Map();
    for (let y = Math.max(0, cy - outer); y <= Math.min(this.height - 1, cy + outer); y++) {
      for (let x = Math.max(0, cx - outer); x <= Math.min(this.width - 1, cx + outer); x++) {
        const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2);
        if (d > outer) continue;
        const t = this.ref(x, y);
        if (!this.isLand(t)) continue;
        if (d > inner) {
          const pr = 1 - (d - inner) / (outer - inner);
          if (this.rng.next() > pr * pr) continue;
        }
        const sm = this.owner[t];
        if (sm !== 0) {
          if (!before.has(sm)) before.set(sm, this.playersBySmall[sm].numTiles);
          hitTiles.set(sm, (hitTiles.get(sm) || 0) + 1);
          this.relinquish(t);
        }
        if (!this.fallout[t]) { this.fallout[t] = 1; this.numFallout++; this.changedTiles.push(t); }
        const u = this.unitAt(t);
        if (u) this.removeUnit(u);
      }
    }
    for (const [sm, count] of hitTiles) {
      const p = this.playersBySmall[sm];
      const frac = count / Math.max(1, before.get(sm));
      p.removeTroops(p.troops * Math.min(1, frac * 2));
      p.updateRelation(nk.owner, -100);
      if (p !== nk.owner && p.allies.has(nk.owner.id) && count >= 100) this.breakAlliance(nk.owner, p);
    }
    this.events.push({ k: 'boom', type: nk.type, x: cx, y: cy, by: nk.owner.smallID });
  }

  // ---- alliances ------------------------------------------------------------------
  requestAlliance(from, to) {
    if (!from.alive || !to.alive || from === to) return false;
    if (from.allies.has(to.id)) return false;
    const key = `${from.id}|${to.id}`;
    if (this.allianceRequests.has(key)) return false;
    // if they already asked us, accept
    if (this.allianceRequests.has(`${to.id}|${from.id}`)) { this.acceptAlliance(to, from); return true; }
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
    for (const [k, r] of this.allianceRequests) if (this.tick - r.tick > 30 * TICKS_PER_SECOND) this.allianceRequests.delete(k);
  }
  donate(from, to, troops, gold) {
    if (!from.alive || !to.alive || !from.allies.has(to.id)) return false;
    troops = Math.max(0, Math.floor(troops || 0)); gold = Math.max(0, Math.floor(gold || 0));
    const t = from.removeTroops(troops); to.addTroops(t);
    const g = from.removeGold(gold); to.addGold(g);
    if (t > 0 || g > 0) this.events.push({ k: 'donate', from: from.smallID, to: to.smallID, troops: t, gold: g });
    return true;
  }

  // ---- serialization ----------------------------------------------------------------
  playerInfo(p) {
    return { id: p.id, sm: p.smallID, name: p.name, type: p.type, color: p.color };
  }
  fullState() {
    return {
      tick: this.tick,
      phase: this.phase,
      spawnTicks: this.spawnTicks,
      width: this.width, height: this.height, numLand: this.numLand,
      terrain: Buffer.from(this.terrain.buffer, this.terrain.byteOffset, this.terrain.byteLength).toString('base64'),
      owner: Buffer.from(this.owner.buffer, this.owner.byteOffset, this.owner.byteLength).toString('base64'),
      fallout: Buffer.from(this.fallout.buffer, this.fallout.byteOffset, this.fallout.byteLength).toString('base64'),
      players: this.players.map((p) => this.playerInfo(p)),
      stats: this.statsPacket(),
      units: this.unitsPacket(),
      settings: this.settings,
      winner: this.winner ? this.winner.smallID : 0,
    };
  }
  statsPacket() {
    const cfg = this.config;
    return this.players.map((p) => [
      p.smallID, Math.floor(p.troops), Math.floor(p.gold), p.numTiles,
      (p.spawned ? 1 : 0) | (p.alive ? 2 : 0) | (p.isTraitor() ? 4 : 0) | (p.disconnected ? 8 : 0),
      Math.floor(cfg.maxTroops(p)), [...p.allies].map((id) => this.player(id)?.smallID || 0),
    ]);
  }
  unitsPacket() {
    return this.units.map((u) => [u.id, u.type, u.owner.smallID, u.tile, u.level, u.constructionLeft, u.cooldown]);
  }
  attacksPacket() {
    return this.attacks.filter((a) => !a.done).map((a) => [a.id, a.attacker.smallID, a.target ? a.target.smallID : 0, Math.floor(a.troops), a.sourceTile ?? -1]);
  }
  boatsPacket() {
    return this.boats.filter((b) => !b.done).map((b) => [b.id, b.owner.smallID, b.x, b.y, Math.floor(b.troops), b.target ? b.target.smallID : 0]);
  }
  nukesPacket() {
    return this.nukes.map((n) => [n.id, n.type, n.owner.smallID, Math.round(n.x * 10) / 10, Math.round(n.y * 10) / 10, n.tx, n.ty]);
  }
  // Called once per tick by the server after step(); returns the delta packet and clears buffers.
  drainTickPacket() {
    const tiles = [];
    // dedupe changed tiles
    if (this.changedTiles.length) {
      const seen = new Set();
      for (const t of this.changedTiles) {
        if (seen.has(t)) continue;
        seen.add(t);
        tiles.push(t, this.owner[t] | (this.fallout[t] ? 0x8000 : 0));
      }
      this.changedTiles.length = 0;
    }
    const pkt = { t: 'tick', tick: this.tick, phase: this.phase, tiles };
    if (this.events.length) { pkt.events = this.events; this.events = []; }
    if (this.tick % 5 === 0 || this.phase === 'over') {
      pkt.stats = this.statsPacket();
      pkt.attacks = this.attacksPacket();
    }
    if (this.boats.length || this.nukes.length) { pkt.boats = this.boatsPacket(); pkt.nukes = this.nukesPacket(); }
    else if (this.tick % 5 === 0) { pkt.boats = []; pkt.nukes = []; }
    if (this.unitsChanged || this.tick % 50 === 0) { pkt.units = this.unitsPacket(); this.unitsChanged = false; }
    if (this.phase === 'spawn') pkt.spawnLeft = this.spawnTicks - this.tick;
    if (this.phase === 'over') pkt.winner = this.winner ? this.winner.smallID : 0;
    // pending alliance requests to humans (so the client can show accept/reject)
    const reqs = [];
    for (const r of this.allianceRequests.values()) if (r.to.type === PlayerType.HUMAN) reqs.push([r.from.smallID, r.to.id]);
    if (reqs.length || this.tick % 10 === 0) pkt.allyReqs = reqs;
    return pkt;
  }
}

module.exports = { Game, Player, PlayerType, UnitType, NukeType, PALETTE };
