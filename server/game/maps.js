'use strict';
// Map catalog + loader. Maps use OpenFront's terrain format (CC BY-SA 4.0, see public/assets/LICENSE.txt):
// one byte per tile: bit7 = land, bit6 = shoreline, bit5 = ocean (water only), bits0-4 = magnitude
// (elevation for land, depth for water; land magnitude 31 = impassable).
const fs = require('fs');
const path = require('path');
const { Rng } = require('./rng');

const ASSET_COMMIT = '8a20597f6631e733f40e9a1dec2d2012cc916df4';
const RAW_BASE = `https://raw.githubusercontent.com/openfrontio/OpenFrontIO/${ASSET_COMMIT}/resources/maps`;
const BUNDLED_DIR = path.join(__dirname, '..', 'maps');
const CACHE_DIR = path.join(__dirname, '..', 'maps-cache');

const IS_LAND = 0x80, SHORELINE = 0x40, OCEAN = 0x20, MAG_MASK = 0x1f, IMPASSABLE = 31;

// Real maps (id = OpenFront folder name). The first five are bundled; the rest download on first use.
const MAP_CATALOG = [
  { id: 'world', name: 'World' },
  { id: 'europe', name: 'Europe' },
  { id: 'asia', name: 'Asia' },
  { id: 'oceania', name: 'Oceania' },
  { id: 'pangaea', name: 'Pangaea' },
  { id: 'giantworldmap', name: 'Giant World Map' },
  { id: 'africa', name: 'Africa' },
  { id: 'northamerica', name: 'North America' },
  { id: 'southamerica', name: 'South America' },
  { id: 'unitedstates', name: 'United States' },
  { id: 'mena', name: 'Middle East & North Africa' },
  { id: 'middleeast', name: 'Middle East' },
  { id: 'eastasia', name: 'East Asia' },
  { id: 'southeastasia', name: 'Southeast Asia' },
  { id: 'indiansubcontinent', name: 'Indian Subcontinent' },
  { id: 'china', name: 'China' },
  { id: 'japan', name: 'Japan' },
  { id: 'korea', name: 'Korea' },
  { id: 'russia', name: 'Russia' },
  { id: 'australia', name: 'Australia' },
  { id: 'newzealand', name: 'New Zealand' },
  { id: 'britannia', name: 'Britannia' },
  { id: 'scandinavia', name: 'Scandinavia' },
  { id: 'baltics', name: 'Baltics' },
  { id: 'germany', name: 'Germany' },
  { id: 'france', name: 'France' },
  { id: 'italia', name: 'Italia' },
  { id: 'balkans', name: 'Balkans' },
  { id: 'blacksea', name: 'Black Sea' },
  { id: 'iceland', name: 'Iceland' },
  { id: 'caribbean', name: 'Caribbean' },
  { id: 'greatlakes', name: 'Great Lakes' },
  { id: 'gulfofmexico', name: 'Gulf of Mexico' },
  { id: 'antarctica', name: 'Antarctica' },
  { id: 'arctic', name: 'Arctic' },
  { id: 'alps', name: 'Alps' },
  { id: 'mars', name: 'Mars' },
  { id: 'luna', name: 'Luna' },
  { id: 'fourislands', name: 'Four Islands' },
  { id: 'betweentwoseas', name: 'Between Two Seas' },
  { id: 'gen-continents', name: 'Random: Continents', generated: 'continents' },
  { id: 'gen-islands', name: 'Random: Islands', generated: 'islands' },
  { id: 'gen-pangaea', name: 'Random: Pangaea', generated: 'pangaea' },
];

function catalog() { return MAP_CATALOG.map((m) => ({ id: m.id, name: m.name })); }
function isValidMapId(id) { return MAP_CATALOG.some((m) => m.id === id); }

async function fetchToFile(url, file) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  return buf;
}

async function mapFile(id, name) {
  const bundled = path.join(BUNDLED_DIR, id, name);
  if (fs.existsSync(bundled)) return fs.readFileSync(bundled);
  const cached = path.join(CACHE_DIR, id, name);
  if (fs.existsSync(cached)) return fs.readFileSync(cached);
  console.log(`[maps] downloading ${id}/${name} ...`);
  return fetchToFile(`${RAW_BASE}/${id}/${name}`, cached);
}

/**
 * Load a map. `compact` uses the half-resolution version.
 * @returns {Promise<{id,name,width,height,terrain:Uint8Array,numLand:number,nations:Array<{name,flag,x,y}>,seed:number}>}
 */
async function loadMap(id, { compact = false, seed = 1, width, height } = {}) {
  const entry = MAP_CATALOG.find((m) => m.id === id) || MAP_CATALOG[0];
  if (entry.generated) {
    const w = width || (compact ? 1000 : 2000), h = height || (compact ? 500 : 1000);
    return generateMap(w, h, seed, entry.generated, entry);
  }
  const manifest = JSON.parse((await mapFile(entry.id, 'manifest.json')).toString('utf8'));
  const meta = compact ? manifest.map4x : manifest.map;
  const bin = await mapFile(entry.id, compact ? 'map4x.bin' : 'map.bin');
  if (bin.length !== meta.width * meta.height) throw new Error(`map ${id}: bad size ${bin.length} for ${meta.width}x${meta.height}`);
  const terrain = new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength);
  const scale = compact ? 0.5 : 1;
  const nations = [...(manifest.nations || []), ...(manifest.additionalNations || [])]
    .filter((n) => n.coordinates)
    .map((n) => ({ name: n.name, flag: n.flag || '', x: Math.floor(n.coordinates[0] * scale), y: Math.floor(n.coordinates[1] * scale) }));
  return { id: entry.id, name: entry.name, width: meta.width, height: meta.height, terrain, numLand: countLand(terrain), nations, seed };
}

function countLand(terrain) {
  let n = 0;
  for (let i = 0; i < terrain.length; i++) if ((terrain[i] & IS_LAND) && (terrain[i] & MAG_MASK) !== IMPASSABLE) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Procedural maps → OpenFront byte format
function makeValueNoise(rng, gridW, gridH) {
  const vals = new Float32Array(gridW * gridH);
  for (let i = 0; i < vals.length; i++) vals[i] = rng.next();
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const tx = smooth(x - x0), ty = smooth(y - y0);
    const gx0 = ((x0 % gridW) + gridW) % gridW, gx1 = (gx0 + 1) % gridW;
    const gy0 = ((y0 % gridH) + gridH) % gridH, gy1 = (gy0 + 1) % gridH;
    const a = vals[gy0 * gridW + gx0], b = vals[gy0 * gridW + gx1];
    const c = vals[gy1 * gridW + gx0], d = vals[gy1 * gridW + gx1];
    return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
  };
}
function fbm(rng, octaves, baseFreq, w, h) {
  const layers = [];
  for (let o = 0; o < octaves; o++) {
    const freq = baseFreq * Math.pow(2, o);
    layers.push({ noise: makeValueNoise(rng, Math.ceil(w * freq) + 2, Math.ceil(h * freq) + 2), freq, amp: Math.pow(0.5, o) });
  }
  const total = layers.reduce((s, l) => s + l.amp, 0);
  return (x, y) => { let v = 0; for (const l of layers) v += l.noise(x * l.freq, y * l.freq) * l.amp; return v / total; };
}

function generateMap(width, height, seed, type, entry) {
  const rng = new Rng(seed);
  const elev = fbm(rng, 7, 1 / 160, width, height);
  const detail = fbm(rng, 3, 1 / 24, width, height);
  const land = new Uint8Array(width * height);
  const height01 = new Float32Array(width * height);
  let seaLevel = 0.5;
  if (type === 'islands') seaLevel = 0.56;
  if (type === 'pangaea') seaLevel = 0.44;
  const cx = width / 2, cy = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let e = elev(x, y);
      const ex = Math.min(x, width - 1 - x) / (width * 0.1), ey = Math.min(y, height - 1 - y) / (height * 0.1);
      e *= 0.25 + 0.75 * Math.min(1, ex, ey);
      if (type === 'pangaea') { const dx = (x - cx) / (width / 2), dy = (y - cy) / (height / 2); e += 0.18 * (1 - Math.sqrt(dx * dx + dy * dy)) - 0.05; }
      if (type === 'islands') e += (detail(x, y) - 0.5) * 0.15;
      const i = y * width + x;
      if (e > seaLevel) { land[i] = 1; height01[i] = Math.max(0, Math.min(1, (e - seaLevel) / (1 - seaLevel) + (detail(x, y) - 0.5) * 0.25)); }
    }
  }
  removeSmallRegions(land, width, height, 1, 60, 0);
  removeSmallRegions(land, width, height, 0, 12, 1);
  const terrain = toOpenFrontBytes(land, height01, width, height);
  const numLand = countLand(terrain);
  return { id: entry.id, name: entry.name, width, height, terrain, numLand, nations: [], seed };
}

function floodRegions(mask, width, height, value) {
  const seen = new Uint8Array(mask.length);
  const regions = [];
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (seen[start] || mask[start] !== value) continue;
    const region = [];
    stack.push(start); seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      region.push(i);
      const x = i % width, y = (i / width) | 0;
      if (x > 0 && !seen[i - 1] && mask[i - 1] === value) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < width - 1 && !seen[i + 1] && mask[i + 1] === value) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !seen[i - width] && mask[i - width] === value) { seen[i - width] = 1; stack.push(i - width); }
      if (y < height - 1 && !seen[i + width] && mask[i + width] === value) { seen[i + width] = 1; stack.push(i + width); }
    }
    regions.push(region);
  }
  return regions;
}
function removeSmallRegions(mask, width, height, value, minSize, replaceWith) {
  for (const r of floodRegions(mask, width, height, value)) if (r.length < minSize) for (const i of r) mask[i] = replaceWith;
}

// Build terrain bytes: shoreline bits, ocean bit (largest water body), water depth, land elevation bands.
function toOpenFrontBytes(land, height01, width, height) {
  const n = width * height;
  const terrain = new Uint8Array(n);
  // ocean = biggest connected water region
  const waterRegions = floodRegions(land, width, height, 0);
  let biggest = null;
  for (const r of waterRegions) if (!biggest || r.length > biggest.length) biggest = r;
  const ocean = new Uint8Array(n);
  if (biggest) for (const i of biggest) ocean[i] = 1;
  // depth: BFS distance from land for water tiles
  const depth = new Int32Array(n).fill(-1);
  let frontier = [];
  for (let i = 0; i < n; i++) if (land[i]) { depth[i] = 0; frontier.push(i); }
  let d = 0;
  while (frontier.length && d < 12) {
    d++;
    const next = [];
    for (const i of frontier) {
      const x = i % width, y = (i / width) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1];
      for (const j of nb) if (j >= 0 && depth[j] === -1) { depth[j] = d; next.push(j); }
    }
    frontier = next;
  }
  for (let i = 0; i < n; i++) {
    const x = i % width, y = (i / width) | 0;
    const nbs = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1];
    if (land[i]) {
      let shore = false;
      for (const j of nbs) if (j >= 0 && !land[j]) shore = true;
      const h = height01[i];
      let mag;
      if (h < 0.35) mag = Math.floor((h / 0.35) * 9);
      else if (h < 0.6) mag = 10 + Math.floor(((h - 0.35) / 0.25) * 9);
      else mag = 20 + Math.min(10, Math.floor(((h - 0.6) / 0.4) * 10));
      terrain[i] = IS_LAND | (shore ? SHORELINE : 0) | mag;
    } else {
      let shore = false;
      for (const j of nbs) if (j >= 0 && land[j]) shore = true;
      const dd = depth[i] < 0 ? 12 : depth[i];
      terrain[i] = (ocean[i] ? OCEAN : 0) | (shore ? SHORELINE : 0) | Math.min(10, Math.max(0, dd - 1));
    }
  }
  return terrain;
}

module.exports = { MAP_CATALOG, catalog, isValidMapId, loadMap, IS_LAND, SHORELINE, OCEAN, MAG_MASK, IMPASSABLE, ASSET_COMMIT };
