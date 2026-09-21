'use strict';
// Game tunables. The formulas here mirror the balance of OpenFront.io
// (troop growth, attack costs, unit prices, AI difficulty scaling) so the game
// "feels" the same, re-implemented from scratch for this project.

const TerrainType = { WATER: 0, PLAINS: 1, HIGHLAND: 2, MOUNTAIN: 3 };
const PlayerType = { HUMAN: 'human', NATION: 'nation', BOT: 'bot' };
const UnitType = { CITY: 'city', PORT: 'port', DEFENSE_POST: 'defense', SILO: 'silo', SAM: 'sam' };
const NukeType = { ATOM: 'atom', HYDROGEN: 'hydrogen' };
const Difficulty = { EASY: 'easy', MEDIUM: 'medium', HARD: 'hard', IMPOSSIBLE: 'impossible' };

const TICKS_PER_SECOND = 10;

// Tile counts are close to OpenFront's so the per-tile balance carries over.
const MAP_SIZES = {
  small: [500, 310],
  medium: [800, 500],
  large: [1100, 690],
  huge: [1500, 940],
};

const DEFAULT_SETTINGS = {
  name: 'New Game',
  public: false,
  maxHumans: 8,
  mapSize: 'medium',
  mapType: 'continents', // continents | islands | pangaea
  seed: 0, // 0 = random each game
  nations: 6, // smart AI players
  bots: 20, // small dumb tribes
  difficulty: Difficulty.MEDIUM,
  spawnPhaseSeconds: 30,
  gameSpeed: 1, // 0.5 .. 3 (sim ticks per real tick)
  disableNukes: false,
  disableBoats: false,
  infiniteGold: false,
  infiniteTroops: false,
  instantBuild: false,
  startingGold: 0,
  percentToWin: 80,
};

function sanitizeSettings(input) {
  const s = { ...DEFAULT_SETTINGS };
  if (!input || typeof input !== 'object') return s;
  const num = (v, lo, hi, def) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  s.name = String(input.name ?? s.name).slice(0, 32) || 'New Game';
  s.public = !!input.public;
  s.maxHumans = Math.round(num(input.maxHumans, 1, 32, s.maxHumans));
  s.mapSize = MAP_SIZES[input.mapSize] ? input.mapSize : s.mapSize;
  s.mapType = ['continents', 'islands', 'pangaea'].includes(input.mapType) ? input.mapType : s.mapType;
  s.seed = Math.round(num(input.seed, 0, 2147483647, 0));
  s.nations = Math.round(num(input.nations, 0, 40, s.nations));
  s.bots = Math.round(num(input.bots, 0, 200, s.bots));
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

// ---- helpers -------------------------------------------------------------
const within = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
const sigmoid = (x, k, mid) => 1 / (1 + Math.exp(-k * (x - mid)));

// Attack tunables ------------------------------------------------------------
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
    case TerrainType.PLAINS: return { mag: 80, tileCost: 16.5 };
    case TerrainType.HIGHLAND: return { mag: 100, tileCost: 20 };
    case TerrainType.MOUNTAIN: return { mag: 120, tileCost: 25 };
    default: return { mag: 80, tileCost: 16.5 };
  }
}

class Config {
  constructor(settings) {
    this.settings = settings;
  }

  difficulty() { return this.settings.difficulty; }
  infiniteGold() { return this.settings.infiniteGold; }
  infiniteTroops() { return this.settings.infiniteTroops; }
  instantBuild() { return this.settings.instantBuild; }

  numSpawnPhaseTicks() { return this.settings.spawnPhaseSeconds * TICKS_PER_SECOND; }
  spawnRadius() { return 4; }
  minDistanceBetweenPlayers() { return 20; }
  spawnImmunityTicks() { return 50; }
  percentageTilesOwnedToWin() { return this.settings.percentToWin; }

  // structures
  defensePostRange() { return 30; }
  defensePostDefenseBonus() { return 5; }
  defensePostSpeedBonus() { return 3; }
  samRange() { return 70; }
  samCooldownTicks() { return 90; }
  siloCooldownTicks() { return 90; }
  cityTroopIncrease() { return 250000; }
  portGoldPerTick() { return 120; }
  boatMaxNumber() { return this.settings.disableBoats ? 0 : 3; }
  boatSpeed() { return 2; } // tiles per tick
  nukeSpeed() { return 4; } // tiles per tick
  nukeMagnitude(type) {
    return type === NukeType.HYDROGEN ? { inner: 40, outer: 60 } : { inner: 10, outer: 25 };
  }
  traitorDurationTicks() { return 30 * TICKS_PER_SECOND; }
  traitorDefenseDebuff() { return 1.5; }
  traitorSpeedDebuff() { return 0.75; }
  falloutDefenseModifier(ratio) { return 5 - ratio * 2; }

  constructionTicks(type) {
    if (this.instantBuild()) return 0;
    switch (type) {
      case UnitType.CITY: return 20;
      case UnitType.PORT: return 50;
      case UnitType.DEFENSE_POST: return 50;
      case UnitType.SILO: return 100;
      case UnitType.SAM: return 300;
      default: return 0;
    }
  }

  unitCost(type, numOwned, player) {
    if (player && player.type === PlayerType.HUMAN && this.infiniteGold()) return 0;
    switch (type) {
      case UnitType.CITY: return Math.min(1000000, Math.pow(2, numOwned) * 125000);
      case UnitType.PORT: return Math.min(1000000, Math.pow(2, numOwned) * 125000);
      case UnitType.DEFENSE_POST: return Math.min(250000, (numOwned + 1) * 50000);
      case UnitType.SILO: return 1000000;
      case UnitType.SAM: return Math.min(3000000, (numOwned + 1) * 1500000);
      default: return 0;
    }
  }
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
    let max = 2 * (Math.pow(player.numTiles, 0.6) * 1000 + 50000) + player.cityLevels() * this.cityTroopIncrease();
    if (player.type === PlayerType.BOT) return max / 3;
    if (player.type === PlayerType.HUMAN) return max;
    switch (this.difficulty()) {
      case Difficulty.EASY: return max * 0.5;
      case Difficulty.MEDIUM: return max * 0.75;
      case Difficulty.HARD: return max;
      case Difficulty.IMPOSSIBLE: return max * 1.25;
    }
    return max;
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
    if (player.type === PlayerType.BOT) return 50;
    // flat base (OpenFront) + a little from land + trade income from ports
    const ports = player.unitLevels(UnitType.PORT);
    return 100 + player.numTiles * 0.004 + ports * this.portGoldPerTick();
  }

  attackAmount(attacker, ratio) {
    // Humans pick a ratio; AIs compute their own amount.
    const r = ratio ?? (attacker.type === PlayerType.BOT ? 1 / 20 : 1 / 5);
    return Math.floor(attacker.troops * r);
  }

  /**
   * Per-tile attack outcome. Pure function of the situation.
   * mag: how bloody the tile is. tileCost: how slow it is to take.
   */
  attackLogic(input) {
    const { attackTroops, attacker, defender } = input;
    let { mag, tileCost } = terrainAttackBase(input.terrain);

    if (defender !== null && input.defenderHasDefensePost) {
      mag *= this.defensePostDefenseBonus();
      tileCost *= this.defensePostSpeedBonus();
    }
    if (input.falloutRatio !== null) {
      const f = this.falloutDefenseModifier(input.falloutRatio);
      mag *= f;
      tileCost *= f;
    }

    if (defender === null) {
      const tickBudget = input.borderSize * 2;
      return {
        attackerTroopLoss: mag / (attacker.type === PlayerType.BOT ? 10 : 5),
        defenderTroopLoss: 0,
        tickFraction: within((TERRA_NULLIUS_COST_SCALE * tileCost) / attackTroops, TERRA_NULLIUS_MIN_COST, TERRA_NULLIUS_MAX_COST) / tickBudget,
      };
    }

    if (attacker.type !== PlayerType.BOT && defender.type === PlayerType.BOT) {
      mag *= BOT_DEFENDER_LOSS_MULT;
    }

    const largeAttackerBonus = largeTerritoryBonus(attacker.numTiles, LARGE_ATTACKER_DEPTH);
    const largeDefenderBonus = largeTerritoryBonus(defender.numTiles, LARGE_DEFENDER_DEPTH);
    const traitorLossMod = defender.isTraitor ? this.traitorDefenseDebuff() : 1;
    const traitorCostMod = defender.isTraitor ? this.traitorSpeedDebuff() : 1;

    const defenderTroopLoss = defender.troops / Math.max(1, defender.numTiles);
    const troopRatio = defender.troops / Math.max(1, attackTroops);
    const attackerTroopLoss =
      mag * traitorLossMod * within(troopRatio, 0.6, 2) *
      (ATTACKER_LOSS_BASE * largeAttackerBonus * largeDefenderBonus + ATTACKER_LOSS_PER_DENSITY * defenderTroopLoss);

    const speedCost = (within(troopRatio, 0.82, 7.5) * within(troopRatio / 20, 1, 50)) / SPEED_COST_DIVISOR;
    const largeAttackerSpeedBonus = largeTerritoryBonus(attacker.numTiles, LARGE_ATTACKER_SPEED_DEPTH);
    return {
      attackerTroopLoss,
      defenderTroopLoss,
      tickFraction: (speedCost * tileCost * largeAttackerSpeedBonus * largeDefenderBonus * traitorCostMod) / Math.max(1, input.borderSize),
    };
  }

  // Gold you get for fully conquering someone.
  conquerGoldAmount(captured) {
    return Math.floor(captured.gold * 0.5) + 10000;
  }

  // AI reaction speed in ticks
  nationAttackRate(rng) {
    switch (this.difficulty()) {
      case Difficulty.EASY: return rng.int(65, 100);
      case Difficulty.MEDIUM: return rng.int(55, 70);
      case Difficulty.HARD: return rng.int(45, 60);
      case Difficulty.IMPOSSIBLE: return rng.int(30, 50);
    }
    return 60;
  }
}

module.exports = {
  TerrainType, PlayerType, UnitType, NukeType, Difficulty,
  TICKS_PER_SECOND, MAP_SIZES, DEFAULT_SETTINGS, sanitizeSettings,
  Config, within,
};
