'use strict';
// Game tunables. Formulas and numbers follow OpenFront.io's balance (troop growth, attack cost/speed,
// unit prices, trade income, AI difficulty scaling) so the game plays the same; the code is original.

const TerrainType = { WATER: 0, PLAINS: 1, HIGHLAND: 2, MOUNTAIN: 3 };
const PlayerType = { HUMAN: 'human', NATION: 'nation', BOT: 'bot' };
const UnitType = { CITY: 'city', PORT: 'port', DEFENSE_POST: 'defense', SILO: 'silo', SAM: 'sam', LAB: 'lab', FACTORY: 'factory', WALL: 'wall', MECH: 'mech', WARSHIP: 'warship', SUBMARINE: 'submarine', MINE: 'mine' };
// Fixed structures (live on a tile). Mobile units (mech/warship/submarine) are handled by their own systems.
const STRUCTURE_TYPES = ['city', 'port', 'defense', 'silo', 'sam', 'lab', 'factory', 'mine'];
const { effects: R } = require('./research');
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
  spawnPhaseSeconds: 10,
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
  samRange(player) { return 70 + R.samRangeBonus(player); }
  samCooldownTicks() { return 90; }
  siloCooldownTicks(player) { return Math.floor(90 * R.siloCooldownMultiplier(player)); }
  cityTroopIncrease(player) { return R.cityTroopBonus(player); }
  boatMaxNumber(player) { return this.settings.disableBoats ? 0 : R.boatMax(player); }
  boatSpeed(player) { return 2 * R.boatSpeed(player); } // tiles per tick along the path
  tradeShipSpeed() { return 1.2; }
  trainSpeed() { return 2.5; }
  nukeSpeed() { return 6; } // tiles per tick along the arc
  nukeMagnitude(type, player) { return type === NukeType.HYDROGEN ? { inner: 80, outer: 100 } : R.atomMagnitude(player); }
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
  trainStationMinRange() { return 15; }
  trainStationMaxRange() { return 110; }
  railroadMaxSize() { return Math.floor(110 * 1.4142); }
  trainSpawnRate(numFactories) { return (numFactories + 10) * 15; } // expected ticks between trains per factory level
  trainGold(rel, stopsVisited) {
    const base = rel === 'ally' ? 35000 : rel === 'self' ? 10000 : 25000;
    return Math.max(5000, base - Math.max(0, stopsVisited - 9) * 5000);
  }
  bomberCost() { return 300000; }
  bomberRange() { return 250; }
  bomberSpeed() { return 4; }
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
  buildDiscount(player) { return R.buildDiscount(player); }
  // numOwned: count of the type owned (ports and factories share a count, as in OpenFront).
  unitCost(type, numOwned, player) {
    if (player && player.type === PlayerType.HUMAN && this.infiniteGold()) return 0;
    const d = this.buildDiscount(player);
    switch (type) {
      case UnitType.CITY: return Math.min(1000000, Math.pow(2, numOwned) * 125000) * d;
      case UnitType.PORT:
      case UnitType.FACTORY: return Math.min(1000000, Math.pow(2, numOwned) * 125000) * d;
      case UnitType.DEFENSE_POST: return Math.min(250000, (numOwned + 1) * 50000) * d;
      case UnitType.SILO: return 1000000 * d;
      case UnitType.SAM: return Math.min(3000000, (numOwned + 1) * 1500000) * d;
      case UnitType.LAB: return 1000000 * d;
      case UnitType.MINE: return 50000 * d;
      case UnitType.WARSHIP: {
        let c = Math.min(1000000, (numOwned + 1) * 250000);
        if (player && player.researches && player.researches.has('coastal_bombardment')) c += 300000 * Math.floor(numOwned / 10);
        return c * d;
      }
      case UnitType.SUBMARINE: return Math.min(2500000, (numOwned + 1) * 625000) * d;
      // Mechs are national-scale assets: brutally expensive, escalating hard per mech owned.
      case UnitType.MECH: return (2000000 + numOwned * 2500000) * R.mechCostMultiplier(player) * d;
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
  maxResearchesPerPlayer() { return 2; }
  populationRequiredForLab() { return 3; }
  structureMinGap() { return 3; }
  labMinGapFromPopulation() { return 6; }

  // ---- Mechs: super-tanky walking artillery, built at level-2+ factories ----
  mechFactoryLevelRequired() { return 2; }
  mechBaseHp(player, factoryLevel = 2) { return Math.floor(40000 * (1 + 0.5 * (factoryLevel - 2)) * R.mechHpMultiplier(player)); }
  mechSpeed(player, onWater = false) { return 0.35 * (onWater ? 0.6 : 1) * R.mechSpeedMultiplier(player); }
  mechRange(player, factoryLevel = 2) { return 12 + 3 * (factoryLevel - 2) + R.mechRangeBonus(player); }
  mechCannonCooldown(player) { return Math.floor(60 * R.mechCooldownMultiplier(player)); }
  mechStompCooldown(player) { return Math.floor(20 * R.mechCooldownMultiplier(player)); }
  mechShellDamage(player, factoryLevel = 2) { return Math.floor(2500 * (1 + 0.3 * (factoryLevel - 2)) * R.mechDamageMultiplier(player)); }
  mechShellBlastRadius() { return 2.5; }
  mechStompRadius(player) { return 3 + R.mechStompBonus(player); }
  mechTroopKillPerShell(player, factoryLevel = 2) { return Math.floor(6000 * (1 + 0.3 * (factoryLevel - 2)) * R.mechDamageMultiplier(player)); }
  mechPatrolRadius() { return 6; }
  nukeCost(type, player) {
    if (player && player.type === PlayerType.HUMAN && this.infiniteGold()) return 0;
    return type === NukeType.HYDROGEN ? 5000000 : R.atomCost(player);
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
  goldAdditionRate(player, attacking = false) {
    return (player.type === PlayerType.BOT ? 50 : 100) * R.goldMultiplier(player, attacking);
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
      attackerTroopLoss: attackerTroopLoss * (input.attackerLossMult || 1),
      defenderTroopLoss,
      tickFraction: (speedCost * tileCost * largeAttackerSpeedBonus * largeDefenderBonus * traitorCostMod) / Math.max(1, input.borderSize) / (input.attackSpeedMult || 1),
    };
  }
  // OpenFront: conquering an AI takes its whole treasury, a human half of it. We add a land bounty
  // so swallowing a big nation pays a good chunk.
  conquerGoldAmount(captured) {
    const treasury = captured.type === PlayerType.HUMAN ? Math.floor(captured.gold * 0.5) : Math.floor(captured.gold);
    return treasury + 10000 + captured.numTiles * 15;
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
  Config, within, HUMAN_COLORS, NATION_COLORS, BOT_COLORS, RESEARCH, RESEARCH_BY_ID,
};
