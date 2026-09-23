'use strict';
// "Info" on a building or unit: the numbers that actually matter for it, computed from the same config
// and research the simulation uses, so the panel can never disagree with what happens in play.
// Returns { title, sub, rows: [[label, value, tone?]] } where tone is 'good' | 'bad' | undefined.
// Mixed into Game.prototype.
const { UnitType, TICKS_PER_SECOND } = require('./config');
const R = require('./research').effects;

const sec = (ticks) => `${(ticks / TICKS_PER_SECOND).toFixed(ticks < 100 ? 1 : 0)}s`;
const pct = (f) => `${(f * 100).toFixed(f < 0.1 ? 2 : 0)}%`;
const num = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}K` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : `${Math.round(n)}`);
const LABEL = {
  city: 'City', port: 'Port', defense: 'Defense Post', silo: 'Missile Silo', sam: 'SAM Launcher', lab: 'Research Lab', factory: 'Factory',
  mine: 'Naval Mine', artillery: 'Artillery Battery', repair: 'Repair Yard', airport: 'Airport',
};

module.exports = {
  inspect(viewer, q) {
    if (q.kind === 'building') return this.inspectBuilding(viewer, this.unitAt(q.tile));
    if (q.kind === 'mech') return this.inspectMech(viewer, this.mechs.find((m) => m.id === q.id && !m.done));
    if (q.kind === 'warship' || q.kind === 'submarine') {
      const list = q.kind === 'warship' ? this.warships : this.subs;
      const s = list.find((x) => x.id === q.id && !x.done);
      if (s && q.kind === 'submarine' && s.owner !== viewer && !viewer.isFriendly(s.owner) && !s.detected) return null;
      return this.inspectShip(viewer, q.kind, s);
    }
    return null;
  },

  inspectBuilding(viewer, u) {
    if (!u) return null;
    const cfg = this.config, p = u.owner, rows = [];
    const maxLv = [UnitType.CITY, UnitType.PORT, UnitType.FACTORY, UnitType.LAB].includes(u.type) ? cfg.maxUnitLevel(p, u.type) : 1;
    rows.push(['Owner', p.name]);
    if (maxLv > 1) rows.push(['Level', `${u.level} / ${maxLv}`]);
    if (u.constructionLeft > 0) rows.push(['Status', `building, ${sec(u.constructionLeft)} left`, 'bad']);
    switch (u.type) {
      case UnitType.CITY:
        rows.push(['Gold', `+${num(cfg.cityGold(u.level) * TICKS_PER_SECOND)}/s`, 'good']);
        rows.push(['Max troops', `+${num(cfg.cityTroopIncrease(p) * u.level)}`, 'good']);
        if (u.level < maxLv) rows.push(['Next level', `+${num((cfg.cityGold(u.level + 1) - cfg.cityGold(u.level)) * TICKS_PER_SECOND)}/s gold`]);
        rows.push(['On rail', u.station ? 'yes' : 'no — build a Factory within 110 tiles']);
        break;
      case UnitType.PORT:
        rows.push(['Trade', `sends ships to foreign ports; allies pay +${pct(cfg.alliedTradeBonus() - 1)}`, 'good']);
        rows.push(['Builds', `Warships / Submarines at level ${u.level}`]);
        rows.push(['Warship at this level', `${num(cfg.warshipMaxHp(u.level))} HP, +${pct(cfg.warshipDamageMultiplier(u.level) - 1)} damage`]);
        break;
      case UnitType.FACTORY: {
        const links = (this.railAdj.get(u.id) || new Set()).size;
        rows.push(['Rail links', `${links}`]);
        rows.push(['Train gold', `×${cfg.factoryEfficiency(u.level).toFixed(2)} per delivery`, cfg.factoryEfficiency(u.level) > 1 ? 'good' : undefined]);
        if (u.level >= cfg.mechFactoryLevelRequired()) rows.push(['Mechs built here', `level ${u.level}: ${num(cfg.mechBaseHp(p, u.level))} HP, ${cfg.mechRange(p, u.level)} range`]);
        else rows.push(['Mechs', `needs level ${cfg.mechFactoryLevelRequired()}`, 'bad']);
        break;
      }
      case UnitType.DEFENSE_POST: {
        rows.push(['Guards', `${cfg.defensePostRange()} tiles: attackers lose ×${cfg.defensePostDefenseBonus()} troops, move ×${cfg.defensePostSpeedBonus()} slower`, 'good']);
        rows.push(['Border in range', `×${cfg.defensePostBorderBonus()} harder again`, 'good']);
        const coastal = this.isCoastalPost(u);
        if (coastal) {
          const allShips = p.researches.has('coastal_defense');
          rows.push(['Coastal guns', `${pct(cfg.defensePostShipDamage(p) / cfg.warshipHp())} of a warship per shell, every ${sec(cfg.defensePostShellRate(p))}`]);
          rows.push(['Engages', allShips ? 'every enemy ship' : 'warships only']);
          rows.push(['Gun range', `${cfg.defensePostShipRange(p)} tiles`]);
        } else rows.push(['Coastal guns', 'none — too far inland to see the sea']);
        if (u.garrison) rows.push(['Garrison', num(u.garrison)]);
        break;
      }
      case UnitType.SILO:
        rows.push(['Reload', sec(cfg.siloCooldownTicks(p))]);
        rows.push(['Status', u.cooldown > 0 ? `reloading, ${sec(u.cooldown)}` : 'ready', u.cooldown > 0 ? 'bad' : 'good']);
        if (R.clusterMunitions(p)) rows.push(['Cluster Strike', `${cfg.clusterCount()} missiles, ${num(cfg.nukeCost('cluster', p))}`]);
        break;
      case UnitType.SAM:
        rows.push(['Range', `${cfg.samRange(p)} tiles`]);
        rows.push(['Stops', '1 missile per reload']);
        rows.push(['Reload', sec(cfg.samCooldownTicks())]);
        rows.push(['Status', u.cooldown > 0 ? `reloading, ${sec(u.cooldown)}` : 'ready', u.cooldown > 0 ? 'bad' : 'good']);
        break;
      case UnitType.LAB: {
        rows.push(['Research speed', `×${(1 / cfg.labSpeedMultiplier(u.level)).toFixed(2)}`, u.level > 1 ? 'good' : undefined]);
        const r = p.research && p.research.labId === u.id ? p.research : null;
        if (r && (viewer === p || viewer.isFriendly(p))) rows.push(['Working on', `${r.id.replace(/_/g, ' ')}, ${sec(r.doneTick - this.tick)} left`]);
        else if (u.cooldown > 0) rows.push(['Status', `cooling down, ${sec(u.cooldown)}`]);
        rows.push(['Doctrine slots', `${cfg.researchesPerLab()} per lab`]);
        break;
      }
      case UnitType.ARTILLERY:
        rows.push(['Range', `${cfg.artilleryRange(p)} tiles`]);
        rows.push(['Vs Mech', `${pct(cfg.artilleryMechDamageFraction(p))} of its health per shell`, 'good']);
        rows.push(['Vs Warship', `${pct(cfg.artilleryShipDamageFraction(p))} per shell`]);
        rows.push(['Reload', sec(cfg.artilleryReload(p))]);
        rows.push(['Next shell', u.shellReady > this.tick ? sec(u.shellReady - this.tick) : 'ready']);
        break;
      case UnitType.REPAIR:
        rows.push(['Range', `${cfg.repairRange()} tiles`]);
        rows.push(['Mechs', `+${pct(cfg.repairMechPercent())} health every ${sec(cfg.repairInterval())}`, 'good']);
        rows.push(['Walls', `+${num(cfg.repairWallAmount())} HP on ${cfg.repairWallTilesPerPass()} tiles every ${sec(cfg.repairInterval())}`, 'good']);
        break;
      case UnitType.AIRPORT:
        rows.push(['Airships', `${this.liveAirships(p).length} / ${cfg.airshipCap(p)} in the air`]);
        rows.push(['Carries', `${pct(cfg.airshipTroopShare(p))} of your troops`]);
        rows.push(['Range', `${cfg.airshipRange(p)} tiles`]);
        rows.push(['Next airship', num(cfg.airshipCost(p, p.airshipsBuilt || 0))]);
        rows.push(['SAMs nearby', R.samNearAirport(p) ? 'allowed (Airbase Network)' : `not within ${cfg.airportSamExclusion()} tiles`]);
        break;
      case UnitType.MINE:
        rows.push(['Blast', 'sinks any enemy ship within 2 tiles']);
        break;
      default: break;
    }
    return { title: `${LABEL[u.type] || u.type}${maxLv > 1 ? ' L' + u.level : ''}`, sub: p.name, rows };
  },

  inspectMech(viewer, m) {
    if (!m) return null;
    const cfg = this.config, p = m.owner, rows = [];
    const perSec = (t) => (cfg.mechSpeed(p, false, t) * TICKS_PER_SECOND).toFixed(1);
    rows.push(['Owner', p.name]);
    rows.push(['Health', `${num(Math.max(0, m.hp))} / ${num(m.maxHp)}`, m.hp < m.maxHp * 0.4 ? 'bad' : undefined]);
    rows.push(['Shell', `${num(cfg.mechShellDamage(p, m.level))} dmg, kills ${num(cfg.mechTroopKillPerShell(p, m.level))} troops`]);
    rows.push(['Range', `${m.range} tiles`]);
    rows.push(['Cannon reload', sec(cfg.mechCannonCooldown(p))]);
    rows.push(['Stomp', `radius ${cfg.mechStompRadius(p)}, every ${sec(cfg.mechStompCooldown(p))}`]);
    rows.push(['Speed', `${perSec('own')} home · ${perSec('neutral')} open · ${perSec('enemy')} enemy tiles/s`]);
    rows.push(['Holds ground', `${cfg.mechAuraRange()} tiles: attackers lose ×${cfg.mechDefenseBonus()} troops, ×${cfg.mechSpeedPenalty()} slower`, 'good']);
    if (R.mechCrossesWater(p)) rows.push(['Water', 'can cross']);
    if (R.mechAmphibious(p)) rows.push(['Vs ships', `${num(cfg.mechShipDamage(p))} per shell, spots subs in ${cfg.mechSubDetectRange()} tiles`, 'good']);
    if (R.mechAntiAir(p)) rows.push(['Anti-air', 'shoots down airships in range', 'good']);
    if (viewer === p || viewer.isFriendly(p)) {
      rows.push(['Orders', m.refit ? `refitting (${m.refit.phase === 'work' ? sec(m.refit.until - this.tick) + ' left' : 'heading home'})` : m.mode]);
      const yard = this.refitYard(p, 'mech', m.x, m.y);
      if (yard && yard.level > m.level && !m.refit) rows.push(['Refit available', `to level ${yard.level}`, 'good']);
    }
    return { title: `Mech L${m.level}`, sub: p.name, rows };
  },

  inspectShip(viewer, kind, s) {
    if (!s) return null;
    const cfg = this.config, p = s.owner, rows = [];
    const lvl = s.level || 1;
    rows.push(['Owner', p.name]);
    rows.push(['Health', `${num(Math.max(0, s.hp))} / ${num(s.maxHp || (kind === 'warship' ? cfg.warshipHp() : cfg.submarineHp()))}`]);
    if (kind === 'warship') {
      rows.push(['Shell', `${num(250 * 2 * cfg.warshipDamageMultiplier(lvl))}–${num(250 * 3 * cfg.warshipDamageMultiplier(lvl))} dmg`]);
      rows.push(['Reload', sec(cfg.warshipShellRate())]);
      rows.push(['Gun range', `${cfg.warshipTargetRange()} tiles`]);
      rows.push(['Hunts', 'enemy boats, trade ships, warships and detected subs']);
    } else {
      rows.push(['Volley', `3 missiles every ${sec(cfg.submarineVolleyTicks ? cfg.submarineVolleyTicks() : 900)}`]);
      rows.push(['Missile range', `${cfg.submarineMissileRange()} tiles, ignore SAMs`]);
      rows.push(['Stealth', s.detected ? 'DETECTED' : 'hidden', s.detected ? 'bad' : 'good']);
    }
    rows.push(['Repair', this.tick - (s.lastHitTick ?? -1e9) < 100 ? 'none — under fire' : 'slow at sea, fast at your ports']);
    if (viewer === p) {
      if (s.refit) rows.push(['Orders', `refitting (${s.refit.phase === 'work' ? sec(s.refit.until - this.tick) + ' left' : 'heading to port'})`]);
      const yard = this.refitYard(p, kind, s.x, s.y);
      if (yard && yard.level > lvl && !s.refit) rows.push(['Refit available', `to level ${yard.level}`, 'good']);
    }
    return { title: `${kind === 'warship' ? 'Warship' : 'Submarine'} L${lvl}`, sub: p.name, rows };
  },
};
