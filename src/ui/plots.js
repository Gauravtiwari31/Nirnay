/**
 * Canvas rendering for the Nirnay.
 *
 * Three panels are drawn from one `analyse()` object (see the module contract):
 *   - step response : unit-step output, settling band, peak and settling markers
 *   - bode          : open-loop magnitude (dB) and phase (deg) over a shared log axis
 *   - pole-zero     : closed- and open-loop poles/zeros over the faint root locus
 *
 * This module creates no DOM. The canvases are handed in by `main.js`; everything
 * here is pure drawing. All colours come from CSS custom properties on `:root`,
 * so the theme lives in the stylesheet and nothing is hard-coded here.
 *
 * `drawAll` runs on every slider input, so it stays allocation-light and reads no
 * layout: panel sizes come from the ResizeObserver, never from a forced reflow.
 */

/* -------------------------------------------------------------- constants */

const FONT_UI = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";
const FONT_NUM = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/**
 * Non-ASCII glyphs are written as escapes so the source file stays pure ASCII
 * whatever an editor or static server does with encoding.
 */
const SYM = {
  W: "ω", // omega, angular frequency
  ZETA: "ζ", // zeta, damping ratio
  DEG: "°",
  PLUSMINUS: "±",
  INFINITY: "∞",
  NONE: "—", // em dash, shown when a metric is null
};

/** CSS custom properties consumed by the plots, mapped to the palette keys used below. */
const THEME_VARS = {
  bg: "--bg",
  grid: "--grid",
  axis: "--axis",
  fg: "--fg",
  accent: "--accent",
  accent2: "--accent-2",
  warn: "--warn",
  ok: "--ok",
  muted: "--muted",
};

/** How long a resolved palette is reused before the stylesheet is read again. */
const THEME_TTL_MS = 500;

/** Backing-store scale cap: past 3x the extra pixels buy nothing visible. */
const MAX_DPR = 3;

const EMPTY = Object.freeze([]);

/* ------------------------------------------------------------------ state */

/**
 * @typedef {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D,
 *            w: number, h: number, dpr: number}} Panel
 * @typedef {{x: number, y: number, w: number, h: number}} Box
 * @typedef {{ctx: CanvasRenderingContext2D, t: Record<string,string>, dpr: number}} Gfx
 */

/** @type {{step?: Panel, bode?: Panel, pz?: Panel}|null} */
let panels = null;
/** @type {ResizeObserver|null} */
let observer = null;
/** Most recent analysis, kept so a resize can repaint without the caller's help. */
let latest = null;
let rafId = 0;
let palette = null;
let paletteAt = 0;

/* ------------------------------------------------------------------ theme */

/**
 * Resolve the palette from CSS custom properties on the document element.
 * Cached briefly so a 60fps redraw does not hit the style system every frame,
 * and re-read eagerly on init and on resize so a theme change is picked up.
 *
 * @param {boolean} [force] ignore the cache and read now
 * @returns {Record<string, string>} palette keyed by {@link THEME_VARS}
 */
function theme(force = false) {
  const now = Date.now();
  if (!force && palette && now - paletteAt < THEME_TTL_MS) return palette;
  const style = getComputedStyle(document.documentElement);
  const out = {};
  for (const key of Object.keys(THEME_VARS)) {
    const value = style.getPropertyValue(THEME_VARS[key]);
    out[key] = typeof value === "string" ? value.trim() : "";
  }
  // A missing variable degrades to a system colour rather than to an invented one,
  // so an unstyled page stays legible instead of painting background on background.
  if (!out.bg) out.bg = "Canvas";
  if (!out.fg) out.fg = "CanvasText";
  for (const key of Object.keys(THEME_VARS)) {
    if (!out[key]) out[key] = out.fg;
  }
  palette = out;
  paletteAt = now;
  return out;
}

/* -------------------------------------------------------------- lifecycle */

/**
 * Attach the renderer to three canvases and paint empty frames.
 * Safe to call again: the previous observer is torn down first, so a re-mount
 * leaves no stale observers behind.
 *
 * @param {{step?: HTMLCanvasElement, bode?: HTMLCanvasElement, pz?: HTMLCanvasElement}} canvases
 * @returns {void}
 */
export function initPlots(canvases) {
  dispose();
  panels = {};
  observer = typeof ResizeObserver === "function" ? new ResizeObserver(onResize) : null;
  for (const key of ["step", "bode", "pz"]) {
    const canvas = canvases && canvases[key];
    if (!canvas || typeof canvas.getContext !== "function") continue;
    const ctx = canvas.getContext("2d");
    if (!ctx) continue;
    /** @type {Panel} */
    const panel = { canvas, ctx, w: 0, h: 0, dpr: 0 };
    syncSize(panel, null);
    panels[key] = panel;
    if (observer) observer.observe(canvas);
  }
  theme(true);
  render();
}

/**
 * Redraw all three panels from an `analyse()` result.
 * Anything other than an object paints empty frames instead of throwing.
 *
 * @param {object|null} analysis the object described in the module contract
 * @returns {void}
 */
export function drawAll(analysis) {
  latest = analysis && typeof analysis === "object" ? analysis : null;
  render();
}

/** Release the observer and any frame still queued. */
function dispose() {
  if (observer) observer.disconnect();
  observer = null;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  panels = null;
}

/**
 * Resize handler: re-size the backing stores, then repaint once per frame.
 *
 * @param {ResizeObserverEntry[]} entries
 * @returns {void}
 */
function onResize(entries) {
  if (!panels) return;
  for (const entry of entries) {
    for (const key of Object.keys(panels)) {
      const panel = panels[key];
      if (panel.canvas === entry.target) syncSize(panel, entry);
    }
  }
  theme(true);
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    render();
  });
}

/**
 * Size the backing store to the content box times devicePixelRatio.
 * The ResizeObserver entry is preferred over `getBoundingClientRect` because it
 * reports the content box exactly and costs no layout flush.
 *
 * @param {Panel} panel
 * @param {ResizeObserverEntry|null} entry
 * @returns {void}
 */
function syncSize(panel, entry) {
  const dpr = clamp(window.devicePixelRatio || 1, 1, MAX_DPR);
  let w = 0;
  let h = 0;
  const boxes = entry && entry.contentBoxSize;
  if (boxes) {
    const box = boxes.length ? boxes[0] : boxes;
    if (box) {
      w = box.inlineSize;
      h = box.blockSize;
    }
  }
  if (!(w > 0) || !(h > 0)) {
    const rect = panel.canvas.getBoundingClientRect();
    w = rect.width;
    h = rect.height;
  }
  if (!(w > 0)) w = panel.canvas.width || 320;
  if (!(h > 0)) h = panel.canvas.height || 200;
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  // Assigning width/height resets the context, so only assign on a real change.
  if (panel.canvas.width !== bw) panel.canvas.width = bw;
  if (panel.canvas.height !== bh) panel.canvas.height = bh;
  panel.w = w;
  panel.h = h;
  panel.dpr = dpr;
}

/** Paint every attached panel from `latest`. */
function render() {
  if (!panels) return;
  const t = theme();
  if (panels.step) paint(panels.step, t, drawStep);
  if (panels.bode) paint(panels.bode, t, drawBode);
  if (panels.pz) paint(panels.pz, t, drawPZ);
}

/**
 * Reset the context, clear to the background colour, and run one panel renderer.
 * A renderer must never take the page down with it: if an analysis object is
 * malformed in some way the guards missed, that panel says so and the rest draw.
 *
 * @param {Panel} panel
 * @param {Record<string,string>} t palette
 * @param {(ctx: CanvasRenderingContext2D, panel: Panel, t: Record<string,string>, a: object|null) => void} fn
 * @returns {void}
 */
function paint(panel, t, fn) {
  const ctx = panel.ctx;
  resetContext(ctx, panel, t);
  try {
    fn(ctx, panel, t, latest);
  } catch {
    if (typeof ctx.reset === "function") ctx.reset();
    resetContext(ctx, panel, t);
    centreText(ctx, panel, t.muted, "plot unavailable");
  }
}

/**
 * Put the context into a known state and clear the panel.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Panel} panel
 * @param {Record<string,string>} t
 * @returns {void}
 */
function resetContext(ctx, panel, t) {
  ctx.setTransform(panel.dpr, 0, 0, panel.dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.lineJoin = "round";
  ctx.lineCap = "butt";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = t.bg;
  ctx.fillRect(0, 0, panel.w, panel.h);
}

/* ------------------------------------------------------- numeric helpers */

/**
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number} `v` confined to [lo, hi]
 */
function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * @param {unknown} v
 * @returns {number[]} `v` when it is an array, otherwise a shared empty array
 */
function numArray(v) {
  return Array.isArray(v) ? v : EMPTY;
}

/**
 * Keep only entries that are usable complex numbers.
 *
 * @param {unknown} list
 * @returns {{re: number, im: number}[]}
 */
function finiteComplex(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const c of list) {
    if (!c) continue;
    if (Number.isFinite(c.re) && Number.isFinite(c.im)) out.push(c);
  }
  return out;
}

/**
 * A "nice" axis step: 1, 2 or 5 times a power of ten.
 *
 * @param {number} span data range to cover
 * @param {number} target roughly how many intervals are wanted
 * @returns {number} step size, always > 0
 */
function niceStep(span, target) {
  if (!Number.isFinite(span) || span <= 0) return 1;
  const raw = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mult = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return mult * mag;
}

/**
 * Tick positions covering [lo, hi] on a 1/2/5 grid.
 *
 * @param {number} lo
 * @param {number} hi
 * @param {number} target approximate tick count
 * @returns {{step: number, ticks: number[]}}
 */
function ticksFor(lo, hi, target) {
  const step = niceStep(hi - lo, target);
  const ticks = [];
  const first = Math.ceil(lo / step - 1e-9);
  const last = Math.floor(hi / step + 1e-9);
  for (let i = first; i <= last && ticks.length < 64; i++) ticks.push(i * step);
  return { step, ticks };
}

/**
 * Pick the smallest step from a fixed list that keeps the tick count sane.
 * Used for axes with conventional steps: dB and degrees.
 *
 * @param {number} span
 * @param {number} target approximate tick count
 * @param {number[]} list candidate steps, ascending
 * @returns {number}
 */
function stepFromList(span, target, list) {
  for (const s of list) {
    if (span / s <= target) return s;
  }
  return list[list.length - 1];
}

/**
 * Format an axis tick, with the decimal count implied by the step size.
 *
 * @param {number} v tick value
 * @param {number} step tick spacing
 * @returns {string}
 */
function fmtTick(v, step) {
  if (!Number.isFinite(v)) return "";
  if (Math.abs(v) < Math.abs(step) * 1e-6) return "0";
  const mag = Math.abs(v);
  if (mag >= 1e5 || mag < 1e-4) return v.toExponential(0).replace("e+", "e");
  const dec = clamp(-Math.floor(Math.log10(Math.abs(step)) + 1e-9), 0, 6);
  return v.toFixed(dec);
}

/**
 * Format a metric for an annotation: three significant figures, no trailing zeros.
 *
 * @param {unknown} v
 * @param {string} [unit] appended after a thin gap when the value exists
 * @returns {string} `SYM.NONE` when the value is null or not finite
 */
function fmtVal(v, unit = "") {
  if (typeof v !== "number" || !Number.isFinite(v)) return SYM.NONE;
  const mag = Math.abs(v);
  let s;
  if (mag === 0) {
    s = "0";
  } else if (mag >= 1e5 || mag < 1e-3) {
    s = v.toExponential(1).replace("e+", "e");
  } else {
    const dec = clamp(2 - Math.floor(Math.log10(mag)), 0, 4);
    s = v.toFixed(dec);
    if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  }
  return unit ? s + " " + unit : s;
}

/**
 * Label for a power-of-ten frequency tick.
 *
 * @param {number} exp decade exponent
 * @returns {string}
 */
function fmtDecade(exp) {
  if (exp >= -3 && exp <= 4) {
    const v = Math.pow(10, exp);
    return exp < 0 ? v.toFixed(-exp) : String(v);
  }
  return "1e" + exp;
}

/**
 * Linear interpolation of a series sampled on a log-spaced frequency grid.
 *
 * @param {number[]} ws ascending frequencies, rad/s
 * @param {number[]} ys values at those frequencies
 * @param {number} w frequency to evaluate at
 * @returns {number|null} null when `w` is outside the grid or the data is unusable
 */
function interpLogX(ws, ys, w) {
  const n = Math.min(ws.length, ys.length);
  if (n < 2 || !(w > 0)) return null;
  const target = Math.log10(w);
  for (let i = 1; i < n; i++) {
    const a = ws[i - 1];
    const b = ws[i];
    if (!(a > 0) || !(b > 0)) continue;
    const la = Math.log10(a);
    const lb = Math.log10(b);
    if (target < Math.min(la, lb) || target > Math.max(la, lb)) continue;
    const y0 = ys[i - 1];
    const y1 = ys[i];
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) return null;
    const f = lb === la ? 0 : (target - la) / (lb - la);
    return y0 + f * (y1 - y0);
  }
  return null;
}

/* ------------------------------------------------------ drawing primitives */

/**
 * Snap a coordinate to the middle of a device pixel so 1px lines stay sharp.
 *
 * @param {number} v CSS-pixel coordinate
 * @param {number} dpr device pixel ratio in force
 * @returns {number}
 */
function crisp(v, dpr) {
  return (Math.round(v * dpr) + 0.5) / dpr;
}

/**
 * Inner plot rectangle for a panel.
 *
 * @param {Panel} panel
 * @param {{left: number, right: number, top: number, bottom: number}} pad
 * @returns {Box}
 */
function makeBox(panel, pad) {
  return {
    x: pad.left,
    y: pad.top,
    w: panel.w - pad.left - pad.right,
    h: panel.h - pad.top - pad.bottom,
  };
}

/**
 * @param {Box} box
 * @returns {boolean} true when the box is big enough to be worth drawing into
 */
function boxUsable(box) {
  return box.w > 40 && box.h > 30;
}

/**
 * Value-to-pixel mapping for a linear axis.
 *
 * @param {number} d0 data value at `p0`
 * @param {number} d1 data value at `p1`
 * @param {number} p0 pixel at `d0`
 * @param {number} p1 pixel at `d1`
 * @returns {(v: number) => number}
 */
function linScale(d0, d1, p0, p1) {
  const span = d1 - d0 || 1;
  const k = (p1 - p0) / span;
  return (v) => p0 + (v - d0) * k;
}

/**
 * Message shown when a panel has nothing to draw.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Panel} panel
 * @param {string} colour
 * @param {string} text
 * @returns {void}
 */
function centreText(ctx, panel, colour, text) {
  ctx.textAlign = "center";
  ctx.font = "12px " + FONT_UI;
  ctx.fillStyle = colour;
  ctx.fillText(text, panel.w / 2, panel.h / 2);
  ctx.textAlign = "left";
}

/**
 * A vertical line across a box.
 *
 * @param {Gfx} g
 * @param {Box} box
 * @param {number} px
 * @param {string} colour
 * @param {{width?: number, dash?: number[], alpha?: number}} [opts]
 * @returns {void}
 */
function vLine(g, box, px, colour, opts = {}) {
  if (!Number.isFinite(px) || px < box.x - 0.5 || px > box.x + box.w + 0.5) return;
  const ctx = g.ctx;
  ctx.save();
  ctx.globalAlpha = opts.alpha === undefined ? 1 : opts.alpha;
  ctx.strokeStyle = colour;
  ctx.lineWidth = opts.width || 1;
  if (opts.dash) ctx.setLineDash(opts.dash);
  ctx.beginPath();
  const x = ctx.lineWidth <= 1.01 ? crisp(px, g.dpr) : px;
  ctx.moveTo(x, box.y);
  ctx.lineTo(x, box.y + box.h);
  ctx.stroke();
  ctx.restore();
}

/**
 * A horizontal line across a box.
 *
 * @param {Gfx} g
 * @param {Box} box
 * @param {number} py
 * @param {string} colour
 * @param {{width?: number, dash?: number[], alpha?: number}} [opts]
 * @returns {void}
 */
function hLine(g, box, py, colour, opts = {}) {
  if (!Number.isFinite(py) || py < box.y - 0.5 || py > box.y + box.h + 0.5) return;
  const ctx = g.ctx;
  ctx.save();
  ctx.globalAlpha = opts.alpha === undefined ? 1 : opts.alpha;
  ctx.strokeStyle = colour;
  ctx.lineWidth = opts.width || 1;
  if (opts.dash) ctx.setLineDash(opts.dash);
  ctx.beginPath();
  const y = ctx.lineWidth <= 1.01 ? crisp(py, g.dpr) : py;
  ctx.moveTo(box.x, y);
  ctx.lineTo(box.x + box.w, y);
  ctx.stroke();
  ctx.restore();
}

/**
 * 1px border around the plot area.
 *
 * @param {Gfx} g
 * @param {Box} box
 * @returns {void}
 */
function frame(g, box) {
  const ctx = g.ctx;
  ctx.save();
  ctx.strokeStyle = g.t.axis;
  ctx.lineWidth = 1;
  ctx.strokeRect(crisp(box.x, g.dpr), crisp(box.y, g.dpr), Math.round(box.w), Math.round(box.h));
  ctx.restore();
}

/**
 * Tick labels under a box.
 *
 * @param {Gfx} g
 * @param {Box} box
 * @param {{px: number, text: string}[]} items
 * @returns {void}
 */
function labelsX(g, box, items) {
  const ctx = g.ctx;
  ctx.save();
  ctx.fillStyle = g.t.muted;
  ctx.font = "10px " + FONT_NUM;
  ctx.textAlign = "center";
  ctx.strokeStyle = g.t.axis;
  ctx.lineWidth = 1;
  for (const item of items) {
    if (!Number.isFinite(item.px)) continue;
    ctx.beginPath();
    const x = crisp(item.px, g.dpr);
    ctx.moveTo(x, box.y + box.h);
    ctx.lineTo(x, box.y + box.h + 4);
    ctx.stroke();
    ctx.fillText(item.text, item.px, box.y + box.h + 13);
  }
  ctx.restore();
}

/**
 * Tick labels to the left of a box.
 *
 * @param {Gfx} g
 * @param {Box} box
 * @param {{py: number, text: string}[]} items
 * @returns {void}
 */
function labelsY(g, box, items) {
  const ctx = g.ctx;
  ctx.save();
  ctx.fillStyle = g.t.muted;
  ctx.font = "10px " + FONT_NUM;
  ctx.textAlign = "right";
  ctx.strokeStyle = g.t.axis;
  ctx.lineWidth = 1;
  for (const item of items) {
    if (!Number.isFinite(item.py)) continue;
    ctx.beginPath();
    const y = crisp(item.py, g.dpr);
    ctx.moveTo(box.x - 4, y);
    ctx.lineTo(box.x, y);
    ctx.stroke();
    ctx.fillText(item.text, box.x - 7, item.py);
  }
  ctx.restore();
}

/**
 * Axis title centred under a box.
 *
 * @param {Gfx} g
 * @param {Box} box
 * @param {string} text
 * @returns {void}
 */
function titleX(g, box, text) {
  const ctx = g.ctx;
  ctx.save();
  ctx.fillStyle = g.t.fg;
  ctx.font = "11px " + FONT_UI;
  ctx.textAlign = "center";
  ctx.fillText(text, box.x + box.w / 2, box.y + box.h + 28);
  ctx.restore();
}

/**
 * Axis title rotated along the left edge of a box.
 *
 * @param {Gfx} g
 * @param {Box} box
 * @param {string} text
 * @returns {void}
 */
function titleY(g, box, text) {
  const ctx = g.ctx;
  ctx.save();
  ctx.translate(14, box.y + box.h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = g.t.fg;
  ctx.font = "11px " + FONT_UI;
  ctx.textAlign = "center";
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

/**
 * Stroke a data series, skipping non-finite samples and clamping wild pixel
 * coordinates so a diverging response cannot produce degenerate geometry.
 * The caller is expected to have clipped to the plot box.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number[]} xs
 * @param {number[]} ys
 * @param {(v: number) => number} sx
 * @param {(v: number) => number} sy
 * @param {Box} box
 * @returns {void}
 */
function strokeSeries(ctx, xs, ys, sx, sy, box) {
  const n = Math.min(xs.length, ys.length);
  if (n < 2) return;
  const xLo = box.x - 8 * box.w;
  const xHi = box.x + 9 * box.w;
  const yLo = box.y - 8 * box.h;
  const yHi = box.y + 9 * box.h;
  ctx.beginPath();
  let pen = false;
  for (let i = 0; i < n; i++) {
    const xv = xs[i];
    const yv = ys[i];
    if (!Number.isFinite(xv) || !Number.isFinite(yv)) {
      pen = false;
      continue;
    }
    const px = sx(xv);
    const py = sy(yv);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      pen = false;
      continue;
    }
    const cx = clamp(px, xLo, xHi);
    const cy = clamp(py, yLo, yHi);
    if (pen) ctx.lineTo(cx, cy);
    else {
      ctx.moveTo(cx, cy);
      pen = true;
    }
  }
  ctx.stroke();
}

/**
 * Rounded-rectangle path, with a manual fallback for contexts without `roundRect`.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} w
 * @param {number} h
 * @param {number} r corner radius
 * @returns {void}
 */
function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") {
    ctx.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Metric readout pinned to a corner of a box, on a translucent plate so it stays
 * readable over the curves.
 *
 * @param {Gfx} g
 * @param {Box} box
 * @param {{label: string, value: string, colour?: string}[]} rows
 * @param {"tr"|"tl"} [corner]
 * @returns {void}
 */
function badge(g, box, rows, corner = "tr") {
  if (!rows.length) return;
  const ctx = g.ctx;
  const fs = 11;
  const lh = 15;
  const padX = 8;
  const padY = 6;
  const gap = 12;
  ctx.save();
  ctx.font = fs + "px " + FONT_UI;
  let labelW = 0;
  for (const row of rows) labelW = Math.max(labelW, ctx.measureText(row.label).width);
  ctx.font = fs + "px " + FONT_NUM;
  let valueW = 0;
  for (const row of rows) valueW = Math.max(valueW, ctx.measureText(row.value).width);
  const w = Math.ceil(labelW + gap + valueW + padX * 2);
  const h = rows.length * lh + padY * 2;
  const x = corner === "tl" ? box.x + 8 : box.x + box.w - w - 8;
  const y = box.y + 8;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = g.t.bg;
  roundRectPath(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = g.t.grid;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.globalAlpha = 1;
  for (let i = 0; i < rows.length; i++) {
    const cy = y + padY + lh * i + lh / 2;
    ctx.textAlign = "left";
    ctx.font = fs + "px " + FONT_UI;
    ctx.fillStyle = g.t.muted;
    ctx.fillText(rows[i].label, x + padX, cy);
    ctx.textAlign = "right";
    ctx.font = fs + "px " + FONT_NUM;
    ctx.fillStyle = rows[i].colour || g.t.fg;
    ctx.fillText(rows[i].value, x + w - padX, cy);
  }
  ctx.restore();
}

/**
 * Small pill label, used for the stability call-out.
 *
 * @param {Gfx} g
 * @param {Box} box
 * @param {string} text
 * @param {string} colour
 * @returns {void}
 */
function tag(g, box, text, colour) {
  const ctx = g.ctx;
  ctx.save();
  ctx.font = "11px " + FONT_UI;
  const w = Math.ceil(ctx.measureText(text).width) + 14;
  const h = 19;
  const x = box.x + 8;
  const y = box.y + 8;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = g.t.bg;
  roundRectPath(ctx, x, y, w, h, 9);
  ctx.fill();
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = colour;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = colour;
  ctx.textAlign = "center";
  ctx.fillText(text, x + w / 2, y + h / 2 + 0.5);
  ctx.restore();
}

/**
 * Short text label with a translucent plate behind it, for in-plot annotations.
 *
 * @param {Gfx} g
 * @param {number} x anchor
 * @param {number} y anchor (vertical centre)
 * @param {string} text
 * @param {string} colour
 * @param {"left"|"right"|"center"} [align]
 * @returns {void}
 */
function chip(g, x, y, text, colour, align = "left") {
  const ctx = g.ctx;
  ctx.save();
  ctx.font = "10px " + FONT_NUM;
  const w = Math.ceil(ctx.measureText(text).width) + 8;
  const h = 14;
  const left = align === "right" ? x - w : align === "center" ? x - w / 2 : x;
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = g.t.bg;
  roundRectPath(ctx, left, y - h / 2, w, h, 3);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = colour;
  ctx.textAlign = "center";
  ctx.fillText(text, left + w / 2, y);
  ctx.restore();
}

/**
 * An `x` marker, drawn for poles.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} r half-diagonal
 * @param {string} colour
 * @param {number} width stroke width
 * @returns {void}
 */
function markerX(ctx, x, y, r, colour, width) {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x - r, y - r);
  ctx.lineTo(x + r, y + r);
  ctx.moveTo(x + r, y - r);
  ctx.lineTo(x - r, y + r);
  ctx.stroke();
  ctx.restore();
}

/**
 * An `o` marker, drawn for zeros.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} x
 * @param {number} y
 * @param {number} r radius
 * @param {string} colour
 * @param {number} width stroke width
 * @returns {void}
 */
function markerO(ctx, x, y, r, colour, width) {
  ctx.save();
  ctx.strokeStyle = colour;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/**
 * Colour for a metric, driven by the spec verdict when one is available.
 *
 * @param {Record<string,string>} t palette
 * @param {{value: number|null, pass: boolean}|undefined} result one entry of `analysis.spec.results`
 * @returns {string}
 */
function specColour(t, result) {
  if (!result) return t.fg;
  if (result.value === null || !Number.isFinite(result.value)) return t.muted;
  return result.pass ? t.ok : t.warn;
}

/* --------------------------------------------------------- step response */

const STEP_PAD = { left: 54, right: 16, top: 14, bottom: 40 };

/**
 * Step-response panel: reference, settling band, response, peak and settling markers.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Panel} panel
 * @param {Record<string,string>} t palette
 * @param {object|null} a analysis
 * @returns {void}
 */
function drawStep(ctx, panel, t, a) {
  const box = makeBox(panel, STEP_PAD);
  if (!boxUsable(box)) return;
  const g = { ctx, t, dpr: panel.dpr };

  const ts = numArray(a && a.step && a.step.t);
  const ys = numArray(a && a.step && a.step.y);
  const n = Math.min(ts.length, ys.length);
  const metrics = (a && a.metrics) || {};
  const results = (a && a.spec && a.spec.results) || {};

  // Time axis: prefer the horizon the simulator chose, fall back to the samples.
  let tEnd = Number.isFinite(a && a.step && a.step.tEnd) ? a.step.tEnd : 0;
  if (!(tEnd > 0)) {
    for (let i = n - 1; i >= 0; i--) {
      if (Number.isFinite(ts[i]) && ts[i] > 0) {
        tEnd = ts[i];
        break;
      }
    }
  }
  if (!(tEnd > 0)) tEnd = 1;

  // Output axis. A diverging response would otherwise squash everything into a
  // flat line at the bottom, so the range is capped at a few times the scale of
  // the early transient and the curve is clipped instead.
  const finalValue = Number.isFinite(metrics.finalValue) ? metrics.finalValue : null;
  let dataMin = Infinity;
  let dataMax = -Infinity;
  let earlyMax = 0;
  const earlyCount = Math.max(1, Math.floor(n * 0.2));
  for (let i = 0; i < n; i++) {
    const v = ys[i];
    if (!Number.isFinite(v)) continue;
    if (v < dataMin) dataMin = v;
    if (v > dataMax) dataMax = v;
    if (i < earlyCount) earlyMax = Math.max(earlyMax, Math.abs(v));
  }
  const hasData = dataMin <= dataMax;
  const scale = Math.max(1, Math.abs(finalValue === null ? 0 : finalValue), earlyMax);
  const cap = 6 * scale;
  let lo = hasData ? Math.max(dataMin, -cap) : 0;
  let hi = hasData ? Math.min(dataMax, cap) : 1.2;
  const clipped = hasData && (dataMin < lo - 1e-9 || dataMax > hi + 1e-9);
  lo = Math.min(lo, 0);
  hi = Math.max(hi, 1.05); // the unit reference must always be on screen
  const padY = (hi - lo) * 0.08 || 0.1;
  lo -= padY;
  hi += padY;

  const sx = linScale(0, tEnd, box.x, box.x + box.w);
  const sy = linScale(lo, hi, box.y + box.h, box.y);
  const xt = ticksFor(0, tEnd, 6);
  const yt = ticksFor(lo, hi, 5);

  for (const v of xt.ticks) vLine(g, box, sx(v), t.grid, { alpha: 0.55 });
  for (const v of yt.ticks) hLine(g, box, sy(v), t.grid, { alpha: 0.55 });

  // +/-2% settling band around the final value.
  if (finalValue !== null && Math.abs(finalValue) > 1e-9) {
    const bandLo = sy(finalValue * 0.98);
    const bandHi = sy(finalValue * 1.02);
    const top = Math.min(bandLo, bandHi);
    const height = Math.abs(bandLo - bandHi);
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = t.ok;
    ctx.fillRect(box.x, top, box.w, Math.max(height, 1));
    ctx.restore();
    hLine(g, box, bandLo, t.ok, { alpha: 0.4, dash: [3, 3] });
    hLine(g, box, bandHi, t.ok, { alpha: 0.4, dash: [3, 3] });
  }

  if (lo < 0 && hi > 0) hLine(g, box, sy(0), t.axis, { alpha: 0.9 });
  hLine(g, box, sy(1), t.muted, { alpha: 0.9, width: 1.5, dash: [6, 4] });

  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();

  // Settling marker first, so the response curve sits on top of it.
  const settling = metrics.settlingTime;
  if (Number.isFinite(settling) && settling >= 0 && settling <= tEnd) {
    const px = sx(settling);
    vLine(g, box, px, specColour(t, results.settlingTime), { width: 1.5, dash: [5, 4] });
  }

  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  strokeSeries(ctx, ts, ys, sx, sy, box);

  // Peak marker.
  const peakTime = metrics.peakTime;
  const peakValue = metrics.peakValue;
  if (Number.isFinite(peakTime) && Number.isFinite(peakValue) && peakTime <= tEnd) {
    const px = sx(peakTime);
    const py = sy(peakValue);
    if (py > box.y - 20 && py < box.y + box.h + 20) {
      ctx.save();
      ctx.globalAlpha = 0.6;
      ctx.strokeStyle = t.accent2;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(crisp(px, panel.dpr), py);
      ctx.lineTo(crisp(px, panel.dpr), box.y + box.h);
      ctx.stroke();
      ctx.restore();
      ctx.save();
      ctx.fillStyle = t.accent2;
      ctx.beginPath();
      ctx.arc(px, py, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
  ctx.restore();

  frame(g, box);
  labelsX(
    g,
    box,
    xt.ticks.map((v) => ({ px: sx(v), text: fmtTick(v, xt.step) })),
  );
  labelsY(
    g,
    box,
    yt.ticks.map((v) => ({ py: sy(v), text: fmtTick(v, yt.step) })),
  );
  titleX(g, box, "time [s]");
  titleY(g, box, "output y(t)");

  if (Number.isFinite(settling) && settling >= 0 && settling <= tEnd) {
    chip(g, sx(settling) + 5, box.y + box.h - 10, "ts", specColour(t, results.settlingTime));
  }

  badge(g, box, [
    {
      label: "overshoot",
      value: fmtVal(metrics.overshoot, "%"),
      colour: specColour(t, results.overshoot),
    },
    {
      label: "settling",
      value: fmtVal(metrics.settlingTime, "s"),
      colour: specColour(t, results.settlingTime),
    },
    {
      label: "SS error",
      value: fmtVal(metrics.steadyStateError),
      colour: specColour(t, results.steadyStateError),
    },
  ]);

  if (a && a.stable === false) tag(g, box, "UNSTABLE", t.warn);
  else if (clipped) tag(g, box, "y axis clipped", t.muted);
  if (n < 2) centreText(ctx, panel, t.muted, "no step data");
}

/* ----------------------------------------------------------------- bode */

const BODE_PAD = { left: 54, right: 16, top: 14, bottom: 38 };
const DB_STEPS = [1, 2, 5, 10, 20, 40, 60, 100, 200];
const DEG_STEPS = [15, 30, 45, 90, 180, 360, 720];

/**
 * Bode panel: open-loop magnitude and phase over a shared log-frequency axis,
 * with the gain and phase crossovers marked and the margins annotated.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Panel} panel
 * @param {Record<string,string>} t palette
 * @param {object|null} a analysis
 * @returns {void}
 */
function drawBode(ctx, panel, t, a) {
  const outer = makeBox(panel, BODE_PAD);
  if (!boxUsable(outer) || outer.h < 90) return;
  const g = { ctx, t, dpr: panel.dpr };

  const gap = 24;
  const usable = outer.h - gap;
  const magH = Math.round(usable * 0.55);
  const magBox = { x: outer.x, y: outer.y, w: outer.w, h: magH };
  const phBox = { x: outer.x, y: outer.y + magH + gap, w: outer.w, h: usable - magH };

  const ws = numArray(a && a.bode && a.bode.w);
  const mags = numArray(a && a.bode && a.bode.magDb);
  const phases = numArray(a && a.bode && a.bode.phaseDeg);
  const n = Math.min(ws.length, Math.min(mags.length, phases.length));
  const margins = (a && a.margins) || {};
  const results = (a && a.spec && a.spec.results) || {};

  // Frequency axis, snapped outwards to whole decades.
  let wLo = Infinity;
  let wHi = -Infinity;
  for (let i = 0; i < n; i++) {
    const w = ws[i];
    if (!(w > 0) || !Number.isFinite(w)) continue;
    if (w < wLo) wLo = w;
    if (w > wHi) wHi = w;
  }
  if (!(wLo > 0) || !(wHi > 0) || wLo > wHi) {
    wLo = 0.01;
    wHi = 100;
  }
  let dLo = Math.floor(Math.log10(wLo));
  let dHi = Math.ceil(Math.log10(wHi));
  if (dHi <= dLo) dHi = dLo + 1;
  const sx = linScale(dLo, dHi, outer.x, outer.x + outer.w);
  const sw = (w) => sx(Math.log10(w));

  // Magnitude axis.
  let magLo = Infinity;
  let magHi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = mags[i];
    if (!Number.isFinite(v)) continue;
    if (v < magLo) magLo = v;
    if (v > magHi) magHi = v;
  }
  if (magLo > magHi) {
    magLo = -40;
    magHi = 40;
  }
  magLo = Math.max(magLo, -160);
  magHi = Math.min(magHi, 160);
  magLo = Math.min(magLo, -6);
  magHi = Math.max(magHi, 6); // keep the 0 dB line comfortably inside
  const magStep = stepFromList(magHi - magLo, 6, DB_STEPS);
  magLo = Math.floor(magLo / magStep) * magStep;
  magHi = Math.ceil(magHi / magStep) * magStep;
  const smag = linScale(magLo, magHi, magBox.y + magBox.h, magBox.y);

  // Phase axis. The phase is unwrapped, so the -180 reference may sit at
  // -180 + 360k; every such line inside the range is drawn.
  let phLo = Infinity;
  let phHi = -Infinity;
  for (let i = 0; i < n; i++) {
    const v = phases[i];
    if (!Number.isFinite(v)) continue;
    if (v < phLo) phLo = v;
    if (v > phHi) phHi = v;
  }
  if (phLo > phHi) {
    phLo = -270;
    phHi = 0;
  }
  phLo = Math.max(phLo, -1080);
  phHi = Math.min(phHi, 1080);
  phLo = Math.min(phLo, -185);
  phHi = Math.max(phHi, -175);
  const phStep = stepFromList(phHi - phLo, 5, DEG_STEPS);
  phLo = Math.floor(phLo / phStep) * phStep;
  phHi = Math.ceil(phHi / phStep) * phStep;
  const sph = linScale(phLo, phHi, phBox.y + phBox.h, phBox.y);

  // Decade grid, with minor ticks while they stay legible.
  const decades = dHi - dLo;
  const labelEvery = Math.ceil((decades + 1) / 9);
  const xLabels = [];
  for (let d = dLo; d <= dHi; d++) {
    const px = sx(d);
    vLine(g, magBox, px, t.grid, { alpha: 0.7 });
    vLine(g, phBox, px, t.grid, { alpha: 0.7 });
    if ((d - dLo) % labelEvery === 0) xLabels.push({ px, text: fmtDecade(d) });
    if (decades <= 8 && d < dHi) {
      for (let k = 2; k <= 9; k++) {
        const minor = sx(d + Math.log10(k));
        vLine(g, magBox, minor, t.grid, { alpha: 0.28 });
        vLine(g, phBox, minor, t.grid, { alpha: 0.28 });
      }
    }
  }

  const magTicks = [];
  for (let v = magLo; v <= magHi + 1e-9; v += magStep) {
    hLine(g, magBox, smag(v), t.grid, { alpha: 0.55 });
    magTicks.push({ py: smag(v), text: fmtTick(v, magStep) });
  }
  const phTicks = [];
  for (let v = phLo; v <= phHi + 1e-9; v += phStep) {
    hLine(g, phBox, sph(v), t.grid, { alpha: 0.55 });
    phTicks.push({ py: sph(v), text: fmtTick(v, phStep) });
  }

  // The two references that define the margins.
  hLine(g, magBox, smag(0), t.axis, { alpha: 0.9, dash: [5, 4] });
  for (let k = Math.ceil((phLo + 180) / 360); k <= Math.floor((phHi + 180) / 360); k++) {
    hLine(g, phBox, sph(-180 + 360 * k), t.axis, { alpha: 0.9, dash: [5, 4] });
  }

  // Crossover guides.
  const wgc = Number.isFinite(margins.gainCrossoverW) ? margins.gainCrossoverW : null;
  const wpc = Number.isFinite(margins.phaseCrossoverW) ? margins.phaseCrossoverW : null;
  if (wgc !== null && wgc > 0) {
    vLine(g, magBox, sw(wgc), t.ok, { alpha: 0.75, dash: [4, 4] });
    vLine(g, phBox, sw(wgc), t.ok, { alpha: 0.75, dash: [4, 4] });
  }
  if (wpc !== null && wpc > 0) {
    vLine(g, magBox, sw(wpc), t.warn, { alpha: 0.75, dash: [4, 4] });
    vLine(g, phBox, sw(wpc), t.warn, { alpha: 0.75, dash: [4, 4] });
  }

  // Curves.
  ctx.save();
  ctx.beginPath();
  ctx.rect(magBox.x, magBox.y, magBox.w, magBox.h);
  ctx.clip();
  ctx.strokeStyle = t.accent;
  ctx.lineWidth = 2;
  strokeSeries(ctx, ws, mags, sw, smag, magBox);
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.rect(phBox.x, phBox.y, phBox.w, phBox.h);
  ctx.clip();
  ctx.strokeStyle = t.accent2;
  ctx.lineWidth = 2;
  strokeSeries(ctx, ws, phases, sw, sph, phBox);
  ctx.restore();

  // Gain margin: the drop from 0 dB down to the curve at the phase crossover.
  const gmDb = Number.isFinite(margins.gainMarginDb) ? margins.gainMarginDb : null;
  if (wpc !== null && wpc > 0 && gmDb !== null) {
    const magAt = interpLogX(ws, mags, wpc);
    const value = magAt === null ? -gmDb : magAt;
    const px = sw(wpc);
    const y0 = smag(0);
    const y1 = smag(clamp(value, magLo, magHi));
    ctx.save();
    ctx.strokeStyle = t.warn;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, y0);
    ctx.lineTo(px, y1);
    ctx.stroke();
    ctx.restore();
    chip(g, px + 6, (y0 + y1) / 2, "GM " + fmtVal(gmDb, "dB"), t.warn);
  }

  // Phase margin: the lift from the -180 reference up to the curve at the gain
  // crossover. The reference level is derived from the unwrapped phase itself so
  // the bracket lands on the right 360-degree branch.
  const pmDeg = Number.isFinite(margins.phaseMarginDeg) ? margins.phaseMarginDeg : null;
  if (wgc !== null && wgc > 0 && pmDeg !== null) {
    const phaseAt = interpLogX(ws, phases, wgc);
    const value = phaseAt === null ? pmDeg - 180 : phaseAt;
    const base = value - pmDeg;
    const px = sw(wgc);
    const y0 = sph(clamp(base, phLo, phHi));
    const y1 = sph(clamp(value, phLo, phHi));
    ctx.save();
    ctx.strokeStyle = t.ok;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, y0);
    ctx.lineTo(px, y1);
    ctx.stroke();
    ctx.restore();
    chip(g, px + 6, (y0 + y1) / 2, "PM " + fmtVal(pmDeg, SYM.DEG), t.ok);
  }

  frame(g, magBox);
  frame(g, phBox);
  labelsY(g, magBox, magTicks);
  labelsY(g, phBox, phTicks);
  labelsX(g, phBox, xLabels);
  titleX(g, outer, "frequency [rad/s]");
  titleY(g, magBox, "|L| [dB]");
  titleY(g, phBox, "phase [" + SYM.DEG + "]");

  if (wgc !== null && wgc > 0) {
    chip(g, sw(wgc), magBox.y + 8, SYM.W + "gc " + fmtVal(wgc), t.ok, "center");
  }
  if (wpc !== null && wpc > 0) {
    chip(g, sw(wpc), phBox.y + phBox.h - 9, SYM.W + "pc " + fmtVal(wpc), t.warn, "center");
  }

  badge(
    g,
    magBox,
    [
      {
        label: "phase margin",
        value: pmDeg === null ? SYM.NONE : fmtVal(pmDeg, SYM.DEG),
        colour: specColour(t, results.phaseMargin),
      },
      {
        label: "gain margin",
        value: gmDb === null ? SYM.INFINITY : fmtVal(gmDb, "dB"),
        colour: gmDb === null ? t.ok : gmDb > 0 ? t.ok : t.warn,
      },
    ],
    "tr",
  );

  if (n < 2) centreText(ctx, panel, t.muted, "no frequency data");
}

/* ------------------------------------------------------ pole-zero / locus */

const PZ_PAD = { left: 54, right: 16, top: 14, bottom: 38 };

/**
 * Pole-zero panel: closed-loop poles and zeros on the complex plane, over the
 * root locus and the open-loop configuration. Equal aspect on both axes, with
 * the right half-plane shaded so instability reads at a glance.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Panel} panel
 * @param {Record<string,string>} t palette
 * @param {object|null} a analysis
 * @returns {void}
 */
function drawPZ(ctx, panel, t, a) {
  const box = makeBox(panel, PZ_PAD);
  if (!boxUsable(box)) return;
  const g = { ctx, t, dpr: panel.dpr };

  const clPoles = finiteComplex(a && a.poles);
  const clZeros = finiteComplex(a && a.zeros);
  const olPoles = finiteComplex(a && a.openLoopPoles);
  const olZeros = finiteComplex(a && a.openLoopZeros);
  const branches = Array.isArray(a && a.locus && a.locus.branches) ? a.locus.branches : EMPTY;

  // Window from the singularities only: locus branches run off to infinity and
  // must not be allowed to set the scale.
  let minRe = Infinity;
  let maxRe = -Infinity;
  let maxIm = 0;
  for (const group of [clPoles, clZeros, olPoles, olZeros]) {
    for (const c of group) {
      if (c.re < minRe) minRe = c.re;
      if (c.re > maxRe) maxRe = c.re;
      maxIm = Math.max(maxIm, Math.abs(c.im));
    }
  }
  if (minRe > maxRe) {
    minRe = -1;
    maxRe = 1;
  }
  minRe = Math.min(minRe, 0);
  maxRe = Math.max(maxRe, 0);
  const reSpan = maxRe - minRe || 2;
  minRe -= reSpan * 0.25;
  maxRe += reSpan * 0.25;
  // Always keep a slice of the right half-plane visible, so the shaded region
  // and the imaginary axis are part of the picture even for a very stable loop.
  const minRhp = (maxRe - minRe) * 0.22;
  if (maxRe < minRhp) maxRe = minRhp;
  if (!(maxIm > 0)) maxIm = (maxRe - minRe) * 0.35;
  maxIm *= 1.25;

  // Equal aspect: one scale for both axes, ranges grown to fill the box.
  const k = Math.min(box.w / (maxRe - minRe), box.h / (2 * maxIm));
  const halfW = box.w / (2 * k);
  const halfH = box.h / (2 * k);
  const centreRe = (minRe + maxRe) / 2;
  const xLo = centreRe - halfW;
  const xHi = centreRe + halfW;
  const yLo = -halfH;
  const yHi = halfH;
  const sx = linScale(xLo, xHi, box.x, box.x + box.w);
  const sy = linScale(yLo, yHi, box.y + box.h, box.y);

  // Shared tick step keeps the grid square.
  const step = niceStep(Math.max(xHi - xLo, yHi - yLo), 6);
  const xTicks = ticksFor(xLo, xHi, 6).ticks;
  const yTicks = [];
  for (let i = Math.ceil(yLo / step - 1e-9); i <= Math.floor(yHi / step + 1e-9); i++) {
    yTicks.push(i * step);
  }

  // Right half-plane.
  const zeroX = sx(0);
  if (zeroX < box.x + box.w) {
    ctx.save();
    ctx.globalAlpha = 0.09;
    ctx.fillStyle = t.warn;
    const left = Math.max(zeroX, box.x);
    ctx.fillRect(left, box.y, box.x + box.w - left, box.h);
    ctx.restore();
  }

  for (const v of xTicks) vLine(g, box, sx(v), t.grid, { alpha: 0.5 });
  for (const v of yTicks) hLine(g, box, sy(v), t.grid, { alpha: 0.5 });
  hLine(g, box, sy(0), t.axis, { alpha: 0.9 });
  vLine(g, box, zeroX, t.fg, { alpha: 0.55, width: 2 });

  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();

  // Locus branches, faint: context for where the poles came from and where the
  // next gain change will push them.
  ctx.globalAlpha = 0.38;
  ctx.strokeStyle = t.muted;
  ctx.lineWidth = 1.25;
  for (const branch of branches) {
    if (!Array.isArray(branch) || branch.length < 2) continue;
    ctx.beginPath();
    let pen = false;
    for (const c of branch) {
      if (!c || !Number.isFinite(c.re) || !Number.isFinite(c.im)) {
        pen = false;
        continue;
      }
      const px = clamp(sx(c.re), box.x - 4 * box.w, box.x + 5 * box.w);
      const py = clamp(sy(c.im), box.y - 4 * box.h, box.y + 5 * box.h);
      if (pen) ctx.lineTo(px, py);
      else {
        ctx.moveTo(px, py);
        pen = true;
      }
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Constant-damping ray through the dominant pole.
  const dominant = a && a.dominant;
  const zeta = dominant && Number.isFinite(dominant.zeta) ? dominant.zeta : null;
  if (zeta !== null && zeta > 0 && zeta < 1) {
    const reach = Math.max(halfW, halfH) * 2.2;
    const dx = -zeta * reach;
    const dy = Math.sqrt(1 - zeta * zeta) * reach;
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = t.muted;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(sx(0), sy(0));
    ctx.lineTo(sx(dx), sy(dy));
    ctx.moveTo(sx(0), sy(0));
    ctx.lineTo(sx(dx), sy(-dy));
    ctx.stroke();
    ctx.restore();
  }

  // Open loop underneath in grey, closed loop bright on top.
  for (const c of olZeros) markerO(ctx, sx(c.re), sy(c.im), 5, t.muted, 1.5);
  for (const c of olPoles) markerX(ctx, sx(c.re), sy(c.im), 5, t.muted, 1.5);
  for (const c of clZeros) markerO(ctx, sx(c.re), sy(c.im), 6, t.accent2, 2);
  for (const c of clPoles) {
    const unstable = c.re > 1e-9;
    markerX(ctx, sx(c.re), sy(c.im), 6.5, unstable ? t.warn : t.accent, 2.4);
  }
  ctx.restore();

  frame(g, box);
  labelsX(
    g,
    box,
    xTicks.map((v) => ({ px: sx(v), text: fmtTick(v, step) })),
  );
  labelsY(
    g,
    box,
    yTicks.map((v) => ({ py: sy(v), text: fmtTick(v, step) })),
  );
  titleX(g, box, "Re [1/s]");
  titleY(g, box, "Im [1/s]");

  legendPZ(g, box);

  const stable = a && a.stable;
  badge(g, box, [
    {
      label: "closed loop",
      value: stable === false ? "unstable" : stable === true ? "stable" : SYM.NONE,
      colour: stable === false ? t.warn : stable === true ? t.ok : t.muted,
    },
    { label: SYM.ZETA + " dominant", value: fmtVal(zeta) },
    {
      label: SYM.W + "n",
      value: fmtVal(dominant && dominant.wn, "rad/s"),
    },
  ]);

  if (!clPoles.length && !olPoles.length) centreText(ctx, panel, t.muted, "no pole data");
}

/**
 * Marker key for the pole-zero panel, pinned to the bottom-left of the plot.
 *
 * @param {Gfx} g
 * @param {Box} box
 * @returns {void}
 */
function legendPZ(g, box) {
  const ctx = g.ctx;
  const t = g.t;
  const rows = [
    { kind: "x", colour: t.accent, text: "closed-loop pole" },
    { kind: "o", colour: t.accent2, text: "closed-loop zero" },
    { kind: "x", colour: t.muted, text: "open-loop pole" },
    { kind: "o", colour: t.muted, text: "open-loop zero" },
    { kind: "line", colour: t.muted, text: "root locus" },
  ];
  const fs = 10;
  const lh = 14;
  const padX = 8;
  const padY = 5;
  ctx.save();
  ctx.font = fs + "px " + FONT_UI;
  let textW = 0;
  for (const row of rows) textW = Math.max(textW, ctx.measureText(row.text).width);
  const w = Math.ceil(textW) + padX * 2 + 20;
  const h = rows.length * lh + padY * 2;
  if (w > box.w * 0.7 || h > box.h * 0.7) {
    ctx.restore();
    return;
  }
  const x = box.x + 8;
  const y = box.y + box.h - h - 8;
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = t.bg;
  roundRectPath(ctx, x, y, w, h, 6);
  ctx.fill();
  ctx.globalAlpha = 0.6;
  ctx.strokeStyle = t.grid;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.globalAlpha = 1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const cy = y + padY + lh * i + lh / 2;
    const mx = x + padX + 5;
    if (row.kind === "x") markerX(ctx, mx, cy, 4, row.colour, 1.6);
    else if (row.kind === "o") markerO(ctx, mx, cy, 4, row.colour, 1.4);
    else {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = row.colour;
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(mx - 5, cy);
      ctx.lineTo(mx + 5, cy);
      ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = t.muted;
    ctx.textAlign = "left";
    ctx.fillText(row.text, x + padX + 18, cy);
  }
  ctx.restore();
}
