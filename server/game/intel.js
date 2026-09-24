'use strict';
// Nation profiles: the words an AI writes in its memory about another nation.
//
// A nation AI doesn't reason about raw numbers when it decides what to research, whom to nuke or whom
// to ally with. It looks at a rival and writes down short words - "city_clump", "sam_covered",
// "econ_buff", "attacked_me" - each with a confidence from 0 to 1 that fades if it isn't seen again.
// Every choice the AI can make is tagged with the words that make it attractive (see research.js
// `answers`, and the action tables in ai.js). So "this nation is clumped, has no air defence and is a
// danger to me" is literally the three words that the nuke-the-clump action is looking for.
//
// There are two kinds of words:
//   * objective words - what anyone can see: buildings, clumps, SAM coverage, navies, doctrines held.
//     Computed once per nation here and shared by every AI (cached), so a hundred AIs looking at the
//     same nation cost one look.
//   * relational words - how that nation relates to *me*: neighbour, attacked me, my ally's target,
//     stronger than me. Each AI adds these itself (ai.js).
// Mixed into Game.prototype.
const { UnitType, PlayerType } = require('./config');
const { RESEARCH_BY_ID } = require('./research');

const PROFILE_TTL = 50;          // ticks an objective profile stays fresh
const CLUMP_RADIUS = 30;         // buildings closer than this count as one cluster
const CLUMP_MIN = 3;             // this many cities in one cluster makes a clump
const SAM_CLUMP_RADIUS = 60;

// Every word, with what it means. Kept in one place so the vocabulary is easy to read and extend.
const WORDS = {
  // ---- size and strength (relative words are added per observer) ----
  giant: 'far more land than me', small: 'far less land than me',
  strong_army: 'more troops than me', weak_army: 'far fewer troops than me', troops_depleted: 'running on empty (under 25% of their cap)',
  growing: 'gaining land fast', shrinking: 'losing land', collapsing: 'losing land very fast',
  rich: 'a big treasury or income', poor: 'a thin treasury',
  // ---- what they have built ----
  populated: 'many cities / high city levels', city_clump: 'three or more cities packed together',
  industry_clump: 'factories or labs packed in with cities', industrial: 'two or more factories',
  rail_network: 'a large rail network', research_hub: 'two or more labs, or an upgraded lab',
  port_heavy: 'three or more ports', fortified: 'several defense posts', walled: 'long walls',
  artillery_line: 'artillery batteries', repair_yards: 'repair yards keeping mechs alive',
  sam_covered: 'has SAM launchers', sam_clump: 'SAMs overlapping each other', clump_uncovered: 'a city clump no SAM can protect',
  no_air_defense: 'no SAMs and no fighter doctrine', nuclear: 'owns missile silos', nuke_armed: 'a silo ready and the gold to fire it',
  airport: 'owns an airport', airship_threat: 'can fly troops in over defences',
  // ---- what they field ----
  mech_force: 'fields a mech', mech_army: 'fields two or more mechs', naval: 'fields warships',
  navy_heavy: 'four or more warships', sub_threat: 'submarines', bomber_threat: 'bomber strikes',
  coastal: 'has a sea coast',
  // ---- doctrines they hold (also produced from research.js `words`) ----
  econ_buff: 'an economy doctrine', aggressive: 'an offensive doctrine', fast_attacks: 'faster attacks',
  mech_economy: 'cheap mechs', coastal_fort: 'fortified coasts', nuke_hardened: 'hardened against nukes',
  troop_heavy: 'extra troops per city', air_defense: 'fighter cover', heavy_mechs: 'heavy mechs',
  mech_breakers: 'mechs that smash walls', mech_firepower: 'hard-hitting mechs', mech_range: 'long-range mechs',
  amphibious: 'mechs that cross water', anti_navy: 'mechs that sink ships', bombardment: 'warships that shell coasts',
  sub_nukes: 'nuclear submarines', invader: 'strong sea invasions', mined: 'mined waters', bombers: 'bomber doctrine',
  cheap_nukes: 'cheap nukes', mirv: 'MIRV warheads', anti_mech: 'artillery doctrine', sam_breaker: 'can punch through SAMs',
  anti_air: 'can shoot down airships', deterrent: 'automatic nuclear retaliation', rail_power: 'rail-driven army',
  // ---- relations (added by each observing AI) ----
  neighbor: 'shares a border with me', same_continent: 'reachable by land', overseas: 'only reachable by sea or air',
  ally: 'my ally', attacked_me: 'has attacked me', attacking_me_now: 'is attacking me right now',
  betrayed_me: 'broke an alliance with me', nuked_me: 'nuked me', sank_my_ships: 'sank my ships',
  shot_my_missiles: 'their SAMs shot my missiles down', downed_my_airships: 'shot my airships down',
  declared_war_on_me: 'declared war on me', at_war: 'I declared war on them', trade_partner: 'trades with me',
  enemy_of_ally: 'is attacking my ally', ally_target: 'my ally is attacking them', ally_winning: 'my ally is winning against them',
  enemy_of_enemy: 'fights someone I hate', traitor: 'a known traitor', busy: 'fighting on another front',
  overextended: 'attacking on several fronts at once', danger: 'a real threat to me', easy_prey: 'weak, next door and unprotected',
  offline: 'its player has disconnected',
  outgrown: 'an ally I have outgrown - far weaker than me', rushing: 'I am going all-in on them',
};

module.exports = {
  // Objective profile of a nation, cached for PROFILE_TTL ticks and shared by every observer.
  nationProfile(o) {
    this.profiles ||= new Map();
    const cached = this.profiles.get(o.smallID);
    if (cached && this.tick - cached.tick < PROFILE_TTL) return cached;
    const prof = this.computeProfile(o, cached);
    this.profiles.set(o.smallID, prof);
    return prof;
  },
  computeProfile(o, prev) {
    const cfg = this.config;
    const words = new Set();
    const n = {};
    const cities = [], factories = [], labs = [], sams = [];
    for (const u of o.units) {
      if (u.constructionLeft > 0) continue;
      n[u.type] = (n[u.type] || 0) + 1;
      if (u.type === UnitType.CITY) cities.push(u);
      else if (u.type === UnitType.FACTORY) factories.push(u);
      else if (u.type === UnitType.LAB) labs.push(u);
      else if (u.type === UnitType.SAM) sams.push(u);
    }
    const cityLevels = cities.reduce((a, u) => a + u.level, 0);
    // ---- clumps: greedy clustering of cities (plus factories/labs as industry) ----
    const clumps = [];
    const R2 = CLUMP_RADIUS * CLUMP_RADIUS;
    const used = new Set();
    for (const c of cities) {
      if (used.has(c)) continue;
      const cx = this.x(c.tile), cy = this.y(c.tile);
      const members = cities.filter((d) => !used.has(d) && (this.x(d.tile) - cx) ** 2 + (this.y(d.tile) - cy) ** 2 <= R2);
      if (members.length < CLUMP_MIN) continue;
      for (const d of members) used.add(d);
      const mx = members.reduce((a, d) => a + this.x(d.tile), 0) / members.length;
      const my = members.reduce((a, d) => a + this.y(d.tile), 0) / members.length;
      const industry = [...factories, ...labs].filter((d) => (this.x(d.tile) - mx) ** 2 + (this.y(d.tile) - my) ** 2 <= R2).length;
      // how many of the owner's SAMs cover this clump's centre
      let cover = 0;
      for (const s of sams) { const r = cfg.samRange(o); if ((this.x(s.tile) - mx) ** 2 + (this.y(s.tile) - my) ** 2 <= r * r) cover++; }
      clumps.push({ x: mx, y: my, size: members.length, levels: members.reduce((a, d) => a + d.level, 0), industry, cover });
    }
    clumps.sort((a, b) => (b.levels + b.industry * 2) - (a.levels + a.industry * 2));
    if (clumps.length) words.add('city_clump');
    if (clumps.some((c) => c.industry > 0)) words.add('industry_clump');
    if (clumps.some((c) => c.cover === 0)) words.add('clump_uncovered');
    // ---- buildings ----
    if (cities.length >= 5 || cityLevels >= 8) words.add('populated');
    if (factories.length >= 2) words.add('industrial');
    if ((this.rails || []).filter((r) => r.a.owner === o).length >= 6) words.add('rail_network');
    if (labs.length >= 2 || labs.some((l) => l.level >= 2)) words.add('research_hub');
    if ((n[UnitType.PORT] || 0) >= 3) words.add('port_heavy');
    if ((n[UnitType.DEFENSE_POST] || 0) >= 3) words.add('fortified');
    if (o.numWallTiles >= 60) words.add('walled');
    if ((n[UnitType.ARTILLERY] || 0) >= 1) words.add('artillery_line');
    if ((n[UnitType.REPAIR] || 0) >= 1) words.add('repair_yards');
    if (sams.length) words.add('sam_covered');
    if (sams.some((a) => sams.some((b) => a !== b && (this.x(a.tile) - this.x(b.tile)) ** 2 + (this.y(a.tile) - this.y(b.tile)) ** 2 <= SAM_CLUMP_RADIUS * SAM_CLUMP_RADIUS))) words.add('sam_clump');
    if (!sams.length && !o.researches.has('fighter_networks') && !o.researches.has('interceptor_screen')) words.add('no_air_defense');
    const silos = o.units.filter((u) => u.type === UnitType.SILO && u.constructionLeft === 0);
    if (silos.length) words.add('nuclear');
    if (silos.some((u) => u.cooldown === 0) && o.gold >= cfg.nukeCost('atom', o)) words.add('nuke_armed');
    if (n[UnitType.AIRPORT]) { words.add('airport'); words.add('airship_threat'); }
    // ---- units ----
    const mechs = o.mechs.filter((m) => !m.done).length;
    const warships = o.warships.filter((w) => !w.done).length;
    if (mechs >= 1) words.add('mech_force');
    if (mechs >= 2) words.add('mech_army');
    if (warships >= 1) words.add('naval');
    if (warships >= 4) words.add('navy_heavy');
    if (o.airships.some((a) => !a.done)) words.add('airship_threat');
    if (o.researches.has('submarine_warfare')) words.add('sub_threat');
    if (o.researches.has('strategic_bombers')) words.add('bomber_threat');
    if (o.border.size && [...o.border].slice(0, 400).some((t) => this.isOceanShore(t))) words.add('coastal');
    // ---- doctrines they hold ----
    for (const id of o.researches) { const r = RESEARCH_BY_ID[id]; if (r && r.words) for (const w of r.words) words.add(w); }
    // ---- trends ----
    if (prev && prev.tiles > 0) {
      const change = (o.numTiles - prev.tiles) / prev.tiles;
      if (change > 0.1) words.add('growing');
      if (change < -0.1) words.add('shrinking');
      if (change < -0.3) words.add('collapsing');
    }
    if (o.troops < cfg.maxTroops(o) * 0.25) words.add('troops_depleted');
    if (o.gold >= 5e6 || (o.goldRate || 0) * 10 >= 25000) words.add('rich');
    if (o.gold < 200000) words.add('poor');
    if (o.outgoingAttacks.filter((a) => !a.done && a.target).length >= 3) words.add('overextended');
    if (o.incomingAttacks.filter((a) => !a.done).length >= 1) words.add('busy');
    if (o.isTraitor()) words.add('traitor');
    if (o.disconnected) words.add('offline');
    return { tick: this.tick, words, clumps, tiles: o.numTiles, troops: o.troops, sams: sams.length, silos: silos.length, mechs, warships };
  },
};

module.exports.WORDS = WORDS;
