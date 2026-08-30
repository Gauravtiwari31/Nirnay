/**
 * Single source of truth for the Control Systems Design Bench.
 *
 * The plots, the readout panel and the WebMCP site tools all read from this module: callers
 * mutate state through the setters and read every derived quantity through `analyse()`.
 * `analyse()` is memoised on an internal version counter that each setter bumps, so the three
 * consumers can call it as often as they like without re-running the simulation.
 *
 * This file is pure state plus math. It touches no DOM API.
 */

import { pidTF, series, closedLoop, polesZeros } from "../core/tf.js";
import { stepResponse, stepMetrics } from "../core/sim.js";
import { autoFreqRange, frequencyResponse, logspace, margins } from "../core/freq.js";
import { rootLocus } from "../core/rlocus.js";
import { cabs } from "../core/complex.js";

/**
 * @typedef {{re: number, im: number}} Complex
 * @typedef {{num: number[], den: number[]}} TransferFunction
 * @typedef {{overshoot: number, settlingTime: number, steadyStateError: number, phaseMargin: number}} Spec
 * @typedef {{plantKey: string|null, plant: TransferFunction, Kp: number, Ki: number, Kd: number, N: number, spec: Spec}} State
 */

/**
 * Built-in plant catalogue. Each entry is a transfer function in descending powers of s, plus a
 * human-readable label for the plant selector and for tool results.
 * @type {Readonly<Record<string, {label: string, num: number[], den: number[]}>>}
 */
export const PLANTS = {
  "second-order": { label: "Second-order (wn=1, zeta=0.3)", num: [1], den: [1, 0.6, 1] },
  "first-order-lag": { label: "First-order lag", num: [1], den: [1, 1] },
  "double-integrator": { label: "Double integrator", num: [1], den: [1, 0, 0] },
  "dc-motor": { label: "DC motor (position)", num: [1], den: [1, 11, 10, 0] },
  "third-order": { label: "Third-order", num: [1], den: [1, 3, 3, 1] },
  "nonminimum-phase": { label: "Non-minimum phase", num: [-1, 1], den: [1, 2, 1] },
  "unstable": { label: "Unstable plant", num: [1], den: [1, -1, 2] },
};

// The catalogue is a constant: freeze it so a consumer cannot mutate a stock plant in place.
for (const entry of Object.values(PLANTS)) {
  Object.freeze(entry.num);
  Object.freeze(entry.den);
  Object.freeze(entry);
}
Object.freeze(PLANTS);

/** Kp/Ki/Kd are clamped to this magnitude. */
const GAIN_LIMIT = 1000;
/** Derivative-filter pole limits. */
const N_MIN = 1;
const N_MAX = 10000;
/** Highest order accepted from a custom transfer function; keeps the solvers responsive. */
const MAX_ORDER = 10;
/** Frequency samples in the Bode trace. */
const BODE_POINTS = 400;
/** A pole with |Re| below this counts as sitting on the imaginary axis, i.e. not stable. */
const STABILITY_EPS = 1e-9;

const GAIN_KEYS = ["Kp", "Ki", "Kd", "N"];
const SPEC_KEYS = ["overshoot", "settlingTime", "steadyStateError", "phaseMargin"];

/** @type {State} */
const state = {
  plantKey: "second-order",
  plant: { num: [...PLANTS["second-order"].num], den: [...PLANTS["second-order"].den] },
  Kp: 1,
  Ki: 0,
  Kd: 0,
  N: 100,
  spec: { overshoot: 10, settlingTime: 4, steadyStateError: 0.02, phaseMargin: 45 },
};

/** Bumped by every setter; `analyse()` recomputes only when it moves. */
let version = 0;
let cache = null;
let cacheVersion = -1;

/** @type {Set<(state: Readonly<State>) => void>} */
const listeners = new Set();

/**
 * Read the current state.
 * @returns {Readonly<State>} a frozen copy; mutating it does not affect the store
 */
export function getState() {
  return Object.freeze({
    plantKey: state.plantKey,
    plant: Object.freeze({
      num: Object.freeze([...state.plant.num]),
      den: Object.freeze([...state.plant.den]),
    }),
    Kp: state.Kp,
    Ki: state.Ki,
    Kd: state.Kd,
    N: state.N,
    spec: Object.freeze({ ...state.spec }),
  });
}

/**
 * Update one or more controller gains. Partial updates are fine.
 * Kp/Ki/Kd are clamped to [-1000, 1000] and the derivative-filter pole N to [1, 10000]:
 * out-of-range numbers are clamped, non-numeric ones are rejected.
 *
 * @param {{Kp?: number, Ki?: number, Kd?: number, N?: number}} gains gains to change
 * @returns {Readonly<State>} the state after the update
 * @throws {Error} if `gains` is not an object, names no known gain, or carries a non-finite value
 */
export function setGains(gains) {
  if (!isPlainObject(gains)) {
    throw new Error("setGains expects an object such as { Kp: 2, Ki: 0.5 }.");
  }
  const present = GAIN_KEYS.filter((key) => gains[key] !== undefined);
  if (present.length === 0) {
    throw new Error("Nothing to set: provide at least one of Kp, Ki, Kd or N.");
  }
  const next = {};
  for (const key of present) {
    const value = gains[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${key} must be a finite number, got ${describe(value)}.`);
    }
    next[key] = key === "N"
      ? clamp(value, N_MIN, N_MAX)
      : clamp(value, -GAIN_LIMIT, GAIN_LIMIT);
  }
  Object.assign(state, next);
  notify();
  return getState();
}

/**
 * Select a catalogue plant by key, or install a custom transfer function. `key` wins if both are
 * supplied; a custom plant clears `plantKey` to null.
 *
 * @param {{key?: string, num?: number[], den?: number[]}} options plant key, or num/den in
 *   descending powers of s (`[1, 2, 1]` means `s^2 + 2s + 1`)
 * @returns {Readonly<State>} the state after the update
 * @throws {Error} on an unknown key, malformed coefficients, or an improper transfer function
 */
export function setPlant(options) {
  if (!isPlainObject(options)) {
    throw new Error(
      "setPlant expects an object: either a plant key, or num and den coefficient arrays."
    );
  }
  const key = options.key === undefined || options.key === null || options.key === ""
    ? null
    : options.key;

  if (key !== null) {
    if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(PLANTS, key)) {
      throw new Error(
        `Unknown plant ${describe(key)}. Available plants: ${Object.keys(PLANTS).join(", ")}.`
      );
    }
    const preset = PLANTS[key];
    state.plantKey = key;
    state.plant = { num: [...preset.num], den: [...preset.den] };
    notify();
    return getState();
  }

  if (options.num === undefined && options.den === undefined) {
    throw new Error("setPlant needs either a plant key or both num and den coefficient arrays.");
  }
  const num = validateCoefficients(options.num, "Numerator");
  const den = validateCoefficients(options.den, "Denominator");
  const denDegree = degreeOf(den);
  if (denDegree === -Infinity) {
    throw new Error("Denominator must have at least one non-zero coefficient.");
  }
  const numDegree = degreeOf(num);
  if (numDegree > denDegree) {
    throw new Error(
      `Numerator degree (${numDegree}) exceeds denominator degree (${denDegree}); ` +
      "such a transfer function is improper and not physically realizable."
    );
  }
  state.plantKey = null;
  state.plant = { num, den };
  notify();
  return getState();
}

/**
 * Update one or more design-spec targets: overshoot in percent, settling time in seconds,
 * absolute steady-state error, phase margin in degrees.
 *
 * @param {{overshoot?: number, settlingTime?: number, steadyStateError?: number, phaseMargin?: number}} partial
 *   targets to change
 * @returns {Readonly<State>} the state after the update
 * @throws {Error} if no known target is named, or a target is not a finite non-negative number
 */
export function setSpec(partial) {
  if (!isPlainObject(partial)) {
    throw new Error("setSpec expects an object such as { overshoot: 5, settlingTime: 2 }.");
  }
  const present = SPEC_KEYS.filter((key) => partial[key] !== undefined);
  if (present.length === 0) {
    throw new Error(
      "Nothing to set: provide at least one of overshoot, settlingTime, steadyStateError or phaseMargin."
    );
  }
  const next = {};
  for (const key of present) {
    const value = partial[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`Spec target ${key} must be a finite number, got ${describe(value)}.`);
    }
    if (value < 0) {
      throw new Error(`Spec target ${key} must not be negative.`);
    }
    next[key] = value;
  }
  Object.assign(state.spec, next);
  notify();
  return getState();
}

/**
 * Register a listener, called with the frozen state after every change. Derived data is not
 * passed in: call `analyse()` inside the listener, it is memoised and therefore cheap.
 *
 * @param {(state: Readonly<State>) => void} fn listener
 * @returns {() => void} unsubscribe; safe to call more than once
 * @throws {Error} if `fn` is not a function
 */
export function subscribe(fn) {
  if (typeof fn !== "function") {
    throw new Error("subscribe expects a function.");
  }
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Full derived analysis of the current design: controller and loop transfer functions, step
 * response and its metrics, stability margins, poles and zeros, Bode data, root locus and the
 * spec verdict.
 *
 * Memoised on the state version, so two calls with no intervening change return the very same
 * object. That object is shared by every consumer and must be treated as read-only. This
 * function never throws: if a numeric routine fails for a pathological plant, the affected
 * fields come back null or empty and the rest of the object is still well formed.
 *
 * @returns {object} the analysis object described in the module contract
 */
export function analyse() {
  if (cache !== null && cacheVersion === version) {
    return cache;
  }
  cache = computeAnalysis();
  cacheVersion = version;
  return cache;
}

/* ------------------------------------------------------------------------- *
 * Internals
 * ------------------------------------------------------------------------- */

/** Bump the version (invalidating the memo) and fan the new state out to the subscribers. */
function notify() {
  version += 1;
  const snapshot = getState();
  // Iterate a copy: a listener may subscribe or unsubscribe while being called.
  for (const fn of [...listeners]) {
    try {
      fn(snapshot);
    } catch {
      // A failing subscriber must not abort the state change or starve the other subscribers.
    }
  }
}

/**
 * Build the analysis object.
 * @returns {object} the analysis object
 */
function computeAnalysis() {
  try {
    return derive();
  } catch {
    // Belt and braces: `derive` already guards each numeric stage, but `analyse()` is
    // contractually total and the plots, the controls and the tool layer all depend on that.
    return emptyAnalysis();
  }
}

/**
 * The real derivation. Every numeric stage is guarded on its own so one bad plant degrades a
 * single field instead of taking down the page and the tool layer with it.
 * @returns {object} the analysis object
 */
function derive() {
  const plant = { num: [...state.plant.num], den: [...state.plant.den] };
  const controller = attempt(
    () => asTF(pidTF(state.Kp, state.Ki, state.Kd, state.N)),
    { num: [state.Kp], den: [1] }
  );
  const openLoop = attempt(() => asTF(series(controller, plant)), { num: [0], den: [1] });
  const loop = attempt(() => asTF(closedLoop(openLoop)), { num: [0], den: [1] });

  const closedPZ = attempt(() => polesZeros(loop), null);
  const poles = closedPZ === null ? [] : toComplexList(closedPZ.poles);
  const zeros = closedPZ === null ? [] : toComplexList(closedPZ.zeros);
  // Poles we could not compute must not read as stable, hence the explicit null check.
  const stable = closedPZ !== null && poles.every((p) => p.re < -STABILITY_EPS);

  const openPZ = attempt(() => polesZeros(openLoop), null);
  const openLoopPoles = openPZ === null ? [] : toComplexList(openPZ.poles);
  const openLoopZeros = openPZ === null ? [] : toComplexList(openPZ.zeros);

  // The raw trace goes to stepMetrics untouched; the sanitised copy is what the plots draw.
  const rawTrace = attempt(() => stepResponse(loop), null);
  const metrics = sanitiseMetrics(
    rawTrace === null ? null : attempt(() => stepMetrics(loop, rawTrace), null),
    stable
  );
  const marginData = sanitiseMargins(attempt(() => margins(openLoop), null));

  return {
    plant,
    controller,
    openLoop,
    closedLoop: loop,
    step: sanitiseTrace(rawTrace),
    metrics,
    margins: marginData,
    poles,
    zeros,
    openLoopPoles,
    openLoopZeros,
    dominant: dominantPole(poles, stable),
    bode: attempt(() => computeBode(openLoop), { w: [], magDb: [], phaseDeg: [] }),
    locus: sanitiseLocus(attempt(() => rootLocus(openLoop), null)),
    stable,
    spec: evaluateSpec(metrics, marginData),
  };
}

/**
 * The all-null analysis, used when the derivation itself fails.
 * @returns {object} a well-formed analysis object carrying no results
 */
function emptyAnalysis() {
  const metrics = sanitiseMetrics(null, false);
  const marginData = sanitiseMargins(null);
  return {
    plant: { num: [...state.plant.num], den: [...state.plant.den] },
    controller: { num: [state.Kp], den: [1] },
    openLoop: { num: [0], den: [1] },
    closedLoop: { num: [0], den: [1] },
    step: { t: [], y: [], tEnd: 0 },
    metrics,
    margins: marginData,
    poles: [],
    zeros: [],
    openLoopPoles: [],
    openLoopZeros: [],
    dominant: null,
    bode: { w: [], magDb: [], phaseDeg: [] },
    locus: { k: [], branches: [] },
    stable: false,
    spec: evaluateSpec(metrics, marginData),
  };
}

/**
 * Open-loop Bode data over an automatically chosen decade range.
 * @param {TransferFunction} tf open loop
 * @returns {{w: number[], magDb: number[], phaseDeg: number[]}} index-aligned finite samples
 */
function computeBode(tf) {
  const range = attempt(() => autoFreqRange(tf), null);
  const lo = range !== null && Number.isFinite(range.lo) ? range.lo : -2;
  const hi = range !== null && Number.isFinite(range.hi) && range.hi > lo ? range.hi : lo + 5;
  const response = frequencyResponse(tf, logspace(lo, hi, BODE_POINTS));
  const out = { w: [], magDb: [], phaseDeg: [] };
  const n = Math.min(response.w.length, response.magDb.length, response.phaseDeg.length);
  for (let i = 0; i < n; i += 1) {
    // A magnitude of exactly zero maps to -Infinity dB. Drop such a sample rather than invent a
    // floor value: the three arrays stay index-aligned and every value stays drawable.
    if (!Number.isFinite(response.w[i])) continue;
    if (!Number.isFinite(response.magDb[i])) continue;
    if (!Number.isFinite(response.phaseDeg[i])) continue;
    out.w.push(response.w[i]);
    out.magDb.push(response.magDb[i]);
    out.phaseDeg.push(response.phaseDeg[i]);
  }
  return out;
}

/**
 * Trim a step trace to its finite prefix, so a diverging response still plots its run-up.
 * @param {{t: number[], y: number[], tEnd: number}|null} trace raw stepResponse output
 * @returns {{t: number[], y: number[], tEnd: number}} the drawable trace
 */
function sanitiseTrace(trace) {
  if (trace === null || !Array.isArray(trace.t) || !Array.isArray(trace.y)) {
    return { t: [], y: [], tEnd: 0 };
  }
  const n = Math.min(trace.t.length, trace.y.length);
  const t = [];
  const y = [];
  for (let i = 0; i < n; i += 1) {
    if (!Number.isFinite(trace.t[i]) || !Number.isFinite(trace.y[i])) break;
    t.push(trace.t[i]);
    y.push(trace.y[i]);
  }
  const complete = t.length === n;
  const last = t.length > 0 ? t[t.length - 1] : 0;
  return { t, y, tEnd: complete && Number.isFinite(trace.tEnd) ? trace.tEnd : last };
}

/**
 * @param {object|null} m raw stepMetrics output
 * @param {boolean} stable fallback stability flag, taken from the closed-loop poles
 * @returns {object} the stepMetrics shape, with every non-finite field replaced by null
 */
function sanitiseMetrics(m, stable) {
  if (m === null || typeof m !== "object") {
    return {
      stable,
      finalValue: null,
      overshoot: null,
      peakValue: null,
      peakTime: null,
      riseTime: null,
      settlingTime: null,
      steadyStateError: null,
    };
  }
  return {
    stable: typeof m.stable === "boolean" ? m.stable : stable,
    finalValue: finiteOrNull(m.finalValue),
    overshoot: finiteOrNull(m.overshoot),
    peakValue: finiteOrNull(m.peakValue),
    peakTime: finiteOrNull(m.peakTime),
    riseTime: finiteOrNull(m.riseTime),
    settlingTime: finiteOrNull(m.settlingTime),
    steadyStateError: finiteOrNull(m.steadyStateError),
  };
}

/**
 * @param {object|null} m raw margins output
 * @returns {object} the margins shape, with every non-finite field replaced by null
 */
function sanitiseMargins(m) {
  const source = m === null || typeof m !== "object" ? {} : m;
  return {
    gainMarginDb: finiteOrNull(source.gainMarginDb),
    gainMargin: finiteOrNull(source.gainMargin),
    phaseMarginDeg: finiteOrNull(source.phaseMarginDeg),
    gainCrossoverW: finiteOrNull(source.gainCrossoverW),
    phaseCrossoverW: finiteOrNull(source.phaseCrossoverW),
  };
}

/**
 * @param {{k: number[], branches: Complex[][]}|null} locus raw rootLocus output
 * @returns {{k: number[], branches: Complex[][]}} drawable branches
 */
function sanitiseLocus(locus) {
  if (locus === null || !Array.isArray(locus.k) || !Array.isArray(locus.branches)) {
    return { k: [], branches: [] };
  }
  if (!locus.k.every((k) => Number.isFinite(k))) {
    return { k: [], branches: [] };
  }
  const branches = [];
  for (const branch of locus.branches) {
    if (!Array.isArray(branch)) continue;
    const points = [];
    for (const point of branch) {
      // Stop at the first bad sample, so what remains stays index-aligned with k.
      if (!isComplex(point)) break;
      points.push({ re: point.re, im: point.im });
    }
    if (points.length > 0) branches.push(points);
  }
  return { k: [...locus.k], branches };
}

/**
 * The pole that dominates the transient: the one closest to the imaginary axis from the left,
 * or, when nothing sits in the left half-plane, the rightmost pole overall.
 * @param {Complex[]} poles closed-loop poles
 * @param {boolean} stable whether the closed loop is stable
 * @returns {{pole: Complex, zeta: number|null, wn: number|null}|null} null when there are no poles
 */
function dominantPole(poles, stable) {
  if (poles.length === 0) return null;
  const leftHalf = poles.filter((p) => p.re < 0);
  const pool = stable && leftHalf.length > 0 ? leftHalf : poles;
  let pole = pool[0];
  for (const p of pool) {
    if (p.re > pole.re) pole = p;
  }
  const wn = cabs(pole);
  if (!Number.isFinite(wn) || wn === 0) {
    return { pole: { re: pole.re, im: pole.im }, zeta: null, wn: finiteOrNull(wn) };
  }
  // normaliseZero keeps a pole on the imaginary axis from reporting a damping ratio of -0.
  return { pole: { re: pole.re, im: pole.im }, zeta: normaliseZero(-pole.re / wn), wn };
}

/**
 * Score the current results against the design spec.
 * @param {object} metrics sanitised step metrics
 * @param {object} marginData sanitised stability margins
 * @returns {{targets: Spec, results: object, allPass: boolean}} the spec verdict
 */
function evaluateSpec(metrics, marginData) {
  const targets = { ...state.spec };
  const results = {
    overshoot: check(metrics.overshoot, targets.overshoot, (v, t) => v <= t),
    settlingTime: check(metrics.settlingTime, targets.settlingTime, (v, t) => v <= t),
    steadyStateError: check(
      metrics.steadyStateError,
      targets.steadyStateError,
      (v, t) => Math.abs(v) <= t
    ),
    phaseMargin: check(marginData.phaseMarginDeg, targets.phaseMargin, (v, t) => v >= t),
  };
  return {
    targets,
    results,
    allPass: Object.values(results).every((r) => r.pass),
  };
}

/**
 * One spec line. A value we could not measure never passes.
 * @param {number|null} value measured value
 * @param {number} target spec target
 * @param {(value: number, target: number) => boolean} ok the comparison this target uses
 * @returns {{value: number|null, target: number, pass: boolean}} the scored line
 */
function check(value, target, ok) {
  const v = finiteOrNull(value);
  return { value: v, target, pass: v !== null && ok(v, target) };
}

/**
 * Run `fn`, falling back to `fallback` if it throws or hands back nothing usable.
 * @template T
 * @param {() => T} fn the computation
 * @param {T} fallback the value to use on failure
 * @returns {T} the result, or `fallback`
 */
function attempt(fn, fallback) {
  try {
    const value = fn();
    return value === undefined || value === null ? fallback : value;
  } catch {
    return fallback;
  }
}

/**
 * Copy a transfer function, rejecting anything malformed so `attempt` can substitute.
 * @param {TransferFunction} tf candidate transfer function
 * @returns {TransferFunction} a defensive copy
 * @throws {Error} if the coefficients are missing, non-finite, or the denominator vanishes
 */
function asTF(tf) {
  if (!tf || !Array.isArray(tf.num) || !Array.isArray(tf.den)) {
    throw new Error("Transfer function must have num and den coefficient arrays.");
  }
  if (!tf.num.every((c) => Number.isFinite(c)) || !tf.den.every((c) => Number.isFinite(c))) {
    throw new Error("Transfer function coefficients must all be finite.");
  }
  if (degreeOf(tf.den) === -Infinity) {
    throw new Error("Denominator must have at least one non-zero coefficient.");
  }
  return { num: [...tf.num], den: [...tf.den] };
}

/**
 * Validate and copy user-supplied polynomial coefficients.
 * @param {number[]} value candidate coefficients, descending powers of s
 * @param {string} label "Numerator" or "Denominator", used in the error message
 * @returns {number[]} a defensive copy
 * @throws {Error} with a message written to be read by a person or relayed to an agent
 */
function validateCoefficients(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(
      `${label} must be a non-empty array of coefficients in descending powers of s, ` +
      "e.g. [1, 2, 1] for s^2 + 2s + 1."
    );
  }
  if (value.length - 1 > MAX_ORDER) {
    throw new Error(`${label} order is limited to ${MAX_ORDER}.`);
  }
  const out = [];
  for (const c of value) {
    if (typeof c !== "number" || !Number.isFinite(c)) {
      throw new Error(`${label} coefficients must all be finite numbers, got ${describe(c)}.`);
    }
    out.push(c);
  }
  return out;
}

/**
 * Polynomial degree after dropping leading coefficients that are zero to within a relative
 * tolerance, matching the trimming convention the core modules use.
 * @param {number[]} coeffs descending-power coefficients
 * @returns {number} the degree, or -Infinity for the zero polynomial
 */
function degreeOf(coeffs) {
  let scale = 0;
  for (const c of coeffs) scale = Math.max(scale, Math.abs(c));
  if (scale === 0) return -Infinity;
  const tol = 1e-12 * scale;
  let lead = 0;
  while (lead < coeffs.length && Math.abs(coeffs[lead]) <= tol) lead += 1;
  return coeffs.length - lead - 1;
}

/**
 * @param {unknown} value candidate
 * @returns {boolean} true for a complex number with finite parts
 */
function isComplex(value) {
  return Boolean(value)
    && typeof value === "object"
    && Number.isFinite(value.re)
    && Number.isFinite(value.im);
}

/**
 * @param {unknown} list candidate array of complex numbers
 * @returns {Complex[]} copies of the finite entries, order preserved
 */
function toComplexList(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(isComplex).map((p) => ({ re: p.re, im: p.im }));
}

/**
 * @param {unknown} value candidate
 * @returns {number|null} the number itself, or null if it is not finite
 */
function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * @param {number} value input
 * @returns {number} `value`, with negative zero normalised to positive zero
 */
function normaliseZero(value) {
  return value === 0 ? 0 : value;
}

/**
 * @param {number} value input
 * @param {number} lo lower bound
 * @param {number} hi upper bound
 * @returns {number} `value` clamped to [lo, hi]
 */
function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), hi);
}

/**
 * @param {unknown} value candidate
 * @returns {boolean} true for a non-null, non-array object
 */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Render a rejected value for an error message.
 * @param {unknown} value the offending value
 * @returns {string} a short human-readable description
 */
function describe(value) {
  if (typeof value === "string") return `"${value}"`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") return "an object";
  return String(value);
}
