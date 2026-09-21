'use strict';
// Procedural map generation: fractal value-noise elevation → water/plains/highland/mountain.
const { Rng } = require('./rng');
const { TerrainType } = require('./config');

function makeValueNoise(rng, gridW, gridH) {
  const vals = new Float32Array(gridW * gridH);
  for (let i = 0; i < vals.length; i++) vals[i] = rng.next();
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    // x,y in grid units
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
  return (x, y) => {
    let v = 0;
    for (const l of layers) v += l.noise(x * l.freq, y * l.freq) * l.amp;
    return v / total;
  };
}

/**
 * @returns {{width:number,height:number,terrain:Uint8Array,numLand:number,seed:number}}
 */
function generateMap(width, height, seed, type) {
  const rng = new Rng(seed);
  const elev = fbm(rng, 6, 1 / 48, width, height);
  const detail = fbm(rng, 3, 1 / 10, width, height);
  const terrain = new Uint8Array(width * height);

  let seaLevel = 0.5;
  if (type === 'islands') seaLevel = 0.56;
  if (type === 'pangaea') seaLevel = 0.44;

  const cx = width / 2, cy = height / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let e = elev(x, y);
      // fade to ocean at the edges
      const ex = Math.min(x, width - 1 - x) / (width * 0.12);
      const ey = Math.min(y, height - 1 - y) / (height * 0.12);
      const edge = Math.min(1, ex, ey);
      e = e * (0.25 + 0.75 * edge);
      if (type === 'pangaea') {
        const dx = (x - cx) / (width / 2), dy = (y - cy) / (height / 2);
        const d = Math.sqrt(dx * dx + dy * dy);
        e += 0.18 * (1 - d) - 0.05;
      }
      if (type === 'islands') {
        e += (detail(x, y) - 0.5) * 0.15;
      }
      let t = TerrainType.WATER;
      if (e > seaLevel) {
        const h = (e - seaLevel) / (1 - seaLevel) + (detail(x, y) - 0.5) * 0.25;
        if (h > 0.55) t = TerrainType.MOUNTAIN;
        else if (h > 0.32) t = TerrainType.HIGHLAND;
        else t = TerrainType.PLAINS;
      }
      terrain[y * width + x] = t;
    }
  }

  removeSmallIslands(terrain, width, height, 25);
  fillSmallLakes(terrain, width, height, 6);

  let numLand = 0;
  for (let i = 0; i < terrain.length; i++) if (terrain[i] !== TerrainType.WATER) numLand++;
  return { width, height, terrain, numLand, seed, type };
}

function floodRegions(terrain, width, height, isMember) {
  const seen = new Uint8Array(terrain.length);
  const regions = [];
  const stack = [];
  for (let start = 0; start < terrain.length; start++) {
    if (seen[start] || !isMember(terrain[start])) continue;
    const region = [];
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const i = stack.pop();
      region.push(i);
      const x = i % width, y = (i / width) | 0;
      if (x > 0 && !seen[i - 1] && isMember(terrain[i - 1])) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < width - 1 && !seen[i + 1] && isMember(terrain[i + 1])) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !seen[i - width] && isMember(terrain[i - width])) { seen[i - width] = 1; stack.push(i - width); }
      if (y < height - 1 && !seen[i + width] && isMember(terrain[i + width])) { seen[i + width] = 1; stack.push(i + width); }
    }
    regions.push(region);
  }
  return regions;
}

function removeSmallIslands(terrain, width, height, minSize) {
  for (const r of floodRegions(terrain, width, height, (t) => t !== TerrainType.WATER)) {
    if (r.length < minSize) for (const i of r) terrain[i] = TerrainType.WATER;
  }
}

function fillSmallLakes(terrain, width, height, minSize) {
  for (const r of floodRegions(terrain, width, height, (t) => t === TerrainType.WATER)) {
    if (r.length < minSize) for (const i of r) terrain[i] = TerrainType.PLAINS;
  }
}

module.exports = { generateMap };
