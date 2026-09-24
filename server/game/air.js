'use strict';
// Airports and airships.
//
// This exists to answer the turtle: a nation with SAMs, warships and Coastal Defense posts is otherwise
// untouchable — nukes get intercepted, boats get sunk before they beach, and there is no third way in.
// An airship flies over all of it. SAMs cannot touch one, warships cannot reach one, and it puts troops
// straight onto ground that has no coast to defend.
//
// The price of that is deliberate and steep:
//   * an Airport is one of the most expensive buildings in the game, and you may only have one
//   * an airship carries a small slice of your army, not a real invasion (5%, 10% with Strategic Airlift)
//   * your own SAM umbrella and your Airport cannot overlap — opening the sky for your planes opens it
//     for everybody else's missiles too, unless you research Airbase Network
//   * Interceptor Screen shoots them down, so the counter exists and it is a doctrine, not a building
//
// Airships reach anywhere on the map. What decides how long a flight takes is the Airport's road network:
// an Airport lays roads to your Cities in range (the way a Factory lays rail), and every City on those
// roads is an airfield - an airship takes off from whichever airfield is closest to its target.
//
// Mixed into Game.prototype.
const { UnitType, PlayerType } = require('./config');
const { newId } = require('./ids');
const { astar } = require('./path');
const R = require('./research').effects;

const AIRPORT_ROADS = 8;          // cities an Airport lays roads to

module.exports = {
  airports(p) { return p.completedUnitsOf(UnitType.AIRPORT); },
  // ---- roads ----
  roadCost(t) { return this.isLand(t) && !this.wallHp[t] ? 1 : 0; },   // roads don't bridge the sea
  roadConnect(u) {
    const p = u.owner, range = this.config.airportRoadRange(p);
    const queue = (a, b) => (this.roadQueue ||= []).push([a, b]);
    if (u.type === UnitType.AIRPORT) {
      const cities = p.units.filter((o) => o.type === UnitType.CITY && o.constructionLeft === 0 && this.dist(o.tile, u.tile) <= range)
        .sort((a, b) => this.dist(a.tile, u.tile) - this.dist(b.tile, u.tile));
      for (const c of cities.slice(0, AIRPORT_ROADS)) queue(u, c);
    } else if (u.type === UnitType.CITY) {
      for (const a of p.units) {
        if (a.type !== UnitType.AIRPORT || a.constructionLeft > 0 || this.dist(a.tile, u.tile) > range) continue;
        if (this.roads.filter((r) => r.a === a).length < AIRPORT_ROADS) queue(a, u);
      }
    }
  },
  layRoad(a, b) {
    if (a.owner !== b.owner || this.roads.some((r) => r.a === a && r.b === b)) return false;
    const range = this.config.airportRoadRange(a.owner);
    const path = astar(this, [a.tile], b.tile, (t) => this.roadCost(t), { diag: true, maxIter: 40000 });
    if (!path || path.length > range * 1.6) return false;
    this.roads.push({ id: newId(), a, b, tiles: path });
    this.roadsChanged = true;
    return true;
  },
  tickRoads() {
    if (!this.roadQueue || !this.roadQueue.length) return;
    const [a, b] = this.roadQueue.shift();
    if (this.units.includes(a) && this.units.includes(b)) this.layRoad(a, b);
  },
  // A road dies with either end, or when a city on it changes hands.
  onRoadUnitChanged(u) {
    if (u.type !== UnitType.AIRPORT && u.type !== UnitType.CITY) return;
    const before = this.roads.length;
    this.roads = this.roads.filter((r) => r.a !== u && r.b !== u);
    if (this.roads.length !== before) this.roadsChanged = true;
  },
  // The Airport and every City on its roads.
  airfields(p) {
    const out = this.airports(p);
    for (const r of this.roads) if (r.a.owner === p && r.b.owner === p && r.b.constructionLeft === 0) out.push(r.b);
    return out;
  },
  liveAirships(p) { return p.airships.filter((a) => !a.done); },

  // A SAM battery and an airport jam each other; neither can be built inside the other's exclusion ring.
  samAirportConflict(p, type, tile) {
    if (R.samNearAirport(p)) return null;
    const r = this.config.airportSamExclusion();
    if (type === UnitType.SAM) {
      const port = p.units.find((u) => u.type === UnitType.AIRPORT && this.dist(u.tile, tile) <= r);
      if (port) return `Too close to your Airport (SAMs jam your own flight paths within ${r} tiles — research Airbase Network to allow it)`;
    }
    if (type === UnitType.AIRPORT) {
      const sam = p.units.find((u) => u.type === UnitType.SAM && this.dist(u.tile, tile) <= r);
      if (sam) return `Too close to your SAM Launcher (within ${r} tiles — research Airbase Network to allow it)`;
    }
    return null;
  },

  canLaunchAirship(p, targetTile) {
    if (!p.alive) return { ok: false, reason: 'dead' };
    if (this.unitDisabled('airport')) return { ok: false, reason: 'Airships are disabled in this game' };
    const ports = this.airports(p);
    if (!ports.length) return { ok: false, reason: 'Airships need an Airport' };
    if (!this.isLand(targetTile)) return { ok: false, reason: 'Airships drop troops on land' };
    const cap = this.config.airshipCap(p);
    if (this.liveAirships(p).length >= cap) return { ok: false, reason: `All ${cap} airships are already in the air` };
    const owner = this.ownerOf(targetTile);
    if (owner === p) return { ok: false, reason: 'That is already your land' };
    if (owner && !this.canAttack(p, owner)) return { ok: false, reason: `You cannot attack ${owner.name}` };
    const cost = this.config.airshipCost(p, p.airshipsBuilt || 0);
    if (p.gold < cost) return { ok: false, reason: `Not enough gold (need ${Math.floor(cost).toLocaleString()})` };
    const troops = Math.floor(p.troops * this.config.airshipTroopShare(p));
    if (troops < 1) return { ok: false, reason: 'No troops to load' };
    // anywhere on the map: it takes off from the airfield (Airport, or a City on its roads) nearest the target
    const from = this.airfields(p).sort((a, b) => this.dist(a.tile, targetTile) - this.dist(b.tile, targetTile))[0];
    return { ok: true, cost, from, troops };
  },

  launchAirship(p, targetTile) {
    const c = this.canLaunchAirship(p, targetTile);
    if (!c.ok) return c;
    p.removeGold(c.cost);
    p.airshipsBuilt = (p.airshipsBuilt || 0) + 1;
    const troops = p.removeTroops(c.troops);
    const a = {
      id: newId(), owner: p, troops,
      x: this.x(c.from.tile) + 0.5, y: this.y(c.from.tile) + 0.5,
      tx: this.x(targetTile) + 0.5, ty: this.y(targetTile) + 0.5,
      dst: targetTile, hp: this.config.airshipHp(p), done: false, checked: new Set(),
    };
    this.airships.push(a);
    p.airships.push(a);
    this.events.push({ k: 'airship', by: p.smallID, target: this.owner[targetTile] });
    return c;
  },

  tickAirships() {
    if (!this.airships.length) return;
    const cfg = this.config;
    for (const a of this.airships) {
      if (a.done) continue;
      const p = a.owner;
      if (!p.alive) { a.done = true; continue; }
      const speed = cfg.airshipSpeed(p);
      const dx = a.tx - a.x, dy = a.ty - a.y, d = Math.hypot(dx, dy);

      // Interceptor Screen: the one thing that can bring an airship down. Checked per enemy nation once so a
      // single flight past a city is one roll, not one per tick.
      for (const q of this.players) {
        if (!q.alive || q === p || p.isFriendly(q) || !R.interceptsAirships(q)) continue;
        if (a.checked.has(q.smallID)) continue;
        // Interceptors fly from SAM sites (their normal range) and the Airport - not from every city.
        const near = q.units.some((u) => u.constructionLeft === 0
          && ((u.type === UnitType.SAM && Math.hypot(this.x(u.tile) + 0.5 - a.x, this.y(u.tile) + 0.5 - a.y) <= cfg.samRange(q))
            || (u.type === UnitType.AIRPORT && Math.hypot(this.x(u.tile) + 0.5 - a.x, this.y(u.tile) + 0.5 - a.y) <= cfg.interceptorRange(q))));
        if (!near) continue;
        a.checked.add(q.smallID);
        if (this.rng.next() < cfg.interceptorKillChance(q)) {
          a.done = true;
          this.events.push({ k: 'airshipDown', by: q.smallID, p: p.smallID, x: a.x, y: a.y });
          break;
        }
      }
      if (a.done) continue;

      if (d <= speed) {
        a.x = a.tx; a.y = a.ty; a.done = true;
        const dst = a.dst;
        const ownerNow = this.ownerOf(dst);
        if (ownerNow === p || (ownerNow && (p.isFriendly(ownerNow) || !this.canAttack(p, ownerNow)))) { p.addTroops(a.troops); continue; }
        // Same shape as a beach landing, minus the coast requirement - that is the whole point.
        let landing = Math.floor(a.troops * R.landingBonus(p) * R.airdropBonus(p));
        if (ownerNow) ownerNow.removeTroops(ownerNow.troops / Math.max(1, ownerNow.numTiles));
        this.conquer(p, dst);
        // SEAD: the drop goes in on top of the air defences and takes them apart
        if (R.sead(p)) {
          for (const u of [...this.units]) {
            if (u.type !== UnitType.SAM || !this.hostile(p, u.owner)) continue;
            if (Math.hypot(this.x(u.tile) - this.x(dst), this.y(u.tile) - this.y(dst)) > this.config.seadRadius()) continue;
            this.events.push({ k: 'structHit', p: u.owner.smallID, type: u.type, x: this.x(u.tile), y: this.y(u.tile) });
            this.removeUnit(u);
          }
        }
        p.addTroops(landing);
        this.sendAttack(p, ownerNow, landing, dst);
        if (ownerNow) this.handleDeadDefender(p, ownerNow);
        this.events.push({ k: 'airdrop', by: p.smallID, p: ownerNow ? ownerNow.smallID : 0, troops: landing, x: this.x(dst), y: this.y(dst) });
        continue;
      }
      a.x += (dx / d) * speed;
      a.y += (dy / d) * speed;
    }
    if (this.airships.some((a) => a.done)) {
      this.airships = this.airships.filter((a) => !a.done);
      for (const p of this.players) p.airships = p.airships.filter((a) => !a.done);
    }
  },

  airshipsPacket() {
    return this.airships.filter((a) => !a.done).map((a) => [a.id, a.owner.smallID, this.r1(a.x), this.r1(a.y), this.r1(a.tx), this.r1(a.ty), Math.floor(a.troops)]);
  },
};
