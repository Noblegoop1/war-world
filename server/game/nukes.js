'use strict';
// Nukes (lobbed along OpenFront's cubic-Bezier arc, blast = BFS with a 50% outer ring like OpenFront),
// SAM interception, MIRV, Nuclear Deterrence, and Strategic Bomber strikes. Mixed into Game.prototype.
const { UnitType, NukeType, PlayerType } = require('./config');
const { newId } = require('./ids');
const { bezierArc, bezierPoint } = require('./path');
const R = require('./research').effects;

module.exports = {
  readySilos(p) { return p.units.filter((u) => u.type === UnitType.SILO && u.constructionLeft === 0 && u.cooldown === 0); },
  canLaunchNuke(p, type, tile) {
    if (!p.alive) return { ok: false, reason: 'dead' };
    if (this.settings.disableNukes) return { ok: false, reason: 'Nukes are disabled' };
    if (!Object.values(NukeType).includes(type)) return { ok: false, reason: 'bad type' };
    if (type === NukeType.CLUSTER && !R.clusterMunitions(p)) return { ok: false, reason: 'Cluster Strikes need the Cluster Munitions research' };
    if (!this.isLand(tile)) return { ok: false, reason: 'Target must be land' };
    const cost = this.config.nukeCost(type, p);
    if (p.gold < cost) return { ok: false, reason: `Not enough gold (need ${Math.floor(cost).toLocaleString()})` };
    const silos = this.readySilos(p);
    // Nuclear Submarines can fire atom bombs from sea
    const subs = type === NukeType.ATOM && p.researches.has('nuclear_subs') ? p.subs.filter((s) => !s.done && s.nukeReady <= this.tick) : [];
    if (!silos.length && !subs.length) return { ok: false, reason: 'You need a ready Missile Silo' };
    let best = null, bestD = Infinity, from = null;
    for (const u of silos) { const d = this.dist(u.tile, tile); if (d < bestD) { bestD = d; best = u; from = { x: this.x(u.tile), y: this.y(u.tile) }; } }
    for (const s of subs) { const d = this.distXY(s.x, s.y, this.x(tile), this.y(tile)); if (d < bestD) { bestD = d; best = s; from = { x: Math.floor(s.x), y: Math.floor(s.y) }; } }
    return { ok: true, cost, launcher: best, from };
  },
  launchNuke(p, type, tile) {
    const c = this.canLaunchNuke(p, type, tile);
    if (!c.ok) return c;
    p.removeGold(c.cost);
    if (c.launcher.kind === 'submarine') c.launcher.nukeReady = this.tick + 900;
    else { c.launcher.cooldown = this.config.siloCooldownTicks(p); this.unitsChanged = true; }
    if (type === NukeType.CLUSTER) {
      // Eight separate missiles, each its own target for a SAM. That is the whole idea: a SAM kills one
      // missile per reload, so a volley gets most of its load through a defence that stops any single bomb.
      const cx = this.x(tile), cy = this.y(tile), spread = this.config.clusterSpread();
      for (let i = 0; i < this.config.clusterCount(); i++) {
        const ang = (i / this.config.clusterCount()) * Math.PI * 2 + this.rng.next() * 0.6;
        const d = i === 0 ? 0 : this.rng.int(4, spread);
        const tx = Math.max(0, Math.min(this.width - 1, Math.round(cx + Math.cos(ang) * d)));
        const ty = Math.max(0, Math.min(this.height - 1, Math.round(cy + Math.sin(ang) * d)));
        const b = this.spawnNuke(p, 'bomblet', c.from.x, c.from.y, tx, ty, this.ref(tx, ty));
        b.arc = bezierArc(c.from.x + 0.5, c.from.y + 0.5, tx + 0.5, ty + 0.5, 25 + i * 3);  // fan the arcs out
      }
    } else this.spawnNuke(p, type, c.from.x, c.from.y, this.x(tile), this.y(tile), tile);
    this.events.push({ k: 'nuke', type, by: p.smallID, tile, target: this.owner[tile] });
    return c;
  },
  spawnNuke(p, type, sx, sy, tx, ty, tile) {
    const arc = bezierArc(sx + 0.5, sy + 0.5, tx + 0.5, ty + 0.5);
    const nuke = { id: newId(), type, owner: p, x: sx + 0.5, y: sy + 0.5, sx, sy, tx, ty, target: tile, arc, t: 0, done: false };
    this.nukes.push(nuke);
    return nuke;
  },
  tickNukes() {
    if (!this.nukes.length) return;
    for (const nk of this.nukes) {
      if (nk.done) continue;
      const speed = this.config.nukeSpeed(nk.owner);
      // SAM interception (only real nukes; MIRV warheads too)
      let intercepted = false;
      for (const u of this.units) {
        if (u.type !== UnitType.SAM || u.constructionLeft > 0 || u.cooldown > 0) continue;
        if (u.owner === nk.owner || u.owner.isFriendly(nk.owner)) continue;
        const dx = this.x(u.tile) - nk.x, dy = this.y(u.tile) - nk.y;
        const r = this.config.samRange(u.owner);
        if (dx * dx + dy * dy <= r * r) {
          // Hypersonic missiles tie the SAM up for longer even when it scores.
          u.cooldown = this.config.samCooldownTicks() * R.samReloadPenalty(nk.owner);
          this.unitsChanged = true;
          // Decoy Warheads: the SAM spends its shot on a decoy and the real missile flies on.
          if (this.rng.next() < R.decoyChance(nk.owner)) { this.events.push({ k: 'decoy', by: u.owner.smallID, x: nk.x, y: nk.y }); break; }
          intercepted = true;
          this.events.push({ k: 'samhit', by: u.owner.smallID, vs: nk.owner.smallID, x: nk.x, y: nk.y });
          break;
        }
      }
      if (intercepted) { nk.done = true; continue; }
      nk.t += speed / nk.arc.length;
      if (nk.t >= 1) { nk.x = nk.tx + 0.5; nk.y = nk.ty + 0.5; nk.done = true; this.detonate(nk); continue; }
      const pt = bezierPoint(nk.arc, nk.t);
      nk.x = pt.x; nk.y = pt.y;
    }
    this.nukes = this.nukes.filter((n) => !n.done);
  },
  // OpenFront blast: BFS from ground zero; a tile is destroyed inside `inner`, or inside `outer` with 50% chance
  // (and only if connected through destroyed tiles, so no isolated pixels).
  blastTiles(cx, cy, inner, outer) {
    const start = this.ref(cx, cy);
    const inner2 = inner * inner, outer2 = outer * outer;
    const out = [];
    const seen = new Set([start]);
    const queue = [start];
    const b = [0, 0, 0, 0];
    while (queue.length) {
      const t = queue.shift();
      const dx = this.x(t) - cx, dy = this.y(t) - cy, d2 = dx * dx + dy * dy;
      if (d2 > outer2) continue;
      if (d2 > inner2 && !this.rng.chance(2)) continue;
      out.push(t);
      const n = this.neighbors4(t, b);
      for (let k = 0; k < n; k++) if (!seen.has(b[k])) { seen.add(b[k]); queue.push(b[k]); }
    }
    return out;
  },
  detonate(nk, isWarhead = false) {
    const { inner, outer } = nk.type === 'warhead' ? { inner: 12, outer: 18 } : this.config.nukeMagnitude(nk.type, nk.owner);
    const small = nk.type === 'bomblet';
    const cx = nk.tx, cy = nk.ty;
    // MIRV: a hydrogen bomb splits into 5 atom-sized warheads instead of one big blast
    if (nk.type === NukeType.HYDROGEN && nk.owner.researches.has('mirv') && !isWarhead) {
      for (let i = 0; i < 5; i++) {
        const ang = this.rng.next() * Math.PI * 2, d = this.rng.int(6, 45);
        const wx = Math.max(0, Math.min(this.width - 1, Math.round(cx + Math.cos(ang) * d))), wy = Math.max(0, Math.min(this.height - 1, Math.round(cy + Math.sin(ang) * d)));
        const w = this.spawnNuke(nk.owner, 'warhead', cx, cy, wx, wy, this.ref(wx, wy));
        w.arc = bezierArc(cx + 0.5, cy + 0.5, wx + 0.5, wy + 0.5, 12);
      }
      this.events.push({ k: 'mirvSplit', x: cx, y: cy, by: nk.owner.smallID });
      return;
    }
    const hitTiles = new Map(), before = new Map();
    const hardenedSpared = new Set();
    for (const t of this.blastTiles(cx, cy, inner, outer)) {
      if (!this.isLand(t)) continue;
      const sm = this.owner[t];
      const d2 = (this.x(t) - cx) ** 2 + (this.y(t) - cy) ** 2;
      const u = this.unitAt(t);
      if (u && u.owner.researches.has('hardened_infra') && d2 > inner * inner) { hardenedSpared.add(t); continue; } // structure + its tile survive
      if (sm !== 0) {
        const q = this.playersBySmall[sm];
        if (!before.has(sm)) before.set(sm, q.numTiles);
        hitTiles.set(sm, (hitTiles.get(sm) || 0) + 1);
        this.relinquish(t);
      }
      this.addFallout(t, this.config.falloutDuration(nk.type));
      if (u) this.removeUnit(u);
    }
    for (const [sm, count] of hitTiles) {
      const q = this.playersBySmall[sm];
      const owned = Math.max(1, before.get(sm));
      // Population dies with the ground. Per-tile death factor (OpenFront's shape), capped so a single
      // bomb can cripple but not instantly delete an army, and applied to troops in transit too.
      const perTile = this.config.nukeDeathFactor(q.troops, owned);
      const killed = Math.min(q.troops * this.config.nukeMaxTroopLoss(), perTile * count);
      q.removeTroops(killed);
      const share = q.troops > 0 ? Math.min(0.9, killed / (q.troops + killed)) : 0.5;
      for (const a of q.outgoingAttacks) if (!a.done) a.troops *= 1 - share;
      for (const b of q.boats) if (!b.done) b.troops *= 1 - share;
      q.updateRelation(nk.owner, -100);
      q.lastNukedBy = nk.owner;
      if (q !== nk.owner && q.allies.has(nk.owner.id) && count >= 100) this.breakAlliance(nk.owner, q);
      // Nuclear Deterrence: automatic atom-bomb reply
      if (q !== nk.owner && q.alive && q.researches.has('nuclear_deterrence') && nk.owner.alive && this.readySilos(q).length && q.gold >= this.config.nukeCost(NukeType.ATOM, q)) {
        const targets = nk.owner.units.filter((u) => u.type === UnitType.SILO).concat(nk.owner.units.filter((u) => u.type === UnitType.CITY));
        if (targets.length) { const tt = targets[0].tile; const r = this.launchNuke(q, NukeType.ATOM, tt); if (r.ok) this.events.push({ k: 'deterrence', by: q.smallID, at: nk.owner.smallID }); }
      }
    }
    this.razeWallsAround(cx, cy, outer);
    for (const m of this.mechs) {
      if (m.done) continue;
      const d = Math.hypot(m.x - cx, m.y - cy);
      if (small) { if (d <= outer) m.hp -= m.maxHp * 0.08; continue; }
      if (d <= inner) m.hp = 0; else if (d <= outer) m.hp -= m.maxHp * (1 - (d - inner) / (outer - inner)) * 0.8;
    }
    for (const list of [this.warships, this.subs, this.boats, this.tradeShips]) for (const s of list) { if (s.done) continue; if (Math.hypot(s.x - cx, s.y - cy) <= outer) this.damageShip(s, small ? 250 : 5000, nk.owner); }
    this.events.push({ k: 'boom', type: nk.type, x: cx, y: cy, by: nk.owner.smallID });
  },

  // ---- Strategic Bombers -----------------------------------------------------------
  canLaunchBomber(p, tile) {
    if (!p.alive) return { ok: false, reason: 'dead' };
    if (!p.researches.has('strategic_bombers')) return { ok: false, reason: 'Needs the Strategic Bombers research' };
    const u = this.unitAt(tile);
    if (!u || !this.hostile(p, u.owner)) return { ok: false, reason: 'Aim at an enemy structure' };
    const silos = p.completedUnitsOf(UnitType.SILO);
    if (!silos.length) return { ok: false, reason: 'Bombers launch from a Missile Silo' };
    silos.sort((a, b) => this.dist(a.tile, tile) - this.dist(b.tile, tile));
    if (this.dist(silos[0].tile, tile) > this.config.bomberRange()) return { ok: false, reason: `Out of range (${this.config.bomberRange()} tiles from a silo)` };
    const cost = this.config.bomberCost();
    if (p.gold < cost) return { ok: false, reason: `Not enough gold (need ${cost.toLocaleString()})` };
    return { ok: true, cost, silo: silos[0], target: u };
  },
  launchBomber(p, tile) {
    const c = this.canLaunchBomber(p, tile);
    if (!c.ok) return c;
    p.removeGold(c.cost);
    this.bombers.push({ id: newId(), owner: p, x: this.x(c.silo.tile) + 0.5, y: this.y(c.silo.tile) + 0.5, tx: this.x(tile) + 0.5, ty: this.y(tile) + 0.5, targetTile: tile, done: false, checkedOwner: null });
    this.events.push({ k: 'bomber', by: p.smallID, target: c.target.owner.smallID });
    return c;
  },
  tickBombers() {
    if (!this.bombers.length) return;
    const sp = this.config.bomberSpeed();
    for (const b of this.bombers) {
      if (b.done) continue;
      const dx = b.tx - b.x, dy = b.ty - b.y, d = Math.hypot(dx, dy);
      if (d <= sp) {
        b.done = true;
        const u = this.unitAt(b.targetTile);
        if (u && this.hostile(b.owner, u.owner)) { this.events.push({ k: 'structHit', p: u.owner.smallID, type: u.type, x: this.x(u.tile), y: this.y(u.tile) }); this.removeUnit(u); this.neutralizeArea(b.owner, b.tx, b.ty, 2, 4000, 'bomb'); }
        continue;
      }
      b.x += (dx / d) * sp; b.y += (dy / d) * sp;
      // Fighter Networks: each second over a defended nation's land, 60%/5 chance of being shot down (~60% over a crossing)
      const o = this.ownerOf(this.tileAt(b.x, b.y));
      if (o && o !== b.checkedOwner) b.checkedOwner = o;
      const tgt = this.unitAt(b.targetTile);
      const immune = R.sead(b.owner) && tgt && tgt.type === UnitType.SAM;
      if (!immune && o && this.hostile(b.owner, o) && o.researches.has('fighter_networks') && this.tick % 10 === 0 && this.rng.next() < 0.18) {
        b.done = true;
        this.events.push({ k: 'bomberDown', by: o.smallID, x: b.x, y: b.y });
      }
    }
    this.bombers = this.bombers.filter((b) => !b.done);
  },
};
