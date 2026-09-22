'use strict';
// Game tunables. Formulas and numbers follow OpenFront.io's balance (troop growth, attack cost/speed,
// unit prices, trade income, AI difficulty scaling) so the game plays the same; the code is original.

const TerrainType = { WATER: 0, PLAINS: 1, HIGHLAND: 2, MOUNTAIN: 3 };
const PlayerType = { HUMAN: 'human', NATION: 'nation', BOT: 'bot' };
const UnitType = { CITY: 'city', PORT: 'port', DEFENSE_POST: 'defense', SILO: 'silo', SAM: 'sam', LAB: 'lab', WALL: 'wall', MECH: 'mech' };
// Structures that count as "population" (a nation's civilian centers). Labs & walls can't be built near these.
const POPULATION_TYPES = ['city'];
const NukeType = { ATOM: 'atom', HYDROGEN: 'hydrogen' };
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
  spawnPhaseSeconds: 30,
  gameSpeed: 1,
  disableNukes: false,
  disableBoats: false,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  startingGold: 0,
  percentToWin: 80,
};

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
  samRange() { return 70; }
  samCooldownTicks() { return 90; }
  siloCooldownTicks() { return 90; }
  cityTroopIncrease() { return 250000; }
  boatMaxNumber() { return this.settings.disableBoats ? 0 : 3; }
  boatSpeed() { return 2; } // tiles per tick
  tradeShipSpeed() { return 1; }
  nukeSpeed() { return 4; }
  nukeMagnitude(type) { return type === NukeType.HYDROGEN ? { inner: 80, outer: 100 } : { inner: 12, outer: 30 }; }
  traitorDurationTicks() { return 30 * TICKS_PER_SECOND; }
  traitorDefenseDebuff() { return 1.5; }
  traitorSpeedDebuff() { return 0.75; }
  falloutDefenseModifier(ratio) { return 5 - ratio * 2; }
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
      default: return 0;
    }
  }
  // Mass Production research: all buildings cost 15% less.
  buildDiscount(player) { return player && player.researches && player.researches.has('mass_production') ? 0.85 : 1; }
  unitCost(type, numOwned, player) {
    if (player && player.type === PlayerType.HUMAN && this.infiniteGold()) return 0;
    const d = this.buildDiscount(player);
    switch (type) {
      case UnitType.CITY: return Math.min(1000000, Math.pow(2, numOwned) * 125000) * d;
      case UnitType.PORT: return Math.min(1000000, Math.pow(2, numOwned) * 125000) * d;
      case UnitType.DEFENSE_POST: return Math.min(250000, (numOwned + 1) * 50000) * d;
      case UnitType.SILO: return 1000000 * d;
      case UnitType.SAM: return Math.min(3000000, (numOwned + 1) * 1500000) * d;
      case UnitType.LAB: return 1000000 * d;
      // Mechs are national-scale assets: brutally expensive, escalating hard per mech owned.
      case UnitType.MECH: return (2000000 + numOwned * 2500000) * (player && player.researches && player.researches.has('mech_production') ? 0.6 : 1) * d;
      default: return 0;
    }
  }
  // Wall segments: near-exponential in the number of wall tiles already built.
  wallSegmentCost(numWallTiles, player) {
    if (player && player.type === PlayerType.HUMAN && this.infiniteGold()) return 0;
    return Math.floor((2000 + 400 * numWallTiles) * Math.pow(1.012, numWallTiles) * this.buildDiscount(player));
  }
  wallMaxHp() { return 60000; }
  labResearchTicks() { return 60 * TICKS_PER_SECOND; } // 60s to complete a research
  labCooldownTicks() { return 45 * TICKS_PER_SECOND; }
  maxResearchesPerPlayer() { return 2; }
  populationRequiredForLab() { return 3; }
  structureMinGap() { return 3; }        // labs/walls can't be within this many tiles of a population building
  labMinGapFromPopulation() { return 6; }

  // ---- Mechs (every nation has them from the start) ----
  mechBaseHp(player) {
    let hp = 8000;
    if (player && player.researches) { if (player.researches.has('heavy_mech')) hp *= 2.2; }
    return hp;
  }
  mechSpeed(player) {
    let s = 0.6; // tiles/tick
    if (player && player.researches) { if (player.researches.has('heavy_mech')) s *= 0.6; }
    return s;
  }
  mechRange(player) { return player && player.researches && player.researches.has('longrange_mech') ? 14 : 3; }
  mechTroopDamagePerTick(player) {
    let d = 1200; // damage dealt to enemy troops per tick while engaged
    if (player && player.researches && player.researches.has('mech_weapons')) d *= 1.6;
    return d;
  }
  mechTroopDamageResist() { return 0.15; } // mechs take only 15% of the troop loss a normal tile would inflict
  mechConquerBonus(player) { return player && player.researches && player.researches.has('assault_mech') ? 3 : 1; } // vs defended land
  nukeCost(type, player) {
    if (player && player.type === PlayerType.HUMAN && this.infiniteGold()) return 0;
    return type === NukeType.HYDROGEN ? 5000000 : 750000;
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
    const max = 2 * (Math.pow(player.numTiles, 0.6) * 1000 + 50000) + player.cityLevels() * this.cityTroopIncrease();
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
    return Math.min(player.troops + toAdd, max) - player.troops;
  }
  goldAdditionRate(player) {
    return player.type === PlayerType.BOT ? 50 : 100;
  }
  // Gold each side earns when a trade ship arrives, by sailing distance.
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
    if (defender !== null && input.defenderHasDefensePost) { mag *= this.defensePostDefenseBonus(); tileCost *= this.defensePostSpeedBonus(); }
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
      attackerTroopLoss,
      defenderTroopLoss,
      tickFraction: (speedCost * tileCost * largeAttackerSpeedBonus * largeDefenderBonus * traitorCostMod) / Math.max(1, input.borderSize),
    };
  }
  conquerGoldAmount(captured) { return Math.floor(captured.gold * 0.5) + 10000; }
  nationAttackRate(rng) {
    switch (this.difficulty()) {
      case Difficulty.EASY: return rng.int(65, 100);
      case Difficulty.MEDIUM: return rng.int(55, 70);
      case Difficulty.HARD: return rng.int(45, 60);
      default: return rng.int(30, 50);
    }
  }
}

// Research augments. `impl:true` = fully wired into the sim this build; others are staged (pickable, effect noted).
// `weight` biases the random 3-of pool. `tags` help the AI pick sensibly for its strategy.
const RESEARCH = [
  { id: 'war_economy', name: 'War Economy', impl: true, tags: ['econ', 'aggro'],
    desc: '+30% gold income while you are attacking an enemy nation.' },
  { id: 'mass_production', name: 'Mass Production', impl: true, tags: ['econ', 'build'],
    desc: 'All buildings cost 15% less gold.' },
  { id: 'defensive_position', name: 'Defensive Position', impl: true, tags: ['defense'],
    desc: 'Defense Posts fight back on their own, hurting nearby attackers by 15% of your troops. Click one to reinforce.' },
  { id: 'heavy_mech', name: 'Heavy Mech Doctrine', impl: true, tags: ['mech', 'defense'],
    desc: 'Your Mechs are slower but far more durable (2.2× HP).' },
  { id: 'assault_mech', name: 'Assault Mech Doctrine', impl: true, tags: ['mech', 'aggro'],
    desc: 'Your Mechs tear through defended and walled territory 3× faster.' },
  { id: 'mech_production', name: 'Mech Production', impl: true, tags: ['mech', 'econ'],
    desc: 'Mechs cost 40% less, so you can field more of them.' },
  { id: 'mech_weapons', name: 'Mech Weapons Systems', impl: true, tags: ['mech', 'aggro'],
    desc: 'Mechs deal 60% more damage to enemy troops.' },
  { id: 'longrange_mech', name: 'Long-Range Mech Systems', impl: true, tags: ['mech'],
    desc: 'Mechs gain a long strike range and can hit land from farther away.' },
  { id: 'dday', name: 'D-Day', impl: true, tags: ['navy', 'aggro'],
    desc: 'Boat invasions land with +15% troops, and can carry more.' },
  { id: 'coastal_bombardment', name: 'Coastal Bombardment', impl: false, tags: ['navy', 'aggro'],
    desc: 'Warships stay at sea and bombard coastal enemy land within range; only enemy warships can stop them. (Staged — needs warship art)' },
  // Staged (pickable; deep implementation on the roadmap — need art/VFX):
  { id: 'submarine_warfare', name: 'Submarine Warfare', impl: false, tags: ['navy'],
    desc: 'Unlock invisible Submarines that fire volleys of short-range missiles and slip past SAMs. (Staged)' },
  { id: 'strategic_bombers', name: 'Strategic Bombers', impl: false, tags: ['air', 'aggro'],
    desc: 'An air force that bombs enemy Cities, Factories and Silos at range. (Staged)' },
];
const RESEARCH_BY_ID = Object.fromEntries(RESEARCH.map((r) => [r.id, r]));

module.exports = {
  TerrainType, PlayerType, UnitType, POPULATION_TYPES, NukeType, Difficulty, TICKS_PER_SECOND, DEFAULT_SETTINGS, sanitizeSettings,
  Config, within, HUMAN_COLORS, NATION_COLORS, BOT_COLORS, RESEARCH, RESEARCH_BY_ID,
};
