'use strict';
// Mechs: national-scale walking artillery. Built at a level-2+ Factory (higher level = more HP and range), then
// ordered to a patrol point like a warship. They hold and circle that spot, shelling hostile structures, mechs,
// ships (if amphibious) and land within range, and stomp the ground around them. Land hit by a mech is NOT
// claimed — it becomes empty land for troops to take. Mechs are slow, land-locked (Amphibious doctrine allows
// water), super tanky, and bleed HP while standing in hostile territory. Mixed into Game.prototype.
const { UnitType, PlayerType } = require('./config');
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
      patrol: targetTile, pts: [], idx: 0, wanderAt: 0, cannonReady: this.tick + 20, stompReady: this.tick + 10, engaged: false, engagedUntil: 0, onWater: false, done: false };
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
    this.mechPathTo(m, tile);
    return { ok: true };
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
      // ---- movement: to the patrol point, then circle it ----
      const speed = cfg.mechSpeed(p, m.onWater);
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
        const target = this.mechPickTarget(m);
        if (target) {
          if (target.kind === 'ship') this.fireShell(p, m, target.obj, 'mechAA', { dmg: 700, speed: 4 });
          else this.fireShell(p, m, null, 'mech', { tx: target.x, ty: target.y, structTile: target.structTile ?? -1, dmg: cfg.mechShellDamage(p, m.level), troopKill: cfg.mechTroopKillPerShell(p, m.level), speed: 4, life: 80, level: m.level });
          m.cannonReady = this.tick + cfg.mechCannonCooldown(p);
          m.engagedUntil = this.tick + 40;
        } else m.cannonReady = this.tick + 10;
      }
      // ---- stomp: clear hostile land underfoot ----
      if (this.tick >= m.stompReady) {
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
  mechPickTarget(m) {
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
