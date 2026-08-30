/**
 * Complex arithmetic for the control-systems core.
 *
 * A complex number is a plain `{re, im}` object rather than a class instance, so the
 * values pass unchanged through `JSON.stringify` and the WebMCP tool boundary and can
 * be handed straight to the plot layer.
 *
 * This module is DOM-free and imports nothing.
 */

/**
 * @typedef {{re: number, im: number}} Complex
 */

/**
 * Build a complex number.
 * @param {number} re Real part.
 * @param {number} [im] Imaginary part. Defaults to 0.
 * @returns {Complex} The complex value `re + im*i`.
 */
export function cx(re, im = 0) {
  return { re, im };
}

/**
 * Add two complex numbers.
 * @param {Complex} a Left operand.
 * @param {Complex} b Right operand.
 * @returns {Complex} `a + b`.
 */
export function cadd(a, b) {
  return { re: a.re + b.re, im: a.im + b.im };
}

/**
 * Subtract two complex numbers.
 * @param {Complex} a Left operand.
 * @param {Complex} b Right operand.
 * @returns {Complex} `a - b`.
 */
export function csub(a, b) {
  return { re: a.re - b.re, im: a.im - b.im };
}

/**
 * Multiply two complex numbers.
 * @param {Complex} a Left operand.
 * @param {Complex} b Right operand.
 * @returns {Complex} `a * b`.
 */
export function cmul(a, b) {
  return {
    re: a.re * b.re - a.im * b.im,
    im: a.re * b.im + a.im * b.re,
  };
}

/**
 * Divide two complex numbers.
 *
 * Uses Smith's algorithm — factor out the larger denominator component before
 * squaring — so that a denominator with large parts cannot overflow the naive
 * `re^2 + im^2` term.
 *
 * @param {Complex} a Numerator.
 * @param {Complex} b Denominator.
 * @returns {Complex} `a / b`, or `{re: Infinity, im: 0}` when `b` is exactly zero.
 */
export function cdiv(a, b) {
  if (b.re === 0 && b.im === 0) return { re: Infinity, im: 0 };
  if (Math.abs(b.re) >= Math.abs(b.im)) {
    const r = b.im / b.re;
    const d = b.re + b.im * r;
    return { re: (a.re + a.im * r) / d, im: (a.im - a.re * r) / d };
  }
  const r = b.re / b.im;
  const d = b.re * r + b.im;
  return { re: (a.re * r + a.im) / d, im: (a.im * r - a.re) / d };
}

/**
 * Modulus of a complex number.
 * @param {Complex} a Operand.
 * @returns {number} `|a|`, computed with `Math.hypot` to avoid intermediate overflow.
 */
export function cabs(a) {
  return Math.hypot(a.re, a.im);
}

/**
 * Argument (phase angle) of a complex number.
 * @param {Complex} a Operand.
 * @returns {number} `arg(a)` in radians, in `(-pi, pi]`.
 */
export function carg(a) {
  return Math.atan2(a.im, a.re);
}

/**
 * Multiply a complex number by a real scalar.
 * @param {Complex} a Operand.
 * @param {number} k Real scale factor.
 * @returns {Complex} `k * a`.
 */
export function cscale(a, k) {
  return { re: a.re * k, im: a.im * k };
}
