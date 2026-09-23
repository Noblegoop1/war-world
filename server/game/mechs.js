'use strict';
// Mechs: national-scale walking artillery. Built at a level-2+ Factory (higher level = more HP and range), then
// ordered to a patrol point like a warship. They hold and circle that spot, shelling hostile structures, mechs,
// ships (if amphibious) and land within range, and stomp the ground around them. Land hit by a mech is NOT
// claimed — it becomes empty land for troops to take. Mechs are slow, land-locked (Amphibious doctrine allows
// water), super tanky, and bleed HP while standing in hostile territory.
//
// Each mech runs one of four standing orders (`mode`):
//   hold    - sit on the patrol point it was given and circle it (the default, what a click sets)
//   roam    - walk its owner's border, favouring the stretch closest to trouble
//   defend  - answer incoming attacks: nearest first, then whichever is throwing the most troops
//   assault - march into one named nation and keep wrecking whatever is in range
// A mech also anchors ground: attacks near one bleed 3x troops and crawl at half speed (see config
// mechAuraRange / mechDefenseBonus). Mixed into Game.prototype.
const { UnitType, PlayerType, within } = require('./config');
const MECH_MODES = ['hold', 'roam', 'defend', 'assault'];
const REORDER_INTERVAL = 40;   // ticks between standing-order re-evaluations
const { newId } = require('./ids');
const { astar, resamplePath } = require('./path');
const R = require('./research').effects;

module.exports = {
  mechFactories(p) { return p.completedUnitsOf(UnitType.FACTORY).filter((f) => f.level >= this.config.mechFactoryLevelRequired()); },
  canBuildMech(p, targetTile, fromTile = -1) {
    if (!p.alive) return { ok: false, reason: 'dead' };
    const amph = R.mechAmphibious(p);
    if (!this.isLand(targetTile) && !(amph && this.isWater(targetTile))) return { ok: false, reason: amph ? 'Pick a land or water tile' : 'Mechs are land-locked: pick a land tile' };
    const facs = this.mechFactories(p);
    if (!facs.length) return { ok: false, reason: 'Mechs need a level-2 Factory (build a Factory, then build on it again to upgrade)' };
    if (p.mechs.filter((m) => !m.done).length >= R.mechCap(p)) return { ok: false, reason: `Mech limit reached (${R.mechCap(p)})` };
    const cost = this.config.unitCost(UnitType.MECH, p.mechs.length, p);
    if (p.gold < cost) return { ok: false, reason: `Not enough gold (need ${Math.floor(cost).toLocaleString()})` };
    let factory = fromTile >= 0 ? facs.find((f) => f.tile === fromTile) : null;
    if (!factory) { facs.sort((a, b) => b.level - a.level || this.dist(a.tile, targetTile) - this.dist(b.tile, targetTile)); factory = facs[0]; }
    return { ok: true, cost, factory };
  },
  buildMech(p, targetTile, fromTile = -1) {
    const c = this.canBuildMech(p, targetTile, fromTile);
    if (!c.ok) return c;
    p.removeGold(c.cost);
    const lvl = c.factory.level;
    const hp = this.config.mechBaseHp(p, lvl);
    const m = { id: newId(), owner: p, level: lvl, x: this.x(c.factory.tile) + 0.5, y: this.y(c.factory.tile) + 0.5, hp, maxHp: hp, range: this.config.mechRange(p, lvl),
      patrol: targetTile, pts: [], idx: 0, wanderAt: 0, cannonReady: this.tick + 20, stompReady: this.tick + 10, engaged: false, engagedUntil: 0, onWater: false, done: false,
      mode: 'hold', orderTarget: 0, reorderAt: 0 };
    p.mechs.push(m);
    this.mechs.push(m);
    this.mechPathTo(m, targetTile);
    this.events.push({ k: 'mech', by: p.smallID });
    return c;
  },
  moveMech(p, id, tile) {
    const m = this.mechs.find((x) => x.id === id && x.owner === p && !x.done);
    if (!m) return { ok: false, reason: 'No such mech' };
    if (!this.isLand(tile) && !(R.mechAmphibious(p) && this.isWater(tile))) return { ok: false, reason: R.mechAmphibious(p) ? 'Pick a land or water tile' : 'Mechs are land-locked' };
    m.patrol = tile;
    m.mode = 'hold';
    this.mechPathTo(m, tile);
    return { ok: true };
  },
  // Standing orders. `targetSm` only matters for 'assault' and must be a nation we may attack.
  setMechMode(p, id, mode, targetSm = 0) {
    if (!MECH_MODES.includes(mode)) return { ok: false, reason: 'Unknown mech order' };
    const mechs = id > 0 ? this.mechs.filter((x) => x.id === id && x.owner === p && !x.done) : p.mechs.filter((x) => !x.done);
    if (!mechs.length) return { ok: false, reason: 'No such mech' };
    let target = 0;
    if (mode === 'assault') {
      const o = this.playersBySmall[targetSm];
      if (!o || o === p || !o.alive) return { ok: false, reason: 'Pick a nation to assault' };
      if (p.isFriendly(o)) return { ok: false, reason: `You are allied with ${o.name}` };
      target = targetSm;
    }
    for (const m of mechs) { m.mode = mode; m.orderTarget = target; m.reorderAt = 0; }
    return { ok: true, count: mechs.length, mode, target };
  },
  // Where should a mech be standing right now, given its orders? Returns a tile or -1 to stay put.
  mechOrderTile(m) {
    const p = m.owner;
    switch (m.mode) {
      case 'roam': {
        // walk the border, preferring the stretch nearest a hostile neighbour
        if (!p.border.size) return -1;
        let best = -1, bestScore = -Infinity;
        let n = 0;
        for (const t of p.border) {
          if (n++ % Math.max(1, Math.floor(p.border.size / 60)) !== 0) continue;
          const d = Math.hypot(this.x(t) - m.x, this.y(t) - m.y);
          let threat = 0;
          const c = this.neighbors4(t, this.nbufA);
          for (let k = 0; k < c; k++) { const o = this.owner[this.nbufA[k]]; if (o && o !== p.smallID) { threat = 1; break; } }
          // near > far, contested > quiet, plus a little noise so several mechs don't stack up
          const score = threat * 60 - d + this.rng.int(0, 25);
          if (score > bestScore) { bestScore = score; best = t; }
        }
        return best;
      }
      case 'defend': {
        const live = p.incomingAttacks.filter((a) => !a.done && a.troops > 0);
        if (!live.length) return -1;
        // nearest first, then whoever is committing the most troops
        let best = null, bestScore = -Infinity;
        for (const a of live) {
          if (a.markX < 0) continue;
          const d = Math.hypot(a.markX - m.x, a.markY - m.y);
          const score = Math.sqrt(a.troops) - d * 2;
          if (score > bestScore) { bestScore = score; best = a; }
        }
        if (!best) return -1;
        const t = this.ref(Math.round(within(best.markX, 0, this.width - 1)), Math.round(within(best.markY, 0, this.height - 1)));
        return this.isLand(t) ? t : -1;
      }
      case 'assault': {
        const o = this.playersBySmall[m.orderTarget];
        if (!o || !o.alive || p.isFriendly(o)) { m.mode = 'roam'; return -1; }
        // head for their nearest border tile, so the mech chews the edge rather than diving into the middle
        let best = -1, bd = Infinity;
        let n = 0;
        for (const t of o.border) {
          if (n++ % Math.max(1, Math.floor(o.border.size / 80)) !== 0) continue;
          const d = (this.x(t) - m.x) ** 2 + (this.y(t) - m.y) ** 2;
          if (d < bd) { bd = d; best = t; }
        }
        return best;
      }
      default: return -1;
    }
  },
  mechCost(p) { const amph = R.mechAmphibious(p); return (t) => (this.isLand(t) ? (this.wallHp[t] && this.owner[t] !== p.smallID ? 3 : 1) : amph && this.isWater(t) ? 2.5 : 0); },
  mechPathTo(m, tile) {
    const path = astar(this, [this.tileAt(m.x, m.y)], tile, this.mechCost(m.owner), { maxIter: 150000 });
    if (path && path.length > 1) { m.pts = resamplePath(this, path, 1); m.idx = 0; }
    else { m.pts = []; m.idx = 0; }
  },
  mechAtTile(tile) {
    const x = this.x(tile), y = this.y(tile);
    for (const m of this.mechs) if (!m.done && Math.floor(m.x) === x && Math.floor(m.y) === y) return m;
    return null;
  },
  tickMechs() {
    if (!this.mechs.length) return;
    const cfg = this.config;
    for (const m of this.mechs) {
      if (m.done) continue;
      const p = m.owner;
      if (!p.alive) { m.done = true; continue; }
      if (m.hp <= 0) { m.done = true; this.events.push({ k: 'mechLost', p: p.smallID, x: m.x, y: m.y }); continue; }
      const here = this.tileAt(m.x, m.y);
      m.onWater = this.isWater(here);
      // ---- standing orders: re-aim the patrol point periodically ----
      if (m.mode !== 'hold' && this.tick >= m.reorderAt) {
        m.reorderAt = this.tick + REORDER_INTERVAL + this.rng.int(0, 20);
        const want = this.mechOrderTile(m);
        if (want >= 0 && want !== m.patrol && this.pathBudget > 0) {
          const far = Math.hypot(this.x(want) - m.x, this.y(want) - m.y) > cfg.mechPatrolRadius();
          if (far) { this.pathBudget--; m.patrol = want; this.mechPathTo(m, want); }
        }
      }
      // ---- movement: to the patrol point, then circle it ----
      const groundOwner = this.ownerOf(here);
      const ground = !groundOwner ? 'neutral' : groundOwner === p ? 'own' : p.isFriendly(groundOwner) ? 'ally' : 'enemy';
      const speed = cfg.mechSpeed(p, m.onWater, ground);
      if (m.pts.length && m.idx < m.pts.length - 1) this.advanceAlong(m, speed);
      else if (this.tick >= m.wanderAt) {
        m.wanderAt = this.tick + this.rng.int(30, 60);
        const pr = cfg.mechPatrolRadius(), px = this.x(m.patrol), py = this.y(m.patrol);
        const ang = this.rng.next() * Math.PI * 2;
        const gx = Math.round(px + Math.cos(ang) * pr), gy = Math.round(py + Math.sin(ang) * pr);
        if (this.valid(gx, gy)) { const gt = this.ref(gx, gy); if (this.mechCost(p)(gt) > 0) this.mechPathTo(m, gt); }
      }
      // ---- damage from standing in hostile territory ----
      const o = this.ownerOf(here);
      if (o && this.hostile(p, o)) {
        const density = o.troops / Math.max(1, o.numTiles);
        // tuned so a mech lasts ~2.5 min deep inside a strong nation (defense post nearby), 6+ min in a tribe
        let dmg = 6 + density * 0.2 + Math.sqrt(o.troops) * 0.008;
        if (this.hasDefensePostNearby(o, here)) dmg *= 1.5;
        m.hp -= dmg;
      }
      m.engaged = this.tick < m.engagedUntil;
      // ---- cannon ----
      if (this.tick >= m.cannonReady) {
        // Standing on home soil with nothing actually threatening us, a mech holds fire rather than
        // shelling the countryside. It still answers anything hostile that comes into range.
        const passive = (m.mode === 'hold' || m.mode === 'roam') && (ground === 'own' || ground === 'ally');
        const target = this.mechPickTarget(m, passive);
        if (target) {
          if (target.kind === 'ship') this.fireShell(p, m, target.obj, 'mechAA', { dmg: 700, speed: 4 });
          else this.fireShell(p, m, null, 'mech', { tx: target.x, ty: target.y, structTile: target.structTile ?? -1, dmg: cfg.mechShellDamage(p, m.level), troopKill: cfg.mechTroopKillPerShell(p, m.level), speed: 4, life: 80, level: m.level });
          m.cannonReady = this.tick + cfg.mechCannonCooldown(p);
          m.engagedUntil = this.tick + 40;
        } else m.cannonReady = this.tick + 10;
      }
      // ---- stomp: clear hostile land underfoot ----
      if (this.tick >= m.stompReady && !((m.mode === 'hold' || m.mode === 'roam') && ground === 'own')) {
        const r = cfg.mechStompRadius(p);
        let hostileNear = false;
        const ix = Math.floor(m.x), iy = Math.floor(m.y);
        for (let dy = -r; dy <= r && !hostileNear; dy++) for (let dx = -r; dx <= r; dx++) { const x = ix + dx, y = iy + dy; if (!this.valid(x, y)) continue; const q = this.ownerOf(this.ref(x, y)); if (q && this.hostile(p, q)) { hostileNear = true; break; } }
        if (hostileNear) {
          this.neutralizeArea(p, m.x, m.y, r, cfg.mechTroopKillPerShell(p, m.level) * 0.4, 'mech');
          // walls and defense posts under the stomp take a beating
          this.damageWallsAround(ix, iy, r + 1, 8000 * R.mechBreachMultiplier(p));
          m.stompReady = this.tick + cfg.mechStompCooldown(p);
          m.engagedUntil = this.tick + 40;
          this.events.push({ k: 'stomp', x: m.x, y: m.y, r, by: p.smallID });
        } else m.stompReady = this.tick + 10;
      }
    }
    if (this.mechs.some((m) => m.done)) {
      this.mechs = this.mechs.filter((m) => !m.done);
      for (const p of this.players) p.mechs = p.mechs.filter((m) => !m.done);
    }
  },
  // Target priority: hostile mech > hostile structure > hostile ship (amphibious) > densest hostile land patch.
  mechPickTarget(m, passive = false) {
    const p = m.owner, r = m.range, r2 = r * r;
    let best = null, bd = Infinity;
    for (const o of this.mechs) { if (o === m || o.done || !this.hostile(p, o.owner)) continue; const d = (o.x - m.x) ** 2 + (o.y - m.y) ** 2; if (d <= r2 && d < bd) { bd = d; best = { x: o.x, y: o.y }; } }
    if (best) return best;
    for (const u of this.units) {
      if (!this.hostile(p, u.owner) || u.type === UnitType.MINE) continue;
      const ux = this.x(u.tile) + 0.5, uy = this.y(u.tile) + 0.5;
      const d = (ux - m.x) ** 2 + (uy - m.y) ** 2;
      if (d <= r2 && d < bd) { bd = d; best = { x: ux, y: uy, structTile: u.tile }; }
    }
    if (best) return best;
    if (R.mechAmphibious(p) || m.onWater || this.isShore(this.tileAt(m.x, m.y))) {
      const ship = this.nearestEnemyShip(p, m.x, m.y, r, true, true);
      if (ship) return { kind: 'ship', obj: ship };
    }
    // land: sample points in range, prefer tiles of the strongest hostile owner (bots last)
    if (passive) return null;   // at home and unthreatened: don't shell the landscape
    let bestScore = 0;
    for (let i = 0; i < 18; i++) {
      const ang = this.rng.next() * Math.PI * 2, dist = 2 + this.rng.next() * (r - 2);
      const gx = Math.floor(m.x + Math.cos(ang) * dist), gy = Math.floor(m.y + Math.sin(ang) * dist);
      if (!this.valid(gx, gy)) continue;
      const t = this.ref(gx, gy);
      if (!this.isLand(t)) continue;
      const o = this.ownerOf(t);
      if (!o || !this.hostile(p, o)) continue;
      const score = (o.type === PlayerType.BOT ? 1 : 3) + (this.wallHp[t] ? 2 : 0) + (o.incomingAttacks.some((a) => a.attacker === p) ? 2 : 0);
      if (score > bestScore) { bestScore = score; best = { x: gx + 0.5, y: gy + 0.5 }; }
    }
    return best;
  },
};
