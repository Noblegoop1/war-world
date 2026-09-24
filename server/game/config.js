'use strict';
// Game tunables. Formulas and numbers follow OpenFront.io's balance (troop growth, attack cost/speed,
// unit prices, trade income, AI difficulty scaling) so the game plays the same; the code is original.

const TerrainType = { WATER: 0, PLAINS: 1, HIGHLAND: 2, MOUNTAIN: 3 };
const PlayerType = { HUMAN: 'human', NATION: 'nation', BOT: 'bot', ZOMBIE: 'zombie' };
const UnitType = { CITY: 'city', PORT: 'port', DEFENSE_POST: 'defense', SILO: 'silo', SAM: 'sam', LAB: 'lab', FACTORY: 'factory', WALL: 'wall', MECH: 'mech', WARSHIP: 'warship', SUBMARINE: 'submarine', MINE: 'mine', ARTILLERY: 'artillery', REPAIR: 'repair', AIRPORT: 'airport' };
// Fixed structures (live on a tile). Mobile units (mech/warship/submarine) are handled by their own systems.
const STRUCTURE_TYPES = ['city', 'port', 'defense', 'silo', 'sam', 'lab', 'factory', 'mine', 'artillery', 'repair', 'airport'];
const { effects: R } = require('./research');
// Structures that count as "population" (a nation's civilian centers). Labs & walls can't be built near these.
const MECH_BARGE_SPEED = 0.5;              // a mech without a water doctrine, crossing on a barge
const POPULATION_TYPES = ['city'];
const NukeType = { ATOM: 'atom', HYDROGEN: 'hydrogen', CLUSTER: 'cluster' };
const Difficulty = { EASY: 'easy', MEDIUM: 'medium', HARD: 'hard', IMPOSSIBLE: 'impossible' };

const TICKS_PER_SECOND = 10;

// OpenFront's default theme palettes (render-settings / default-theme.json).
const HUMAN_COLORS = ['#a3e635', '#84cc16', '#10b981', '#34d399', '#2dd4bf', '#4ade80', '#6ee7b7', '#86efac', '#97ffbb', '#baffc9', '#e6fad2', '#22c55e', '#43be54', '#52b788', '#30b2b4', '#e6fffa', '#dcf0fa', '#e9d5ff', '#ccccff', '#dcdcff', '#cae1ff', '#93c5fd', '#7dd3fc', '#63cafd', '#38bdf8', '#60a5fa', '#3b82f6', '#4f46e5', '#7c3aed', '#9333ea', '#b388ff', '#a78bfa', '#d946ef', '#a855f7', '#be5cfb', '#c084fc', '#f0abfc', '#f472b6', '#ec4899', '#dc2626', '#ef4444', '#eb4b4b', '#f56565', '#f87171', '#fb7185', '#fda4af', '#fca5a5', '#ffcce5', '#fad7e1', '#fbebf5', '#f0f0c8', '#fafad2', '#fff0c8', '#ffdfba', '#fcd34d', '#fbbf24', '#eab308', '#ca8a04', '#f59e0b', '#fb923c', '#f97316', '#ea580c', '#854d0e'];
const NATION_COLORS = ['#d2d264', '#b4d278', '#aabe64', '#50c878', '#82c882', '#8cb48c', '#a0bea0', '#a0b48c', '#64a050', '#648c6e', '#64b4a0', '#82b4aa', '#aabeb4', '#648296', '#78a0c8', '#8c96b4', '#64d2d2', '#8cb4dc', '#82aabe', '#64b4e6', '#5082be', '#7878be', '#966ebe', '#a078a0', '#aa8cbe', '#b482b4', '#be8c96', '#b464e6', '#b4a0b4', '#aa96aa', '#968296', '#e6b4b4', '#d2a0c8', '#e682b4', '#d264a0', '#be6482', '#dc7878', '#c8826e', '#e68c8c', '#e66464', '#e69664', '#d28c50', '#e6b450', '#c8a06e', '#be9682', '#b4aa8c', '#c8c88c', '#beaa64'];
const BOT_COLORS = ['#96a08c', '#a0a096', '#aaaa8c', '#aaaa78', '#96a078', '#96aa82', '#96aa96', '#82aa82', '#8ca08c', '#789664', '#788c78', '#64aa82', '#78a096', '#82a096', '#78aaaa', '#78a0be', '#8296aa', '#8296a0', '#8c96a0', '#8ca0aa', '#96a0a0', '#6478a0', '#78828c', '#8282a0', '#8c828c', '#8c78a0', '#968296', '#968ca0', '#a082a0', '#aa96aa', '#a078be', '#a07882', '#aa788c', '#aa8278', '#aa8282', '#b48c8c', '#be82a0', '#be7878', '#be8c78', '#bea064', '#aa8c64', '#a08c82', '#aa9682', '#a09678', '#a0968c', '#a08c96', '#a096a0', '#968c96', '#b4a0a0'];

const DEFAULT_SETTINGS = {
  name: 'New Game',
  public: false,
  maxHumans: 16,
  map: 'world',
  mapSize: 'normal', // normal | compact (half resolution, faster)
  seed: 0, // random maps only; 0 = random
  nations: 30, // AI nations (uses the map's real nations first)
  bots: 150, // small tribes
  difficulty: Difficulty.MEDIUM,
  spawnPhaseSeconds: 10,
  gameSpeed: 1,
  disableNukes: false,
  disableBoats: false,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  startingGold: 0,
  percentToWin: 80,
  // ---- the options page ----
  mode: 'ffa',                 // ffa | teams | zombie
  zombieDifficulty: 'medium',  // zombie mode: easy | medium | hard | nightmare (the horde's strength)
  teams: '2',                  // '2'..'7' | 'duos' | 'trios' | 'quads' | 'hvn' (humans vs nations)
  nationsDefault: false,       // use every nation the map defines
  randomSpawn: false,
  waterNukes: false,
  doomsdayClock: false,
  maxTimerMinutes: 0,          // game length; 0 = no limit
  goldMultiplier: 1,
  allianceMinutes: 0,          // alliances expire after this long; 0 = never
  overtimeMinutes: 0,          // after this long the land needed to win starts dropping; 0 = never
  disabledUnits: [],
};
// Everything the host can switch off on the options page (keys match the build keys).
const DISABLEABLE_UNITS = ['city', 'defense', 'port', 'warship', 'boat', 'silo', 'sam', 'atom', 'hydrogen', 'mirv', 'factory', 'lab', 'mech', 'wall', 'artillery', 'repair', 'airport', 'submarine'];
const TEAM_SPECS = ['2', '3', '4', '5', '6', '7', 'duos', 'trios', 'quads', 'hvn'];

function sanitizeSettings(input, isValidMapId) {
  const s = { ...DEFAULT_SETTINGS };
  if (!input || typeof input !== 'object') return s;
  const num = (v, lo, hi, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  s.name = String(input.name ?? s.name).slice(0, 32) || 'New Game';
  s.public = !!input.public;
  s.maxHumans = Math.round(num(input.maxHumans, 1, 64, s.maxHumans));
  s.map = isValidMapId && isValidMapId(input.map) ? input.map : s.map;
  s.mapSize = input.mapSize === 'compact' ? 'compact' : 'normal';
  s.seed = Math.round(num(input.seed, 0, 2147483647, 0));
  s.nations = Math.round(num(input.nations, 0, 120, s.nations));
  s.bots = Math.round(num(input.bots, 0, 400, s.bots));
  s.difficulty = Object.values(Difficulty).includes(input.difficulty) ? input.difficulty : s.difficulty;
  s.spawnPhaseSeconds = Math.round(num(input.spawnPhaseSeconds, 5, 180, s.spawnPhaseSeconds));
  s.gameSpeed = num(input.gameSpeed, 0.5, 3, 1);
  s.disableNukes = !!input.disableNukes;
  s.disableBoats = !!input.disableBoats;
  s.infiniteGold = !!input.infiniteGold;
  s.infiniteTroops = !!input.infiniteTroops;
  s.instantBuild = !!input.instantBuild;
  s.startingGold = Math.round(num(input.startingGold, 0, 1e9, 0));
  s.percentToWin = Math.round(num(input.percentToWin, 30, 100, 80));
  // ---- the options page (numbers arrive as a checkbox + a value, OpenFront style) ----
  const on = (k) => input[k] === true || input[k] === 'true' || input[k] === 'on';
  s.mode = input.mode === 'teams' ? 'teams' : input.mode === 'zombie' ? 'zombie' : 'ffa';
  s.zombieDifficulty = ['easy', 'medium', 'hard', 'nightmare'].includes(input.zombieDifficulty) ? input.zombieDifficulty : 'medium';
  s.teams = TEAM_SPECS.includes(String(input.teams)) ? String(input.teams) : '2';
  s.nationsDefault = !!input.nationsDefault;
  s.randomSpawn = !!input.randomSpawn;
  s.waterNukes = !!input.waterNukes;
  s.doomsdayClock = !!input.doomsdayClock && s.mode !== 'zombie';   // the horde is the clock in zombie mode
  s.maxTimerOn = on('maxTimerOn'); s.maxTimer = Math.round(num(input.maxTimer, 1, 120, 30));
  s.maxTimerMinutes = s.maxTimerOn ? s.maxTimer : 0;
  s.goldMultOn = on('goldMultOn'); s.goldMult = num(input.goldMult, 0.1, 100, 2);
  s.goldMultiplier = s.goldMultOn ? s.goldMult : 1;
  s.startingGoldOn = on('startingGoldOn'); s.startingGoldM = num(input.startingGoldM, 0, 1000, 5);
  if (s.startingGoldOn) s.startingGold = Math.round(s.startingGoldM * 1e6);
  s.allianceOn = on('allianceOn'); s.allianceMin = Math.round(num(input.allianceMin, 1, 60, 5));
  s.allianceMinutes = s.allianceOn ? s.allianceMin : 0;
  s.overtimeOn = on('overtimeOn'); s.overtimeMin = Math.round(num(input.overtimeMin, 1, 180, 45));
  s.overtimeMinutes = s.overtimeOn ? s.overtimeMin : 0;
  // disabled units: either a list, or one unit_<key> flag per chip (checked = allowed)
  const list = Array.isArray(input.disabledUnits) ? input.disabledUnits.map(String) : DISABLEABLE_UNITS.filter((k) => input['unit_' + k] === false || input['unit_' + k] === 'false');
  s.disabledUnits = DISABLEABLE_UNITS.filter((k) => list.includes(k));
  if (input.disableNukes && !Array.isArray(input.disabledUnits)) for (const k of ['atom', 'hydrogen', 'mirv']) if (!s.disabledUnits.includes(k)) s.disabledUnits.push(k);
  if (input.disableBoats && !Array.isArray(input.disabledUnits) && !s.disabledUnits.includes('boat')) s.disabledUnits.push('boat');
  for (const k of DISABLEABLE_UNITS) s['unit_' + k] = !s.disabledUnits.includes(k);
  s.disableNukes = s.disabledUnits.includes('atom') && s.disabledUnits.includes('hydrogen');
  s.disableBoats = s.disabledUnits.includes('boat');
  return s;
}

const within = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const sigmoid = (x, k, mid) => 1 / (1 + Math.exp(-k * (x - mid)));

// Attack tunables (OpenFront)
const LARGE_TERRITORY_MIDPOINT = 300000;
const LARGE_TERRITORY_STEEPNESS = 2.5;
const LARGE_ATTACKER_DEPTH = 0.7;
const LARGE_DEFENDER_DEPTH = 0.3;
const LARGE_ATTACKER_SPEED_DEPTH = 0.73;
const BOT_DEFENDER_LOSS_MULT = 0.7;
const TERRA_NULLIUS_COST_SCALE = 2000;
// ---- economy (see passiveGold) ----
const LAND_GOLD = 2.5;                                   // gold/tick per sqrt(tile)
const CITY_GOLD_UNIT = 70;                               // gold/tick for a level-1 City
const CITY_GOLD_BY_LEVEL = [0, 1, 2.2, 3.6, 6.5];        // multiples of the unit; level 4 is the big step
const PEACE_DIVIDEND = 1.3;                              // passive gold multiplier while at peace
const PEACE_DIVIDEND_TICKS = 900;                        // 90s since you last attacked a nation
const CONQUEST_TREASURY_SHARE = 0.5;
const ALLIED_TRADE_BONUS = 1.75;                       // trade ships between allies pay both sides 75% more
// Declaring war: a standing war economy costs gold, and the declared target is hit harder.
const WAR_GOLD_PENALTY = 0.8;
const WAR_TROOP_BONUS = 1.15;
const WAR_MIN_TICKS = 600;                              // a war lasts at least a minute before peace can be made
const TERRA_NULLIUS_MIN_COST = 5;
const TERRA_NULLIUS_MAX_COST = 100;
const ATTACKER_LOSS_BASE = 0.463;
const ATTACKER_LOSS_PER_DENSITY = 0.0039;
const SPEED_COST_DIVISOR = 8.55;

function largeTerritoryBonus(numTiles, depth) {
  return 1 - depth * sigmoid(Math.log(Math.max(1, numTiles)), LARGE_TERRITORY_STEEPNESS, Math.log(LARGE_TERRITORY_MIDPOINT));
}
function terrainAttackBase(terrain) {
  switch (terrain) {
    case TerrainType.HIGHLAND: return { mag: 100, tileCost: 20 };
    case TerrainType.MOUNTAIN: return { mag: 120, tileCost: 25 };
    default: return { mag: 80, tileCost: 16.5 };
  }
}

class Config {
  constructor(settings) { this.settings = settings; }

  difficulty() { return this.settings.difficulty; }
  infiniteGold() { return this.settings.infiniteGold; }
  infiniteTroops() { return this.settings.infiniteTroops; }
  instantBuild() { return this.settings.instantBuild; }

  numSpawnPhaseTicks() { return this.settings.spawnPhaseSeconds * TICKS_PER_SECOND; }
  spawnRadius() { return 4; }
  minDistanceBetweenPlayers() { return 30; }
  spawnImmunityTicks() { return 50; }
  percentageTilesOwnedToWin() { return this.settings.percentToWin; }
  conquerThresholdTiles() { return 100; }

  defensePostRange() { return 30; }
  defensePostDefenseBonus() { return 5; }
  defensePostSpeedBonus() { return 3; }
  // Extra difficulty on the defender's own border tiles inside a post's range, on top of the radius
  // bonus above. These are the tiles the client draws with the fortified border colour.
  defensePostBorderBonus() { return 1.5; }
  // Walls and defense posts work together: a wall that starts or ends on one of your posts, and is no
  // longer than this, is 30% cheaper - so posts want to sit within this distance of each other and be
  // joined up. Wall tiles inside a post's range are as much harder to break as a border tile there.
  wallLinkMaxLength() { return 50; }
  wallLinkDiscount() { return 0.7; }
  wallPostSnap() { return 6; }
  // A post only shells ships if it can see the sea. Anything further inland than this is a land fort.
  defensePostCoastRange() { return 6; }
  // Coastal guns harass ships, they don't sink them: a fraction of a warship's health per shell.
  defensePostShipDamage(player) { return this.warshipHp() * R.defensePostShipDamagePct(player); }
  samRange(player) { return 70 + R.samRangeBonus(player); }
  samCooldownTicks() { return 90; }
  siloCooldownTicks(player) { return Math.floor(90 * R.siloCooldownMultiplier(player)); }
  cityTroopIncrease(player) { return R.cityTroopBonus(player); }
  boatMaxNumber(player) { return this.settings.disableBoats ? 0 : R.boatMax(player); }
  boatSpeed(player) { return 2 * R.boatSpeed(player); } // tiles per tick along the path
  tradeShipSpeed() { return 1.2; }
  trainSpeed() { return 2.5; }
  nukeSpeed(player) { return 6 * R.missileSpeedMultiplier(player); } // tiles per tick along the arc
  // Cluster Strike: many small missiles instead of one big one, so SAMs (one kill per reload) saturate.
  clusterCount() { return 8; }
  clusterSpread() { return 20; }
  mirvWarheads() { return 5; }
  nukeMagnitude(type, player) {
    if (type === NukeType.HYDROGEN) return { inner: 80, outer: 100 };
    if (type === 'bomblet') return { inner: 3, outer: 6 };
    return R.atomMagnitude(player);
  }
  // ---- warships / navy (OpenFront numbers) ----
  warshipHp() { return 1000; }
  warshipPatrolRange() { return 100; }
  warshipTargetRange() { return 130; }
  warshipShellRate() { return 20; }
  warshipSpeed() { return 1.2; }
  shellSpeed() { return 3; }
  shellDamage(rng) { return Math.floor(250 * ((rng.int(1, 6) - 1) * 25 + 200) / 100); }
  bombardRange() { return 40; }
  submarineHp() { return 800; }
  submarineDetectRange() { return 10; }
  submarineVolleyCooldown() { return 90 * TICKS_PER_SECOND; }
  submarineMissileRange() { return 80; }
  mineRange() { return 2; }
  defensePostShipRange(player) { return R.defensePostShipRange(player); }
  defensePostShellRate(player) { return R.defensePostShellRate(player); }
  // ---- rails / factories (OpenFront numbers) ----
  // A station this close to another is still wired into the network, it just isn't worth
  // laying a dedicated rail to; `trainStationMinRange` is only a *preference* for where trains go.
  railMinRange() { return 2; }
  trainStationMinRange() { return 15; }
  trainStationMaxRange() { return 110; }
  railroadMaxSize() { return Math.floor(110 * 1.4142); }
  trainSpawnRate(numFactories) { return (numFactories + 10) * 15; } // expected ticks between trains per factory level
  // A factory above level 2 isn't just bigger, it's better run: more gold per delivery from that station.
  factoryEfficiency(level) { return 1 + Math.max(0, level - 2) * 0.35; }
  trainGold(rel, stopsVisited) {
    const base = rel === 'ally' ? 35000 : rel === 'self' ? 10000 : 25000;
    return Math.max(5000, base - Math.max(0, stopsVisited - 9) * 5000);
  }
  bomberCost(player = null) { return player && player.type === PlayerType.HUMAN && this.infiniteGold() ? 0 : 300000; }
  bomberRange() { return 250; }
  bomberSpeed() { return 4; }
  traitorDurationTicks() { return 30 * TICKS_PER_SECOND; }
  traitorDefenseDebuff() { return 1.5; }
  traitorSpeedDebuff() { return 0.75; }
  falloutDefenseModifier(ratio) { return 5 - ratio * 2; }
  // How long ground stays irradiated, in ticks. Long enough to matter, short enough that the map heals.
  falloutDuration(type) { return type === 'hydrogen' ? 2400 : type === 'warhead' ? 700 : type === 'bomblet' ? 300 : 1200; }
  // Troops lost per tile of theirs that a blast erases, as a share of their standing army. OpenFront
  // applies a per-tile death factor like this; troops in transit die with the rest.
  nukeDeathFactor(troops, tilesOwned) { return (5 * troops) / Math.max(1, tilesOwned); }
  nukeMaxTroopLoss() { return 0.75; }
  allianceRequestTimeoutTicks() { return 30 * TICKS_PER_SECOND; }

  constructionTicks(type) {
    if (this.instantBuild()) return 0;
    switch (type) {
      case UnitType.CITY: return 20;
      case UnitType.PORT: return 50;
      case UnitType.DEFENSE_POST: return 50;
      case UnitType.SILO: return 100;
      case UnitType.SAM: return 300;
      case UnitType.LAB: return 100;
      case UnitType.MECH: return 80;
      case UnitType.ARTILLERY: return 90;
      case UnitType.AIRPORT: return 200;
      case UnitType.REPAIR: return 70;
      default: return 0;
    }
  }
  buildDiscount(player) { return R.buildDiscount(player); }
  // numOwned: count of the type owned (ports and factories share a count, as in OpenFront).
  unitCost(type, numOwned, player) {
    if (player && player.type === PlayerType.HUMAN && this.infiniteGold()) return 0;
    const d = this.buildDiscount(player);
    switch (type) {
      // The first few are as cheap as ever; the ladder now tops out at 2M instead of 1M, because income
      // no longer sits at a flat 1K/s and a 1M cap stopped meaning anything by mid-game.
      case UnitType.CITY: return Math.min(2000000, Math.pow(2, numOwned) * 125000) * d;
      case UnitType.PORT:
      case UnitType.FACTORY: return Math.min(2000000, Math.pow(2, numOwned) * 125000) * d;
      // Posts were 250K at most - about 17 seconds of mid-game income for x5 attacker losses.
      case UnitType.DEFENSE_POST: return Math.min(600000, (numOwned + 1) * 75000) * d;
      case UnitType.SILO: return 1500000 * d;
      case UnitType.SAM: return Math.min(3000000, (numOwned + 1) * 1500000) * d;
      case UnitType.LAB: return 1000000 * this.labCostMultiplier(numOwned) * d;
      case UnitType.MINE: return 100000 * d;
      case UnitType.WARSHIP: {
        let c = Math.min(1500000, (numOwned + 1) * 300000);
        if (player && player.researches && player.researches.has('coastal_bombardment')) c += 300000 * Math.floor(numOwned / 10);
        return c * d;
      }
      case UnitType.SUBMARINE: return Math.min(3000000, (numOwned + 1) * 750000) * d;
      // Mechs are national-scale assets: brutally expensive, escalating hard per mech owned.
      case UnitType.MECH: return (2000000 + numOwned * 2500000) * R.mechCostMultiplier(player) * d;
      case UnitType.ARTILLERY: return Math.min(2500000, (numOwned + 1) * 400000) * d;
      case UnitType.AIRPORT: return 8000000 * d;
      case UnitType.REPAIR: return Math.min(2000000, (numOwned + 1) * 500000) * d;
      default: return 0;
    }
  }
  // Wall tiles (walls are 3 tiles thick): near-exponential in the number of wall tiles already owned.
  wallTileCost(numWallTiles, player) {
    if (player && player.type === PlayerType.HUMAN && this.infiniteGold()) return 0;
    return Math.floor((700 + 120 * numWallTiles) * Math.pow(1.006, numWallTiles) * this.buildDiscount(player));
  }
  wallMaxHp() { return 60000; }
  wallBuildTicks() { return 120; }        // per 3x3 block, built one block at a time (slowest build in the game)
  wallThickness() { return 3; }
  labResearchTicks() { return 60 * TICKS_PER_SECOND; }
  labCooldownTicks() { return 45 * TICKS_PER_SECOND; }
  // Each finished lab is worth two doctrines, and every lab after the first costs five times the last.
  // Wanting a fourth doctrine is a real economic decision rather than a formality.
  researchesPerLab() { return 2; }
  maxResearchesPerPlayer(player) { return this.researchesPerLab() * Math.max(1, this.completedLabs(player)); }
  completedLabs(player) { return player ? player.units.filter((u) => u.type === UnitType.LAB && u.constructionLeft === 0).length : 1; }
  labCostMultiplier(numLabs) { return Math.pow(5, numLabs); }
  // Research is slow on purpose: a doctrine is a commitment, and the wait is what makes where you put
  // the lab (and whether you can hold it) matter. Better doctrines take longer.
  labResearchTicks(tier = 2) { return (120 + 60 * tier) * TICKS_PER_SECOND; }
  // Everything tops out at level 3; one doctrine can push a single building type to 4.
  maxUnitLevel(player, type) { return 3 + R.maxLevelBonus(player, type); }
  populationRequiredForLab() { return 3; }
  structureMinGap() { return 3; }
  labMinGapFromPopulation() { return 6; }

  // ---- Mechs: super-tanky walking artillery, built at level-2+ factories ----
  mechFactoryLevelRequired() { return 2; }
  mechBaseHp(player, factoryLevel = 2) { return Math.floor(40000 * (1 + 0.5 * (factoryLevel - 2)) * R.mechHpMultiplier(player)); }
  // Ground matters: on its own roads a mech drives - fast enough to reach an attack anywhere at home
  // within seconds - it wades through no-man's land and crawls once it is inside someone else's country.
  // Without a water doctrine it crosses the sea on a slow barge. `ground` is 'own' | 'ally' | 'neutral' | 'enemy'.
  mechSpeed(player, onWater = false, ground = 'neutral') {
    let base;
    if (onWater) base = R.mechCrossesWater(player) ? 0.35 : MECH_BARGE_SPEED;
    else base = ground === 'own' ? 1.2 : ground === 'ally' ? 0.8 : ground === 'enemy' ? 0.3 : 0.45;
    return base * R.mechSpeedMultiplier(player);
  }
  // A mech shell into an attacking army: a share of that attack plus a flat bite, by factory level.
  // Against troops a mech fires suppressive rounds, three times as often as its normal cannon.
  mechAttackKill(player, factoryLevel = 2) {
    const m = (1 + 0.3 * (factoryLevel - 2)) * R.mechDamageMultiplier(player);
    return { share: 0.03 * m, flat: 5000 * m };
  }
  // Spearhead: your own attacks within this range of your mech take ground faster and lose fewer troops.
  mechSuppressFactor() { return 3; }
  // Hold zone: the owner's ground this close to a mech can't be taken while it stands. Each attempt at it
  // chips the mech (a big army chips harder) and costs the attacker troops.
  mechHoldRadius() { return 6; }
  mechHoldChip(attackTroops) { return 15 + attackTroops * 0.00001; }
  mechHoldBleed() { return 400; }
  mechSpearheadRange() { return 40; }
  // Share of a nation's army each mech shell takes while the mech's owner is attacking that nation
  // (a stomp takes a quarter of this).
  mechWarBite(player, factoryLevel = 2) { return 0.02 * (1 + 0.3 * (factoryLevel - 2)) * R.mechDamageMultiplier(player); }
  mechSpearheadSpeed() { return 2; }
  mechSpearheadLoss() { return 0.5; }
  // Swarms: troops sent at an enemy mech. Every troop that reaches it takes this much off its health.
  swarmSpeed() { return 1.5; }
  swarmDamagePerTroop() { return 0.03; }
  swarmRange() { return 120; }            // how far from your own land a swarm will run
  swarmShellKill() { return 0.15; }       // share of a swarm a mech shell kills
  mechRange(player, factoryLevel = 2) { return 12 + 3 * (factoryLevel - 2) + R.mechRangeBonus(player); }
  mechCannonCooldown(player) { return Math.floor(60 * R.mechCooldownMultiplier(player)); }
  mechStompCooldown(player) { return Math.floor(20 * R.mechCooldownMultiplier(player)); }
  mechShellDamage(player, factoryLevel = 2) { return Math.floor(2500 * (1 + 0.3 * (factoryLevel - 2)) * R.mechDamageMultiplier(player)); }
  mechShellBlastRadius() { return 2.5; }
  mechStompRadius(player) { return 3 + R.mechStompBonus(player); }
  mechTroopKillPerShell(player, factoryLevel = 2) { return Math.floor(6000 * (1 + 0.3 * (factoryLevel - 2)) * R.mechDamageMultiplier(player)); }
  mechPatrolRadius() { return 6; }
  // Against ships a mech is a harassing gun, unless it is an Amphibious mech built for exactly this.
  mechShipDamage(player) { return R.mechAmphibious(player) ? 950 : 350; }
  mechShipRangeMultiplier(player) { return R.mechAmphibious(player) ? 1.5 : 1; }
  mechSubDetectRange() { return 30; }
  // ---- Artillery Battery: the static answer to a mech parked on your border ----
  artilleryRange(player) { return 45 + R.artilleryRangeBonus(player); }
  // A battery is a siege gun, not a machine gun: one shell every 45 seconds, but a direct hit takes a
  // quarter of a mech or a tenth of a warship. Damage is a fraction of the target's own maximum, so it
  // stays meaningful against high-level mechs.
  artilleryReload(player) { return Math.floor(450 * R.artilleryReloadMultiplier(player)); }
  artilleryMechDamageFraction(player) { return 0.25 * R.artilleryDamageMultiplier(player); }
  artilleryShipDamageFraction(player) { return 0.1 * R.artilleryDamageMultiplier(player); }
  artilleryTroopKill(player) { return Math.floor(20000 * R.artilleryDamageMultiplier(player)); }
  artilleryBlastRadius() { return 3; }
  // ---- Repair Yard: keeps mechs and walls alive near the front ----
  repairRange() { return 40; }
  repairInterval() { return 20; }
  repairMechPercent() { return 0.02; }   // of max HP, per interval, per mech in range
  repairWallAmount() { return 2500; }    // HP per interval, spread over the damaged tiles it can reach
  repairWallTilesPerPass() { return 12; }
  // ---- Airport / airships (see air.js for why these numbers are so unforgiving) ----
  maxAirports() { return 1; }
  airportSamExclusion() { return 70; }
  airshipCap(player) { return 3 + R.airshipCapBonus(player); }
  // Every Port / Factory at the top level adds one to how many of its units you may field, and a
  // level-4 one (Heavy Industry) adds another. Levelling production is how you grow a navy or mech corps.
  producerCapBonus(player, type) {
    let b = 0;
    for (const u of player.units) if (u.type === type && u.constructionLeft === 0) { if (u.level >= 3) b++; if (u.level >= 4) b++; }
    return b;
  }
  warshipCap(player) { return R.warshipCap(player) + this.producerCapBonus(player, UnitType.PORT); }
  submarineCap(player) { return 2 + this.producerCapBonus(player, UnitType.PORT); }
  mechCap(player) { return R.mechCap(player) + this.producerCapBonus(player, UnitType.FACTORY); }
  airshipCost(player, built) {
    if (player && player.type === PlayerType.HUMAN && this.infiniteGold()) return 0;
    return (1000000 + built * 750000) * R.airshipCostMultiplier(player) * this.buildDiscount(player);
  }
  airshipTroopShare(player) { return 0.05 * R.airshipCapacityMultiplier(player); }
  airshipSpeed(player) { return 1.4 * R.airshipSpeedMultiplier(player); }
  // Airships reach anywhere; the Airport's road network (and Strategic Airlift's longer roads) decides
  // where they take off from.
  airportRoadRange(player) { return 110 * R.airportRoadMultiplier(player); }
  airshipHp() { return 1; }
  seadRadius() { return 15; }
  interceptorRange(player) { return 60 + R.interceptorRangeBonus(player); }
  interceptorKillChance(player) { return 0.45 * R.interceptorChanceMultiplier(player); }
  // A mech anchors the ground around it, like a mobile defense post.
  mechAuraRange() { return 30; }
  mechDefenseBonus() { return 3; }
  mechSpeedPenalty() { return 2; }
  nukeCost(type, player) {
    if (player && player.type === PlayerType.HUMAN && this.infiniteGold()) return 0;
    if (type === NukeType.CLUSTER) return 1500000;
    return type === NukeType.HYDROGEN ? 6000000 : R.atomCost(player);
  }

  startTroops(type) {
    if (type === PlayerType.BOT) return 10000;
    if (type === PlayerType.NATION) {
      switch (this.difficulty()) {
        case Difficulty.EASY: return 12500;
        case Difficulty.MEDIUM: return 18750;
        case Difficulty.HARD: return 25000;
        case Difficulty.IMPOSSIBLE: return 31250;
      }
    }
    return this.infiniteTroops() ? 1000000 : 25000;
  }
  maxTroops(player) {
    if (player.type === PlayerType.HUMAN && this.infiniteTroops()) return 1e9;
    const max = (2 * (Math.pow(player.numTiles, 0.6) * 1000 + 50000) + player.cityLevels() * this.cityTroopIncrease(player)) * R.maxTroopsMultiplier(player);
    if (player.type === PlayerType.BOT) return max / 3;
    if (player.type === PlayerType.HUMAN) return max;
    switch (this.difficulty()) {
      case Difficulty.EASY: return max * 0.5;
      case Difficulty.MEDIUM: return max * 0.75;
      case Difficulty.IMPOSSIBLE: return max * 1.25;
      default: return max;
    }
  }
  troopIncreaseRate(player) {
    const max = this.maxTroops(player);
    let toAdd = 10 + Math.pow(player.troops, 0.73) / 4;
    toAdd *= 1 - player.troops / max;
    if (player.type === PlayerType.BOT) toAdd *= 0.5;
    if (player.type === PlayerType.NATION) {
      switch (this.difficulty()) {
        case Difficulty.EASY: toAdd *= 0.9; break;
        case Difficulty.MEDIUM: toAdd *= 0.95; break;
        case Difficulty.IMPOSSIBLE: toAdd *= 1.05; break;
      }
    }
    toAdd *= R.troopGrowthMultiplier(player, player.connectedFactories || 0);
    return Math.min(player.troops + toAdd, max) - player.troops;
  }
  // Passive income, split into the parts the HUD shows. The flat base is OpenFront's; on top of it:
  //   land   - grows with the square root of territory, so ten times the land is ~three times the gold
  //   cities - every City pays by level, which is what makes building an actual investment
  // Tribes stay poor on purpose. Everything here is gold per tick.
  passiveGold(player) {
    if (player.type === PlayerType.BOT) return { base: 50, land: 0, cities: 0 };
    let cities = 0;
    for (const u of player.units) if (u.type === UnitType.CITY && u.constructionLeft === 0) cities += CITY_GOLD_BY_LEVEL[Math.min(u.level, CITY_GOLD_BY_LEVEL.length - 1)];
    return { base: 100, land: LAND_GOLD * Math.sqrt(player.numTiles), cities: cities * CITY_GOLD_UNIT };
  }
  // Not having started a war with another nation for a while pays: the turtle's income bonus.
  isAtPeace(player, tick) { return tick - (player.lastOffenseTick ?? -1e9) >= PEACE_DIVIDEND_TICKS; }
  goldAdditionRate(player, attacking = false, tick = 0) {
    const g = this.passiveGold(player);
    let rate = (g.base + g.land + g.cities) * R.goldMultiplier(player, attacking);
    if (player.type !== PlayerType.BOT && this.isAtPeace(player, tick)) rate *= PEACE_DIVIDEND;
    if (player.warsDeclared && player.warsDeclared.size) rate *= WAR_GOLD_PENALTY;
    return rate;
  }
  // Gold each side earns when a trade ship arrives, by sailing distance.
  alliedTradeBonus() { return ALLIED_TRADE_BONUS; }
  cityGold(level) { return CITY_GOLD_BY_LEVEL[Math.min(level, CITY_GOLD_BY_LEVEL.length - 1)] * CITY_GOLD_UNIT; }   // per tick
  // Ships take their port's level: tougher and harder-hitting per level.
  warshipMaxHp(level = 1) { return Math.round(this.warshipHp() * (1 + 0.35 * (level - 1))); }
  warshipDamageMultiplier(level = 1) { return 1 + 0.25 * (level - 1); }
  submarineMaxHp(level = 1) { return Math.round(this.submarineHp() * (1 + 0.35 * (level - 1))); }
  // A better-equipped lab thinks faster, but not so fast that a doctrine arrives in seconds.
  labSpeedMultiplier(level = 1) { return [1, 1, 0.8, 0.65][Math.min(level, 3)]; }
  labUpgradeCost(level) { return 1500000 * level; }
  peaceDividendMultiplier() { return PEACE_DIVIDEND; }
  warGoldPenalty() { return WAR_GOLD_PENALTY; }
  warTroopBonus() { return WAR_TROOP_BONUS; }
  warMinTicks() { return WAR_MIN_TICKS; }
  tradeShipGold(dist) {
    const debuff = 300;
    return Math.floor(75000 / (1 + Math.exp(-0.03 * (dist - debuff))) + 50 * dist);
  }
  // Probability per tick that a port spawns a trade ship (damped by the global ship count).
  tradeShipSpawnChance(portLevel, numTradeShips) {
    const boost = 1 + 0.45 * Math.exp(-numTradeShips / 120);
    const damping = 1 - sigmoid(numTradeShips, Math.LN2 / 50, 330);
    const plateau = 0.25 * (1 - sigmoid(numTradeShips, Math.LN2 / 100, 800));
    return (portLevel * boost * Math.max(damping, plateau)) / 250;
  }
  attackAmount(attacker, ratio) {
    const r = ratio ?? (attacker.type === PlayerType.BOT ? 1 / 20 : 1 / 5);
    return Math.floor(attacker.troops * r);
  }
  attackLogic(input) {
    const { attackTroops, attacker, defender } = input;
    let { mag, tileCost } = terrainAttackBase(input.terrain);
    if (defender !== null && input.defenderHasDefensePost) {
      mag *= this.defensePostDefenseBonus(); tileCost *= this.defensePostSpeedBonus();
      if (input.isDefenderBorder) { mag *= this.defensePostBorderBonus(); tileCost *= this.defensePostBorderBonus(); }
    }
    // A mech nearby digs in the ground it stands on, the same way a defense post does.
    if (defender !== null && input.defenderHasMech) { mag *= this.mechDefenseBonus(); tileCost *= this.mechSpeedPenalty(); }
    // zombie ground: the dead are thick on it (zombie mode)
    if (defender !== null && input.zombieDefense) mag *= input.zombieDefense;
    // ...and on the attack it is the spearhead: troops pushing past their own mech break through.
    if (defender !== null && input.attackerHasMech) { mag *= this.mechSpearheadLoss(); tileCost /= this.mechSpearheadSpeed(); }
    if (input.falloutRatio !== null) { const f = this.falloutDefenseModifier(input.falloutRatio); mag *= f; tileCost *= f; }
    if (defender === null) {
      const tickBudget = input.borderSize * 2;
      return {
        attackerTroopLoss: mag / (attacker.type === PlayerType.BOT ? 10 : 5),
        defenderTroopLoss: 0,
        tickFraction: within((TERRA_NULLIUS_COST_SCALE * tileCost) / attackTroops, TERRA_NULLIUS_MIN_COST, TERRA_NULLIUS_MAX_COST) / tickBudget,
      };
    }
    if (attacker.type !== PlayerType.BOT && defender.type === PlayerType.BOT) mag *= BOT_DEFENDER_LOSS_MULT;
    const largeAttackerBonus = largeTerritoryBonus(attacker.numTiles, LARGE_ATTACKER_DEPTH);
    const largeDefenderBonus = largeTerritoryBonus(defender.numTiles, LARGE_DEFENDER_DEPTH);
    const traitorLossMod = defender.isTraitor ? this.traitorDefenseDebuff() : 1;
    const traitorCostMod = defender.isTraitor ? this.traitorSpeedDebuff() : 1;
    const defenderTroopLoss = defender.troops / Math.max(1, defender.numTiles);
    const troopRatio = defender.troops / Math.max(1, attackTroops);
    const attackerTroopLoss = mag * traitorLossMod * within(troopRatio, 0.6, 2) *
      (ATTACKER_LOSS_BASE * largeAttackerBonus * largeDefenderBonus + ATTACKER_LOSS_PER_DENSITY * defenderTroopLoss);
    const speedCost = (within(troopRatio, 0.82, 7.5) * within(troopRatio / 20, 1, 50)) / SPEED_COST_DIVISOR;
    const largeAttackerSpeedBonus = largeTerritoryBonus(attacker.numTiles, LARGE_ATTACKER_SPEED_DEPTH);
    return {
      attackerTroopLoss: attackerTroopLoss * (input.attackerLossMult || 1),
      defenderTroopLoss,
      tickFraction: (speedCost * tileCost * largeAttackerSpeedBonus * largeDefenderBonus * traitorCostMod) / Math.max(1, input.borderSize) / (input.attackSpeedMult || 1),
    };
  }
  // OpenFront: conquering an AI takes its whole treasury, a human half of it. We add a land bounty
  // so swallowing a big nation pays a good chunk.
  // Half the loser's treasury, whoever they were. Taking an AI's whole purse made eating neighbours
  // the only real economy; the land bounty still makes a big conquest pay.
  conquerGoldAmount(captured) {
    return Math.floor(captured.gold * CONQUEST_TREASURY_SHARE) + 10000 + captured.numTiles * 15;
  }
  nationAttackRate(rng) {
    switch (this.difficulty()) {
      case Difficulty.EASY: return rng.int(65, 100);
      case Difficulty.MEDIUM: return rng.int(55, 70);
      case Difficulty.HARD: return rng.int(45, 60);
      default: return rng.int(30, 50);
    }
  }
}

const { RESEARCH, RESEARCH_BY_ID } = require('./research');

module.exports = {
  TerrainType, PlayerType, UnitType, STRUCTURE_TYPES, POPULATION_TYPES, NukeType, Difficulty, TICKS_PER_SECOND, DEFAULT_SETTINGS, sanitizeSettings,
  Config, within, HUMAN_COLORS, NATION_COLORS, BOT_COLORS, RESEARCH, RESEARCH_BY_ID, DISABLEABLE_UNITS, TEAM_SPECS,
};
