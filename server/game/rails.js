'use strict';
// Factories, rail network and trains (OpenFront's system): a Factory becomes a train station and pulls every
// City / Port / Factory / Lab within 110 tiles into the rail network. Trains spawn at factories, ride the rails
// to another station in the same connected cluster and pay gold on arrival (more for other nations, most for allies).
// Level-2+ factories also produce Mechs (see mechs.js). Mixed into Game.prototype.
const { UnitType } = require('./config');
const { newId } = require('./ids');
const { astar, resamplePath } = require('./path');
const R = require('./research').effects;

const STATION_TYPES = [UnitType.CITY, UnitType.PORT, UnitType.FACTORY, UnitType.LAB];

module.exports = {
  // Rails prefer land; water costs 6x (bridges), impassable is blocked. 8-connected so tracks run on straight diagonals.
  railCost(t) { if (!this.isLand(t)) return this.isWater(t) ? 6 : 0; return this.wallHp[t] ? 0 : 1; },
  railNeighbors(u) { return this.railAdj.get(u.id) || new Set(); },
  isStationType(u) { return STATION_TYPES.includes(u.type); },
  // Called when a structure finishes building. A Factory is a station and drags every City/Port/Lab/
  // Factory in range into the network; anything else joins an existing network if a Factory reaches it.
  // Distance only has to clear `railMinRange` (a couple of tiles) — a City built right next to its
  // Factory still gets track. `trainStationMinRange` is not a connection rule, it only biases where
  // trains choose to go, so a tight cluster of buildings is wired up instead of being left orphaned.
  railConnect(u) {
    if (!this.isStationType(u) || u.station) return;
    const range = this.config.trainStationMaxRange();
    const min = this.config.railMinRange();
    const inRange = (o) => { const d = this.dist(o.tile, u.tile); return d <= range && d >= min; };
    const makeStation = (o) => { if (!o.station) { o.station = true; this.railAdj.set(o.id, new Set()); } };
    if (u.type === UnitType.FACTORY) {
      makeStation(u);
      const near = this.units.filter((o) => o !== u && this.isStationType(o) && o.constructionLeft === 0 && inRange(o));
      near.sort((a, b) => this.dist(a.tile, u.tile) - this.dist(b.tile, u.tile));
      // link the nearest two now, queue the rest (A* is spread over later ticks)
      near.slice(0, 8).forEach((o, i) => { makeStation(o); if (i < 2) this.layRail(u, o); else (this.railQueue ||= []).push([u, o]); });
      this.unitsChanged = true; this.railsChanged = true;
      return;
    }
    // Not a factory: join the nearest factories in range, then mesh with a couple of their stations.
    const factories = this.units.filter((o) => o.type === UnitType.FACTORY && o.station && inRange(o));
    if (!factories.length) return;
    makeStation(u);
    factories.sort((a, b) => this.dist(a.tile, u.tile) - this.dist(b.tile, u.tile));
    factories.slice(0, 2).forEach((f, i) => { if (i === 0) this.layRail(u, f); else (this.railQueue ||= []).push([u, f]); });
    const others = this.units.filter((o) => o !== u && o.station && o.type !== UnitType.FACTORY && inRange(o) && this.dist(o.tile, u.tile) <= range * 0.6);
    others.sort((a, b) => this.dist(a.tile, u.tile) - this.dist(b.tile, u.tile));
    for (const o of others.slice(0, 2)) (this.railQueue ||= []).push([u, o]);
    this.unitsChanged = true; this.railsChanged = true;
  },
  layRail(a, b) {
    if (this.railNeighbors(a).has(b.id)) return true;
    const path = astar(this, [a.tile], b.tile, (t) => this.railCost(t), { diag: true, maxIter: 60000 });
    if (!path || path.length > this.config.railroadMaxSize()) return false;
    const r = { id: newId(), a, b, tiles: path };
    this.rails.push(r);
    this.railNeighbors(a).add(b.id); this.railNeighbors(b).add(a.id);
    this.railsChanged = true;
    return true;
  },
  onUnitRemoved(u) {
    if (!u.station) return;
    this.rails = this.rails.filter((r) => { if (r.a === u || r.b === u) { this.railNeighbors(r.a).delete(r.b.id); this.railNeighbors(r.b).delete(r.a.id); return false; } return true; });
    this.railAdj.delete(u.id);
    u.station = false;
    this.railsChanged = true;
    for (const t of this.trains) if (t.a === u || t.b === u) t.done = true;
  },
  onStationOwnerChanged(u) { void u; this.railsChanged = true; },
  unitById(id) { return this.units.find((u) => u.id === id) || null; },
  // Stations reachable from `u` over rails (BFS on the station graph).
  railCluster(u) {
    const seen = new Set([u.id]);
    const out = [];
    const queue = [u];
    while (queue.length) {
      const cur = queue.shift();
      out.push(cur);
      for (const id of this.railNeighbors(cur)) { if (seen.has(id)) continue; seen.add(id); const o = this.unitById(id); if (o) queue.push(o); }
    }
    return out;
  },
  railRoute(from, to) {
    // BFS over stations, then stitch rail tile paths
    const prev = new Map([[from.id, null]]);
    const queue = [from];
    let found = false;
    while (queue.length) {
      const cur = queue.shift();
      if (cur === to) { found = true; break; }
      for (const id of this.railNeighbors(cur)) { if (prev.has(id)) continue; prev.set(id, cur); const o = this.unitById(id); if (o) queue.push(o); }
    }
    if (!found) return null;
    const stations = [];
    for (let s = to; s; s = prev.get(s.id)) stations.push(s);
    stations.reverse();
    const tiles = [];
    for (let i = 1; i < stations.length; i++) {
      const r = this.rails.find((x) => (x.a === stations[i - 1] && x.b === stations[i]) || (x.b === stations[i - 1] && x.a === stations[i]));
      if (!r) return null;
      const seg = r.a === stations[i - 1] ? r.tiles : [...r.tiles].reverse();
      for (let k = i === 1 ? 0 : 1; k < seg.length; k++) tiles.push(seg[k]);
    }
    return { tiles, stops: stations.length - 1 };
  },
  tickTrains() {
    const cfg = this.config;
    if (this.railQueue && this.railQueue.length) { const [a, b] = this.railQueue.shift(); if (this.units.includes(a) && this.units.includes(b)) this.layRail(a, b); }
    if (this.tick % 5 === 0) {
      for (const p of this.players) {
        if (!p.alive) continue;
        const factories = p.completedUnitsOf(UnitType.FACTORY).filter((f) => f.station);
        p.connectedFactories = factories.filter((f) => this.railNeighbors(f).size > 0).length;
        if (!factories.length) continue;
        const rate = cfg.trainSpawnRate(factories.length) / R.trainRateMultiplier(p);
        for (const f of factories) {
          if (this.railNeighbors(f).size === 0) continue;
          // chance per 5 ticks scaled so the expected interval matches `rate` ticks per level
          if (this.rng.next() >= (5 * f.level) / rate) continue;
          const all = this.railCluster(f).filter((s) => s !== f);
          if (!all.length) continue;
          // prefer somewhere actually worth the trip; a tight cluster still runs short shuttles
          const far = all.filter((s) => this.dist(s.tile, f.tile) >= cfg.trainStationMinRange());
          const cluster = far.length ? far : all;
          const foreign = cluster.filter((s) => s.owner !== p && !s.owner.incomingAttacks.some((a) => a.attacker === p) && !p.incomingAttacks.some((a) => a.attacker === s.owner));
          const pool = foreign.length && this.rng.chance(3) === false ? foreign : cluster;
          const dst = pool[this.rng.int(0, pool.length - 1)];
          const route = this.railRoute(f, dst);
          if (!route || route.tiles.length < 2) continue;
          const pts = resamplePath(this, route.tiles, 1);
          const cars = [];
          for (let i = 0; i < 4; i++) cars.push({ x: pts[0].x, y: pts[0].y });
          this.trains.push({ id: newId(), owner: p, a: f, b: dst, pts, idx: 0, x: pts[0].x, y: pts[0].y, cars, stops: route.stops, done: false });
        }
      }
    }
    if (!this.trains.length) return;
    const speed = cfg.trainSpeed();
    for (const t of this.trains) {
      if (t.done) continue;
      if (!t.owner.alive || !this.units.includes(t.b)) { t.done = true; continue; }
      const arrived = this.advanceAlong(t, speed);
      for (let i = 0; i < t.cars.length; i++) { const k = Math.max(0, Math.floor(t.idx - (i + 1) * 3)); const p = t.pts[k]; t.cars[i].x = p.x; t.cars[i].y = p.y; }
      if (!arrived) continue;
      t.done = true;
      const dstOwner = t.b.owner;
      const rel = dstOwner === t.owner ? 'self' : t.owner.isFriendly(dstOwner) ? 'ally' : 'other';
      const gold = Math.floor(cfg.trainGold(rel, t.stops) * R.trainGoldMultiplier(t.owner) * cfg.factoryEfficiency(t.a.level));
      t.owner.addGold(gold, 'train');
      if (dstOwner !== t.owner) dstOwner.addGold(Math.floor(gold * 0.5), 'train');
      if (t.owner.type === 'human') this.events.push({ k: 'train', to: t.owner.id, gold, p: dstOwner.smallID });
    }
    this.trains = this.trains.filter((t) => !t.done);
  },
};
