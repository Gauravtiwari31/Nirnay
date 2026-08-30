/**
 * WebMCP site tools for the Control Systems Design Bench.
 *
 * The three plots on this page are canvas renderings. An agent cannot read them,
 * and a screenshot only lets it guess at numbers. These tools expose the actual
 * numeric output of the simulation — overshoot, settling time, steady-state error,
 * gain and phase margin, damping ratio — so an agent can close the tuning loop:
 * change a gain, read the real metrics, decide the next move.
 *
 * Two design decisions matter more than the rest:
 *
 *   1. Every write tool returns the full post-change report. The agent does not
 *      have to call a read tool afterwards to find out what it just did, so a
 *      tuning iteration costs one round trip instead of two.
 *
 *   2. No tool ever returns a bare acknowledgement. Every result carries numbers
 *      the agent can verify against and reason from, which is also what lets it
 *      notice when a change made things worse.
 *
 * @module mcp/tools
 */

import { PLANTS, analyse, getState, setGains, setPlant, setSpec } from "../ui/store.js";
import { logAgent } from "../ui/controls.js";

/** Tolerance for treating a pole as real when pairing conjugates for display. */
const REAL_EPS = 1e-9;

/**
 * Format a number for a tool result: fixed notation where it reads well, scientific
 * where it does not, with trailing zeros trimmed.
 * @param {unknown} v the value
 * @param {number} [digits] decimal places before trimming
 * @returns {string} the formatted number, or "undefined" for anything non-finite
 */
function n(v, digits = 4) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "undefined";
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e6)) return v.toExponential(3);
  const s = v.toFixed(digits);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/**
 * Render a coefficient array as a polynomial in s.
 * @param {number[]} coeffs coefficients in descending powers
 * @returns {string} e.g. "s^2 + 0.6s + 1"
 */
function formatPoly(coeffs) {
  const c = Array.isArray(coeffs) ? coeffs : [];
  const deg = c.length - 1;
  const terms = [];
  for (let i = 0; i < c.length; i += 1) {
    const v = c[i];
    if (!Number.isFinite(v) || v === 0) continue;
    const p = deg - i;
    const a = Math.abs(v);
    const mag = a === 1 && p > 0 ? "" : n(a);
    const sym = p === 0 ? "" : p === 1 ? "s" : `s^${p}`;
    terms.push({ negative: v < 0, text: `${mag}${sym}` });
  }
  if (terms.length === 0) return "0";
  let out = (terms[0].negative ? "-" : "") + terms[0].text;
  for (let i = 1; i < terms.length; i += 1) {
    out += `${terms[i].negative ? " - " : " + "}${terms[i].text}`;
  }
  return out;
}

/**
 * Render a transfer function as a ratio of polynomials.
 * @param {{num: number[], den: number[]}} tf the transfer function
 * @returns {string} e.g. "1 / (s^2 + 0.6s + 1)"
 */
function formatTF(tf) {
  const den = formatPoly(tf.den);
  const num = formatPoly(tf.num);
  return den === "1" ? num : `${num} / (${den})`;
}

/**
 * Render poles or zeros, pairing complex conjugates so the list reads the way an
 * engineer would write it.
 * @param {{re: number, im: number}[]} list poles or zeros
 * @returns {string} e.g. "-0.3 +/- 1.382i, -10"
 */
function formatRoots(list) {
  if (!Array.isArray(list) || list.length === 0) return "none";
  const used = new Array(list.length).fill(false);
  const parts = [];
  for (let i = 0; i < list.length; i += 1) {
    if (used[i]) continue;
    used[i] = true;
    const p = list[i];
    if (Math.abs(p.im) < REAL_EPS) {
      parts.push(n(p.re));
      continue;
    }
    let mate = -1;
    for (let k = i + 1; k < list.length; k += 1) {
      if (used[k]) continue;
      if (Math.abs(list[k].re - p.re) < REAL_EPS && Math.abs(list[k].im + p.im) < REAL_EPS) {
        mate = k;
        break;
      }
    }
    if (mate >= 0) {
      used[mate] = true;
      parts.push(`${n(p.re)} +/- ${n(Math.abs(p.im))}i`);
    } else {
      parts.push(`${n(p.re)} ${p.im < 0 ? "-" : "+"} ${n(Math.abs(p.im))}i`);
    }
  }
  return parts.join(", ");
}

/**
 * One line per spec, stating the measured value against its target and by how much
 * it passes or fails. The signed margin is what lets an agent tell "nearly there"
 * from "badly wrong" without a second call.
 * @param {object} spec the `spec` block of an `analyse()` result
 * @returns {string} a multi-line spec report
 */
function formatSpec(spec) {
  const rows = [
    ["overshoot", "%", "<=", spec.results.overshoot],
    ["settling time", "s", "<=", spec.results.settlingTime],
    ["steady-state error", "", "<=", spec.results.steadyStateError],
    ["phase margin", "deg", ">=", spec.results.phaseMargin],
  ];
  const lines = rows.map(([label, unit, rel, r]) => {
    const u = unit ? ` ${unit}` : "";
    if (r.value === null) {
      return `  ${label}: undefined (target ${rel} ${n(r.target)}${u}) FAIL - not defined for this design`;
    }
    const slack = rel === "<=" ? r.target - Math.abs(r.value) : r.value - r.target;
    const verdict = r.pass ? "PASS" : "FAIL";
    const by = `${r.pass ? "inside" : "outside"} by ${n(Math.abs(slack))}${u}`;
    return `  ${label}: ${n(r.value)}${u} (target ${rel} ${n(r.target)}${u}) ${verdict}, ${by}`;
  });
  return `${spec.allPass ? "ALL SPECS MET" : "SPECS NOT MET"}\n${lines.join("\n")}`;
}

/**
 * The standard report block returned by every tool that changes something, and by
 * `get_system`. Dense on purpose: one block tells the agent the whole state of the
 * design, so it can decide its next move without another call.
 * @returns {string} the report
 */
function report() {
  const s = getState();
  const a = analyse();
  const m = a.metrics;
  const g = a.margins;

  const preset = s.plantKey === null ? "custom" : `preset "${s.plantKey}"`;
  const gm = g.gainMargin === null
    ? "GM infinite (open-loop phase never reaches -180 deg)"
    : `GM ${n(g.gainMargin)} (${n(g.gainMarginDb)} dB) @ ${n(g.phaseCrossoverW)} rad/s`;
  const pm = g.phaseMarginDeg === null
    ? "PM undefined (|L| never crosses 1, so there is no gain crossover)"
    : `PM ${n(g.phaseMarginDeg)} deg @ ${n(g.gainCrossoverW)} rad/s`;

  const step = m.finalValue === null
    ? "Step:  no steady state (the loop contains a free integrator), so overshoot and " +
      "steady-state error are undefined"
    : `Step:  overshoot ${n(m.overshoot)}% | rise ${n(m.riseTime)} s | settle ` +
      `${n(m.settlingTime)} s | peak ${n(m.peakValue)} @ ${n(m.peakTime)} s | ` +
      `final ${n(m.finalValue)} | ess ${n(m.steadyStateError)}`;

  const dom = a.dominant === null
    ? "Dominant: none"
    : `Dominant pole ${n(a.dominant.pole.re)}${a.dominant.pole.im === 0 ? "" :
        ` +/- ${n(Math.abs(a.dominant.pole.im))}i`}: zeta ${n(a.dominant.zeta)}, ` +
      `wn ${n(a.dominant.wn)} rad/s`;

  return [
    `Controller: Kp=${n(s.Kp)} Ki=${n(s.Ki)} Kd=${n(s.Kd)} (derivative filter N=${n(s.N)})`,
    `  C(s) = ${formatTF(a.controller)}`,
    `Plant (${preset}): ${formatTF(a.plant)}`,
    `Closed loop: ${a.stable ? "STABLE" : "UNSTABLE"}  T(s) = ${formatTF(a.closedLoop)}`,
    step,
    `Freq:  ${pm} | ${gm}`,
    `Closed-loop poles: ${formatRoots(a.poles)}`,
    dom,
    formatSpec(a.spec),
  ].join("\n");
}

/**
 * Evenly spaced samples from a trace, so a result stays small enough to be worth
 * reading while still showing the shape of the transient.
 * @param {number[]} xs first series
 * @param {number[]} ys second series
 * @param {number} count how many samples to keep
 * @returns {Array<[number, number]>} the sampled pairs
 */
function thin(xs, ys, count) {
  const len = Math.min(xs.length, ys.length);
  if (len === 0) return [];
  if (len <= count) return xs.slice(0, len).map((x, i) => [x, ys[i]]);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const idx = Math.round((i * (len - 1)) / (count - 1));
    out.push([xs[idx], ys[idx]]);
  }
  return out;
}

/**
 * Wrap plain text as a WebMCP tool result.
 * @param {string} body the result body
 * @returns {{content: Array<{type: string, text: string}>}} the tool result
 */
function asResult(body) {
  return { content: [{ type: "text", text: body }] };
}

/**
 * Wrap a tool body so that a validation failure comes back as a readable result
 * rather than a thrown call. A thrown call gives the agent nothing to correct
 * against; a message naming the offending argument lets it retry successfully.
 * @param {string} label short description used in the on-page activity log
 * @param {(args: object) => string} fn the tool body, returning result text
 * @returns {(args: object) => Promise<object>} an `execute` implementation
 */
function guard(label, fn) {
  return async (args) => {
    const input = args && typeof args === "object" ? args : {};
    try {
      const body = fn(input);
      logAgent(label(input));
      return asResult(body);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      logAgent(`${label(input)} - rejected: ${message}`);
      return asResult(`Error: ${message}`);
    }
  };
}

/** The tool definitions, in the order they are registered. */
const TOOLS = [
  {
    name: "get_system",
    description:
      "Read the complete current state of the control design: the plant transfer function, the " +
      "PID gains, the resulting controller and closed-loop transfer functions, whether the loop " +
      "is stable, all step-response and frequency-domain metrics, and how the design measures up " +
      "against the active targets. Start here to find out what you are working with.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    label: () => "get_system",
    run: () => report(),
  },

  {
    name: "run_step_response",
    description:
      "Simulate the closed-loop unit-step response and return its exact numeric transient " +
      "metrics: percent overshoot, rise time, peak value and peak time, 2% settling time, final " +
      "value and steady-state error. Use this instead of trying to read the step-response plot: " +
      "the plot is a canvas rendering, so its numbers cannot be recovered visually, and these are " +
      "the actual simulated values.",
    inputSchema: {
      type: "object",
      properties: {
        include_samples: {
          type: "boolean",
          description:
            "When true, also return about 40 evenly spaced (time in seconds, output) pairs from " +
            "the response, so the shape of the transient can be inspected directly. Defaults to " +
            "false, which returns the metrics only.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    label: () => "run_step_response",
    run: (args) => {
      const a = analyse();
      const m = a.metrics;
      const lines = [
        `Closed loop: ${a.stable ? "STABLE" : "UNSTABLE"}  T(s) = ${formatTF(a.closedLoop)}`,
      ];
      if (m.finalValue === null) {
        lines.push(
          "No steady state: the closed loop contains a free integrator, so the response does " +
          "not converge and overshoot, settling time and steady-state error are undefined."
        );
      } else {
        lines.push(
          `overshoot:          ${n(m.overshoot)} %`,
          `rise time (10-90%): ${n(m.riseTime)} s`,
          `peak value:         ${n(m.peakValue)} at ${n(m.peakTime)} s`,
          `settling time (2%): ${n(m.settlingTime)} s`,
          `final value:        ${n(m.finalValue)}`,
          `steady-state error: ${n(m.steadyStateError)} (unit step reference)`
        );
      }
      if (args.include_samples === true) {
        const pairs = thin(a.step.t, a.step.y, 40)
          .map(([t, y]) => `${n(t, 3)},${n(y, 4)}`)
          .join("  ");
        lines.push(`samples (t s, y): ${pairs}`);
      }
      return lines.join("\n");
    },
  },

  {
    name: "get_frequency_response",
    description:
      "Return the open-loop stability margins: gain margin in dB and as a linear factor, phase " +
      "margin in degrees, and both crossover frequencies in rad/s. Both crossovers are located " +
      "by bisection, so they are exact rather than read off a plot. Use this to judge robustness " +
      "and how much more gain the loop can tolerate before it goes unstable.",
    inputSchema: {
      type: "object",
      properties: {
        include_samples: {
          type: "boolean",
          description:
            "When true, also return about 30 log-spaced (frequency in rad/s, magnitude in dB, " +
            "phase in degrees) triples of the open-loop Bode data. Defaults to false, which " +
            "returns the margins only.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    label: () => "get_frequency_response",
    run: (args) => {
      const a = analyse();
      const g = a.margins;
      const lines = [`Open loop: L(s) = ${formatTF(a.openLoop)}`];
      lines.push(
        g.phaseMarginDeg === null
          ? "phase margin:     undefined - |L| never crosses 1, so there is no gain crossover"
          : `phase margin:     ${n(g.phaseMarginDeg)} deg at ${n(g.gainCrossoverW)} rad/s`
      );
      lines.push(
        g.gainMargin === null
          ? "gain margin:      infinite - the open-loop phase never reaches -180 deg"
          : `gain margin:      ${n(g.gainMargin)} linear (${n(g.gainMarginDb)} dB) at ` +
            `${n(g.phaseCrossoverW)} rad/s`
      );
      if (args.include_samples === true) {
        const rows = [];
        const w = a.bode.w;
        const count = Math.min(30, w.length);
        for (let i = 0; i < count; i += 1) {
          const idx = count === 1 ? 0 : Math.round((i * (w.length - 1)) / (count - 1));
          rows.push(`${n(w[idx], 3)},${n(a.bode.magDb[idx], 2)},${n(a.bode.phaseDeg[idx], 2)}`);
        }
        lines.push(`samples (w rad/s, mag dB, phase deg): ${rows.join("  ")}`);
      }
      return lines.join("\n");
    },
  },

  {
    name: "get_pole_zero_map",
    description:
      "Return the closed-loop poles and zeros as exact complex numbers, the damping ratio and " +
      "natural frequency of the dominant pole, and the critical loop gain at which the system " +
      "would become unstable. Use this to understand why the transient looks the way it does, " +
      "or how far the design is from the stability boundary. The pole-zero plot is a canvas " +
      "rendering, so these values cannot be read off the screen.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    label: () => "get_pole_zero_map",
    run: () => {
      const a = analyse();
      const lines = [
        `Closed loop: ${a.stable ? "STABLE (all poles in the left half-plane)" : "UNSTABLE (at least one pole with Re >= 0)"}`,
        `closed-loop poles: ${formatRoots(a.poles)}`,
        `closed-loop zeros: ${formatRoots(a.zeros)}`,
        `open-loop poles:   ${formatRoots(a.openLoopPoles)}`,
        `open-loop zeros:   ${formatRoots(a.openLoopZeros)}`,
      ];
      lines.push(
        a.dominant === null
          ? "dominant pole: none"
          : `dominant pole: ${formatRoots([a.dominant.pole])} with damping ratio zeta ` +
            `${n(a.dominant.zeta)} and natural frequency wn ${n(a.dominant.wn)} rad/s`
      );
      const crit = a.margins.gainMargin;
      lines.push(
        crit === null
          ? "critical gain: none - increasing the loop gain never destabilises this loop"
          : `critical gain: the loop reaches the stability boundary at ${n(crit)} times the ` +
            `current gain, with poles crossing the imaginary axis at ${n(a.margins.phaseCrossoverW)} rad/s`
      );
      return lines.join("\n");
    },
  },

  {
    name: "evaluate_design",
    description:
      "Check the current design against the active target specification and return, for each " +
      "target, the measured value, the target, a PASS or FAIL verdict and the signed margin by " +
      "which it passes or fails, then an overall verdict. Use this to decide whether tuning is " +
      "finished, and when it is not, to see which requirement is furthest from being met.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    label: () => "evaluate_design",
    run: () => {
      const a = analyse();
      return [
        `Controller: Kp=${n(getState().Kp)} Ki=${n(getState().Ki)} Kd=${n(getState().Kd)}`,
        `Closed loop: ${a.stable ? "STABLE" : "UNSTABLE"}`,
        formatSpec(a.spec),
      ].join("\n");
    },
  },

  {
    name: "set_controller_gains",
    description:
      "Set one or more PID gains on the live page and immediately return the full resulting " +
      "design report: the new gains, stability, every step-response metric, both stability " +
      "margins, the closed-loop poles and the spec verdict. Because the post-change metrics come " +
      "back with the change, one call is enough per tuning iteration. Any parameter left out " +
      "keeps its current value, so a single gain can be adjusted on its own. The plots on the " +
      "page redraw as this is applied.",
    inputSchema: {
      type: "object",
      properties: {
        Kp: {
          type: "number",
          description:
            "Proportional gain. Raising it speeds up the response and reduces steady-state " +
            "error, at the cost of more overshoot and less phase margin. Clamped to " +
            "[-1000, 1000]. Omit to leave unchanged.",
        },
        Ki: {
          type: "number",
          description:
            "Integral gain, in units of 1/s. Any non-zero value drives the steady-state error " +
            "for a step reference to zero, but adds phase lag and so tends to increase " +
            "overshoot. Clamped to [-1000, 1000]. Omit to leave unchanged.",
        },
        Kd: {
          type: "number",
          description:
            "Derivative gain, in seconds. Adds phase lead, which damps overshoot and increases " +
            "phase margin, but amplifies high-frequency content. Clamped to [-1000, 1000]. " +
            "Omit to leave unchanged.",
        },
        N: {
          type: "number",
          description:
            "Derivative filter pole in rad/s, which makes the derivative term realizable: the " +
            "term is Kd*N*s/(s+N). Larger N approaches an ideal derivative. Clamped to " +
            "[1, 10000], default 100. Omit to leave unchanged.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    label: (args) => {
      const parts = ["Kp", "Ki", "Kd", "N"]
        .filter((k) => args[k] !== undefined)
        .map((k) => `${k}=${n(args[k])}`);
      return `set_controller_gains ${parts.join(" ") || "(no change)"}`;
    },
    run: (args) => {
      const wanted = {};
      for (const key of ["Kp", "Ki", "Kd", "N"]) {
        if (args[key] !== undefined) wanted[key] = args[key];
      }
      setGains(wanted);
      return report();
    },
  },

  {
    name: "set_plant",
    description:
      "Replace the plant being controlled, either by naming one of the built-in presets or by " +
      "giving numerator and denominator coefficients directly, then return the full resulting " +
      "design report with the current controller applied to the new plant. Use this to try the " +
      "same controller against a different system, or to enter a specific transfer function.",
    inputSchema: {
      type: "object",
      properties: {
        preset: {
          type: "string",
          enum: Object.keys(PLANTS),
          description:
            "Name of a built-in plant. Give either this or numerator and denominator, not both.",
        },
        numerator: {
          type: "array",
          items: { type: "number" },
          description:
            "Numerator coefficients in descending powers of s, so [1] is 1 and [-1, 1] is " +
            "1 - s. Must be given together with denominator.",
        },
        denominator: {
          type: "array",
          items: { type: "number" },
          description:
            "Denominator coefficients in descending powers of s, so [1, 0.6, 1] is " +
            "s^2 + 0.6s + 1. Must have degree at least that of the numerator, and must be " +
            "given together with numerator.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    label: (args) =>
      args.preset !== undefined
        ? `set_plant preset "${args.preset}"`
        : `set_plant custom [${args.numerator}] / [${args.denominator}]`,
    run: (args) => {
      const hasCustom = args.numerator !== undefined || args.denominator !== undefined;
      if (args.preset !== undefined && hasCustom) {
        throw new Error(
          "Give either preset, or numerator and denominator, but not both."
        );
      }
      if (args.preset !== undefined) {
        setPlant({ key: args.preset });
      } else if (hasCustom) {
        if (args.numerator === undefined || args.denominator === undefined) {
          throw new Error("A custom plant needs both numerator and denominator.");
        }
        setPlant({ num: args.numerator, den: args.denominator });
      } else {
        throw new Error(
          `Nothing to set: give preset (one of ${Object.keys(PLANTS).join(", ")}), or ` +
          "numerator and denominator coefficient arrays."
        );
      }
      return report();
    },
  },

  {
    name: "set_design_spec",
    description:
      "Set the target specification that the controller is being tuned to meet, then return the " +
      "current design re-evaluated against the new targets. Use this when the user states " +
      "requirements, so that evaluate_design and every write tool report progress against the " +
      "right goal. Any target left out keeps its current value.",
    inputSchema: {
      type: "object",
      properties: {
        max_overshoot_percent: {
          type: "number",
          description:
            "Largest acceptable percent overshoot of the step response. Must not be negative. " +
            "Omit to leave unchanged.",
        },
        max_settling_time_s: {
          type: "number",
          description:
            "Largest acceptable 2% settling time in seconds. Must not be negative. Omit to " +
            "leave unchanged.",
        },
        max_steady_state_error: {
          type: "number",
          description:
            "Largest acceptable absolute steady-state error for a unit step, so 0.02 means 2% " +
            "of the reference. Must not be negative. Omit to leave unchanged.",
        },
        min_phase_margin_deg: {
          type: "number",
          description:
            "Smallest acceptable open-loop phase margin in degrees; 45 to 60 is a common " +
            "robustness requirement. Must not be negative. Omit to leave unchanged.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    label: (args) => {
      const parts = Object.entries(args).map(([k, v]) => `${k}=${n(v)}`);
      return `set_design_spec ${parts.join(" ") || "(no change)"}`;
    },
    run: (args) => {
      const map = {
        max_overshoot_percent: "overshoot",
        max_settling_time_s: "settlingTime",
        max_steady_state_error: "steadyStateError",
        min_phase_margin_deg: "phaseMargin",
      };
      const wanted = {};
      for (const [from, to] of Object.entries(map)) {
        if (args[from] !== undefined) wanted[to] = args[from];
      }
      setSpec(wanted);
      const a = analyse();
      return `Targets updated.\n${formatSpec(a.spec)}`;
    },
  },
];

/**
 * Register every site tool on the top-level document, if this browser supports WebMCP.
 *
 * Feature-detection is deliberate rather than defensive: the bench is a complete,
 * usable instrument on its own, and a browser without WebMCP should get the page
 * working normally rather than an error.
 *
 * @returns {Promise<{available: boolean, count: number, unregister: () => void}>}
 *   whether WebMCP was found, how many tools were registered, and a teardown
 *   function that removes them again
 */
export async function registerWebMCPTools() {
  // document.modelContext, not navigator.modelContext: the latter is the older
  // MCP-B era spelling and is not what current implementations expose.
  const ctx = typeof document !== "undefined" ? document.modelContext : undefined;
  if (!ctx || typeof ctx.registerTool !== "function") {
    return { available: false, count: 0, unregister: () => {} };
  }

  const controller = new AbortController();
  const handles = [];

  for (const tool of TOOLS) {
    const handle = await ctx.registerTool(
      {
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: tool.annotations,
        execute: guard(tool.label, tool.run),
      },
      { signal: controller.signal }
    );
    handles.push(handle);
  }

  return {
    available: true,
    count: handles.length,
    unregister: () => {
      // Implementations differ in how a tool is withdrawn, so try each route:
      // a handle returned by registerTool, an explicit unregisterTool, and the
      // abort signal passed at registration.
      for (let i = 0; i < handles.length; i += 1) {
        const handle = handles[i];
        if (handle && typeof handle.unregister === "function") handle.unregister();
        else if (typeof ctx.unregisterTool === "function") ctx.unregisterTool(TOOLS[i].name);
      }
      controller.abort();
    },
  };
}
