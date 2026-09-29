/**
 * Tests for the derived analysis in src/ui/store.js.
 *
 * The store is DOM-free, so Node imports it unchanged. It is a module-level
 * singleton: each test sets every piece of state it depends on rather than
 * relying on what an earlier test left behind.
 */

import { test, assert, assertEqual, assertClose, assertNear } from "./harness.mjs";

import { analyse, setGains, setPlant } from "../src/ui/store.js";
import { cabs } from "../src/core/complex.js";
import { polyEvalComplex } from "../src/core/poly.js";

/**
 * Relative residual of a polynomial at a point, so "is a root" can be asserted
 * without trusting the root finder that produced the point.
 * @param {number[]} p coefficients, descending powers
 * @param {{re:number, im:number}} z candidate root
 * @returns {number} |p(z)| / sum_k |p_k| |z|^(n-k)
 */
function relResidual(p, z) {
  let scale = 0;
  const r = cabs(z);
  for (let k = 0; k < p.length; k += 1) scale += Math.abs(p[k]) * Math.pow(r, p.length - 1 - k);
  return cabs(polyEvalComplex(p, z)) / scale;
}

test("store: dominant pole of the default design", () => {
  // Plant 1/(s^2 + 0.6s + 1) under Kp = 1 closes to 1/(s^2 + 0.6s + 2):
  //   poles -0.3 +/- j*sqrt(1.91), wn = sqrt(2), zeta = 0.3/sqrt(2)
  setPlant({ key: "second-order" });
  setGains({ Kp: 1, Ki: 0, Kd: 0, N: 100 });
  const d = analyse().dominant;
  assertNear(d.pole.re, -0.3, 1e-9, "real part of the dominant pole");
  assertNear(d.pole.im, Math.sqrt(1.91), 1e-9, "imaginary part, reported from the upper half-plane");
  assertClose(d.wn, Math.SQRT2, 1e-9, "natural frequency sqrt(2)");
  assertClose(d.zeta, 0.3 / Math.SQRT2, 1e-9, "damping ratio 0.3/sqrt(2)");
});

test("store: a nearly cancelled pole is not reported as dominant", () => {
  // Kp=12, Ki=4, Kd=3, N=100 on 1/(s^2 + 0.6s + 1). By hand:
  //   C(s) = (312s^2 + 1204s + 400)/(s^2 + 100s)
  //   den  = (s^2 + 100s)(s^2 + 0.6s + 1) + 312s^2 + 1204s + 400
  //        = s^4 + 100.6s^3 + 373s^2 + 1304s + 400
  //   zeros of 312s^2 + 1204s + 400: (-1204 +/- sqrt(950416))/624
  // The closed loop has a slow real pole just beside the zero near -0.367. It is the
  // pole closest to the imaginary axis, but its residue is tiny; the response
  // (22.6% overshoot) is shaped by the complex pair.
  setPlant({ key: "second-order" });
  setGains({ Kp: 12, Ki: 4, Kd: 3, N: 100 });
  const a = analyse();
  const den = [1, 100.6, 373, 1304, 400];
  const zero = (-1204 + Math.sqrt(950416)) / 624;

  let nearest = a.poles[0];
  for (const p of a.poles) if (p.re > nearest.re) nearest = p;
  assertNear(nearest.im, 0, 1e-12, "the pole closest to the axis is real");
  assert(Math.abs(nearest.re - zero) < 0.1 * Math.abs(zero),
    `the pole closest to the axis (${nearest.re}) sits within 10% of the zero at ${zero}`);

  const d = a.dominant;
  assert(d.pole.im > 0.5, `the dominant pole must be the complex pair, got ${d.pole.re} + ${d.pole.im}i`);
  assert(relResidual(den, d.pole) < 1e-12, "the dominant pole is a root of the hand-derived denominator");
  assertClose(d.zeta, -d.pole.re / cabs(d.pole), 1e-12, "zeta = -Re(p)/|p|");
  assert(d.zeta > 0.3 && d.zeta < 0.7, `an underdamped zeta is consistent with 22.6% overshoot, got ${d.zeta}`);
});

test("store: an unstable loop's dominant pole is its rightmost pole", () => {
  // 1/(s^2 - s + 2) under Kp = 1 closes to 1/(s^2 - s + 3): poles 0.5 +/- j*sqrt(11)/2.
  setPlant({ key: "unstable" });
  setGains({ Kp: 1, Ki: 0, Kd: 0, N: 100 });
  const a = analyse();
  assertEqual(a.stable, false, "1/(s^2 - s + 3) is unstable");
  assertNear(a.dominant.pole.re, 0.5, 1e-9, "the dominant pole is the right-half-plane pair");
  assert(a.dominant.zeta < 0, "a right-half-plane pole has a negative damping ratio");
});
