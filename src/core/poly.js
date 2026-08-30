/**
 * Dense real polynomial arithmetic.
 *
 * Polynomials are `number[]` in DESCENDING powers throughout the whole project:
 * `[1, 2, 3]` is `s^2 + 2s + 3`. The leading coefficient is always index 0.
 *
 * This module is DOM-free.
 */

import { cx, cadd, cmul } from "./complex.js";

/**
 * @typedef {import("./complex.js").Complex} Complex
 */

/**
 * Relative magnitude below which a coefficient counts as zero.
 * Relative, not absolute, so scaling a polynomial by 1e-6 does not erase it.
 */
const TRIM_EPS = 1e-12;

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
 * Multiply two polynomials (discrete convolution of the coefficient vectors).
 * @param {number[]} a Left operand, descending powers.
 * @param {number[]} b Right operand, descending powers.
 * @returns {number[]} The product, descending powers. Empty if either input is empty.
 */
export function polyMul(a, b) {
  if (a.length === 0 || b.length === 0) return [];
  const out = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i];
    if (ai === 0) continue;
    for (let j = 0; j < b.length; j++) {
      out[i + j] += ai * b[j];
    }
  }
  return out;
}

/**
 * Add two polynomials.
 *
 * Because coefficients are stored in descending powers, operands of different
 * length are RIGHT-aligned so that equal powers of `s` line up.
 *
 * @param {number[]} a Left operand, descending powers.
 * @param {number[]} b Right operand, descending powers.
 * @returns {number[]} The sum, with length `max(a.length, b.length)`.
 */
export function polyAdd(a, b) {
  const n = Math.max(a.length, b.length);
  const out = new Array(n).fill(0);
  for (let i = 0; i < a.length; i++) out[n - a.length + i] += a[i];
  for (let i = 0; i < b.length; i++) out[n - b.length + i] += b[i];
  return out;
}

/**
 * Scale every coefficient of a polynomial by a real factor.
 * @param {number[]} a Coefficients, descending powers.
 * @param {number} k Scale factor.
 * @returns {number[]} A new array holding `k * a`.
 */
export function polyScale(a, k) {
  return a.map((c) => c * k);
}

/**
 * Drop leading coefficients that are negligible relative to the largest one.
 *
 * Keeps at least one coefficient, so the zero polynomial trims to `[0]` and the
 * empty array trims to itself.
 *
 * @param {number[]} a Coefficients, descending powers.
 * @returns {number[]} A new array with the leading near-zero coefficients removed.
 */
export function polyTrim(a) {
  if (a.length === 0) return [];
  const scale = maxAbs(a);
  if (scale === 0) return [0];
  const tol = TRIM_EPS * scale;
  let i = 0;
  while (i < a.length - 1 && Math.abs(a[i]) <= tol) i++;
  return a.slice(i);
}

/**
 * Evaluate a real polynomial at a complex point using Horner's rule.
 * @param {number[]} p Coefficients, descending powers.
 * @param {Complex} s Point at which to evaluate.
 * @returns {Complex} `p(s)`. Returns 0 for an empty coefficient array.
 */
export function polyEvalComplex(p, s) {
  let acc = cx(0, 0);
  for (let i = 0; i < p.length; i++) {
    acc = cadd(cmul(acc, s), cx(p[i], 0));
  }
  return acc;
}

/**
 * Degree of a polynomial, ignoring negligible leading coefficients.
 * @param {number[]} a Coefficients, descending powers.
 * @returns {number} The degree, or `-Infinity` for the zero (or empty) polynomial.
 */
export function polyDeg(a) {
  const t = polyTrim(a);
  if (t.length === 0 || (t.length === 1 && t[0] === 0)) return -Infinity;
  return t.length - 1;
}
