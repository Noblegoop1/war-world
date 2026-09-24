'use strict';
// AI players. "Nations" are real opponents whose aggression scales with the difficulty setting;
// "Bots" are small tribes that mostly just expand. Nations use every War World system: factories/rail,
// labs + research (and change behaviour based on what they researched), mechs, warships/subs/mines,
// choke-point walls, nukes and bombers.
const { Rng } = require('./rng');
const { PlayerType, UnitType, NukeType, Difficulty, RESEARCH_BY_ID, within } = require('./config');
const R = require('./research').effects;
const { bezierArc, bezierPoint } = require('./path');

// Colonising empty landmasses (see maybeColonise).
const COLONISE_COOLDOWN = 200;             // ticks between attempts
// Minimum ticks between an AI's strategic strikes (easy -> impossible). The AI now routes around SAM
// umbrellas and lands most of what it fires, and gold is plentiful, so the pacing has to come from here
// rather than from missiles being wasted.
const NUKE_CADENCE = [Infinity, 1200, 750, 500];
// Route-search budget for the AI's own boat launches (see Game.sendBoat).
const AI_BOAT_BUDGET = { maxIter: 60000, tries: 3 };
// ---- word memory (see rememberNations) ----
// Chance, per turn, that the nation takes a fresh look at the others (easy -> impossible), and who it
// looks at: easy only its neighbours, impossible every nation on the map, every turn.
const OBSERVE_CHANCE = [0.25, 0.5, 0.75, 1];
const WORD_FADE = 0.7;          // a word not seen again keeps this share of its confidence per look
const WORD_FORGET = 0.15;       // below this it is forgotten
const BELIEVE = 0.5;            // confidence at which a word counts as true
const EARLY_GAME_TICKS = 3000;  // the first five minutes: alliances are cheap and useful
// ---- the finish (see finishMoves) ----
// How much stronger (ATK POWER) than an ally a nation must be before that alliance has outlived its
// purpose (easy -> impossible). Boxed in or restless, it settles for three quarters of this.
const OUTGROWN_RATIO = [4, 2.6, 1.9, 1.5];
// Turns in a row sitting on a full army with nothing to do before a nation forces a decision.
const IDLE_TURNS_LIMIT = [14, 9, 6, 3];
const FORTIFY_INTERVAL = [Infinity, 900, 600, 400];   // ticks between fortification steps (easy -> impossible)
const WALL_FUND_SHARE = [0, 0.15, 0.22, 0.28];        // share of income set aside for linked walls
const ZOMBIE_PUSH_AT = [0.7, 0.6, 0.5, 0.45];   // troop share at which a nation pushes into zombie land
const RUSH_TICKS = 1500;                        // a rush keeps sending waves for up to 2.5 minutes
const RUSH_WAVE_SHARE = [0.4, 0.5, 0.6, 0.7];   // share of the army each wave commits
// Words that make each choice attractive. A choice's appeal for a nation is the sum of its words'
// confidence in that nation's entry of our memory.
const CHOICE_WORDS = {
  nukeClump: { need: ['city_clump', 'industry_clump', 'populated', 'econ_buff', 'research_hub'], why: ['danger', 'attacked_me', 'nuked_me', 'betrayed_me', 'at_war', 'declared_war_on_me', 'strong_army', 'giant', 'growing'], open: ['clump_uncovered', 'no_air_defense'] },
  retaliate: { why: ['attacked_me', 'attacking_me_now', 'betrayed_me', 'nuked_me', 'declared_war_on_me', 'sank_my_ships'], can: ['weak_army', 'troops_depleted', 'busy', 'overextended', 'shrinking', 'collapsing'], cant: ['strong_army', 'fortified', 'walled', 'mech_army', 'giant'] },
  seekAlly: { want: ['neighbor', 'strong_army', 'trade_partner', 'enemy_of_enemy', 'danger', 'rich'], refuse: ['traitor', 'betrayed_me', 'attacked_me', 'attacking_me_now', 'at_war', 'declared_war_on_me', 'nuked_me'] },
  declareWar: { want: ['easy_prey', 'betrayed_me', 'ally_winning', 'collapsing', 'weak_army', 'troops_depleted'], avoid: ['strong_army', 'giant', 'fortified', 'deterrent', 'nuke_armed'] },
  buildArtillery: ['mech_army', 'mech_force', 'heavy_mechs', 'mech_breakers', 'mech_firepower', 'amphibious'],
  buildSam: ['nuclear', 'nuke_armed', 'cheap_nukes', 'mirv', 'bombers', 'bomber_threat', 'sub_nukes'],
  buildPosts: ['aggressive', 'fast_attacks', 'invader', 'strong_army', 'attacking_me_now', 'danger'],
  airlift: ['sam_covered', 'sam_clump', 'walled', 'fortified', 'coastal_fort', 'overseas', 'shot_my_missiles'],
  mechTarget: { want: ['easy_prey', 'weak_army', 'shrinking', 'busy', 'at_war'], avoid: ['artillery_line', 'anti_mech', 'mech_army', 'fortified'] },
  // finishing a nation off - a collapsing enemy, or an ally we have outgrown
  finish: { want: ['easy_prey', 'weak_army', 'troops_depleted', 'shrinking', 'collapsing', 'populated', 'rich', 'small', 'busy', 'traitor', 'outgrown'], avoid: ['strong_army', 'fortified', 'walled', 'mech_army', 'deterrent', 'nuke_armed', 'giant'] },
};
const COLONISE_MIN_TROOP_RATIO = 0.35;     // don't ship out unless reasonably stocked
const COLONISE_ISOLATION_BONUS = 1.5;      // how much an untouched island beats contested ground
const COLONISE_SCORE_THRESHOLD = [400, 160, 60, 25];   // easy -> impossible
// A small island close by is worth a small boat even though its score is low. Within this many tiles,
// any island at least this big gets settled once we have troops to spare.
const SMALL_ISLAND_RANGE = 110;
const SMALL_ISLAND_MIN = 10;

class NationAI {
  constructor(game, player, seed) {
    this.game = game;
    this.p = player;
    this.rng = new Rng(seed);
    this.cfg = game.config;
    this.triggerRatio = this.rng.int(50, 60) / 100;
    this.reserveRatio = this.rng.int(30, 40) / 100;
    this.expandRatio = this.rng.int(10, 20) / 100;
    this.attackRate = this.cfg.nationAttackRate(this.rng);
    this.attackTick = this.rng.int(0, this.attackRate - 1);
    this.lastStructureTick = -10000;
    this.placements = 0;
    this.spawnAttemptTick = this.rng.int(0, 20);
    this.spawnTries = 0;
    this.aggression = 1;      // multiplies willingness to attack (research-driven)
    this.buildBias = 1;
    this.wantFactories = 1;
    this.wantMechs = 0;
    this.wantWarships = 0;
    this.wantSubs = 0;
    this.wantMines = 0;
    this.wantBombers = 0;
    this.nukeBias = 1;
    this.lastWallTick = -10000;
    this.currentEnemy = null;
    this.coloniseAfter = this.rng.int(0, COLONISE_COOLDOWN);
    this.airliftAfter = 0;
    this.wantAirships = 0;
    this.wantAntiSam = 0;
    this.wantAntiAir = 0;
    // ---- intelligence (see observe / note) ----
    this.intel = new Map();       // smallID -> { now, prev } snapshots of every rival
    this.grudge = new Map();      // smallID -> 0..100, what they have done to us lately
    this.samWall = new Map();     // smallID -> times their SAMs shot our missiles down
    this.airWall = new Map();     // smallID -> times they downed our airships
    this.threat = { sams: 0, silos: 0, mechs: 0, air: 0, navy: 0, artillery: 0, bombers: 0 };
    this.posture = 'expand';
    this.labCheckAfter = 0;
    // ---- word memory ----
    this.mem = new Map();          // smallID -> { conf: Map<word, 0..1>, seen: tick, clump: {x,y}|null }
    this.betrayedBy = new Set();
    this.nukedBy = new Set();
    this.sankBy = new Set();
    this.warCheckAfter = 0;
    this.assistAfter = 0;
    // ---- the finish ----
    this.rush = null;              // { target: smallID, until: tick } while we are going all-in on someone
    this.idleTurns = 0;
    this.betrayCheckAfter = 0;
  }

  get difficulty() { return this.cfg.difficulty(); }
  // Zombie mode, before the plague is over: every living nation is on the same side, more or less.
  get zombieSiege() { const z = this.game.zombie; return !!z && (z.phase === 'calm' || z.phase === 'outbreak'); }
  get hardOrWorse() { return this.difficulty === Difficulty.HARD || this.difficulty === Difficulty.IMPOSSIBLE; }
  get diffIndex() { return { easy: 0, medium: 1, hard: 2, impossible: 3 }[this.difficulty]; }

  tick() {
    const g = this.game, p = this.p;
    if (g.phase === 'spawn') {
      if (!p.spawned && g.tick >= this.spawnAttemptTick) {
        let t = p.nationSpawn ? g.randomSpawnTile(this.cfg.minDistanceBetweenPlayers() * 0.5, p.nationSpawn) : null;
        if (t === null && (!p.nationSpawn || this.spawnTries++ > 3)) t = g.randomSpawnTile(this.cfg.minDistanceBetweenPlayers());
        if (t !== null) g.spawn(p, t);
        else this.spawnAttemptTick = g.tick + 10;
      }
      return;
    }
    if (!p.alive) return;
    const rate = this.attackRate;
    const offset = g.tick % rate;
    if (offset !== this.attackTick) {
      const oneThird = (this.attackTick + Math.floor(rate / 3)) % rate;
      const twoThirds = (this.attackTick + Math.floor((rate * 2) / 3)) % rate;
      if (offset === oneThird || offset === twoThirds) this.handleStructures();
      if (offset === oneThird) this.handleMechs();
      return;
    }
    this.observe();
    this.handleAllianceRequests();
    this.manageSharing();
    this.handleLabs();
    this.handleStructures();
    this.handleNavy();
    this.handleMechs();
    this.counterMechs();
    this.maybeAttack();
    this.maybeAirlift();
    this.maybeNuke();
    this.maybeBomb();
  }

  // ======================================================================================
  // Intelligence. A short memory of every rival - what they have built, which doctrines they hold,
  // whether they are growing, and what they have done to us - refreshed each time we act. Posture,
  // research picks and weapon choices read from it instead of only reacting to whoever is adjacent.
  // ======================================================================================
  observe() {
    const g = this.game, p = this.p;
    const neighbours = new Set(g.neighborsOf(p).players);
    const myMass = p.border.size ? g.landmass[p.border.values().next().value] : -1;
    const T = { sams: 0, silos: 0, mechs: 0, air: 0, navy: 0, artillery: 0, bombers: 0 };
    for (const o of g.players) {
      if (o === p || !o.alive || o.type === PlayerType.BOT) continue;
      const n = {};
      for (const u of o.units) if (u.constructionLeft === 0) n[u.type] = (n[u.type] || 0) + 1;
      const snap = {
        tick: g.tick, tiles: o.numTiles, troops: o.troops, gold: o.gold, n,
        mechs: o.mechs.filter((m) => !m.done).length,
        warships: o.warships.filter((w) => !w.done).length,
        subs: o.subs.filter((sb) => !sb.done && sb.detected).length,   // we only know about subs we have seen
        airships: o.airships.filter((a) => !a.done).length,
        researches: [...o.researches],
      };
      const rec = this.intel.get(o.smallID);
      this.intel.set(o.smallID, { now: snap, prev: rec ? rec.now : snap });
      // grudges build up while someone is hitting us and fade otherwise
      let gr = (this.grudge.get(o.smallID) || 0) * 0.93;
      if (p.incomingAttacks.some((a) => !a.done && a.attacker === o)) gr += 12;
      if (p.lastNukedBy === o) gr += 25;
      this.grudge.set(o.smallID, Math.min(100, gr));
      if (!g.hostile(p, o)) continue;
      // how much this rival matters to us: next door, same continent, or far away
      let w = neighbours.has(o) ? 1 : (o.border.size && g.landmass[o.border.values().next().value] === myMass ? 0.55 : 0.3);
      w *= 1 + gr / 60;
      T.sams += (n.sam || 0) * w;
      T.silos += (n.silo || 0) * w;
      T.mechs += snap.mechs * w * (neighbours.has(o) ? 1.5 : 1);
      T.air += ((n.airport || 0) * 2 + snap.airships) * w;
      T.navy += (snap.warships + snap.subs + (o.researches.has('submarine_warfare') ? 2 : 0)) * w;
      T.artillery += (n.artillery || 0) * w;
      if (o.researches.has('strategic_bombers')) T.bombers += w;
    }
    this.threat = T;
    this.posture = this.choosePosture(neighbours);
    this.rememberNations(neighbours);
  }
  // What kind of turn is this? Drives what we build and how much we keep in reserve.
  choosePosture(neighbours) {
    const g = this.game, p = this.p;
    const incoming = p.incomingAttacks.filter((a) => !a.done).reduce((sum, a) => sum + a.troops, 0);
    const hostile = [...neighbours].filter((o) => g.hostile(p, o));
    const strongest = hostile.reduce((m, o) => Math.max(m, o.troops), 0);
    if (incoming > p.troops * 0.35 || strongest > p.troops * 1.6) return 'turtle';
    if (g.neighborsOf(p).touchesNeutral) return 'expand';
    const weak = hostile.find((o) => o.troops < p.troops * 0.6 || (this.grudge.get(o.smallID) || 0) > 40);
    if (weak && p.troops > this.cfg.maxTroops(p) * 0.5) return 'war';
    return 'build';
  }
  // Remember the things that happen to us between turns. Called by the game every tick.
  note(events) {
    const me = this.p.smallID;
    for (const e of events) {
      if (e.k === 'samhit' && e.vs === me) this.samWall.set(e.by, (this.samWall.get(e.by) || 0) + 1);
      else if (e.k === 'airshipDown' && e.p === me) this.airWall.set(e.by, (this.airWall.get(e.by) || 0) + 1);
      else if (e.k === 'sunk' && e.p === me && e.by) { this.grudge.set(e.by, Math.min(100, (this.grudge.get(e.by) || 0) + 4)); this.sankBy.add(e.by); }
      else if (e.k === 'betrayed' && e.p === me) { this.betrayedBy.add(e.by); this.grudge.set(e.by, 100); }
      else if (e.k === 'nuke' && e.target === me) { this.nukedBy.add(e.by); this.grudge.set(e.by, Math.min(100, (this.grudge.get(e.by) || 0) + 40)); }
      else if (e.k === 'warDeclared' && e.on === me) this.grudge.set(e.by, Math.min(100, (this.grudge.get(e.by) || 0) + 25));
      else if (e.k === 'raft' && e.p === me) this.raftsSeen = (this.raftsSeen || 0) + 1;
    }
  }
  // Enemy SAMs that would get a shot at a missile landing on this tile.
  samCover(tile) {
    const g = this.game, p = this.p;
    const x = g.x(tile), y = g.y(tile);
    let n = 0;
    for (const u of g.units) {
      if (u.type !== UnitType.SAM || u.constructionLeft > 0 || !g.hostile(p, u.owner)) continue;
      const r = this.cfg.samRange(u.owner);
      if ((g.x(u.tile) - x) ** 2 + (g.y(u.tile) - y) ** 2 <= r * r) n++;
    }
    return n;
  }
  // ======================================================================================
  // Word memory. Each look at another nation writes words about it with a confidence: the shared,
  // objective profile (what they have built and researched - see intel.js) plus how they relate to us.
  // Choices read these words; see CHOICE_WORDS at the top of the file.
  // ======================================================================================
  rememberNations(neighbours) {
    const g = this.game, p = this.p;
    if (this.rng.next() >= OBSERVE_CHANCE[this.diffIndex]) return;
    // every landmass we hold ground on (sampled from our border)
    const myMasses = new Set();
    { let i = 0; for (const t of p.border) { if (i++ % 7) continue; myMasses.add(g.landmass[t]); if (i > 700) break; } }
    const sharesLand = (o) => { let i = 0; for (const t of o.border) { if (i++ % 7) continue; if (myMasses.has(g.landmass[t])) return true; if (i > 700) break; } return false; };
    const hated = [...this.grudge.entries()].filter(([, v]) => v > 40).map(([k]) => k);
    const allies = g.players.filter((o) => o !== p && o.alive && p.isFriendly(o));
    for (const o of g.players) {
      if (o === p || !o.alive) continue;
      const nb = neighbours.has(o);
      // who we bother looking at depends on how good we are
      const d = this.diffIndex;
      const attacking = p.incomingAttacks.some((a) => !a.done && a.attacker === o);
      const relevant = d >= 3 || nb || attacking || p.isFriendly(o)
        || (d >= 1 && (this.grudge.get(o.smallID) || 0) > 20)
        || (d >= 2 && o.type !== PlayerType.BOT && sharesLand(o));
      if (!relevant) continue;
      if (o.type === PlayerType.BOT && !nb) continue;   // tribes only matter next door
      const prof = g.nationProfile(o);
      const w = new Set(prof.words);
      // ---- how they relate to us ----
      const sameMass = nb || sharesLand(o);   // a shared border is by definition the same continent
      if (nb) w.add('neighbor');
      if (sameMass) w.add('same_continent'); else w.add('overseas');
      if (p.isFriendly(o)) w.add('ally');
      if ((this.grudge.get(o.smallID) || 0) > 20) w.add('attacked_me');
      if (attacking) w.add('attacking_me_now');
      if (this.betrayedBy.has(o.smallID)) w.add('betrayed_me');
      if (this.nukedBy.has(o.smallID) || p.lastNukedBy === o) w.add('nuked_me');
      if (this.sankBy.has(o.smallID)) w.add('sank_my_ships');
      if ((this.samWall.get(o.smallID) || 0) > 0) w.add('shot_my_missiles');
      if ((this.airWall.get(o.smallID) || 0) > 0) w.add('downed_my_airships');
      if (o.warsDeclared && o.warsDeclared.has(p.smallID)) w.add('declared_war_on_me');
      if (p.warsDeclared.has(o.smallID)) w.add('at_war');
      if (g.tradeShips.some((sh) => !sh.done && ((sh.owner === o && sh.dstPort.owner === p) || (sh.owner === p && sh.dstPort.owner === o)))) w.add('trade_partner');
      if (allies.some((a) => o.outgoingAttacks.some((x) => !x.done && x.target === a))) w.add('enemy_of_ally');
      if (allies.some((a) => a.outgoingAttacks.some((x) => !x.done && x.target === o))) {
        w.add('ally_target');
        if (prof.words.has('shrinking') || prof.words.has('collapsing')) w.add('ally_winning');
      }
      if (hated.some((h) => o.outgoingAttacks.some((x) => !x.done && x.target && x.target.smallID === h))) w.add('enemy_of_enemy');
      if (o.troops > p.troops * 1.3) w.add('strong_army');
      if (o.troops < p.troops * 0.6) w.add('weak_army');
      if (o.numTiles > p.numTiles * 2) w.add('giant');
      if (o.numTiles < p.numTiles * 0.5) w.add('small');
      const hostile = g.hostile(p, o);
      if (hostile && (nb || sameMass) && (w.has('strong_army') || w.has('aggressive') || attacking || (w.has('nuke_armed') && (this.grudge.get(o.smallID) || 0) > 0))) w.add('danger');
      if (hostile && nb && w.has('weak_army') && !w.has('fortified') && !w.has('walled')) w.add('easy_prey');
      if (p.allies.has(o.id) && o.type !== PlayerType.BOT && o.troops * OUTGROWN_RATIO[d] < p.troops) w.add('outgrown');
      if (g.lentTo(o, p)) w.add('lends_to_me');
      if (g.lentTo(p, o)) w.add('borrows_from_me');
      if (this.rush && this.rush.target === o.smallID) w.add('rushing');
      // ---- fold into memory: seen words go to 1, the rest fade ----
      let m = this.mem.get(o.smallID);
      if (!m) { m = { conf: new Map(), seen: 0, clump: null }; this.mem.set(o.smallID, m); }
      for (const [k, v] of m.conf) { if (!w.has(k)) { const nv = v * WORD_FADE; if (nv < WORD_FORGET) m.conf.delete(k); else m.conf.set(k, nv); } }
      for (const k of w) m.conf.set(k, 1);
      m.seen = g.tick;
      m.clump = prof.clumps[0] || null;
    }
    // forget the dead
    for (const k of [...this.mem.keys()]) { const o = g.playersBySmall[k]; if (!o || !o.alive) this.mem.delete(k); }
  }
  // Confidence we have in `word` about nation `sm` (0 if never seen).
  know(sm, word) { const m = this.mem.get(sm); return m ? (m.conf.get(word) || 0) : 0; }
  believes(sm, word) { return this.know(sm, word) >= BELIEVE; }
  wordSum(sm, words) { let t = 0; for (const w of words) t += this.know(sm, w); return t; }
  // Every nation we remember, with its memory entry (live ones only).
  remembered() {
    const out = [];
    for (const [sm, m] of this.mem) { const o = this.game.playersBySmall[sm]; if (o && o.alive) out.push([o, m]); }
    return out;
  }
  // For tests / debugging: the words we hold about a nation, strongest first.
  memoryOf(sm) { const m = this.mem.get(sm); return m ? [...m.conf.entries()].sort((a, b) => b[1] - a[1]) : []; }

  // ---- choices driven by the words ----
  // "They are clumped, their clump has no SAM over it, and they are a danger to us": nuke the clump.
  strikeClump() {
    const g = this.game, p = this.p;
    if (g.settings.disableNukes || this.difficulty === Difficulty.EASY || g.tick < (this.nukeAfter || 0)) return false;
    if (!p.completedUnitsOf(UnitType.SILO).some((u) => u.cooldown === 0)) return false;
    const cw = CHOICE_WORDS.nukeClump;
    const cluster = p.researches.has('cluster_munitions');
    const decoys = p.researches.has('decoy_warheads') || p.researches.has('hypersonic_missiles');
    const cands = [];
    for (const [o, m] of this.remembered()) {
      if (!g.hostile(p, o) || !m.clump || o.type === PlayerType.BOT) continue;
      const need = this.wordSum(o.smallID, cw.need);
      const why = this.wordSum(o.smallID, cw.why);
      // Impossible AIs will hit anyone worth hitting; the rest only strike nations that are a problem.
      if (need < 1 || (why < 1 && this.diffIndex < 3)) continue;
      // aim at the clump's own city nearest its centre: the centre itself can be water or a neighbour
      let tile = -1, bd = Infinity;
      for (const u of o.units) {
        if (u.type !== UnitType.CITY) continue;
        const d = (g.x(u.tile) - m.clump.x) ** 2 + (g.y(u.tile) - m.clump.y) ** 2;
        if (d < bd) { bd = d; tile = u.tile; }
      }
      if (tile < 0 || bd > 30 * 30) continue;
      const cover = this.samCoverPath(tile);
      // how much of the strike we expect to land, given the weapons we have
      const lands = cover === 0 ? 1 : cluster ? Math.max(0, 1 - cover / this.cfg.clusterCount()) : decoys && cover <= 1 ? 0.55 : 0;
      if (lands <= 0.3) continue;
      const open = this.wordSum(o.smallID, cw.open);
      cands.push({ o, tile, cover, score: (need + why * 1.5 + open) * (m.clump.levels + m.clump.industry * 2) * lands });
    }
    cands.sort((a, b) => b.score - a.score);
    for (const c of cands.slice(0, 4)) {
      const type = c.cover > 0 && cluster ? NukeType.CLUSTER : NukeType.ATOM;
      if (p.gold < this.cfg.nukeCost(type, p) * 1.1) return false;
      // never onto our own or an ally's land: if this one would splash a friend, try the next
      const { outer } = this.cfg.nukeMagnitude(type, p);
      const bx = g.x(c.tile), by = g.y(c.tile);
      let friendly = false;
      for (let y = Math.max(0, by - outer); y <= Math.min(g.height - 1, by + outer) && !friendly; y += 3) for (let x = Math.max(0, bx - outer); x <= Math.min(g.width - 1, bx + outer); x += 3) {
        const sm = g.owner[g.ref(x, y)];
        if (sm && (sm === p.smallID || p.isFriendly(g.playersBySmall[sm]))) { friendly = true; break; }
      }
      if (friendly) continue;
      if (g.launchNuke(p, type, c.tile).ok) { this.nukeAfter = g.tick + NUKE_CADENCE[this.diffIndex] / this.nukeBias; return true; }
    }
    return false;
  }
  // Hit back - but only when it is a fight we can win, not out of spite.
  smartRetaliate() {
    const g = this.game, p = this.p;
    const cw = CHOICE_WORDS.retaliate;
    let best = null, bestScore = 0;
    for (const [o] of this.remembered()) {
      if (!g.hostile(p, o) || !g.canAttack(p, o)) continue;
      const why = this.wordSum(o.smallID, cw.why);
      if (why < 1) continue;
      const can = this.wordSum(o.smallID, cw.can), cant = this.wordSum(o.smallID, cw.cant);
      // their army against what we can actually spare, adjusted by what we know about them
      const spare = p.troops - this.cfg.maxTroops(p) * this.reserveRatio;
      const odds = spare / Math.max(1, o.troops) * (1 + 0.25 * can) / (1 + 0.2 * cant);
      const threshold = this.betrayedBy.has(o.smallID) ? 0.5 : 0.7;   // betrayal is worth more risk
      if (odds < threshold) continue;
      // don't open a second front while someone stronger is already on us
      const other = p.incomingAttacks.filter((a) => !a.done && a.attacker !== o).reduce((sum, a) => sum + a.troops, 0);
      if (other > p.troops * 0.4) continue;
      const score = why * odds;
      if (score > bestScore) { bestScore = score; best = o; }
    }
    return best ? this.sendAttack(best) : false;
  }
  // ======================================================================================
  // The finish. A nation that is winning keeps its foot down: it breaks alliances that have outlived
  // their purpose and rushes the former ally, finishes off neighbours that are collapsing, and never sits
  // on a full army for long with nothing to do.
  // ======================================================================================
  finishMoves() {
    const g = this.game, p = this.p;
    if (this.zombieSiege) return this.zombieMoves();
    // an active rush keeps sending waves until the target is gone or it stops paying
    if (this.rush) {
      const o = g.playersBySmall[this.rush.target];
      if (!o || !o.alive || g.tick > this.rush.until || p.isFriendly(o) || o.troops > p.troops * 1.1 || this.posture === 'turtle') this.rush = null;
      else if (this.rushWave(o)) return true;
    }
    const busy = p.outgoingAttacks.some((a) => !a.done) || p.boats.some((b) => !b.done);
    if (!busy && p.troops >= this.cfg.maxTroops(p) * 0.8) this.idleTurns++; else this.idleTurns = 0;
    const restless = this.idleTurns >= IDLE_TURNS_LIMIT[this.diffIndex];
    if (this.finishCollapsing()) return true;
    if (this.betrayOutgrownAlly(restless)) return true;
    if (restless && this.breakStalemate()) return true;
    return false;
  }
  startRush(o) {
    const g = this.game, p = this.p;
    if (this.difficulty !== Difficulty.EASY && !p.isFriendly(o) && !p.warsDeclared.has(o.smallID) && o.type !== PlayerType.BOT) g.declareWar(p, o);
    this.rush = { target: o.smallID, until: g.tick + RUSH_TICKS };
    this.currentEnemy = o;
    this.idleTurns = 0;
    return this.rushWave(o, true);
  }
  // One wave of a rush: a big share of the army, minus what we need to hold off anyone else next door.
  rushWave(o, first = false) {
    const g = this.game, p = this.p;
    if (!g.canAttack(p, o)) return false;
    const { players: nb } = g.neighborsOf(p);
    let guard = 0;
    for (const n of nb) if (n !== o && g.hostile(p, n) && n.type !== PlayerType.BOT) guard = Math.max(guard, n.troops * 0.5);
    const share = Math.min(0.85, RUSH_WAVE_SHARE[this.diffIndex] * (first ? 1.15 : 1));
    const troops = Math.floor(Math.min(p.troops * share, p.troops - guard));
    if (troops < Math.max(1000, o.troops * 0.15)) return false;
    this.currentEnemy = o;
    if (nb.includes(o)) return g.sendAttack(p, o, troops, null, this.chooseFocus(o)) !== null;
    // not next door: land on their coast
    if (g.settings.disableBoats || p.boats.length >= this.cfg.boatMaxNumber(p) || g.pathBudget-- <= 0) return false;
    const shore = this.shoreTiles(o, 60);
    if (!shore.length) return false;
    return g.sendBoat(p, this.rng.pick(shore), Math.floor(troops * 0.6), AI_BOAT_BUDGET) !== null;
  }
  // A hostile neighbour that is falling apart gets finished, not left to recover.
  finishCollapsing() {
    const g = this.game, p = this.p;
    if (this.diffIndex === 0 && !this.rng.chance(3)) return false;
    const cw = CHOICE_WORDS.finish;
    let best = null, bestScore = 0;
    for (const o of g.neighborsOf(p).players) {
      if (!g.hostile(p, o) || o.type === PlayerType.BOT || !g.canAttack(p, o)) continue;
      if (o.troops >= p.troops * 0.3) continue;
      const falling = this.believes(o.smallID, 'collapsing') || this.believes(o.smallID, 'shrinking') || this.believes(o.smallID, 'troops_depleted') || o.troops < p.troops * 0.12;
      if (!falling) continue;
      const score = 1 + this.wordSum(o.smallID, cw.want) - 0.5 * this.wordSum(o.smallID, cw.avoid);
      if (score > bestScore) { bestScore = score; best = o; }
    }
    return best ? this.startRush(best) : false;
  }
  // An alliance is a tool. Once we are far stronger than an ally next door, nobody dangerous is left for
  // it to help with, and its land is where we would grow, it is broken on the spot and the ally rushed.
  // Breaking it marks us a traitor for a while (weaker defence), so only a nation with nobody dangerous
  // at its back does it.
  betrayOutgrownAlly(restless) {
    const g = this.game, p = this.p;
    if (g.tick < EARLY_GAME_TICKS || g.tick < this.betrayCheckAfter || p.isTraitor() || this.posture === 'turtle') return false;
    this.betrayCheckAfter = g.tick + 100;
    const { players: nb, touchesNeutral } = g.neighborsOf(p);
    const myPow = g.attackPower(p);
    for (const o of nb) if (g.hostile(p, o) && o.type !== PlayerType.BOT && g.attackPower(o) > myPow * 0.6) return false;
    const boxedIn = !touchesNeutral && !nb.some((o) => g.hostile(p, o) && o.troops < p.troops * 0.8);
    const need = OUTGROWN_RATIO[this.diffIndex] * (boxedIn || restless ? 0.75 : 1);
    const cw = CHOICE_WORDS.finish;
    let best = null, bestScore = 0;
    for (const a of nb) {
      if (!p.allies.has(a.id) || a.type === PlayerType.BOT || !a.alive || g.sameTeam(p, a)) continue;
      const ratio = myPow / Math.max(1, g.attackPower(a));
      // an ally that shares its research with us has earned a little more patience
      if (ratio < need * (g.lentTo(a, p) ? 1.3 : 1) || p.troops < a.troops * 1.3) continue;
      // an ally still holding off someone dangerous for us keeps its purpose
      if (a.incomingAttacks.some((x) => !x.done && x.attacker !== p && g.hostile(p, x.attacker) && x.attacker.troops > p.troops * 0.5)) continue;
      const score = ratio * (1 + 0.25 * this.wordSum(a.smallID, cw.want)) / (1 + 0.3 * this.wordSum(a.smallID, cw.avoid)) * (0.5 + a.numTiles / Math.max(1, p.numTiles));
      if (score > bestScore) { bestScore = score; best = a; }
    }
    if (!best) return false;
    g.breakAlliance(p, best);
    return this.startRush(best);
  }
  // Sat on a full army for too long: hit the weakest non-ally we can reach, by land or by sea.
  breakStalemate() {
    const g = this.game, p = this.p;
    const nb = g.neighborsOf(p).players.filter((o) => g.hostile(p, o) && g.canAttack(p, o)).sort((a, b) => a.troops - b.troops);
    const nextDoor = nb.find((o) => o.troops < p.troops * 1.2);
    if (nextDoor) { this.idleTurns = 0; return nextDoor.type === PlayerType.BOT ? this.sendAttack(nextDoor) : this.startRush(nextDoor); }
    const far = g.players.filter((o) => o.alive && o !== p && o.type !== PlayerType.BOT && g.hostile(p, o) && g.canAttack(p, o) && o.troops < p.troops * 0.8)
      .sort((a, b) => a.troops - b.troops);
    if (far.length) return this.startRush(far[0]);
    return false;
  }
  // Allies fighting someone next to us: lend a hand, and if they are winning, join the land grab.
  assistAllies() {
    const g = this.game, p = this.p;
    if (g.tick < this.assistAfter) return false;
    this.assistAfter = g.tick + 120;
    for (const [o] of this.remembered()) {
      if (!this.believes(o.smallID, 'ally_target') || !g.hostile(p, o) || !g.canAttack(p, o)) continue;
      if (!this.believes(o.smallID, 'neighbor') && !this.believes(o.smallID, 'same_continent')) continue;
      const winning = this.believes(o.smallID, 'ally_winning') || this.believes(o.smallID, 'collapsing');
      const share = winning ? 0.4 : 0.1;
      const troops = Math.floor(p.troops * share);
      if (troops < 1000 || p.troops < this.cfg.maxTroops(p) * (winning ? 0.35 : 0.5)) continue;
      if (winning && !p.warsDeclared.has(o.smallID) && this.difficulty !== Difficulty.EASY) g.declareWar(p, o);   // rush: take the +15%
      this.currentEnemy = o;
      return g.sendAttack(p, o, troops, null, this.chooseFocus(o)) !== null;
    }
    return false;
  }
  // Declare war when we are committing to a real offensive; make peace when it stops paying.
  manageWars() {
    const g = this.game, p = this.p;
    if (this.zombieSiege) { for (const [sm] of [...p.warsDeclared]) { const o = g.playersBySmall[sm]; if (o) g.makePeace(p, o); } return; }
    if (this.difficulty === Difficulty.EASY || g.tick < this.warCheckAfter) return;
    this.warCheckAfter = g.tick + 300;
    const cw = CHOICE_WORDS.declareWar;
    // end wars that no longer make sense: target dead, now stronger than us, or we are being overrun
    for (const [sm] of [...p.warsDeclared]) {
      const o = g.playersBySmall[sm];
      if (!o || !o.alive || this.posture === 'turtle' || (o.troops > p.troops * 1.2 && !this.betrayedBy.has(sm))) g.makePeace(p, o);
    }
    if (p.warsDeclared.size || this.posture !== 'war') return;
    let best = null, bestScore = 1.5;
    for (const [o] of this.remembered()) {
      if (!g.hostile(p, o) || o.type === PlayerType.BOT || !this.believes(o.smallID, 'neighbor')) continue;
      const score = this.wordSum(o.smallID, cw.want) - this.wordSum(o.smallID, cw.avoid) * 0.8;
      if (score > bestScore) { bestScore = score; best = o; }
    }
    if (best) { g.declareWar(p, best); this.currentEnemy = best; }
  }
  // Buildings the words call for, on top of the usual build order.
  wordDrivenBuilds(reserve) {
    const g = this.game, p = this.p;
    const threat = (words) => {
      let t = 0;
      for (const [o] of this.remembered()) if (g.hostile(p, o) && (this.believes(o.smallID, 'neighbor') || this.believes(o.smallID, 'same_continent'))) t += this.wordSum(o.smallID, words);
      return t;
    };
    // mechs next door: artillery
    if (p.unitsOf(UnitType.ARTILLERY).length < 3 && threat(CHOICE_WORDS.buildArtillery) >= 1.5) {
      const cost = this.cfg.unitCost(UnitType.ARTILLERY, p.unitsOf(UnitType.ARTILLERY).length, p);
      if (p.gold >= cost + reserve) { const t = this.tileNearThreat() ?? this.randomInnerTile(); if (t !== null && g.build(p, UnitType.ARTILLERY, t).ok) return true; }
    }
    // nukes or bombers in reach: a SAM over our biggest clump of cities
    if (!g.settings.disableNukes && p.unitsOf(UnitType.SAM).length < 3 && threat(CHOICE_WORDS.buildSam) >= 1.5) {
      const cost = this.cfg.unitCost(UnitType.SAM, p.unitsOf(UnitType.SAM).length, p);
      const mine = g.nationProfile(p).clumps[0];
      if (mine && p.gold >= cost + reserve) {
        const t = this.deepTileNear(mine.x, mine.y, 12, (tt) => !!g.samAirportConflict(p, UnitType.SAM, tt));
        if (t !== null && g.build(p, UnitType.SAM, t).ok) return true;
      }
    }
    return false;
  }

  // Enemy SAMs that get a shot at a missile on its way from our nearest silo to this tile. The missile
  // flies a curved arc and any SAM along that arc can take it, not just the ones around the target -
  // so walk the same arc the simulation uses and count every launcher whose umbrella it crosses.
  samCoverPath(tile) {
    const g = this.game, p = this.p;
    const silos = p.completedUnitsOf(UnitType.SILO);
    if (!silos.length) return this.samCover(tile);
    const tx = g.x(tile), ty = g.y(tile);
    const silo = silos.reduce((a, b) => (g.dist(a.tile, tile) <= g.dist(b.tile, tile) ? a : b));
    const arc = bezierArc(g.x(silo.tile) + 0.5, g.y(silo.tile) + 0.5, tx + 0.5, ty + 0.5);
    const sams = g.units.filter((u) => u.type === UnitType.SAM && u.constructionLeft === 0 && g.hostile(p, u.owner));
    if (!sams.length) return 0;
    const hit = new Set();
    for (let t = 0; t <= 1.0001; t += 0.04) {
      const pt = bezierPoint(arc, t);
      for (const u of sams) {
        if (hit.has(u)) continue;
        const r = this.cfg.samRange(u.owner);
        if ((g.x(u.tile) - pt.x) ** 2 + (g.y(u.tile) - pt.y) ** 2 <= r * r) hit.add(u);
      }
    }
    return hit.size;
  }
  // The deepest tile we own near a point: where a lab or anything precious should live.
  deepTileNear(cx, cy, radius, avoid = () => false) {
    const g = this.game, p = this.p;
    const front = [];
    let i = 0;
    for (const t of p.border) {
      if (i++ % 3) continue;
      const c = g.neighbors4(t, this.nb4 || (this.nb4 = [0, 0, 0, 0]));
      for (let k = 0; k < c; k++) { const o = g.owner[this.nb4[k]]; if (o && o !== p.smallID) { front.push(t); break; } }
      if (front.length > 300) break;
    }
    let best = null, bestScore = -Infinity;
    for (let tries = 0; tries < 60; tries++) {
      const x = Math.round(cx + this.rng.int(-radius, radius)), y = Math.round(cy + this.rng.int(-radius, radius));
      if (!g.valid(x, y)) continue;
      const t = g.ref(x, y);
      if (g.owner[t] !== p.smallID || p.border.has(t) || g.unitNear(t, 3) || avoid(t)) continue;
      let dFront = 1e9;
      for (const f of front) { const d = (g.x(f) - x) ** 2 + (g.y(f) - y) ** 2; if (d < dFront) dFront = d; }
      const score = Math.sqrt(dFront) - this.samCover(t) * 0 - Math.hypot(x - cx, y - cy) * 0.1;
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return best;
  }
  // Labs: put them deep inside, upgrade the busy one, and open another when the slots run out.
  handleLabs() {
    const g = this.game, p = this.p;
    if (g.isZombieGame() && g.canStartCure(p).ok) g.startCure(p);   // the cure comes before any doctrine
    if (this.difficulty === Difficulty.EASY || g.tick < this.labCheckAfter) return;
    this.labCheckAfter = g.tick + 150;
    const labs = p.completedUnitsOf(UnitType.LAB);
    const reserve = p.unitsOf(UnitType.SILO).length ? this.cfg.nukeCost(NukeType.ATOM, p) : 0;
    // speed up whichever lab is working right now
    const busy = p.research ? labs.find((l) => l.id === p.research.labId) : null;
    if (busy && busy.level < this.cfg.maxUnitLevel(p, UnitType.LAB) && this.posture !== 'turtle'
        && p.gold >= this.cfg.labUpgradeCost(busy.level) * 1.1 + reserve * 0.3) {
      if (g.build(p, UnitType.LAB, busy.tile).ok) return;
    }
    // all slots used: another lab, if we can afford the 5x ladder without starving the army
    if (labs.length && p.researchCount() >= this.cfg.maxResearchesPerPlayer(p) && this.posture === 'build') {
      const cost = this.cfg.unitCost(UnitType.LAB, g.costIndex(p, UnitType.LAB), p);
      if (p.gold >= cost * 1.3 + reserve) {
        const fac = p.completedUnitsOf(UnitType.FACTORY)[0];
        if (fac) {
          const t = this.deepTileNear(g.x(fac.tile), g.y(fac.tile), 80, (tt) => g.hasPopulationNear(tt, this.cfg.labMinGapFromPopulation()));
          if (t !== null) g.build(p, UnitType.LAB, t);
        }
      }
    }
  }

  // Called when a research completes: adopt the doctrine.
  onResearch() {
    const p = this.p;
    this.aggression = 1; this.buildBias = 1; this.wantFactories = 1; this.wantMechs = 0; this.wantWarships = 0; this.wantSubs = 0; this.wantMines = 0; this.wantBombers = 0; this.wantAirships = 0; this.wantAntiSam = 0; this.wantAntiAir = 0; this.nukeBias = 1;
    for (const id of p.researches) {
      const r = RESEARCH_BY_ID[id];
      if (!r || !r.ai) continue;
      if (r.ai.aggression) this.aggression *= r.ai.aggression;
      if (r.ai.build) this.buildBias *= r.ai.build;
      if (r.ai.factories) this.wantFactories = Math.max(this.wantFactories, r.ai.factories);
      if (r.ai.mechs) this.wantMechs += r.ai.mechs;
      if (r.ai.warships) this.wantWarships += r.ai.warships;
      if (r.ai.subs) this.wantSubs += r.ai.subs;
      if (r.ai.mines) this.wantMines += r.ai.mines;
      if (r.ai.bombers) this.wantBombers += r.ai.bombers;
      if (r.ai.airships) this.wantAirships += r.ai.airships;
      if (r.ai.antiSam) this.wantAntiSam += r.ai.antiSam;
      if (r.ai.antiAir) this.wantAntiAir += r.ai.antiAir;
      if (r.ai.nukes) this.nukeBias *= 1 + 0.5 * r.ai.nukes;
    }
    // war economy pays for attacking: keep less in reserve
    if (p.researches.has('war_economy')) this.reserveRatio = Math.max(0.2, this.reserveRatio * 0.7);
  }

  // ---- attacking ------------------------------------------------------------
  // Where we'd like expansion pulled: toward the current enemy, else toward the largest neutral area.
  chooseFocus(target) {
    const g = this.game, p = this.p;
    // a mech leading the way into that nation is where the attack should go: it is the spearhead
    if (target) {
      const lead = p.mechs.find((m) => !m.done && !m.onWater && g.owner[g.tileAt(m.x, m.y)] === target.smallID)
        || p.mechs.find((m) => !m.done && m.mode === 'assault' && m.orderTarget === target.smallID);
      if (lead) return g.tileAt(lead.x, lead.y);
    }
    if (target) { const c = g.centroid(target); if (c) return g.ref(Math.round(c.x), Math.round(c.y)); }
    // neutral: sample border tiles' outward neighbours, pick the direction with the most neutral land in a 25-tile probe
    let bestT = -1, bestScore = -1;
    const mine = g.centroid(p) || { x: 0, y: 0 };
    let i = 0;
    for (const t of p.border) {
      if (i++ % 7) continue;
      if (i > 700) break;
      const dx = g.x(t) - mine.x, dy = g.y(t) - mine.y, l = Math.hypot(dx, dy) || 1;
      let score = 0;
      for (let k = 6; k <= 30; k += 6) {
        const x = Math.round(g.x(t) + (dx / l) * k), y = Math.round(g.y(t) + (dy / l) * k);
        if (!g.valid(x, y)) break;
        const tt = g.ref(x, y);
        if (g.isLand(tt) && g.owner[tt] === 0) score += g.fallout[tt] ? 0.5 : 1;   // nuked ground still counts, just discounted
      }
      if (score > bestScore) { bestScore = score; bestT = t; }
    }
    return bestT;
  }
  maybeAttack() {
    const g = this.game, p = this.p;
    const { players: neighbors, touchesNeutral } = g.neighborsOf(p);
    neighbors.sort((a, b) => a.troops - b.troops);
    const friends = neighbors.filter((o) => p.isFriendly(o));
    let enemies = neighbors.filter((o) => !p.isFriendly(o));
    // zombie siege: the living leave each other alone unless someone starts it
    if (this.zombieSiege) enemies = enemies.filter((o) => o.isHorde || o.type === PlayerType.BOT || p.incomingAttacks.some((a) => !a.done && a.attacker === o));
    this.manageWars();
    if (this.finishMoves()) return;
    if (this.assistAllies()) return;
    if (touchesNeutral && this.sendAttack(null)) return;
    // Nothing left to walk into: look for an empty landmass worth shipping troops to.
    if (this.maybeColonise()) return;
    if (enemies.length === 0) {
      if (this.rng.chance(5)) this.attackWithRandomBoat();
    } else {
      if (this.rng.chance(10)) { this.attackWithRandomBoat(enemies); return; }
      this.maybeSendAllianceRequests(enemies);
    }
    this.attackBestTarget(friends, enemies);
  }
  attackBestTarget(friends, enemies) {
    const p = this.p;
    const max = this.cfg.maxTroops(p);
    const ratio = p.troops / max;
    if (ratio < this.reserveRatio / this.aggression) return;
    if (ratio < this.triggerRatio / this.aggression && !this.rng.chance(10)) return;
    for (const s of this.getStrategies(friends, enemies)) if (s()) return;
  }
  getStrategies(friends, enemies) {
    const p = this.p, g = this.game;
    // Hit back only when the words say we can win it (see smartRetaliate); fall back to the plain version
    // for nations we have no memory of yet.
    const retaliate = () => {
      if (this.smartRetaliate()) return true;
      const inc = p.incomingAttacks.find((a) => a.attacker.alive && !p.isFriendly(a.attacker) && !this.mem.has(a.attacker.smallID));
      return inc ? this.sendAttack(inc.attacker) : false;
    };
    const bots = () => { const bot = enemies.find((e) => e.type === PlayerType.BOT); return bot ? this.sendAttack(bot) : false; };
    const assist = () => { for (const f of friends) for (const a of f.incomingAttacks) if (enemies.includes(a.attacker)) return this.sendAttack(a.attacker); return false; };
    const betray = () => {
      if (!this.hardOrWorse || !this.rng.chance(40)) return false;
      const weak = friends.find((f) => f.troops < this.cfg.maxTroops(f) * 0.15 && f.troops < p.troops * 0.5 && f.type !== PlayerType.HUMAN);
      if (!weak) return false;
      g.breakAlliance(p, weak);
      return this.sendAttack(weak);
    };
    const hated = () => { for (const e of enemies) if (p.relation(e) <= -50 && e.troops < p.troops * 3) return this.sendAttack(e); return false; };
    const afk = () => { const e = enemies.find((o) => o.disconnected && o.troops < p.troops * 3); return e ? this.sendAttack(e) : false; };
    const traitor = () => { const e = enemies.find((o) => o.isTraitor()); return e ? this.sendAttack(e) : false; };
    const victim = () => {
      const e = enemies.find((o) => { if (o.troops > p.troops * 1.2) return false; const incoming = o.incomingAttacks.reduce((s, a) => s + a.troops, 0); return incoming > o.troops * 0.5; });
      return e ? this.sendAttack(e) : false;
    };
    const veryWeak = () => { const e = enemies.find((o) => o.troops < this.cfg.maxTroops(o) * 0.15 && o.troops < p.troops * 1.2); return e ? this.sendAttack(e) : false; };
    const juicy = () => {
      const cands = enemies.filter((o) => o.troops <= p.troops * 0.75);
      if (!cands.length) return false;
      cands.sort((a, b) => b.numTiles + b.units.length * 200 - (a.numTiles + a.units.length * 200));
      return this.sendAttack(cands[0]);
    };
    const weakest = () => { if (!enemies.length) return false; const w = enemies[0]; return w.troops < p.troops * this.aggression ? this.sendAttack(w) : false; };
    const island = () => (enemies.length === 0 ? this.attackWithRandomBoat() : false);
    const donate = () => {
      for (const f of friends) {
        if (f.troops < this.cfg.maxTroops(f) * 0.2 && f.incomingAttacks.length > 0 && p.troops > this.cfg.maxTroops(p) * 0.6) { g.donate(p, f, Math.floor(p.troops * 0.2), 0); return true; }
      }
      return false;
    };
    switch (this.difficulty) {
      case Difficulty.EASY: return [bots, retaliate, assist, betray, hated, weakest];
      case Difficulty.MEDIUM: return [bots, retaliate, assist, betray, hated, afk, traitor, weakest, island, donate];
      case Difficulty.HARD: return [bots, retaliate, assist, betray, traitor, afk, hated, veryWeak, juicy, victim, weakest, island, donate];
      default: return [retaliate, bots, veryWeak, betray, assist, victim, traitor, juicy, afk, hated, weakest, island, donate];
    }
  }
  troopSendCap() {
    const p = this.p;
    let retain;
    if (this.difficulty === Difficulty.HARD) retain = 0.75;
    else if (this.difficulty === Difficulty.IMPOSSIBLE) retain = 0.9;
    else return Infinity;
    let maxNeighbor = 0;
    for (const n of this.game.neighborsOf(p).players) if (!p.isFriendly(n) && n.type !== PlayerType.BOT && n.troops > maxNeighbor) maxNeighbor = n.troops;
    let cap = maxNeighbor === 0 ? Infinity : Math.max(0, p.troops - Math.ceil(maxNeighbor * retain / this.aggression));
    const incoming = p.incomingAttacks.reduce((s, a) => s + a.troops, 0);
    if (incoming > 0) cap = Math.max(cap, incoming);
    return cap;
  }
  calculateAttackTroops(target, boat = false) {
    const p = this.p;
    const max = this.cfg.maxTroops(p);
    const isBot = target && target.type === PlayerType.BOT;
    const reserve = (target && !isBot) ? this.reserveRatio : this.expandRatio;
    const keep = max * reserve;
    let troops;
    if (boat) troops = p.troops / 5;
    else if (isBot) {
      const avail = p.troops - keep;
      troops = this.difficulty === Difficulty.EASY ? avail : Math.min(avail, target.troops * 4);
      if (avail < target.troops * 2 && this.difficulty !== Difficulty.EASY) troops = 0;
    } else troops = p.troops - keep;
    let cap = this.troopSendCap();
    if (!target && cap <= 0) cap = Math.ceil(p.troops * 0.05);
    troops = Math.min(troops, cap);
    if (troops < 1) return null;
    if (target && this.hardOrWorse && p.incomingAttacks.length === 0 && troops < target.troops * 0.2) return null;
    return Math.floor(troops);
  }
  sendAttack(target) {
    if (target && !this.game.canAttack(this.p, target)) return false;
    const troops = this.calculateAttackTroops(target);
    if (troops === null) return false;
    if (target) this.currentEnemy = target;
    const focus = this.chooseFocus(target);
    return this.game.sendAttack(this.p, target, troops, null, focus) !== null;
  }
  shoreTiles(player, limit = 400, ocean = false) {
    const g = this.game, out = [];
    for (const t of player.border) { if (ocean ? g.isOceanShore(t) : g.isShore(t)) { out.push(t); if (out.length >= limit) break; } }
    return out;
  }
  // Ship troops to the best unclaimed landmass. This is what stops empty ground like Greenland or
  // Antarctica sitting untouched all game: those score highly because they are big and nobody borders
  // them, which also makes them the safest ground to own.
  maybeColonise() {
    const g = this.game, p = this.p;
    if (g.settings.disableBoats || !p.alive) return false;
    if (this.game.tick < this.coloniseAfter) return false;
    if (p.boats.filter((b) => !b.done).length >= this.cfg.boatMaxNumber(p)) return false;
    // don't ship troops out while we are being overrun
    const underAttack = p.incomingAttacks.reduce((sum, a) => sum + (a.done ? 0 : a.troops), 0);
    if (underAttack > p.troops * 0.4) return false;
    if (p.troops < this.cfg.maxTroops(p) * COLONISE_MIN_TROOP_RATIO) return false;
    if (!this.shoreTiles(p, 1, true).length) return false;
    const regions = g.neutralRegions();
    if (!regions.length) return false;
    const c = g.centroid(p);
    if (!c) return false;
    let best = null, bestScore = 0, bestShore = null;
    for (const r of regions) {
      // nearest landing site, so distance reflects the actual trip rather than the region's middle
      let shore = null, sd = Infinity;
      for (const t of r.shores) { const d = g.dist(t, g.ref(Math.round(c.x), Math.round(c.y))); if (d < sd) { sd = d; shore = t; } }
      if (shore === null) continue;
      // Big is good, close is good, and land nobody else touches is worth a premium: it is defensible
      // and we get to take all of it. `hostile` counts tiles of the region that border someone.
      const isolation = 1 - Math.min(1, r.hostile / Math.max(1, r.edge + r.hostile));
      const score = (r.size * (1 + COLONISE_ISOLATION_BONUS * isolation)) / (1 + sd / 60);
      if (score > bestScore) { bestScore = score; best = r; bestShore = shore; }
    }
    // Nearby small islands: the score formula undervalues them, but they cost almost nothing to take.
    if (!best || bestScore < COLONISE_SCORE_THRESHOLD[this.diffIndex]) {
      for (const r of regions) {
        if (r.size < SMALL_ISLAND_MIN || r.hostile > 0) continue;   // untouched islands only
        for (const t of r.shores) {
          const d = g.dist(t, g.ref(Math.round(c.x), Math.round(c.y)));
          if (d <= SMALL_ISLAND_RANGE && (!best || bestScore < COLONISE_SCORE_THRESHOLD[this.diffIndex] || d < 40)) { best = r; bestShore = t; bestScore = 1e9; break; }
        }
        if (bestScore === 1e9) break;
      }
    }
    if (!best) return false;
    // Weaker AIs only bother with what is close; the good ones will cross an ocean for a free continent.
    if (bestScore < COLONISE_SCORE_THRESHOLD[this.diffIndex]) return false;
    if (g.pathBudget-- <= 0) return false;
    let troops = this.calculateAttackTroops(null, true);
    if (troops === null) return false;
    troops = Math.min(troops, Math.max(4000, best.size * 120));   // enough to take the island, no more
    const sent = g.sendBoat(p, bestShore, troops, AI_BOAT_BUDGET) !== null;
    // back off either way: a failed route usually means no sea path, and retrying every tick is waste
    this.coloniseAfter = g.tick + (sent ? COLONISE_COOLDOWN : COLONISE_COOLDOWN * 3);
    return sent;
  }
  attackWithRandomBoat(enemies = []) {
    const g = this.game, p = this.p;
    if (g.settings.disableBoats) return false;
    if (p.boats.length >= this.cfg.boatMaxNumber(p)) return false;
    if (!this.shoreTiles(p, 1).length) return false;
    const candidates = g.players.filter((o) => o !== p && o.alive && !p.isFriendly(o) && !enemies.includes(o) && o.troops < p.troops * 0.8 && g.canAttack(p, o));
    let dstTile = null;
    if (candidates.length && this.rng.chance(2)) {
      const target = this.rng.pick(candidates);
      const shore = this.shoreTiles(target, 60);
      if (shore.length) dstTile = this.rng.pick(shore);
    } else {
      for (let i = 0; i < 40 && dstTile === null; i++) {
        const t = this.rng.int(0, g.terrain.length - 1);
        if (g.isLand(t) && g.owner[t] === 0 && !g.fallout[t] && g.isShore(t)) dstTile = t;
      }
    }
    if (dstTile === null) return false;
    if (g.pathBudget-- <= 0) return false;
    const troops = this.calculateAttackTroops(g.ownerOf(dstTile), true);
    if (troops === null) return false;
    return g.sendBoat(p, dstTile, troops, AI_BOAT_BUDGET) !== null;
  }

  // ---- alliances --------------------------------------------------------------
  handleAllianceRequests() {
    const g = this.game, p = this.p;
    for (const [, r] of [...g.allianceRequests]) {
      if (r.to !== p) continue;
      const from = r.from;
      const sm = from.smallID, cw = CHOICE_WORDS.seekAlly;
      let accept;
      if (this.wordSum(sm, cw.refuse) >= 1) accept = false;          // traitors, attackers, betrayers
      else if (this.zombieSiege) accept = !this.betrayedBy.has(sm);   // against the dead, any friend will do
      else if (g.tick < EARLY_GAME_TICKS) accept = p.relation(from) > -20 && !this.rng.chance(5);   // early: take the trade bonus
      // later on an alliance has to be worth something: a partner that can hold its own, a common enemy,
      // or protection while we are under pressure. A weak nation asking a strong one is asking to be eaten.
      else accept = p.relation(from) > -20 && !this.rush && (from.troops > p.troops * 0.6 || this.wordSum(sm, cw.want) >= 2 || this.posture === 'turtle')
        && from.troops * OUTGROWN_RATIO[this.diffIndex] >= p.troops && !this.rng.chance(4);
      g.replyAlliance(p, from, accept);
    }
  }
  maybeSendAllianceRequests(enemies) {
    const g = this.game, p0 = this.p;
    if (this.zombieSiege && this.rng.chance(2)) {
      const cands = g.players.filter((o) => o !== p0 && o.alive && !o.isHorde && o.type !== PlayerType.BOT && !p0.isFriendly(o) && !this.betrayedBy.has(o.smallID)
        && (this.believes(o.smallID, 'neighbor') || this.believes(o.smallID, 'same_continent')));
      if (cands.length) { g.requestAlliance(p0, this.rng.pick(cands)); return; }
    }
    // Early on, friendly neighbours are worth courting: allied trade pays both sides 75% more.
    if (g.tick < EARLY_GAME_TICKS && this.rng.chance(3)) {
      const cw = CHOICE_WORDS.seekAlly;
      const cands = this.remembered().map(([o]) => o).filter((o) => o.type !== PlayerType.BOT && g.hostile(p0, o)
        && this.wordSum(o.smallID, cw.refuse) < 1 && this.wordSum(o.smallID, cw.want) >= 1);
      cands.sort((a, b) => this.wordSum(b.smallID, cw.want) - this.wordSum(a.smallID, cw.want));
      if (cands.length) { g.requestAlliance(p0, cands[0]); return; }
    }
    if (!this.rng.chance(15)) return;
    const p = this.p;
    const strong = enemies.filter((e) => e.type !== PlayerType.BOT && e.troops > p.troops && p.relation(e) >= 0 && e.incomingAttacks.every((a) => a.attacker !== p));
    if (strong.length) this.game.requestAlliance(p, this.rng.pick(strong));
  }

  // ---- structures --------------------------------------------------------------
  handleStructures() {
    const g = this.game, p = this.p;
    this.accrueWallFund();
    if (this.placements > 0 && this.tryBuildDefensePost()) return;
    if (this.placements > 0 && this.maybeBuildWall()) return;
    if (this.placements > 2 && this.fortifyClusters()) return;
    if (g.tick - this.lastStructureTick < 80 / this.buildBias) return;
    const built = this.doHandleStructures();
    if (built) { this.lastStructureTick = g.tick; this.placements++; }
  }
  // Where a nation keeps most of its buildings, it rings the place with defense posts no further apart
  // than a linked wall can reach, then - slowly, as the gold allows - joins neighbouring posts with walls
  // (30% cheaper that way, and a post makes the wall beside it harder to break). The side facing trouble
  // gets its posts first. Any two posts facing a hostile border within wall range also get joined.
  fortifyClusters() {
    const g = this.game, p = this.p;
    if (this.difficulty === Difficulty.EASY || g.tick < (this.fortifyAfter || 0) || g.unitDisabled('defense')) return false;
    this.fortifyAfter = g.tick + FORTIFY_INTERVAL[this.diffIndex] + this.rng.int(0, 60);
    const cl = this.mainCluster();
    if (!cl) return false;
    const link = this.cfg.wallLinkMaxLength();
    const posts = p.completedUnitsOf(UnitType.DEFENSE_POST);
    // ---- 1. posts on the ring, trouble side first ----
    const ringR = Math.max(16, Math.min(46, cl.radius + 12));
    const n = Math.max(4, Math.ceil((2 * Math.PI * ringR) / (link * 0.8)));
    const spots = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const x = Math.round(cl.x + Math.cos(a) * ringR), y = Math.round(cl.y + Math.sin(a) * ringR);
      if (!g.valid(x, y)) continue;
      const t = g.ref(x, y);
      if (g.owner[t] !== p.smallID || !g.isLand(t)) continue;
      spots.push({ t, a, danger: this.dangerNear(x, y) });
    }
    spots.sort((u, v) => v.danger - u.danger);
    const hasPost = (t) => posts.some((u) => g.dist(u.tile, t) <= 12) || p.units.some((u) => u.type === UnitType.DEFENSE_POST && g.dist(u.tile, t) <= 12);
    const postCost = this.cfg.unitCost(UnitType.DEFENSE_POST, p.unitsOf(UnitType.DEFENSE_POST).length, p);
    for (const s of spots) {
      if (hasPost(s.t)) continue;
      if (p.gold < postCost * 2) break;
      // nudge to a buildable tile nearby
      for (let k = 0; k < 6; k++) {
        const t = k === 0 ? s.t : g.ref(within(g.x(s.t) + this.rng.int(-3, 3), 0, g.width - 1), within(g.y(s.t) + this.rng.int(-3, 3), 0, g.height - 1));
        if (g.owner[t] === p.smallID && g.build(p, UnitType.DEFENSE_POST, t).ok) return true;
      }
    }
    // ---- 2. join two posts with a wall: ring neighbours first, then any pair on a hostile front ----
    if (g.unitDisabled('wall') || p.wallQueue.length > 1) return false;
    this.wallLinks ||= new Set();
    const key = (a, b) => (a.id < b.id ? a.id + '|' + b.id : b.id + '|' + a.id);
    const pairs = [];
    for (let i = 0; i < posts.length; i++) {
      for (let j = i + 1; j < posts.length; j++) {
        const a = posts[i], b = posts[j], d = g.dist(a.tile, b.tile);
        if (d > link - 2 || d < 6 || this.wallLinks.has(key(a, b))) continue;
        // "on the ring" is loose: the cluster's centre drifts as more gets built around it
        const near = (u) => Math.hypot(g.x(u.tile) - cl.x, g.y(u.tile) - cl.y) <= ringR + 25;
        const onRing = near(a) && near(b);
        const danger = this.dangerNear((g.x(a.tile) + g.x(b.tile)) / 2, (g.y(a.tile) + g.y(b.tile)) / 2);
        if (!onRing && danger < 1) continue;
        pairs.push({ a, b, score: danger + (onRing ? 1 : 0) - d / 100 });
      }
    }
    pairs.sort((u, v) => v.score - u.score);
    this.pendingWallCost = 0;
    // price the best few, then take the best value for money
    const routes = [];
    for (const pr of pairs.slice(0, 5)) {
      const route = this.postWallRoute(pr.a, pr.b, cl);
      if (!route) { this.wallLinks.add(key(pr.a, pr.b)); continue; }   // no way to join these two: stop trying
      routes.push({ ...pr, route, value: pr.score * 1e6 - route.quote.cost });
    }
    routes.sort((u, v) => v.value - u.value);
    for (const pr of routes) {
      const route = pr.route;
      const cost = route.quote.cost;
      // paid for out of the wall fund (a slice of everything we earn), or out of pocket if it is cheap
      if (p.gold >= cost && (this.wallFund >= cost || cost <= p.gold * 0.35)) {
        if (g.buildWall(p, route.pts).ok) {
          this.wallFund = Math.max(0, this.wallFund - cost);
          this.wallLinks.add(key(pr.a, pr.b)); this.lastWallTick = g.tick;
          return true;
        }
      } else if (!this.pendingWallCost) this.pendingWallCost = cost;   // saving up for this one
    }
    return false;
  }
  // A discounted wall between two posts: straight if it can be, otherwise bent outward (or inward) around
  // the cities in the way. Null if no route stays linked (within the 50 tiles).
  postWallRoute(a, b, cl) {
    const g = this.game, p = this.p;
    const straight = g.planWall(p, [a.tile, b.tile]);
    if (straight.ok && straight.linked) return { pts: [a.tile, b.tile], quote: straight };
    const mx = (g.x(a.tile) + g.x(b.tile)) / 2, my = (g.y(a.tile) + g.y(b.tile)) / 2;
    const ox = mx - cl.x, oy = my - cl.y, ol = Math.hypot(ox, oy) || 1;
    for (const push of [8, 14, -8]) {
      const x = Math.round(mx + (ox / ol) * push), y = Math.round(my + (oy / ol) * push);
      if (!g.valid(x, y)) continue;
      const mid = g.ref(x, y);
      if (g.owner[mid] !== p.smallID) continue;
      const q = g.planWall(p, [a.tile, mid, b.tile]);
      if (q.ok && q.linked) return { pts: [a.tile, mid, b.tile], quote: q };
    }
    return null;
  }
  // A share of every coin earned goes to the wall fund, so the expensive linked walls get built slowly
  // instead of never (the AI otherwise spends everything as it comes in).
  accrueWallFund() {
    const p = this.p;
    const earned = p.goldEarned - (this.lastEarned ?? p.goldEarned);
    this.lastEarned = p.goldEarned;
    if (earned > 0) this.wallFund = Math.min(30e6, (this.wallFund || 0) + earned * WALL_FUND_SHARE[this.diffIndex]);
  }
  // The densest group of our buildings: centre and radius (null if we have fewer than three).
  mainCluster() {
    const g = this.game, p = this.p;
    const b = p.units.filter((u) => u.constructionLeft === 0 && u.type !== UnitType.DEFENSE_POST && u.type !== UnitType.MINE && g.isLand(u.tile));
    if (b.length < 3) return null;
    let best = null;
    for (const c of b) {
      const cx = g.x(c.tile), cy = g.y(c.tile);
      const members = b.filter((d) => (g.x(d.tile) - cx) ** 2 + (g.y(d.tile) - cy) ** 2 <= 35 * 35);
      const value = members.reduce((a, d) => a + (d.level || 1) + (d.type === UnitType.CITY ? 1 : 0), 0);
      if (!best || value > best.value) best = { members, value };
    }
    if (!best || best.members.length < 3) return null;
    const x = best.members.reduce((a, d) => a + g.x(d.tile), 0) / best.members.length;
    const y = best.members.reduce((a, d) => a + g.y(d.tile), 0) / best.members.length;
    const radius = Math.max(...best.members.map((d) => Math.hypot(g.x(d.tile) - x, g.y(d.tile) - y)));
    return { x, y, radius };
  }
  // How much hostile ground (and the zombie horde) is near a point: 0 = quiet, higher = closer / more.
  dangerNear(x, y) {
    const g = this.game, p = this.p;
    let d = 0;
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * Math.PI * 2;
      for (const r of [15, 30, 50]) {
        const tx = Math.round(x + Math.cos(a) * r), ty = Math.round(y + Math.sin(a) * r);
        if (!g.valid(tx, ty)) continue;
        const o = g.ownerOf(g.ref(tx, ty));
        if (o && o !== p && g.hostile(p, o) && o.type !== PlayerType.BOT) { d += (o.isHorde ? 2 : 1) * (60 - r) / 45; break; }
      }
    }
    return d;
  }
  tryBuildDefensePost() {
    const g = this.game, p = this.p;
    if (this.difficulty === Difficulty.EASY) return false;
    if (this.difficulty === Difficulty.MEDIUM && !this.rng.chance(2)) return false;
    const land = p.incomingAttacks.filter((a) => a.sourceTile === null);
    if (!land.length || p.troops <= 0) return false;
    const incoming = land.reduce((s, a) => s + a.troops, 0);
    const ratio = incoming / p.troops;
    if (ratio < 0.4) return false;
    const postBias = p.researches.has('defensive_position') || p.researches.has('coastal_defense') ? 2 : 1;
    const allowed = (this.difficulty === Difficulty.MEDIUM ? 1 : Math.ceil(ratio / 0.4)) * postBias;
    if (p.unitsOf(UnitType.DEFENSE_POST).length >= allowed) return false;
    if (p.gold < this.cfg.unitCost(UnitType.DEFENSE_POST, p.unitsOf(UnitType.DEFENSE_POST).length, p)) return false;
    const attackerSm = land[0].attacker.smallID;
    const front = [];
    const b = [0, 0, 0, 0];
    for (const t of p.border) { const n = g.neighbors4(t, b); for (let k = 0; k < n; k++) if (g.owner[b[k]] === attackerSm) { front.push(t); break; } if (front.length > 200) break; }
    if (!front.length) return false;
    for (let i = 0; i < 10; i++) {
      let spot = this.rng.pick(front);
      for (let s = 0; s < 4; s++) { const n = g.neighbors4(spot, b); let moved = false; for (let k = 0; k < n; k++) if (g.owner[b[k]] === p.smallID && !p.border.has(b[k])) { spot = b[k]; moved = true; break; } if (!moved) break; }
      if (g.build(p, UnitType.DEFENSE_POST, spot).ok) { if (p.researches.has('defensive_position')) g.reinforcePost(p, spot); return true; }
    }
    return false;
  }
  randomInnerTile(tries = 20, requireShore = false) {
    const g = this.game, p = this.p;
    if (!p.tiles.size) return null;
    let fallback = null;
    for (let i = 0; i < tries; i++) {
      const t = g.randomTileOf(p.tiles, this.rng);
      if (requireShore) { if (g.isOceanShore(t)) return t; continue; }
      if (!p.border.has(t) && !g.wallHp[t]) {
        fallback = fallback ?? t;
        const b = [0, 0, 0, 0];
        const n = g.neighbors4(t, b);
        let inner = true;
        for (let k = 0; k < n; k++) if (p.border.has(b[k]) || g.owner[b[k]] !== p.smallID) inner = false;
        if (inner) return t;
      }
    }
    return fallback;
  }
  tileNearFactory(factory) {
    const g = this.game, p = this.p;
    for (let i = 0; i < 30; i++) {
      const t = g.randomTileOf(p.tiles, this.rng);
      if (t === null) return null;
      const d = g.dist(t, factory.tile);
      if (d >= 20 && d <= 100 && !p.border.has(t) && !g.hasPopulationNear(t, this.cfg.labMinGapFromPopulation())) return t;
    }
    return null;
  }
  doHandleStructures() {
    const g = this.game, p = this.p;
    // the wall fund has earned a linked wall: stop spending until the gold is actually there
    if (this.pendingWallCost && (this.wallFund || 0) >= this.pendingWallCost && p.gold < this.pendingWallCost) return false;
    const cities = p.unitsOf(UnitType.CITY).length;
    const ports = p.unitsOf(UnitType.PORT).length;
    const factories = p.unitsOf(UnitType.FACTORY);
    const silos = p.unitsOf(UnitType.SILO).length;
    const sams = p.unitsOf(UnitType.SAM).length;
    const coastal = this.shoreTiles(p, 1, true).length > 0;
    const troopRatio = p.troops / this.cfg.maxTroops(p);
    const enemiesHaveSilos = g.units.some((u) => u.type === UnitType.SILO && u.owner !== p && !p.isFriendly(u.owner));
    const reserve = silos > 0 ? this.cfg.nukeCost(NukeType.ATOM, p) * 1.3 : 0;
    const easy = this.difficulty === Difficulty.EASY;

    if (!g.settings.disableNukes && enemiesHaveSilos && sams < 1 + Math.floor(cities / 4) && p.gold >= this.cfg.unitCost(UnitType.SAM, sams, p) && !easy) {
      const t = this.randomInnerTile();
      if (t !== null && g.build(p, UnitType.SAM, t).ok) return true;
    }
    if (coastal && ports < Math.max(1, Math.floor(cities * 0.75)) && p.gold >= this.cfg.unitCost(UnitType.PORT, g.costIndex(p, UnitType.PORT), p)) {
      const t = this.randomInnerTile(30, true);
      if (t !== null && g.build(p, UnitType.PORT, t).ok) return true;
    }
    // Factory: rail economy, and the only way to get mechs. First one after 2 cities; more when research wants them.
    const wantF = Math.min(4, Math.max(this.wantFactories, cities >= 4 ? 2 : 1, this.wantMechs ? 2 : 1));
    if (!easy && cities >= 2 && factories.length < wantF && p.gold >= this.cfg.unitCost(UnitType.FACTORY, g.costIndex(p, UnitType.FACTORY), p) + reserve) {
      const t = this.randomInnerTile(30);
      if (t !== null && g.build(p, UnitType.FACTORY, t).ok) return true;
    }
    // Upgrade a factory to level 2 so mechs are available (Hard+ always, Medium sometimes, or when research says mechs)
    const lvl1 = factories.find((f) => f.level === 1 && f.constructionLeft === 0);
    if (lvl1 && (this.hardOrWorse || this.wantMechs || this.rng.chance(3)) && cities >= 3 && p.gold >= this.cfg.unitCost(UnitType.FACTORY, p.unitLevels(UnitType.FACTORY), p) + reserve) {
      if (g.build(p, UnitType.FACTORY, lvl1.tile).ok) return true;
    }
    // Push the factory that builds our mechs (and the port that builds our ships) up a level once we
    // actually field those units: better new units, and the idle ones come home to refit.
    if (!easy && this.posture !== 'turtle') {
      const liveMechs = p.mechs.filter((m) => !m.done).length, liveShips = p.warships.filter((w) => !w.done).length + p.subs.filter((sb) => !sb.done).length;
      const mf = factories.filter((f) => f.constructionLeft === 0 && f.level >= 2 && f.level < this.cfg.maxUnitLevel(p, UnitType.FACTORY)).sort((a, b) => b.level - a.level)[0];
      if (mf && liveMechs >= 1 && p.gold >= this.cfg.unitCost(UnitType.FACTORY, p.unitLevels(UnitType.FACTORY), p) * 1.2 + reserve) {
        if (g.build(p, UnitType.FACTORY, mf.tile).ok) return true;
      }
      const pt = p.completedUnitsOf(UnitType.PORT).filter((u) => u.level < this.cfg.maxUnitLevel(p, UnitType.PORT)).sort((a, b) => b.level - a.level)[0];
      if (pt && liveShips >= 2 && p.gold >= this.cfg.unitCost(UnitType.PORT, p.unitLevels(UnitType.PORT), p) * 1.2 + reserve) {
        if (g.build(p, UnitType.PORT, pt.tile).ok) return true;
      }
    }
    // Research Lab: near a factory (rail range), away from cities, once we have 3 cities.
    const labs = p.unitsOf(UnitType.LAB).length;
    if (!easy && labs < 1 && g.populationCount(p) >= this.cfg.populationRequiredForLab() && p.researchCount() < this.cfg.maxResearchesPerPlayer()) {
      const fac = factories.find((f) => f.constructionLeft === 0);
      if (fac) {
        const cost = this.cfg.unitCost(UnitType.LAB, labs, p);
        if (p.gold >= cost + reserve) {
          // Losing a lab loses the research, so it goes as deep inside as rail range allows.
          const deep = this.deepTileNear(g.x(fac.tile), g.y(fac.tile), 70, (tt) => g.hasPopulationNear(tt, this.cfg.labMinGapFromPopulation()));
          if (deep !== null && g.build(p, UnitType.LAB, deep).ok) return true;
          for (let i = 0; i < 12; i++) { const t = this.tileNearFactory(fac); if (t !== null && g.build(p, UnitType.LAB, t).ok) return true; }
        }
        else if (cities >= 4) return false; // save up
      }
    }
    // Save-up phase for a missile silo once we have a few cities.
    if (!g.settings.disableNukes && !easy && silos < 1 && cities >= 3) {
      if (p.gold >= this.cfg.unitCost(UnitType.SILO, silos, p)) { const t = this.randomInnerTile(); if (t !== null && g.build(p, UnitType.SILO, t).ok) return true; }
      else if (labs >= 1 || cities >= 5) return false;
    }
    // Mines around our ports when we researched them
    if (this.wantMines && coastal && p.unitsOf(UnitType.MINE).length < 6 && p.gold >= this.cfg.unitCost(UnitType.MINE, 0, p) + reserve) {
      const port = p.completedUnitsOf(UnitType.PORT)[0];
      if (port) for (let i = 0; i < 10; i++) {
        const x = g.x(port.tile) + this.rng.int(-30, 30), y = g.y(port.tile) + this.rng.int(-30, 30);
        if (!g.valid(x, y)) continue;
        const t = g.ref(x, y);
        if (g.isOcean(t) && g.build(p, UnitType.MINE, t).ok) return true;
      }
    }
    // Artillery Battery: the answer to enemy mechs sitting on our border, and to a grinding front.
    // Built reactively - we only pay for one once something is actually pressing on us.
    const guns = p.unitsOf(UnitType.ARTILLERY).length;
    const mechThreat = g.mechs.some((m) => !m.done && g.hostile(p, m.owner) && this.nearOurLand(m.x, m.y, 60));
    const pressed = p.incomingAttacks.filter((a) => !a.done).length >= 2;
    if (!easy && (mechThreat || pressed) && guns < Math.min(4, 1 + Math.floor(cities / 3))) {
      const cost = this.cfg.unitCost(UnitType.ARTILLERY, guns, p);
      if (p.gold >= cost + reserve) {
        const t = this.tileNearThreat() ?? this.randomInnerTile();
        if (t !== null && g.build(p, UnitType.ARTILLERY, t).ok) return true;
      }
    }
    if (!easy && this.wordDrivenBuilds(reserve)) return true;
    // Airport: a late, enormous purchase, and the answer to a SAM wall. If the rivals we care about sit
    // behind SAMs (or their SAMs have already shot our missiles down), stop spending on small things and
    // save for one; then it goes deep inside our land, and maybeAirlift aims the drops at their launchers.
    if (!easy && !p.unitsOf(UnitType.AIRPORT).length && !g.unitDisabled('airport')) {
      const stoppedUs = [...this.samWall.values()].reduce((a, b) => a + b, 0);
      const turtled = g.players.some((o) => o !== p && o.alive && g.hostile(p, o) && o.numTiles > 300
        && (o.unitsOf(UnitType.SAM).length >= 2 || o.warships.filter((w) => !w.done).length >= 3));
      const want = this.wantAirships || stoppedUs >= 2 || (turtled && this.threat.sams >= 2.5 && this.hardOrWorse);
      if (want && this.posture !== 'turtle') {
        const cost = this.cfg.unitCost(UnitType.AIRPORT, 0, p);
        if (p.gold >= cost + reserve) {
          const c = g.centroid(p);
          const t = (c && this.deepTileNear(c.x, c.y, 40, (tt) => !!g.samAirportConflict(p, UnitType.AIRPORT, tt))) ?? this.randomInnerTile(25);
          if (t !== null && g.build(p, UnitType.AIRPORT, t).ok) return true;
        } else if (p.gold >= cost * 0.35) return false;   // saving up: skip the small stuff this turn
      }
    }
    // Repair Yard: only worth it once we have mechs or walls to keep alive.
    if (p.researches.has('field_engineering')) {
      const yards = p.unitsOf(UnitType.REPAIR).length;
      const worth = p.mechs.filter((m) => !m.done).length > 0 || p.numWallTiles > 40;
      if (worth && yards < 2 && p.gold >= this.cfg.unitCost(UnitType.REPAIR, yards, p) + reserve) {
        const t = this.tileNearThreat() ?? this.randomInnerTile(20);
        if (t !== null && g.build(p, UnitType.REPAIR, t).ok) return true;
      }
    }
    const mechReserve = this.wantMechs || (this.hardOrWorse && cities >= 4) ? this.cfg.unitCost(UnitType.MECH, p.mechs.length, p) * 0.5 : 0;
    if ((troopRatio > 0.6 || cities === 0) && p.gold >= this.cfg.unitCost(UnitType.CITY, cities, p) + reserve + mechReserve) {
      const t = this.randomInnerTile();
      if (t !== null && g.build(p, UnitType.CITY, t).ok) return true;
    }
    return false;
  }

  // ---- research choice ------------------------------------------------------------
  pickResearch(choices) {
    const p = this.p, g = this.game;
    if (this.difficulty === Difficulty.EASY) return choices[this.rng.int(0, choices.length - 1)];
    this.observe();   // pick with fresh eyes
    const T = this.threat;
    const coastal = this.shoreTiles(p, 1, true).length > 0;
    const hasFactory2 = g.mechFactories(p).length > 0;
    const silos = p.unitsOf(UnitType.SILO).length;
    const hasAirport = p.unitsOf(UnitType.AIRPORT).length > 0;
    const cities = p.unitsOf(UnitType.CITY).length;
    // nations we can only reach across water are what amphibious and airborne doctrines are for
    // rivals we can only reach over water; capped, because on a world map that is nearly everyone
    const overseas = Math.min(3, g.players.filter((o) => o !== p && o.alive && g.hostile(p, o) && o.type !== PlayerType.BOT && !g.neighborsOf(p).players.includes(o)).length);
    const samsStoppedUs = [...this.samWall.values()].reduce((a, b) => a + b, 0);
    const score = (id) => {
      const r = RESEARCH_BY_ID[id];
      if (!r) return -99;
      let s = 5;
      for (const tag of r.tags) {
        if (tag === 'mech') s += hasFactory2 || p.mechs.length ? 6 : (this.hardOrWorse ? 2 : -4);
        if (tag === 'defense') s += this.posture === 'turtle' ? 7 : 1;
        if (tag === 'aggro') s += this.posture === 'war' ? 5 : this.hardOrWorse ? 2 : 0;
        if (tag === 'econ') s += this.posture === 'build' ? 7 : p.gold < 500000 ? 4 : 1;
        if (tag === 'navy') s += coastal ? (T.navy > 1 ? 5 : 2) : -14;
        if (tag === 'nuke') s += silos ? 4 : -4;
      }
      // what the rivals actually have decides the rest
      switch (id) {
        case 'cluster_munitions': s += (T.sams * 4 + samsStoppedUs * 5) * (silos ? 1 : 0.3); break;
        case 'decoy_warheads': s += (T.sams * 2.5 + samsStoppedUs * 3) * (silos ? 1 : 0.3); break;
        case 'hypersonic_missiles': s += (T.sams * 2 + samsStoppedUs * 2) * (silos ? 1 : 0.3); break;
        case 'sead_doctrine': s += T.sams * 3.5 * (hasAirport ? 1.5 : 0.6) + samsStoppedUs * 2; break;
        case 'field_engineering': s += T.mechs * 5 + (p.mechs.length ? 3 : 0) + (p.numWallTiles > 40 ? 3 : 0); break;
        case 'interceptor_screen': s += T.air * 5; break;
        // mainly an answer to airships; the -80% damage makes it a poor raider on its own
        case 'airborne_mechs': s += T.air * 4 * (hasFactory2 ? 1 : 0.3) + (T.air > 0.5 ? overseas * 0.5 : -4); break;
        case 'amphibious_mech': s += (T.navy * 2.5 + overseas * 2) * (coastal && hasFactory2 ? 1 : 0.2); break;
        case 'coastal_defense': s += T.navy * 3 * (coastal ? 1 : 0); break;
        case 'hardened_infra': s += T.silos * 3; break;
        case 'nuclear_deterrence': s += T.silos * 2.5 * (silos ? 1 : 0.2); break;
        case 'fighter_networks': s += T.bombers * 5 - (T.bombers ? 0 : 6); break;
        case 'strategic_airlift': case 'airbase_network': case 'airborne_doctrine': s += hasAirport ? 6 + T.sams : -6; break;
        case 'megacity': s += cities >= 5 ? 5 : -3; break;
        case 'heavy_industry': s += p.unitsOf(UnitType.FACTORY).length >= 2 ? 5 : -3; break;
        case 'nuclear_subs': s += p.researches.has('submarine_warfare') ? 4 : -30; break;
        default: break;
      }
      // What our memory says we are up against: every remembered nation votes for the doctrines that
      // answer its words, weighted by how much that nation matters to us.
      if (r.answers) {
        let votes = 0;
        for (const [o] of this.remembered()) {
          if (p.isFriendly(o)) continue;
          const sm = o.smallID;
          const weight = this.believes(sm, 'danger') ? 2 : this.believes(sm, 'neighbor') ? 1.4 : this.believes(sm, 'same_continent') ? 1 : 0.5;
          votes += weight * this.wordSum(sm, r.answers);
        }
        s += Math.min(14, votes * 1.2);
      }
      const noise = this.difficulty === Difficulty.MEDIUM ? 6 : 2;
      return s + this.rng.int(0, noise);
    };
    return choices.slice().sort((a, b) => score(b) - score(a))[0];
  }


  // ---- walls: choke-point analysis --------------------------------------------------
  // Approximate min-cut: BFS inward from the front facing the attacker through our own land. Every BFS layer
  // is a cut separating the front from the interior; the narrowest layer within a short depth is the choke.
  // Build there if it's much narrower than the front (cost vs benefit), and we can afford it.
  maybeBuildWall() {
    const g = this.game, p = this.p;
    if (this.difficulty === Difficulty.EASY) return false;
    if (g.tick - this.lastWallTick < 150) return false;
    const land = p.incomingAttacks.filter((a) => a.sourceTile === null && !a.done);
    let attacker = null;
    if (land.length) {
      const incoming = land.reduce((s, a) => s + a.troops, 0);
      if (incoming >= p.troops * 0.2 || this.hardOrWorse) attacker = land[0].attacker;
    }
    if (!attacker && this.hardOrWorse && this.rng.chance(3)) {
      // proactive: fortify against the strongest hostile neighbour
      const nb = g.neighborsOf(p).players.filter((o) => g.hostile(p, o) && o.type !== PlayerType.BOT).sort((a, b) => b.troops - a.troops);
      if (nb.length && nb[0].troops > p.troops * 0.8) attacker = nb[0];
    }
    if (!attacker) return false;
    if (p.wallQueue.length > 2) return false;
    if (p.numWallTiles > 200 + (this.hardOrWorse ? 250 : 0)) return false;
    const plan = this.findChokeWall(attacker);
    if (!plan) return false;
    const quote = g.planWall(p, plan.waypoints);
    if (!quote.ok) return false;
    // benefit: how much narrower the cut is than the front, and how threatened we are
    const threat = Math.min(3, attacker.troops / Math.max(1, p.troops));
    const value = (plan.frontLen / Math.max(1, plan.cutLen)) * threat;
    if (value < 1.2) return false;
    if (quote.cost > p.gold * (this.hardOrWorse ? 0.6 : 0.4)) return false;
    const r = g.buildWall(p, plan.waypoints);
    if (r.ok) { this.lastWallTick = g.tick; return true; }
    return false;
  }
  findChokeWall(attacker) {
    const g = this.game, p = this.p;
    const b = [0, 0, 0, 0];
    // front = our border tiles touching the attacker
    const front = [];
    for (const t of p.border) { const n = g.neighbors4(t, b); for (let k = 0; k < n; k++) if (g.owner[b[k]] === attacker.smallID) { front.push(t); break; } if (front.length > 600) break; }
    if (front.length < 6) return null;
    // BFS layers inward through our land (walls/structures block)
    const depthOf = new Map();
    let frontier = front.slice();
    for (const t of frontier) depthOf.set(t, 0);
    const layers = [frontier];
    const MAXD = 22;
    for (let d = 1; d <= MAXD && frontier.length; d++) {
      const next = [];
      for (const t of frontier) {
        const n = g.neighbors4(t, b);
        for (let k = 0; k < n; k++) {
          const nb = b[k];
          if (depthOf.has(nb)) continue;
          if (g.owner[nb] !== p.smallID || !g.isLand(nb)) continue;
          depthOf.set(nb, d);
          next.push(nb);
        }
      }
      layers.push(next);
      frontier = next;
    }
    // pick the narrowest layer at depth >= 3 (so the wall isn't on the very front line); it must still exist
    let best = -1, bestLen = Infinity;
    for (let d = 3; d < layers.length; d++) {
      const L = layers[d];
      if (!L.length) break;
      // a layer is a valid cut only if the layer beyond it is non-empty (there is an interior to protect)
      if (!layers[d + 1] || !layers[d + 1].length) break;
      const clean = L.filter((t) => !g.unitByTile.has(t) && !g.hasPopulationNear(t, this.cfg.structureMinGap()));
      if (clean.length < L.length * 0.8) continue;
      if (L.length < bestLen) { bestLen = L.length; best = d; }
    }
    if (best < 0) return null;
    const cut = layers[best];
    if (cut.length > 90) return null;
    // order the cut tiles into a polyline: greedy nearest-neighbour chain from one end
    const remaining = new Set(cut);
    // start from an extreme point (max distance from centroid)
    let cx = 0, cy = 0; for (const t of cut) { cx += g.x(t); cy += g.y(t); } cx /= cut.length; cy /= cut.length;
    let start = cut[0], bd = -1;
    for (const t of cut) { const d = (g.x(t) - cx) ** 2 + (g.y(t) - cy) ** 2; if (d > bd) { bd = d; start = t; } }
    const chain = [start]; remaining.delete(start);
    let cur = start;
    while (remaining.size) {
      let nx = -1, nd = Infinity;
      for (const t of remaining) { const d = (g.x(t) - g.x(cur)) ** 2 + (g.y(t) - g.y(cur)) ** 2; if (d < nd) { nd = d; nx = t; } }
      if (nd > 36) break; // disjoint piece: stop (walls need to be a line)
      chain.push(nx); remaining.delete(nx); cur = nx;
    }
    if (chain.length < 4) return null;
    // thin the chain to waypoints every ~3 tiles (walls are 3 thick; the spine fills gaps)
    const waypoints = chain.filter((_, i) => i % 3 === 0 || i === chain.length - 1);
    return { waypoints, frontLen: front.length, cutLen: cut.length, depth: best };
  }

  // ---- navy --------------------------------------------------------------------------
  handleNavy() {
    const g = this.game, p = this.p;
    if (this.difficulty === Difficulty.EASY || g.unitDisabled('warship')) return;
    const ports = p.completedUnitsOf(UnitType.PORT);
    if (!ports.length) return;
    const reserve = p.unitsOf(UnitType.SILO).length ? this.cfg.nukeCost(NukeType.ATOM, p) : 0;
    const enemyShipsNear = g.warships.some((w) => !w.done && g.hostile(p, w.owner) && ports.some((u) => g.distXY(g.x(u.tile), g.y(u.tile), w.x, w.y) < 150));
    const wantW = Math.min(this.cfg.warshipCap(p), (this.hardOrWorse ? 1 : 0) + this.wantWarships + (enemyShipsNear ? 2 : 0) + (p.boats.length ? 1 : 0) + (this.raftsSeen ? 2 : 0));
    const live = p.warships.filter((w) => !w.done).length;
    if (live < wantW && p.gold >= this.cfg.unitCost(UnitType.WARSHIP, p.warships.length, p) + reserve) {
      const pt = this.navalPatrolPoint(ports);
      if (pt >= 0 && g.buildWarship(p, pt).ok) return;
    }
    // retarget warships toward the current enemy's coast when bombardment is researched
    if (p.researches.has('coastal_bombardment') && this.currentEnemy && this.currentEnemy.alive && this.rng.chance(2)) {
      const shore = this.shoreTiles(this.currentEnemy, 40, true);
      if (shore.length) {
        for (const w of p.warships) {
          if (w.done || this.rng.chance(2)) continue;
          const st = this.rng.pick(shore);
          const wn = g.waterNeighborsOf(st);
          if (wn.length) g.moveShip(p, w.id, wn[0]);
        }
      }
    }
    if (this.wantSubs && p.subs.filter((s) => !s.done).length < 2 && p.gold >= this.cfg.unitCost(UnitType.SUBMARINE, p.subs.length, p) + reserve) {
      // subs lurk off an enemy coast if we have one, else near home
      let pt = -1;
      if (this.currentEnemy && this.currentEnemy.alive) { const shore = this.shoreTiles(this.currentEnemy, 30, true); if (shore.length) { const wn = g.waterNeighborsOf(this.rng.pick(shore)); if (wn.length) pt = wn[0]; } }
      if (pt < 0) pt = this.navalPatrolPoint(ports);
      if (pt >= 0) g.buildSub(p, pt);
    }
  }
  navalPatrolPoint(ports) {
    const g = this.game;
    const port = this.rng.pick(ports);
    for (let i = 0; i < 20; i++) {
      const x = g.x(port.tile) + this.rng.int(-40, 40), y = g.y(port.tile) + this.rng.int(-40, 40);
      if (g.valid(x, y) && g.isOcean(g.ref(x, y))) return g.ref(x, y);
    }
    const wn = g.waterNeighborsOf(port.tile);
    return wn.length ? wn[0] : -1;
  }

  // ---- mechs ---------------------------------------------------------------------------
  // Mechs are the most expensive thing a nation can field, so they get a plan rather than a shove in
  // the enemy's direction. The doctrines a nation has researched change that plan:
  //   Amphibious Mech  -> mechs stop caring about coastlines, so overseas nations become raid targets
  //   Heavy / Assault  -> tanky enough to live inside enemy land, so push instead of hold
  //   Long-Range       -> outranges defences, so parking on a border is worth more
  // Without those, a mech is used the way a careful player uses one: hold the line, screen the front,
  // and only commit when the war is already going our way.
  handleMechs() {
    const g = this.game, p = this.p;
    if (this.difficulty === Difficulty.EASY) return;
    const facs = g.mechFactories(p);
    const live = p.mechs.filter((m) => !m.done);
    const cap = this.cfg.mechCap(p);
    const amphibious = R.mechAmphibious(p);
    const tanky = p.researches.has('heavy_mech') || p.researches.has('assault_mech');
    const want = Math.min(cap, (this.difficulty === Difficulty.MEDIUM ? 1 : this.difficulty === Difficulty.HARD ? 2 : 3) + this.wantMechs);

    // ---- who are we pointing them at ----
    let enemy = this.currentEnemy && this.currentEnemy.alive && g.hostile(p, this.currentEnemy) ? this.currentEnemy : null;
    if (!enemy) {
      const nb = g.neighborsOf(p).players.filter((o) => g.hostile(p, o) && o.type !== PlayerType.BOT).sort((a, b) => b.troops - a.troops);
      enemy = nb[0] || null;
    }
    // Prefer a neighbour our memory marks as prey, and keep mechs away from artillery nests.
    {
      const cw = CHOICE_WORDS.mechTarget;
      let bestPrey = null, bestScore = 1;
      for (const [o] of this.remembered()) {
        if (!g.hostile(p, o) || !this.believes(o.smallID, 'neighbor')) continue;
        const score = this.wordSum(o.smallID, cw.want) - this.wordSum(o.smallID, cw.avoid);
        if (score > bestScore) { bestScore = score; bestPrey = o; }
      }
      if (bestPrey) enemy = bestPrey;
      else if (enemy && this.wordSum(enemy.smallID, cw.avoid) >= 2) enemy = null;   // walking into guns
    }
    const inc = p.incomingAttacks.filter((a) => !a.done);
    const incoming = inc.reduce((sum, a) => sum + a.troops, 0);
    const pressed = incoming > p.troops * 0.25;
    if (pressed && inc.length) enemy = inc.sort((a, b) => b.troops - a.troops)[0].attacker;
    // Amphibious mechs open up nations we could never walk to. That is the whole point of the doctrine,
    // and it was being ignored: pick an overseas victim and raid it.
    let raidTarget = null;
    if (R.mechCrossesWater(p) && !pressed) {
      const next = g.neighborsOf(p).players;
      const overseas = g.players.filter((o) => o !== p && o.alive && g.hostile(p, o) && o.numTiles > 40
        && !next.includes(o) && o.troops < p.troops * 1.5);
      // weakest first, then whoever has hurt us
      overseas.sort((a, b) => (a.troops - (this.grudge.get(a.smallID) || 0) * 1e4) - (b.troops - (this.grudge.get(b.smallID) || 0) * 1e4));
      raidTarget = overseas[0] || null;
    }

    // ---- build: only when a mech would earn its price ----
    // guard duty (we are being hit hard, or someone next door fields mechs), a spearhead for a war or a
    // rush we are committed to, or a doctrine built around them. Otherwise the gold is better elsewhere.
    const beenHit = [...this.grudge.values()].some((v) => v > 30);
    const useful = pressed || beenHit || this.posture === 'war' || !!this.rush || p.warsDeclared.size > 0 || this.wantMechs > 0 || this.threat.mechs > 0.5;
    if (facs.length && live.length < want && useful) {
      const reserve = p.unitsOf(UnitType.SILO).length ? this.cfg.nukeCost(NukeType.ATOM, p) : 0;
      const cost = this.cfg.unitCost(UnitType.MECH, p.mechs.length, p);
      if (p.gold >= cost + reserve * 0.5) {
        // Build it somewhere safe of ours near the action, not on top of the enemy where it arrives
        // alone and dies. It walks to the front under its own orders.
        const dst = this.tileNearThreat() ?? this.randomInnerTile(15) ?? this.randomInnerTile();
        if (dst !== null && dst >= 0) g.buildMech(p, dst);
      }
    }
    if (!live.length || !this.rng.chance(2)) return;

    // ---- orders ----
    // Roles are handed out in priority order, one mech at a time, so even a nation with a single mech
    // uses it for the most important job instead of leaving it to wander its own border:
    //   1. hold the line when we are being pushed
    //   2. air defence (Airborne Mechs) where enemy airships would land
    //   3. sink the enemy navy off our coast (Amphibious Mechs)
    //   4. cross the water and raid an overseas nation (Amphibious / Airborne)
    //   5. assault whoever we are fighting on land
    //   6. otherwise walk the border
    const T = this.threat;
    const crossesWater = R.mechCrossesWater(p);
    const pool = [...live].filter((m) => !m.engaged && !m.refit).sort((a, b) => b.hp / b.maxHp - a.hp / a.maxHp);
    const give = (m, mode, target = 0, tile = -1) => {
      if (tile >= 0) { g.moveMech(p, m.id, tile); return; }       // moveMech also sets 'hold'
      if (m.mode !== mode || m.orderTarget !== target) g.setMechMode(p, m.id, mode, target);
    };
    const take = (pred = () => true) => { const i = pool.findIndex(pred); return i < 0 ? null : pool.splice(i, 1)[0]; };
    const healthy = (m) => m.hp > m.maxHp * 0.45;
    // 1. defence
    if (pressed) {
      const want = Math.max(1, Math.ceil(live.length / 2));
      for (let k = 0; k < want; k++) { const m = take(); if (m) give(m, 'defend'); }
    }
    // 2. airborne mechs guard the heart of the country against airdrops
    if (R.mechAntiAir(p) && T.air > 0.5) {
      const cities = p.unitsOf(UnitType.CITY);
      if (cities.length) {
        const cx = cities.reduce((a, u) => a + g.x(u.tile), 0) / cities.length, cy = cities.reduce((a, u) => a + g.y(u.tile), 0) / cities.length;
        const spot = g.ref(Math.round(cx), Math.round(cy));
        const m = take((mm) => g.dist(mm.patrol, spot) > 10);
        if (m) give(m, 'hold', 0, g.isLand(spot) ? spot : cities[0].tile);
      }
    }
    // 3. amphibious mechs go after enemy warships near our coast: this is what the doctrine is for
    if (R.mechAmphibious(p)) {
      let hunt = null;
      for (const t of this.shoreTiles(p, 40, true)) {
        hunt = g.nearestEnemyShip(p, g.x(t), g.y(t), 55, false, true);
        if (hunt) break;
      }
      if (hunt) { const m = take(healthy); if (m) give(m, 'hold', 0, g.tileAt(hunt.x, hunt.y)); }
    }
    // 4. raid across the water
    if (raidTarget && crossesWater) {
      const raiders = Math.max(1, Math.floor(pool.length / 2));
      for (let k = 0; k < raiders; k++) { const m = take(healthy); if (m) give(m, 'assault', raidTarget.smallID); }
    }
    // 5. lead the rush / the war we declared: the mech is the spearhead our attacks aim through
    const rushTarget = this.rush ? g.playersBySmall[this.rush.target] : null;
    if (rushTarget && rushTarget.alive && g.hostile(p, rushTarget)) {
      for (let k = pool.length - 1; k >= 0; k--) { if (healthy(pool[k])) { give(pool[k], 'assault', rushTarget.smallID); pool.splice(k, 1); } }
    }
    // 6. otherwise guard: sit behind the most threatened stretch and answer whatever comes
    for (const m of pool) {
      if (!healthy(m)) { give(m, 'defend'); continue; }
      const warTarget = enemy && g.hostile(p, enemy) && (p.warsDeclared.has(enemy.smallID) || this.posture === 'war');
      if (warTarget && (tanky || this.hardOrWorse || p.troops > enemy.troops)) give(m, 'assault', enemy.smallID);
      else if (raidTarget && crossesWater) give(m, 'assault', raidTarget.smallID);
      else if (m.mode !== 'defend') { const post = this.tileNearThreat(); if (post !== null && post >= 0) give(m, 'defend', 0, post); else give(m, 'defend'); }
    }
  }
  // ---- zombie mode ----
  // While the dead walk: push into zombie land when we have the troops (samples for the cure and
  // salvage gold - and a hive near us is the best target of all), help allies who are being overrun,
  // and keep the lab on the cure. The walls and posts come from fortifyClusters, which weighs the horde
  // double when it decides which side of a city needs them.
  zombieMoves() {
    const g = this.game, p = this.p, h = g.horde;
    if (!h || !h.alive || g.zombie.phase !== 'outbreak') return false;
    const max = this.cfg.maxTroops(p);
    // allies being overrun get troops if we can spare them
    if (p.troops > max * 0.5 && this.rng.chance(3)) {
      for (const o of g.players) {
        if (o === p || !o.alive || !p.isFriendly(o) || o.type === PlayerType.BOT) continue;
        const dead = o.incomingAttacks.filter((a) => !a.done && a.attacker === h).reduce((s, a) => s + a.troops, 0);
        if (dead > o.troops * 1.2) { g.donate(p, o, Math.floor(p.troops * 0.12), 0); return true; }
      }
    }
    const nb = g.neighborsOf(p).players;
    if (!nb.includes(h)) return false;
    const underSiege = p.incomingAttacks.some((a) => !a.done && a.attacker === h && a.troops > p.troops * 0.3);
    const ready = p.troops > max * (underSiege ? 0.3 : ZOMBIE_PUSH_AT[this.diffIndex]);
    if (!ready || g.tick < (this.zPushAfter || 0)) return false;
    this.zPushAfter = g.tick + 60;
    // aim at the nearest hive if one is close, otherwise at the thick of the horde next door
    let focus = -1, fd = Infinity;
    const c = g.centroid(p);
    for (const hv of g.zombie.hives) if (hv.alive && c) { const d = Math.hypot(g.x(hv.tile) - c.x, g.y(hv.tile) - c.y); if (d < fd) { fd = d; focus = hv.tile; } }
    if (fd > 180) focus = -1;
    const troops = Math.floor(p.troops * (underSiege ? 0.25 : 0.35));
    return g.sendAttack(p, h, troops, null, focus >= 0 ? focus : this.chooseFocus(h)) !== null;
  }
  zombieNuke() {
    const g = this.game, p = this.p;
    if (g.tick < (this.nukeAfter || 0) || !g.zombie || g.zombie.phase !== 'outbreak') return false;
    const hives = g.zombie.hives.filter((hv) => hv.alive);
    if (!hives.length) return false;
    const c = g.centroid(p);
    if (!c) return false;
    hives.sort((a, b) => Math.hypot(g.x(a.tile) - c.x, g.y(a.tile) - c.y) - Math.hypot(g.x(b.tile) - c.x, g.y(b.tile) - c.y));
    const type = p.gold >= this.cfg.nukeCost(NukeType.HYDROGEN, p) * 1.5 ? NukeType.HYDROGEN : NukeType.ATOM;
    if (g.launchNuke(p, type, hives[0].tile).ok) { this.nukeAfter = g.tick + NUKE_CADENCE[this.diffIndex]; return true; }
    return false;
  }
  // ---- research sharing ----
  // Lending an ally one of our doctrines is how a nation says "we are friends": economy and defence
  // doctrines go to anyone we like; war doctrines only to allies weaker than us. We ask allies for
  // doctrines that answer what we are up against, and take a loan back from an ally we are turning on or
  // who has grown into a danger. Taking one back costs nothing, so we do it without ceremony.
  manageSharing() {
    const g = this.game, p = this.p;
    if (this.difficulty === Difficulty.EASY || g.tick < (this.shareAfter || 0)) return;
    this.shareAfter = g.tick + 300 + this.rng.int(0, 200);
    const allies = g.players.filter((o) => o !== p && o.alive && p.isFriendly(o) && o.type !== PlayerType.BOT);
    if (!allies.length) return;
    for (const o of allies) {
      const id = g.lentTo(p, o);
      if (!id) continue;
      const turning = (this.rush && this.rush.target === o.smallID) || p.relation(o) < -20;
      const risky = this.isWarDoctrine(id) && o.troops > p.troops * 1.5;
      if (turning || risky) g.endLoan(p, o, 'revoked');
    }
    // lend one ally something (the friendlier, the likelier)
    const order = allies.filter((o) => !g.lentTo(p, o)).sort((a, b) => p.relation(b) - p.relation(a));
    for (const o of order) {
      if (p.relation(o) < 0 || (p.relation(o) < 20 && !this.rng.chance(2))) continue;
      const id = this.bestLoanFor(o);
      if (id && g.lendDoctrine(p, o, id).ok) break;
    }
    // ask for what we need
    for (const id of this.wantedDoctrines()) {
      const lender = allies.find((o) => g.ownsDoctrine(o, id) && !g.lentTo(o, p));
      if (lender && g.askDoctrine(p, lender, id).ok) break;
    }
  }
  isWarDoctrine(id) { const d = RESEARCH_BY_ID[id]; return !!d && d.tags.some((t) => t === 'aggro' || t === 'nuke' || t === 'mech'); }
  // The doctrine of ours that would help this ally most without making a rival of it.
  bestLoanFor(o) {
    const g = this.game, p = this.p;
    let best = null, bs = -Infinity;
    for (const id of p.researches) {
      if (!g.ownsDoctrine(p, id) || o.researches.has(id) || !RESEARCH_BY_ID[id] || id.startsWith('cure_')) continue;
      const tags = RESEARCH_BY_ID[id].tags;
      let s = (tags.includes('defense') ? 3 : 0) + (tags.includes('econ') ? 2 : 0) + this.rng.next();
      if (this.isWarDoctrine(id)) s += o.troops < p.troops * 0.8 ? 1 : -6;
      if (s > bs) { bs = s; best = id; }
    }
    return bs > 0 ? best : null;
  }
  // Doctrines we lack that answer the words we hold about the nations threatening us, best first.
  wantedDoctrines() {
    const g = this.game, p = this.p;
    const score = new Map();
    for (const [o] of this.remembered()) {
      if (!g.hostile(p, o)) continue;
      const weight = this.believes(o.smallID, 'danger') ? 2 : this.believes(o.smallID, 'neighbor') ? 1 : 0.4;
      for (const d of Object.values(RESEARCH_BY_ID)) {
        if (p.researches.has(d.id) || !d.answers) continue;
        const s = this.wordSum(o.smallID, d.answers) * weight;
        if (s > 0) score.set(d.id, (score.get(d.id) || 0) + s);
      }
    }
    return [...score.entries()].filter(([, s]) => s >= 1.5).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => id);
  }
  // An ally asks to borrow one of our doctrines.
  answerShare(borrower, id) {
    const p = this.p;
    if (p.relation(borrower) < -10 || (this.rush && this.rush.target === borrower.smallID)) return false;
    if (this.believes(borrower.smallID, 'outgrown') && !this.isWarDoctrine(id)) return true;   // harmless help to a small friend
    if (this.isWarDoctrine(id) && borrower.troops > p.troops * 1.5) return false;               // don't arm a giant
    return this.difficulty === Difficulty.EASY ? this.rng.chance(2) : true;
  }
  // An enemy mech inside our country gets dealt with. A battery already on it is enough; otherwise send a
  // swarm big enough to pull it down, if we can spare the troops without opening ourselves up.
  counterMechs() {
    const g = this.game, p = this.p;
    if (this.difficulty === Difficulty.EASY || g.tick < (this.swarmAfter || 0)) return false;
    const per = this.cfg.swarmDamagePerTroop();
    for (const m of g.mechs) {
      if (m.done || m.onWater || !g.hostile(p, m.owner)) continue;
      const inside = g.owner[g.tileAt(m.x, m.y)] === p.smallID || (m.mode === 'assault' && m.orderTarget === p.smallID && this.nearOurLand(m.x, m.y, 20));
      if (!inside) continue;
      if (g.swarms.some((sw) => !sw.done && sw.owner === p && sw.target === m)) continue;
      const guns = p.completedUnitsOf(UnitType.ARTILLERY).some((u) => g.distXY(g.x(u.tile), g.y(u.tile), m.x, m.y) <= this.cfg.artilleryRange(p));
      if (guns && m.hp < m.maxHp * 0.6) continue;
      const need = Math.ceil((m.hp / per) * 1.3);
      if (need > p.troops * (this.posture === 'turtle' ? 0.35 : 0.5)) continue;
      if (g.swarmMech(p, m.id, need).ok) { this.swarmAfter = g.tick + 60; return true; }
    }
    return false;
  }
  nearOurLand(x, y, r) {
    const g = this.game, p = this.p;
    const t = g.ref(Math.round(Math.max(0, Math.min(g.width - 1, x))), Math.round(Math.max(0, Math.min(g.height - 1, y))));
    if (g.owner[t] === p.smallID) return true;
    const c = g.centroid(p);
    return c ? Math.hypot(c.x - x, c.y - y) <= r + Math.sqrt(p.numTiles) : false;
  }
  // Somewhere of ours close to whatever is hurting us: where a battery, repair yard or a fresh mech
  // earns its keep. Deliberately not on the border itself, where it would just be overrun.
  tileNearThreat() {
    const g = this.game, p = this.p;
    let fx = null, fy = null;
    const inc = p.incomingAttacks.filter((a) => !a.done && a.markX >= 0).sort((a, b) => b.troops - a.troops)[0];
    if (inc) { fx = inc.markX; fy = inc.markY; }
    else {
      const m = g.mechs.find((x) => !x.done && g.hostile(p, x.owner) && this.nearOurLand(x.x, x.y, 60));
      if (m) { fx = m.x; fy = m.y; }
    }
    if (fx === null) return null;
    let best = null, bd = Infinity, i = 0;
    for (const t of p.tiles) {
      if (i++ % 7) continue;
      if (i > 4000) break;
      if (p.border.has(t) || g.unitNear(t, 3)) continue;
      const d = (g.x(t) - fx) ** 2 + (g.y(t) - fy) ** 2;
      if (d > 15 * 15 && d < bd) { bd = d; best = t; }
    }
    return best;
  }
  // A tile just inside the enemy's border, nearest to us: mechs park there and grind the frontier.
  mechTargetTile(enemy) {
    const g = this.game, p = this.p;
    const mine = g.centroid(p);
    if (!mine) return -1;
    let best = -1, bd = Infinity, i = 0;
    for (const t of enemy.border) {
      if (i++ % 5) continue;
      if (i > 3000) break;
      if (!g.isLand(t)) continue;
      const d = (g.x(t) - mine.x) ** 2 + (g.y(t) - mine.y) ** 2;
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  // Drop troops behind someone's defences. Aimed at a soft inner tile rather than the border, because
  // the point of flying is to land where their army is not.
  maybeAirlift() {
    const g = this.game, p = this.p;
    if (!p.alive || g.tick < this.airliftAfter) return false;
    if (!g.airports(p).length) return false;
    if (g.liveAirships(p).length >= this.cfg.airshipCap(p)) return false;
    if (p.troops < this.cfg.maxTroops(p) * 0.4) return false;
    this.airliftAfter = g.tick + 250;
    const victims = g.players.filter((o) => o !== p && o.alive && g.hostile(p, o) && o.numTiles > 60);
    if (!victims.length) return false;
    // Airships exist to crack SAM umbrellas: nations sitting behind SAMs come first, and the drop goes
    // right onto the launchers (with SEAD that wipes them; without, the troops still overrun the tile).
    const sams = (o) => o.units.filter((u) => u.type === UnitType.SAM && u.constructionLeft === 0).length;
    const appeal = (o) => sams(o) * 3 + (o === this.currentEnemy ? 5 : 0) + (this.grudge.get(o.smallID) || 0) / 20 + this.wordSum(o.smallID, CHOICE_WORDS.airlift) * 2;
    victims.sort((a, b) => appeal(b) - appeal(a));
    for (const v of victims.slice(0, 3)) {
      const launchers = v.units.filter((u) => u.type === UnitType.SAM && u.constructionLeft === 0);
      for (const sam of launchers) {
        if (g.liveAirships(p).length >= this.cfg.airshipCap(p)) return true;
        // land next to it rather than on it: the tile itself holds the building
        const x = g.x(sam.tile) + this.rng.int(-2, 2), y = g.y(sam.tile) + this.rng.int(-2, 2);
        if (g.valid(x, y) && g.launchAirship(p, g.ref(x, y)).ok) return true;
      }
      let i = 0;
      for (const t of v.tiles) {
        if (i++ % 23) continue;
        if (i > 2000) break;
        if (v.border.has(t)) continue;
        if (g.liveAirships(p).length >= this.cfg.airshipCap(p)) return true;
        if (g.launchAirship(p, t).ok) return true;
      }
    }
    return false;
  }


  // ---- nukes / bombers ------------------------------------------------------------------
  maybeNuke() {
    const g = this.game, p = this.p;
    if (g.settings.disableNukes || this.difficulty === Difficulty.EASY) return;
    if (this.zombieSiege) { this.zombieNuke(); return; }
    if (this.strikeClump()) return;
    if (this.difficulty === Difficulty.MEDIUM && !this.rng.chance(Math.max(1, Math.round(3 / this.nukeBias)))) return;
    if (g.tick < (this.nukeAfter || 0)) return;
    const c = g.canLaunchNuke(p, NukeType.ATOM, p.spawnTile ?? 0);
    if (!c.ok && !c.reason.startsWith('Not enough')) return;
    const cluster = p.researches.has('cluster_munitions');
    const decoys = p.researches.has('decoy_warheads') || p.researches.has('hypersonic_missiles');
    let enemies = g.players.filter((o) => o !== p && o.alive && !p.isFriendly(o) && o.type !== PlayerType.BOT &&
      (o.incomingAttacks.some((a) => a.attacker === p) || p.incomingAttacks.some((a) => a.attacker === o) || p.relation(o) <= -50 || (this.grudge.get(o.smallID) || 0) > 50));
    if (!enemies.length && this.hardOrWorse && p.troops > this.cfg.maxTroops(p) * 0.8) enemies = g.neighborsOf(p).players.filter((o) => !p.isFriendly(o) && o.type !== PlayerType.BOT);
    if (!enemies.length) return;
    // the one that has hurt us most, then the strongest
    enemies.sort((a, b) => ((this.grudge.get(b.smallID) || 0) - (this.grudge.get(a.smallID) || 0)) || (b.troops - a.troops));
    const target = enemies[0];
    if (target.numTiles < 400) return;
    // Look for the best-value spot, and count the SAMs that would get a shot at each. A bomb into an
    // umbrella is a million gold thrown away; the counters are what make those spots worth hitting.
    let best = null, bestScore = 0, bestCover = 0;
    for (let i = 0; i < 16; i++) {
      const t = g.randomTileOf(target.tiles, this.rng);
      const cx = g.x(t), cy = g.y(t);
      const { outer } = this.cfg.nukeMagnitude(NukeType.ATOM, p);
      let value = 0, ownOrAlly = 0;
      const r = outer + 3;
      for (let y = Math.max(0, cy - r); y <= Math.min(g.height - 1, cy + r); y += 2) for (let x = Math.max(0, cx - r); x <= Math.min(g.width - 1, cx + r); x += 2) {
        const sm = g.owner[g.ref(x, y)];
        if (sm === 0) continue;
        const o = g.playersBySmall[sm];
        if (o === p || p.isFriendly(o)) ownOrAlly++; else if (o === target) value++;
      }
      if (ownOrAlly > 0) continue;
      for (const u of target.units) if (Math.abs(g.x(u.tile) - cx) <= outer && Math.abs(g.y(u.tile) - cy) <= outer) value += u.type === UnitType.SAM ? 120 : 60;
      const cover = this.samCoverPath(t);
      // how much of the payload we expect to land
      const land = cover === 0 ? 1 : cluster ? Math.max(0, (this.cfg.clusterCount() - cover) / this.cfg.clusterCount()) : decoys ? Math.pow(0.55, cover) : 0;
      const score = value * land;
      if (score > bestScore) { bestScore = score; best = t; bestCover = cover; }
    }
    if (best === null || bestScore < 40) return;
    // pick the weapon for that spot
    let type = NukeType.ATOM;
    if (bestCover > 0 && cluster) type = NukeType.CLUSTER;
    else if (bestCover === 0 && this.difficulty === Difficulty.IMPOSSIBLE && p.gold >= this.cfg.nukeCost(NukeType.HYDROGEN, p) * 1.5 && this.rng.chance(3)) type = NukeType.HYDROGEN;
    if (p.gold < this.cfg.nukeCost(type, p) * (1.3 / this.nukeBias)) return;
    if (g.launchNuke(p, type, best).ok) this.nukeAfter = g.tick + NUKE_CADENCE[this.diffIndex] / this.nukeBias;
  }

  maybeBomb() {
    const g = this.game, p = this.p;
    if (!this.wantBombers || !p.researches.has('strategic_bombers')) return;
    if (p.gold < this.cfg.bomberCost() * 2 || !this.rng.chance(2)) return;
    const silos = p.completedUnitsOf(UnitType.SILO);
    if (!silos.length) return;
    const range = this.cfg.bomberRange();
    const targets = g.units.filter((u) => g.hostile(p, u.owner) && u.owner.type !== PlayerType.BOT && [UnitType.SILO, UnitType.SAM, UnitType.FACTORY, UnitType.CITY, UnitType.LAB, UnitType.PORT].includes(u.type) && silos.some((s) => g.dist(s.tile, u.tile) <= range));
    if (!targets.length) return;
    // with SEAD the air defences come first: that is what opens the sky for everything else
    const pri = p.researches.has('sead_doctrine') ? { sam: 9, silo: 5, factory: 4, lab: 3, city: 2, port: 1 } : { silo: 5, sam: 4, factory: 4, lab: 3, city: 2, port: 1 };
    targets.sort((a, b) => (pri[b.type] || 0) - (pri[a.type] || 0));
    g.launchBomber(p, targets[0].tile);
  }
}

// Small tribes: expand slowly, occasionally poke a weaker neighbour, never build.
class BotAI {
  constructor(game, player, seed) {
    this.game = game;
    this.p = player;
    this.rng = new Rng(seed);
    this.rate = this.rng.int(30, 60);
    this.offset = this.rng.int(0, this.rate - 1);
    this.spawnAttemptTick = this.rng.int(5, 40);
  }
  tick() {
    const g = this.game, p = this.p;
    if (g.phase === 'spawn') {
      if (!p.spawned && g.tick >= this.spawnAttemptTick) {
        const t = g.randomSpawnTile(g.config.minDistanceBetweenPlayers() * 0.5);
        if (t !== null) g.spawn(p, t);
        else this.spawnAttemptTick = g.tick + 10;
      }
      return;
    }
    if (!p.alive || g.tick % this.rate !== this.offset) return;
    const { players: neighbors, touchesNeutral } = g.neighborsOf(p);
    if (touchesNeutral) {
      const troops = Math.floor(p.troops * 0.3);
      if (troops > 10) g.sendAttack(p, null, troops);
      return;
    }
    const enemies = neighbors.filter((o) => !p.isFriendly(o) && o.troops < p.troops * 0.8);
    if (enemies.length && this.rng.chance(3)) {
      enemies.sort((a, b) => a.troops - b.troops);
      const troops = Math.floor(p.troops / 4);
      if (troops > 10) g.sendAttack(p, enemies[0], troops);
    }
    for (const [, r] of [...g.allianceRequests]) if (r.to === p) g.replyAlliance(p, r.from, this.rng.chance(3));
  }
}

module.exports = { NationAI, BotAI };
