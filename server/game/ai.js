'use strict';
// AI players. "Nations" are real opponents whose aggression scales with the
// difficulty setting; "Bots" are small tribes that mostly just expand.
const { Rng } = require('./rng');
const { PlayerType, UnitType, NukeType, Difficulty } = require('./config');

class NationAI {
  constructor(game, player, seed) {
    this.game = game;
    this.p = player;
    this.rng = new Rng(seed);
    this.cfg = game.config;
    this.triggerRatio = this.rng.int(50, 60) / 100;
    this.reserveRatio = this.rng.int(30, 40) / 100;
    this.expandRatio = this.rng.int(10, 20) / 100;
    this.attackRate = this.cfg.nationAttackRate(this.rng);
    this.attackTick = this.rng.int(0, this.attackRate - 1);
    this.lastStructureTick = -10000;
    this.placements = 0;
    this.spawnAttemptTick = this.rng.int(0, 20);
  }

  get difficulty() { return this.cfg.difficulty(); }
  get hardOrWorse() { return this.difficulty === Difficulty.HARD || this.difficulty === Difficulty.IMPOSSIBLE; }

  tick() {
    const g = this.game, p = this.p;
    if (g.phase === 'spawn') {
      if (!p.spawned && g.tick >= this.spawnAttemptTick) {
        const t = g.randomSpawnTile(this.cfg.minDistanceBetweenPlayers());
        if (t !== null) g.spawn(p, t);
        else this.spawnAttemptTick = g.tick + 10;
      }
      return;
    }
    if (!p.alive) return;
    const rate = this.attackRate;
    const offset = g.tick % rate;
    if (offset !== this.attackTick) {
      const oneThird = (this.attackTick + Math.floor(rate / 3)) % rate;
      const twoThirds = (this.attackTick + Math.floor((rate * 2) / 3)) % rate;
      if (offset === oneThird || offset === twoThirds) this.handleStructures();
      return;
    }
    this.handleAllianceRequests();
    this.handleStructures();
    this.maybeAttack();
    this.maybeNuke();
  }

  // ---- attacking ------------------------------------------------------------
  maybeAttack() {
    const g = this.game, p = this.p;
    const { players: neighbors, touchesNeutral } = g.neighborsOf(p);
    neighbors.sort((a, b) => a.troops - b.troops);
    const friends = neighbors.filter((o) => p.isFriendly(o));
    const enemies = neighbors.filter((o) => !p.isFriendly(o));

    if (touchesNeutral && this.sendAttack(null)) return;

    if (enemies.length === 0) {
      if (this.rng.chance(5)) this.attackWithRandomBoat();
    } else {
      if (this.rng.chance(10)) { this.attackWithRandomBoat(enemies); return; }
      this.maybeSendAllianceRequests(enemies);
    }
    this.attackBestTarget(friends, enemies);
  }

  attackBestTarget(friends, enemies) {
    const p = this.p;
    const max = this.cfg.maxTroops(p);
    const ratio = p.troops / max;
    if (ratio < this.reserveRatio) return;
    if (ratio < this.triggerRatio && !this.rng.chance(10)) return;

    const strategies = this.getStrategies(friends, enemies);
    for (const s of strategies) if (s()) return;
  }

  getStrategies(friends, enemies) {
    const p = this.p, g = this.game;
    const retaliate = () => {
      const inc = p.incomingAttacks.find((a) => a.attacker.alive && !p.isFriendly(a.attacker));
      return inc ? this.sendAttack(inc.attacker) : false;
    };
    const bots = () => {
      const bot = enemies.find((e) => e.type === PlayerType.BOT);
      return bot ? this.sendAttack(bot) : false;
    };
    const assist = () => {
      // help an ally: attack whoever is attacking them if we border that attacker
      for (const f of friends) {
        for (const a of f.incomingAttacks) {
          if (enemies.includes(a.attacker)) return this.sendAttack(a.attacker);
        }
      }
      return false;
    };
    const betray = () => {
      if (!this.hardOrWorse || !this.rng.chance(40)) return false;
      const weak = friends.find((f) => f.troops < this.cfg.maxTroops(f) * 0.15 && f.troops < p.troops * 0.5 && f.type !== PlayerType.HUMAN);
      if (!weak) return false;
      g.breakAlliance(p, weak);
      return this.sendAttack(weak);
    };
    const hated = () => {
      for (const e of enemies) {
        if (p.relation(e) <= -50 && e.troops < p.troops * 3) return this.sendAttack(e);
      }
      return false;
    };
    const afk = () => {
      const e = enemies.find((o) => o.disconnected && o.troops < p.troops * 3);
      return e ? this.sendAttack(e) : false;
    };
    const traitor = () => {
      const e = enemies.find((o) => o.isTraitor());
      return e ? this.sendAttack(e) : false;
    };
    const victim = () => {
      const e = enemies.find((o) => {
        if (o.troops > p.troops * 1.2) return false;
        const incoming = o.incomingAttacks.reduce((s, a) => s + a.troops, 0);
        return incoming > o.troops * 0.5;
      });
      return e ? this.sendAttack(e) : false;
    };
    const veryWeak = () => {
      const e = enemies.find((o) => o.troops < this.cfg.maxTroops(o) * 0.15 && o.troops < p.troops * 1.2);
      return e ? this.sendAttack(e) : false;
    };
    const juicy = () => {
      const cands = enemies.filter((o) => o.troops <= p.troops * 0.75);
      if (!cands.length) return false;
      cands.sort((a, b) => b.numTiles + b.units.length * 200 - (a.numTiles + a.units.length * 200));
      return this.sendAttack(cands[0]);
    };
    const weakest = () => {
      if (!enemies.length) return false;
      const w = enemies[0];
      return w.troops < p.troops ? this.sendAttack(w) : false;
    };
    const island = () => (enemies.length === 0 ? this.attackWithRandomBoat() : false);
    const donate = () => {
      for (const f of friends) {
        if (f.troops < this.cfg.maxTroops(f) * 0.2 && f.incomingAttacks.length > 0 && p.troops > this.cfg.maxTroops(p) * 0.6) {
          const amount = Math.floor(p.troops * 0.2);
          g.donate(p, f, amount, 0);
          return true;
        }
      }
      return false;
    };
    switch (this.difficulty) {
      case Difficulty.EASY: return [bots, retaliate, assist, betray, hated, weakest];
      case Difficulty.MEDIUM: return [bots, retaliate, assist, betray, hated, afk, traitor, weakest, island, donate];
      case Difficulty.HARD: return [bots, retaliate, assist, betray, traitor, afk, hated, veryWeak, juicy, victim, weakest, island, donate];
      default: return [retaliate, bots, veryWeak, betray, assist, victim, traitor, juicy, afk, hated, weakest, island, donate];
    }
  }

  troopSendCap() {
    const p = this.p;
    let retain;
    if (this.difficulty === Difficulty.HARD) retain = 0.75;
    else if (this.difficulty === Difficulty.IMPOSSIBLE) retain = 0.9;
    else return Infinity;
    let maxNeighbor = 0;
    for (const n of this.game.neighborsOf(p).players) {
      if (!p.isFriendly(n) && n.type !== PlayerType.BOT && n.troops > maxNeighbor) maxNeighbor = n.troops;
    }
    let cap = maxNeighbor === 0 ? Infinity : Math.max(0, p.troops - Math.ceil(maxNeighbor * retain));
    const incoming = p.incomingAttacks.reduce((s, a) => s + a.troops, 0);
    if (incoming > 0) cap = Math.max(cap, incoming);
    return cap;
  }

  calculateAttackTroops(target, boat = false) {
    const p = this.p;
    const max = this.cfg.maxTroops(p);
    const isBot = target && target.type === PlayerType.BOT;
    const reserve = (target && !isBot) ? this.reserveRatio : this.expandRatio;
    const keep = max * reserve;
    let troops;
    if (boat) troops = p.troops / 5;
    else if (isBot) {
      const avail = p.troops - keep;
      troops = this.difficulty === Difficulty.EASY ? avail : Math.min(avail, target.troops * 4);
      if (avail < target.troops * 2 && this.difficulty !== Difficulty.EASY) troops = 0;
    } else troops = p.troops - keep;
    let cap = this.troopSendCap();
    if (!target && cap <= 0) cap = Math.ceil(p.troops * 0.05);
    troops = Math.min(troops, cap);
    if (troops < 1) return null;
    if (target && this.hardOrWorse && p.incomingAttacks.length === 0 && troops < target.troops * 0.2) return null;
    return Math.floor(troops);
  }

  sendAttack(target) {
    if (target && !this.game.canAttack(this.p, target)) return false;
    const troops = this.calculateAttackTroops(target);
    if (troops === null) return false;
    return this.game.sendAttack(this.p, target, troops) !== null;
  }

  shoreTiles(player, limit = 400) {
    const g = this.game;
    const out = [];
    for (const t of player.border) {
      if (g.isShore(t)) { out.push(t); if (out.length >= limit) break; }
    }
    return out;
  }

  attackWithRandomBoat(enemies = []) {
    const g = this.game, p = this.p;
    if (g.settings.disableBoats) return false;
    if (p.boats.length >= this.cfg.boatMaxNumber()) return false;
    const myShore = this.shoreTiles(p, 50);
    if (!myShore.length) return false;
    // candidate targets: weak enemies with a coast, or neutral coast somewhere nearby
    const candidates = g.players.filter((o) => o !== p && o.alive && !p.isFriendly(o) && !enemies.includes(o) && o.troops < p.troops * 0.8 && g.canAttack(p, o));
    let dstTile = null;
    if (candidates.length && this.rng.chance(2)) {
      const target = this.rng.pick(candidates);
      const shore = this.shoreTiles(target, 60);
      if (shore.length) dstTile = this.rng.pick(shore);
    } else {
      // look for neutral coastline: sample random land tiles
      for (let i = 0; i < 40 && dstTile === null; i++) {
        const t = this.rng.int(0, g.terrain.length - 1);
        if (g.isLand(t) && g.owner[t] === 0 && !g.fallout[t] && g.isShore(t)) dstTile = t;
      }
    }
    if (dstTile === null) return false;
    const target = g.ownerOf(dstTile);
    const troops = this.calculateAttackTroops(target, true);
    if (troops === null) return false;
    return g.sendBoat(p, dstTile, troops) !== null;
  }

  // ---- alliances --------------------------------------------------------------
  handleAllianceRequests() {
    const g = this.game, p = this.p;
    for (const [key, r] of [...g.allianceRequests]) {
      if (r.to !== p) continue;
      const from = r.from;
      const accept = p.relation(from) > -20 && (from.troops > p.troops * 0.5 || this.rng.chance(2)) && !this.rng.chance(4);
      g.replyAlliance(p, from, accept);
      void key;
    }
  }
  maybeSendAllianceRequests(enemies) {
    if (!this.rng.chance(15)) return;
    const p = this.p;
    const strong = enemies.filter((e) => e.type !== PlayerType.BOT && e.troops > p.troops && p.relation(e) >= 0 && e.incomingAttacks.every((a) => a.attacker !== p));
    if (!strong.length) return;
    this.game.requestAlliance(p, this.rng.pick(strong));
  }

  // ---- structures --------------------------------------------------------------
  handleStructures() {
    const g = this.game, p = this.p;
    if (this.placements > 0 && this.tryBuildDefensePost()) return;
    if (g.tick - this.lastStructureTick < 80) return;
    const built = this.doHandleStructures();
    if (built) { this.lastStructureTick = g.tick; this.placements++; }
  }

  tryBuildDefensePost() {
    const g = this.game, p = this.p;
    if (this.difficulty === Difficulty.EASY) return false;
    if (this.difficulty === Difficulty.MEDIUM && !this.rng.chance(2)) return false;
    const land = p.incomingAttacks.filter((a) => a.sourceTile === null);
    if (!land.length || p.troops <= 0) return false;
    const incoming = land.reduce((s, a) => s + a.troops, 0);
    const ratio = incoming / p.troops;
    if (ratio < 0.4) return false;
    const allowed = this.difficulty === Difficulty.MEDIUM ? 1 : Math.ceil(ratio / 0.4);
    if (p.unitsOf(UnitType.DEFENSE_POST).length >= allowed) return false;
    const cost = this.cfg.unitCost(UnitType.DEFENSE_POST, p.unitsOf(UnitType.DEFENSE_POST).length, p);
    if (p.gold < cost) return false;
    // find our tiles adjacent to the attacker
    const attackerSm = land[0].attacker.smallID;
    const front = [];
    const b = [0, 0, 0, 0];
    for (const t of p.border) {
      const n = g.neighbors4(t, b);
      for (let k = 0; k < n; k++) if (g.owner[b[k]] === attackerSm) { front.push(t); break; }
      if (front.length > 200) break;
    }
    if (!front.length) return false;
    for (let i = 0; i < 10; i++) {
      const t = this.rng.pick(front);
      // step a few tiles inland if possible
      let spot = t;
      for (let s = 0; s < 4; s++) {
        const n = g.neighbors4(spot, b);
        let moved = false;
        for (let k = 0; k < n; k++) if (g.owner[b[k]] === p.smallID && !p.border.has(b[k])) { spot = b[k]; moved = true; break; }
        if (!moved) break;
      }
      if (g.build(p, UnitType.DEFENSE_POST, spot).ok) return true;
    }
    return false;
  }

  randomInnerTile(tries = 20, requireShore = false) {
    const g = this.game, p = this.p;
    if (!p.tiles.size) return null;
    let fallback = null;
    for (let i = 0; i < tries; i++) {
      const t = g.randomTileOf(p.tiles, this.rng);
      if (requireShore) { if (g.isShore(t)) return t; continue; }
      if (!p.border.has(t)) {
        fallback = fallback ?? t;
        // prefer tiles whose neighbours are also inner
        const b = [0, 0, 0, 0];
        const n = g.neighbors4(t, b);
        let inner = true;
        for (let k = 0; k < n; k++) if (p.border.has(b[k]) || g.owner[b[k]] !== p.smallID) inner = false;
        if (inner) return t;
      }
    }
    return fallback;
  }

  doHandleStructures() {
    const g = this.game, p = this.p;
    const cities = p.unitsOf(UnitType.CITY).length;
    const ports = p.unitsOf(UnitType.PORT).length;
    const silos = p.unitsOf(UnitType.SILO).length;
    const sams = p.unitsOf(UnitType.SAM).length;
    const coastal = this.shoreTiles(p, 1).length > 0;
    const troopRatio = p.troops / this.cfg.maxTroops(p);
    const enemiesHaveSilos = g.units.some((u) => u.type === UnitType.SILO && u.owner !== p && !p.isFriendly(u.owner));

    if (!g.settings.disableNukes && enemiesHaveSilos && sams < 1 + Math.floor(cities / 4) && p.gold >= this.cfg.unitCost(UnitType.SAM, sams, p) && this.difficulty !== Difficulty.EASY) {
      const t = this.randomInnerTile();
      if (t !== null && g.build(p, UnitType.SAM, t).ok) return true;
    }
    if (coastal && ports < Math.max(1, Math.floor(cities * 0.75)) && p.gold >= this.cfg.unitCost(UnitType.PORT, ports, p)) {
      const t = this.randomInnerTile(30, true);
      if (t !== null && g.build(p, UnitType.PORT, t).ok) return true;
    }
    // Save-up phase: once we have a few cities, hoard gold for a missile silo before building more.
    if (!g.settings.disableNukes && this.difficulty !== Difficulty.EASY && silos < 1 && cities >= 3) {
      if (p.gold >= this.cfg.unitCost(UnitType.SILO, silos, p)) {
        const t = this.randomInnerTile();
        if (t !== null && g.build(p, UnitType.SILO, t).ok) return true;
      }
      return false;
    }
    // keep a nuke fund once we own a silo
    const reserve = silos > 0 ? this.cfg.nukeCost(NukeType.ATOM, p) * 1.3 : 0;
    if ((troopRatio > 0.6 || cities === 0) && p.gold >= this.cfg.unitCost(UnitType.CITY, cities, p) + reserve) {
      const t = this.randomInnerTile();
      if (t !== null && g.build(p, UnitType.CITY, t).ok) return true;
    }
    return false;
  }

  // ---- nukes ------------------------------------------------------------------
  maybeNuke() {
    const g = this.game, p = this.p;
    if (g.settings.disableNukes || this.difficulty === Difficulty.EASY) return;
    if (this.difficulty === Difficulty.MEDIUM && !this.rng.chance(3)) return;
    const silo = p.units.find((u) => u.type === UnitType.SILO && u.constructionLeft === 0 && u.cooldown === 0);
    if (!silo) return;
    let type = NukeType.ATOM;
    if (this.difficulty === Difficulty.IMPOSSIBLE && p.gold >= this.cfg.nukeCost(NukeType.HYDROGEN, p) * 1.5 && this.rng.chance(3)) type = NukeType.HYDROGEN;
    const cost = this.cfg.nukeCost(type, p);
    if (p.gold < cost * 1.3) return;
    // target: an enemy we're at war with (attacking us, or we hate them)
    let enemies = g.players.filter((o) => o !== p && o.alive && !p.isFriendly(o) && o.type !== PlayerType.BOT &&
      (o.incomingAttacks.some((a) => a.attacker === p) || p.incomingAttacks.some((a) => a.attacker === o) || p.relation(o) <= -50));
    // idle at full strength on hard+: soften up the strongest neighbour instead
    if (!enemies.length && this.hardOrWorse && p.troops > this.cfg.maxTroops(p) * 0.8) {
      enemies = g.neighborsOf(p).players.filter((o) => !p.isFriendly(o) && o.type !== PlayerType.BOT);
    }
    if (!enemies.length) return;
    enemies.sort((a, b) => b.troops - a.troops);
    const target = enemies[0];
    if (target.numTiles < 400) return;
    const { outer } = this.cfg.nukeMagnitude(type);
    let best = null, bestScore = 0;
    for (let i = 0; i < 12; i++) {
      const t = g.randomTileOf(target.tiles, this.rng);
      const cx = g.x(t), cy = g.y(t);
      let enemyCount = 0, ownOrAlly = 0;
      const r = outer + 3;
      for (let y = Math.max(0, cy - r); y <= Math.min(g.height - 1, cy + r); y += 2) {
        for (let x = Math.max(0, cx - r); x <= Math.min(g.width - 1, cx + r); x += 2) {
          const sm = g.owner[g.ref(x, y)];
          if (sm === 0) continue;
          const o = g.playersBySmall[sm];
          if (o === p || p.isFriendly(o)) ownOrAlly++;
          else if (o === target) enemyCount++;
        }
      }
      if (ownOrAlly > 0) continue;
      // bonus for structures in blast
      for (const u of target.units) if (Math.abs(g.x(u.tile) - cx) <= outer && Math.abs(g.y(u.tile) - cy) <= outer) enemyCount += 60;
      if (enemyCount > bestScore) { bestScore = enemyCount; best = t; }
    }
    if (best === null || bestScore < 40) return;
    g.launchNuke(p, type, best);
  }
}

// Small tribes: expand slowly, occasionally poke a weaker neighbour, never build.
class BotAI {
  constructor(game, player, seed) {
    this.game = game;
    this.p = player;
    this.rng = new Rng(seed);
    this.rate = this.rng.int(30, 60);
    this.offset = this.rng.int(0, this.rate - 1);
    this.spawnAttemptTick = this.rng.int(5, 40);
  }
  tick() {
    const g = this.game, p = this.p;
    if (g.phase === 'spawn') {
      if (!p.spawned && g.tick >= this.spawnAttemptTick) {
        const t = g.randomSpawnTile(g.config.minDistanceBetweenPlayers() * 0.6);
        if (t !== null) g.spawn(p, t);
        else this.spawnAttemptTick = g.tick + 10;
      }
      return;
    }
    if (!p.alive || g.tick % this.rate !== this.offset) return;
    const { players: neighbors, touchesNeutral } = g.neighborsOf(p);
    if (touchesNeutral) {
      const troops = Math.floor(p.troops * 0.3);
      if (troops > 10) g.sendAttack(p, null, troops);
      return;
    }
    const enemies = neighbors.filter((o) => !p.isFriendly(o) && o.troops < p.troops * 0.8);
    if (enemies.length && this.rng.chance(3)) {
      enemies.sort((a, b) => a.troops - b.troops);
      const troops = Math.floor(p.troops / 4);
      if (troops > 10) g.sendAttack(p, enemies[0], troops);
    }
    // bots accept alliances rarely
    for (const [, r] of [...g.allianceRequests]) {
      if (r.to === p) g.replyAlliance(p, r.from, this.rng.chance(3));
    }
  }
}

module.exports = { NationAI, BotAI };
