'use strict';
// Sea: transport boats, trade ships, warships, submarines, naval mines, and the shared projectile
// ("shell") system also used by defense posts and mechs. Mixed into Game.prototype.
const { UnitType, PlayerType } = require('./config');
const { newId } = require('./ids');
const { astar, resamplePath } = require('./path');
const R = require('./research').effects;

const SUB_MISSILE_CLIMB = 7;        // tiles the launch missile climbs before it splits
const SUB_MISSILE_DROP_TICKS = 7;   // how long the three hang and drop before they burn

// A ship that was hit within this many ticks does not regenerate at sea.
const SHIP_COMBAT_REGEN_DELAY = 100;

module.exports = {
  // ---- water pathing ------------------------------------------------------------
  waterCost(t) { return this.isWater(t) ? 1 + (this.isOcean(t) ? 0 : 0.5) : 0; },
  waterNeighborsOf(tile) {
    const b = [0, 0, 0, 0], n = this.neighbors4(tile, b), out = [];
    for (let k = 0; k < n; k++) if (this.isWater(b[k])) out.push(b[k]);
    return out;
  },
  // Water path from the coast of `p` to the land tile `dst` (returns tiles, last = dst).
  findWaterPathFromCoast(p, dst, maxIter = 250000) {
    const goals = new Set(this.waterNeighborsOf(dst));
    if (!goals.size) return null;
    // nearest ~300 of our shore tiles to the destination → their water neighbours are the starts
    const shore = [];
    for (const t of p.border) if (this.isShore(t)) shore.push(t);
    if (!shore.length) return null;
    shore.sort((a, b) => this.dist(a, dst) - this.dist(b, dst));
    const starts = [];
    const seen = new Set();
    // only start from water that is actually the same sea as the destination; if there is none, there is
    // no route, and we know it without searching
    const seas = new Set([...goals].map((w) => this.waterBody[w]));
    for (const t of shore.slice(0, 300)) for (const w of this.waterNeighborsOf(t)) if (!seen.has(w) && seas.has(this.waterBody[w])) { seen.add(w); starts.push(w); }
    if (!starts.length) return null;
    const path = astar(this, starts, (t) => goals.has(t), (t) => this.waterCost(t), { heuristicTo: dst, maxIter });
    if (!path) return null;
    path.push(dst);
    return path;
  },
  findWaterPathBetween(aTile, bTile, maxIter = 250000) {
    const goals = new Set(this.isWater(bTile) ? [bTile] : this.waterNeighborsOf(bTile));
    const seas = new Set([...goals].map((w) => this.waterBody[w]));
    const starts = (this.isWater(aTile) ? [aTile] : this.waterNeighborsOf(aTile)).filter((w) => seas.has(this.waterBody[w]));
    if (!starts.length || !goals.size) return null;   // different seas: no route, no search
    return astar(this, starts, (t) => goals.has(t), (t) => this.waterCost(t), { heuristicTo: bTile, maxIter });
  },
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
          if (this.isLand(nb) && this.owner[nb] === ownerSm) { if (this.isShore(nb)) { out.push(nb); if (out.length >= limit) break; } next.push(nb); }
        }
        if (out.length >= limit) break;
      }
      frontier = next;
    }
    return out;
  },
  // Advance a mobile along its resampled point path by `speed` points per tick. Returns true when it arrived.
  advanceAlong(m, speed) {
    m.idx = Math.min(m.pts.length - 1, m.idx + speed);
    const p = m.pts[Math.floor(m.idx)];
    if (p) { m.x = p.x; m.y = p.y; }
    return m.idx >= m.pts.length - 1;
  },

  // ---- transport boats ------------------------------------------------------------
  // `budget` bounds the route search. Humans get the full search - they clicked a coast and expect a boat -
  // while the AI's speculative launches pass a small one, so a nation idly probing a far-off shore can't
  // stall every player's tick while the pathfinder crosses an ocean.
  sendBoat(p, clickedTile, troops, budget = null) {
    if (!p.alive || this.settings.disableBoats) return null;
    if (p.boats.filter((x) => !x.done).length >= this.config.boatMaxNumber(p)) return null;
    let landTile = clickedTile;
    if (!this.isLand(clickedTile)) {
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
            else if (this.isWater(nb)) next.push(nb);
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
    let path = null, dst = null;
    let tries = budget ? budget.tries : Infinity;
    for (const cand of this.shoreTilesNear(landTile, this.owner[landTile])) {
      if (tries-- <= 0) break;
      path = this.findWaterPathFromCoast(p, cand, budget ? budget.maxIter : undefined);
      if (path) { dst = cand; break; }
    }
    if (!path) return null;
    troops = Math.min(p.troops, Math.floor(troops * R.boatCapacity(p)));
    if (troops < 1) return null;
    p.removeTroops(Math.min(p.troops, Math.floor(troops / R.boatCapacity(p))));
    const pts = resamplePath(this, path, 1);
    const boat = { id: newId(), owner: p, target, troops, pts, idx: 0, dst, done: false, x: pts[0].x, y: pts[0].y, hp: 1 };
    p.boats.push(boat);
    this.boats.push(boat);
    return boat;
  },
  tickBoats() {
    for (const b of this.boats) {
      if (b.done) continue;
      if (!b.owner.alive) { b.done = true; continue; }
      const arrived = this.advanceAlong(b, this.config.boatSpeed(b.owner));
      if (!arrived) continue;
      b.done = true;
      const dst = b.dst;
      const ownerNow = this.ownerOf(dst);
      if (ownerNow === b.owner || (ownerNow && (b.owner.isFriendly(ownerNow) || !this.canAttack(b.owner, ownerNow)))) { b.owner.addTroops(b.troops); continue; }
      let landing = Math.floor(b.troops * R.landingBonus(b.owner));
      // Coastal Defense Network: landings near a defense post get shredded
      if (ownerNow && ownerNow.researches.has('coastal_defense') && this.hasDefensePostNearby(ownerNow, dst)) landing = Math.floor(landing * 0.7);
      if (ownerNow) ownerNow.removeTroops(ownerNow.troops / Math.max(1, ownerNow.numTiles));
      this.conquer(b.owner, dst);
      b.owner.addTroops(landing);
      this.sendAttack(b.owner, ownerNow, landing, dst);
      if (ownerNow) this.handleDeadDefender(b.owner, ownerNow);
    }
    if (this.boats.some((b) => b.done)) {
      this.boats = this.boats.filter((b) => !b.done);
      for (const p of this.players) p.boats = p.boats.filter((b) => !b.done);
    }
  },

  // ---- trade ships ------------------------------------------------------------------
  tickTrade() {
    const cfg = this.config;
    const ports = this.units.filter((u) => u.type === UnitType.PORT && u.constructionLeft === 0 && u.owner.alive);
    if (ports.length >= 2) {
      for (const port of ports) {
        if (this.rng.next() >= cfg.tradeShipSpawnChance(port.level, this.tradeShips.length)) continue;
        const partners = ports.filter((o) => o.owner !== port.owner && !o.owner.incomingAttacks.some((a) => a.attacker === port.owner) && !port.owner.incomingAttacks.some((a) => a.attacker === o.owner));
        if (!partners.length) continue;
        const dstPort = partners[this.rng.int(0, partners.length - 1)];
        const key = port.tile < dstPort.tile ? `${port.tile}|${dstPort.tile}` : `${dstPort.tile}|${port.tile}`;
        let path = this.tradePathCache.get(key);
        if (path === undefined) {
          if (this.pathBudget-- <= 0) continue;
          path = this.findWaterPathBetween(port.tile, dstPort.tile, 120000);
          if (this.tradePathCache.size > 400) this.tradePathCache.clear();
          this.tradePathCache.set(key, path);
        }
        if (!path) continue;
        const forward = this.dist(path[0], port.tile) <= this.dist(path[path.length - 1], port.tile);
        const pts = resamplePath(this, forward ? path : [...path].reverse(), 1);
        this.tradeShips.push({ id: newId(), owner: port.owner, dstPort, pts, idx: 0, x: pts[0].x, y: pts[0].y, done: false, dist: path.length, hp: 1 });
      }
    }
    for (const s of this.tradeShips) {
      if (s.done) continue;
      if (!s.owner.alive || !this.units.includes(s.dstPort)) { s.done = true; continue; }
      if (!this.advanceAlong(s, cfg.tradeShipSpeed())) continue;
      s.done = true;
      const dstOwner = s.dstPort.owner;
      if (dstOwner === s.owner) continue;
      // allies trade on better terms: the diplomat's income
      const base = cfg.tradeShipGold(s.dist) * (s.owner.isFriendly(dstOwner) ? cfg.alliedTradeBonus() : 1);
      s.owner.addGold(Math.floor(base * R.tradeGoldMultiplier(s.owner)), 'trade');
      dstOwner.addGold(Math.floor(base * R.tradeGoldMultiplier(dstOwner)), 'trade');
      if (s.owner.type === PlayerType.HUMAN) this.events.push({ k: 'trade', to: s.owner.id, gold: base, p: dstOwner.smallID });
      if (dstOwner.type === PlayerType.HUMAN) this.events.push({ k: 'trade', to: dstOwner.id, gold: base, p: s.owner.smallID });
    }
    if (this.tradeShips.some((s) => s.done)) this.tradeShips = this.tradeShips.filter((s) => !s.done);
  },

  // ---- shells / projectiles -----------------------------------------------------------
  // kinds: 'ship' (warship/post vs a ship), 'bombard' (warship vs coast tile), 'mech' (mech cannon),
  // 'mechAA' (mech vs ship), 'sub' (submarine missile). `target` is a mobile object or null; tx/ty the aim point.
  fireShell(owner, fromTile, target, kind, opts = {}) {
    const fx = typeof fromTile === 'number' ? this.x(fromTile) + 0.5 : fromTile.x, fy = typeof fromTile === 'number' ? this.y(fromTile) + 0.5 : fromTile.y;
    const s = { id: newId(), owner, x: fx, y: fy, target: target && target.x !== undefined ? target : null, tx: opts.tx ?? (target ? target.x : fx), ty: opts.ty ?? (target ? target.y : fy), kind, speed: opts.speed || this.config.shellSpeed(), life: opts.life || 90, dmg: opts.dmg || 0, radius: opts.radius || 0, troopKill: opts.troopKill || 0, structTile: opts.structTile ?? -1, level: opts.level || 2 };
    this.shells.push(s);
    return s;
  },
  tickShells() {
    if (!this.shells.length) return;
    for (const s of this.shells) {
      if (s.drop > 0) { s.x += s.vx; s.y += s.vy; s.vy += 0.04; s.drop--; continue; }   // hanging after the split
      if (s.accel) s.speed = Math.min(s.maxSpeed, s.speed * s.accel);
      if (s.target) { if (s.target.done || s.target.hp <= 0) s.target = null; else { s.tx = s.target.x; s.ty = s.target.y; } }
      const dx = s.tx - s.x, dy = s.ty - s.y, d = Math.hypot(dx, dy);
      if (d <= s.speed) { s.x = s.tx; s.y = s.ty; this.shellImpact(s); s.done = true; continue; }
      s.x += (dx / d) * s.speed; s.y += (dy / d) * s.speed;
      if (--s.life <= 0) s.done = true;
    }
    this.shells = this.shells.filter((s) => !s.done);
  },
  // Land tiles within r of a point, as a plain array. Used by anything that scars the ground.
  tilesAround(cx, cy, r) {
    const out = [];
    const x0 = Math.floor(cx), y0 = Math.floor(cy);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = x0 + dx, y = y0 + dy;
        if (!this.valid(x, y) || dx * dx + dy * dy > r * r) continue;
        const t = this.ref(x, y);
        if (this.isLand(t)) out.push(t);
      }
    }
    return out;
  },
  shellImpact(s) {
    const owner = s.owner;
    if (s.kind === 'flak') {
      // an Airborne Mech's shell: an airship has no armour to speak of
      if (s.target && !s.target.done && this.airships.includes(s.target)) {
        s.target.done = true;
        this.events.push({ k: 'airshipDown', by: owner.smallID, p: s.target.owner.smallID, x: s.target.x, y: s.target.y });
      }
      return;
    }
    // warship guns, a mech firing at sea, and coastal defense posts all hit the ship they were aimed at
    if (s.kind === 'ship' || s.kind === 'mechAA' || s.kind === 'post') {
      if (s.target && !s.target.done) this.damageShip(s.target, s.dmg || this.config.shellDamage(this.rng), owner);
      return;
    }
    if (s.kind === 'bombard') { this.neutralizeArea(owner, s.tx, s.ty, 2, 400 + 150 * 4, 'bombard'); return; }
    if (s.kind === 'subLaunch') {
      // the split: three missiles fan out and drop, then each one burns hard for its target
      const n = s.payload.length;
      s.payload.forEach((p, i) => {
        const side = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
        const m = this.fireShell(owner, { x: s.x, y: s.y }, null, 'sub', { tx: p.tx, ty: p.ty, structTile: p.structTile, speed: 0.8, life: 160 });
        m.vx = side * 0.35; m.vy = 0.1; m.drop = SUB_MISSILE_DROP_TICKS + i * 2;
        m.accel = 1.28; m.maxSpeed = 9;
      });
      this.events.push({ k: 'subSplit', x: s.x, y: s.y, by: owner.smallID });
      return;
    }
    if (s.kind === 'sub') {
      const u = s.structTile >= 0 ? this.unitAt(s.structTile) : null;
      if (u && this.hostile(owner, u.owner)) { this.events.push({ k: 'structHit', p: u.owner.smallID, type: u.type, x: this.x(u.tile), y: this.y(u.tile) }); this.removeUnit(u); }
      this.neutralizeArea(owner, s.tx, s.ty, 2, 1500, 'missile');
      for (const t of this.tilesAround(s.tx, s.ty, 2)) this.addFallout(t, 300);
      return;
    }
    if (s.kind === 'artillery') {
      // Artillery is anti-mech first: a direct hit is what makes a battery worth its price. It also
      // thins whoever is attacking underneath, but it never takes ground - the tile stays the defender's.
      let hit = null, bd = Infinity;
      for (const m of this.mechs) {
        if (m.done || !this.hostile(owner, m.owner)) continue;
        const d = (m.x - s.tx) ** 2 + (m.y - s.ty) ** 2;
        if (d <= (s.radius + 1) ** 2 && d < bd) { bd = d; hit = m; }
      }
      if (hit) hit.hp -= hit.maxHp * this.config.artilleryMechDamageFraction(owner);
      if (s.target && !s.target.done) this.damageShip(s.target, this.config.warshipHp() * this.config.artilleryShipDamageFraction(owner), owner);
      for (const a of owner.incomingAttacks) {
        if (a.done || a.markX < 0) continue;
        if (Math.hypot(a.markX - s.tx, a.markY - s.ty) <= s.radius + 2) a.troops = Math.max(0, a.troops - s.troopKill);
      }
      this.events.push({ k: 'shellHit', x: s.tx, y: s.ty });
      return;
    }
    if (s.kind === 'mech' && s.swarm) {
      // a mech shooting the swarm that is running at it
      if (!s.swarm.done) s.swarm.troops *= 1 - this.config.swarmShellKill();
      return;
    }
    if (s.kind === 'mech' && s.attackId) {
      // a mech shell into an attacking army: it thins the attack itself, not the scenery
      const a = this.attacks.find((x) => x.id === s.attackId && !x.done);
      if (a) {
        const k = this.config.mechAttackKill(owner, s.level);
        a.troops = Math.max(0, a.troops - (a.troops * k.share + k.flat));
        this.events.push({ k: 'mechHitAttack', x: s.tx, y: s.ty, by: owner.smallID, p: a.attacker.smallID });
      }
      return;
    }
    if (s.kind === 'mech') {
      const u = s.structTile >= 0 ? this.unitAt(s.structTile) : null;
      if (u && this.hostile(owner, u.owner)) {
        if (owner.researches.has('mech_weapons') || u.type === UnitType.DEFENSE_POST || u.type === UnitType.MINE || (u.hp = (u.hp || 2) - 1) <= 0) { this.events.push({ k: 'structHit', p: u.owner.smallID, type: u.type, x: this.x(u.tile), y: this.y(u.tile) }); this.removeUnit(u); }
        else this.unitsChanged = true;
      }
      const mechAt = this.mechs.find((m) => !m.done && this.hostile(owner, m.owner) && Math.hypot(m.x - s.tx, m.y - s.ty) <= this.config.mechShellBlastRadius() + 1);
      if (mechAt) mechAt.hp -= s.dmg;
      this.mechBreach(owner, s.tx, s.ty, this.config.mechShellBlastRadius(), s.troopKill, this.config.mechWarBite(owner, s.level));
      return;
    }
  },
  // Turn hostile-owned land around (cx,cy) neutral (NOT claimed), kill some of the owner's troops, wreck structures/walls.
  neutralizeArea(by, cx, cy, r, troopKill, cause) {
    const icx = Math.floor(cx), icy = Math.floor(cy);
    const hit = new Map();
    for (let y = Math.max(0, icy - r); y <= Math.min(this.height - 1, icy + r); y++) {
      for (let x = Math.max(0, icx - r); x <= Math.min(this.width - 1, icx + r); x++) {
        if ((x - icx) ** 2 + (y - icy) ** 2 > r * r) continue;
        const t = this.ref(x, y);
        if (!this.isLand(t)) continue;
        const o = this.ownerOf(t);
        if (!o || !this.hostile(by, o)) continue;
        hit.set(o, (hit.get(o) || 0) + 1);
        if (this.wallHp[t]) { const d = 6000 * R.wallDamageMultiplier(o); if (this.wallHp[t] <= d) this.clearWallTile(t); else { this.wallHp[t] -= d; continue; } }
        const u = this.unitAt(t);
        if (u) this.removeUnit(u);
        this.relinquish(t);
      }
    }
    for (const [o, n] of hit) { o.removeTroops(troopKill * Math.min(1, n / 8)); o.updateRelation(by, -20); }
    if (hit.size && cause !== 'mech') this.events.push({ k: 'shellHit', x: icx, y: icy, by: by.smallID, cause });
  },
  nearestEnemyShip(p, x, y, range, includeBoats = true, includeSubs = true) {
    let best = null, bd = range * range;
    const consider = (s) => { if (s.done) return; if (!this.hostile(p, s.owner)) return; const d = (s.x - x) ** 2 + (s.y - y) ** 2; if (d < bd) { bd = d; best = s; } };
    for (const w of this.warships) consider(w);
    for (const m of this.mechs) if (m.onWater) consider(m);    // a mech crossing the sea is fair game
    if (includeSubs) for (const s of this.subs) if (s.detected) consider(s);
    if (includeBoats) { for (const b of this.boats) consider(b); for (const t of this.tradeShips) consider(t); }
    return best;
  },
  damageShip(s, dmg, by) {
    if (s.done) return;
    if (s.isMech) { s.hp -= dmg * (R.mechAmphibious(s.owner) ? 1 : 2); return; }   // a mech on a barge is a sitting duck
    if (s.troops !== undefined) { // transport boat: one hit sinks it, troops lost
      s.done = true; s.owner.boats = s.owner.boats.filter((b) => b !== s);
      this.events.push({ k: 'sunk', kind: 'boat', p: s.owner.smallID, by: by.smallID, x: s.x, y: s.y });
      return;
    }
    if (s.dstPort !== undefined) { // trade ship: captured — the attacker takes the cargo
      s.done = true;
      const gold = this.config.tradeShipGold(s.dist);
      by.addGold(gold, 'plunder');
      this.events.push({ k: 'sunk', kind: 'trade', p: s.owner.smallID, by: by.smallID, x: s.x, y: s.y, gold });
      return;
    }
    s.hp -= dmg;
    s.lastHitTick = this.tick;
    if (s.hp <= 0) {
      s.done = true;
      this.events.push({ k: 'sunk', kind: s.kind, p: s.owner.smallID, by: by.smallID, x: s.x, y: s.y });
      s.owner.updateRelation(by, -40);
    }
  },

  // ---- warships ---------------------------------------------------------------------
  canBuildWarship(p, tile) {
    if (!p.alive) return { ok: false, reason: 'dead' };
    if (this.unitDisabled('warship')) return { ok: false, reason: 'Warships are disabled in this game' };
    if (!this.isWater(tile)) return { ok: false, reason: 'Set the patrol point on water' };
    const ports = p.completedUnitsOf(UnitType.PORT);
    if (!ports.length) return { ok: false, reason: 'You need a Port to launch warships' };
    if (p.warships.filter((w) => !w.done).length >= this.config.warshipCap(p)) return { ok: false, reason: `Warship limit reached (${this.config.warshipCap(p)})` };
    const cost = this.config.unitCost(UnitType.WARSHIP, p.warships.length, p);
    if (p.gold < cost) return { ok: false, reason: `Not enough gold (need ${Math.floor(cost).toLocaleString()})` };
    ports.sort((a, b) => this.dist(a.tile, tile) - this.dist(b.tile, tile));
    return { ok: true, cost, port: ports[0] };
  },
  buildWarship(p, tile) {
    const c = this.canBuildWarship(p, tile);
    if (!c.ok) return c;
    const spawnW = this.waterNeighborsOf(c.port.tile);
    if (!spawnW.length) return { ok: false, reason: 'Port has no water access' };
    p.removeGold(c.cost);
    const st = spawnW[0];
    const w = { id: newId(), kind: 'warship', owner: p, x: this.x(st) + 0.5, y: this.y(st) + 0.5, hp: 0, patrol: tile, pts: [], idx: 0, shellReady: 0, done: false, wanderAt: 0, targetId: 0 };
    this.applyUnitLevel('warship', w, c.port.level);   // built at its port's level
    p.warships.push(w);
    this.warships.push(w);
    this.events.push({ k: 'warship', p: p.smallID });
    return c;
  },
  moveShip(p, id, tile) {
    const s = this.warships.find((w) => w.id === id && w.owner === p) || this.subs.find((w) => w.id === id && w.owner === p);
    if (!s || s.done || !this.isWater(tile)) return { ok: false, reason: 'Pick a water tile' };
    if (s.refit) this.cancelRefit(s);   // an explicit order beats a refit
    s.patrol = tile; s.pts = []; s.idx = 0; s.wanderAt = 0;
    return { ok: true };
  },
  // Head toward the patrol point, then wander around it (OpenFront: random point within patrolRange/2).
  shipWander(s, speed, range) {
    if (s.pts.length && s.idx < s.pts.length - 1) { this.advanceAlong(s, speed); return; }
    if (this.tick < s.wanderAt) return;
    s.wanderAt = this.tick + this.rng.int(10, 30);
    const px = this.x(s.patrol), py = this.y(s.patrol);
    const far = Math.hypot(s.x - px, s.y - py) > range;
    let goal = -1;
    for (let i = 0; i < 12; i++) {
      const gx = far ? px : px + this.rng.int(-range / 2, range / 2), gy = far ? py : py + this.rng.int(-range / 2, range / 2);
      if (!this.valid(gx, gy)) continue;
      const t = this.ref(gx, gy);
      if (this.isWater(t)) { goal = t; break; }
    }
    if (goal < 0) return;
    const path = astar(this, [this.tileAt(s.x, s.y)], goal, (t) => this.waterCost(t), { maxIter: 30000 });
    if (path && path.length > 1) { s.pts = resamplePath(this, path, 1); s.idx = 0; }
  },
  tickWarships() {
    const cfg = this.config;
    for (const w of this.warships) {
      if (w.done) continue;
      if (!w.owner.alive) { w.done = true; continue; }
      if (this.tickRefit('warship', w)) continue;
      w.maxHp = w.maxHp || cfg.warshipHp();
      // Repair: fast alongside our own ports; slow at sea, and not at all while under fire. Without that
      // last rule a ship sitting off a coast out-healed every small gun shooting at it.
      if (w.hp < w.maxHp) {
        const nearPort = w.owner.units.some((u) => u.type === UnitType.PORT && this.dist(u.tile, this.tileAt(w.x, w.y)) < 25);
        const underFire = this.tick - (w.lastHitTick ?? -1e9) < SHIP_COMBAT_REGEN_DELAY;
        const heal = nearPort ? 3 * R.warshipRepairMultiplier(w.owner) : underFire ? 0 : 0.3;
        w.hp = Math.min(w.maxHp, w.hp + heal);
      }
      this.shipWander(w, cfg.warshipSpeed(), cfg.warshipPatrolRange());
      if (w.shellReady > this.tick) continue;
      const target = this.nearestEnemyShip(w.owner, w.x, w.y, cfg.warshipTargetRange());
      if (target) { this.fireShell(w.owner, w, target, 'ship', { dmg: Math.round(cfg.shellDamage(this.rng) * cfg.warshipDamageMultiplier(w.level || 1)) }); w.shellReady = this.tick + cfg.warshipShellRate(); continue; }
      // amphibious enemy mechs at sea
      const mech = this.mechs.find((m) => !m.done && m.onWater && this.hostile(w.owner, m.owner) && Math.hypot(m.x - w.x, m.y - w.y) <= cfg.warshipTargetRange());
      if (mech) { this.fireShell(w.owner, w, null, 'mech', { tx: mech.x, ty: mech.y, dmg: 600, troopKill: 0 }); w.shellReady = this.tick + cfg.warshipShellRate(); continue; }
      // Coastal Bombardment: shell hostile coastal land within range
      if (w.owner.researches.has('coastal_bombardment')) {
        const rr = cfg.bombardRange();
        for (let i = 0; i < 16; i++) {
          const gx = Math.floor(w.x) + this.rng.int(-rr, rr), gy = Math.floor(w.y) + this.rng.int(-rr, rr);
          if (!this.valid(gx, gy) || (gx - w.x) ** 2 + (gy - w.y) ** 2 > rr * rr) continue;
          const t = this.ref(gx, gy);
          if (!this.isLand(t)) continue;
          const o = this.ownerOf(t);
          if (!o || !this.hostile(w.owner, o) || o.type === PlayerType.BOT && this.rng.chance(2)) continue;
          if (!this.isShore(t) && !this.rng.chance(3)) continue;
          this.fireShell(w.owner, w, null, 'bombard', { tx: gx + 0.5, ty: gy + 0.5 });
          w.shellReady = this.tick + cfg.warshipShellRate() * 2;
          break;
        }
      }
    }
    if (this.warships.some((w) => w.done)) {
      this.warships = this.warships.filter((w) => !w.done);
      for (const p of this.players) p.warships = p.warships.filter((w) => !w.done);
    }
  },

  // ---- submarines ---------------------------------------------------------------------
  canBuildSub(p, tile) {
    if (!p.alive) return { ok: false, reason: 'dead' };
    if (this.unitDisabled('submarine')) return { ok: false, reason: 'Submarines are disabled in this game' };
    if (!p.researches.has('submarine_warfare')) return { ok: false, reason: 'Needs the Submarine Warfare research' };
    if (!this.isWater(tile)) return { ok: false, reason: 'Set the patrol point on water' };
    const ports = p.completedUnitsOf(UnitType.PORT);
    if (!ports.length) return { ok: false, reason: 'You need a Port to launch submarines' };
    const subCap = this.config.submarineCap(p);
    if (p.subs.filter((s) => !s.done).length >= subCap) return { ok: false, reason: `Submarine limit reached (${subCap}) - a level-3 Port raises it` };
    const cost = this.config.unitCost(UnitType.SUBMARINE, p.subs.length, p);
    if (p.gold < cost) return { ok: false, reason: `Not enough gold (need ${Math.floor(cost).toLocaleString()})` };
    ports.sort((a, b) => this.dist(a.tile, tile) - this.dist(b.tile, tile));
    return { ok: true, cost, port: ports[0] };
  },
  buildSub(p, tile) {
    const c = this.canBuildSub(p, tile);
    if (!c.ok) return c;
    const spawnW = this.waterNeighborsOf(c.port.tile);
    if (!spawnW.length) return { ok: false, reason: 'Port has no water access' };
    p.removeGold(c.cost);
    const st = spawnW[0];
    const s = { id: newId(), kind: 'submarine', owner: p, x: this.x(st) + 0.5, y: this.y(st) + 0.5, hp: 0, patrol: tile, pts: [], idx: 0, done: false, wanderAt: 0, detected: false, volleyReady: this.tick + 300, nukeReady: 0 };
    this.applyUnitLevel('submarine', s, c.port ? c.port.level : 1);
    p.subs.push(s);
    this.subs.push(s);
    this.events.push({ k: 'sub', p: p.smallID });
    return c;
  },
  tickSubs() {
    const cfg = this.config;
    for (const s of this.subs) {
      if (s.done) continue;
      if (!s.owner.alive) { s.done = true; continue; }
      if (this.tickRefit('submarine', s)) continue;
      this.shipWander(s, cfg.warshipSpeed() * 0.8, cfg.warshipPatrolRange() * 0.6);
      // detection: any hostile warship (or amphibious mech) within 10 tiles
      const dr = cfg.submarineDetectRange();
      s.detected = this.warships.some((w) => !w.done && this.hostile(s.owner, w.owner) && Math.hypot(w.x - s.x, w.y - s.y) <= dr)
        || this.mechs.some((m) => !m.done && this.hostile(s.owner, m.owner) && Math.hypot(m.x - s.x, m.y - s.y)
          <= (R.mechAmphibious(m.owner) ? cfg.mechSubDetectRange() : m.onWater ? dr : -1));   // amphibious mechs hunt subs
      if (this.tick < s.volleyReady) continue;
      // volley of 3 missiles at the nearest hostile structures in range (fallback: hostile coast)
      const rr = cfg.submarineMissileRange();
      const targets = this.units.filter((u) => this.hostile(s.owner, u.owner) && u.owner.type !== PlayerType.BOT && u.type !== UnitType.MINE && this.distXY(this.x(u.tile), this.y(u.tile), s.x, s.y) <= rr)
        .sort((a, b) => this.distXY(this.x(a.tile), this.y(a.tile), s.x, s.y) - this.distXY(this.x(b.tile), this.y(b.tile), s.x, s.y)).slice(0, 3);
      // One missile breaks the surface and climbs; at the top it splits into three that hang and drop for
      // a moment, then each one lights up and races onto its own target (see shellImpact 'subLaunch').
      const payload = targets.map((u) => ({ tx: this.x(u.tile) + 0.5, ty: this.y(u.tile) + 0.5, structTile: u.tile }));
      for (let i = 0; i < 24 && payload.length < 3; i++) {
        const gx = Math.floor(s.x) + this.rng.int(-rr, rr), gy = Math.floor(s.y) + this.rng.int(-rr, rr);
        if (!this.valid(gx, gy)) continue;
        const t = this.ref(gx, gy);
        if (!this.isLand(t)) continue;
        const o = this.ownerOf(t);
        if (!o || !this.hostile(s.owner, o) || o.type === PlayerType.BOT) continue;
        payload.push({ tx: gx + 0.5, ty: gy + 0.5, structTile: -1 });
      }
      const fired = payload.length;
      if (fired) {
        const carrier = this.fireShell(s.owner, s, null, 'subLaunch', { tx: s.x, ty: s.y - SUB_MISSILE_CLIMB, speed: 0.9, life: 40 });
        carrier.payload = payload;
      }
      if (fired) { s.volleyReady = this.tick + cfg.submarineVolleyCooldown(); this.events.push({ k: 'volley', p: s.owner.smallID }); }
      else s.volleyReady = this.tick + 50;
    }
    if (this.subs.some((s) => s.done)) {
      this.subs = this.subs.filter((s) => !s.done);
      for (const p of this.players) p.subs = p.subs.filter((s) => !s.done);
    }
  },

  // ---- mines ------------------------------------------------------------------------------
  tickMines() {
    if (this.tick % 2) return;
    const r = this.config.mineRange();
    for (const u of this.units) {
      if (u.type !== UnitType.MINE || u.constructionLeft > 0) continue;
      const mx = this.x(u.tile) + 0.5, my = this.y(u.tile) + 0.5;
      const victim = this.nearestEnemyShip(u.owner, mx, my, r, true, true) || this.subs.find((s) => !s.done && this.hostile(u.owner, s.owner) && Math.hypot(s.x - mx, s.y - my) <= r);
      if (!victim) continue;
      this.damageShip(victim, 1000, u.owner);
      this.events.push({ k: 'mine', x: mx, y: my, by: u.owner.smallID });
      this.removeUnit(u);
    }
  },
};
