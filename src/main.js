/**
 * Application entry point.
 *
 * Wiring order matters: the controls are bound first so the panel is populated
 * before anything paints, the canvases are attached second, and only then is the
 * store subscription established. From that point on there is exactly one path
 * from a state change to the screen — store notifies, controls re-render, plots
 * redraw — and it does not matter whether the change came from a human moving a
 * slider or from an agent calling a WebMCP tool. That single path is what makes
 * the page update itself while an agent is tuning it.
 *
 * @module main
 */

import { analyse, subscribe } from "./ui/store.js";
import { initControls } from "./ui/controls.js";
import { initPlots, drawAll } from "./ui/plots.js";
import { registerWebMCPTools } from "./mcp/tools.js";

initControls(document.body);

initPlots({
  step: document.getElementById("step-canvas"),
  bode: document.getElementById("bode-canvas"),
  pz: document.getElementById("pz-canvas"),
});

subscribe(() => drawAll(analyse()));
drawAll(analyse());

/**
 * Report WebMCP availability in the header, so it is obvious at a glance — and on
 * a demo recording — whether the page is exposing site tools.
 * @param {string} state one of "pending", "on" or "error"
 * @param {string} message text to display
 * @returns {void}
 */
function setStatus(state, message) {
  const el = document.getElementById("mcp-status");
  if (!el) return;
  el.dataset.state = state;
  el.textContent = message;
}

try {
  const mcp = await registerWebMCPTools();
  if (mcp.available) {
    setStatus("on", `WebMCP connected — ${mcp.count} site tools registered.`);
  } else {
    setStatus(
      "pending",
      "WebMCP not available in this browser. The bench works normally; agent tools are inactive."
    );
  }
} catch (err) {
  setStatus("error", `WebMCP tool registration failed: ${err && err.message ? err.message : err}`);
}
