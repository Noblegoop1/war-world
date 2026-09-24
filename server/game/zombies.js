'use strict';
// Zombie mode: "the dead rise".
//
// What it borrows, and from where:
//   * patient-zero hives in the wilderness that keep feeding the horde and seed new ones elsewhere
//     (Warcraft III zombie maps' virus pools, Plague Inc's patient zero)
//   * great waves announced before they hit, and a final wave from every direction as the clock runs
//     out (They Are Billions' swarms and its "THEY ARE BILLIONS!!" finale); noise - bombs and big
//     battles - draws the horde's attention (They Are Billions)
//   * spore clouds that drift across the sea to seed new hives, and that anti-air can shoot down
//     (the fungal / airborne spread of parasite games, instead of infected ships)
//   * scavenging the infected land: every tile taken back pays salvage and yields samples the cure
//     needs (Infection Free Zone's expeditions)
//
// The horde is a parasite (a player of its own, type 'zombie'): its land is zombie land, its troops
// are the dead.
//   * It feeds on its hosts: while it touches living nations that aren't immune it grows by 0.5% of
//     itself every second; cut off from hosts it starves. It can never outgrow the living (a cap sized
//     to every living army together).
//   * Fighting it works - an attack does push it back - but three quarters of the troops you lose doing
//     it get up again as zombies. Troops it kills on your land rise too (a smaller share). Bombs are the
//     clean answer: nukes and bomber strikes kill the dead without feeding it - but every one enrages
//     it, a stacking bonus to its attacks that fades slowly.
//   * Its infection creeps across borders a few tiles at a time; walls, defense posts, a mech's hold
//     zone and the cure stop the creep. Zombies are ten times weaker against walls than troops are.
//   * Across the sea it travels as spore clouds from its hives: slow, visible, and SAMs (and airborne
//     mechs) shoot them down. A cloud that lands grows a new hive.
//
// Phases: calm (a minute or three to expand) -> outbreak -> aftermath (the horde is wiped out or the
// clock ran out: its land rots back to empty ground for a last land rush) -> over. Two results: every
// nation still standing survived; the strongest survivor wins outright.
//
// The cure is per nation, not a switch for the world: three quick steps in your labs (steps 2 and 3 need
// samples). Each step means fewer of your dead rise and more of your land holds against the creep; the
// last one makes a nation immune - the parasite can't feed on it, its dead stay dead, the creep can't touch
// it. A world where every survivor is immune starves the horde out.
// Mixed into Game.prototype.
const { PlayerType, UnitType } = require('./config');

// easy (Shamblers) -> medium (Outbreak) -> hard (Pandemic) -> nightmare (Extinction)
const Z = {
  names: ['Shamblers', 'Outbreak', 'Pandemic', 'Extinction'],
  calmTicks: [1800, 1500, 1200, 900],           // after the spawn phase, before the dead rise (3, 2.5, 2, 1.5 min)
  hives: [2, 3, 4, 5],
  hiveRadius: [6, 7, 8, 9],
  // The horde is sized against the living: W = every living nation's and player's troops together.
  startShare: [0.5, 0.7, 0.9, 1.15],            // the horde at the outbreak, x W
  feed: [0.004, 0.005, 0.0055, 0.0065],         // growth per second, x its own size (0.5% on Outbreak)
  hungry: 0.5,                                  // ...at this share while it touches no host at all
  hiveFeed: 0.002,                              // each living hive adds this much growth per second
  holdDensity: [150, 130, 110, 90],             // it only pushes into empty land while it has this many dead per tile
  capShare: [0.6, 0.9, 1.1, 1.4],               // it can never outgrow the living: cap, x W
  hiveGuard: 3,                               // ground near a living hive is this much harder to take
  attackerRise: 0.75,                           // share of troops lost attacking it that rise as zombies
  convert: [0.25, 0.35, 0.45, 0.55],            // share of troops it kills on your land that rise
  attackEvery: [100, 80, 70, 60],
  attackShare: [0.07, 0.09, 0.11, 0.13],
  wildShare: [0.04, 0.05, 0.06, 0.07],          // share sent into empty land each push...
  wildCap: [0.02, 0.03, 0.035, 0.045],          // ...but never more than this x W, so the wilds fill at a walk, not a sprint
  creep: [0.004, 0.007, 0.009, 0.013],          // chance per contact tile per 2s
  waveEvery: [4200, 3600, 3000, 2400],          // great waves (7, 6, 5, 4 min)
  waveBonus: [0.3, 0.45, 0.6, 0.8],             // extra dead a wave brings, x its target's army
  sporeEvery: [4800, 3600, 3000, 2400],         // each living hive releases a spore cloud this often
  orphanSporeEvery: [0, 6000, 4800, 3600],      // with no hive left, the horde itself does (0 = never)
  sporeShare: [0.03, 0.04, 0.05, 0.06],         // share of the horde a cloud carries
  surviveMin: [25, 30, 35, 40],
  wallDamage: [0.1, 0.1, 0.1, 0.1],             // zombies against walls: ten times weaker than troops
  defense: [1.6, 2, 2.4, 2.8],                  // how costly zombie ground is to take
  cureTime: [0.8, 1, 1.1, 1.2],
};
const WARN_TICKS = 300;                  // a great wave is announced 30s before it breaks
const AFTERMATH_TICKS = 3000;            // 5 minutes of land rush once the horde is gone
const ROT_TICKS = 600;                   // zombie land rots away over a minute after the cure
const CURE_BASE_TICKS = [0, 1200, 1800, 2400];   // cure steps: 2, 3, 4 minutes at a level-1 lab
const CURE_SAMPLES = [0, 0, 0.0006, 0.002];      // samples needed, as a share of the land
const KILLS_PER_SAMPLE = 3000;                   // zombies killed (defending, attacking or bombing) per sample
const CURE_RISE = [1, 0.75, 0.5, 0];             // share of the usual dead that still rise, by cure step
const CURE_ATTACK_LOSS = [1, 1, 0.8, 0.6];       // your losses attacking the horde, by cure step
const SPORE_SPEED = 0.5;                         // tiles per tick
const RAGE_DECAY_TICKS = 900;                    // one stack of rage fades every 90 seconds
const RAGE_MAX = 12;
const SALVAGE_GOLD = 120;                // gold per zombie tile taken back
const HIVE_REWARD = { samples: 150, gold: 400000 };
const IMMUNE_CITY_RADIUS = 15;           // cure step 1: creep can't take ground this close to your cities
const CURE_NAMES = ['', 'Isolate the Strain', 'Vaccine Trials', 'Immunity'];

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
    this.zombie = { phase: 'calm', outbreakTick: 0, endTick: 0, waveAt: 0, wave: null, finalWave: false, aftermathEnd: 0, rotEnd: 0, hives: [], result: null, noise: new Map(), rage: 0, rageAt: 0, orphanSporeAt: 0 };
    this.spores = [];
  },
  hordeAlive() { return !!(this.horde && this.horde.tiles.size > 0); },

  // ---- the outbreak ----
  // Hives open on the continents people live on: in the wilds (empty land or a tribe's) if there is any,
  // otherwise deep in a nation's hinterland, far from its capital - patient zero. Spread over those
  // continents, never on a lonely islet where the dead would have nobody to reach.
  pickHiveSites(count, avoid = []) {
    const living = this.players.filter((p) => p.alive && !p.isHorde && p.type !== PlayerType.BOT);
    if (!this.landmassSize) { this.landmassSize = new Map(); for (let t = 0; t < this.landmass.length; t++) { const m = this.landmass[t]; if (m >= 0) this.landmassSize.set(m, (this.landmassSize.get(m) || 0) + 1); } }
    const peopled = new Set();
    for (const p of living) { let i = 0; for (const t of p.border) { if (i++ > 60) break; peopled.add(this.landmass[t]); } }
    const minMass = Math.max(300, this.numLand * 0.004);
    const open = (t) => { const o = this.owner[t]; return o === 0 || this.playersBySmall[o].type === PlayerType.BOT; };
    const collect = (requirePeople) => {
      const out = [];
      for (let k = 0; k < 6000; k++) {
        const t = this.rng.int(0, this.terrain.length - 1);
        if (!this.isLand(t) || this.owner[t] === (this.horde ? this.horde.smallID : -1)) continue;
        const m = this.landmass[t];
        if ((this.landmassSize.get(m) || 0) < minMass || (requirePeople && !peopled.has(m))) continue;
        let dmin = Infinity;
        for (const p of living) { const c = p.spawnTile ?? -1; if (c >= 0) dmin = Math.min(dmin, this.dist(c, t)); }
        if (dmin < 30) continue;
        out.push({ t, m, score: Math.min(dmin, 150) + (this.owner[t] === 0 ? 40 : open(t) ? 25 : 0) + this.rng.next() * 15 });
      }
      return out.sort((x, y) => y.score - x.score);
    };
    let cands = collect(true);
    if (cands.length < count) cands = cands.concat(collect(false));
    const sites = [];
    const minApart = Math.max(30, Math.hypot(this.width, this.height) / (count * 3));
    const perMass = new Map();
    for (const pass of [1, 2, 99]) {   // one per continent first, then two, then wherever there is room
      for (const c of cands) {
        if (sites.length >= count) break;
        if ((perMass.get(c.m) || 0) >= pass || [...sites, ...avoid].some((x) => this.dist(x, c.t) < minApart)) continue;
        sites.push(c.t); perMass.set(c.m, (perMass.get(c.m) || 0) + 1);
      }
    }
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
    if (hive) this.zombie.hives.push({ tile, alive: true, sporeAt: this.tick + Z.sporeEvery[this.zdi()], born: this.tick });
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
    // the hives: lost ones are burned; living ones release spore clouds across the sea
    for (const hv of z.hives) {
      if (!hv.alive) continue;
      if (this.owner[hv.tile] !== h.smallID) { this.burnHive(hv); continue; }
      if (this.tick >= hv.sporeAt) { hv.sporeAt = this.tick + Z.sporeEvery[d]; this.releaseSpore(hv.tile); }
    }
    const hives = z.hives.filter((x) => x.alive).length;
    if (!hives && Z.orphanSporeEvery[d] && this.hordeAlive() && this.tick >= z.orphanSporeAt) {
      z.orphanSporeAt = this.tick + Z.orphanSporeEvery[d];
      const b = [...h.border]; if (b.length) this.releaseSpore(b[this.rng.int(0, b.length - 1)]);
    }
    this.tickSpores();
    // the parasite: it feeds on the hosts it touches, starves without them, never outgrows the living
    if (this.tick % 10 === 0) {
      z.W = this.livingStrength();
      const cap = z.W * Z.capShare[d];
      const hosts = this.hordeAlive() ? this.neighborsOf(h).players.filter((o) => o.alive && !o.isHorde && (o.cureStep || 0) < 3) : [];
      z.feeding = hosts.length > 0;
      if (h.troops > cap) h.removeTroops((h.troops - cap) * 0.05);
      else h.addTroops(Math.min(cap - h.troops, h.troops * (Z.feed[d] * (z.feeding ? 1 : Z.hungry) + hives * Z.hiveFeed)));
    }
    // rage from being bombed fades
    if (z.rage > 0 && this.tick >= z.rageAt) { z.rage = Math.max(0, z.rage - 1); z.rageAt = this.tick + RAGE_DECAY_TICKS; }
    for (const [sm, n] of z.noise) { const nn = n * 0.997; if (nn < 1) z.noise.delete(sm); else z.noise.set(sm, nn); }
    if (this.tick % Z.attackEvery[d] === 0) this.hordePush();
    if (this.tick % 20 === 0) this.hordeCreep();
    this.tickWaves();
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
    z.W = this.livingStrength();
    z.orphanSporeAt = this.tick + (Z.orphanSporeEvery[d] || 1e12);
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
  // A spore cloud: released from a hive, it drifts slowly across the sea toward living people on another
  // continent (the nearest, or the noisiest). Where it lands a new hive grows. SAMs and airborne mechs
  // shoot clouds down, so anti-air is how you keep the plague off your shores.
  releaseSpore(fromTile) {
    const h = this.horde, d = this.zdi();
    if (!h || h.troops < 5000) return;
    const src = this.landmass[fromTile], sx = this.x(fromTile), sy = this.y(fromTile);
    let best = null, bestScore = -Infinity;
    for (const o of this.players) {
      if (!o.alive || o.isHorde || o.type === PlayerType.BOT || (o.cureStep || 0) >= 3) continue;
      let i = 0, near = -1, nd = Infinity;
      for (const t of o.tiles) { if (i++ % 23) continue; if (i > 6000) break; if (this.landmass[t] === src) continue; const dd = Math.hypot(this.x(t) - sx, this.y(t) - sy); if (dd < nd) { nd = dd; near = t; } }
      if (near < 0) continue;
      const score = -nd + (this.zombie.noise.get(o.smallID) || 0) * 0.2;
      if (score > bestScore) { bestScore = score; best = { o, t: near }; }
    }
    if (!best) return;
    const troops = Math.floor(h.removeTroops(h.troops * Z.sporeShare[d]));
    const cloud = { id: this.nextSporeId = (this.nextSporeId || 0) + 1, x: sx + 0.5, y: sy + 0.5, tx: this.x(best.t) + 0.5, ty: this.y(best.t) + 0.5, tile: best.t, target: best.o.smallID, troops, done: false };
    this.spores.push(cloud);
    this.events.push({ k: 'sporeCloud', x: sx, y: sy, tx: this.x(best.t), ty: this.y(best.t), p: best.o.smallID });
  },
  tickSpores() {
    if (!this.spores.length) return;
    for (const c of this.spores) {
      if (c.done) continue;
      // anti-air: a ready SAM in range (or an airborne mech) shoots the cloud down
      let shot = null;
      for (const u of this.units) {
        if (u.type !== UnitType.SAM || u.constructionLeft > 0 || u.cooldown > 0 || u.owner.isHorde) continue;
        const r = this.config.samRange(u.owner);
        if ((this.x(u.tile) - c.x) ** 2 + (this.y(u.tile) - c.y) ** 2 <= r * r) { u.cooldown = this.config.samCooldownTicks(); this.unitsChanged = true; shot = u.owner; break; }
      }
      if (!shot) for (const m of this.mechs) if (!m.done && !m.owner.isHorde && m.owner.researches.has('airborne_mechs') && Math.hypot(m.x - c.x, m.y - c.y) <= m.range * 1.5) { shot = m.owner; break; }
      if (shot) { c.done = true; this.events.push({ k: 'sporeDown', by: shot.smallID, x: c.x, y: c.y }); continue; }
      const dx = c.tx - c.x, dy = c.ty - c.y, dist = Math.hypot(dx, dy);
      if (dist <= SPORE_SPEED) {
        c.done = true;
        if (this.zombie.phase === 'outbreak' && !this.wallHp[c.tile]) this.outbreakAt(c.tile, 4, c.troops, true, 'sporeLanding');
        continue;
      }
      c.x += (dx / dist) * SPORE_SPEED; c.y += (dy / dist) * SPORE_SPEED;
    }
    this.spores = this.spores.filter((c) => !c.done);
  },
  sporesPacket() { return (this.spores || []).map((c) => [c.id, Math.round(c.x * 10) / 10, Math.round(c.y * 10) / 10, Math.round(c.tx), Math.round(c.ty), c.target, Math.floor(c.troops)]); },
  // ---- rage: bombs kill the dead cleanly, but every one makes the rest angrier ----
  enrage(amount) {
    const z = this.zombie;
    if (!z || z.phase !== 'outbreak') return;
    z.rage = Math.min(RAGE_MAX, z.rage + amount);
    z.rageAt = this.tick + RAGE_DECAY_TICKS;
    this.events.push({ k: 'hordeRage', rage: Math.round(z.rage * 10) / 10 });
  },
  // The horde's attacks lose fewer and move faster the angrier it is.
  hordeRageLoss() { return this.zombie ? 1 / (1 + 0.08 * this.zombie.rage) : 1; },
  hordeRageSpeed() { return this.zombie ? 1 + 0.04 * this.zombie.rage : 1; },
  // A nuke on zombie land: kills a share of the horde by how much of it the blast covered - none of them rise.
  nukeHorde(tilesHit, type, by = null) {
    const h = this.horde;
    const share = tilesHit / Math.max(1, h.tiles.size + tilesHit);
    const cap = type === 'hydrogen' ? 0.2 : type === 'bomblet' ? 0.015 : 0.1;
    const killed = h.troops * Math.min(cap, share * 1.5 + (type === 'bomblet' ? 0.003 : 0.02));
    h.removeTroops(killed);
    this.sampleKills(by, killed);
    this.enrage(type === 'hydrogen' ? 3 : type === 'bomblet' ? 0.3 : 1.5);
    return killed;
  },
  // A bomber strike on zombie land: burns a patch clean and kills a slice of the horde.
  bombHorde(by, tile) {
    const h = this.horde;
    h.removeTroops(h.troops * 0.025);
    const cx = this.x(tile), cy = this.y(tile);
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      if (dx * dx + dy * dy > 16 || !this.valid(cx + dx, cy + dy)) continue;
      const t = this.ref(cx + dx, cy + dy);
      if (this.owner[t] === h.smallID) this.relinquish(t);
    }
    this.enrage(0.5);
    this.events.push({ k: 'shellHit', x: cx, y: cy, by: by.smallID, cause: 'bomb' });
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
    if (h.troops / Math.max(1, h.tiles.size) > Z.holdDensity[d] && this.neighborsOf(h).touchesNeutral) this.sendAttack(h, null, Math.min(h.troops * Z.wildShare[d], (this.zombie.W || h.troops) * Z.wildCap[d]));
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
    const rage = this.zombie.rage;
    for (const [t, o] of flips) {
      if (rage > 0 && this.rng.next() < 0.5 / (1 + 0.1 * rage)) continue;   // calm hordes creep slower
      o.removeTroops(o.troops / Math.max(1, o.numTiles));
      const u = this.unitAt(t); if (u) this.removeUnit(u);
      this.conquer(h, t);
      this.handleDeadDefender(h, o);
    }
  },
  creepBlocked(o, t) {
    if ((o.cureStep || 0) >= 3) return true;   // immune
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
  noteNoise(p, n) { if (this.zombie && p && !p.isHorde) this.zombie.noise.set(p.smallID, (this.zombie.noise.get(p.smallID) || 0) + n); },

  // ---- dying fighting the dead ----
  // \`victim\` lost \`n\` troops to the horde (attacking it or defending from it): some of them rise.
  // `attacking`: the victim lost them attacking the horde (three quarters rise); otherwise the horde
  // killed them on the victim's own land (a difficulty-set share rises). The cure cuts both.
  zombieConvert(victim, n, attacking = false) {
    if (!this.zombie || this.zombie.phase !== 'outbreak' || !(n > 0)) return;
    const rise = (attacking ? Z.attackerRise : Z.convert[this.zdi()]) * CURE_RISE[Math.min(3, victim.cureStep || 0)];
    if (rise > 0) this.horde.addTroops(n * rise);
    if (n > 20000) this.noteNoise(victim, n / 5000);
  },
  // Killing the dead - on your walls, in your attacks, with your bombs - yields samples for the cure.
  sampleKills(p, killed) { if (p && !p.isHorde && killed > 0) p.samples = (p.samples || 0) + killed / KILLS_PER_SAMPLE; },
  cureAttackLoss(p) { return CURE_ATTACK_LOSS[Math.min(3, p.cureStep || 0)]; },
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
    if ((p.samples || 0) < info.samples) return { ok: false, reason: `Cure step ${info.step} needs ${info.samples} samples - kill zombies or take back their land (you have ${Math.floor(p.samples || 0)})` };
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
      if (p.cureStep >= 3) this.events.push({ k: 'immune', p: p.smallID });
    }
  },
  curePacket(p) {
    const next = Math.min(3, (p.cureStep || 0) + 1);
    return [Math.floor(p.samples || 0), p.cureStep || 0, p.cure ? [p.cure.step, Math.max(0, p.cure.doneTick - this.tick), p.cure.doneTick - p.cure.startTick] : null, Math.ceil(this.numLand * CURE_SAMPLES[next])];
  },

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
    this.spores = [];
    this.events.push({ k: how === 'wiped' ? 'hordeWiped' : 'survivedPlague', p: 0, survivors: z.survivors.length });
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
    const cure = (p.cureStep || 0) * 200 + ((p.cureStep || 0) >= 3 ? 600 : 0);
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
    return [z.phase, Math.max(0, next), this.horde ? this.horde.smallID : 0, hives, z.wave ? [z.wave.target, Math.max(0, z.wave.at - this.tick), z.wave.x, z.wave.y] : null, z.result, Z.names[this.zdi()], z.how || '', Math.round(z.rage * 10) / 10, z.feeding ? 1 : 0];
  },
  zombieCureNames() { return CURE_NAMES; },
};
module.exports.ZOMBIE_TUNING = Z;
