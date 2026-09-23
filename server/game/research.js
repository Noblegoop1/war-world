'use strict';
// Research doctrines. Every entry is fully wired into the simulation (see the `effects` comments and the
// helpers below, which the other systems query). `ai` hints tell the nation AI how to change behaviour.

const RESEARCH = [
  // ---- economy / logistics ----
  { id: 'war_economy', name: 'War Economy', tags: ['econ', 'aggro'], ai: { aggression: 1.4 },
    desc: '+30% gold income while you are attacking an enemy nation. (Your nation fights harder when it fights more.)' },
  { id: 'mass_production', name: 'Mass Production', tags: ['econ', 'build'], ai: { build: 1.3 },
    desc: 'All buildings and walls cost 15% less gold.' },
  { id: 'industrial_mobilization', name: 'Industrial Mobilization', tags: ['econ'], ai: { build: 1.2 },
    desc: 'Cities are retooled for war: +25% gold income, but your max troops are 10% lower.' },
  { id: 'military_rail', name: 'Military Rail', tags: ['econ', 'defense'], ai: { factories: 2 },
    desc: 'Rail moves armies: +20% troop growth while you own 2+ factories connected by rail. Trains also carry 2x gold.' },
  { id: 'strategic_logistics', name: 'Strategic Logistics', tags: ['aggro'], ai: { aggression: 1.2 },
    desc: 'Your attacks advance 25% faster and boats are 50% faster.' },
  { id: 'military_industrial', name: 'Military Industrial Complex', tags: ['mech', 'econ'], ai: { factories: 2, mechs: 1 },
    desc: 'Factories spawn trains twice as often and Mechs cost 25% less.' },
  // ---- defense ----
  { id: 'defensive_position', name: 'Defensive Position', tags: ['defense'], ai: { posts: 2 },
    desc: 'Defense Posts fire on nearby attackers with 15% of your troops as firepower. Click a post to garrison 10% of your troops into it for more.' },
  { id: 'coastal_defense', name: 'Coastal Defense Network', tags: ['defense', 'navy'], ai: { posts: 1.5 },
    desc: 'Defense Posts become coastal batteries: they shell enemy ships at double range and fire rate, and boats landing near them lose 30% of their troops.' },
  { id: 'hardened_infra', name: 'Hardened Infrastructure', tags: ['defense'], ai: {},
    desc: 'Structures outside a nuke\'s core survive the blast, and walls take half damage from everything.' },
  { id: 'military_district', name: 'Military Districts', tags: ['defense', 'aggro'], ai: { aggression: 1.15 },
    desc: 'Cities give +375K max troops instead of +250K, but your gold income is 30% lower.' },
  { id: 'fighter_networks', name: 'Fighter Networks', tags: ['air', 'defense'], ai: {},
    desc: 'Enemy bombers over your territory are shot down 60% of the time, and your SAMs get +30 range.' },
  // ---- mech doctrines ----
  { id: 'heavy_mech', name: 'Heavy Mech Doctrine', tags: ['mech', 'defense'], ai: { mechs: 1 },
    desc: 'Your Mechs have 2.5x HP but move 40% slower.' },
  { id: 'assault_mech', name: 'Assault Mech Doctrine', tags: ['mech', 'aggro'], ai: { mechs: 1, aggression: 1.2 },
    desc: 'Mech stomps clear a wider area (radius +2) and break walls and defense posts 3x faster.' },
  { id: 'mech_production', name: 'Mech Production', tags: ['mech', 'econ'], ai: { mechs: 2 },
    desc: 'Mechs cost 40% less and you may field one extra.' },
  { id: 'mech_weapons', name: 'Mech Weapons Systems', tags: ['mech', 'aggro'], ai: { mechs: 1 },
    desc: 'Mech cannon shells deal 60% more damage and can one-shot structures.' },
  { id: 'longrange_mech', name: 'Long-Range Mech Systems', tags: ['mech'], ai: { mechs: 1 },
    desc: 'Mech cannon range +10 tiles.' },
  { id: 'rapidfire_mech', name: 'Rapid-Fire Mech Systems', tags: ['mech', 'aggro'], ai: { mechs: 1 },
    desc: 'Mech cannon and stomp cooldowns are 40% shorter.' },
  { id: 'amphibious_mech', name: 'Amphibious Mechs', tags: ['mech', 'navy'], ai: { mechs: 1 },
    desc: 'Your Mechs can wade across water (slowly) and fight ships.' },
  // ---- navy ----
  { id: 'coastal_bombardment', name: 'Coastal Bombardment', tags: ['navy', 'aggro'], ai: { warships: 2, aggression: 1.1 },
    desc: 'Warships shell enemy coastal land within 40 tiles, turning it neutral and killing troops. Warships cost +300K per 10 owned.' },
  { id: 'submarine_warfare', name: 'Submarine Warfare', tags: ['navy'], ai: { subs: 1 },
    desc: 'Unlock Submarines (2.5x a warship): invisible unless within 10 tiles of an enemy warship, they fire volleys of 3 missiles every 90s that each wreck one structure and slip past SAMs.' },
  { id: 'nuclear_subs', name: 'Nuclear Submarines', tags: ['navy', 'nuke'], ai: { subs: 1, nukes: 1 },
    desc: 'Your Submarines also carry atom bombs (normal cost) launched from anywhere at sea.' },
  { id: 'amphibious_warfare', name: 'Amphibious Warfare', tags: ['navy', 'aggro'], ai: { boats: 2 },
    desc: 'Transports carry 50% more troops, sail 50% faster, and you may have 5 boats at once.' },
  { id: 'naval_mines', name: 'Naval Mines', tags: ['navy', 'defense'], ai: { mines: 1 },
    desc: 'Lay Mines (50K) on the sea. Any enemy ship or boat passing within 2 tiles is destroyed.' },
  { id: 'naval_base', name: 'Naval Bases', tags: ['navy', 'econ'], ai: { warships: 1 },
    desc: 'Ports become Naval Bases: +25% trade-ship gold, warships repair 5x faster near them, +2 warship cap.' },
  { id: 'dday', name: 'D-Day', tags: ['navy', 'aggro'], ai: { boats: 1.5 },
    desc: 'Boat invasions hit the beach with +15% troops and take the landing tile instantly with no losses.' },
  // ---- air ----
  { id: 'strategic_bombers', name: 'Strategic Bombers', tags: ['air', 'aggro'], ai: { bombers: 1 },
    desc: 'Order Bomber strikes (300K) from any Missile Silo: a bomber flies up to 250 tiles and destroys one enemy structure. SAMs can\'t touch it; Fighter Networks can.' },
  { id: 'close_air_support', name: 'Close Air Support', tags: ['air', 'aggro'], ai: { aggression: 1.25 },
    desc: 'Your ground attacks on players lose 25% fewer troops.' },
  // ---- strategic weapons ----
  { id: 'tactical_nukes', name: 'Tactical Nuclear Weapons', tags: ['nuke', 'aggro'], ai: { nukes: 2 },
    desc: 'Atom bombs cost 400K instead of 750K, silos reload twice as fast, but atom blasts are smaller (8/16).' },
  { id: 'mirv', name: 'MIRV Engineering', tags: ['nuke'], ai: { nukes: 1 },
    desc: 'Hydrogen bombs split into 5 atom-sized warheads scattered up to 45 tiles around the target.' },
  { id: 'field_engineering', name: 'Field Engineering', tags: ['defense', 'mech'], ai: { defensive: 1, mechs: 1 },
    desc: 'Unlocks the Repair Yard: it heals your Mechs and rebuilds damaged walls in range. Artillery Batteries also get +15 range, reload 30% faster and hit 50% harder.' },
  { id: 'megacity', name: 'Megacity Planning', tags: ['econ'], ai: { build: 1.1 }, tier: 3,
    desc: 'Cities can reach level 4 instead of 3, and a level-4 City is worth far more than the step before it.' },
  { id: 'heavy_industry', name: 'Heavy Industry', tags: ['econ'], ai: { factories: 3 }, tier: 3,
    desc: 'Factories can reach level 4. Every level above 2 also makes that factory\u2019s trains pay 35% more.' },
  { id: 'strategic_airlift', name: 'Strategic Airlift', tags: ['air'], ai: { airships: 2 }, tier: 3,
    desc: 'Airships carry 10% of your troops instead of 5%, fly 50% faster and reach 120 tiles further.' },
  { id: 'airbase_network', name: 'Airbase Network', tags: ['air'], ai: { airships: 1 }, tier: 2,
    desc: 'A fourth airship, 30% cheaper airships, and SAM Launchers may finally sit next to your Airport.' },
  { id: 'airborne_doctrine', name: 'Airborne Doctrine', tags: ['air', 'aggro'], ai: { airships: 1, aggression: 1.1 }, tier: 2,
    desc: 'Troops dropped by airship land 35% stronger.' },
  { id: 'interceptor_screen', name: 'Interceptor Screen', tags: ['defense', 'air'], ai: { defensive: 1 }, tier: 2,
    desc: 'Fighters scramble from your Cities, SAMs and Airport: enemy airships passing within 60 tiles have a 45% chance of being shot down. The only answer to an airlift.' },
  { id: 'nuclear_deterrence', name: 'Nuclear Deterrence', tags: ['nuke', 'defense'], ai: {},
    desc: 'If someone nukes you while you have a ready silo and 750K gold, an atom bomb automatically answers at their nearest silo (or city).' },
];
const BY_ID = Object.fromEntries(RESEARCH.map((r) => [r.id, r]));

const has = (p, id) => !!(p && p.researches && p.researches.has(id));

// ---- multipliers used across the sim ----
const effects = {
  buildDiscount: (p) => (has(p, 'mass_production') ? 0.85 : 1),
  goldMultiplier: (p, attacking) => {
    let m = 1;
    if (has(p, 'war_economy') && attacking) m *= 1.3;
    if (has(p, 'industrial_mobilization')) m *= 1.25;
    if (has(p, 'military_district')) m *= 0.7;
    return m;
  },
  maxTroopsMultiplier: (p) => (has(p, 'industrial_mobilization') ? 0.9 : 1),
  cityTroopBonus: (p) => (has(p, 'military_district') ? 375000 : 250000),
  troopGrowthMultiplier: (p, connectedFactories) => (has(p, 'military_rail') && connectedFactories >= 2 ? 1.2 : 1),
  attackSpeedMultiplier: (p) => (has(p, 'strategic_logistics') ? 1.25 : 1),
  attackerLossMultiplier: (p, vsPlayer) => (vsPlayer && has(p, 'close_air_support') ? 0.75 : 1),
  boatCapacity: (p) => (has(p, 'amphibious_warfare') ? 1.5 : 1),
  boatSpeed: (p) => (has(p, 'amphibious_warfare') ? 1.5 : 1) * (has(p, 'strategic_logistics') ? 1.5 : 1),
  boatMax: (p) => (has(p, 'amphibious_warfare') ? 5 : 3),
  landingBonus: (p) => (has(p, 'dday') ? 1.15 : 1),
  tradeGoldMultiplier: (p) => (has(p, 'naval_base') ? 1.25 : 1),
  trainGoldMultiplier: (p) => (has(p, 'military_rail') ? 2 : 1),
  trainRateMultiplier: (p) => (has(p, 'military_industrial') ? 2 : 1),
  warshipCap: (p) => 3 + (has(p, 'naval_base') ? 2 : 0),
  warshipRepairMultiplier: (p) => (has(p, 'naval_base') ? 5 : 1),
  atomCost: (p) => (has(p, 'tactical_nukes') ? 400000 : 750000),
  atomMagnitude: (p) => (has(p, 'tactical_nukes') ? { inner: 8, outer: 16 } : { inner: 12, outer: 30 }),
  siloCooldownMultiplier: (p) => (has(p, 'tactical_nukes') ? 0.5 : 1),
  samRangeBonus: (p) => (has(p, 'fighter_networks') ? 30 : 0),
  wallDamageMultiplier: (p) => (has(p, 'hardened_infra') ? 0.5 : 1),
  // Fraction of a warship's health a defense post shell takes off. Deliberately tiny: posts drive ships
  // off over time instead of deleting them. Coastal Defense Network is what makes them actually dangerous.
  // One doctrine may raise ONE building type's ceiling from 3 to 4, and that last level is a big jump.
  // ---- air power ----
  airshipCapBonus: (p) => (has(p, 'airbase_network') ? 1 : 0),
  airshipCostMultiplier: (p) => (has(p, 'airbase_network') ? 0.7 : 1),
  airshipCapacityMultiplier: (p) => (has(p, 'strategic_airlift') ? 2 : 1),
  airshipSpeedMultiplier: (p) => (has(p, 'strategic_airlift') ? 1.5 : 1),
  airshipRangeBonus: (p) => (has(p, 'strategic_airlift') ? 120 : 0),
  airdropBonus: (p) => (has(p, 'airborne_doctrine') ? 1.35 : 1),
  samNearAirport: (p) => has(p, 'airbase_network'),
  interceptsAirships: (p) => has(p, 'interceptor_screen'),
  interceptorRangeBonus: (p) => (has(p, 'fighter_networks') ? 40 : 0),
  interceptorChanceMultiplier: (p) => (has(p, 'fighter_networks') ? 1.4 : 1),
  maxLevelBonus: (p, type) => ((type === 'city' && has(p, 'megacity')) || (type === 'factory' && has(p, 'heavy_industry')) ? 1 : 0),
  artilleryRangeBonus: (p) => (has(p, 'field_engineering') ? 15 : 0),
  artilleryReloadMultiplier: (p) => (has(p, 'field_engineering') ? 0.7 : 1),
  artilleryDamageMultiplier: (p) => (has(p, 'field_engineering') ? 1.5 : 1),
  defensePostShipDamagePct: (p) => (has(p, 'coastal_defense') ? 0.015 : 0.004),
  defensePostShipRange: (p) => (has(p, 'coastal_defense') ? 150 : 75),
  defensePostShellRate: (p) => (has(p, 'coastal_defense') ? 50 : 100),
  // mechs
  mechHpMultiplier: (p) => (has(p, 'heavy_mech') ? 2.5 : 1),
  mechSpeedMultiplier: (p) => (has(p, 'heavy_mech') ? 0.6 : 1),
  mechRangeBonus: (p) => (has(p, 'longrange_mech') ? 10 : 0),
  mechDamageMultiplier: (p) => (has(p, 'mech_weapons') ? 1.6 : 1),
  mechCooldownMultiplier: (p) => (has(p, 'rapidfire_mech') ? 0.6 : 1),
  mechStompBonus: (p) => (has(p, 'assault_mech') ? 2 : 0),
  mechBreachMultiplier: (p) => (has(p, 'assault_mech') ? 3 : 1),
  mechCostMultiplier: (p) => (has(p, 'mech_production') ? 0.6 : 1) * (has(p, 'military_industrial') ? 0.75 : 1),
  mechCap: (p) => 3 + (has(p, 'mech_production') ? 1 : 0),
  mechAmphibious: (p) => has(p, 'amphibious_mech'),
};

module.exports = { RESEARCH, RESEARCH_BY_ID: BY_ID, has, effects };
