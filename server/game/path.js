'use strict';
// Shared 8-connected A* / BFS on the tile grid. Diagonal steps cost sqrt(2) and never cut through
// a blocked corner, so paths run along real hypotenuses instead of staircases.

const SQRT2 = Math.SQRT2;

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.v.length; }
  push(v, k) {
    const K = this.k, V = this.v; let i = V.length; K.push(k); V.push(v);
    while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= K[i]) break; [K[p], K[i]] = [K[i], K[p]]; [V[p], V[i]] = [V[i], V[p]]; i = p; }
  }
  pop() {
    const K = this.k, V = this.v; const top = V[0]; const lk = K.pop(), lv = V.pop();
    if (V.length) { K[0] = lk; V[0] = lv; let i = 0; const n = V.length; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < n && K[l] < K[m]) m = l; if (r < n && K[r] < K[m]) m = r; if (m === i) break; [K[m], K[i]] = [K[i], K[m]]; [V[m], V[i]] = [V[i], V[m]]; i = m; } }
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
function astar(g, starts, goal, cost, opts = {}) {
  const W = g.width, H = g.height, N = W * H;
  const maxIter = opts.maxIter || 400000;
  const diag = opts.diag !== false;
  const goalTile = typeof goal === 'number' ? goal : (opts.heuristicTo ?? -1);
  const isGoal = typeof goal === 'number' ? (t) => t === goal : goal;
  const gx = goalTile >= 0 ? goalTile % W : 0, gy = goalTile >= 0 ? (goalTile / W) | 0 : 0;
  const h = goalTile >= 0
    ? (t) => { const dx = Math.abs(t % W - gx), dy = Math.abs(((t / W) | 0) - gy); return Math.max(dx, dy) + (SQRT2 - 1) * Math.min(dx, dy); }
    : () => 0;
  const gScore = new Float32Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const heap = new MinHeap();
  for (const s of starts) { if (s < 0 || s >= N) continue; gScore[s] = 0; came[s] = s; heap.push(s, h(s)); }
  let iter = 0;
  while (heap.size) {
    if (++iter > maxIter) return null;
    const cur = heap.pop();
    if (closed[cur]) continue;
    closed[cur] = 1;
    if (isGoal(cur)) {
      const path = [];
      let t = cur;
      while (came[t] !== t) { path.push(t); t = came[t]; }
      path.push(t);
      return path.reverse();
    }
    const cx = cur % W, cy = (cur / W) | 0;
    const gcur = gScore[cur];
    const okL = cx > 0, okR = cx < W - 1, okU = cy > 0, okD = cy < H - 1;
    const tryStep = (nt, stepCost) => {
      if (closed[nt]) return;
      const c = cost(nt, cur);
      if (!(c > 0) || c === Infinity) return;
      const ng = gcur + stepCost * c;
      if (ng < gScore[nt]) { gScore[nt] = ng; came[nt] = cur; heap.push(nt, ng + h(nt)); }
    };
    // orthogonal
    const pL = okL && cost(cur - 1, cur) > 0, pR = okR && cost(cur + 1, cur) > 0, pU = okU && cost(cur - W, cur) > 0, pD = okD && cost(cur + W, cur) > 0;
    if (okL) tryStep(cur - 1, 1);
    if (okR) tryStep(cur + 1, 1);
    if (okU) tryStep(cur - W, 1);
    if (okD) tryStep(cur + W, 1);
    if (diag) { // diagonals only when both adjacent orthogonals are passable (no corner cutting)
      if (okL && okU && pL && pU) tryStep(cur - W - 1, SQRT2);
      if (okR && okU && pR && pU) tryStep(cur - W + 1, SQRT2);
      if (okL && okD && pL && pD) tryStep(cur + W - 1, SQRT2);
      if (okR && okD && pR && pD) tryStep(cur + W + 1, SQRT2);
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
