/**
 * Root locus: how the closed-loop poles migrate as a scalar loop gain is swept.
 *
 * The closed-loop characteristic polynomial of a unity-feedback loop with open
 * loop k*L(s) is  den(s) + k*num(s) = 0.  Sweeping k and factoring that polynomial
 * at each step traces the locus directly, which is both simpler and more robust
 * than the classical construction rules (asymptotes, breakaway points, angle of
 * departure) and handles non-minimum-phase and unstable plants without special
 * cases.
 *
 * @module core/rlocus
 */

import { polyAdd, polyScale, polyDeg } from "./poly.js";
import { polyRoots } from "./roots.js";
import { logspace } from "./freq.js";

/** Points in the logarithmic part of the default gain sweep. */
const DEFAULT_POINTS = 200;

/** Decade exponents of the default gain sweep, after the k = 0 start. */
const K_LO_DECADE = -3;
const K_HI_DECADE = 3;

/** Gain range scanned when hunting for the stability boundary. */
const CRIT_LO_DECADE = -6;
const CRIT_HI_DECADE = 6;
const CRIT_SCAN_POINTS = 601;
const CRIT_BISECT_STEPS = 100;

/**
 * Reorder `roots` so that each entry continues the trajectory of the corresponding
 * entry in `prev`, by greedy nearest-neighbour matching in the complex plane.
 *
 * Without this the branches would be whatever order the root finder happened to
 * return, and drawn lines would leap between branches wherever two poles pass
 * close to one another — most visibly at the imaginary-axis crossing, where a
 * conjugate pair would appear to swap.
 *
 * @param {{re: number, im: number}[]} prev previous positions, one per branch
 * @param {{re: number, im: number}[]} roots newly computed roots, unordered
 * @returns {{re: number, im: number}[]} `roots`, permuted to align with `prev`
 */
function matchToPrevious(prev, roots) {
  const pairs = [];
  for (let i = 0; i < prev.length; i += 1) {
    for (let j = 0; j < roots.length; j += 1) {
      pairs.push({ i, j, d: Math.hypot(prev[i].re - roots[j].re, prev[i].im - roots[j].im) });
    }
  }
  pairs.sort((a, b) => a.d - b.d);

  const out = new Array(prev.length).fill(null);
  const usedBranch = new Set();
  const usedRoot = new Set();
  for (const p of pairs) {
    if (usedBranch.has(p.i) || usedRoot.has(p.j)) continue;
    out[p.i] = roots[p.j];
    usedBranch.add(p.i);
    usedRoot.add(p.j);
  }
  // A branch is left unmatched only when the characteristic polynomial loses
  // degree (the leading coefficients of den and k*num cancel). Holding the last
  // position keeps every branch index-aligned with the gain vector.
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] === null) out[i] = prev[i];
  }
  return out;
}

/**
 * Trace the closed-loop poles of den(s) + k*num(s) = 0 as k sweeps upward.
 *
 * @param {{num: number[], den: number[]}} L the open-loop transfer function
 * @param {{kMax?: number, n?: number}} [opts] sweep options; `n` is the number of
 *   logarithmically spaced gains after the k = 0 start
 * @returns {{k: number[], branches: {re: number, im: number}[][]}}
 *   `branches[i]` is one pole's trajectory, with exactly one point per entry of `k`
 */
export function rootLocus(L, opts = {}) {
  const n = Number.isFinite(opts.n) && opts.n > 0 ? Math.floor(opts.n) : DEFAULT_POINTS;
  const hiDecade = Number.isFinite(opts.kMax) && opts.kMax > 0 ? Math.log10(opts.kMax) : K_HI_DECADE;
  const k = [0, ...logspace(K_LO_DECADE, hiDecade, n)];

  const start = polyRoots(L.den);
  if (start.length === 0) return { k: [], branches: [] };

  const branches = start.map((r) => [{ re: r.re, im: r.im }]);
  let prev = start.map((r) => ({ re: r.re, im: r.im }));

  for (let i = 1; i < k.length; i += 1) {
    const chi = polyAdd(L.den, polyScale(L.num, k[i]));
    const roots = polyRoots(chi);
    const ordered = matchToPrevious(prev, roots);
    for (let b = 0; b < branches.length; b += 1) {
      branches[b].push({ re: ordered[b].re, im: ordered[b].im });
    }
    prev = ordered;
  }

  return { k, branches };
}

/**
 * Largest real part among the closed-loop poles at a given gain. This is the
 * scalar whose sign decides stability.
 * @param {{num: number[], den: number[]}} L the open-loop transfer function
 * @param {number} k loop gain
 * @returns {number} max Re(root), or NaN when the polynomial degenerates
 */
function maxRealPart(L, k) {
  const roots = polyRoots(polyAdd(L.den, polyScale(L.num, k)));
  if (roots.length === 0) return NaN;
  let m = -Infinity;
  for (const r of roots) if (r.re > m) m = r.re;
  return m;
}

/**
 * The gain at which the loop first goes unstable.
 *
 * Found by bisecting on max Re(closed-loop pole) crossing zero — entirely in the
 * s-plane, sharing no code path with the frequency-domain gain margin. When both
 * are defined they must agree, which makes the pair a strong mutual check.
 *
 * The scan deliberately starts just above zero rather than at zero: a loop with an
 * open-loop integrator sits exactly on the boundary at k = 0, and starting there
 * would read as already unstable.
 *
 * @param {{num: number[], den: number[]}} L the open-loop transfer function
 * @returns {{k: number, w: number}|null} the critical gain and the frequency at
 *   which the poles cross the imaginary axis, or `null` if the locus never
 *   enters the right half-plane
 */
export function criticalGain(L) {
  if (polyDeg(L.num) < 0 || polyDeg(L.den) < 0) return null;

  const ks = logspace(CRIT_LO_DECADE, CRIT_HI_DECADE, CRIT_SCAN_POINTS);
  let lo = null;
  let hi = null;
  let prevK = ks[0];
  let prevM = maxRealPart(L, prevK);
  if (!Number.isFinite(prevM) || prevM >= 0) return null;

  for (let i = 1; i < ks.length; i += 1) {
    const m = maxRealPart(L, ks[i]);
    if (!Number.isFinite(m)) continue;
    if (m >= 0) {
      lo = prevK;
      hi = ks[i];
      break;
    }
    prevK = ks[i];
    prevM = m;
  }
  if (lo === null) return null;

  // Linear bisection: the bracket is narrow by now, and k itself is the quantity
  // being reported, so refining it linearly is the most direct thing to do.
  for (let i = 0; i < CRIT_BISECT_STEPS; i += 1) {
    const mid = 0.5 * (lo + hi);
    if (maxRealPart(L, mid) < 0) lo = mid;
    else hi = mid;
  }
  const kc = 0.5 * (lo + hi);

  const roots = polyRoots(polyAdd(L.den, polyScale(L.num, kc)));
  let crossing = roots[0];
  for (const r of roots) if (r.re > crossing.re) crossing = r;
  return { k: kc, w: Math.abs(crossing.im) };
}
