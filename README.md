# Control Systems Design Bench

A browser-based control-systems tuning workbench where a person and an AI agent work the same
loop at the same time. You watch the step response, Bode plot and root locus redraw as the gains
change. The agent reads the actual numbers behind those plots through WebMCP site tools —
overshoot, settling time, phase margin, pole locations — and tunes the controller against a
design spec you set.

**Live demo:** TBD

**Demo video:** TBD

## What it is

An interactive control-systems tuning workbench. A plant transfer function is put in a unity
negative-feedback loop with a realisable PID controller. Three live canvas panels show the
closed-loop step response, the open-loop Bode magnitude and phase, and a pole-zero map with the
root locus behind it. Sliders and number inputs drive `Kp`, `Ki`, `Kd` and the derivative filter
pole `N`; a plant selector switches between seven textbook plants or accepts custom numerator and
denominator coefficients.

The same page exposes eight WebMCP tools. An agent can read the numeric simulation output and
write new gains, a new plant, or a new design spec. One store sits behind both surfaces, so a
tool call and a slider drag are indistinguishable to the rest of the app: whichever moves, the
plots redraw and the metric readout updates. The human can take the controls back mid-conversation,
and the agent's next read reflects it.

## Why this needs WebMCP

The plots are canvas renderings. There is no DOM to scrape — a step response is a few thousand
pixels drawn with `lineTo`. A screenshot only lets a model guess: ask a vision model for the
overshoot and it will say "roughly 25%", because that is all a picture supports. Tuning a
controller on "roughly" does not converge.

WebMCP exposes the simulation output itself, as numbers, from the same code that draws the pixels.
Concretely, here is what the agent gets that no amount of DOM scraping or screenshotting can give:

- **Overshoot, peak time and 10–90% rise time** measured from the integrated response, with
  interpolation between samples rather than snapping to the sample grid.
- **Settling time** taken from the last time the response leaves the ±2% band, scanning backwards
  — not the first time it enters, which is the number a human eyeballing a plot usually reports.
- **Steady-state error** from the exact closed-loop DC gain, including the case where there is no
  steady state at all, which is reported as `null` with a reason rather than a silent `NaN`.
- **Gain and phase margins** with the crossover frequencies refined by bisection to 1e-10 relative
  tolerance, instead of the nearest point on a plotted frequency grid.
- **Closed-loop pole locations**, plus the dominant pole's damping ratio and natural frequency.
- **A pass/fail verdict** against every target in the design spec, so the agent knows when to stop.

That closes the tuning loop. The agent proposes gains, gets real metrics back, compares them to
the spec, and adjusts — the same iteration a control engineer does by hand, except it can run ten
rounds in the time it takes to explain the first one. It can also do the parts that are tedious by
hand: push a gain until the phase margin reaches 60 degrees, or find where the root locus crosses
into the right half-plane and report the largest usable gain.

Every write tool returns the post-change metrics in the same call. `set_controller_gains` does not
answer "done" — it answers with the resulting overshoot, settling time, margins and spec verdict.
That turns what would be a two-call loop (write, then read to find out what happened) into a single
call. It roughly halves the round trips in a tuning session, and it keeps the agent's reasoning
anchored to a measurement instead of to its own prediction of what those gains would do.

## WebMCP tools

Registered on `document.modelContext` from `src/mcp/tools.js`, behind a feature detection so the
page still works normally in a browser with no WebMCP support. Read tools carry
`annotations.readOnlyHint: true` and run without a confirmation prompt; the three write tools do
not, because they change what the human is looking at.

| Tool | Kind | Inputs | Returns |
| --- | --- | --- | --- |
| `get_system` | read | none | Plant and controller transfer functions, the current `Kp`, `Ki`, `Kd` and `N`, the open- and closed-loop polynomials, whether the loop is stable, and the active design spec. The orientation call. |
| `run_step_response` | read | `include_samples` (optional) | Overshoot percent, peak value and peak time, 10–90% rise time, 2% settling time, steady-state error, final value, and stability. With `include_samples`, about 40 evenly spaced `(t, y)` pairs as well. |
| `get_frequency_response` | read | `include_samples` (optional) | Gain margin in dB and linear, phase margin in degrees, and the gain- and phase-crossover frequencies in rad/s. With `include_samples`, about 30 log-spaced `(w, magnitude dB, phase deg)` triples as well. |
| `get_pole_zero_map` | read | none | Closed-loop poles and zeros, the dominant pole with its damping ratio and natural frequency, the open-loop poles and zeros for context, and the critical gain at which the loop would go unstable. |
| `evaluate_design` | read | none | Every spec target next to its measured value with a pass/fail flag and the signed margin by which it passes or fails, plus an overall verdict. The tool that tells the agent whether it is finished. |
| `set_controller_gains` | write | any of `Kp`, `Ki`, `Kd`, `N` | Applies the gains, redraws the plots, and returns the full post-change metrics and spec verdict. |
| `set_plant` | write | `preset`, or `numerator` and `denominator` coefficient arrays | Switches the plant, redraws, and returns the post-change metrics and spec verdict. |
| `set_design_spec` | write | any of `max_overshoot_percent`, `max_settling_time_s`, `max_steady_state_error`, `min_phase_margin_deg` | Updates the targets and returns the current design re-scored against them. |

Named plants accepted as `set_plant`'s `preset`: `second-order`, `first-order-lag`,
`double-integrator`, `dc-motor`, `third-order`, `nonminimum-phase`, `unstable`.

Every parameter on every tool is optional. A write tool given nothing to do says so rather than
guessing, and `set_controller_gains` applies only the gains it is given, so a single gain can be
nudged without restating the others.

Polynomial coefficients are always in descending powers, so `[1, 0.6, 1]` means `s^2 + 0.6s + 1`.
Frequencies are rad/s and angles are degrees at every tool boundary. Invalid input — an improper
transfer function, an all-zero denominator, a non-finite gain — comes back as a readable error
message rather than a broken plot, so the agent can correct itself and retry.

## Try it with an agent

Open the live demo in the ChatGPT desktop app's built-in browser and paste one of these:

- "Tune this controller for under 10% overshoot and settling under 3 seconds."
- "Why is this loop unstable, and what is the largest gain I can use?"
- "Switch to the DC motor plant and design a PI controller with 60 degrees of phase margin."
- "Add derivative action until the overshoot halves, then tell me what it cost in phase margin."
- "Set the spec to 5% overshoot with zero steady-state error, then tell me whether that is
  achievable with PID on this plant."

The site-tools indicator in the address bar lights up while a tool runs, and every call is echoed
into the activity log on the page, so you can see exactly what the agent read and what it changed.

## Running locally

```
git clone <repo-url>
cd webmcp
python -m http.server 8000
```

Then open <http://127.0.0.1:8000>.

**Opening `index.html` over `file://` does not work.** WebMCP is a secure-context API:
`document.modelContext` is `undefined` on a `file://` page, so no tools are registered and the
agent sees nothing at all. `localhost` and `127.0.0.1` do count as secure contexts, so plain HTTP
is fine for local work; a real deployment needs HTTPS. Any static file server will do — there is
nothing to build and nothing to install.

## Using it with ChatGPT

- Use the **ChatGPT desktop app's built-in browser**. Web ChatGPT does not expose site tools.
- Use a model that supports site tools.
- Turn on **Settings > Browser > Permissions > Enable site tools**.
- Site tools are not available in Enterprise or Edu workspaces.

Without any of that the page still works. Every control is on screen, and the feature detection
simply skips tool registration.

## Architecture

```
index.html              Page shell: the three canvases, the controls, the agent activity log.
styles.css              Theme. Defines the custom properties the canvas renderer reads.
src/main.js             Entry point. Wires the store, plots, controls and tool registration.
src/core/
  complex.js            Complex arithmetic.
  poly.js               Polynomial arithmetic in descending powers.
  roots.js              Durand-Kerner simultaneous root finder.
  tf.js                 Transfer functions: PID, series, closed loop, controllable canonical form.
  sim.js                RK4 step response and time-domain metrics.
  freq.js               Frequency response, log-spaced grids, gain and phase margins.
  rlocus.js             Root locus with continuity-sorted branches, and the critical gain.
src/ui/
  store.js              Single source of truth, with a memoised analyse().
  plots.js              Canvas rendering of the step, Bode and pole-zero panels.
  controls.js           DOM controls, metric readout with pass/fail chips, agent log.
src/mcp/tools.js        WebMCP tool registration on document.modelContext.
tests/
  run.mjs               Node test runner.
  harness.mjs           Dependency-free assertions and reporting.
  core.test.mjs         Numeric tests for everything under src/core/.
  browser.html          Browser integration tests for the WebMCP layer and the UI.
```

The simulation is pure client-side JavaScript with no backend and no dependencies: polynomial
arithmetic, a Durand-Kerner root finder for poles and zeros, RK4 integration of the controllable
canonical state space for the step response, and direct evaluation of the transfer function at
`s = jw` for the frequency response. Nothing under `src/core/` touches the DOM, which is why Node
can import those modules unchanged and test the numerics directly.

## Tests

```
node tests/run.mjs
```

No test framework and no dependencies — Node 22 imports the core modules exactly as they ship.
The suite checks the numerics against results that are known independently of this code:

- Analytic second-order formulae. For a plant with known `zeta` and `wn`, the simulated overshoot
  must match `exp(-pi*zeta/sqrt(1-zeta^2))` and the peak time must match
  `pi/(wn*sqrt(1-zeta^2))`, which catches integration error and metric-extraction bugs at once.
- Textbook gain and phase margins, for open loops whose margins can be worked out by hand.
- A cross-check between two independent code paths: the gain at which the root locus crosses into
  the right half-plane must agree with the gain margin computed from the frequency response. The
  two share no code, so agreement is evidence rather than a tautology.

Node cannot import the DOM modules, so the WebMCP layer has its own suite. Serve the repository
and open <http://127.0.0.1:8000/tests/browser.html>; the banner turns green when it passes. It
loads the real `index.html` markup, registers the tools against a stubbed `document.modelContext`,
and checks the parts that only exist in a browser: that all eight tools register, that every
schema sets `additionalProperties: false` and describes each parameter, that `readOnlyHint` is
true on exactly the five read tools, that invalid input comes back as a readable error instead of
a thrown call, that read tools leave the state untouched — and that a write tool's change actually
reaches the sliders and the readout, which is the path the whole human-agent story depends on.

## Licence

MIT. See [LICENSE](LICENSE).
