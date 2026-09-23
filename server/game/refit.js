'use strict';
// Unit levels and refits.
//
// A mobile unit is built at the level of the building that made it: Mechs at their Factory's level,
// Warships and Submarines at their Port's. Upgrading that building later doesn't reach out and upgrade
// what is already in the field - the unit has to come home for a refit. That is deliberate: a refit takes
// a unit off the front for a while, so upgrading mid-war is a real decision.
//
//   * When a Factory or Port is upgraded, every IDLE unit of the kind it builds that is below its new
//     level heads back automatically. "Idle" means not fighting: a mech on hold/roam with nothing in
//     range, a ship that hasn't been shot at or seen an enemy ship recently. Anything in a fight stays.
//   * The unit goes to your highest-level building of that type (nearest if tied), refits there for
//     REFIT_TICKS fully healed, then returns to the orders it had.
//   * You can force it: "Recall for refit" on the building, or "Refit" on a unit.
//
// Mixed into Game.prototype.
const { UnitType } = require('./config');

const REFIT_TICKS = 300;              // 30 s in the yard
const MECH_REFIT_REACH = 4;           // how close a mech must get to its factory
const SHIP_REFIT_REACH = 9;           // how close a ship must get to its port
const IDLE_AFTER_HIT_TICKS = 100;     // a unit hit this recently is still "in a fight"

const PRODUCER = { mech: UnitType.FACTORY, warship: UnitType.PORT, submarine: UnitType.PORT };

module.exports = {
  refitRoster(p, kind) {
    if (kind === 'mech') return p.mechs.filter((m) => !m.done);
    if (kind === 'warship') return p.warships.filter((w) => !w.done);
    if (kind === 'submarine') return p.subs.filter((s) => !s.done);
    return [];
  },
  // Highest-level finished building that can refit this kind; ties go to the nearest.
  refitYard(p, kind, x, y) {
    const type = PRODUCER[kind];
    let best = null;
    for (const u of p.units) {
      if (u.type !== type || u.constructionLeft > 0) continue;
      if (kind === 'mech' && u.level < this.config.mechFactoryLevelRequired()) continue;
      if (!best || u.level > best.level || (u.level === best.level && Math.hypot(this.x(u.tile) - x, this.y(u.tile) - y) < Math.hypot(this.x(best.tile) - x, this.y(best.tile) - y))) best = u;
    }
    return best;
  },
  unitIsIdle(kind, m) {
    if (m.refit) return false;
    if (this.tick - (m.lastHitTick ?? -1e9) < IDLE_AFTER_HIT_TICKS) return false;
    if (kind === 'mech') return !m.engaged && (m.mode === 'hold' || m.mode === 'roam');
    // a ship is idle if no enemy ship is within its guns' reach
    return !this.nearestEnemyShip(m.owner, m.x, m.y, this.config.warshipTargetRange(), true, true);
  },
  // Send one unit home. Returns a reason string on failure.
  startRefit(kind, m, yard = null) {
    const p = m.owner;
    yard = yard || this.refitYard(p, kind, m.x, m.y);
    if (!yard) return 'No building to refit at';
    if (yard.level <= (m.level || 1)) return `Already level ${m.level || 1}`;
    m.refit = { yardId: yard.id, phase: 'travel', until: 0, prevPatrol: m.patrol, prevMode: m.mode };
    if (kind === 'mech') { m.mode = 'hold'; this.mechPathTo(m, yard.tile); }
    else {
      // park on open water beside the port
      const water = this.waterNeighborsOf(yard.tile);
      if (!water.length) { m.refit = null; return 'That port has no water access'; }
      m.patrol = water[0]; m.pts = []; m.idx = 0; m.wanderAt = 0;
    }
    this.events.push({ k: 'refitStart', p: p.smallID, kind, level: yard.level });
    return null;
  },
  cancelRefit(m, why = null) {
    if (!m.refit) return;
    const r = m.refit;
    m.refit = null;
    if (r.prevMode) m.mode = r.prevMode;
    if (why) this.events.push({ k: 'refitCancelled', p: m.owner.smallID, why });
  },
  // Called by the mech / ship tick. Returns true while the unit is busy refitting (skip normal behaviour).
  tickRefit(kind, m) {
    if (!m.refit) return false;
    const yard = this.units.find((u) => u.id === m.refit.yardId);
    if (!yard || yard.owner !== m.owner) { this.cancelRefit(m, 'lost the building'); return false; }
    const yx = this.x(yard.tile) + 0.5, yy = this.y(yard.tile) + 0.5;
    const d = Math.hypot(m.x - yx, m.y - yy);
    if (m.refit.phase === 'travel') {
      if (kind === 'mech') {
        if (m.pts.length && m.idx < m.pts.length - 1) this.advanceAlong(m, this.config.mechSpeed(m.owner, m.onWater, 'own'));
        else if (d > MECH_REFIT_REACH) this.mechPathTo(m, yard.tile);
      } else this.shipWander(m, this.config.warshipSpeed(), 2);
      if (d <= (kind === 'mech' ? MECH_REFIT_REACH : SHIP_REFIT_REACH)) { m.refit.phase = 'work'; m.refit.until = this.tick + REFIT_TICKS; }
      return true;
    }
    // in the yard: stay put, heal, and come out at the yard's current level
    m.hp = Math.min(m.maxHp || m.hp, (m.hp || 0) + (m.maxHp || 0) * 0.01);
    if (this.tick < m.refit.until) return true;
    const r = m.refit;
    m.refit = null;
    this.applyUnitLevel(kind, m, yard.level);
    this.events.push({ k: 'refitDone', p: m.owner.smallID, kind, level: m.level });
    // back to what it was doing
    if (kind === 'mech') { m.mode = r.prevMode || 'hold'; if (r.prevPatrol >= 0) { m.patrol = r.prevPatrol; this.mechPathTo(m, r.prevPatrol); } }
    else if (r.prevPatrol !== undefined) { m.patrol = r.prevPatrol; m.pts = []; m.idx = 0; m.wanderAt = 0; }
    return false;
  },
  // Level-dependent stats. Called at build time and after a refit.
  applyUnitLevel(kind, m, level) {
    const cfg = this.config;
    m.level = level;
    if (kind === 'mech') { m.maxHp = cfg.mechBaseHp(m.owner, level); m.range = cfg.mechRange(m.owner, level); }
    else if (kind === 'warship') m.maxHp = cfg.warshipMaxHp(level);
    else if (kind === 'submarine') m.maxHp = cfg.submarineMaxHp(level);
    m.hp = m.maxHp;
  },
  // A producer just went up a level: bring home everything idle that is now behind it.
  onProducerUpgraded(yard) {
    const kinds = yard.type === UnitType.FACTORY ? ['mech'] : yard.type === UnitType.PORT ? ['warship', 'submarine'] : [];
    for (const kind of kinds) {
      for (const m of this.refitRoster(yard.owner, kind)) {
        if ((m.level || 1) >= yard.level || !this.unitIsIdle(kind, m)) continue;
        this.startRefit(kind, m);
      }
    }
  },
  // "Recall for refit" on a building: every unit it builds that is below its level, idle or not.
  recallForRefit(p, tile) {
    const yard = this.unitAt(tile);
    if (!yard || yard.owner !== p || !PRODUCER_TYPES.has(yard.type)) return { ok: false, reason: 'Only Factories and Ports refit units' };
    const kinds = yard.type === UnitType.FACTORY ? ['mech'] : ['warship', 'submarine'];
    let n = 0;
    for (const kind of kinds) for (const m of this.refitRoster(p, kind)) if (!m.refit && (m.level || 1) < yard.level && !this.startRefit(kind, m, yard)) n++;
    return n ? { ok: true, count: n } : { ok: false, reason: `Nothing below level ${yard.level} to refit` };
  },
  refitUnit(p, kind, id) {
    const m = this.refitRoster(p, kind).find((x) => x.id === id);
    if (!m) return { ok: false, reason: 'No such unit' };
    if (m.refit) { this.cancelRefit(m); return { ok: true, cancelled: true }; }
    const err = this.startRefit(kind, m);
    return err ? { ok: false, reason: err } : { ok: true };
  },
};
const PRODUCER_TYPES = new Set([UnitType.FACTORY, UnitType.PORT]);
