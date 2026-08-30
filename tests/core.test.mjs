/**
 * Numeric test suite for src/core/*.
 *
 * Every expected value here is either hand-derived (the derivation is in the
 * comment above the test) or produced from a closed-form analytic solution
 * evaluated independently of the code under test. Nothing was fitted to an
 * implementation.
 */

import { test, assert, assertEqual, assertNull, assertClose, assertNear } from "./harness.mjs";

import { cx, cadd, csub, cmul, cdiv, cabs, carg, cscale } from "../src/core/complex.js";
import { polyMul, polyAdd, polyScale, polyTrim, polyEvalComplex, polyDeg } from "../src/core/poly.js";
import { polyRoots } from "../src/core/roots.js";
import { pidTF, series, closedLoop, errorTF, dcGain, polesZeros, toStateSpace } from "../src/core/tf.js";
import { stepResponse, stepMetrics, chooseHorizon } from "../src/core/sim.js";
import { frequencyResponse, logspace, autoFreqRange, margins } from "../src/core/freq.js";
import { rootLocus, criticalGain } from "../src/core/rlocus.js";

// ---------------------------------------------------------------------------
// local helpers (test-only; deliberately independent of src/)
// ---------------------------------------------------------------------------

/**
 * Render a complex number for failure messages.
 * @param {{re:number, im:number}} z
 * @returns {string}
 */
function fc(z) {
  if (!z || typeof z.re !== "number") return String(z);
  return `${z.re.toPrecision(10)}${z.im < 0 ? "-" : "+"}${Math.abs(z.im).toPrecision(10)}i`;
}

/**
 * Compare two arrays element-wise to a relative tolerance.
 * @param {number[]} actual
 * @param {number[]} expected
 * @param {number} relTol
 * @param {string} msg
 * @returns {void}
 */
function assertArrayClose(actual, expected, relTol, msg) {
  assert(Array.isArray(actual), `${msg}\n    expected an array, got ${JSON.stringify(actual)}`);
  assertEqual(actual.length, expected.length, `${msg} (length)\n    array was [${actual}]`);
  for (let i = 0; i < expected.length; i += 1) {
    assertClose(actual[i], expected[i], relTol, `${msg} at index ${i}\n    full actual:   [${actual}]\n    full expected: [${expected}]`);
  }
}

/**
 * Compare root sets as multisets: same length, and every expected root is
 * matched (greedily, nearest first) by a distinct actual root within `absTol`.
 * Ordering beyond that is not asserted here — the documented sort is checked
 * separately by `assertSortedByContract`.
 * @param {{re:number, im:number}[]} actual
 * @param {{re:number, im:number}[]} expected
 * @param {number} absTol tolerance in the complex plane
 * @param {string} msg
 * @returns {void}
 */
function assertRootSet(actual, expected, absTol, msg) {
  assert(Array.isArray(actual), `${msg}\n    expected an array of roots, got ${JSON.stringify(actual)}`);
  const show = () => `\n    actual:   [${actual.map(fc).join(", ")}]\n    expected: [${expected.map(fc).join(", ")}]`;
  assertEqual(actual.length, expected.length, `${msg} (root count)${show()}`);
  const taken = new Array(actual.length).fill(false);
  for (const e of expected) {
    let best = -1;
    let bestD = Infinity;
    for (let j = 0; j < actual.length; j += 1) {
      if (taken[j]) continue;
      const d = Math.hypot(actual[j].re - e.re, actual[j].im - e.im);
      if (d < bestD) { bestD = d; best = j; }
    }
    assert(
      best >= 0 && bestD <= absTol,
      `${msg}\n    no unmatched root within ${absTol.toExponential(3)} of ${fc(e)}` +
      `\n    nearest was ${best >= 0 ? fc(actual[best]) : "none"} at distance ${bestD.toExponential(4)}${show()}`
    );
    taken[best] = true;
  }
}

/**
 * Assert the contract's ordering: descending real part, ties broken by
 * descending imaginary part.
 * @param {{re:number, im:number}[]} roots
 * @param {string} msg
 * @returns {void}
 */
function assertSortedByContract(roots, msg) {
  const eps = 1e-7;
  for (let i = 1; i < roots.length; i += 1) {
    const a = roots[i - 1];
    const b = roots[i];
    const ok = b.re < a.re + eps && (b.re < a.re - eps || b.im < a.im + eps);
    assert(ok, `${msg}\n    order violated at index ${i}: ${fc(a)} then ${fc(b)}` +
      `\n    full list: [${roots.map(fc).join(", ")}]`);
  }
}

/**
 * Assert no numeric field of a flat result object is NaN or Infinity.
 * `null` is allowed — the contract uses it for "not defined".
 * @param {Record<string, unknown>} obj
 * @param {string} msg
 * @returns {void}
 */
function assertNoBadNumbers(obj, msg) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number") {
      assert(Number.isFinite(v), `${msg}\n    field "${k}" is ${v}; the contract says return null, never a non-finite number`);
    }
  }
}

/**
 * Standard second-order plant: G(s) = wn^2 / (s^2 + 2*zeta*wn*s + wn^2).
 * @param {number} zeta damping ratio
 * @param {number} wn natural frequency rad/s
 * @returns {{num:number[], den:number[]}}
 */
function secondOrder(zeta, wn) {
  return { num: [wn * wn], den: [1, 2 * zeta * wn, wn * wn] };
}

/**
 * Closed-form unit-step response of `secondOrder(zeta, wn)`:
 *   y(t) = 1 - e^(-zeta*wn*t)/sqrt(1-zeta^2) * sin(wd*t + acos(zeta))
 * @param {number} t
 * @param {number} zeta
 * @param {number} wn
 * @returns {number}
 */
function secondOrderStep(t, zeta, wn) {
  const r = Math.sqrt(1 - zeta * zeta);
  return 1 - (Math.exp(-zeta * wn * t) / r) * Math.sin(wn * r * t + Math.acos(zeta));
}

/**
 * Exact 2%-band settling time of a second-order system, found from the closed
 * form above by scanning backwards for the last band exit and bisecting.
 * This is genuine analytic ground truth for the RK4 result — the two share no
 * code path.
 * @param {number} zeta
 * @param {number} wn
 * @returns {number} seconds
 */
function exactSettlingTime(zeta, wn) {
  const band = 0.02;
  const err = (t) => Math.abs(secondOrderStep(t, zeta, wn) - 1) - band;
  // The exponential envelope e^(-zeta*wn*t)/sqrt(1-zeta^2) falls below `band`
  // here, so the last crossing is strictly before it.
  const tEnv = (Math.log(1 / band) - 0.5 * Math.log(1 - zeta * zeta)) / (zeta * wn);
  const T = tEnv * 1.05;
  const N = 400000;
  let last = 0;
  for (let i = N; i >= 0; i -= 1) {
    if (err((T * i) / N) > 0) { last = i; break; }
  }
  let a = (T * last) / N;
  let b = (T * (last + 1)) / N;
  for (let i = 0; i < 100; i += 1) {
    const m = 0.5 * (a + b);
    if (err(m) > 0) a = m; else b = m;
  }
  return 0.5 * (a + b);
}

/**
 * Evaluate a state-space realisation at a complex s:  C (sI - A)^-1 B + D.
 * Complex Gaussian elimination with partial pivoting; makes no assumption
 * about the shape of A, so it validates the realisation rather than restating
 * the contract's formula.
 * @param {{A:number[][], B:number[], C:number[], D:number}} ss
 * @param {{re:number, im:number}} s
 * @returns {{re:number, im:number}}
 */
function ssEvalComplex(ss, s) {
  const n = ss.B.length;
  const m = [];
  for (let i = 0; i < n; i += 1) {
    const row = [];
    for (let j = 0; j < n; j += 1) {
      row.push(i === j ? csub(s, cx(ss.A[i][j])) : cx(-ss.A[i][j]));
    }
    row.push(cx(ss.B[i]));
    m.push(row);
  }
  for (let col = 0; col < n; col += 1) {
    let piv = col;
    for (let r = col + 1; r < n; r += 1) {
      if (cabs(m[r][col]) > cabs(m[piv][col])) piv = r;
    }
    const swap = m[col]; m[col] = m[piv]; m[piv] = swap;
    for (let r = col + 1; r < n; r += 1) {
      const f = cdiv(m[r][col], m[col][col]);
      for (let c = col; c <= n; c += 1) m[r][c] = csub(m[r][c], cmul(f, m[col][c]));
    }
  }
  const x = new Array(n);
  for (let i = n - 1; i >= 0; i -= 1) {
    let acc = m[i][n];
    for (let j = i + 1; j < n; j += 1) acc = csub(acc, cmul(m[i][j], x[j]));
    x[i] = cdiv(acc, m[i][i]);
  }
  let y = cx(ss.D);
  for (let i = 0; i < n; i += 1) y = cadd(y, cscale(x[i], ss.C[i]));
  return y;
}

/**
 * Evaluate a transfer function at a complex s.
 * @param {{num:number[], den:number[]}} tf
 * @param {{re:number, im:number}} s
 * @returns {{re:number, im:number}}
 */
function tfEval(tf, s) {
  return cdiv(polyEvalComplex(tf.num, s), polyEvalComplex(tf.den, s));
}

// ---------------------------------------------------------------------------
// complex.js
// ---------------------------------------------------------------------------

test("complex: arithmetic against hand values", () => {
  // (1+2i)(3-4i) = 3 - 4i + 6i - 8i^2 = 11 + 2i
  const p = cmul(cx(1, 2), cx(3, -4));
  assertNear(p.re, 11, 1e-12, "cmul real part of (1+2i)(3-4i)");
  assertNear(p.im, 2, 1e-12, "cmul imag part of (1+2i)(3-4i)");

  // (1+2i)/(3-4i) = (1+2i)(3+4i)/25 = (3 + 4i + 6i - 8)/25 = (-5 + 10i)/25
  const q = cdiv(cx(1, 2), cx(3, -4));
  assertNear(q.re, -0.2, 1e-12, "cdiv real part of (1+2i)/(3-4i)");
  assertNear(q.im, 0.4, 1e-12, "cdiv imag part of (1+2i)/(3-4i)");

  assertNear(cadd(cx(1, 2), cx(-3, 5)).re, -2, 1e-12, "cadd real part");
  assertNear(cadd(cx(1, 2), cx(-3, 5)).im, 7, 1e-12, "cadd imag part");
  assertNear(csub(cx(1, 2), cx(-3, 5)).im, -3, 1e-12, "csub imag part");
  assertNear(cscale(cx(1.5, -2), 4).re, 6, 1e-12, "cscale real part");
  assertNear(cscale(cx(1.5, -2), 4).im, -8, 1e-12, "cscale imag part");

  assertNear(cabs(cx(3, -4)), 5, 1e-12, "cabs(3-4i)");
  assertNear(carg(cx(0, 1)), Math.PI / 2, 1e-12, "carg(i) in radians");
  assertNear(carg(cx(-1, 0)), Math.PI, 1e-12, "carg(-1) in radians");
  assertNear(cx(7).im, 0, 1e-12, "cx() defaults im to 0");
});

test("complex: cdiv guards division by zero", () => {
  // Contract: |b| == 0 -> {re: Infinity, im: 0}. Not NaN.
  const z = cdiv(cx(1, 1), cx(0, 0));
  assertEqual(z.re, Infinity, "cdiv by zero should return re = Infinity");
  assertEqual(z.im, 0, "cdiv by zero should return im = 0 (not NaN)");
});

// ---------------------------------------------------------------------------
// poly.js
// ---------------------------------------------------------------------------

test("poly: polyMul against hand expansion", () => {
  // (s^2 + 2s + 3)(s + 4) = s^3 + 6s^2 + 11s + 12
  assertArrayClose(polyMul([1, 2, 3], [1, 4]), [1, 6, 11, 12], 1e-12, "polyMul([1,2,3],[1,4])");
  // (2s^2 - 1)(s + 1) = 2s^3 + 2s^2 - s - 1
  assertArrayClose(polyMul([2, 0, -1], [1, 1]), [2, 2, -1, -1], 1e-12, "polyMul([2,0,-1],[1,1])");
  // multiplication by a scalar polynomial
  assertArrayClose(polyMul([3], [1, 5]), [3, 15], 1e-12, "polyMul([3],[1,5])");
});

test("poly: polyAdd right-aligns mismatched lengths", () => {
  // (s^2 + 2s + 3) + (4s + 5) = s^2 + 6s + 8
  assertArrayClose(polyAdd([1, 2, 3], [4, 5]), [1, 6, 8], 1e-12, "polyAdd([1,2,3],[4,5])");
  // order must not matter
  assertArrayClose(polyAdd([4, 5], [1, 2, 3]), [1, 6, 8], 1e-12, "polyAdd([4,5],[1,2,3])");
  // constant + cubic
  assertArrayClose(polyAdd([7], [1, 0, 0, 1]), [1, 0, 0, 8], 1e-12, "polyAdd([7],[1,0,0,1])");
  assertArrayClose(polyAdd([1, 2], [3, 4]), [4, 6], 1e-12, "polyAdd equal lengths");
});

test("poly: polyScale", () => {
  assertArrayClose(polyScale([1, 2, 3], 2), [2, 4, 6], 1e-12, "polyScale([1,2,3],2)");
  assertArrayClose(polyScale([1, -2], -0.5), [-0.5, 1], 1e-12, "polyScale([1,-2],-0.5)");
});

test("poly: polyTrim strips leading ~zeros relatively, not absolutely", () => {
  assertArrayClose(polyTrim([0, 0, 1, 2]), [1, 2], 1e-12, "polyTrim([0,0,1,2])");
  assertArrayClose(polyTrim([1, 2]), [1, 2], 1e-12, "polyTrim leaves a clean polynomial alone");
  // threshold is |c| < 1e-12 * max|c|; max is 3 so 1e-15 is noise
  assertArrayClose(polyTrim([0, 1e-15, 3]), [3], 1e-12, "polyTrim([0,1e-15,3]) should drop both leading terms");
  // 1e-11 relative to max 1 is ABOVE the 1e-12 threshold: it is a real coefficient
  assertArrayClose(polyTrim([1e-11, 1]), [1e-11, 1], 1e-12, "polyTrim must not drop a coefficient above the relative threshold");
});

test("poly: polyDeg", () => {
  assertEqual(polyDeg([1, 2, 3]), 2, "polyDeg([1,2,3])");
  assertEqual(polyDeg([2, 0, 0]), 2, "polyDeg([2,0,0]) - trailing zeros do not reduce the degree");
  assertEqual(polyDeg([0, 0, 7]), 0, "polyDeg([0,0,7]) after trimming leading zeros");
  assertEqual(polyDeg([5]), 0, "polyDeg of a constant");
  assertEqual(polyDeg([0, 0, 0]), -Infinity, "polyDeg of the zero polynomial");
});

test("poly: polyEvalComplex by hand", () => {
  // p(s) = s^2 + 2s + 3 at s = 1 + 2i:
  //   s^2 = -3 + 4i, 2s = 2 + 4i  ->  (-3+4i) + (2+4i) + 3 = 2 + 8i
  const a = polyEvalComplex([1, 2, 3], cx(1, 2));
  assertNear(a.re, 2, 1e-12, "polyEvalComplex([1,2,3], 1+2i) real part");
  assertNear(a.im, 8, 1e-12, "polyEvalComplex([1,2,3], 1+2i) imag part");

  // p(s) = 2s^3 - s^2 + 0s + 5 at s = i:
  //   2(-i) - (-1) + 5 = 6 - 2i
  const b = polyEvalComplex([2, -1, 0, 5], cx(0, 1));
  assertNear(b.re, 6, 1e-12, "polyEvalComplex([2,-1,0,5], i) real part");
  assertNear(b.im, -2, 1e-12, "polyEvalComplex([2,-1,0,5], i) imag part");

  // real argument still works
  const c = polyEvalComplex([1, 0, -4], cx(2, 0));
  assertNear(c.re, 0, 1e-12, "polyEvalComplex([1,0,-4], 2) is a root");
  assertNear(c.im, 0, 1e-12, "polyEvalComplex([1,0,-4], 2) imag part");
});

// ---------------------------------------------------------------------------
// roots.js
// ---------------------------------------------------------------------------

test("roots: distinct real roots", () => {
  // s^3 - 6s^2 + 11s - 6 = (s-1)(s-2)(s-3)
  const r = polyRoots([1, -6, 11, -6]);
  assertRootSet(r, [cx(3), cx(2), cx(1)], 1e-9, "polyRoots([1,-6,11,-6])");
  assertSortedByContract(r, "polyRoots([1,-6,11,-6]) ordering");
  for (const z of r) assertNear(z.im, 0, 1e-12, `real root ${fc(z)} should be snapped to exactly real`);
});

test("roots: pure imaginary pair", () => {
  // s^2 + 1 = 0
  const r = polyRoots([1, 0, 1]);
  assertRootSet(r, [cx(0, 1), cx(0, -1)], 1e-9, "polyRoots([1,0,1])");
  assertSortedByContract(r, "polyRoots([1,0,1]) ordering");
  assertNear(r[0].im + r[1].im, 0, 1e-12, "conjugate pair should sum to a real number");
});

test("roots: repeated roots (ill-conditioned; loose but honest tolerances)", () => {
  // (s+1)^2. A double root can only be located to about sqrt(eps) ~ 1e-8 in
  // double precision, so 1e-5 is the right order of tolerance here.
  const d = polyRoots([1, 2, 1]);
  assertRootSet(d, [cx(-1), cx(-1)], 1e-5, "polyRoots([1,2,1]) double root at -1");

  // (s+1)^3. A triple root is limited to about eps^(1/3) ~ 5e-6 by the
  // conditioning of the problem itself, and the iterates wander at that
  // radius, so 1e-3 is a deliberately generous but still meaningful bound.
  const t = polyRoots([1, 3, 3, 1]);
  assertRootSet(t, [cx(-1), cx(-1), cx(-1)], 1e-3, "polyRoots([1,3,3,1]) triple root at -1");
});

test("roots: trailing zero coefficients are exact roots at the origin", () => {
  // s^2 -> double root at 0, peeled off rather than iterated on
  const a = polyRoots([1, 0, 0]);
  assertRootSet(a, [cx(0), cx(0)], 1e-12, "polyRoots([1,0,0])");

  // s^3 + 11s^2 + 10s = s(s+1)(s+10)
  const b = polyRoots([1, 11, 10, 0]);
  assertRootSet(b, [cx(0), cx(-1), cx(-10)], 1e-9, "polyRoots([1,11,10,0])");
  assertSortedByContract(b, "polyRoots([1,11,10,0]) ordering");
});

test("roots: complex pairs from the quadratic formula", () => {
  // s^2 + 0.6s + 1 -> -0.3 +/- i*sqrt(3.64)/2
  const a = polyRoots([1, 0.6, 1]);
  const im1 = Math.sqrt(3.64) / 2; // 0.9539392014169457
  assertRootSet(a, [cx(-0.3, im1), cx(-0.3, -im1)], 1e-9, "polyRoots([1,0.6,1])");
  assertSortedByContract(a, "polyRoots([1,0.6,1]) ordering");

  // s^2 - s + 2 -> 0.5 +/- i*sqrt(7)/2
  const b = polyRoots([1, -1, 2]);
  const im2 = Math.sqrt(7) / 2; // 1.3228756555322954
  assertRootSet(b, [cx(0.5, im2), cx(0.5, -im2)], 1e-9, "polyRoots([1,-1,2])");
  assertSortedByContract(b, "polyRoots([1,-1,2]) ordering");
});

test("roots: degree <= 0 returns an empty array", () => {
  assertEqual(polyRoots([5]).length, 0, "polyRoots of a constant");
  assertEqual(polyRoots([0, 0, 3]).length, 0, "polyRoots([0,0,3]) trims to a constant");
});

// ---------------------------------------------------------------------------
// tf.js
// ---------------------------------------------------------------------------

test("tf: pidTF degenerate forms", () => {
  // Pure proportional: no extra dynamics at all.
  const p = pidTF(2.5, 0, 0);
  assertArrayClose(p.num, [2.5], 1e-12, "pidTF(2.5,0,0).num");
  assertArrayClose(p.den, [1], 1e-12, "pidTF(2.5,0,0).den");

  // PI: (Kp*s + Ki)/s, deliberately NOT the full form, so the pole/zero map
  // does not show a cancelling pair at -N.
  const pi = pidTF(2, 3, 0);
  assertArrayClose(pi.num, [2, 3], 1e-12, "pidTF(2,3,0).num");
  assertArrayClose(pi.den, [1, 0], 1e-12, "pidTF(2,3,0).den");
});

test("tf: pidTF full realizable form", () => {
  // C(s) = Kp + Ki/s + Kd*N*s/(s+N) over s(s+N):
  //   num = [Kp + Kd*N, Kp*N + Ki, Ki*N], den = [1, N, 0]
  // Kp=2, Ki=3, Kd=4, N=10 -> num [42, 23, 30], den [1, 10, 0]
  const c = pidTF(2, 3, 4, 10);
  assertArrayClose(c.num, [42, 23, 30], 1e-12, "pidTF(2,3,4,10).num");
  assertArrayClose(c.den, [1, 10, 0], 1e-12, "pidTF(2,3,4,10).den");

  // Pure derivative: Kd only. Ki === 0 but Kd !== 0, so the full form applies.
  // num = [0 + 1*100, 0*100 + 0, 0] = [100, 0, 0]
  const d = pidTF(0, 0, 1, 100);
  assertArrayClose(d.num, [100, 0, 0], 1e-12, "pidTF(0,0,1,100).num");
  assertArrayClose(d.den, [1, 100, 0], 1e-12, "pidTF(0,0,1,100).den");

  // Default N is 100.
  const e = pidTF(1, 1, 1);
  assertArrayClose(e.num, [101, 101, 100], 1e-12, "pidTF(1,1,1) with default N=100");
  assertArrayClose(e.den, [1, 100, 0], 1e-12, "pidTF(1,1,1) den with default N=100");
});

test("tf: series multiplies numerators and denominators", () => {
  // a = (s+2)/(s+3), b = 4/(s^2+5)
  // num = (s+2)*4          = 4s + 8
  // den = (s+3)(s^2+5)     = s^3 + 3s^2 + 5s + 15
  const ab = series({ num: [1, 2], den: [1, 3] }, { num: [4], den: [1, 0, 5] });
  assertArrayClose(ab.num, [4, 8], 1e-12, "series(...).num");
  assertArrayClose(ab.den, [1, 3, 5, 15], 1e-12, "series(...).den");
});

test("tf: closedLoop and errorTF on a worked example", () => {
  // L(s) = 2(s+2) / (s(s+3)) = (2s+4)/(s^2+3s)
  //   T = L/(1+L) = (2s+4) / (s^2+3s + 2s+4) = (2s+4)/(s^2+5s+4)
  //   E/R = 1/(1+L) = (s^2+3s) / (s^2+5s+4)
  const L = { num: [2, 4], den: [1, 3, 0] };
  const T = closedLoop(L);
  assertArrayClose(T.num, [2, 4], 1e-12, "closedLoop(L).num should be L.num");
  assertArrayClose(T.den, [1, 5, 4], 1e-12, "closedLoop(L).den = L.den + L.num");

  const E = errorTF(L);
  assertArrayClose(E.num, [1, 3, 0], 1e-12, "errorTF(L).num should be L.den");
  assertArrayClose(E.den, [1, 5, 4], 1e-12, "errorTF(L).den = L.den + L.num");

  // The simplest case, used everywhere else in the suite:
  // L = 1/(s(s+1)) -> T = 1/(s^2+s+1)
  const T2 = closedLoop({ num: [1], den: [1, 1, 0] });
  assertArrayClose(T2.num, [1], 1e-12, "closedLoop(1/(s^2+s)).num");
  assertArrayClose(T2.den, [1, 1, 1], 1e-12, "closedLoop(1/(s^2+s)).den");

  // Algebraic identity check at an arbitrary complex point: T = L/(1+L).
  const s = cx(0.7, 1.1);
  const Lv = tfEval(L, s);
  const want = cdiv(Lv, cadd(cx(1), Lv));
  const got = tfEval(T, s);
  assertNear(got.re, want.re, 1e-12, `closedLoop identity T = L/(1+L) at s=${fc(s)} (real part)`);
  assertNear(got.im, want.im, 1e-12, `closedLoop identity T = L/(1+L) at s=${fc(s)} (imag part)`);

  const wantE = cdiv(cx(1), cadd(cx(1), Lv));
  const gotE = tfEval(E, s);
  assertNear(gotE.re, wantE.re, 1e-12, `errorTF identity E = 1/(1+L) at s=${fc(s)} (real part)`);
  assertNear(gotE.im, wantE.im, 1e-12, `errorTF identity E = 1/(1+L) at s=${fc(s)} (imag part)`);
});

test("tf: dcGain", () => {
  // 1/(s^2+0.6s+1) at s=0 is 1/1
  assertClose(dcGain({ num: [1], den: [1, 0.6, 1] }), 1, 1e-12, "dcGain of 1/(s^2+0.6s+1)");
  // (2s+4)/(s^2+5s+4) at s=0 is 4/4
  assertClose(dcGain({ num: [2, 4], den: [1, 5, 4] }), 1, 1e-12, "dcGain of (2s+4)/(s^2+5s+4)");
  // 3/(2s+6) at s=0 is 3/6
  assertClose(dcGain({ num: [3], den: [2, 6] }), 0.5, 1e-12, "dcGain of 3/(2s+6)");
  // Pole at the origin -> no DC gain at all.
  assertNull(dcGain({ num: [1], den: [1, 1, 0] }), "dcGain of 1/(s^2+s) must be null (pole at the origin)");
  assertNull(dcGain({ num: [1], den: [1, 0, 0] }), "dcGain of 1/s^2 must be null");
});

test("tf: polesZeros", () => {
  // (s+3)/((s+1)(s+2))
  const pz = polesZeros({ num: [1, 3], den: [1, 3, 2] });
  assertRootSet(pz.zeros, [cx(-3)], 1e-9, "polesZeros zeros");
  assertRootSet(pz.poles, [cx(-1), cx(-2)], 1e-9, "polesZeros poles");
});

test("tf: toStateSpace with direct feedthrough", () => {
  // T(s) = (2s^2 + 3s + 4) / (s^2 + 5s + 6).  deg num == deg den.
  //   b0 = 2, b1 = 3, b2 = 4 ; a1 = 5, a2 = 6
  //   D  = b0 = 2
  //   b'_1 = b1 - b0*a1 = 3 - 10 = -7
  //   b'_2 = b2 - b0*a2 = 4 - 12 = -8
  //   A = [[0,1],[-6,-5]] ; B = [0,1] ; C = [b'_2, b'_1] = [-8,-7]
  // The point of this test: C must be the corrected numerator, NOT [3,4]
  // (or [4,3]) taken straight from `num`.
  const tf = { num: [2, 3, 4], den: [1, 5, 6] };
  const ss = toStateSpace(tf);
  assert(ss !== null, "toStateSpace of a proper TF must not be null");

  assertClose(ss.D, 2, 1e-12, "D must equal b0 = 2 for a system with direct feedthrough");
  assertArrayClose(ss.C, [-8, -7], 1e-12, "C must be [b_n - b0*a_n, ...] = [-8,-7], not the raw numerator");
  assertArrayClose(ss.B, [0, 1], 1e-12, "B of the controllable canonical form");
  assertEqual(ss.A.length, 2, "A must be 2x2");
  assertArrayClose(ss.A[0], [0, 1], 1e-12, "A row 0 (superdiagonal one)");
  assertArrayClose(ss.A[1], [-6, -5], 1e-12, "A bottom row = [-a2, -a1]");

  // Independent check: C(sI-A)^-1 B + D must equal num(s)/den(s).
  for (const s of [cx(1.3, 0.7), cx(-0.4, 2.2), cx(3, -1)]) {
    const got = ssEvalComplex(ss, s);
    const want = tfEval(tf, s);
    assertNear(got.re, want.re, 1e-10, `C(sI-A)^-1 B + D at s=${fc(s)} (real part)`);
    assertNear(got.im, want.im, 1e-10, `C(sI-A)^-1 B + D at s=${fc(s)} (imag part)`);
  }
});

test("tf: toStateSpace normalises a non-monic denominator", () => {
  // T(s) = (4s + 2)/(2s^2 + 6s + 8) = (2s + 1)/(s^2 + 3s + 4)
  //   b0 = 0 (strictly proper) so D = 0 and C is the numerator itself,
  //   reversed: C = [b'_2, b'_1] = [1, 2]
  const tf = { num: [4, 2], den: [2, 6, 8] };
  const ss = toStateSpace(tf);
  assert(ss !== null, "toStateSpace of a strictly proper TF must not be null");
  assertClose(ss.D, 0, 1e-12, "D must be 0 for a strictly proper system");
  assertArrayClose(ss.C, [1, 2], 1e-12, "C after normalising den to monic");
  assertArrayClose(ss.A[1], [-4, -3], 1e-12, "A bottom row after normalising den to monic");

  const s = cx(0.9, -1.4);
  const got = ssEvalComplex(ss, s);
  const want = tfEval(tf, s);
  assertNear(got.re, want.re, 1e-10, `non-monic realisation at s=${fc(s)} (real part)`);
  assertNear(got.im, want.im, 1e-10, `non-monic realisation at s=${fc(s)} (imag part)`);
});

test("tf: toStateSpace rejects an improper transfer function", () => {
  // deg num (2) > deg den (1)
  assertNull(toStateSpace({ num: [1, 0, 0], den: [1, 1] }), "toStateSpace of an improper TF must be null");
});

// ---------------------------------------------------------------------------
// sim.js
// ---------------------------------------------------------------------------

test("sim: chooseHorizon from the slowest stable pole", () => {
  // 1/(s^2+0.6s+1): poles -0.3 +/- 0.954i, sigma = 0.3, tEnd = 8/0.3
  const a = chooseHorizon({ num: [1], den: [1, 0.6, 1] });
  assertEqual(a.stable, true, "1/(s^2+0.6s+1) is stable");
  assertClose(a.tEnd, 8 / 0.3, 1e-9, "chooseHorizon tEnd = 8/sigma for sigma = 0.3");

  // 1/(s+1): sigma = 1, tEnd = 8
  const b = chooseHorizon({ num: [1], den: [1, 1] });
  assertEqual(b.stable, true, "1/(s+1) is stable");
  assertClose(b.tEnd, 8, 1e-9, "chooseHorizon tEnd = 8 for sigma = 1");

  // 1/(s^2-s+1): poles at 0.5 +/- 0.866i -> unstable, horizon capped at 30
  const c = chooseHorizon({ num: [1], den: [1, -1, 2] });
  assertEqual(c.stable, false, "1/(s^2-s+2) is unstable");
  assert(c.tEnd >= 0.5 && c.tEnd <= 30, `unstable horizon must be clamped to [0.5, 30], got ${c.tEnd}`);

  // Pole at the origin counts as not stable (Re >= -1e-9).
  const d = chooseHorizon({ num: [1], den: [1, 1, 0] });
  assertEqual(d.stable, false, "1/(s^2+s) has a pole at the origin, so stable must be false");
});

test("sim: stepResponse trace shape", () => {
  const tf = secondOrder(0.5, 1);
  const tr = stepResponse(tf);
  assert(Array.isArray(tr.t) && Array.isArray(tr.y), "stepResponse must return t and y arrays");
  assertEqual(tr.t.length, tr.y.length, "t and y must be the same length");
  assert(tr.t.length > 100, `default trace should have hundreds of samples, got ${tr.t.length}`);
  assertNear(tr.t[0], 0, 1e-12, "trace must start at t = 0");
  assertNear(tr.y[0], 0, 1e-12, "a strictly proper system starts at y(0) = 0");
  assertClose(tr.t[tr.t.length - 1], tr.tEnd, 1e-9, "trace must end exactly at tEnd");
  for (let i = 1; i < tr.t.length; i += 1) {
    assert(tr.t[i] > tr.t[i - 1], `time vector must be strictly increasing (broke at index ${i})`);
  }

  // The RK4 trace itself must track the closed form.
  for (const i of [10, 100, 400, tr.t.length - 1]) {
    const want = secondOrderStep(tr.t[i], 0.5, 1);
    assertNear(tr.y[i], want, 1e-6, `RK4 y(t=${tr.t[i]}) vs closed form, index ${i}`);
  }
});

// Analytic ground truth for G = wn^2/(s^2 + 2*zeta*wn*s + wn^2):
//   Mp = 100*exp(-pi*zeta/sqrt(1-zeta^2))     (exact)
//   tp = pi/(wn*sqrt(1-zeta^2))               (exact)
//   ts is taken from the closed form by root-finding, NOT from the textbook
//   4/(zeta*wn) rule — that rule is only a rough envelope estimate and is 16%
//   high at zeta = 0.3 (11.23 s actual vs 13.33 s from the rule). A 10% test
//   against 4/(zeta*wn) would therefore be encoding a wrong answer. The rule
//   is still checked below, at the ~25% accuracy it actually has.
for (const zeta of [0.3, 0.5, 0.7]) {
  for (const wn of [1, 5]) {
    test(`sim: second-order metrics, zeta=${zeta} wn=${wn}`, () => {
      const tf = secondOrder(zeta, wn);
      // A fine record grid: peakTime is quantised to the recorded samples
      // (the contract only interpolates rise and settling times), so the grid
      // has to be finer than the 0.5% tolerance we are asserting.
      const tr = stepResponse(tf, { n: 8000 });
      const m = stepMetrics(tf, tr);
      assertNoBadNumbers(m, `stepMetrics(zeta=${zeta}, wn=${wn})`);

      assertEqual(m.stable, true, `zeta=${zeta} wn=${wn} is stable`);
      assertClose(m.finalValue, 1, 1e-6, `final value of a unit-DC-gain plant (zeta=${zeta}, wn=${wn})`);
      assertNear(m.steadyStateError, 0, 1e-5, `steady-state error = 1 - finalValue (zeta=${zeta}, wn=${wn})`);

      const Mp = 100 * Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta));
      assertClose(m.overshoot, Mp, 5e-3, `overshoot vs 100*exp(-pi*zeta/sqrt(1-zeta^2)) (zeta=${zeta}, wn=${wn})`);
      assertClose(m.peakValue, 1 + Mp / 100, 5e-3, `peak value = 1 + Mp/100 (zeta=${zeta}, wn=${wn})`);

      const tp = Math.PI / (wn * Math.sqrt(1 - zeta * zeta));
      assertClose(m.peakTime, tp, 5e-3, `peak time vs pi/(wn*sqrt(1-zeta^2)) (zeta=${zeta}, wn=${wn})`);

      const tsExact = exactSettlingTime(zeta, wn);
      assertClose(m.settlingTime, tsExact, 1e-2, `2% settling time vs the closed-form last band exit (zeta=${zeta}, wn=${wn})`);

      // Sanity check on the textbook rule of thumb, at its real accuracy.
      const tsRule = 4 / (zeta * wn);
      assertClose(m.settlingTime, tsRule, 0.25, `2% settling time vs the 4/(zeta*wn) rule of thumb (approximate; zeta=${zeta}, wn=${wn})`);
    });
  }
}

test("sim: first-order 1/(s+1) has exact logarithmic metrics", () => {
  // y(t) = 1 - e^-t.  10% at ln(10/9), 90% at ln(10): rise = ln 9 = 2.1972246
  // 2% band exit at e^-t = 0.02: ts = ln 50 = 3.9120230
  const tf = { num: [1], den: [1, 1] };
  const tr = stepResponse(tf, { n: 8000 });
  const m = stepMetrics(tf, tr);
  assertNoBadNumbers(m, "stepMetrics of 1/(s+1)");

  assertEqual(m.stable, true, "1/(s+1) is stable");
  assertClose(m.finalValue, 1, 1e-6, "final value of 1/(s+1)");
  assertNear(m.steadyStateError, 0, 1e-5, "steady-state error of 1/(s+1)");
  assertClose(m.riseTime, Math.log(9), 1e-3, "10%-90% rise time of 1/(s+1) = ln 9");
  assertClose(m.settlingTime, Math.log(50), 1e-3, "2% settling time of 1/(s+1) = ln 50");

  assert(m.overshoot !== null, "overshoot must be a number when finalValue is 1, not null");
  assert(m.overshoot <= 0.1, `a first-order lag must not overshoot; got ${m.overshoot}%`);
});

test("sim: unstable plant reports stable === false", () => {
  // 1/(s^2 - s + 2): poles at 0.5 +/- 1.3229i, both in the right half plane.
  const tf = { num: [1], den: [1, -1, 2] };
  const tr = stepResponse(tf);
  const m = stepMetrics(tf, tr);
  assertEqual(m.stable, false, "1/(s^2-s+2) must report stable === false");
  assertNoBadNumbers(m, "stepMetrics of an unstable plant must not leak NaN/Infinity");
});

test("sim: pole at the origin gives nulls, never NaN", () => {
  // 1/(s^2+s) = 1/(s(s+1)) is a type-1 system: the step response ramps away
  // and there is no final value, so every metric defined relative to it is
  // null by the contract.
  const tf = { num: [1], den: [1, 1, 0] };
  const tr = stepResponse(tf);
  const m = stepMetrics(tf, tr);

  assertEqual(m.stable, false, "a pole at the origin is not stable");
  assertNull(m.finalValue, "finalValue must be null when there is no steady state");
  assertNull(m.overshoot, "overshoot is relative to finalValue, so it must be null");
  assertNull(m.riseTime, "riseTime is 10%-90% of finalValue, so it must be null");
  assertNull(m.settlingTime, "settlingTime is a band around finalValue, so it must be null");
  assertNull(m.steadyStateError, "steadyStateError is 1 - finalValue, so it must be null");
  assertNoBadNumbers(m, "stepMetrics of 1/(s^2+s) must not leak NaN/Infinity");
  for (const v of tr.y) assert(Number.isFinite(v), "the step trace itself must stay finite");
});

test("sim: steady-state error of a plant whose DC gain is not 1", () => {
  // 1/((s+1)(s+2)) has DC gain 0.5, so ess = 1 - 0.5 = 0.5 for a unit step.
  const tf = { num: [1], den: [1, 3, 2] };
  const m = stepMetrics(tf, stepResponse(tf, { n: 4000 }));
  assertClose(m.finalValue, 0.5, 1e-5, "finalValue = DC gain of 1/((s+1)(s+2))");
  assertClose(m.steadyStateError, 0.5, 1e-4, "steadyStateError must be 1 - finalValue, not a normalised error");
  assert(m.overshoot <= 0.1, `an overdamped system must not overshoot; got ${m.overshoot}%`);
});

// ---------------------------------------------------------------------------
// freq.js
// ---------------------------------------------------------------------------

test("freq: logspace endpoints and spacing", () => {
  const g = logspace(-2, 2, 5);
  assertArrayClose(g, [0.01, 0.1, 1, 10, 100], 1e-12, "logspace(-2,2,5)");
  const h = logspace(-1, 1, 3);
  assertArrayClose(h, [0.1, 1, 10], 1e-12, "logspace(-1,1,3)");
  const big = logspace(-3, 3, 601);
  assertEqual(big.length, 601, "logspace must return exactly n points");
  assertClose(big[0], 1e-3, 1e-12, "logspace lower endpoint");
  assertClose(big[600], 1e3, 1e-12, "logspace upper endpoint");
});

test("freq: frequencyResponse of 1/(s+1) at hand-checked points", () => {
  // |L(j1)| = 1/sqrt(2) = 0.70710678, -3.0103 dB, phase -45 deg
  const r = frequencyResponse({ num: [1], den: [1, 1] }, [0.001, 1, 1000]);
  assertClose(r.mag[1], Math.SQRT1_2, 1e-10, "|1/(j+1)| = 1/sqrt(2)");
  assertClose(r.magDb[1], 20 * Math.log10(Math.SQRT1_2), 1e-10, "magnitude in dB at w = 1");
  assertClose(r.phaseDeg[1], -45, 1e-9, "phase of 1/(s+1) at w = 1 is -45 deg");

  assertClose(r.mag[0], 1 / Math.hypot(1, 0.001), 1e-10, "|1/(s+1)| at w = 0.001");
  assertNear(r.phaseDeg[0], -(Math.atan(0.001) * 180) / Math.PI, 1e-9, "phase at w = 0.001");
  assertNear(r.phaseDeg[2], -(Math.atan(1000) * 180) / Math.PI, 1e-9, "phase at w = 1000 approaches -90 deg");

  for (let i = 0; i < r.w.length; i += 1) {
    assertClose(r.magDb[i], 20 * Math.log10(r.mag[i]), 1e-9, `magDb must be 20*log10(mag) at index ${i}`);
  }
});

test("freq: phase is unwrapped - monotone and no jumps", () => {
  // 1/(s(s+1)(s+2)) sweeps from -90 deg to -270 deg. A wrap bug shows up
  // either as a +360 step or as the phase folding back upwards.
  const w = logspace(-3, 3, 600);
  const r = frequencyResponse({ num: [1], den: [1, 3, 2, 0] }, w);

  assertNear(r.phaseDeg[0], -90, 0.2, "phase at w = 1e-3 should be just under -90 deg");
  assertNear(r.phaseDeg[599], -270, 0.5, "phase at w = 1e3 should be just above -270 deg");

  for (let i = 1; i < r.phaseDeg.length; i += 1) {
    const d = r.phaseDeg[i] - r.phaseDeg[i - 1];
    assert(
      d <= 1e-9,
      `unwrapped phase must decrease monotonically for 1/(s(s+1)(s+2)); rose by ${d.toFixed(4)} deg` +
      `\n    index ${i}, w = ${w[i]}\n    phase[i-1] = ${r.phaseDeg[i - 1]}\n    phase[i]   = ${r.phaseDeg[i]}`
    );
    assert(
      Math.abs(d) <= 30,
      `unwrapped phase jumped by ${d.toFixed(4)} deg between adjacent grid points - that is a wrap bug` +
      `\n    index ${i}, w = ${w[i]}\n    phase[i-1] = ${r.phaseDeg[i - 1]}\n    phase[i]   = ${r.phaseDeg[i]}`
    );
  }
});

test("freq: autoFreqRange returns decade exponents padded by two decades", () => {
  // 1/((s+1)(s+10)): |p| in {1, 10} -> log10 in {0, 1} -> [-2, 3]
  const r = autoFreqRange({ num: [1], den: [1, 11, 10] });
  assertClose(r.lo, -2, 1e-12, "autoFreqRange lo = log10(min |p|) - 2");
  assertClose(r.hi, 3, 1e-12, "autoFreqRange hi = log10(max |p|) + 2");

  // 1/(s^2+0.6s+1): both poles have magnitude 1 -> [-2, 2]
  const s = autoFreqRange({ num: [1], den: [1, 0.6, 1] });
  assertClose(s.lo, -2, 1e-12, "autoFreqRange lo for unit-magnitude poles");
  assertClose(s.hi, 2, 1e-12, "autoFreqRange hi for unit-magnitude poles");

  // Clamped to [-3, 4]: |p| = 1e-4 would want lo = -6.
  const c = autoFreqRange({ num: [1], den: [1, 1e-4] });
  assert(c.lo >= -3 - 1e-12, `autoFreqRange lo must be clamped at -3, got ${c.lo}`);
  assert(c.hi <= 4 + 1e-12, `autoFreqRange hi must be clamped at 4, got ${c.hi}`);
});

test("freq: margins of L = 1/(s(s+1))", () => {
  // |L(jw)| = 1/(w*sqrt(w^2+1)) = 1  ->  w^4 + w^2 - 1 = 0
  //   w^2 = (sqrt(5)-1)/2 = 0.6180339887, wgc = 0.7861513778
  // phase = -90 - atan(wgc) = -128.1727076 deg, PM = 51.8272924 deg
  // The phase approaches -180 deg only asymptotically, so it never crosses:
  // the gain margin is undefined, not infinite and certainly not NaN.
  const m = margins({ num: [1], den: [1, 1, 0] });
  assertNoBadNumbers(m, "margins of 1/(s(s+1))");
  assertClose(m.gainCrossoverW, 0.7861513777574233, 1e-3, "gain crossover of 1/(s(s+1))");
  assertClose(m.phaseMarginDeg, 51.827292372987756, 1e-3, "phase margin of 1/(s(s+1))");
  assertNull(m.gainMargin, "1/(s(s+1)) has no phase crossover, so gainMargin must be null");
  assertNull(m.gainMarginDb, "1/(s(s+1)) has no phase crossover, so gainMarginDb must be null");
  assertNull(m.phaseCrossoverW, "1/(s(s+1)) never reaches -180 deg, so phaseCrossoverW must be null");
});

test("freq: margins of L = 1/(s(s+1)(s+2))", () => {
  // den(jw) = -3w^2 + j*w*(2 - w^2).
  //   Phase crossover: imaginary part zero -> w = sqrt(2) = 1.41421356,
  //   where |den| = 6, so the gain margin is exactly 6 (15.5630250 dB).
  //   Gain crossover: 9u^2 + u(2-u)^2 = 1 with u = w^2, i.e.
  //   u^3 + 5u^2 + 4u - 1 = 0 -> u = 0.1986912435, w = 0.4457479596.
  //   (Note: 0.446287 is NOT the crossover; 0.4457480 is the value consistent
  //   with the textbook phase margin of 53.4108 deg quoted for this system.)
  //   PM = 180 - 90 - atan(w) - atan(w/2) = 53.4107862 deg.
  const m = margins({ num: [1], den: [1, 3, 2, 0] });
  assertNoBadNumbers(m, "margins of 1/(s(s+1)(s+2))");
  assertClose(m.phaseCrossoverW, Math.SQRT2, 1e-3, "phase crossover of 1/(s(s+1)(s+2)) is sqrt(2)");
  assertClose(m.gainMargin, 6, 1e-3, "linear gain margin of 1/(s(s+1)(s+2)) is exactly 6");
  assertClose(m.gainMarginDb, 15.563025007672874, 1e-3, "gain margin in dB = 20*log10(6)");
  assertClose(m.gainCrossoverW, 0.4457479596318946, 1e-3, "gain crossover of 1/(s(s+1)(s+2))");
  assertClose(m.phaseMarginDeg, 53.410786177699194, 1e-3, "phase margin of 1/(s(s+1)(s+2))");

  // Bisection, not nearest-grid-point: check the crossover really satisfies
  // |L| = 1 rather than merely landing near it.
  const r = frequencyResponse({ num: [1], den: [1, 3, 2, 0] }, [m.gainCrossoverW]);
  assertClose(r.mag[0], 1, 1e-6, "|L| at the reported gain crossover must be 1 to bisection accuracy");
});

test("freq: margins are null when the loop never crosses", () => {
  // |1/(jw+1)| < 1 for every w > 0 and the phase only reaches -90 deg.
  const m = margins({ num: [1], den: [1, 1] });
  assertNoBadNumbers(m, "margins of 1/(s+1)");
  assertNull(m.gainCrossoverW, "|1/(s+1)| never reaches 1, so gainCrossoverW must be null");
  assertNull(m.phaseMarginDeg, "with no gain crossover the phase margin must be null");
  assertNull(m.phaseCrossoverW, "1/(s+1) never reaches -180 deg, so phaseCrossoverW must be null");
  assertNull(m.gainMargin, "with no phase crossover the gain margin must be null");
  assertNull(m.gainMarginDb, "with no phase crossover the dB gain margin must be null");
});

// ---------------------------------------------------------------------------
// rlocus.js
// ---------------------------------------------------------------------------

test("rlocus: branch structure and k sweep", () => {
  const L = { num: [1], den: [1, 3, 2, 0] };
  const lc = rootLocus(L);
  assertEqual(lc.branches.length, 3, "a third-order loop has three closed-loop poles, so three branches");
  assertEqual(lc.k.length, 201, "default sweep is k = 0 plus 200 log-spaced gains");
  assertEqual(lc.k[0], 0, "the sweep must start at k = 0");
  assertClose(lc.k[1], 1e-3, 1e-9, "the log sweep starts at 1e-3");
  assertClose(lc.k[lc.k.length - 1], 1e3, 1e-9, "the log sweep ends at 1e3");
  for (let i = 0; i < lc.branches.length; i += 1) {
    assertEqual(lc.branches[i].length, lc.k.length, `branch ${i} must have one point per gain`);
  }

  // At k = 0 the closed-loop poles are the open-loop poles: 0, -1, -2.
  const start = lc.branches.map((b) => b[0]);
  assertRootSet(start, [cx(0), cx(-1), cx(-2)], 1e-9, "branch start points at k = 0");
});

test("rlocus: branches are continuity-sorted, not re-sorted per gain", () => {
  // Between adjacent gains on this sweep the true root motion never exceeds
  // ~0.23 in the complex plane (measured: the largest step is at the top of
  // the k range, where the asymptotic branches are moving fastest). A branch
  // swap at the imaginary-axis crossing would show up as a jump of ~2.83
  // (between +j1.414 and -j1.414) or ~4.4 (onto the real branch at -3), so a
  // 0.6 threshold separates real motion from a sorting bug cleanly.
  const lc = rootLocus({ num: [1], den: [1, 3, 2, 0] });
  const limit = 0.6;
  let worst = 0;
  let worstAt = "";
  for (let b = 0; b < lc.branches.length; b += 1) {
    const br = lc.branches[b];
    for (let i = 1; i < br.length; i += 1) {
      const d = Math.hypot(br[i].re - br[i - 1].re, br[i].im - br[i - 1].im);
      assert(Number.isFinite(d), `branch ${b} point ${i} is not finite: ${fc(br[i])}`);
      if (d > worst) { worst = d; worstAt = `branch ${b}, k[${i}] = ${lc.k[i]}, ${fc(br[i - 1])} -> ${fc(br[i])}`; }
    }
  }
  assert(worst <= limit, `root-locus branch discontinuity: largest adjacent step ${worst.toFixed(5)} > ${limit}\n    at ${worstAt}`);
});

test("rlocus: criticalGain cross-checks the frequency-domain gain margin", () => {
  // This is the strongest test in the suite: two completely independent
  // computations of the same physical quantity must agree.
  //
  //   Routh on s^3 + 3s^2 + 2s + k = 0 gives marginal stability at k = 6,
  //   with the roots on the imaginary axis at s = +/- j*sqrt(2).
  //
  //   Path 1 - rlocus.criticalGain: bisects on max Re(closed-loop root)
  //            crossing zero, purely in the s-plane.
  //   Path 2 - freq.margins: finds where the open-loop phase hits -180 deg
  //            and reports 1/|L| there, purely in the frequency domain.
  //
  // They share no code beyond polynomial evaluation, so agreement is real
  // evidence that both are right.
  const L = { num: [1], den: [1, 3, 2, 0] };

  const cg = criticalGain(L);
  assert(cg !== null, "1/(s(s+1)(s+2)) does cross into the RHP, so criticalGain must not be null");
  assertClose(cg.k, 6, 1e-3, "critical gain from the root locus (Routh: exactly 6)");
  assertClose(cg.w, Math.SQRT2, 1e-3, "imaginary-axis crossing frequency from the root locus (Routh: sqrt(2))");

  const m = margins(L);
  assertClose(cg.k, m.gainMargin, 2e-3, "CROSS-CHECK: root-locus critical gain vs frequency-domain gain margin");
  assertClose(cg.w, m.phaseCrossoverW, 2e-3, "CROSS-CHECK: root-locus crossing frequency vs phase-crossover frequency");

  // Third, independent confirmation: the closed-loop characteristic
  // polynomial at k = 6 must factor as (s+3)(s^2+2).
  const r = polyRoots(polyAdd(L.den, polyScale(L.num, 6)));
  assertRootSet(r, [cx(0, Math.SQRT2), cx(0, -Math.SQRT2), cx(-3)], 1e-8, "roots of s^3+3s^2+2s+6");
});

test("rlocus: criticalGain is null when the locus stays in the LHP", () => {
  // den + k*num = s + 1 + k, whose root -(1+k) is in the left half plane for
  // every k >= 0.
  assertNull(criticalGain({ num: [1], den: [1, 1] }), "1/(s+1) never goes unstable, so criticalGain must be null");
});
