/**
 * Polynomial root finding by the Durand-Kerner (Weierstrass) method.
 *
 * Every other numeric module in the bench ultimately depends on this file: poles,
 * zeros, damping ratios, stability, the pole-zero map and the root locus are all root
 * sets. It therefore does more than a textbook Durand-Kerner loop — see the comment
 * block on `polyRoots` for the refinements and why each one is needed.
 *
 * This module is DOM-free.
 */

import { cx, cadd, csub, cmul, cdiv, cabs, cscale } from "./complex.js";
import { polyTrim, polyDeg, polyEvalComplex } from "./poly.js";

/**
 * @typedef {import("./complex.js").Complex} Complex
 */

/** Maximum Durand-Kerner sweeps before the iteration gives up. */
const MAX_ITER = 500;

/** Relative correction below which a sweep counts as converged. */
const CONVERGE_TOL = 1e-12;

/**
 * Seed for the initial estimates `z_k = SEED^k`. Complex, just inside the unit circle
 * and not a root of unity, so the starting points never sit symmetrically on the real
 * axis — which would trap a real polynomial's iterates on the real axis forever.
 */
const SEED = { re: 0.4, im: 0.9 };

/**
 * Smallest cluster tolerance, used when the iteration converged and its own residual
 * says nothing useful. Roughly `7 * sqrt(eps)`: a DOUBLE root cannot be located more
 * precisely than `sqrt(eps)` in double precision, so two iterates this close are the
 * same root and there is no information to lose by merging them.
 */
const TOL_FLOOR = 1e-7;

/**
 * Largest cluster tolerance. Beyond this the grouping would stop being noise removal
 * and start discarding genuinely distinct roots, so a badly stalled iteration is left
 * alone rather than papered over.
 */
const TOL_CAP = 1e-3;

/**
 * Safety factor applied to the stalled residual when grouping a numerically multiple
 * root. A stalled cluster orbits the true root at radius `r` with corrections of the
 * same order, so its diameter is a small multiple of `r`.
 */
const CLUSTER_SLACK = 8;

/** Relative threshold below which an imaginary part is treated as numerical noise. */
const REAL_SNAP = 1e-9;

/**
 * Largest absolute coefficient of a polynomial.
 * @param {number[]} a Coefficients, descending powers.
 * @returns {number} `max |a_i|`, or 0 for an empty array.
 */
function maxAbs(a) {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(a[i]);
    if (v > m) m = v;
  }
  return m;
}

/**
 * Run the Durand-Kerner sweep on a MONIC polynomial with a non-zero constant term.
 *
 * Updates are applied in place (Gauss-Seidel style): each correction already sees the
 * corrections made earlier in the same sweep, which roughly halves the sweep count
 * compared with the Jacobi form.
 *
 * @param {number[]} monic Monic coefficients, descending powers, degree >= 1.
 * @returns {{roots: Complex[], residual: number}} The iterates, and the largest
 *   relative correction of the final sweep. A residual well above `CONVERGE_TOL` means
 *   the iteration stalled, which is what a root of multiplicity three or more looks
 *   like from the inside.
 */
function durandKerner(monic) {
  const d = monic.length - 1;
  const z = new Array(d);
  let seed = cx(1, 0);
  for (let k = 0; k < d; k++) {
    z[k] = seed;
    seed = cmul(seed, SEED);
  }

  let residual = Infinity;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    residual = 0;
    for (let k = 0; k < d; k++) {
      let den = cx(1, 0);
      for (let j = 0; j < d; j++) {
        if (j !== k) den = cmul(den, csub(z[k], z[j]));
      }
      // Two iterates landed on exactly the same point, so the mutual-repulsion term
      // vanished. Nudge this one off the collision and let the next sweep proceed.
      if (cabs(den) === 0) {
        z[k] = cadd(z[k], cx(1e-6, 1e-6));
        residual = Infinity;
        continue;
      }
      const delta = cdiv(polyEvalComplex(monic, z[k]), den);
      if (!Number.isFinite(delta.re) || !Number.isFinite(delta.im)) continue;
      z[k] = csub(z[k], delta);
      const rel = cabs(delta) / Math.max(1, cabs(z[k]));
      if (rel > residual) residual = rel;
    }
    if (residual < CONVERGE_TOL) break;
  }
  return { roots: z, residual };
}

/**
 * Single-linkage grouping of iterates that are numerically the same root.
 * @param {Complex[]} roots Raw iterates.
 * @param {number} tol Relative distance below which two iterates are the same root.
 * @returns {{label: number[], groups: number}} Group index per root, and the group
 *   count. `groups === roots.length` means nothing clustered.
 */
function clusterLabels(roots, tol) {
  const n = roots.length;
  const label = new Array(n).fill(-1);
  let groups = 0;

  for (let i = 0; i < n; i++) {
    if (label[i] !== -1) continue;
    label[i] = groups;
    const pending = [i];
    while (pending.length > 0) {
      const a = pending.pop();
      const reach = tol * Math.max(1, cabs(roots[a]));
      for (let j = 0; j < n; j++) {
        if (label[j] !== -1) continue;
        if (cabs(csub(roots[a], roots[j])) <= reach) {
          label[j] = groups;
          pending.push(j);
        }
      }
    }
    groups++;
  }
  return { label, groups };
}

/**
 * Collapse each group of numerically indistinguishable iterates onto one shared value.
 *
 * A root of multiplicity `m` can only be located to about `eps^(1/m)` — a double root
 * to ~1e-8, a triple to ~1e-5 — because below that, rounding error in evaluating
 * `p(z)` swamps the true value. Durand-Kerner leaves such a root as a small ring of
 * distinct iterates around it, which downstream shows up as a repeated real pole
 * masquerading as a lightly damped complex pair.
 *
 * The shared value is not the arithmetic mean of the ring, which inherits the ring's
 * asymmetry. It comes from Vieta's first identity instead: the roots of a monic
 * polynomial sum to `-a1`, so a group of `m` iterates must sum to `-a1` minus every
 * root outside the group. Those outside roots are simple and accurate to machine
 * precision, which makes the recovered group value accurate to machine precision too —
 * `(s+1)^3` lands on exactly -1 rather than -0.9999972.
 *
 * @param {Complex[]} roots Raw iterates.
 * @param {number} tol Relative distance below which two iterates are the same root.
 * @param {number} rootSum Sum of all roots, i.e. `-a1` of the monic polynomial.
 * @returns {Complex[]} A new array, same length and order, with each group replaced by
 *   its recovered value.
 */
function mergeClusters(roots, tol, rootSum) {
  const { label, groups } = clusterLabels(roots, tol);
  if (groups === roots.length) return roots.slice();

  const sums = Array.from({ length: groups }, () => cx(0, 0));
  const counts = new Array(groups).fill(0);
  for (let i = 0; i < roots.length; i++) {
    sums[label[i]] = cadd(sums[label[i]], roots[i]);
    counts[label[i]] += 1;
  }

  const values = new Array(groups);
  for (let g = 0; g < groups; g++) {
    if (counts[g] === 1) {
      values[g] = sums[g];
      continue;
    }
    let outside = cx(0, 0);
    for (let h = 0; h < groups; h++) {
      if (h !== g) outside = cadd(outside, sums[h]);
    }
    values[g] = cscale(csub(cx(rootSum, 0), outside), 1 / counts[g]);
  }

  return roots.map((_, i) => {
    const v = values[label[i]];
    return cx(v.re, v.im);
  });
}

/**
 * Force the root set into a canonical, reproducible form.
 *
 * Snaps near-real roots to exactly real, then rewrites each complex pair as an exact
 * conjugate pair. A polynomial with real coefficients has exactly conjugate roots in
 * theory; making that exact in the output keeps the pole-zero map symmetric to the
 * pixel and makes the damping ratio of a pole agree with that of its twin.
 *
 * @param {Complex[]} roots Merged roots.
 * @param {number} tol Relative tolerance for recognising a conjugate partner.
 * @returns {Complex[]} A new array of canonicalised roots.
 */
function canonicalise(roots, tol) {
  const out = roots.map((r) =>
    Math.abs(r.im) < REAL_SNAP * Math.max(1, Math.abs(r.re)) ? cx(r.re, 0) : cx(r.re, r.im),
  );

  const paired = new Array(out.length).fill(false);
  for (let i = 0; i < out.length; i++) {
    if (paired[i] || out[i].im <= 0) continue;
    const reach = tol * Math.max(1, cabs(out[i]));
    let best = -1;
    let bestDist = Infinity;
    for (let j = 0; j < out.length; j++) {
      if (paired[j] || out[j].im >= 0) continue;
      const dist = cabs(csub(out[i], cx(out[j].re, -out[j].im)));
      if (dist < bestDist) {
        bestDist = dist;
        best = j;
      }
    }
    if (best === -1 || bestDist > reach) continue;
    const re = (out[i].re + out[best].re) / 2;
    const im = (Math.abs(out[i].im) + Math.abs(out[best].im)) / 2;
    out[i] = cx(re, im);
    out[best] = cx(re, -im);
    paired[i] = true;
    paired[best] = true;
  }
  return out;
}

/**
 * Durand-Kerner (Weierstrass) simultaneous root finder.
 *
 * Three refinements sit on top of the bare iteration, each of which the plants in this
 * bench actually need:
 *
 * 1. Roots at the origin are peeled off as trailing zero coefficients BEFORE
 *    iterating. A zero constant term drags every iterate toward the origin together,
 *    the mutual-repulsion denominators collapse, and convergence stalls. Any plant
 *    with an integrator (`den = [1, 11, 10, 0]`) hits this.
 * 2. Numerically multiple roots are collapsed onto a single shared value recovered
 *    from Vieta's first identity, with the iteration's own residual sizing the
 *    cluster. See `mergeClusters`.
 * 3. The result is canonicalised — near-real roots snapped to real, complex roots
 *    written as exact conjugate pairs — and sorted deterministically, so repeated
 *    calls on unchanged state produce identical output and the plots do not jitter.
 *
 * @param {number[]} p Descending-power coefficients, e.g. `[1, 2, 3]` for `s^2+2s+3`.
 * @returns {Complex[]} Roots, length = `polyDeg(p)`, sorted by descending real part
 *   then descending imaginary part. Empty array for a constant, zero, empty or
 *   non-finite polynomial.
 */
export function polyRoots(p) {
  if (!Array.isArray(p) || !p.every(Number.isFinite)) return [];

  const c = polyTrim(p);
  const degree = polyDeg(c);
  if (!Number.isFinite(degree) || degree <= 0) return [];

  // Peel trailing near-zero coefficients: each one is a root at s = 0.
  const zeroTol = 1e-12 * maxAbs(c);
  let last = c.length - 1;
  let originRoots = 0;
  while (last > 0 && Math.abs(c[last]) <= zeroTol) {
    last -= 1;
    originRoots += 1;
  }

  const reduced = c.slice(0, last + 1);
  let roots = [];

  if (reduced.length > 1) {
    const lead = reduced[0];
    const monic = reduced.map((v) => v / lead);
    const solved = durandKerner(monic);
    const tol = Math.min(TOL_CAP, Math.max(TOL_FLOOR, CLUSTER_SLACK * solved.residual));
    roots = canonicalise(mergeClusters(solved.roots, tol, -monic[1]), tol);
  }

  for (let i = 0; i < originRoots; i++) roots.push(cx(0, 0));

  roots.sort((a, b) => b.re - a.re || b.im - a.im);
  return roots;
}
