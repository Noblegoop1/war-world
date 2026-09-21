'use strict';
// Small seeded PRNG (mulberry32) so maps and AI are reproducible per seed.
class Rng {
  constructor(seed) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }
  next() {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  // integer in [lo, hi] inclusive
  int(lo, hi) {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  // true with probability 1/n
  chance(n) {
    return this.int(0, n - 1) === 0;
  }
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
}

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

module.exports = { Rng, hashString };
