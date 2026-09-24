'use strict';
// Zombie mode: "the dead rise".
//
// What it borrows, and from where:
//   * patient-zero hives in the wilderness that keep feeding the horde and seed new ones elsewhere
//     (Warcraft III zombie maps' virus pools, Plague Inc's patient zero)
//   * great waves announced before they hit, and a final wave from every direction as the clock runs
//     out (They Are Billions' swarms and its "THEY ARE BILLIONS!!" finale); noise - bombs and big
//     battles - draws the horde's attention (They Are Billions)
//   * infection crossing the sea on ships: an infected transport or trade ship starts a new outbreak
//     where it lands (Plague Inc's boats), plus zombie rafts the horde sends itself
//   * scavenging the infected land: every tile taken back pays salvage and yields samples the cure
//     needs (Infection Free Zone's expeditions)
//
// The horde is a player of its own (type 'zombie'): its land is zombie land, its troops are the dead.
//   * It spreads like an ownerless attack - into empty land and into every living neighbour.
//   * The living who die fighting it rise and join it (a difficulty-set share; cure step 2 stops yours).
//   * Its infection creeps across borders a few tiles at a time; walls, defense posts, a mech's hold
//     zone and (cure step 1) your cities' surroundings stop the creep. Zombies barely scratch walls.
//
// Phases: calm (a minute or two to expand) -> outbreak (the apocalypse) -> aftermath (the horde is
// cured, wiped out, or the clock ran out: its land rots back to empty ground for a last land rush)
// -> over. Two results: every nation still standing survived; the strongest survivor wins outright.
//
// The cure: three steps researched in any of your labs, alongside your doctrines. Steps 2 and 3 need
// samples - zombie land you have taken back. The first nation to finish step 3 cures the world.
// Mixed into Game.prototype.
const { PlayerType, UnitType } = require('./config');

// easy (Shamblers) -> medium (Outbreak) -> hard (Pandemic) -> nightmare (Extinction)
const Z = {
  names: ['Shamblers', 'Outbreak', 'Pandemic', 'Extinction'],
  calmTicks: [1800, 1500, 1200, 900],           // after the spawn phase, before the dead rise (3, 2.5, 2, 1.5 min)
  hives: [2, 3, 4, 5],
  hiveRadius: [6, 7, 8, 9],
  // The horde is sized against the living: W = every living nation's and player's troops together.
  startShare: [0.3, 0.45, 0.55, 0.8],          // the horde at the outbreak, x W
  growthShare: [0.0005, 0.0008, 0.00095, 0.0013],// growth per tick, x W (on top of the dead that rise)
  growthPerTile: [0.1, 0.16, 0.24, 0.34],       // troops per tick per zombie tile
  capShare: [0.7, 1.1, 1.3, 1.8],               // soft cap, x W: above it the dead rot faster than they rise
  hiveGuard: 2.5,                               // ground near a living hive is this much harder to take
  convert: [0.2, 0.3, 0.36, 0.48],              // share of the living killed fighting it that rise again
  attackEvery: [70, 50, 44, 34],
  attackShare: [0.14, 0.18, 0.2, 0.25],
  wildShare: [0.04, 0.05, 0.06, 0.07],          // share sent into empty land each push...
  wildCap: [0.008, 0.012, 0.014, 0.018],        // ...but never more than this x W, so the wilds fill at a walk, not a sprint
  creep: [0.004, 0.007, 0.009, 0.013],          // chance per contact tile per 2s
  waveEvery: [4200, 3600, 3000, 2400],          // great waves (7, 6, 5, 4 min)
  waveBonus: [0.35, 0.55, 0.8, 1.1],            // extra dead a wave brings, x its target's army
  raftEvery: [2400, 1800, 1200, 800],
  raftShare: [0.03, 0.04, 0.05, 0.07],
  sporeEvery: [0, 6000, 4800, 3600],            // a hive seeds another landmass this often (0 = never)
  surviveMin: [25, 30, 35, 40],
  wallDamage: [0.15, 0.2, 0.25, 0.3],           // zombies against walls, as a share of troops' damage
  defense: [0.8, 1, 1.15, 1.3],                 // how costly zombie ground is to take
  cureTime: [0.8, 1, 1.15, 1.3],
  infectShip: [0.15, 0.25, 0.35, 0.5],
};
const WARN_TICKS = 300;                  // a great wave is announced 30s before it breaks
const AFTERMATH_TICKS = 3000;            // 5 minutes of land rush once the horde is gone
const ROT_TICKS = 600;                   // zombie land rots away over a minute after the cure
const CURE_BASE_TICKS = [0, 1800, 3000, 4800];   // cure steps: 3, 5, 8 minutes at a level-1 lab
const CURE_SAMPLES = [0, 0, 0.004, 0.012];       // samples (share of the land taken back from the horde)
const SALVAGE_GOLD = 120;                // gold per zombie tile taken back
const HIVE_REWARD = { samples: 150, gold: 400000 };
const IMMUNE_CITY_RADIUS = 15;           // cure step 1: creep can't take ground this close to your cities
const CURE_NAMES = ['', 'Isolate the Strain', 'Vaccine Trials', 'Mass Inoculation'];

module.exports = {
  isZombieGame() { return this.settings.mode === 'zombie'; },
  zdi() { return { easy: 0, medium: 1, hard: 2, nightmare: 3 }[this.settings.zombieDifficulty] ?? 1; },
  zombieSurviveTicks() { return (this.settings.maxTimerMinutes > 0 ? this.settings.maxTimerMinutes : Z.surviveMin[this.zdi()]) * 600; },
  // Called once all players are added.
  createHorde() {
    if (!this.isZombieGame()) return;
    const h = this.addPlayer({ id: 'horde', name: 'The Horde', type: PlayerType.ZOMBIE });
    h.color = '#5a8f3c';
    h.isHorde = true;
    this.horde = h;
    this.zombie = { phase: 'calm', outbreakTick: 0, endTick: 0, waveAt: 0, wave: null, raftAt: 0, finalWave: false, aftermathEnd: 0, rotEnd: 0, hives: [], curedBy: null, result: null, noise: new Map() };
  },
  hordeAlive() { return !!(this.horde && this.horde.tiles.size > 0); },

  // ---- the outbreak ----
  // Hives go where nobody lives: the land furthest from every nation, spread over the map, preferring
  // continents that have people on them (so nobody is safe) but no hive yet.
  pickHiveSites(count, avoid = []) {
    const living = this.players.filter((p) => p.alive && !p.isHorde);
    const massHasPeople = new Set();
    for (const p of living) { let i = 0; for (const t of p.border) { if (i++ > 40) break; massHasPeople.add(this.landmass[t]); } }
    const sites = [];
    const minApart = Math.hypot(this.width, this.height) / (count + 1.5);
    const cands = [];
    for (let k = 0; k < 4000; k++) {
      const t = this.rng.int(0, this.terrain.length - 1);
      if (!this.isLand(t) || this.owner[t] !== 0) continue;
      let dmin = Infinity;
      for (const p of living) { const c = p.spawnTile ?? -1; if (c >= 0) dmin = Math.min(dmin, this.dist(c, t)); }
      if (dmin < 25) continue;
      const bonus = massHasPeople.has(this.landmass[t]) ? 1.6 : 0.7;
      cands.push({ t, score: Math.min(dmin, 200) * bonus + this.rng.next() * 10 });
    }
    cands.sort((a, b) => b.score - a.score);
    const usedMass = new Map();
    for (const c of cands) {
      if (sites.length >= count) break;
      if ([...sites, ...avoid].some((s) => this.dist(s, c.t) < minApart)) continue;
      const m = this.landmass[c.t];
      if ((usedMass.get(m) || 0) >= 1 && usedMass.size < massHasPeople.size) continue;   // one per continent first
      sites.push(c.t); usedMass.set(m, (usedMass.get(m) || 0) + 1);
    }
    // not enough wilderness (a crowded map): fall back to the emptiest owned ground
    for (const c of cands) { if (sites.length >= count) break; if (!sites.includes(c.t)) sites.push(c.t); }
    return sites;
  },
  // The dead rise at a tile: the horde takes the ground around it (whoever held it) and gains troops.
  outbreakAt(tile, radius, troops, hive = false, kind = 'outbreak') {
    const h = this.horde;
    if (!h) return;
    if (!h.spawned) { h.spawned = true; h.spawnTile = tile; h.spawnTick = this.tick; }
    const cx = this.x(tile), cy = this.y(tile);
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        if (dx * dx + dy * dy > radius * radius) continue;
        const x = cx + dx, y = cy + dy;
        if (!this.valid(x, y)) continue;
        const t = this.ref(x, y);
        if (!this.isLand(t) || this.wallHp[t]) continue;
        const o = this.ownerOf(t);
        if (o && o !== h) o.removeTroops(o.troops / Math.max(1, o.numTiles));
        this.conquer(h, t);
      }
    }
    h.addTroops(troops);
    if (hive) this.zombie.hives.push({ tile, alive: true, sporeAt: this.tick + (Z.sporeEvery[this.zdi()] || 1e12), born: this.tick });
    this.events.push({ k: kind, x: cx, y: cy, size: hive ? 'hive' : kind === 'outbreak' ? 'small' : kind });
    for (const o of this.players) if (o.alive && !o.isHorde) this.checkDeadByOutbreak(o);
  },
  checkDeadByOutbreak(o) { if (o.tiles.size === 0 && o.spawned) o.conqueredBy = this.horde; },

  // ---- per tick ----
  tickZombies() {
    if (!this.isZombieGame() || this.phase !== 'play') return;
    const z = this.zombie, h = this.horde, d = this.zdi();
    h.gold = 0;
    if (z.phase === 'calm') {
      if (this.tick >= this.spawnTicks + Z.calmTicks[d]) this.startApocalypse();
      return;
    }
    if (z.phase === 'aftermath') { this.tickAftermath(); return; }
    if (z.phase !== 'outbreak') return;
    // the hives: lost ones stop feeding the horde; living ones seed other continents
    for (const hv of z.hives) {
      if (!hv.alive) continue;
      if (this.owner[hv.tile] !== h.smallID) { this.burnHive(hv); continue; }
      if (Z.sporeEvery[d] && this.tick >= hv.sporeAt) { hv.sporeAt = this.tick + Z.sporeEvery[d]; this.spore(hv); }
    }
    // growth, sized to the living, with a soft cap: past it the dead rot faster than they rise
    if (this.tick % 10 === 0) z.W = this.livingStrength();
    const tiles = h.tiles.size, hives = z.hives.filter((x) => x.alive).length;
    const W = z.W || 1;
    const cap = W * Z.capShare[d];
    if (h.troops < cap) h.addTroops(tiles * Z.growthPerTile[d] + W * Z.growthShare[d] * (hives ? 1 : 0.5));
    else h.removeTroops((h.troops - cap) * 0.005);
    for (const [sm, n] of z.noise) { const nn = n * 0.997; if (nn < 1) z.noise.delete(sm); else z.noise.set(sm, nn); }
    if (this.tick % Z.attackEvery[d] === 0) this.hordePush();
    if (this.tick % 20 === 0) this.hordeCreep();
    this.tickWaves();
    if (this.tick >= z.raftAt) { z.raftAt = this.tick + Z.raftEvery[d]; this.hordeRaft(); }
    // the end of the apocalypse: the horde is gone, or the clock ran out
    if (!this.hordeAlive() && !hives) this.endApocalypse('wiped');
    else if (this.tick >= z.endTick) this.endApocalypse('survived');
  },
  startApocalypse() {
    const z = this.zombie, d = this.zdi();
    z.phase = 'outbreak';
    z.outbreakTick = this.tick;
    z.endTick = this.tick + this.zombieSurviveTicks();
    z.waveAt = this.tick + Z.waveEvery[d];
    z.raftAt = this.tick + Z.raftEvery[d];
    z.W = this.livingStrength();
    const sites = this.pickHiveSites(Z.hives[d]);
    const per = Math.max(20000, Math.floor(z.W * Z.startShare[d] / Math.max(1, sites.length)));
    for (const t of sites) this.outbreakAt(t, Z.hiveRadius[d], per, true);
    this.events.push({ k: 'apocalypse', mins: Math.round(this.zombieSurviveTicks() / 600), diff: Z.names[d] });
  },
  burnHive(hv) {
    hv.alive = false;
    const by = this.ownerOf(hv.tile);
    if (by && !by.isHorde) {
      by.samples = (by.samples || 0) + HIVE_REWARD.samples;
      by.addGold(HIVE_REWARD.gold, 'plunder');
    }
    this.events.push({ k: 'hiveBurned', by: by ? by.smallID : 0, x: this.x(hv.tile), y: this.y(hv.tile) });
  },
  // A hive seeds a new, smaller hive on another continent that still has living people on it.
  spore(hv) {
    const masses = new Set(); for (const x of this.zombie.hives) if (x.alive) masses.add(this.landmass[x.tile]);
    const sites = this.pickHiveSites(3, this.zombie.hives.map((x) => x.tile)).filter((t) => !masses.has(this.landmass[t]));
    const t = sites[0] ?? this.pickHiveSites(1, this.zombie.hives.map((x) => x.tile))[0];
    if (t === undefined) return;
    void hv;
    const d = this.zdi();
    this.outbreakAt(t, Math.max(4, Z.hiveRadius[d] - 3), Math.floor(this.horde.troops * 0.05) + 5000, true, 'spore');
  },
  // Who does the horde go for? Noise (bombs, big battles) draws it; so does a long shared border and a thin army.
  hordeTargets() {
    const h = this.horde, z = this.zombie;
    const { players } = this.neighborsOf(h);
    return players.filter((o) => o.alive && !o.isHorde).map((o) => {
      const noise = z.noise.get(o.smallID) || 0;
      const density = o.troops / Math.max(1, o.numTiles);
      return { o, score: (1 + noise / 200) * (o.type === PlayerType.BOT ? 0.6 : 1) / Math.sqrt(density + 5) };
    }).sort((a, b) => b.score - a.score);
  },
  hordePush() {
    const h = this.horde, d = this.zdi();
    if (!this.hordeAlive() || h.troops < 500) return;
    const targets = this.hordeTargets();
    // into the wilderness: the horde fills empty land and so reaches everyone eventually
    if (this.neighborsOf(h).touchesNeutral) this.sendAttack(h, null, Math.min(h.troops * Z.wildShare[d], (this.zombie.W || h.troops) * Z.wildCap[d]));
    // at the living: one main push, and a probe at a second target
    if (targets[0]) this.sendAttack(h, targets[0].o, h.troops * Z.attackShare[d]);
    if (targets[1] && this.rng.chance(2)) this.sendAttack(h, targets[1].o, h.troops * Z.attackShare[d] * 0.4);
  },
  // Infection creeps across the border a tile at a time wherever the living touch zombie land, unless
  // the ground is held: a wall, a defense post nearby, a mech's hold zone, or (cure step 1) a city nearby.
  hordeCreep() {
    const h = this.horde, d = this.zdi();
    if (!this.hordeAlive()) return;
    const b = [0, 0, 0, 0];
    const step = Math.max(1, Math.floor(h.border.size / 700));
    let i = 0;
    const flips = [];
    for (const t of h.border) {
      if (i++ % step) continue;
      const n = this.neighbors4(t, b);
      for (let k = 0; k < n; k++) {
        const nb = b[k];
        const sm = this.owner[nb];
        if (!sm || sm === h.smallID || !this.isLand(nb) || this.wallHp[nb]) continue;
        if (this.rng.next() >= Z.creep[d] * step) continue;
        const o = this.playersBySmall[sm];
        if (this.creepBlocked(o, nb)) continue;
        flips.push([nb, o]);
      }
    }
    for (const [t, o] of flips) {
      o.removeTroops(o.troops / Math.max(1, o.numTiles));
      const u = this.unitAt(t); if (u) this.removeUnit(u);
      this.conquer(h, t);
      this.handleDeadDefender(h, o);
    }
  },
  creepBlocked(o, t) {
    if (this.hasDefensePostNearby(o, t)) return true;
    if (o.mechs.length && this.mechHolding(o, t)) return true;
    if ((o.cureStep || 0) >= 1) {
      const x = this.x(t), y = this.y(t);
      for (const u of o.units) if (u.type === UnitType.CITY && (this.x(u.tile) - x) ** 2 + (this.y(u.tile) - y) ** 2 <= IMMUNE_CITY_RADIUS * IMMUNE_CITY_RADIUS) return true;
    }
    return false;
  },
  // Great waves: announced, then a flood of the dead at one nation. The last one, a minute before the
  // clock runs out, comes from every direction at once.
  tickWaves() {
    const z = this.zombie, h = this.horde, d = this.zdi();
    if (!z.wave && this.tick >= z.waveAt - WARN_TICKS && this.tick < z.endTick - 1200) {
      const t = this.hordeTargets().find((x) => x.o.type !== PlayerType.BOT) || this.hordeTargets()[0];
      if (t) {
        const c = this.centroid(t.o) || { x: 0, y: 0 };
        z.wave = { target: t.o.smallID, at: z.waveAt, x: Math.round(c.x), y: Math.round(c.y) };
        this.events.push({ k: 'waveWarn', p: t.o.smallID, secs: Math.round(WARN_TICKS / 10), x: z.wave.x, y: z.wave.y });
      } else z.waveAt = this.tick + Z.waveEvery[d];
    }
    if (z.wave && this.tick >= z.wave.at) {
      const o = this.playersBySmall[z.wave.target];
      if (o && o.alive && this.hordeAlive()) {
        const bonus = o.troops * Z.waveBonus[d];
        h.addTroops(bonus);
        this.sendAttack(h, o, h.troops * 0.5);
        this.noteNoise(o, 400);
        this.events.push({ k: 'hordeWave', p: o.smallID, troops: Math.round(h.troops * 0.5) });
      }
      z.wave = null;
      z.waveAt = this.tick + Z.waveEvery[d];
    }
    if (!z.finalWave && this.tick >= z.endTick - 600 && this.hordeAlive()) {
      z.finalWave = true;
      const targets = this.hordeTargets();
      for (const t of targets) { h.addTroops(t.o.troops * Z.waveBonus[d] * 0.6); }
      for (const t of targets) this.sendAttack(h, t.o, h.troops / Math.max(1, targets.length) * 0.8);
      this.events.push({ k: 'finalWave' });
    }
  },
  // Rafts: the horde sends the dead across the water at the nearest living coast. Warships sink them.
  hordeRaft() {
    const h = this.horde, d = this.zdi();
    if (!this.hordeAlive() || this.settings.disableBoats || h.troops < 2000) return;
    let src = -1; { let i = 0; for (const t of h.border) { if (i++ % 5) continue; if (this.isOceanShore(t)) { src = t; break; } } }
    if (src < 0) return;
    let best = -1, bd = Infinity;
    for (const o of this.players) {
      if (!o.alive || o.isHorde || o.type === PlayerType.BOT) continue;
      let i = 0;
      for (const t of o.border) {
        if (i++ % 9) continue; if (i > 3000) break;
        if (!this.isOceanShore(t) || this.landmass[t] === this.landmass[src]) continue;
        const dd = this.dist(t, src);
        if (dd < bd) { bd = dd; best = t; }
      }
    }
    if (best < 0 || bd > 350 || this.pathBudget-- <= 0) return;
    const boat = this.sendBoat(h, best, h.troops * Z.raftShare[d], { maxIter: 60000, tries: 2 });
    if (boat) this.events.push({ k: 'raft', x: this.x(best), y: this.y(best), p: this.owner[best] });
  },
  noteNoise(p, n) { if (this.zombie && p && !p.isHorde) this.zombie.noise.set(p.smallID, (this.zombie.noise.get(p.smallID) || 0) + n); },

  // ---- dying fighting the dead ----
  // \`victim\` lost \`n\` troops to the horde (attacking it or defending from it): some of them rise.
  zombieConvert(victim, n) {
    if (!this.zombie || this.zombie.phase !== 'outbreak' || !(n > 0)) return;
    const step = victim.cureStep || 0;
    if (step >= 2) return;
    this.horde.addTroops(n * Z.convert[this.zdi()] * (step >= 1 ? 0.5 : 1));
    if (n > 20000) this.noteNoise(victim, n / 5000);
  },
  // How costly a zombie tile is to take: harder the closer it is to a living hive (the nest is thick with them).
  zombieDefenseMult(tile) {
    let m = Z.defense[this.zdi()];
    if (tile !== undefined && this.zombie) {
      const r = Z.hiveRadius[this.zdi()] + 5, x = this.x(tile), y = this.y(tile);
      for (const hv of this.zombie.hives) if (hv.alive && (this.x(hv.tile) - x) ** 2 + (this.y(hv.tile) - y) ** 2 <= r * r) { m *= Z.hiveGuard; break; }
    }
    return m;
  },
  // Every living nation's and player's troops together (what the horde is measured against).
  livingStrength() {
    let w = 0;
    for (const p of this.players) if (p.alive && !p.isHorde && p.type !== PlayerType.BOT) w += p.troops;
    return w;
  },
  zombieWallMult() { return Z.wallDamage[this.zdi()]; },
  // Taking zombie ground back: salvage and a sample per tile.
  onReclaim(p) {
    p.samples = (p.samples || 0) + 1;
    p.addGold(SALVAGE_GOLD, 'plunder');
  },
  // Ships leaving near zombie land may carry the infection with them.
  hordeNear(tile, r) {
    if (!this.hordeAlive() || !this.zombie || this.zombie.phase !== 'outbreak') return false;
    const x = this.x(tile), y = this.y(tile), h = this.horde.smallID;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      for (const rr of [r * 0.4, r * 0.75, r]) {
        const tx = Math.round(x + Math.cos(a) * rr), ty = Math.round(y + Math.sin(a) * rr);
        if (this.valid(tx, ty) && this.owner[this.ref(tx, ty)] === h) return true;
      }
    }
    return false;
  },
  maybeInfectShip(ship, fromTile, r) {
    if (!this.isZombieGame() || ship.owner.isHorde) return;
    if (this.hordeNear(fromTile, r) && this.rng.next() < Z.infectShip[this.zdi()]) ship.infected = true;
  },
  shipLanded(ship, tile) {
    if (!ship.infected || !this.zombie || this.zombie.phase !== 'outbreak') return;
    this.outbreakAt(tile, 3, Math.floor((ship.troops || 20000) * 0.4) + 3000, false, 'shipOutbreak');
  },

  // ---- the cure ----
  cureInfo(p) {
    const step = (p.cureStep || 0) + 1;
    if (step > 3) return { ok: false, reason: 'The cure is done' };
    return { step, name: CURE_NAMES[step], samples: Math.ceil(this.numLand * CURE_SAMPLES[step]), ticks: CURE_BASE_TICKS[step] };
  },
  canStartCure(p) {
    if (!this.isZombieGame()) return { ok: false, reason: 'There is no plague in this game' };
    if (!this.zombie || this.zombie.phase !== 'outbreak') return { ok: false, reason: this.zombie && this.zombie.phase === 'calm' ? 'Nothing to cure yet' : 'The plague is over' };
    if (p.cure) return { ok: false, reason: 'Already researching the cure' };
    const info = this.cureInfo(p);
    if (!info.step || info.ok === false) return info;
    const labs = p.completedUnitsOf(UnitType.LAB);
    if (!labs.length) return { ok: false, reason: 'The cure needs a Research Lab' };
    if ((p.samples || 0) < info.samples) return { ok: false, reason: `Cure step ${info.step} needs ${info.samples} samples - take back zombie land (you have ${p.samples || 0})` };
    labs.sort((a, b) => b.level - a.level);
    return { ok: true, info, lab: labs[0] };
  },
  startCure(p) {
    const c = this.canStartCure(p);
    if (!c.ok) return c;
    const ticks = Math.round(c.info.ticks * Z.cureTime[this.zdi()] * this.config.labSpeedMultiplier(c.lab.level));
    p.cure = { step: c.info.step, startTick: this.tick, doneTick: this.tick + ticks, labId: c.lab.id };
    this.events.push({ k: 'cureStart', p: p.smallID, step: c.info.step });
    return { ok: true };
  },
  tickCure() {
    if (!this.isZombieGame()) return;
    for (const p of this.players) {
      if (!p.cure) continue;
      if (!p.alive || !this.units.some((u) => u.id === p.cure.labId && u.owner === p)) { this.events.push({ k: 'cureLost', p: p.smallID }); p.cure = null; continue; }
      if (this.tick < p.cure.doneTick) continue;
      p.cureStep = p.cure.step;
      p.cure = null;
      this.events.push({ k: 'cureStep', p: p.smallID, step: p.cureStep });
      if (p.cureStep >= 3 && this.zombie.phase === 'outbreak') { this.zombie.curedBy = p; this.endApocalypse('cured'); }
    }
  },
  curePacket(p) { return [p.samples || 0, p.cureStep || 0, p.cure ? [p.cure.step, Math.max(0, p.cure.doneTick - this.tick), p.cure.doneTick - p.cure.startTick] : null]; },

  // ---- the end ----
  endApocalypse(how) {
    const z = this.zombie;
    if (z.phase !== 'outbreak') return;
    z.phase = 'aftermath';
    z.how = how;
    z.aftermathEnd = this.tick + AFTERMATH_TICKS;
    z.rotEnd = this.tick + ROT_TICKS;
    z.survivors = this.players.filter((p) => p.alive && !p.isHorde && p.type !== PlayerType.BOT).map((p) => p.smallID);
    for (const a of this.attacks) if (a.attacker === this.horde) a.done = true;
    for (const b of this.boats) if (b.owner === this.horde) b.done = true;
    for (const hv of z.hives) hv.alive = false;
    this.events.push({ k: how === 'cured' ? 'cured' : how === 'wiped' ? 'hordeWiped' : 'survivedPlague', p: z.curedBy ? z.curedBy.smallID : 0, survivors: z.survivors.length });
    // the dead stop coming back for anyone
    for (const p of this.players) if (!p.isHorde) p.cureStep = Math.max(p.cureStep || 0, 2);
  },
  // Zombie land rots back to empty ground over a minute, then the survivors have a few minutes to grab
  // what they can before the final count.
  tickAftermath() {
    const z = this.zombie, h = this.horde;
    if (h.tiles.size) {
      const left = Math.max(1, Math.ceil((z.rotEnd - this.tick) / 10));
      if (this.tick % 10 === 0) {
        let quota = Math.ceil(h.tiles.size / left);
        for (const t of [...h.border]) { if (quota-- <= 0) break; this.relinquish(t); }
      }
      h.troops = Math.max(0, h.troops * 0.97);
    }
    if (this.tick >= z.aftermathEnd) this.finishZombieGame();
  },
  // Strength of a survivor: land first, then army, treasury, buildings, and what it did against the plague.
  survivorScore(p) {
    const land = p.tiles.size / Math.max(1, this.numLand) * 10000;
    let build = 0; for (const u of p.units) build += (u.level || 1) * 25;
    const cure = (p.cureStep || 0) * 150 + (this.zombie.curedBy === p ? 1500 : 0);
    return Math.round(land + p.troops / 1000 + p.gold / 10000 + build + cure + (p.samples || 0) / 5);
  },
  finishZombieGame() {
    const z = this.zombie;
    const alive = this.players.filter((p) => p.alive && !p.isHorde && p.type !== PlayerType.BOT);
    const survivors = alive.filter((p) => z.survivors.includes(p.smallID));
    const ranked = survivors.map((p) => ({ p, score: this.survivorScore(p) })).sort((a, b) => b.score - a.score);
    z.result = ranked.map((r) => [r.p.smallID, r.score]);
    z.phase = 'over';
    this.phase = 'over';
    this.winner = ranked.length ? ranked[0].p : this.horde;
    this.winnerTeam = 0;
    this.winTick = this.tick;
    this.events.push({ k: 'win', p: this.winner.smallID, zombie: true, result: z.result });
  },
  // If every living nation falls, the dead inherit the earth.
  checkZombieDefeat() {
    const z = this.zombie;
    if (!z || z.phase !== 'outbreak') return;
    const living = this.players.filter((p) => p.alive && !p.isHorde && p.type !== PlayerType.BOT);
    if (living.length) return;
    z.result = [];
    z.phase = 'over';
    this.phase = 'over';
    this.winner = this.horde;
    this.winTick = this.tick;
    this.events.push({ k: 'win', p: this.horde.smallID, zombie: true, result: [] });
  },
  zombiePacket() {
    const z = this.zombie;
    if (!z) return null;
    const hives = z.hives.filter((h) => h.alive).map((h) => h.tile);
    const next = z.phase === 'calm' ? this.spawnTicks + Z.calmTicks[this.zdi()] - this.tick : z.phase === 'outbreak' ? z.endTick - this.tick : z.phase === 'aftermath' ? z.aftermathEnd - this.tick : 0;
    return [z.phase, Math.max(0, next), this.horde ? this.horde.smallID : 0, hives, z.wave ? [z.wave.target, Math.max(0, z.wave.at - this.tick), z.wave.x, z.wave.y] : null, z.result, Z.names[this.zdi()], z.how || ''];
  },
  zombieCureNames() { return CURE_NAMES; },
};
module.exports.ZOMBIE_TUNING = Z;
