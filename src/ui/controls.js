/**
 * Human-facing control panel and numeric readout.
 *
 * Everything visible here is painted from the store's state inside a `subscribe()` callback;
 * this module never keeps its own copy. That is what makes the WebMCP story work on screen:
 * when an agent calls `set_controller_gains`, the store notifies, and the very same code path
 * that handles a human dragging a slider moves the sliders and repaints the metrics.
 */

import {
  PLANTS,
  analyse,
  getState,
  setGains,
  setPlant,
  setSpec,
  subscribe,
} from "./store.js";

/** Placeholder for a metric the simulation could not produce (em dash). */
const NA = "—";

/** Maximum number of lines kept in #agent-log. */
const LOG_LIMIT = 50;

/** Span of the Kp/Ki/Kd range sliders. The number inputs accept anything the store accepts. */
const SLIDER_MIN = 0;
const SLIDER_MAX = 50;

/** Gains that get a slider + number input pair. */
const GAIN_KEYS = ["Kp", "Ki", "Kd"];

/**
 * Numeric metric rows, keyed by the `data-metric` attribute in index.html.
 * `read` pulls the value out of an `analyse()` result; `digits` is its display precision.
 * The dominant pole is complex and is rendered separately.
 */
const METRICS = {
  overshoot: { read: (a) => a.metrics.overshoot, digits: 2 },
  riseTime: { read: (a) => a.metrics.riseTime, digits: 3 },
  settlingTime: { read: (a) => a.metrics.settlingTime, digits: 3 },
  peakValue: { read: (a) => a.metrics.peakValue, digits: 4 },
  peakTime: { read: (a) => a.metrics.peakTime, digits: 3 },
  steadyStateError: { read: (a) => a.metrics.steadyStateError, digits: 4 },
  gainMargin: { read: (a) => a.margins.gainMarginDb, digits: 2 },
  phaseMargin: { read: (a) => a.margins.phaseMarginDeg, digits: 2 },
  gainCrossover: { read: (a) => a.margins.gainCrossoverW, digits: 4 },
  phaseCrossover: { read: (a) => a.margins.phaseCrossoverW, digits: 4 },
  zeta: { read: (a) => (a.dominant ? a.dominant.zeta : null), digits: 4 },
  wn: { read: (a) => (a.dominant ? a.dominant.wn : null), digits: 4 },
};

/**
 * Rows that carry a PASS/FAIL chip. `relation` and `unit` only build the chip's tooltip;
 * the verdict itself always comes from `analyse().spec.results`, never from a local test.
 */
const SPEC_CHIPS = {
  overshoot: { relation: "≤", unit: " %" },
  settlingTime: { relation: "≤", unit: " s" },
  steadyStateError: { relation: "≤", unit: "" },
  phaseMargin: { relation: "≥", unit: "°" },
};

/** Spec target inputs, keyed by their field in `state.spec`. */
const SPEC_INPUT_IDS = {
  overshoot: "spec-overshoot",
  settlingTime: "spec-settling",
  steadyStateError: "spec-sse",
  phaseMargin: "spec-pm",
};

/** Cached element references, filled in by {@link initControls}. */
let ui = null;

/**
 * Wire the control panel to the store and render it for the first time.
 * Safe to call once per page; `src/main.js` is the only caller.
 *
 * @param {ParentNode} root Element to search for the control markup, usually `document.body`.
 * @returns {void}
 */
export function initControls(root) {
  ui = collect(root ?? document);
  populatePlants(ui.plantSelect);
  wireGains();
  wirePlant();
  wireSpec();
  subscribe(render);
  render(getState());
}

/**
 * Prepend a timestamped line to the on-page agent activity log, capped at 50 entries.
 * `src/mcp/tools.js` calls this on every WebMCP tool invocation so a human watching the
 * page can see exactly what the agent asked for and when.
 *
 * @param {string} message Human-readable description of what the agent just did.
 * @returns {void}
 */
export function logAgent(message) {
  const log = document.getElementById("agent-log");
  if (!log) return;

  const placeholder = log.querySelector(".log-empty");
  if (placeholder) placeholder.remove();

  const now = new Date();
  const time = document.createElement("time");
  time.className = "log-time";
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString([], { hour12: false });

  const text = document.createElement("span");
  text.className = "log-msg";
  text.textContent = String(message);

  const line = document.createElement("p");
  line.className = "log-line";
  line.append(time, text);
  log.prepend(line);

  while (log.childElementCount > LOG_LIMIT) log.lastElementChild.remove();
}

/* ------------------------------------------------------------------ element lookup */

/**
 * Resolve every element the panel touches, once.
 *
 * @param {ParentNode} scope Subtree to search.
 * @returns {object} Cached references.
 */
function collect(scope) {
  const byId = (id) => scope.querySelector(`#${id}`);

  const gains = {};
  for (const key of GAIN_KEYS) {
    const prefix = key.toLowerCase();
    gains[key] = { slider: byId(`${prefix}-slider`), number: byId(`${prefix}-number`) };
  }

  const spec = {};
  for (const [key, id] of Object.entries(SPEC_INPUT_IDS)) spec[key] = byId(id);

  const metricRows = new Map();
  for (const key of [...Object.keys(METRICS), "dominantPole"]) {
    const row = scope.querySelector(`[data-metric="${key}"]`);
    if (!row) continue;
    metricRows.set(key, { value: row.querySelector(".value"), chip: row.querySelector(".chip") });
  }

  return {
    gains,
    spec,
    metricRows,
    filterN: byId("n-number"),
    plantSelect: byId("plant-select"),
    plantNum: byId("plant-num"),
    plantDen: byId("plant-den"),
    plantApply: byId("plant-apply"),
    plantError: byId("plant-error"),
    stabilityBadge: byId("stability-badge"),
    specBadge: byId("spec-badge"),
  };
}

/**
 * Fill the plant `<select>` from `PLANTS`, plus a "Custom" entry that stands for
 * `state.plantKey === null`.
 *
 * @param {HTMLSelectElement|null} select
 * @returns {void}
 */
function populatePlants(select) {
  if (!select) return;

  const options = document.createDocumentFragment();
  for (const [key, plant] of Object.entries(PLANTS)) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = plant.label;
    options.append(option);
  }

  const custom = document.createElement("option");
  custom.value = "";
  custom.textContent = "Custom …";
  options.append(custom);

  select.replaceChildren(options);
}

/* ------------------------------------------------------------------------- wiring */

/**
 * Bind the gain sliders, gain number inputs and the derivative filter pole.
 * @returns {void}
 */
function wireGains() {
  for (const key of GAIN_KEYS) {
    const pair = ui.gains[key];
    if (!pair) continue;
    const apply = (value) => setGains({ [key]: value });
    const current = () => getState()[key];
    bindNumericInput(pair.slider, apply, current);
    bindNumericInput(pair.number, apply, current);
  }

  bindNumericInput(
    ui.filterN,
    (value) => setGains({ N: value }),
    () => getState().N,
  );
}

/**
 * Bind the plant preset select, the custom coefficient fields and the Apply button.
 * @returns {void}
 */
function wirePlant() {
  if (ui.plantSelect) {
    ui.plantSelect.addEventListener("change", () => {
      clearPlantError();
      if (!ui.plantSelect.value) {
        // "Custom" is a shortcut to the coefficient fields, not a plant of its own:
        // repaint the select from state, then send the user where the work happens.
        renderInputs(getState());
        if (ui.plantNum) ui.plantNum.focus();
        return;
      }
      guardStore(() => setPlant({ key: ui.plantSelect.value }));
    });
  }

  if (ui.plantApply) ui.plantApply.addEventListener("click", applyCustomPlant);

  for (const input of [ui.plantNum, ui.plantDen]) {
    if (!input) continue;
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      applyCustomPlant();
    });
  }
}

/**
 * Bind the four design-specification target inputs.
 * @returns {void}
 */
function wireSpec() {
  for (const key of Object.keys(SPEC_INPUT_IDS)) {
    bindNumericInput(
      ui.spec[key],
      (value) => setSpec({ [key]: value }),
      () => getState().spec[key],
    );
  }
}

/**
 * Push every keystroke that parses as a number into the store, and repaint the field from
 * the store on blur so half-typed values ("", "-", "1.") do not linger.
 *
 * @param {HTMLInputElement|null} input
 * @param {(value: number) => void} apply Store setter for this field.
 * @param {() => number} current Reads the field's authoritative value back out of the store.
 * @returns {void}
 */
function bindNumericInput(input, apply, current) {
  if (!input) return;

  input.addEventListener("input", () => {
    const value = Number.parseFloat(input.value);
    if (Number.isFinite(value)) apply(value);
  });

  input.addEventListener("blur", () => syncNumeric(input, current()));
}

/**
 * Parse both coefficient fields and hand them to the store.
 * @returns {void}
 */
function applyCustomPlant() {
  guardStore(() => {
    const num = parseCoefficients(ui.plantNum ? ui.plantNum.value : "", "numerator");
    const den = parseCoefficients(ui.plantDen ? ui.plantDen.value : "", "denominator");
    setPlant({ num, den });
  });
}

/**
 * Run a store mutation, surfacing a rejected plant as inline text under the fields rather
 * than as an uncaught exception.
 *
 * @param {() => void} mutate
 * @returns {void}
 */
function guardStore(mutate) {
  try {
    mutate();
    clearPlantError();
  } catch (error) {
    showPlantError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Parse a space- or comma-separated coefficient list, highest power first.
 *
 * @param {string} text Raw field contents.
 * @param {string} label Field name, used in the error message.
 * @returns {number[]} Descending-power coefficients.
 * @throws {Error} If the field is empty or holds a token that is not a finite number.
 */
function parseCoefficients(text, label) {
  const tokens = String(text).trim().split(/[\s,]+/).filter(Boolean);
  if (tokens.length === 0) throw new Error(`The ${label} needs at least one coefficient.`);

  return tokens.map((token) => {
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Error(`"${token}" in the ${label} is not a number.`);
    return value;
  });
}

/**
 * @param {string} message
 * @returns {void}
 */
function showPlantError(message) {
  if (!ui.plantError) return;
  ui.plantError.textContent = message;
  ui.plantError.hidden = false;
}

/** @returns {void} */
function clearPlantError() {
  if (!ui.plantError) return;
  ui.plantError.textContent = "";
  ui.plantError.hidden = true;
}

/* ---------------------------------------------------------------------- rendering */

/**
 * Repaint the whole panel from state. Registered with `subscribe()`, so it runs for a human
 * dragging a slider and for an agent calling a WebMCP tool alike.
 *
 * @param {object} state Current store state.
 * @returns {void}
 */
function render(state) {
  renderInputs(state);
  renderMetrics(analyse());
}

/**
 * Drive every input back to the stored value.
 *
 * @param {object} state Current store state.
 * @returns {void}
 */
function renderInputs(state) {
  for (const key of GAIN_KEYS) {
    const pair = ui.gains[key];
    if (!pair) continue;
    const value = state[key];
    syncNumeric(pair.slider, value);
    syncNumeric(pair.number, value);
    if (pair.slider) {
      pair.slider.dataset.clamped = String(value < SLIDER_MIN || value > SLIDER_MAX);
    }
  }

  syncNumeric(ui.filterN, state.N);

  if (ui.plantSelect) {
    const wanted = state.plantKey ?? "";
    if (ui.plantSelect.value !== wanted) ui.plantSelect.value = wanted;
  }
  syncTextField(ui.plantNum, formatCoefficients(state.plant.num));
  syncTextField(ui.plantDen, formatCoefficients(state.plant.den));

  for (const key of Object.keys(SPEC_INPUT_IDS)) syncNumeric(ui.spec[key], state.spec[key]);
}

/**
 * Repaint the numeric readout, the pass/fail chips and the two badges.
 *
 * @param {object} analysis Result of `analyse()`.
 * @returns {void}
 */
function renderMetrics(analysis) {
  for (const [key, metric] of Object.entries(METRICS)) {
    const row = ui.metricRows.get(key);
    if (row) setText(row.value, formatFixed(metric.read(analysis), metric.digits));
  }

  const poleRow = ui.metricRows.get("dominantPole");
  if (poleRow) {
    setText(poleRow.value, analysis.dominant ? formatComplex(analysis.dominant.pole) : NA);
  }

  for (const [key, chipSpec] of Object.entries(SPEC_CHIPS)) {
    const row = ui.metricRows.get(key);
    if (!row || !row.chip) continue;
    const result = analysis.spec.results[key];
    row.chip.dataset.pass = String(result.pass);
    setText(row.chip, result.pass ? "PASS" : "FAIL");
    row.chip.title = `Target ${chipSpec.relation} ${trimNumber(result.target)}${chipSpec.unit}`;
  }

  if (ui.stabilityBadge) {
    ui.stabilityBadge.dataset.stable = String(analysis.stable);
    setText(ui.stabilityBadge, analysis.stable ? "STABLE" : "UNSTABLE");
  }

  if (ui.specBadge) {
    ui.specBadge.dataset.pass = String(analysis.spec.allPass);
    setText(ui.specBadge, analysis.spec.allPass ? "SPEC MET" : "SPEC NOT MET");
  }
}

/* ------------------------------------------------------------------ small helpers */

/**
 * Write a number into an input without fighting the person typing in it: a focused field is
 * left alone as long as it already parses to the stored value, so "2.50" survives while an
 * agent-driven change (or a clamp) still repaints it immediately.
 *
 * @param {HTMLInputElement|null} input
 * @param {number} value
 * @returns {void}
 */
function syncNumeric(input, value) {
  if (!input || !Number.isFinite(value)) return;
  if (input === document.activeElement && Number.parseFloat(input.value) === value) return;

  const next = trimNumber(value);
  if (input.value !== next) input.value = next;
}

/**
 * Same idea for the free-text coefficient fields, which have no canonical spelling: leave
 * them entirely alone while focused.
 *
 * @param {HTMLInputElement|null} input
 * @param {string} text
 * @returns {void}
 */
function syncTextField(input, text) {
  if (!input || input === document.activeElement) return;
  if (input.value !== text) input.value = text;
}

/**
 * @param {Node|null} node
 * @param {string} text
 * @returns {void}
 */
function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

/**
 * Format a metric that may legitimately be null (no settling time, no phase crossover, ...).
 *
 * @param {number|null} value
 * @param {number} digits
 * @returns {string} Fixed-point text, or an em dash.
 */
function formatFixed(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : NA;
}

/**
 * Format a number for an input field or a tooltip: enough precision to be exact, without
 * float noise like `0.30000000000000004`.
 *
 * @param {number} value
 * @returns {string}
 */
function trimNumber(value) {
  if (!Number.isFinite(value)) return NA;
  return String(Number(value.toFixed(6)));
}

/**
 * @param {{re: number, im: number}|null} pole
 * @returns {string} e.g. `-0.3000 + 0.9539j`, or just the real part for a real pole.
 */
function formatComplex(pole) {
  if (!pole || !Number.isFinite(pole.re)) return NA;
  if (!Number.isFinite(pole.im) || Math.abs(pole.im) < 1e-9) return pole.re.toFixed(4);
  const sign = pole.im < 0 ? "-" : "+";
  return `${pole.re.toFixed(4)} ${sign} ${Math.abs(pole.im).toFixed(4)}j`;
}

/**
 * @param {number[]} coefficients Descending-power coefficients.
 * @returns {string} Space-separated text for the plant fields.
 */
function formatCoefficients(coefficients) {
  return coefficients.map(trimNumber).join(" ");
}
