'use strict';
// AI players. "Nations" are real opponents whose aggression scales with the difficulty setting;
// "Bots" are small tribes that mostly just expand. Nations use every War World system: factories/rail,
// labs + research (and change behaviour based on what they researched), mechs, warships/subs/mines,
// choke-point walls, nukes and bombers.
const { Rng } = require('./rng');
const { PlayerType, UnitType, NukeType, Difficulty, RESEARCH_BY_ID } = require('./config');
const R = require('./research').effects;

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
    this.spawnTries = 0;
    this.aggression = 1;      // multiplies willingness to attack (research-driven)
    this.buildBias = 1;
    this.wantFactories = 1;
    this.wantMechs = 0;
    this.wantWarships = 0;
    this.wantSubs = 0;
    this.wantMines = 0;
    this.wantBombers = 0;
    this.nukeBias = 1;
    this.lastWallTick = -10000;
    this.currentEnemy = null;
  }

  get difficulty() { return this.cfg.difficulty(); }
  get hardOrWorse() { return this.difficulty === Difficulty.HARD || this.difficulty === Difficulty.IMPOSSIBLE; }
  get diffIndex() { return { easy: 0, medium: 1, hard: 2, impossible: 3 }[this.difficulty]; }

  tick() {
    const g = this.game, p = this.p;
    if (g.phase === 'spawn') {
      if (!p.spawned && g.tick >= this.spawnAttemptTick) {
        let t = p.nationSpawn ? g.randomSpawnTile(this.cfg.minDistanceBetweenPlayers() * 0.5, p.nationSpawn) : null;
        if (t === null && (!p.nationSpawn || this.spawnTries++ > 3)) t = g.randomSpawnTile(this.cfg.minDistanceBetweenPlayers());
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
      if (offset === oneThird) this.handleMechs();
      return;
    }
    this.handleAllianceRequests();
    this.handleStructures();
    this.handleNavy();
    this.handleMechs();
    this.maybeAttack();
    this.maybeNuke();
    this.maybeBomb();
  }

  // Called when a research completes: adopt the doctrine.
  onResearch() {
    const p = this.p;
    this.aggression = 1; this.buildBias = 1; this.wantFactories = 1; this.wantMechs = 0; this.wantWarships = 0; this.wantSubs = 0; this.wantMines = 0; this.wantBombers = 0; this.nukeBias = 1;
    for (const id of p.researches) {
      const r = RESEARCH_BY_ID[id];
      if (!r || !r.ai) continue;
      if (r.ai.aggression) this.aggression *= r.ai.aggression;
      if (r.ai.build) this.buildBias *= r.ai.build;
      if (r.ai.factories) this.wantFactories = Math.max(this.wantFactories, r.ai.factories);
      if (r.ai.mechs) this.wantMechs += r.ai.mechs;
      if (r.ai.warships) this.wantWarships += r.ai.warships;
      if (r.ai.subs) this.wantSubs += r.ai.subs;
      if (r.ai.mines) this.wantMines += r.ai.mines;
      if (r.ai.bombers) this.wantBombers += r.ai.bombers;
      if (r.ai.nukes) this.nukeBias *= 1 + 0.5 * r.ai.nukes;
    }
    // war economy pays for attacking: keep less in reserve
    if (p.researches.has('war_economy')) this.reserveRatio = Math.max(0.2, this.reserveRatio * 0.7);
  }

  // ---- attacking ------------------------------------------------------------
  // Where we'd like expansion pulled: toward the current enemy, else toward the largest neutral area.
  chooseFocus(target) {
    const g = this.game, p = this.p;
    if (target) { const c = g.centroid(target); if (c) return g.ref(Math.round(c.x), Math.round(c.y)); }
    // neutral: sample border tiles' outward neighbours, pick the direction with the most neutral land in a 25-tile probe
    let bestT = -1, bestScore = -1;
    const mine = g.centroid(p) || { x: 0, y: 0 };
    let i = 0;
    for (const t of p.border) {
      if (i++ % 7) continue;
      if (i > 700) break;
      const dx = g.x(t) - mine.x, dy = g.y(t) - mine.y, l = Math.hypot(dx, dy) || 1;
      let score = 0;
      for (let k = 6; k <= 30; k += 6) {
        const x = Math.round(g.x(t) + (dx / l) * k), y = Math.round(g.y(t) + (dy / l) * k);
        if (!g.valid(x, y)) break;
        const tt = g.ref(x, y);
        if (g.isLand(tt) && g.owner[tt] === 0 && !g.fallout[tt]) score++;
      }
      if (score > bestScore) { bestScore = score; bestT = t; }
    }
    return bestT;
  }
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
    if (ratio < this.reserveRatio / this.aggression) return;
    if (ratio < this.triggerRatio / this.aggression && !this.rng.chance(10)) return;
    for (const s of this.getStrategies(friends, enemies)) if (s()) return;
  }
  getStrategies(friends, enemies) {
    const p = this.p, g = this.game;
    const retaliate = () => { const inc = p.incomingAttacks.find((a) => a.attacker.alive && !p.isFriendly(a.attacker)); return inc ? this.sendAttack(inc.attacker) : false; };
    const bots = () => { const bot = enemies.find((e) => e.type === PlayerType.BOT); return bot ? this.sendAttack(bot) : false; };
    const assist = () => { for (const f of friends) for (const a of f.incomingAttacks) if (enemies.includes(a.attacker)) return this.sendAttack(a.attacker); return false; };
    const betray = () => {
      if (!this.hardOrWorse || !this.rng.chance(40)) return false;
      const weak = friends.find((f) => f.troops < this.cfg.maxTroops(f) * 0.15 && f.troops < p.troops * 0.5 && f.type !== PlayerType.HUMAN);
      if (!weak) return false;
      g.breakAlliance(p, weak);
      return this.sendAttack(weak);
    };
    const hated = () => { for (const e of enemies) if (p.relation(e) <= -50 && e.troops < p.troops * 3) return this.sendAttack(e); return false; };
    const afk = () => { const e = enemies.find((o) => o.disconnected && o.troops < p.troops * 3); return e ? this.sendAttack(e) : false; };
    const traitor = () => { const e = enemies.find((o) => o.isTraitor()); return e ? this.sendAttack(e) : false; };
    const victim = () => {
      const e = enemies.find((o) => { if (o.troops > p.troops * 1.2) return false; const incoming = o.incomingAttacks.reduce((s, a) => s + a.troops, 0); return incoming > o.troops * 0.5; });
      return e ? this.sendAttack(e) : false;
    };
    const veryWeak = () => { const e = enemies.find((o) => o.troops < this.cfg.maxTroops(o) * 0.15 && o.troops < p.troops * 1.2); return e ? this.sendAttack(e) : false; };
    const juicy = () => {
      const cands = enemies.filter((o) => o.troops <= p.troops * 0.75);
      if (!cands.length) return false;
      cands.sort((a, b) => b.numTiles + b.units.length * 200 - (a.numTiles + a.units.length * 200));
      return this.sendAttack(cands[0]);
    };
    const weakest = () => { if (!enemies.length) return false; const w = enemies[0]; return w.troops < p.troops * this.aggression ? this.sendAttack(w) : false; };
    const island = () => (enemies.length === 0 ? this.attackWithRandomBoat() : false);
    const donate = () => {
      for (const f of friends) {
        if (f.troops < this.cfg.maxTroops(f) * 0.2 && f.incomingAttacks.length > 0 && p.troops > this.cfg.maxTroops(p) * 0.6) { g.donate(p, f, Math.floor(p.troops * 0.2), 0); return true; }
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
    for (const n of this.game.neighborsOf(p).players) if (!p.isFriendly(n) && n.type !== PlayerType.BOT && n.troops > maxNeighbor) maxNeighbor = n.troops;
    let cap = maxNeighbor === 0 ? Infinity : Math.max(0, p.troops - Math.ceil(maxNeighbor * retain / this.aggression));
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
    if (target) this.currentEnemy = target;
    const focus = this.chooseFocus(target);
    return this.game.sendAttack(this.p, target, troops, null, focus) !== null;
  }
  shoreTiles(player, limit = 400, ocean = false) {
    const g = this.game, out = [];
    for (const t of player.border) { if (ocean ? g.isOceanShore(t) : g.isShore(t)) { out.push(t); if (out.length >= limit) break; } }
    return out;
  }
  attackWithRandomBoat(enemies = []) {
    const g = this.game, p = this.p;
    if (g.settings.disableBoats) return false;
    if (p.boats.length >= this.cfg.boatMaxNumber(p)) return false;
    if (!this.shoreTiles(p, 1).length) return false;
    const candidates = g.players.filter((o) => o !== p && o.alive && !p.isFriendly(o) && !enemies.includes(o) && o.troops < p.troops * 0.8 && g.canAttack(p, o));
    let dstTile = null;
    if (candidates.length && this.rng.chance(2)) {
      const target = this.rng.pick(candidates);
      const shore = this.shoreTiles(target, 60);
      if (shore.length) dstTile = this.rng.pick(shore);
    } else {
      for (let i = 0; i < 40 && dstTile === null; i++) {
        const t = this.rng.int(0, g.terrain.length - 1);
        if (g.isLand(t) && g.owner[t] === 0 && !g.fallout[t] && g.isShore(t)) dstTile = t;
      }
    }
    if (dstTile === null) return false;
    if (g.pathBudget-- <= 0) return false;
    const troops = this.calculateAttackTroops(g.ownerOf(dstTile), true);
    if (troops === null) return false;
    return g.sendBoat(p, dstTile, troops) !== null;
  }

  // ---- alliances --------------------------------------------------------------
  handleAllianceRequests() {
    const g = this.game, p = this.p;
    for (const [, r] of [...g.allianceRequests]) {
      if (r.to !== p) continue;
      const from = r.from;
      const accept = p.relation(from) > -20 && (from.troops > p.troops * 0.5 || this.rng.chance(2)) && !this.rng.chance(4);
      g.replyAlliance(p, from, accept);
    }
  }
  maybeSendAllianceRequests(enemies) {
    if (!this.rng.chance(15)) return;
    const p = this.p;
    const strong = enemies.filter((e) => e.type !== PlayerType.BOT && e.troops > p.troops && p.relation(e) >= 0 && e.incomingAttacks.every((a) => a.attacker !== p));
    if (strong.length) this.game.requestAlliance(p, this.rng.pick(strong));
  }

  // ---- structures --------------------------------------------------------------
  handleStructures() {
    const g = this.game, p = this.p;
    if (this.placements > 0 && this.tryBuildDefensePost()) return;
    if (this.placements > 0 && this.maybeBuildWall()) return;
    if (g.tick - this.lastStructureTick < 80 / this.buildBias) return;
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
    const postBias = p.researches.has('defensive_position') || p.researches.has('coastal_defense') ? 2 : 1;
    const allowed = (this.difficulty === Difficulty.MEDIUM ? 1 : Math.ceil(ratio / 0.4)) * postBias;
    if (p.unitsOf(UnitType.DEFENSE_POST).length >= allowed) return false;
    if (p.gold < this.cfg.unitCost(UnitType.DEFENSE_POST, p.unitsOf(UnitType.DEFENSE_POST).length, p)) return false;
    const attackerSm = land[0].attacker.smallID;
    const front = [];
    const b = [0, 0, 0, 0];
    for (const t of p.border) { const n = g.neighbors4(t, b); for (let k = 0; k < n; k++) if (g.owner[b[k]] === attackerSm) { front.push(t); break; } if (front.length > 200) break; }
    if (!front.length) return false;
    for (let i = 0; i < 10; i++) {
      let spot = this.rng.pick(front);
      for (let s = 0; s < 4; s++) { const n = g.neighbors4(spot, b); let moved = false; for (let k = 0; k < n; k++) if (g.owner[b[k]] === p.smallID && !p.border.has(b[k])) { spot = b[k]; moved = true; break; } if (!moved) break; }
      if (g.build(p, UnitType.DEFENSE_POST, spot).ok) { if (p.researches.has('defensive_position')) g.reinforcePost(p, spot); return true; }
    }
    return false;
  }
  randomInnerTile(tries = 20, requireShore = false) {
    const g = this.game, p = this.p;
    if (!p.tiles.size) return null;
    let fallback = null;
    for (let i = 0; i < tries; i++) {
      const t = g.randomTileOf(p.tiles, this.rng);
      if (requireShore) { if (g.isOceanShore(t)) return t; continue; }
      if (!p.border.has(t) && !g.wallHp[t]) {
        fallback = fallback ?? t;
        const b = [0, 0, 0, 0];
        const n = g.neighbors4(t, b);
        let inner = true;
        for (let k = 0; k < n; k++) if (p.border.has(b[k]) || g.owner[b[k]] !== p.smallID) inner = false;
        if (inner) return t;
      }
    }
    return fallback;
  }
  tileNearFactory(factory) {
    const g = this.game, p = this.p;
    for (let i = 0; i < 30; i++) {
      const t = g.randomTileOf(p.tiles, this.rng);
      if (t === null) return null;
      const d = g.dist(t, factory.tile);
      if (d >= 20 && d <= 100 && !p.border.has(t) && !g.hasPopulationNear(t, this.cfg.labMinGapFromPopulation())) return t;
    }
    return null;
  }
  doHandleStructures() {
    const g = this.game, p = this.p;
    const cities = p.unitsOf(UnitType.CITY).length;
    const ports = p.unitsOf(UnitType.PORT).length;
    const factories = p.unitsOf(UnitType.FACTORY);
    const silos = p.unitsOf(UnitType.SILO).length;
    const sams = p.unitsOf(UnitType.SAM).length;
    const coastal = this.shoreTiles(p, 1, true).length > 0;
    const troopRatio = p.troops / this.cfg.maxTroops(p);
    const enemiesHaveSilos = g.units.some((u) => u.type === UnitType.SILO && u.owner !== p && !p.isFriendly(u.owner));
    const reserve = silos > 0 ? this.cfg.nukeCost(NukeType.ATOM, p) * 1.3 : 0;
    const easy = this.difficulty === Difficulty.EASY;

    if (!g.settings.disableNukes && enemiesHaveSilos && sams < 1 + Math.floor(cities / 4) && p.gold >= this.cfg.unitCost(UnitType.SAM, sams, p) && !easy) {
      const t = this.randomInnerTile();
      if (t !== null && g.build(p, UnitType.SAM, t).ok) return true;
    }
    if (coastal && ports < Math.max(1, Math.floor(cities * 0.75)) && p.gold >= this.cfg.unitCost(UnitType.PORT, g.costIndex(p, UnitType.PORT), p)) {
      const t = this.randomInnerTile(30, true);
      if (t !== null && g.build(p, UnitType.PORT, t).ok) return true;
    }
    // Factory: rail economy, and the only way to get mechs. First one after 2 cities; more when research wants them.
    const wantF = Math.min(4, Math.max(this.wantFactories, cities >= 4 ? 2 : 1, this.wantMechs ? 2 : 1));
    if (!easy && cities >= 2 && factories.length < wantF && p.gold >= this.cfg.unitCost(UnitType.FACTORY, g.costIndex(p, UnitType.FACTORY), p) + reserve) {
      const t = this.randomInnerTile(30);
      if (t !== null && g.build(p, UnitType.FACTORY, t).ok) return true;
    }
    // Upgrade a factory to level 2 so mechs are available (Hard+ always, Medium sometimes, or when research says mechs)
    const lvl1 = factories.find((f) => f.level === 1 && f.constructionLeft === 0);
    if (lvl1 && (this.hardOrWorse || this.wantMechs || this.rng.chance(3)) && cities >= 3 && p.gold >= this.cfg.unitCost(UnitType.FACTORY, p.unitLevels(UnitType.FACTORY), p) + reserve) {
      if (g.build(p, UnitType.FACTORY, lvl1.tile).ok) return true;
    }
    // Research Lab: near a factory (rail range), away from cities, once we have 3 cities.
    const labs = p.unitsOf(UnitType.LAB).length;
    if (!easy && labs < 1 && g.populationCount(p) >= this.cfg.populationRequiredForLab() && p.researchCount() < this.cfg.maxResearchesPerPlayer()) {
      const fac = factories.find((f) => f.constructionLeft === 0);
      if (fac) {
        const cost = this.cfg.unitCost(UnitType.LAB, labs, p);
        if (p.gold >= cost + reserve) { for (let i = 0; i < 12; i++) { const t = this.tileNearFactory(fac); if (t !== null && g.build(p, UnitType.LAB, t).ok) return true; } }
        else if (cities >= 4) return false; // save up
      }
    }
    // Save-up phase for a missile silo once we have a few cities.
    if (!g.settings.disableNukes && !easy && silos < 1 && cities >= 3) {
      if (p.gold >= this.cfg.unitCost(UnitType.SILO, silos, p)) { const t = this.randomInnerTile(); if (t !== null && g.build(p, UnitType.SILO, t).ok) return true; }
      else if (labs >= 1 || cities >= 5) return false;
    }
    // Mines around our ports when we researched them
    if (this.wantMines && coastal && p.unitsOf(UnitType.MINE).length < 6 && p.gold >= this.cfg.unitCost(UnitType.MINE, 0, p) + reserve) {
      const port = p.completedUnitsOf(UnitType.PORT)[0];
      if (port) for (let i = 0; i < 10; i++) {
        const x = g.x(port.tile) + this.rng.int(-30, 30), y = g.y(port.tile) + this.rng.int(-30, 30);
        if (!g.valid(x, y)) continue;
        const t = g.ref(x, y);
        if (g.isOcean(t) && g.build(p, UnitType.MINE, t).ok) return true;
      }
    }
    const mechReserve = this.wantMechs || (this.hardOrWorse && cities >= 4) ? this.cfg.unitCost(UnitType.MECH, p.mechs.length, p) * 0.5 : 0;
    if ((troopRatio > 0.6 || cities === 0) && p.gold >= this.cfg.unitCost(UnitType.CITY, cities, p) + reserve + mechReserve) {
      const t = this.randomInnerTile();
      if (t !== null && g.build(p, UnitType.CITY, t).ok) return true;
    }
    return false;
  }

  // ---- research choice ------------------------------------------------------------
  pickResearch(choices) {
    const p = this.p, g = this.game;
    if (this.difficulty === Difficulty.EASY) return choices[this.rng.int(0, choices.length - 1)];
    const coastal = this.shoreTiles(p, 1, true).length > 0;
    const underAttack = p.incomingAttacks.length > 0;
    const hasFactory2 = g.mechFactories(p).length > 0;
    const enemiesHaveNukes = g.units.some((u) => u.type === UnitType.SILO && g.hostile(p, u.owner));
    const score = (id) => {
      const r = RESEARCH_BY_ID[id];
      if (!r) return -1;
      let s = 5;
      for (const tag of r.tags) {
        if (tag === 'mech') s += hasFactory2 || p.mechs.length ? 8 : (this.hardOrWorse ? 3 : -3);
        if (tag === 'defense') s += underAttack ? 7 : 2;
        if (tag === 'aggro') s += this.hardOrWorse ? 4 : 1;
        if (tag === 'econ') s += p.gold < 500000 ? 6 : 2;
        if (tag === 'navy') s += coastal ? (this.hardOrWorse ? 4 : 2) : -12;
        if (tag === 'air') s += p.unitsOf(UnitType.SILO).length ? 4 : -2;
        if (tag === 'nuke') s += p.unitsOf(UnitType.SILO).length ? 5 : -4;
      }
      if (id === 'nuclear_deterrence' && enemiesHaveNukes) s += 6;
      if (id === 'fighter_networks' && !g.players.some((o) => o.researches.has('strategic_bombers') && g.hostile(p, o))) s -= 6;
      if (id === 'nuclear_subs' && !p.researches.has('submarine_warfare')) s -= 20;
      return s + this.rng.int(0, 3);
    };
    return choices.slice().sort((a, b) => score(b) - score(a))[0];
  }

  // ---- walls: choke-point analysis --------------------------------------------------
  // Approximate min-cut: BFS inward from the front facing the attacker through our own land. Every BFS layer
  // is a cut separating the front from the interior; the narrowest layer within a short depth is the choke.
  // Build there if it's much narrower than the front (cost vs benefit), and we can afford it.
  maybeBuildWall() {
    const g = this.game, p = this.p;
    if (this.difficulty === Difficulty.EASY) return false;
    if (g.tick - this.lastWallTick < 150) return false;
    const land = p.incomingAttacks.filter((a) => a.sourceTile === null && !a.done);
    let attacker = null;
    if (land.length) {
      const incoming = land.reduce((s, a) => s + a.troops, 0);
      if (incoming >= p.troops * 0.2 || this.hardOrWorse) attacker = land[0].attacker;
    }
    if (!attacker && this.hardOrWorse && this.rng.chance(3)) {
      // proactive: fortify against the strongest hostile neighbour
      const nb = g.neighborsOf(p).players.filter((o) => g.hostile(p, o) && o.type !== PlayerType.BOT).sort((a, b) => b.troops - a.troops);
      if (nb.length && nb[0].troops > p.troops * 0.8) attacker = nb[0];
    }
    if (!attacker) return false;
    if (p.wallQueue.length > 2) return false;
    if (p.numWallTiles > 200 + (this.hardOrWorse ? 250 : 0)) return false;
    const plan = this.findChokeWall(attacker);
    if (!plan) return false;
    const quote = g.planWall(p, plan.waypoints);
    if (!quote.ok) return false;
    // benefit: how much narrower the cut is than the front, and how threatened we are
    const threat = Math.min(3, attacker.troops / Math.max(1, p.troops));
    const value = (plan.frontLen / Math.max(1, plan.cutLen)) * threat;
    if (value < 1.2) return false;
    if (quote.cost > p.gold * (this.hardOrWorse ? 0.6 : 0.4)) return false;
    const r = g.buildWall(p, plan.waypoints);
    if (r.ok) { this.lastWallTick = g.tick; return true; }
    return false;
  }
  findChokeWall(attacker) {
    const g = this.game, p = this.p;
    const b = [0, 0, 0, 0];
    // front = our border tiles touching the attacker
    const front = [];
    for (const t of p.border) { const n = g.neighbors4(t, b); for (let k = 0; k < n; k++) if (g.owner[b[k]] === attacker.smallID) { front.push(t); break; } if (front.length > 600) break; }
    if (front.length < 6) return null;
    // BFS layers inward through our land (walls/structures block)
    const depthOf = new Map();
    let frontier = front.slice();
    for (const t of frontier) depthOf.set(t, 0);
    const layers = [frontier];
    const MAXD = 22;
    for (let d = 1; d <= MAXD && frontier.length; d++) {
      const next = [];
      for (const t of frontier) {
        const n = g.neighbors4(t, b);
        for (let k = 0; k < n; k++) {
          const nb = b[k];
          if (depthOf.has(nb)) continue;
          if (g.owner[nb] !== p.smallID || !g.isLand(nb)) continue;
          depthOf.set(nb, d);
          next.push(nb);
        }
      }
      layers.push(next);
      frontier = next;
    }
    // pick the narrowest layer at depth >= 3 (so the wall isn't on the very front line); it must still exist
    let best = -1, bestLen = Infinity;
    for (let d = 3; d < layers.length; d++) {
      const L = layers[d];
      if (!L.length) break;
      // a layer is a valid cut only if the layer beyond it is non-empty (there is an interior to protect)
      if (!layers[d + 1] || !layers[d + 1].length) break;
      const clean = L.filter((t) => !g.unitByTile.has(t) && !g.hasPopulationNear(t, this.cfg.structureMinGap()));
      if (clean.length < L.length * 0.8) continue;
      if (L.length < bestLen) { bestLen = L.length; best = d; }
    }
    if (best < 0) return null;
    const cut = layers[best];
    if (cut.length > 90) return null;
    // order the cut tiles into a polyline: greedy nearest-neighbour chain from one end
    const remaining = new Set(cut);
    // start from an extreme point (max distance from centroid)
    let cx = 0, cy = 0; for (const t of cut) { cx += g.x(t); cy += g.y(t); } cx /= cut.length; cy /= cut.length;
    let start = cut[0], bd = -1;
    for (const t of cut) { const d = (g.x(t) - cx) ** 2 + (g.y(t) - cy) ** 2; if (d > bd) { bd = d; start = t; } }
    const chain = [start]; remaining.delete(start);
    let cur = start;
    while (remaining.size) {
      let nx = -1, nd = Infinity;
      for (const t of remaining) { const d = (g.x(t) - g.x(cur)) ** 2 + (g.y(t) - g.y(cur)) ** 2; if (d < nd) { nd = d; nx = t; } }
      if (nd > 36) break; // disjoint piece: stop (walls need to be a line)
      chain.push(nx); remaining.delete(nx); cur = nx;
    }
    if (chain.length < 4) return null;
    // thin the chain to waypoints every ~3 tiles (walls are 3 thick; the spine fills gaps)
    const waypoints = chain.filter((_, i) => i % 3 === 0 || i === chain.length - 1);
    return { waypoints, frontLen: front.length, cutLen: cut.length, depth: best };
  }

  // ---- navy --------------------------------------------------------------------------
  handleNavy() {
    const g = this.game, p = this.p;
    if (this.difficulty === Difficulty.EASY || g.settings.disableBoats) return;
    const ports = p.completedUnitsOf(UnitType.PORT);
    if (!ports.length) return;
    const reserve = p.unitsOf(UnitType.SILO).length ? this.cfg.nukeCost(NukeType.ATOM, p) : 0;
    const enemyShipsNear = g.warships.some((w) => !w.done && g.hostile(p, w.owner) && ports.some((u) => g.distXY(g.x(u.tile), g.y(u.tile), w.x, w.y) < 150));
    const wantW = Math.min(R.warshipCap(p), (this.hardOrWorse ? 1 : 0) + this.wantWarships + (enemyShipsNear ? 2 : 0) + (p.boats.length ? 1 : 0));
    const live = p.warships.filter((w) => !w.done).length;
    if (live < wantW && p.gold >= this.cfg.unitCost(UnitType.WARSHIP, p.warships.length, p) + reserve) {
      const pt = this.navalPatrolPoint(ports);
      if (pt >= 0 && g.buildWarship(p, pt).ok) return;
    }
    // retarget warships toward the current enemy's coast when bombardment is researched
    if (p.researches.has('coastal_bombardment') && this.currentEnemy && this.currentEnemy.alive && this.rng.chance(2)) {
      const shore = this.shoreTiles(this.currentEnemy, 40, true);
      if (shore.length) {
        for (const w of p.warships) {
          if (w.done || this.rng.chance(2)) continue;
          const st = this.rng.pick(shore);
          const wn = g.waterNeighborsOf(st);
          if (wn.length) g.moveShip(p, w.id, wn[0]);
        }
      }
    }
    if (this.wantSubs && p.subs.filter((s) => !s.done).length < 2 && p.gold >= this.cfg.unitCost(UnitType.SUBMARINE, p.subs.length, p) + reserve) {
      // subs lurk off an enemy coast if we have one, else near home
      let pt = -1;
      if (this.currentEnemy && this.currentEnemy.alive) { const shore = this.shoreTiles(this.currentEnemy, 30, true); if (shore.length) { const wn = g.waterNeighborsOf(this.rng.pick(shore)); if (wn.length) pt = wn[0]; } }
      if (pt < 0) pt = this.navalPatrolPoint(ports);
      if (pt >= 0) g.buildSub(p, pt);
    }
  }
  navalPatrolPoint(ports) {
    const g = this.game;
    const port = this.rng.pick(ports);
    for (let i = 0; i < 20; i++) {
      const x = g.x(port.tile) + this.rng.int(-40, 40), y = g.y(port.tile) + this.rng.int(-40, 40);
      if (g.valid(x, y) && g.isOcean(g.ref(x, y))) return g.ref(x, y);
    }
    const wn = g.waterNeighborsOf(port.tile);
    return wn.length ? wn[0] : -1;
  }

  // ---- mechs ---------------------------------------------------------------------------
  handleMechs() {
    const g = this.game, p = this.p;
    if (this.difficulty === Difficulty.EASY) return;
    const facs = g.mechFactories(p);
    const live = p.mechs.filter((m) => !m.done);
    const cap = R.mechCap(p);
    const want = Math.min(cap, (this.difficulty === Difficulty.MEDIUM ? 1 : this.difficulty === Difficulty.HARD ? 2 : 3) + this.wantMechs);
    // choose where mechs should be: the front against the current enemy (or the strongest hostile neighbour)
    let enemy = this.currentEnemy && this.currentEnemy.alive && g.hostile(p, this.currentEnemy) ? this.currentEnemy : null;
    if (!enemy) {
      const nb = g.neighborsOf(p).players.filter((o) => g.hostile(p, o) && o.type !== PlayerType.BOT).sort((a, b) => b.troops - a.troops);
      enemy = nb[0] || null;
      const inc = p.incomingAttacks.find((a) => a.attacker.alive && g.hostile(p, a.attacker));
      if (inc) enemy = inc.attacker;
    }
    const target = enemy ? this.mechTargetTile(enemy) : -1;
    if (facs.length && live.length < want) {
      const reserve = p.unitsOf(UnitType.SILO).length ? this.cfg.nukeCost(NukeType.ATOM, p) : 0;
      const cost = this.cfg.unitCost(UnitType.MECH, p.mechs.length, p);
      if (p.gold >= cost + reserve * 0.5) {
        const dst = target >= 0 ? target : this.randomInnerTile();
        if (dst !== null && dst >= 0) g.buildMech(p, dst);
      }
    }
    // re-task idle / misplaced mechs every so often
    if (target >= 0 && this.rng.chance(2)) {
      for (const m of live) {
        if (m.engaged) continue;
        if (g.dist(m.patrol, target) > 25) g.moveMech(p, m.id, target);
      }
    }
  }
  // A tile just inside the enemy's border, nearest to us: mechs park there and grind the frontier.
  mechTargetTile(enemy) {
    const g = this.game, p = this.p;
    const mine = g.centroid(p);
    if (!mine) return -1;
    let best = -1, bd = Infinity, i = 0;
    for (const t of enemy.border) {
      if (i++ % 5) continue;
      if (i > 3000) break;
      if (!g.isLand(t)) continue;
      const d = (g.x(t) - mine.x) ** 2 + (g.y(t) - mine.y) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  // ---- nukes / bombers ------------------------------------------------------------------
  maybeNuke() {
    const g = this.game, p = this.p;
    if (g.settings.disableNukes || this.difficulty === Difficulty.EASY) return;
    if (this.difficulty === Difficulty.MEDIUM && !this.rng.chance(Math.max(1, Math.round(3 / this.nukeBias)))) return;
    const c = g.canLaunchNuke(p, NukeType.ATOM, p.spawnTile ?? 0);
    if (!c.ok && !c.reason.startsWith('Not enough')) return;
    let type = NukeType.ATOM;
    if (this.difficulty === Difficulty.IMPOSSIBLE && p.gold >= this.cfg.nukeCost(NukeType.HYDROGEN, p) * 1.5 && this.rng.chance(3)) type = NukeType.HYDROGEN;
    const cost = this.cfg.nukeCost(type, p);
    if (p.gold < cost * (1.3 / this.nukeBias)) return;
    let enemies = g.players.filter((o) => o !== p && o.alive && !p.isFriendly(o) && o.type !== PlayerType.BOT &&
      (o.incomingAttacks.some((a) => a.attacker === p) || p.incomingAttacks.some((a) => a.attacker === o) || p.relation(o) <= -50));
    if (!enemies.length && this.hardOrWorse && p.troops > this.cfg.maxTroops(p) * 0.8) enemies = g.neighborsOf(p).players.filter((o) => !p.isFriendly(o) && o.type !== PlayerType.BOT);
    if (!enemies.length) return;
    enemies.sort((a, b) => b.troops - a.troops);
    const target = enemies[0];
    if (target.numTiles < 400) return;
    const { outer } = this.cfg.nukeMagnitude(type, p);
    let best = null, bestScore = 0;
    for (let i = 0; i < 12; i++) {
      const t = g.randomTileOf(target.tiles, this.rng);
      const cx = g.x(t), cy = g.y(t);
      let enemyCount = 0, ownOrAlly = 0;
      const r = outer + 3;
      for (let y = Math.max(0, cy - r); y <= Math.min(g.height - 1, cy + r); y += 2) for (let x = Math.max(0, cx - r); x <= Math.min(g.width - 1, cx + r); x += 2) {
        const sm = g.owner[g.ref(x, y)];
        if (sm === 0) continue;
        const o = g.playersBySmall[sm];
        if (o === p || p.isFriendly(o)) ownOrAlly++; else if (o === target) enemyCount++;
      }
      if (ownOrAlly > 0) continue;
      for (const u of target.units) if (Math.abs(g.x(u.tile) - cx) <= outer && Math.abs(g.y(u.tile) - cy) <= outer) enemyCount += 60;
      if (enemyCount > bestScore) { bestScore = enemyCount; best = t; }
    }
    if (best === null || bestScore < 40) return;
    g.launchNuke(p, type, best);
  }
  maybeBomb() {
    const g = this.game, p = this.p;
    if (!this.wantBombers || !p.researches.has('strategic_bombers')) return;
    if (p.gold < this.cfg.bomberCost() * 2 || !this.rng.chance(2)) return;
    const silos = p.completedUnitsOf(UnitType.SILO);
    if (!silos.length) return;
    const range = this.cfg.bomberRange();
    const targets = g.units.filter((u) => g.hostile(p, u.owner) && u.owner.type !== PlayerType.BOT && [UnitType.SILO, UnitType.SAM, UnitType.FACTORY, UnitType.CITY, UnitType.LAB, UnitType.PORT].includes(u.type) && silos.some((s) => g.dist(s.tile, u.tile) <= range));
    if (!targets.length) return;
    const pri = { silo: 5, sam: 4, factory: 4, lab: 3, city: 2, port: 1 };
    targets.sort((a, b) => (pri[b.type] || 0) - (pri[a.type] || 0));
    g.launchBomber(p, targets[0].tile);
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
        const t = g.randomSpawnTile(g.config.minDistanceBetweenPlayers() * 0.5);
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
    for (const [, r] of [...g.allianceRequests]) if (r.to === p) g.replyAlliance(p, r.from, this.rng.chance(3));
  }
}

module.exports = { NationAI, BotAI };
