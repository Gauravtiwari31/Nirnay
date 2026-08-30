/**
 * Frequency-domain analysis: Bode data and stability margins.
 *
 * Everything here evaluates the transfer function directly on the imaginary axis,
 * s = jw, using exact polynomial arithmetic. No approximation is involved in the
 * response itself; the only numerical work is locating the two crossover
 * frequencies, and those are refined by bisection rather than read off the grid.
 *
 * @module core/freq
 */

import { cx, cabs, cdiv } from "./complex.js";
import { polyEvalComplex } from "./poly.js";
import { polyRoots } from "./roots.js";

/** Grid density used when hunting for crossovers before bisection. */
const SCAN_POINTS = 4001;

/** Bisection steps. Each halves the bracket, so this is far tighter than 1e-10 relative. */
const BISECT_STEPS = 80;

/** Magnitudes below this are treated as "at the origin" and excluded from range finding. */
const ORIGIN_EPS = 1e-12;

/**
 * Clamp a value into an inclusive range.
 * @param {number} v value
 * @param {number} lo lower bound
 * @param {number} hi upper bound
 * @returns {number} the clamped value
 */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Logarithmically spaced frequency grid.
 * @param {number} decadeLo lower exponent, i.e. the grid starts at 10^decadeLo
 * @param {number} decadeHi upper exponent, i.e. the grid ends at 10^decadeHi
 * @param {number} n number of points; must be at least 1
 * @returns {number[]} exactly `n` points, endpoints inclusive
 */
export function logspace(decadeLo, decadeHi, n) {
  if (!Number.isFinite(n) || n < 1) return [];
  if (n === 1) return [Math.pow(10, decadeLo)];
  const out = new Array(n);
  const step = (decadeHi - decadeLo) / (n - 1);
  for (let i = 0; i < n; i += 1) {
    out[i] = Math.pow(10, decadeLo + i * step);
  }
  // Pin the endpoints so round-trip through the exponent cannot drift them.
  out[0] = Math.pow(10, decadeLo);
  out[n - 1] = Math.pow(10, decadeHi);
  return out;
}

/**
 * Evaluate a transfer function at s = jw.
 * @param {{num: number[], den: number[]}} tf the transfer function
 * @param {number} w frequency in rad/s
 * @returns {{re: number, im: number}} the complex value L(jw)
 */
function evalAt(tf, w) {
  const s = cx(0, w);
  return cdiv(polyEvalComplex(tf.num, s), polyEvalComplex(tf.den, s));
}

/**
 * Complex frequency response over a given grid.
 *
 * The phase is unwrapped: adjacent samples never differ by more than 180 degrees,
 * so the curve is continuous and can be compared against -180 directly. Without
 * this both the Bode phase plot and the phase margin would be wrong wherever the
 * true phase passes through the +/-180 branch cut.
 *
 * @param {{num: number[], den: number[]}} tf the transfer function
 * @param {number[]} w frequencies in rad/s, assumed ascending
 * @returns {{w: number[], mag: number[], magDb: number[], phaseDeg: number[]}}
 *   index-aligned arrays; `phaseDeg` is continuous, not folded into (-180, 180]
 */
export function frequencyResponse(tf, w) {
  const out = { w: [], mag: [], magDb: [], phaseDeg: [] };
  let offset = 0;
  let prevRaw = null;
  for (const wi of w) {
    const H = evalAt(tf, wi);
    const mag = cabs(H);
    // atan2 returns (-pi, pi]; convert first, unwrap second.
    const raw = (Math.atan2(H.im, H.re) * 180) / Math.PI;
    if (prevRaw !== null) {
      const d = raw - prevRaw;
      // |d| can only exceed 180 by crossing the branch cut, and only ever by one
      // turn between adjacent samples on a sane grid, so a single step suffices.
      if (d > 180) offset -= 360;
      else if (d < -180) offset += 360;
    }
    prevRaw = raw;
    out.w.push(wi);
    out.mag.push(mag);
    out.magDb.push(20 * Math.log10(mag));
    out.phaseDeg.push(raw + offset);
  }
  return out;
}

/**
 * A sensible decade range for plotting: two decades either side of the slowest and
 * fastest finite dynamics. Poles and zeros at the origin carry no frequency
 * information and are skipped.
 * @param {{num: number[], den: number[]}} tf the transfer function
 * @returns {{lo: number, hi: number}} decade exponents, clamped to [-3, 4]
 */
export function autoFreqRange(tf) {
  const mags = [];
  for (const r of polyRoots(tf.den)) {
    const m = cabs(r);
    if (m > ORIGIN_EPS) mags.push(m);
  }
  for (const r of polyRoots(tf.num)) {
    const m = cabs(r);
    if (m > ORIGIN_EPS) mags.push(m);
  }
  if (mags.length === 0) return { lo: -2, hi: 2 };
  const lo = clamp(Math.log10(Math.min(...mags)) - 2, -3, 4);
  const hi = clamp(Math.log10(Math.max(...mags)) + 2, -3, 4);
  // Clamping can collapse the range; keep it strictly increasing so callers can
  // always build a grid from it.
  return hi > lo ? { lo, hi } : { lo, hi: Math.min(4, lo + 4) };
}

/**
 * Bisect for a sign change of `f` on [a, b], stepping by the geometric midpoint
 * because the bracket comes off a logarithmic grid.
 * @param {(x: number) => number} f function with opposite signs at the endpoints
 * @param {number} a lower bracket, strictly positive
 * @param {number} b upper bracket, strictly positive
 * @returns {number} the crossing point
 */
function bisectLog(f, a, b) {
  let lo = a;
  let hi = b;
  let flo = f(lo);
  if (flo === 0) return lo;
  for (let i = 0; i < BISECT_STEPS; i += 1) {
    const mid = Math.sqrt(lo * hi);
    const fm = f(mid);
    if (fm === 0) return mid;
    if (fm < 0 === flo < 0) {
      lo = mid;
      flo = fm;
    } else {
      hi = mid;
    }
  }
  return Math.sqrt(lo * hi);
}

/**
 * Refine a crossing that the scan detected between `w[i-1]` and `w[i]`.
 *
 * The tight bracket is tried first, because bisecting the narrowest interval that
 * contains the root cannot stray onto a neighbouring one. It fails in one specific
 * case: when the crossing lands on a grid point, `f` at that point is zero to
 * within rounding rather than exactly zero, so both endpoints of the tight bracket
 * share a sign and there is no root to bisect towards. Widening by one cell on
 * each side recovers a genuine sign change. If even that is single-signed the
 * crossing is degenerate, and the endpoint closest to satisfying the condition is
 * the honest answer.
 *
 * @param {(x: number) => number} f the crossing condition, zero at the crossover
 * @param {number[]} w the scan grid
 * @param {number} i index such that the crossing lies in [w[i-1], w[i]]
 * @returns {number} the refined crossover frequency
 */
function refineCrossing(f, w, i) {
  const lo = w[i - 1];
  const hi = w[i];
  const fLo = f(lo);
  const fHi = f(hi);
  if (fLo === 0) return lo;
  if (fHi === 0) return hi;
  if (fLo < 0 !== fHi < 0) return bisectLog(f, lo, hi);

  const wideLo = w[Math.max(0, i - 2)];
  const wideHi = w[Math.min(w.length - 1, i + 1)];
  const fwLo = f(wideLo);
  const fwHi = f(wideHi);
  if (fwLo < 0 !== fwHi < 0) return bisectLog(f, wideLo, wideHi);

  return Math.abs(fLo) <= Math.abs(fHi) ? lo : hi;
}

/**
 * Open-loop stability margins.
 *
 * Both crossovers are located by finding a sign change on a dense logarithmic
 * grid and then bisecting, so the reported frequency satisfies its defining
 * equation to machine precision rather than merely landing on a nearby grid point.
 *
 * The gain crossover is bisected on log|L|, which is well conditioned across many
 * decades. The phase crossover is bisected on Im{L(jw)} instead of on the phase
 * itself: at -180 degrees L is real and negative, so its imaginary part changes
 * sign there exactly. Bracketing that root with the unwrapped phase first is what
 * keeps it from latching onto the phase = 0 crossing, where Im{L} also vanishes.
 *
 * @param {{num: number[], den: number[]}} L the open-loop transfer function
 * @returns {{
 *   gainMarginDb: number|null,
 *   gainMargin: number|null,
 *   phaseMarginDeg: number|null,
 *   gainCrossoverW: number|null,
 *   phaseCrossoverW: number|null
 * }} margins, with `null` wherever the corresponding crossing does not exist
 */
export function margins(L) {
  const out = {
    gainMarginDb: null,
    gainMargin: null,
    phaseMarginDeg: null,
    gainCrossoverW: null,
    phaseCrossoverW: null,
  };

  const range = autoFreqRange(L);
  // Widen past the plotting range: a crossover can sit well outside the band that
  // merely looks interesting, and missing one reports a false "no margin".
  const lo = range.lo - 2;
  const hi = range.hi + 2;
  const w = logspace(lo, hi, SCAN_POINTS);
  if (w.length === 0) return out;

  const resp = frequencyResponse(L, w);

  // --- gain crossover: the first w where |L| = 1 ---------------------------
  const magCondition = (x) => Math.log(cabs(evalAt(L, x)));
  for (let i = 1; i < w.length; i += 1) {
    const a = resp.mag[i - 1] - 1;
    const b = resp.mag[i] - 1;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (a === 0 || a < 0 !== b < 0) {
      out.gainCrossoverW = refineCrossing(magCondition, w, i);
      break;
    }
  }

  if (out.gainCrossoverW !== null) {
    const H = evalAt(L, out.gainCrossoverW);
    const phase = (Math.atan2(H.im, H.re) * 180) / Math.PI;
    // Normalise into (-180, 180]. Adding 180 to a value already in that interval
    // lands in (0, 360], so one wrap is always enough.
    let pm = 180 + phase;
    while (pm > 180) pm -= 360;
    while (pm <= -180) pm += 360;
    out.phaseMarginDeg = pm;
  }

  // --- phase crossover: the first w where the phase reaches -180 -----------
  for (let i = 1; i < w.length; i += 1) {
    const a = resp.phaseDeg[i - 1] + 180;
    const b = resp.phaseDeg[i] + 180;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (a === 0 || a < 0 !== b < 0) {
      const wpc = refineCrossing((x) => evalAt(L, x).im, w, i);
      const mag = cabs(evalAt(L, wpc));
      if (Number.isFinite(mag) && mag > 0) {
        out.phaseCrossoverW = wpc;
        out.gainMargin = 1 / mag;
        out.gainMarginDb = -20 * Math.log10(mag);
      }
      break;
    }
  }

  return out;
}
