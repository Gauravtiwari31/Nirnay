/**
 * Time-domain simulation: unit-step response by fixed-step RK4 on the
 * controllable canonical realisation, plus the step-response metrics an agent
 * actually tunes against (overshoot, rise time, settling time, steady-state
 * error). Pure numerics, no DOM.
 */

import { polyRoots } from "./roots.js";
import { dcGain, toStateSpace } from "./tf.js";

/** Real parts at or above this count as non-decaying (unstable or marginal). */
const STABLE_MARGIN = -1e-9;

/** Internal RK4 steps taken per recorded sample. */
const OVERSAMPLE = 20;

/** Settling band, as a fraction of the final value. */
const SETTLING_BAND = 0.02;

/** Final values below this cannot be normalised against. */
const TINY = 1e-12;

/**
 * Clamp a value into an inclusive range.
 * @param {number} v value
 * @param {number} lo lower bound
 * @param {number} hi upper bound
 * @returns {number}
 */
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Pick a simulation window long enough to show the slowest mode settle, without
 * running forever on a system that never settles.
 *
 * A stable system gets eight time constants of its slowest pole. An unstable or
 * marginal system gets a shorter, hard-capped window: there is no steady state
 * to wait for, and the trace only has to show the divergence.
 *
 * @param {{num:number[], den:number[]}} tf transfer function to size a window for
 * @returns {{tEnd:number, stable:boolean}} window end in seconds, and whether
 *   every pole is strictly in the left half plane
 */
export function chooseHorizon(tf) {
  const poles = polyRoots(tf.den);
  let sigmaStable = Infinity;
  let stable = true;
  for (const p of poles) {
    if (!Number.isFinite(p.re) || p.re >= STABLE_MARGIN) {
      stable = false;
      continue;
    }
    sigmaStable = Math.min(sigmaStable, Math.abs(p.re));
  }
  if (stable) {
    // A pure gain has no poles at all: sigmaStable stays Infinity and the clamp
    // falls back to the 0.5 s floor, which is all such a response needs.
    return { tEnd: clamp(8 / sigmaStable, 0.5, 200), stable: true };
  }
  const sigma = Number.isFinite(sigmaStable) ? sigmaStable : 1;
  return { tEnd: clamp(8 / Math.max(1e-3, sigma), 0.5, 30), stable: false };
}

/**
 * Evaluate the output equation `y = C x + D u` for a unit step input.
 * @param {{C:number[], D:number}} ss state-space model
 * @param {Float64Array} x state vector
 * @returns {number} output
 */
function output(ss, x) {
  let y = ss.D;
  for (let i = 0; i < x.length; i++) y += ss.C[i] * x[i];
  return y;
}

/**
 * Unit-step response of `tf`, integrated with RK4 on its controllable canonical
 * state space.
 *
 * The integrator runs at `tEnd / (n * 20)` and records every 20th point: the
 * plotted trace stays small while the numerics are resolved an order of
 * magnitude finer than the sample grid, which is what keeps the peak and the
 * settling band honest on lightly damped systems.
 *
 * @param {{num:number[], den:number[]}} tf transfer function to simulate
 * @param {{tEnd?:number, n?:number}} [opts] `tEnd` overrides the automatic
 *   window; `n` is the number of recorded samples after t=0 (default 800)
 * @returns {{t:number[], y:number[], tEnd:number, truncated:boolean}} `t` and
 *   `y` hold `n + 1` points (t=0 first) unless the response overflowed to a
 *   non-finite value, in which case the trace stops there. `truncated` is true
 *   whenever the window ends before any steady state is reached.
 * @throws {Error} if `tf` is improper and so has no state-space realisation
 */
export function stepResponse(tf, opts = {}) {
  const ss = toStateSpace(tf);
  if (!ss) {
    throw new Error(
      "Cannot simulate this transfer function: the numerator degree exceeds the denominator degree."
    );
  }
  const horizon = chooseHorizon(tf);
  const n = Math.max(2, Math.floor(Number.isFinite(opts.n) ? opts.n : 800));
  const window = Number.isFinite(opts.tEnd) && opts.tEnd > 0 ? opts.tEnd : horizon.tEnd;
  let truncated = !horizon.stable || window < horizon.tEnd;

  const dim = ss.A.length;
  const dt = window / (n * OVERSAMPLE);
  const x = new Float64Array(dim);
  // Scratch vectors for the four RK4 stages, allocated once instead of per step.
  const k1 = new Float64Array(dim);
  const k2 = new Float64Array(dim);
  const k3 = new Float64Array(dim);
  const k4 = new Float64Array(dim);
  const xt = new Float64Array(dim);

  /**
   * Write `dx/dt = A x + B u` with `u = 1` into `out`.
   * @param {Float64Array} state state vector to differentiate
   * @param {Float64Array} out destination vector
   * @returns {void}
   */
  const derivative = (state, out) => {
    for (let i = 0; i < dim; i++) {
      const row = ss.A[i];
      let acc = ss.B[i];
      for (let j = 0; j < dim; j++) acc += row[j] * state[j];
      out[i] = acc;
    }
  };

  const t = [0];
  const y = [output(ss, x)];
  for (let sample = 1; sample <= n; sample++) {
    for (let s = 0; s < OVERSAMPLE; s++) {
      derivative(x, k1);
      for (let i = 0; i < dim; i++) xt[i] = x[i] + 0.5 * dt * k1[i];
      derivative(xt, k2);
      for (let i = 0; i < dim; i++) xt[i] = x[i] + 0.5 * dt * k2[i];
      derivative(xt, k3);
      for (let i = 0; i < dim; i++) xt[i] = x[i] + dt * k3[i];
      derivative(xt, k4);
      for (let i = 0; i < dim; i++) {
        x[i] += (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
      }
    }
    const yi = output(ss, x);
    if (!Number.isFinite(yi)) {
      // A strongly divergent system overflows part way through the window. Stop
      // at the last real number rather than handing NaN to the plots.
      truncated = true;
      break;
    }
    t.push((sample * window) / n);
    y.push(yi);
  }

  return { t, y, tEnd: t[t.length - 1], truncated };
}

/**
 * Time at which a trace first reaches `level`, linearly interpolated between the
 * two straddling samples so the answer is not quantised to the sample grid.
 * @param {number[]} t sample times
 * @param {number[]} yn samples normalised so the final value is 1
 * @param {number} level normalised level to cross
 * @returns {number|null} null if the level is never reached inside the window
 */
function firstCrossing(t, yn, level) {
  if (yn[0] >= level) return t[0];
  for (let i = 1; i < yn.length; i++) {
    if (yn[i] >= level) {
      const d = yn[i] - yn[i - 1];
      const f = d === 0 ? 0 : (level - yn[i - 1]) / d;
      return t[i - 1] + f * (t[i] - t[i - 1]);
    }
  }
  return null;
}

/**
 * Locate the largest sample of `s` and refine it with the vertex of the parabola
 * through the three samples straddling it. The sample grid on its own quantises
 * the peak time to half a step, which is visible against the analytic
 * `tp = pi / (wn * sqrt(1 - zeta^2))`.
 * @param {number[]} t sample times
 * @param {number[]} s samples to maximise
 * @returns {{index:number, time:number, value:number}} refined peak, `value` in
 *   the units of `s`
 */
function refinedPeak(t, s) {
  let pi = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i] > s[pi]) pi = i;
  }
  let time = t[pi];
  let value = s[pi];
  if (pi > 0 && pi < s.length - 1) {
    const curvature = s[pi - 1] - 2 * s[pi] + s[pi + 1];
    const slope = s[pi - 1] - s[pi + 1];
    if (curvature !== 0) {
      const offset = (0.5 * slope) / curvature;
      if (Math.abs(offset) <= 1) {
        time = t[pi] + offset * (t[pi + 1] - t[pi]);
        value = s[pi] - 0.25 * slope * offset;
      }
    }
  }
  return { index: pi, time, value };
}

/**
 * Step-response metrics for `tf`, measured on an already computed trace.
 *
 * Peak time and peak value are refined by fitting a parabola through the three
 * samples around the maximum; rise and settling times are linearly interpolated
 * between samples. Anything with no meaning for the system in question comes
 * back as `null` rather than as a misleading number: an unstable or marginal
 * system has no final value, so it has no overshoot, rise time, settling time or
 * steady-state error either.
 *
 * @param {{num:number[], den:number[]}} tf transfer function that was simulated
 * @param {{t:number[], y:number[]}} [trace] trace from {@link stepResponse},
 *   computed on demand when omitted
 * @returns {{stable:boolean, finalValue:number|null, overshoot:number|null,
 *   peakValue:number|null, peakTime:number|null, riseTime:number|null,
 *   settlingTime:number|null, steadyStateError:number|null}} overshoot is a
 *   percentage of the final value; all times are in seconds
 */
export function stepMetrics(tf, trace) {
  const tr = trace && Array.isArray(trace.t) && trace.t.length ? trace : stepResponse(tf);
  const { t, y } = tr;
  const { stable } = chooseHorizon(tf);
  const finalValue = stable ? dcGain(tf) : null;

  if (finalValue === null || t.length < 2) {
    return {
      stable,
      finalValue,
      overshoot: null,
      peakValue: null,
      peakTime: null,
      riseTime: null,
      settlingTime: null,
      steadyStateError: null,
    };
  }

  if (Math.abs(finalValue) < TINY) {
    // The response decays back to zero (a controller with a zero at the origin,
    // for instance). There is nothing to express a percentage or a 2% band
    // against, so only the peak and the steady-state error mean anything.
    const peak = refinedPeak(t, y.map(Math.abs));
    return {
      stable,
      finalValue,
      overshoot: null,
      peakValue: Math.sign(y[peak.index]) * peak.value,
      peakTime: peak.time,
      riseTime: null,
      settlingTime: null,
      steadyStateError: 1 - finalValue,
    };
  }

  // Normalising by the final value turns every threshold below into a plain
  // fraction, and keeps the logic right for systems that settle at a negative
  // value (a non-minimum-phase plant under negative gain, say).
  const yn = y.map((v) => v / finalValue);
  const peak = refinedPeak(t, yn);
  const peakTime = peak.time;
  const peakValue = finalValue * peak.value;

  // A monotone (first-order) response peaks at the window edge a hair below the
  // final value, which would read as a small negative overshoot; clamp at zero.
  const overshoot = Math.max(0, 100 * (peak.value - 1));

  const t10 = firstCrossing(t, yn, 0.1);
  const t90 = firstCrossing(t, yn, 0.9);
  const riseTime = t10 !== null && t90 !== null && t90 >= t10 ? t90 - t10 : null;

  // Settling time is the last time the response leaves the band, not the first
  // time it enters it: a lightly damped response crosses in and out repeatedly.
  let last = -1;
  for (let i = yn.length - 1; i >= 0; i--) {
    if (Math.abs(yn[i] - 1) > SETTLING_BAND) {
      last = i;
      break;
    }
  }
  let settlingTime;
  if (last < 0) {
    settlingTime = 0; // starts inside the band, e.g. a pure gain
  } else if (last === yn.length - 1) {
    settlingTime = null; // still outside the band when the window ends
  } else {
    const edge = 1 + (yn[last] > 1 ? SETTLING_BAND : -SETTLING_BAND);
    const d = yn[last + 1] - yn[last];
    const f = d === 0 ? 1 : clamp((edge - yn[last]) / d, 0, 1);
    settlingTime = t[last] + f * (t[last + 1] - t[last]);
  }

  return {
    stable,
    finalValue,
    overshoot,
    peakValue,
    peakTime,
    riseTime,
    settlingTime,
    steadyStateError: 1 - finalValue,
  };
}
