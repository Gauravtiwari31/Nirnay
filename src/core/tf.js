/**
 * Transfer-function algebra for the Nirnay.
 *
 * Everything in here is pure numerics over `{num, den}` pairs whose coefficients
 * are plain arrays in descending powers of s (`[1, 2, 3]` is `s^2 + 2s + 3`), so
 * the module imports cleanly into Node for tests and into the browser unchanged.
 */

import { polyAdd, polyDeg, polyMul, polyTrim } from "./poly.js";
import { polyRoots } from "./roots.js";

/**
 * Relative tolerance for deciding that a coefficient is structurally zero.
 * An absolute threshold would be wrong here: loop gains routinely span decades,
 * so "small" only means anything next to the largest coefficient present.
 */
const REL_EPS = 1e-12;

/**
 * Largest absolute coefficient of a polynomial.
 * @param {number[]} p descending-power coefficients
 * @returns {number} 0 for an empty or all-zero polynomial
 */
function maxAbs(p) {
  let m = 0;
  for (const c of p) {
    const a = Math.abs(c);
    if (a > m) m = a;
  }
  return m;
}

/**
 * Realizable PID controller: `C(s) = Kp + Ki/s + Kd*N*s/(s + N)`.
 *
 * The derivative action is filtered by a pole at `-N`; an ideal `Kd*s` term is
 * improper, so it has no state-space realisation and would make the step
 * simulation impossible. Over the common denominator `s(s + N)` this gives
 * `num = [Kp + Kd*N, Kp*N + Ki, Ki*N]`, `den = [1, N, 0]`.
 *
 * The degenerate cases are returned in reduced form rather than carrying a
 * common factor of `s`: an exactly cancelling pole/zero pair is invisible in the
 * maths but shows up as spurious markers on the pole-zero map.
 *
 * @param {number} Kp proportional gain
 * @param {number} Ki integral gain
 * @param {number} Kd derivative gain
 * @param {number} [N=100] derivative filter coefficient, rad/s
 * @returns {{num:number[], den:number[]}} controller transfer function
 * @throws {Error} if a gain is not finite or `N` is not positive
 */
export function pidTF(Kp, Ki, Kd, N = 100) {
  if (![Kp, Ki, Kd, N].every(Number.isFinite)) {
    throw new Error("PID gains and the filter coefficient N must all be finite numbers.");
  }
  if (N <= 0) {
    throw new Error("Derivative filter coefficient N must be greater than 0.");
  }
  if (Ki === 0 && Kd === 0) return { num: [Kp], den: [1] };
  if (Kd === 0) return { num: [Kp, Ki], den: [1, 0] };
  return { num: [Kp + Kd * N, Kp * N + Ki, Ki * N], den: [1, N, 0] };
}

/**
 * Series (cascade) connection: `a(s) * b(s)`.
 * @param {{num:number[], den:number[]}} a first block
 * @param {{num:number[], den:number[]}} b second block
 * @returns {{num:number[], den:number[]}} product transfer function
 */
export function series(a, b) {
  return {
    num: polyTrim(polyMul(a.num, b.num)),
    den: polyTrim(polyMul(a.den, b.den)),
  };
}

/**
 * Unity-negative-feedback closed loop of the open loop `L`: `T = L / (1 + L)`.
 * The trim matters only in the degenerate case where the leading terms of
 * `den` and `num` cancel, which would otherwise leave a phantom extra pole.
 * @param {{num:number[], den:number[]}} L open-loop transfer function
 * @returns {{num:number[], den:number[]}} closed-loop transfer function
 */
export function closedLoop(L) {
  return { num: L.num.slice(), den: polyTrim(polyAdd(L.den, L.num)) };
}

/**
 * Error transfer function of the same loop: `E/R = 1 / (1 + L)`.
 * @param {{num:number[], den:number[]}} L open-loop transfer function
 * @returns {{num:number[], den:number[]}} error transfer function
 */
export function errorTF(L) {
  return { num: L.den.slice(), den: polyTrim(polyAdd(L.den, L.num)) };
}

/**
 * DC gain `T(0)`, i.e. the ratio of the constant terms.
 * @param {{num:number[], den:number[]}} tf transfer function
 * @returns {number|null} null when the denominator has a root at the origin, so
 *   the response has no finite steady state (a free integrator, for example)
 */
export function dcGain(tf) {
  const num = polyTrim(tf.num);
  const den = polyTrim(tf.den);
  if (!num.length || !den.length) return null;
  const scale = maxAbs(den);
  const d0 = den[den.length - 1];
  if (scale === 0 || Math.abs(d0) < REL_EPS * scale) return null;
  const g = num[num.length - 1] / d0;
  return Number.isFinite(g) ? g : null;
}

/**
 * Poles and zeros of a transfer function.
 * @param {{num:number[], den:number[]}} tf transfer function
 * @returns {{poles:{re:number,im:number}[], zeros:{re:number,im:number}[]}}
 */
export function polesZeros(tf) {
  return { poles: polyRoots(tf.den), zeros: polyRoots(tf.num) };
}

/**
 * Controllable canonical state-space realisation.
 *
 * For `T(s) = (b0 s^n + ... + bn) / (s^n + a1 s^(n-1) + ... + an)` (denominator
 * normalised monic, numerator left-padded to length n+1):
 * `D = b0`, `b'_i = b_i - b0*a_i`, `A` is the companion matrix with ones on the
 * superdiagonal and `[-an, ..., -a1]` along the bottom row, `B = [0,...,0,1]`
 * and `C = [b'_n, ..., b'_1]`. Splitting out `D` is what lets a system with
 * direct feedthrough (deg num == deg den) be realised at all.
 *
 * @param {{num:number[], den:number[]}} tf transfer function
 * @returns {{A:number[][], B:number[], C:number[], D:number}|null} null if the
 *   transfer function is improper (deg num > deg den) or the denominator is zero
 */
export function toStateSpace(tf) {
  const den = polyTrim(tf.den);
  const num = polyTrim(tf.num);
  if (!den.length || den[0] === 0) return null;
  const n = den.length - 1;
  if (polyDeg(num) > n) return null;

  const a = den.map((c) => c / den[0]);
  const b = new Array(n + 1).fill(0);
  // Right-align the numerator against the monic denominator.
  for (let i = 0; i <= n && i < num.length; i++) {
    b[n - i] = num[num.length - 1 - i] / den[0];
  }

  const D = b[0];
  const bp = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) bp[i] = b[i] - D * a[i];

  const A = [];
  for (let i = 0; i < n; i++) {
    const row = new Array(n).fill(0);
    if (i < n - 1) row[i + 1] = 1;
    A.push(row);
  }
  const B = new Array(n).fill(0);
  const C = new Array(n).fill(0);
  if (n > 0) {
    for (let j = 0; j < n; j++) {
      A[n - 1][j] = -a[n - j];
      C[j] = bp[n - j];
    }
    B[n - 1] = 1;
  }
  return { A, B, C, D };
}
