'use strict';
// Mechs: national-scale walking artillery. Built at a level-2+ Factory (higher level = more HP and range), then
// ordered to a patrol point like a warship. They hold and circle that spot, shelling hostile structures, mechs,
// ships (if amphibious) and land within range, and stomp the ground around them. Land hit by a mech is NOT
// claimed — it becomes empty land for troops to take. Mechs are slow, land-locked (Amphibious doctrine allows
// water), super tanky, and bleed HP while standing in hostile territory.
//
// Each mech runs one of four standing orders (`mode`):
//   defend  - "Guard", the default: wait at a post, and the moment an attack hits our land drive to that
//             front on our own roads, hold it and shell the attacking troops; go back to the post after
//   hold    - sit on the point it was sent to and circle it (a click into enemy land sets this)
//   roam    - walk its owner's border, favouring the stretch closest to trouble
//   assault - march into one named nation and keep wrecking whatever is in range
// What a mech is for:
//   * defence - attacks near it bleed 3x troops and crawl (mechAuraRange / mechDefenseBonus), and its
//     shells go into the attacking army itself (mechAttackKill)
//   * offence - the spearhead: its owner's attacks near it take ground twice as fast for half the losses,
//     and when its owner is attacking that nation its stomps and shells take the ground for its owner
//     (a bridgehead the attack pours through) instead of just flattening it
//   * any mech can cross the sea on a slow barge; warships can shell it there
// The counter is a swarm: troops sent straight at the mech, each one taking a bite out of it.
// Mixed into Game.prototype.
const { UnitType, PlayerType, within } = require('./config');
const MECH_MODES = ['hold', 'roam', 'defend', 'assault'];
const REORDER_INTERVAL = 40;   // ticks between standing-order re-evaluations
const GUARD_REORDER_INTERVAL = 12;   // a guarding mech checks for attacks far more often
const { newId } = require('./ids');
const { astar, resamplePath } = require('./path');
const R = require('./research').effects;

module.exports = {
  mechFactories(p) { return p.completedUnitsOf(UnitType.FACTORY).filter((f) => f.level >= this.config.mechFactoryLevelRequired()); },
  canBuildMech(p, targetTile, fromTile = -1) {
    if (!p.alive) return { ok: false, reason: 'dead' };
    if (this.unitDisabled('mech')) return { ok: false, reason: 'Mechs are disabled in this game' };
    const amph = R.mechCrossesWater(p);
    if (!this.isLand(targetTile) && !(amph && this.isWater(targetTile))) return { ok: false, reason: amph ? 'Pick a land or water tile' : 'Mechs are land-locked: pick a land tile' };
    const facs = this.mechFactories(p);
    if (!facs.length) return { ok: false, reason: 'Mechs need a level-2 Factory (build a Factory, then build on it again to upgrade)' };
    if (p.mechs.filter((m) => !m.done).length >= this.config.mechCap(p)) return { ok: false, reason: `Mech limit reached (${this.config.mechCap(p)})` };
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
      mode: 'defend', post: targetTile, orderTarget: 0, reorderAt: 0, isMech: true };
    p.mechs.push(m);
    this.mechs.push(m);
    this.mechPathTo(m, targetTile);
    this.events.push({ k: 'mech', by: p.smallID });
    return c;
  },
  moveMech(p, id, tile) {
    const m = this.mechs.find((x) => x.id === id && x.owner === p && !x.done);
    if (!m) return { ok: false, reason: 'No such mech' };
    if (!this.isLand(tile) && !(R.mechCrossesWater(p) && this.isWater(tile))) return { ok: false, reason: R.mechCrossesWater(p) ? 'Pick a land or water tile' : 'Mechs are land-locked' };
    if (m.refit) this.cancelRefit(m);
    m.patrol = tile;
    // sent into someone else's country: hold there and fight. Anywhere else: that is its new guard post.
    const o = this.ownerOf(tile);
    if (o && this.hostile(p, o)) m.mode = 'hold';
    else { m.mode = 'defend'; m.post = tile; }
    m.reorderAt = this.tick + 30;
    this.mechPathTo(m, tile);
    return { ok: true, mode: m.mode };
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
    for (const m of mechs) { m.mode = mode; m.orderTarget = target; m.reorderAt = 0; if (mode === 'defend') m.post = m.patrol; }
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
        if (!live.length) {
          // nothing to answer: back to the guard post
          if (m.post >= 0 && Math.hypot(this.x(m.post) - m.x, this.y(m.post) - m.y) > this.config.mechPatrolRadius() * 2) return m.post;
          return -1;
        }
        // nearest first, then whoever is committing the most troops
        let best = null, bestScore = -Infinity;
        for (const a of live) {
          if (a.markX < 0) continue;
          const d = Math.hypot(a.markX - m.x, a.markY - m.y);
          const score = Math.sqrt(a.troops) - d * 2;
          if (score > bestScore) { bestScore = score; best = a; }
        }
        if (!best) return -1;
        // stand on our side of that front (the nearest of our border tiles), not in the ground they took
        let bt = -1, bd = Infinity, n = 0;
        const step = Math.max(1, Math.floor(p.border.size / 400));
        for (const t of p.border) {
          if (n++ % step) continue;
          const d = (this.x(t) - best.markX) ** 2 + (this.y(t) - best.markY) ** 2;
          if (d < bd) { bd = d; bt = t; }
        }
        if (bt >= 0) return bt;
        const t = this.ref(Math.round(within(best.markX, 0, this.width - 1)), Math.round(within(best.markY, 0, this.height - 1)));
        return this.isLand(t) ? t : -1;
      }
      case 'assault': {
        const o = this.playersBySmall[m.orderTarget];
        if (!o || !o.alive || p.isFriendly(o)) { m.mode = 'roam'; return -1; }
        // our troops are already pushing into them: walk at the head of that push (the ground behind the
        // front is freshly ours, so the mech keeps up), where the spearhead bonus does the most good
        const push = p.outgoingAttacks.filter((a) => !a.done && a.target === o && a.markX >= 0).sort((a, b) => b.troops - a.troops)[0];
        if (push) {
          const t = this.ref(Math.round(within(push.markX, 0, this.width - 1)), Math.round(within(push.markY, 0, this.height - 1)));
          if (this.isLand(t)) return t;
        }
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
  // Route cost follows how fast a mech moves on the ground: its own roads are cheapest, an ally's next,
  // then empty land, and a foreign country (where it crawls) is avoided unless it is the only way. Water
  // is fine for a water-doctrine mech and costly (a slow barge) for the rest.
  mechCost(p) {
    const amph = R.mechCrossesWater(p), me = p.smallID;
    return (t) => {
      if (this.isLand(t)) {
        const o = this.owner[t];
        if (o === me) return 1;
        if (o === 0) return 2.5;
        const q = this.playersBySmall[o];
        return (q && p.isFriendly(q) ? 1.5 : 4) + (this.wallHp[t] ? 3 : 0);
      }
      return this.isWater(t) ? (amph ? 2.5 : 5) : 0;
    };
  },
  mechPathTo(m, tile) {
    const path = astar(this, [this.tileAt(m.x, m.y)], tile, this.mechCost(m.owner), { maxIter: 150000 });
    if (path && path.length > 1) { m.pts = resamplePath(this, path, 1); m.idx = 0; }
    else { m.pts = []; m.idx = 0; }
  },
  // What a mech's stomp and its shells do to hostile ground. If its owner has troops attacking that
  // nation, the ground becomes the owner's - a bridgehead the attack pours through (buildings on it are
  // captured, as an attack would). Otherwise it is only flattened to empty land. Either way the owner of
  // the ground loses troops and walls take a beating.
  mechBreach(by, cx, cy, r, troopKill, warBite = 0) {
    const icx = Math.floor(cx), icy = Math.floor(cy);
    const hit = new Map(), atWar = new Map();
    for (let y = Math.max(0, icy - r); y <= Math.min(this.height - 1, icy + r); y++) {
      for (let x = Math.max(0, icx - r); x <= Math.min(this.width - 1, icx + r); x++) {
        if ((x - icx) ** 2 + (y - icy) ** 2 > r * r) continue;
        const t = this.ref(x, y);
        if (!this.isLand(t)) continue;
        const o = this.ownerOf(t);
        if (!o || !this.hostile(by, o)) continue;
        hit.set(o, (hit.get(o) || 0) + 1);
        if (this.wallHp[t]) { const d = 6000 * R.wallDamageMultiplier(o); if (this.wallHp[t] <= d) this.clearWallTile(t); else { this.wallHp[t] -= d; continue; } }
        if (!atWar.has(o)) atWar.set(o, by.outgoingAttacks.some((a) => !a.done && a.target === o));
        if (atWar.get(o)) this.conquer(by, t);
        else { const u = this.unitAt(t); if (u) this.removeUnit(u); this.relinquish(t); }
      }
    }
    for (const [o, n] of hit) {
      // against a nation we are attacking, every hit also takes a bite out of its army: a mech leading an
      // offensive grinds the defenders down, which is what makes the troops behind it cheap to push
      const bite = atWar.get(o) ? o.troops * warBite : 0;
      o.removeTroops((troopKill + bite) * Math.min(1, n / 8));
      o.updateRelation(by, -20);
      if (atWar.get(o)) this.handleDeadDefender(by, o);
    }
  },
  // ---- swarms: troops sent straight at an enemy mech ----
  swarmMech(p, mechId, troops) {
    if (!p.alive) return { ok: false, reason: 'dead' };
    const m = this.mechs.find((x) => x.id === mechId && !x.done);
    if (!m || !this.hostile(p, m.owner)) return { ok: false, reason: 'Pick an enemy mech' };
    if (!this.canAttack(p, m.owner)) return { ok: false, reason: `You can't attack ${m.owner.name} yet` };
    if (m.onWater) return { ok: false, reason: "It's at sea - troops can't reach it (use warships)" };
    troops = Math.min(p.troops, Math.floor(troops));
    if (!(troops >= 1000)) return { ok: false, reason: 'Send at least 1,000 troops' };
    // run from the nearest of our own tiles
    let from = -1, bd = Infinity, n = 0;
    const step = Math.max(1, Math.floor(p.border.size / 500));
    for (const t of p.border) {
      if (n++ % step) continue;
      const d = (this.x(t) - m.x) ** 2 + (this.y(t) - m.y) ** 2;
      if (d < bd) { bd = d; from = t; }
    }
    const range = this.config.swarmRange();
    if (from < 0 || bd > range * range) return { ok: false, reason: `Too far: a swarm runs at most ${range} tiles from your land` };
    p.removeTroops(troops);
    const s = { id: newId(), owner: p, x: this.x(from) + 0.5, y: this.y(from) + 0.5, troops, target: m, done: false };
    this.swarms.push(s);
    this.events.push({ k: 'swarm', by: p.smallID, p: m.owner.smallID, troops });
    return { ok: true, troops };
  },
  tickSwarms() {
    if (!this.swarms.length) return;
    const sp = this.config.swarmSpeed(), per = this.config.swarmDamagePerTroop();
    for (const s of this.swarms) {
      if (s.done) continue;
      const m = s.target;
      // the mech is gone (or put to sea): the survivors walk home
      if (!s.owner.alive || m.done || m.onWater || s.troops < 50) { if (s.owner.alive) s.owner.addTroops(s.troops * 0.5); s.done = true; continue; }
      const dx = m.x - s.x, dy = m.y - s.y, d = Math.hypot(dx, dy);
      if (d <= sp + 1) {
        const dmg = s.troops * per;
        m.hp -= dmg;
        this.events.push({ k: 'swarmHit', by: s.owner.smallID, p: m.owner.smallID, x: m.x, y: m.y, dmg: Math.round(dmg), kill: m.hp <= 0 });
        s.done = true;
        continue;
      }
      s.x += (dx / d) * sp; s.y += (dy / d) * sp;
    }
    this.swarms = this.swarms.filter((s) => !s.done);
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
      if (this.tickRefit('mech', m)) continue;
      const here = this.tileAt(m.x, m.y);
      m.onWater = this.isWater(here);
      // ---- standing orders: re-aim the patrol point periodically ----
      if (m.mode !== 'hold' && this.tick >= m.reorderAt) {
        m.reorderAt = this.tick + (m.mode === 'defend' ? GUARD_REORDER_INTERVAL : REORDER_INTERVAL) + this.rng.int(0, 10);
        const want = this.mechOrderTile(m);
        if (want >= 0 && want !== m.patrol && this.pathBudget > 0) {
          const far = Math.hypot(this.x(want) - m.x, this.y(want) - m.y) > cfg.mechPatrolRadius();
          if (far) { this.pathBudget--; m.patrol = want; this.mechPathTo(m, want); }
        }
      }
      // ---- movement: to the patrol point, then circle it ----
      const groundOwner = this.ownerOf(here);
      let ground = !groundOwner ? 'neutral' : groundOwner === p ? 'own' : p.isFriendly(groundOwner) ? 'ally' : 'enemy';
      if (ground === 'enemy' && m.mode === 'defend' && p.incomingAttacks.some((a) => !a.done && a.attacker === groundOwner)) ground = 'neutral';
      const speed = cfg.mechSpeed(p, m.onWater, ground);
      if (m.pts.length && m.idx < m.pts.length - 1) this.advanceAlong(m, speed);
      else if (this.tick >= m.wanderAt) {
        m.wanderAt = this.tick + this.rng.int(30, 60);
        const pr = cfg.mechPatrolRadius(), px = this.x(m.patrol), py = this.y(m.patrol);
        const ang = this.rng.next() * Math.PI * 2;
        const gx = Math.round(px + Math.cos(ang) * pr), gy = Math.round(py + Math.sin(ang) * pr);
        if (this.valid(gx, gy)) { const gt = this.ref(gx, gy); if (this.isLand(gt) || (R.mechCrossesWater(p) && this.isWater(gt))) this.mechPathTo(m, gt); }
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
      // on a barge a mech is cargo: it neither fires nor stomps until it is ashore
      const barge = m.onWater && !R.mechCrossesWater(p);
      // Standing on home soil with nothing actually threatening us, a mech holds fire rather than
      // shelling the countryside. It still answers anything hostile that comes into range.
      const passive = m.mode !== 'assault' && (ground === 'own' || ground === 'ally');
      // ---- cannon ----
      if (!barge && this.tick >= m.cannonReady) {
        const target = this.mechPickTarget(m, passive);
        if (target) {
          if (target.kind === 'air') this.fireShell(p, m, target.obj, 'flak', { speed: 7, life: 60 });
          else if (target.kind === 'ship') this.fireShell(p, m, target.obj, 'mechAA', { dmg: cfg.mechShipDamage(p), speed: 4 });
          else if (target.kind === 'swarm') { const sh = this.fireShell(p, m, target.obj, 'mech', { speed: 6, life: 60, level: m.level }); sh.swarm = target.obj; }
          else if (target.kind === 'troops') { const sh = this.fireShell(p, m, null, 'mech', { tx: target.x, ty: target.y, speed: 4, life: 80, level: m.level }); sh.attackId = target.attack.id; }
          else this.fireShell(p, m, null, 'mech', { tx: target.x, ty: target.y, structTile: target.structTile ?? -1, dmg: cfg.mechShellDamage(p, m.level), troopKill: cfg.mechTroopKillPerShell(p, m.level), speed: 4, life: 80, level: m.level });
          m.cannonReady = this.tick + (target.kind === 'troops' || target.kind === 'swarm' ? Math.ceil(cfg.mechCannonCooldown(p) / cfg.mechSuppressFactor()) : cfg.mechCannonCooldown(p));
          m.engagedUntil = this.tick + 40;
        } else m.cannonReady = this.tick + 10;
      }
      // ---- stomp: clear hostile land underfoot ----
      if (!barge && this.tick >= m.stompReady && !passive) {
        const r = cfg.mechStompRadius(p);
        let hostileNear = false;
        const ix = Math.floor(m.x), iy = Math.floor(m.y);
        for (let dy = -r; dy <= r && !hostileNear; dy++) for (let dx = -r; dx <= r; dx++) { const x = ix + dx, y = iy + dy; if (!this.valid(x, y)) continue; const q = this.ownerOf(this.ref(x, y)); if (q && this.hostile(p, q)) { hostileNear = true; break; } }
        if (hostileNear) {
          this.mechBreach(p, m.x, m.y, r, cfg.mechTroopKillPerShell(p, m.level) * 0.4, cfg.mechWarBite(p, m.level) / 4);
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
    // Airborne Mechs are the anti-airship answer: an enemy airship in range comes first, always.
    if (R.mechAntiAir(p)) {
      let air = null, ad = r2 * 1.5;
      for (const a of this.airships) {
        if (a.done || !this.hostile(p, a.owner)) continue;
        const d = (a.x - m.x) ** 2 + (a.y - m.y) ** 2;
        if (d < ad) { ad = d; air = a; }
      }
      if (air) return { kind: 'air', obj: air };
    }
    let best = null, bd = Infinity;
    for (const o of this.mechs) { if (o === m || o.done || !this.hostile(p, o.owner)) continue; const d = (o.x - m.x) ** 2 + (o.y - m.y) ** 2; if (d <= r2 && d < bd) { bd = d; best = { x: o.x, y: o.y }; } }
    if (best) return best;
    // a swarm of troops running at us
    for (const s of this.swarms) { if (s.done || !this.hostile(p, s.owner)) continue; const d = (s.x - m.x) ** 2 + (s.y - m.y) ** 2; if (d <= r2 * 1.3 && d < bd) { bd = d; best = { kind: 'swarm', obj: s }; } }
    if (best) return best;
    // an army attacking us or an ally: shell the front of the biggest one in reach
    let most = 0;
    const reach = (r + 8) * (r + 8);
    for (const a of this.attacks) {
      if (a.done || !a.target || !this.hostile(p, a.attacker) || !(a.target === p || p.isFriendly(a.target)) || a.troops <= most) continue;
      // the nearest point of that attack's front we can reach: its marker, or any tile it is about to take
      let fx = -1, fy = -1, fd = reach;
      if (a.markX >= 0) { const d = (a.markX - m.x) ** 2 + (a.markY - m.y) ** 2; if (d <= fd) { fd = d; fx = a.markX; fy = a.markY; } }
      if (fx < 0 && a.border.size) {
        let n = 0;
        const step = Math.max(1, Math.floor(a.border.size / 150));
        for (const t of a.border) {
          if (n++ % step) continue;
          const tx = this.x(t) + 0.5, ty = this.y(t) + 0.5, d = (tx - m.x) ** 2 + (ty - m.y) ** 2;
          if (d <= fd) { fd = d; fx = tx; fy = ty; }
        }
      }
      if (fx >= 0) { most = a.troops; best = { kind: 'troops', attack: a, x: fx, y: fy }; }
    }
    if (best) return best;
    for (const u of this.units) {
      if (!this.hostile(p, u.owner) || u.type === UnitType.MINE) continue;
      const ux = this.x(u.tile) + 0.5, uy = this.y(u.tile) + 0.5;
      const d = (ux - m.x) ** 2 + (uy - m.y) ** 2;
      if (d <= r2 && d < bd) { bd = d; best = { x: ux, y: uy, structTile: u.tile }; }
    }
    if (best) return best;
    if (R.mechAmphibious(p) || m.onWater || this.isShore(this.tileAt(m.x, m.y))) {
      const ship = this.nearestEnemyShip(p, m.x, m.y, r * this.config.mechShipRangeMultiplier(p), true, true);
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
