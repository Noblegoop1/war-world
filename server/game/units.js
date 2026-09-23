'use strict';
// Structures (cities, ports, factories, labs, defense posts, silos, SAMs, mines), walls, and research.
// Mixed into Game.prototype.
const { UnitType, STRUCTURE_TYPES, PlayerType, TICKS_PER_SECOND, RESEARCH, RESEARCH_BY_ID } = require('./config');
const { newId } = require('./ids');
const R = require('./research').effects;

module.exports = {
  // ---- structures ---------------------------------------------------------------
  unitAt(tile) { return this.unitByTile.get(tile) || null; },
  populationCount(p) { return p.completedUnitsOf(UnitType.CITY).length; },
  hasPopulationNear(tile, r) {
    const x = this.x(tile), y = this.y(tile);
    for (const u of this.units) {
      if (u.type !== UnitType.CITY) continue;
      if (Math.abs(this.x(u.tile) - x) <= r && Math.abs(this.y(u.tile) - y) <= r) return true;
    }
    return false;
  },
  unitNear(tile, r) {
    const x = this.x(tile), y = this.y(tile);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (!this.valid(x + dx, y + dy)) continue;
      const u = this.unitByTile.get(this.ref(x + dx, y + dy));
      if (u) return u;
    }
    return null;
  },
  factoryInRange(tile, range) {
    for (const u of this.units) if (u.type === UnitType.FACTORY && u.constructionLeft === 0 && this.dist(u.tile, tile) <= range) return u;
    return null;
  },
  costIndex(p, type) {
    // ports and factories share a price ladder (OpenFront)
    if (type === UnitType.PORT || type === UnitType.FACTORY) return p.unitsOf(UnitType.PORT).length + p.unitsOf(UnitType.FACTORY).length;
    return p.unitsOf(type).length;
  },
  canBuild(p, type, tile) {
    if (!p.alive) return { ok: false, reason: 'dead' };
    if (!STRUCTURE_TYPES.includes(type)) return { ok: false, reason: 'bad type' };
    if (type === UnitType.MINE) {
      if (!p.researches.has('naval_mines')) return { ok: false, reason: 'Needs the Naval Mines research' };
      if (!this.isWater(tile)) return { ok: false, reason: 'Mines go in the water' };
      if (this.unitAt(tile) || this.unitNear(tile, 3)) return { ok: false, reason: 'Too close to another mine' };
      const cost = this.config.unitCost(type, p.unitsOf(type).length, p);
      if (p.gold < cost) return { ok: false, reason: `Not enough gold (need ${Math.floor(cost).toLocaleString()})` };
      // must be near your own coast or port so mines defend something
      let near = false;
      for (const u of p.units) if (u.type === UnitType.PORT && this.dist(u.tile, tile) <= 60) { near = true; break; }
      if (!near) return { ok: false, reason: 'Mines must be within 60 tiles of one of your ports' };
      return { ok: true, cost, upgrade: null };
    }
    if (this.owner[tile] !== p.smallID) return { ok: false, reason: 'You must own the tile' };
    if (this.wallHp[tile]) return { ok: false, reason: 'A wall is in the way' };
    if (type === UnitType.PORT && !this.isOceanShore(tile)) return { ok: false, reason: 'Ports must be built on the sea coast' };
    if (this.settings.disableNukes && (type === UnitType.SILO || type === UnitType.SAM)) return { ok: false, reason: 'Nukes are disabled' };
    if (type === UnitType.AIRPORT && p.unitsOf(UnitType.AIRPORT).length >= this.config.maxAirports()) return { ok: false, reason: 'You may only have one Airport' };
    const conflict = this.samAirportConflict(p, type, tile);
    if (conflict) return { ok: false, reason: conflict };
    if (type === UnitType.REPAIR && !p.researches.has('field_engineering')) return { ok: false, reason: 'Needs the Field Engineering research' };
    if (type === UnitType.LAB) {
      if (this.populationCount(p) < this.config.populationRequiredForLab()) return { ok: false, reason: `Research Labs need ${this.config.populationRequiredForLab()} Cities first` };
      if (this.hasPopulationNear(tile, this.config.labMinGapFromPopulation())) return { ok: false, reason: 'Labs must be away from your Cities' };
      if (!this.factoryInRange(tile, this.config.trainStationMaxRange())) return { ok: false, reason: 'Labs must be within rail range (110 tiles) of a Factory' };
      if (p.researchCount() >= this.config.maxResearchesPerPlayer(p) + this.config.researchesPerLab()) return { ok: false, reason: 'Finish the doctrines you already have room for first' };
    }
    const existing = this.unitAt(tile);
    let upgrade = null;
    const upgradable = type === UnitType.CITY || type === UnitType.PORT || type === UnitType.FACTORY;
    if (existing) {
      if (existing.owner === p && existing.type === type && upgradable && existing.constructionLeft === 0) {
        if (existing.level >= this.config.maxUnitLevel(p, type)) return { ok: false, reason: `${type} is at its maximum level (${existing.level})` };
        upgrade = existing;
      }
      else if (!upgrade) return { ok: false, reason: 'Tile already has a structure' };
    } else if (this.unitNear(tile, 2)) return { ok: false, reason: 'Too close to another structure' };
    const count = upgrade ? p.unitLevels(type) : this.costIndex(p, type);
    const cost = this.config.unitCost(type, count, p);
    if (p.gold < cost) return { ok: false, reason: `Not enough gold (need ${Math.floor(cost).toLocaleString()})` };
    return { ok: true, cost, upgrade };
  },
  build(p, type, tile) {
    const c = this.canBuild(p, type, tile);
    if (!c.ok) return c;
    p.removeGold(c.cost);
    if (c.upgrade) { c.upgrade.level++; if (c.upgrade.type === UnitType.FACTORY) this.events.push({ k: 'factoryUp', p: p.smallID, level: c.upgrade.level }); }
    else {
      const u = { id: newId(), type, owner: p, tile, level: 1, constructionLeft: this.config.constructionTicks(type), cooldown: 0, garrison: 0, station: false, shellReady: 0 };
      this.units.push(u);
      this.unitByTile.set(tile, u);
      p.units.push(u);
      if (u.constructionLeft === 0) this.onUnitCompleted(u);
      if (type === UnitType.LAB) this.events.push({ k: 'labBuilt', p: p.smallID });
    }
    this.unitsChanged = true;
    return c;
  },
  onUnitCompleted(u) {
    if (u.type === UnitType.FACTORY || u.type === UnitType.CITY || u.type === UnitType.PORT || u.type === UnitType.LAB) this.railConnect(u);
  },
  // Defensive Position: garrison 10% of your troops into a post to make it hit harder.
  reinforcePost(p, tile) {
    const u = this.unitAt(tile);
    if (!u || u.owner !== p || u.type !== UnitType.DEFENSE_POST) return { ok: false, reason: 'Not your defense post' };
    if (!p.researches.has('defensive_position')) return { ok: false, reason: 'Needs the Defensive Position research' };
    const n = p.removeTroops(p.troops * 0.1);
    u.garrison = (u.garrison || 0) + n;
    this.unitsChanged = true;
    return { ok: true, added: n };
  },
  // Only a post that can see open water shoots at ships. Cached: neither the coast nor the post moves.
  isCoastalPost(u) {
    if (u.coastal !== undefined) return u.coastal;
    const r = this.config.defensePostCoastRange(), x = this.x(u.tile), y = this.y(u.tile);
    u.coastal = false;
    for (let dy = -r; dy <= r && !u.coastal; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx, ny = y + dy;
        if (!this.valid(nx, ny) || dx * dx + dy * dy > r * r) continue;
        if (this.isOcean(this.ref(nx, ny))) { u.coastal = true; break; }
      }
    }
    return u.coastal;
  },
  // Artillery Battery: a static gun that answers what troops cannot — enemy mechs sitting on your
  // border — and drops shells on whichever attack front is closest. Slow reload, big hit.
  tickArtillery() {
    if (this.tick % 5 !== 0) return;
    for (const p of this.players) {
      if (!p.alive) continue;
      const guns = p.completedUnitsOf(UnitType.ARTILLERY);
      if (!guns.length) continue;
      const range = this.config.artilleryRange(p), reload = this.config.artilleryReload(p);
      for (const u of guns) {
        if (u.shellReady > this.tick) continue;
        const gx = this.x(u.tile) + 0.5, gy = this.y(u.tile) + 0.5;
        // hostile mechs first: this is the unit's whole reason to exist
        let target = null, bd = range * range;
        for (const m of this.mechs) {
          if (m.done || !this.hostile(p, m.owner)) continue;
          const d = (m.x - gx) ** 2 + (m.y - gy) ** 2;
          if (d < bd) { bd = d; target = { x: m.x, y: m.y, mech: true }; }
        }
        if (!target) {
          // then enemy warships in reach, then whichever attack is closest
          const ship = this.nearestEnemyShip(p, gx, gy, range, true);
          if (ship) target = { x: ship.x, y: ship.y, ship };
        }
        if (!target) {
          for (const a of p.incomingAttacks) {
            if (a.done || a.markX < 0) continue;
            const d = (a.markX - gx) ** 2 + (a.markY - gy) ** 2;
            if (d < bd) { bd = d; target = { x: a.markX, y: a.markY }; }
          }
        }
        if (!target) continue;
        this.fireShell(p, u.tile, target.ship || null, 'artillery', {
          tx: target.x, ty: target.y, speed: 2.5, life: 200,
          troopKill: this.config.artilleryTroopKill(p),
          radius: this.config.artilleryBlastRadius(),
        });
        u.shellReady = this.tick + reload;
      }
    }
  },
  // Repair Yard: patches up mechs and walls in range. Needs Field Engineering.
  tickRepairYards() {
    const every = this.config.repairInterval();
    if (this.tick % every !== 0) return;
    for (const p of this.players) {
      if (!p.alive) continue;
      const yards = p.completedUnitsOf(UnitType.REPAIR);
      if (!yards.length) continue;
      const range = this.config.repairRange();
      for (const u of yards) {
        const ux = this.x(u.tile), uy = this.y(u.tile);
        for (const m of p.mechs) {
          if (m.done || m.hp >= m.maxHp) continue;
          if ((m.x - ux) ** 2 + (m.y - uy) ** 2 > range * range) continue;
          m.hp = Math.min(m.maxHp, m.hp + m.maxHp * this.config.repairMechPercent());
        }
        if (!p.numWallTiles) continue;
        // walk a ring of the owner's damaged wall tiles and top them up
        const maxHp = this.config.wallMaxHp();
        let budget = this.config.repairWallTilesPerPass(), per = this.config.repairWallAmount();
        for (let dy = -range; dy <= range && budget > 0; dy += 2) {
          for (let dx = -range; dx <= range && budget > 0; dx += 2) {
            const x = ux + dx, y = uy + dy;
            if (!this.valid(x, y) || dx * dx + dy * dy > range * range) continue;
            const t = this.ref(x, y);
            if (!this.wallHp[t] || this.wallHp[t] >= maxHp || this.owner[t] !== p.smallID) continue;
            this.wallHp[t] = Math.min(maxHp, this.wallHp[t] + per);
            budget--;
          }
        }
      }
    }
  },
  // Defense posts: shell enemy ships within range (OpenFront) and, with Defensive Position, hit land attackers.
  tickDefensePosts() {
    if (this.tick % 5 !== 0) return;
    for (const p of this.players) {
      if (!p.alive) continue;
      const posts = p.completedUnitsOf(UnitType.DEFENSE_POST);
      if (!posts.length) continue;
      const shipRange = this.config.defensePostShipRange(p), rate = this.config.defensePostShellRate(p);
      const dmg = this.config.defensePostShipDamage(p);
      for (const u of posts) {
        if (u.shellReady > this.tick) continue;
        if (!this.isCoastalPost(u)) continue;   // inland forts have no line on the sea
        const target = this.nearestEnemyShip(p, this.x(u.tile) + 0.5, this.y(u.tile) + 0.5, shipRange, true);
        if (target) { this.fireShell(p, u.tile, target, 'post', { dmg }); u.shellReady = this.tick + rate; }
      }
      if (p.researches.has('defensive_position') && p.incomingAttacks.length && this.tick % 10 === 0) {
        const r = this.config.defensePostRange();
        for (const a of p.incomingAttacks) {
          if (a.done) continue;
          let inRange = null, n = 0;
          for (const t of a.border) { if (n++ > 40) break; inRange = posts.find((u) => this.dist(u.tile, t) <= r); if (inRange) break; }
          if (inRange) {
            const hit = (p.troops * 0.15 + (inRange.garrison || 0) * 0.5) * 0.1;
            a.troops = Math.max(0, a.troops - hit);
            inRange.garrison = Math.max(0, (inRange.garrison || 0) - hit * 0.05);
          }
        }
      }
    }
  },

  // ---- walls ----------------------------------------------------------------------
  // Walls are 3 tiles thick: every point of the drawn line becomes a 3x3 block. Blocks are built one at a
  // time (slowest construction in the game). Enemies must grind each tile's HP down; nukes raze them.
  clearWallTile(t) {
    if (!this.wallHp[t]) return;
    const o = this.ownerOf(t);
    if (o) o.numWallTiles = Math.max(0, o.numWallTiles - 1);
    this.wallHp[t] = 0;
    this.changedTiles.push(t);
  },
  wallBlockTiles(center) {
    const cx = this.x(center), cy = this.y(center), out = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (this.valid(cx + dx, cy + dy)) out.push(this.ref(cx + dx, cy + dy));
    return out;
  },
  // Assisted drawing: if an endpoint is near the coast (or an existing wall) extend the line so the wall seals it.
  snapWallEndpoint(p, tile, other) {
    const W = this.width;
    const seen = new Set([tile]);
    let frontier = [tile];
    const b = [0, 0, 0, 0];
    for (let d = 0; d < 5 && frontier.length; d++) {
      const next = [];
      for (const t of frontier) {
        const n = this.neighbors4(t, b);
        for (let k = 0; k < n; k++) {
          const nb = b[k];
          if (seen.has(nb)) continue;
          seen.add(nb);
          if (this.owner[nb] !== p.smallID) {
            if (this.isWater(nb) || this.wallHp[nb]) return t; // reached the coast / a wall: stop at the last owned tile
            continue;
          }
          if (this.wallHp[nb]) return nb;
          next.push(nb);
        }
      }
      frontier = next;
    }
    void W; void other;
    return tile;
  },
  linePoints(a, b) {
    // 8-connected Bresenham between two tiles
    let x0 = this.x(a), y0 = this.y(a); const x1 = this.x(b), y1 = this.y(b);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy; const out = [];
    for (let i = 0; i < 2000; i++) {
      out.push(this.ref(x0, y0));
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    return out;
  },
  // Turn a drawn polyline (waypoints) into the exact 3-thick tile set, with coast snapping at both ends.
  planWall(p, waypoints, snap = true) {
    if (!Array.isArray(waypoints) || !waypoints.length) return { ok: false, reason: 'Bad wall' };
    const pts = waypoints.map(Number).filter((t) => Number.isInteger(t) && t >= 0 && t < this.terrain.length).slice(0, 200);
    if (!pts.length) return { ok: false, reason: 'Bad wall' };
    if (snap) { pts[0] = this.snapWallEndpoint(p, pts[0]); pts[pts.length - 1] = this.snapWallEndpoint(p, pts[pts.length - 1]); }
    const spine = [];
    for (let i = 0; i < pts.length; i++) {
      if (i === 0) { spine.push(pts[0]); continue; }
      const seg = this.linePoints(pts[i - 1], pts[i]);
      for (let k = 1; k < seg.length; k++) spine.push(seg[k]);
    }
    if (spine.length > 400) return { ok: false, reason: 'Wall too long (max 400 tiles)' };
    const tiles = new Set();
    for (const c of spine) for (const t of this.wallBlockTiles(c)) if (this.isLand(t) && this.owner[t] === p.smallID && !this.unitByTile.has(t) && !this.wallHp[t]) tiles.add(t);
    if (!tiles.size) return { ok: false, reason: 'Draw the wall on your own land' };
    for (const t of tiles) if (this.hasPopulationNear(t, this.config.structureMinGap())) return { ok: false, reason: 'Walls cannot be built right next to a City' };
    // blocks in draw order for sequential construction
    const blocks = [];
    const used = new Set();
    for (const c of spine) { const bt = this.wallBlockTiles(c).filter((t) => tiles.has(t) && !used.has(t)); if (bt.length) { blocks.push(bt); for (const t of bt) used.add(t); } }
    let cost = 0;
    let n = p.numWallTiles + p.wallQueue.reduce((s, b) => s + b.tiles.length, 0);
    for (const t of tiles) { cost += this.config.wallTileCost(n++, p); void t; }
    return { ok: true, cost: Math.floor(cost), tiles: [...tiles], blocks, spine };
  },
  buildWall(p, waypoints) {
    if (!p.alive) return { ok: false, reason: 'dead' };
    const plan = this.planWall(p, waypoints);
    if (!plan.ok) return plan;
    if (p.gold < plan.cost) return { ok: false, reason: `Not enough gold (need ${plan.cost.toLocaleString()})` };
    p.removeGold(plan.cost);
    for (const bt of plan.blocks) {
      for (const t of bt) { this.wallHp[t] = 1; this.changedTiles.push(t); } // reserved + visible; HP ramps during construction
      p.numWallTiles += bt.length;
      p.wallQueue.push({ tiles: bt, progress: 0 });
    }
    return plan;
  },
  tickWalls() {
    const max = this.config.wallMaxHp(), ticks = this.config.wallBuildTicks();
    for (const p of this.players) {
      if (!p.wallQueue.length) continue;
      const blk = p.wallQueue[0];
      blk.progress++;
      const hp = Math.max(1, Math.floor((max * blk.progress) / ticks));
      let alive = false;
      for (const t of blk.tiles) if (this.owner[t] === p.smallID && this.wallHp[t] > 0) { this.wallHp[t] = Math.max(this.wallHp[t], Math.min(max, hp)); alive = true; }
      if (blk.progress >= ticks || !alive) { p.wallQueue.shift(); for (const t of blk.tiles) this.changedTiles.push(t); }
    }
  },
  razeWallsAround(cx, cy, r) {
    for (let y = Math.max(0, cy - r); y <= Math.min(this.height - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(this.width - 1, cx + r); x++) {
        const t = this.ref(x, y);
        if (this.wallHp[t] && (x - cx) ** 2 + (y - cy) ** 2 <= r * r) this.clearWallTile(t);
      }
    }
  },
  damageWallsAround(cx, cy, r, dmg) {
    for (let y = Math.max(0, cy - r); y <= Math.min(this.height - 1, cy + r); y++) {
      for (let x = Math.max(0, cx - r); x <= Math.min(this.width - 1, cx + r); x++) {
        const t = this.ref(x, y);
        if (!this.wallHp[t] || (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const o = this.ownerOf(t);
        const d = dmg * (o ? R.wallDamageMultiplier(o) : 1);
        if (this.wallHp[t] <= d) this.clearWallTile(t); else this.wallHp[t] -= d;
      }
    }
  },

  // ---- research ------------------------------------------------------------------
  labReady(p) { return p.completedUnitsOf(UnitType.LAB).find((u) => u.cooldown === 0) || null; },
  offerResearch(p, lab) {
    if (p.research || p.pendingChoices || p.researchCount() >= this.config.maxResearchesPerPlayer(p)) return false;
    const taken = p.researches;
    const pool = RESEARCH.filter((r) => !taken.has(r.id) && !(r.id === 'nuclear_subs' && !taken.has('submarine_warfare')));
    if (pool.length < 3) return false;
    const choices = [];
    const bag = [...pool];
    while (choices.length < 3 && bag.length) { const i = this.rng.int(0, bag.length - 1); choices.push(bag[i].id); bag.splice(i, 1); }
    p.pendingChoices = { labId: lab.id, choices };
    if (p.type === PlayerType.HUMAN) this.events.push({ k: 'researchOffer', to: p.id, choices });
    else if (p.ai && p.ai.pickResearch) this.pickResearch(p, p.ai.pickResearch(choices));
    return true;
  },
  pickResearch(p, id) {
    if (!p.pendingChoices || !p.pendingChoices.choices.includes(id)) return { ok: false, reason: 'Not an offered research' };
    const lab = this.units.find((u) => u.id === p.pendingChoices.labId);
    const tier = (RESEARCH_BY_ID[id] && RESEARCH_BY_ID[id].tier) || 2;
    const ticks = this.config.labResearchTicks(tier);
    p.research = { id, doneTick: this.tick + ticks, labId: p.pendingChoices.labId };
    p.pendingChoices = null;
    if (lab) { lab.cooldown = ticks + this.config.labCooldownTicks(); this.unitsChanged = true; }
    this.events.push({ k: 'researchStart', p: p.smallID, id });
    return { ok: true };
  },
  // A doctrine is only as safe as the building working on it. Lose the lab - bombed, nuked or overrun -
  // and the work stops; the slot is free again but the progress is gone.
  onLabLost(u) {
    const p = u.owner;
    if (p.pendingChoices && p.pendingChoices.labId === u.id) p.pendingChoices = null;
    if (p.research && p.research.labId === u.id) {
      this.events.push({ k: 'researchLost', p: p.smallID, id: p.research.id });
      p.research = null;
      this.unitsChanged = true;
    }
  },
  tickResearch() {
    for (const p of this.players) {
      if (!p.alive) continue;
      if (p.research && this.tick >= p.research.doneTick) {
        p.researches.add(p.research.id);
        this.events.push({ k: 'researchDone', p: p.smallID, id: p.research.id });
        p.research = null;
        this.unitsChanged = true;
        if (p.ai && p.ai.onResearch) p.ai.onResearch();
      }
      if (!p.research && !p.pendingChoices && p.researchCount() < this.config.maxResearchesPerPlayer(p) && this.tick % 10 === 0) {
        const lab = this.labReady(p);
        if (lab) this.offerResearch(p, lab);
      }
    }
  },
};
