'use strict';
// Game modes and match options (the lobby's options page): teams, random spawn, water nukes, the
// doomsday clock, game length and overtime, alliance duration, the gold multiplier and disabled units.
//
// Teams: nations and humans are dealt into teams (tribes stay on their own). Teammates are permanent
// allies - they can't attack each other and there is no alliance to break - and alliances across teams
// don't exist. A team wins when its members together hold the land needed to win.
//
// Doomsday clock (an anti-stall, after OpenFront's): once it starts, a bar of land share rises in steps.
// Every side below it that isn't the leader is doomed: a warning, then its troops drain, then its land
// rots from the edges until it is gone. The leader is always safe, so a game always ends.
// Mixed into Game.prototype.
const { PlayerType } = require('./config');

const TEAM_NAMES = ['Red', 'Blue', 'Green', 'Yellow', 'Purple', 'Orange', 'Teal'];
const TEAM_COLORS = ['#e53935', '#1e88e5', '#43a047', '#fdd835', '#8e24aa', '#fb8c00', '#00897b'];
const TEAM_SIZES = { duos: 2, trios: 3, quads: 4 };
// ---- doomsday clock ----
const DOOM_START_TICKS = 10 * 60 * 10;     // starts 10 minutes into the game (or halfway through a set game length)
const DOOM_STEP_TICKS = 300;               // the bar rises every 30 seconds...
const DOOM_STEP_SHARE = 0.01;              // ...by 1% of the land
const DOOM_WARNING_TICKS = 600;            // a minute of warning before the drain starts
const DOOM_DRAIN_TICKS = 300;              // 30 seconds of troop drain before the land starts to rot
const DOOM_ROT_SECONDS = 40;               // a doomed side's land is gone this long after rot starts
// ---- overtime ----
const OVERTIME_STEP_TICKS = 300;           // every 30 seconds of overtime...
const OVERTIME_STEP_PERCENT = 1;           // ...the land needed to win drops by 1% of the map
const OVERTIME_FLOOR_PERCENT = 20;

function shade(hex, k) {
  // members of a team share its hue: lighter / darker variants by index
  const n = parseInt(hex.slice(1), 16);
  const f = [0, -0.18, 0.18, -0.32, 0.3, -0.42, 0.42][k % 7];
  const ch = (v) => Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f));
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => ch(v).toString(16).padStart(2, '0')).join('');
}

module.exports = {
  isTeamGame() { return this.settings.mode === 'teams'; },
  // ---- teams ----
  assignTeams() {
    this.teams = [];
    if (!this.isTeamGame()) return;
    const humans = this.players.filter((p) => p.type === PlayerType.HUMAN);
    const nations = this.players.filter((p) => p.type === PlayerType.NATION);
    for (let i = nations.length - 1; i > 0; i--) { const j = this.rng.int(0, i); [nations[i], nations[j]] = [nations[j], nations[i]]; }
    const spec = String(this.settings.teams);
    let count;
    if (spec === 'hvn') count = 2;
    else if (TEAM_SIZES[spec]) count = Math.max(2, Math.ceil((humans.length + nations.length) / TEAM_SIZES[spec]));
    else count = Math.min(7, Math.max(2, Number(spec) || 2));
    count = Math.min(count, TEAM_NAMES.length);
    for (let i = 0; i < count; i++) this.teams.push({ id: i + 1, name: TEAM_NAMES[i], color: TEAM_COLORS[i], members: [] });
    const join = (p, t) => { t.members.push(p); p.team = t.id; };
    if (spec === 'hvn') {
      for (const p of humans) join(p, this.teams[0]);
      for (const p of nations) join(p, this.teams[1]);
    } else {
      // humans are spread first so they are not all stacked on one side, then nations fill the gaps;
      // fixed-size teams (duos/trios/quads) never grow past their size
      const cap = TEAM_SIZES[spec] || Infinity;
      const smallest = () => this.teams.filter((t) => t.members.length < cap).sort((a, b) => a.members.length - b.members.length)[0];
      for (const p of humans) { const t = smallest() || this.teams[0]; join(p, t); }
      for (const p of nations) { const t = smallest(); if (t) join(p, t); }
    }
    for (const t of this.teams) t.members.forEach((p, k) => { p.color = shade(t.color, k); });
  },
  teamOf(p) { return p && p.team ? this.teams.find((t) => t.id === p.team) : null; },
  teamsPacket() { return (this.teams || []).map((t) => [t.id, t.name, t.color]); },
  // ---- the sides that can win: a team, or a lone player ----
  sides() {
    if (this.isTeamGame()) {
      const out = this.teams.map((t) => ({ team: t, players: t.members.filter((p) => p.alive) })).filter((s) => s.players.length);
      // anyone left without a team (tribes) is not a side
      return out.map((s) => ({ ...s, tiles: s.players.reduce((a, p) => a + p.tiles.size, 0) }));
    }
    return this.players.filter((p) => p.alive && p.type !== PlayerType.BOT).map((p) => ({ team: null, players: [p], tiles: p.tiles.size }));
  },
  // Land share needed to win right now (overtime lowers it over time).
  winPercent() {
    let pct = this.config.percentageTilesOwnedToWin();
    const ot = this.settings.overtimeMinutes;
    if (ot > 0) {
      const since = this.tick - this.spawnTicks - ot * 600;
      if (since > 0) pct = Math.max(OVERTIME_FLOOR_PERCENT, pct - Math.floor(since / OVERTIME_STEP_TICKS) * OVERTIME_STEP_PERCENT);
    }
    return pct;
  },
  // Returns the winning side or null. Game length: when time runs out, the biggest side wins.
  modeWinner() {
    const sides = this.sides();
    if (!sides.length) return null;
    sides.sort((a, b) => b.tiles - a.tiles);
    const need = this.winPercent() / 100 * this.numLand;
    const len = this.settings.maxTimerMinutes;
    if (sides[0].tiles >= need) return sides[0];
    if (len > 0 && this.tick >= this.spawnTicks + len * 600) return sides[0];
    if (this.isTeamGame() && sides.length === 1 && this.tick > this.spawnTicks + 100) return sides[0];
    return null;
  },

  // ---- random spawn: humans are placed for them at the start ----
  tickRandomSpawn() {
    if (!this.settings.randomSpawn || this.randomSpawnDone) return;
    this.randomSpawnDone = true;
    for (const p of this.players) {
      if (p.type !== PlayerType.HUMAN || p.spawned) continue;
      const t = this.randomSpawnTile(this.config.minDistanceBetweenPlayers() * 0.6);
      if (t !== null) this.spawn(p, t);
    }
  },

  // ---- alliances that expire ----
  tickAllianceExpiry() {
    const mins = this.settings.allianceMinutes;
    if (!(mins > 0) || this.tick % 10) return;
    const limit = mins * 600;
    for (const p of this.players) {
      if (!p.allianceSince) continue;
      for (const [id, since] of p.allianceSince) {
        if (this.tick - since < limit) continue;
        const q = this.playersById.get(id);
        p.allianceSince.delete(id);
        if (!q || !p.allies.has(id)) continue;
        p.allies.delete(id); q.allies.delete(p.id);
        if (q.allianceSince) q.allianceSince.delete(p.id);
        this.events.push({ k: 'allianceExpired', a: p.smallID, b: q.smallID });
      }
    }
  },

  // ---- doomsday clock ----
  doomStartTick() {
    const len = this.settings.maxTimerMinutes;
    return this.spawnTicks + (len > 0 ? Math.min(DOOM_START_TICKS, Math.floor(len * 600 / 2)) : DOOM_START_TICKS);
  },
  doomBar() {
    const t = this.tick - this.doomStartTick();
    return t < 0 ? 0 : Math.min(0.5, (1 + Math.floor(t / DOOM_STEP_TICKS)) * DOOM_STEP_SHARE);
  },
  tickDoomsday() {
    if (!this.settings.doomsdayClock || this.phase !== 'play' || this.tick % 10) return;
    const bar = this.doomBar();
    if (bar <= 0) return;
    const sides = this.sides();
    if (sides.length < 2) return;
    sides.sort((a, b) => b.tiles - a.tiles);
    const leader = sides[0];
    for (const s of sides) {
      const doomed = s !== leader && s.tiles < bar * this.numLand;
      for (const p of s.players) {
        if (!doomed) { if (p.doomedAt) { p.doomedAt = 0; this.events.push({ k: 'doomLifted', p: p.smallID }); } continue; }
        if (!p.doomedAt) { p.doomedAt = this.tick; this.events.push({ k: 'doomed', p: p.smallID, bar: Math.round(bar * 100) }); continue; }
        const age = this.tick - p.doomedAt;
        if (age < DOOM_WARNING_TICKS) continue;
        if (age < DOOM_WARNING_TICKS + DOOM_DRAIN_TICKS) { p.removeTroops(p.troops * 0.08); for (const w of p.warships) if (!w.done) w.hp *= 0.92; continue; }
        // rot: land falls away from the edges, fast enough to finish the side on schedule
        p.removeTroops(p.troops * 0.1);
        const secondsLeft = Math.max(1, DOOM_ROT_SECONDS - Math.floor((age - DOOM_WARNING_TICKS - DOOM_DRAIN_TICKS) / 10));
        let quota = Math.ceil(p.tiles.size / secondsLeft);
        for (const t of [...p.border]) { if (quota-- <= 0) break; const u = this.unitAt(t); if (u) this.removeUnit(u); this.relinquish(t); }
      }
    }
  },

  // ---- disabled units ----
  unitDisabled(key) { return (this.settings.disabledUnits || []).includes(key); },
};
