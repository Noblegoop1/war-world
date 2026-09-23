'use strict';
// Shared 8-connected A* / BFS on the tile grid. Diagonal steps cost sqrt(2) and never cut through
// a blocked corner, so paths run along real hypotenuses instead of staircases.

const SQRT2 = Math.SQRT2;

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.v.length; }
  push(v, k) {
    const K = this.k, V = this.v; let i = V.length; K.push(k); V.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (K[p] <= K[i]) break;
      const tk = K[p]; K[p] = K[i]; K[i] = tk;
      const tv = V[p]; V[p] = V[i]; V[i] = tv;
      i = p;
    }
  }
  pop() {
    const K = this.k, V = this.v; const top = V[0]; const lk = K.pop(), lv = V.pop();
    if (V.length) {
      K[0] = lk; V[0] = lv;
      let i = 0; const n = V.length;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < n && K[l] < K[m]) m = l;
        if (r < n && K[r] < K[m]) m = r;
        if (m === i) break;
        const tk = K[m]; K[m] = K[i]; K[i] = tk;
        const tv = V[m]; V[m] = V[i]; V[i] = tv;
        i = m;
      }
    }
    return top;
  }
}

/**
 * A* from one or more start tiles to a goal (tile) or goal test.
 * @param {object} g  game (needs width, height)
 * @param {number[]} starts
 * @param {number|((t:number)=>boolean)} goal  tile index, or predicate
 * @param {(t:number, from:number)=>number} cost  step cost multiplier for entering t (Infinity/<=0 = blocked); 1 = normal
 * @param {object} [opts] { heuristicTo: tile for the heuristic when goal is a predicate, maxIter, diag: true }
 * @returns {number[]|null} path of tiles from a start to the goal (inclusive), or null
 */
// Scratch buffers shared by every search on the same map size. A generation stamp marks which entries
// belong to the current search, so nothing has to be cleared: allocating and filling three full-map
// arrays per call (4.5 MB on the world map) used to dominate short searches and fed the GC.
// astar is not re-entrant (no search runs inside a cost function), so one set is enough.
let scratch = null;
function buffersFor(N) {
  if (!scratch || scratch.N !== N) scratch = { N, g: new Float32Array(N), came: new Int32Array(N), seen: new Uint32Array(N), closed: new Uint32Array(N), gen: 0 };
  if (++scratch.gen >= 0xfffffff0) { scratch.seen.fill(0); scratch.closed.fill(0); scratch.gen = 1; }
  return scratch;
}

function astar(g, starts, goal, cost, opts = {}) {
  const W = g.width, H = g.height, N = W * H;
  const maxIter = opts.maxIter || 400000;
  const diag = opts.diag !== false;
  const goalTile = typeof goal === 'number' ? goal : (opts.heuristicTo ?? -1);
  const isGoal = typeof goal === 'number' ? null : goal;
  const gx = goalTile >= 0 ? goalTile % W : 0, gy = goalTile >= 0 ? (goalTile / W) | 0 : 0;
  const useH = goalTile >= 0;
  const h = (t) => { if (!useH) return 0; const dx = Math.abs(t % W - gx), dy = Math.abs(((t / W) | 0) - gy); return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy); };
  const B = buffersFor(N), gen = B.gen, G = B.g, came = B.came, seen = B.seen, closed = B.closed;
  const heap = new MinHeap();
  for (const s of starts) { if (s < 0 || s >= N) continue; seen[s] = gen; G[s] = 0; came[s] = s; heap.push(s, h(s)); }
  // relax one neighbour; inlined logic of the old per-node closure
  const relax = (nt, cur, gcur, stepCost, c) => {
    if (closed[nt] === gen || !(c > 0) || c === Infinity) return;
    const ng = gcur + stepCost * c;
    if (seen[nt] !== gen || ng < G[nt]) { seen[nt] = gen; G[nt] = ng; came[nt] = cur; heap.push(nt, ng + h(nt)); }
  };
  let iter = 0;
  while (heap.size) {
    if (++iter > maxIter) return null;
    const cur = heap.pop();
    if (closed[cur] === gen) continue;
    closed[cur] = gen;
    if (isGoal ? isGoal(cur) : cur === goal) {
      const path = [];
      let t = cur;
      while (came[t] !== t) { path.push(t); t = came[t]; }
      path.push(t);
      return path.reverse();
    }
    const cx = cur % W, cy = (cur / W) | 0;
    const gcur = G[cur];
    const okL = cx > 0, okR = cx < W - 1, okU = cy > 0, okD = cy < H - 1;
    // each orthogonal cost once: it decides both the step and whether diagonals may cut past it
    const cL = okL ? cost(cur - 1, cur) : 0, cR = okR ? cost(cur + 1, cur) : 0, cU = okU ? cost(cur - W, cur) : 0, cD = okD ? cost(cur + W, cur) : 0;
    if (okL) relax(cur - 1, cur, gcur, 1, cL);
    if (okR) relax(cur + 1, cur, gcur, 1, cR);
    if (okU) relax(cur - W, cur, gcur, 1, cU);
    if (okD) relax(cur + W, cur, gcur, 1, cD);
    if (diag) { // diagonals only when both adjacent orthogonals are passable (no corner cutting)
      const pL = cL > 0, pR = cR > 0, pU = cU > 0, pD = cD > 0;
      if (okL && okU && pL && pU) relax(cur - W - 1, cur, gcur, SQRT2, cost(cur - W - 1, cur));
      if (okR && okU && pR && pU) relax(cur - W + 1, cur, gcur, SQRT2, cost(cur - W + 1, cur));
      if (okL && okD && pL && pD) relax(cur + W - 1, cur, gcur, SQRT2, cost(cur + W - 1, cur));
      if (okR && okD && pR && pD) relax(cur + W + 1, cur, gcur, SQRT2, cost(cur + W + 1, cur));
    }
  }
  return null;
}

// Plain 8-connected BFS (unit costs) for "nearest tile matching predicate" queries.
function bfsNearest(g, starts, passable, isTarget, maxDepth = 200) {
  const W = g.width, H = g.height;
  const seen = new Uint8Array(W * H);
  let frontier = [];
  for (const s of starts) { if (!seen[s]) { seen[s] = 1; frontier.push(s); } }
  for (let d = 0; d < maxDepth && frontier.length; d++) {
    const next = [];
    for (const t of frontier) {
      if (isTarget(t)) return t;
      const x = t % W, y = (t / W) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const nt = ny * W + nx;
        if (seen[nt]) continue;
        seen[nt] = 1;
        if (!passable(nt)) { if (isTarget(nt)) return nt; continue; }
        next.push(nt);
      }
    }
    frontier = next;
  }
  return -1;
}

// Sample a path at a fixed distance step so units move at constant speed along diagonals.
// Returns [{x,y}] world points (tile centres).
function resamplePath(g, path, step) {
  if (!path || !path.length) return [];
  const W = g.width;
  const pts = path.map((t) => ({ x: t % W + 0.5, y: ((t / W) | 0) + 0.5 }));
  if (pts.length === 1) return pts;
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    let d = step - carry;
    while (d <= len) { out.push({ x: a.x + (dx / len) * d, y: a.y + (dy / len) * d }); d += step; }
    carry = len - (d - step);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Cubic Bezier lob (OpenFront's nuke arc): p1/p2 raised by max(dist/3, 50) above the chord.
function bezierArc(x0, y0, x3, y3, minHeight = 50) {
  const dx = x3 - x0, dy = y3 - y0;
  const dist = Math.hypot(dx, dy);
  const hgt = Math.max(dist / 3, minHeight);
  const p1 = { x: x0 + dx / 4, y: y0 + dy / 4 - hgt }, p2 = { x: x0 + (3 * dx) / 4, y: y0 + (3 * dy) / 4 - hgt };
  return { p0: { x: x0, y: y0 }, p1, p2, p3: { x: x3, y: y3 }, length: dist * 1.25 + hgt * 0.8 };
}
function bezierPoint(c, t) {
  const u = 1 - t;
  return {
    x: u * u * u * c.p0.x + 3 * u * u * t * c.p1.x + 3 * u * t * t * c.p2.x + t * t * t * c.p3.x,
    y: u * u * u * c.p0.y + 3 * u * u * t * c.p1.y + 3 * u * t * t * c.p2.y + t * t * t * c.p3.y,
  };
}

module.exports = { astar, bfsNearest, resamplePath, bezierArc, bezierPoint, MinHeap };
