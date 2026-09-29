# Nirnay — Technical Details

*Nirnay — "the verdict".* A browser-based PID tuning workbench where a person and an AI agent
work the same control loop at the same time, the agent through WebMCP site tools.

This document covers how the project works internally: the architecture, the control-systems
maths and numerical methods, the state model, the WebMCP tool layer, rendering, testing, design
decisions, and the issues found in review and how they were fixed. The [README](README.md) is
the short version; this is the long one.

| | |
| --- | --- |
| Repository | <https://github.com/Gauravtiwari31/Nirnay> |
| Licence | MIT |
| Last updated | 29 Sep 2026, after the fixes listed in [section 14](#14-issues-found-in-review) |
| Live demo / video | Not yet recorded in the repo (the README still says TBD) |

---

## Contents

1. [What it is](#1-what-it-is)
2. [At a glance](#2-at-a-glance)
3. [Architecture](#3-architecture)
4. [Control model and conventions](#4-control-model-and-conventions)
5. [Numerical core (`src/core/`)](#5-numerical-core-srccore)
6. [State and analysis (`src/ui/store.js`)](#6-state-and-analysis-srcuistorejs)
7. [WebMCP layer (`src/mcp/tools.js`)](#7-webmcp-layer-srcmcptoolsjs)
8. [Human interface](#8-human-interface)
9. [Testing](#9-testing)
10. [Robustness and error handling](#10-robustness-and-error-handling)
11. [Performance](#11-performance)
12. [Running, deploying and using it with an agent](#12-running-deploying-and-using-it-with-an-agent)
13. [Design decisions and trade-offs](#13-design-decisions-and-trade-offs)
14. [Issues found in review](#14-issues-found-in-review)
15. [Scope limits](#15-scope-limits)
16. [Repository facts](#16-repository-facts)
17. [Glossary](#17-glossary)

---

## 1. What it is

A plant transfer function `G(s)` sits in a unity negative-feedback loop with a realisable PID
controller `C(s)`. The page shows three live canvas plots:

- the **closed-loop unit-step response**, with the ±2% settling band, peak and settling markers
- the **open-loop Bode plot** (magnitude and phase), with gain and phase margins drawn on
- a **pole-zero map** with the root locus behind it

A human drives `Kp`, `Ki`, `Kd` and the derivative filter pole `N` with sliders and number
fields, picks one of seven textbook plants or types a custom one, and sets a design spec
(maximum overshoot, maximum settling time, maximum steady-state error, minimum phase margin).
A metrics panel scores the design against the spec with PASS/FAIL chips.

The same page registers **eight WebMCP tools** (five read, three write). An agent can read the
exact numbers behind the plots and change the gains, the plant or the spec. One store sits
behind both surfaces, so a tool call and a slider drag take the same code path. Whichever one
moves, the plots redraw and the readout updates.

### Why it needs WebMCP

The plots are `<canvas>` renderings, so there is no DOM text to scrape: a step response is a few
thousand pixels drawn with `lineTo`. A screenshot only lets a vision model estimate ("roughly 25%
overshoot"), and a tuning loop cannot converge on estimates. WebMCP hands the agent the
simulation output itself, computed by the same code that draws the pixels. Write tools return
the post-change metrics in the same call, so each tuning iteration is a single round trip:
propose gains, read real metrics, compare them with the spec, adjust.

---

## 2. At a glance

| | |
| --- | --- |
| Type | Static single-page web app. No backend. |
| Language | Vanilla JavaScript, native ES modules loaded directly by the browser |
| Dependencies | None: no runtime, build or test dependencies, and no `package.json` |
| Build step | None. Deploying means copying the directory to a static host. |
| Rendering | Canvas 2D API, written by hand (no chart library) |
| Numerics | Written by hand: complex arithmetic, polynomial algebra, a Durand-Kerner root finder, RK4 integration, bisection |
| Agent interface | WebMCP: 8 tools registered on `document.modelContext` (5 read, 3 write) |
| Tests | 53 Node tests for the numerics and the store (53/53 passing on Node 22.23.2), plus an in-browser integration suite of 124 checks for the tool layer and the UI (124/124 passing in headless Chrome) |
| Size | About 7,500 lines across 19 source files: 1,526 numerics, 2,822 UI, 717 WebMCP, 1,496 tests, plus HTML and CSS |

---

## 3. Architecture

### 3.1 File map

| File | Lines | Responsibility |
| --- | ---: | --- |
| `index.html` | 265 | Page shell: three canvases, the controls, the metrics readout, the agent activity log |
| `styles.css` | 641 | Theme and layout. Its `:root` custom properties are also the plot palette. |
| `src/main.js` | 57 | Entry point. Wires the controls, plots, store subscription and tool registration, and reports WebMCP status. |
| `src/core/complex.js` | 107 | Complex arithmetic on plain `{re, im}` objects |
| `src/core/poly.js` | 138 | Dense real polynomials in descending powers |
| `src/core/roots.js` | 298 | Durand-Kerner root finder with clustering and canonicalisation |
| `src/core/tf.js` | 174 | Transfer functions: PID, series, closed loop, DC gain, state-space realisation |
| `src/core/sim.js` | 341 | RK4 step response, time-domain metrics, per-pole step weights |
| `src/core/freq.js` | 297 | Frequency response, phase unwrapping, gain and phase margins |
| `src/core/rlocus.js` | 171 | Root locus with continuity-sorted branches, and the critical gain |
| `src/ui/store.js` | 736 | Single source of truth, validation, and a memoised `analyse()` |
| `src/ui/controls.js` | 507 | DOM controls, metrics readout, PASS/FAIL chips, agent activity log |
| `src/ui/plots.js` | 1,579 | Canvas rendering of the step, Bode and pole-zero panels |
| `src/mcp/tools.js` | 717 | WebMCP tool definitions, registration and result formatting |
| `tests/run.mjs` | 15 | Node test entry point |
| `tests/harness.mjs` | 140 | Assertion and reporting harness with no dependencies |
| `tests/core.test.mjs` | 947 | Numeric tests for everything under `src/core/` |
| `tests/store.test.mjs` | 77 | Tests for the store's derived analysis |
| `tests/browser.html` | 317 | Browser integration tests for the WebMCP layer and the UI |

### 3.2 Module dependencies

```
index.html ─── styles.css  (colour tokens; plots.js reads them at runtime)
    │
src/main.js
    ├──► ui/controls.js ──┐
    ├──► ui/plots.js      │   (imports nothing: pure drawing from an analyse() object)
    ├──► mcp/tools.js ────┼──► ui/controls.js (logAgent only)
    │                     ▼
    └──────────────► ui/store.js
                          │
                          ▼
        core/  (DOM-free, importable by Node unchanged)
          sim.js ──► tf.js ──► roots.js ──► poly.js ──► complex.js
          freq.js ─────────────► roots.js, poly.js, complex.js
          rlocus.js ──► freq.js (logspace), roots.js, poly.js
```

Dependencies only point downwards. `core/` and `store.js` never touch the DOM, which is what
lets `node tests/run.mjs` import them directly. `plots.js` imports nothing: it draws whatever
`analyse()` object it is given.

### 3.3 One store, one render path

There is exactly one path from a state change to the screen, and both actors use it:

```
Human: slider "input" event ─┐
                             ├──► store setter ──► version += 1 ──► notify(listeners)
Agent: WebMCP execute() ─────┘                                          │
                                  ┌─────────────────────────────────────┤
                                  ▼                                     ▼
                     controls.render(state)                 drawAll(analyse())
                     (repaint inputs + metrics)             (repaint 3 canvases)
                                  │                                     │
                                  └──────────► analyse() ◄──────────────┘
                                         computed once, memoised on version
```

For a tool call the order is: `guard()` runs the tool body, the body calls a setter, the setter
notifies, and the listeners repaint (the first `analyse()` call computes the result). The tool
then builds its text result from `analyse()`, which is now a cache hit. It therefore reads the
**same analysis object** the pixels were drawn from. Finally the call is written to the activity
log.

### 3.4 Boot sequence (`src/main.js`)

1. `initControls(document.body)`: resolve elements, fill the plant `<select>`, bind events,
   subscribe, first render.
2. `initPlots({step, bode, pz})`: attach the canvases, size the backing stores, paint empty frames.
3. `subscribe(() => drawAll(analyse()))`, then `drawAll(analyse())` for the first real paint.
4. `await registerWebMCPTools()` (top-level `await`, which is why the script is
   `type="module"`), then set the header status to `on`, `pending` (no WebMCP) or `error`.

Tool registration runs after the first paint. The page is fully usable before registration, and
stays usable if it fails.

---

## 4. Control model and conventions

### 4.1 Loop structure

```
 r ──►(+)── e ──► C(s) ── u ──► G(s) ──┬──► y
       ▲ −                              │
       └────────────────────────────────┘
```

| Quantity | Definition | Polynomial form |
| --- | --- | --- |
| Controller | `C(s) = Kp + Ki/s + Kd·N·s/(s+N)` | see 4.2 |
| Open loop | `L(s) = C(s)·G(s)` | `numL = numC·numG`, `denL = denC·denG` |
| Closed loop | `T(s) = L/(1+L)` | `numT = numL`, `denT = denL + numL` |
| Reference | unit step, `r(t) = 1` for `t ≥ 0` | |

### 4.2 Realisable PID

An ideal derivative `Kd·s` is improper: it has no state-space realisation, so the step response
could not be simulated. The derivative is filtered by a pole at `−N` instead (default
`N = 100 rad/s`, clamped to [1, 10000]). Larger `N` approaches the ideal derivative. Over the
common denominator `s(s+N)`:

| Case (`pidTF`) | num | den |
| --- | --- | --- |
| `Ki = 0` and `Kd = 0` (P) | `[Kp]` | `[1]` |
| `Kd = 0` (PI) | `[Kp, Ki]` | `[1, 0]` |
| `Ki = 0` (PD) | `[Kp + Kd·N, Kp·N]` | `[1, N]` |
| otherwise (PID) | `[Kp + Kd·N, Kp·N + Ki, Ki·N]` | `[1, N, 0]` |

The P, PI and PD cases are returned in reduced form on purpose. A cancelling pole/zero pair is
invisible in the transfer function but not in the polynomials. For PD the common factor would
be `s`: it survives into the closed-loop denominator as an exact pole at the origin and makes
every PD design read as marginally stable. That was a real bug until it was fixed
([14.1](#141-pd-control-was-reported-as-unstable-high--fixed)).

### 4.3 Conventions (used across the whole codebase)

| Convention | Rule |
| --- | --- |
| Polynomials | `number[]` in **descending** powers: `[1, 0.6, 1]` is `s² + 0.6s + 1` |
| Complex numbers | Plain `{re, im}` objects, not class instances, so they pass through `JSON.stringify` and the tool boundary unchanged |
| Units | rad/s and degrees at every API and tool boundary; radians internally |
| Undefined quantities | `null` with a stated reason. Never a silent `NaN` or `Infinity`. |
| "Zero" tolerances | Relative, never absolute: `1e-12 × max|coefficient|`. Gains span decades, so "small" only means something relative to the largest coefficient present. |
| Stability | Every closed-loop pole has `Re < −1e-9`. A pole on the imaginary axis counts as not stable. |

### 4.4 Plant catalogue

| Key | `G(s)` | Open-loop poles / zeros | Why it is in the set | Critical `Kp` (P-only) |
| --- | --- | --- | --- | --- |
| `second-order` (default) | `1/(s² + 0.6s + 1)` | `−0.3 ± 0.954j` (ζ = 0.3, ωn = 1) | Classic underdamped plant | none (GM ∞) |
| `first-order-lag` | `1/(s + 1)` | `−1` | Monotone response, no overshoot | none |
| `double-integrator` | `1/s²` | `0, 0` | Marginal under P alone; needs derivative action | marginal for every `Kp` |
| `dc-motor` | `1/(s³ + 11s² + 10s)` | `0, −1, −10` | Type-1 plant (pole at the origin) | 110 |
| `third-order` | `1/(s + 1)³` | triple pole at `−1` | Exercises the repeated-root handling | 8 |
| `nonminimum-phase` | `(1 − s)/(s + 1)²` | zero at `+1`, poles `−1, −1` | Right-half-plane zero: initial undershoot | 2 |
| `unstable` | `1/(s² − s + 2)` | `0.5 ± 1.323j` | Open-loop unstable; P alone cannot stabilise it | never stable under P |

The critical gains in the last column match hand Routh-Hurwitz analysis (DC motor: `11·10 = 110`;
third order: `3·3 − 1 = 8`; non-minimum phase: `2 − K > 0`). They also match the gain margins
the tool layer reports for `Kp = 1`.

---

## 5. Numerical core (`src/core/`)

Every module is pure and DOM-free. Each export carries JSDoc with `@param` and `@returns`.

### 5.1 `complex.js`

- `cx, cadd, csub, cmul, cscale, cabs, carg, cdiv` on `{re, im}`.
- **Division uses Smith's algorithm**: it factors out the larger denominator component before
  squaring, so a denominator with large parts cannot overflow the naive `re² + im²` term.
- Division by exact zero returns `{re: Infinity, im: 0}`, never `NaN`.
- `cabs` uses `Math.hypot`, which avoids intermediate overflow.

### 5.2 `poly.js`

- `polyMul`: discrete convolution of the coefficient vectors.
- `polyAdd`: **right-aligns** operands of different length, so equal powers of `s` line up (this
  follows from storing coefficients in descending powers).
- `polyTrim`: drops leading coefficients with `|c| ≤ 1e-12 × max|c|` and always keeps at least
  one. Because the threshold is relative, scaling a polynomial by `1e-6` does not erase it.
- `polyEvalComplex`: Horner's rule at a complex point.
- `polyDer`: the derivative, used for residues at simple poles.
- `polyDeg`: degree after trimming; `-Infinity` for the zero polynomial.

### 5.3 `roots.js`: Durand-Kerner root finder

Every pole, zero, damping ratio, stability verdict and root-locus point in the app comes from
this file. `polyRoots(p)` runs this pipeline:

1. **Validate and trim.** Non-finite input, or degree ≤ 0 after trimming, returns `[]`.
2. **Peel roots at the origin.** Trailing coefficients below `1e-12 × max|c|` are removed and
   each one becomes an exact root at `0`. Without this, a zero constant term drags every iterate
   towards the origin together, the mutual-repulsion denominators collapse and convergence
   stalls. Any plant with an integrator, such as `[1, 11, 10, 0]`, would hit this.
3. **Normalise to monic.**
4. **Seed** with `z_k = (0.4 + 0.9i)^k`. The seed is complex, inside the unit circle and not a
   root of unity. Seeds placed symmetrically on the real axis would trap a real polynomial's
   iterates on the real axis forever.
5. **Iterate in Gauss-Seidel form:** `z_k ← z_k − p(z_k) / ∏_{j≠k}(z_k − z_j)`, applied in
   place so that each correction already sees the corrections made earlier in the same sweep.
   This takes roughly half as many sweeps as the Jacobi form. Stop when the largest relative
   correction falls below `1e-12`, or after 500 sweeps. If two iterates collide exactly, the
   current one is nudged by `(1e-6, 1e-6)`.
6. **Merge numerical clusters.** A root of multiplicity `m` can only be located to about
   `eps^(1/m)`: roughly 1e-8 for a double root and 1e-5 for a triple. Durand-Kerner leaves such
   a root as a small ring of iterates around it, which would otherwise appear as a lightly damped
   complex pair.
   - Cluster tolerance = `clamp(8 × final residual, 1e-7, 1e-3)`, with single-linkage grouping.
     A tolerance above 1e-3 would start discarding genuinely distinct roots.
   - The shared value is **not** the mean of the ring, which would inherit the ring's asymmetry.
     It comes from **Vieta's first identity**: the roots of a monic polynomial sum to `−a₁`, so a
     group of `m` iterates takes the value `(−a₁ − Σ roots outside the group) / m`. The roots
     outside the group are simple and accurate to machine precision, so the recovered value is
     too. `(s+1)³` resolves to exactly `−1`, not `−0.9999972`.
7. **Canonicalise.** Imaginary parts below `1e-9 × max(1, |re|)` are snapped to exactly real, and
   each complex pair is rewritten as an exact conjugate pair (averaged real part, averaged
   `|im|`). This keeps the pole-zero map symmetric to the pixel and gives both poles of a pair the
   same damping ratio.
8. **Sort deterministically**: descending real part, then descending imaginary part. Repeated
   calls on unchanged state give identical output, so the plots do not jitter.

| Constant | Value | Meaning |
| --- | --- | --- |
| `MAX_ITER` | 500 | Sweep limit |
| `CONVERGE_TOL` | 1e-12 | Relative correction that counts as converged |
| `SEED` | 0.4 + 0.9i | Initial-estimate generator |
| `TOL_FLOOR` / `TOL_CAP` | 1e-7 / 1e-3 | Cluster tolerance bounds |
| `CLUSTER_SLACK` | 8 | Residual multiplier for the cluster radius |
| `REAL_SNAP` | 1e-9 | Relative threshold for snapping to real |

Cost: each sweep is O(d²) for a degree-d polynomial. The app's loops are degree ≤ 12 or so
(custom plants are capped at order 10), so this is cheap.

### 5.4 `tf.js`: transfer-function algebra

- `pidTF(Kp, Ki, Kd, N = 100)`: see [4.2](#42-realisable-pid). Throws on non-finite gains or
  `N ≤ 0`.
- `series(a, b)`: multiplies numerators and denominators, then trims both.
- `closedLoop(L)`: `{num: L.num, den: trim(L.den + L.num)}`. The trim matters when the leading
  terms cancel, which would otherwise leave a phantom extra pole.
- `errorTF(L)`: `E/R = 1/(1+L)`. Used only by tests.
- `dcGain(tf)`: ratio of the constant terms. Returns `null` when the denominator's constant term
  is negligible (a pole at the origin), meaning there is no finite steady state.
- `polesZeros(tf)`: `polyRoots` of the denominator and numerator.
- `toStateSpace(tf)`: **controllable canonical realisation with direct feedthrough.** For
  `T(s) = (b₀sⁿ + … + bₙ)/(sⁿ + a₁sⁿ⁻¹ + … + aₙ)`, with the denominator made monic and the
  numerator right-aligned to length `n+1`:

  ```
  D    = b₀
  b'ᵢ  = bᵢ − b₀·aᵢ                 (i = 1..n)
  A    = companion matrix: ones on the superdiagonal, bottom row [−aₙ … −a₁]
  B    = [0 … 0 1]ᵀ
  C    = [b'ₙ … b'₁]
  ```

  Splitting out `D` is what allows systems with `deg num = deg den` (every PID loop with
  `Kd ≠ 0`) to be realised at all. Returns `null` for an improper TF.

### 5.5 `sim.js`: step response and time-domain metrics

**Choosing the simulation window (`chooseHorizon`)**

| Case | `tEnd` |
| --- | --- |
| Stable (every pole `Re < −1e-9`) | `clamp(8 / σ_min, 0.5, 200)` s: eight time constants of the slowest pole |
| Unstable or marginal | `clamp(8 / max(1e-3, σ), 0.5, 30)` s: long enough to show the divergence |
| Pure gain (no poles) | 0.5 s floor |

**Integration (`stepResponse`)**

- Fixed-step classical **RK4** on `ẋ = Ax + B·1`, with `y = Cx + D`.
- Records `n = 800` samples after `t = 0` (801 points). The integrator takes **20 internal steps
  per recorded sample**, so `dt = tEnd / 16000`. The numerics are resolved an order of magnitude
  finer than the plotted grid, which keeps the peak and the settling band accurate on lightly
  damped systems.
- The four RK4 stage vectors are `Float64Array` scratch buffers allocated once, not per step.
- If the output overflows to a non-finite value, the trace stops at the last finite sample and
  `truncated = true`. The plots never receive `NaN`.

**Metrics (`stepMetrics`)**

The response is first normalised by the final value (`yn = y / y∞`). Every threshold then
becomes a plain fraction, and the logic also works for responses that settle at a negative value.

| Metric | Definition | Numerical detail |
| --- | --- | --- |
| Final value `y∞` | Closed-loop DC gain `T(0)` | Only when stable; otherwise `null` |
| Steady-state error | `1 − y∞` (signed; the spec compares `|ess|`) | Exact, from DC gain, not read off the trace |
| Peak value / time | Maximum of `yn` | **Parabolic refinement** through the three samples around the maximum: vertex offset `½(s₋ − s₊)/(s₋ − 2s₀ + s₊)`, accepted if `|offset| ≤ 1` |
| Overshoot | `max(0, 100·(peak_n − 1))` % | Clamped at 0, because a monotone response peaks a hair below `y∞` at the window edge |
| Rise time | 10%→90% of `y∞` | First crossings, linearly interpolated between samples |
| Settling time | **Last** exit from the ±2% band | Scans **backwards** from the end; the band-edge crossing is linearly interpolated. `0` if the response never leaves the band; `null` if it is still outside when the window ends. |

Edge cases:
- Unstable or marginal closed loop: every metric is `null`.
- `|y∞| < 1e-12` (the response decays back to zero): no percentage or band exists, so only peak
  and steady-state error are reported.

The backward scan for settling time matters. A lightly damped response crosses into and out of
the band repeatedly, and the first entry, which is what a person eyeballing a plot usually
reports, can be badly wrong.

**Per-pole step weights (`stepModeWeights`)**

With simple poles the step response expands as `y(t) = T(0) + Σ Rᵢ·e^(pᵢt)`, where `Rᵢ` is the
residue of `T(s)/s` at `pᵢ`:

```
Rᵢ = num(pᵢ) / (pᵢ · den'(pᵢ))          weightᵢ = |Rᵢ| / |Re pᵢ|
```

The weight is the area under the magnitude of that pole's own term: large when the term is both
big and slow to decay. A pole nearly cancelled by a zero has a tiny residue, so it weighs little
even when it is the pole closest to the imaginary axis. A repeated pole (`den'(p) = 0`) carries
a `t·e^(pt)` term and gets an infinite weight. The store uses these weights to pick the dominant
pole ([6.6](#66-derived-judgements)).

### 5.6 `freq.js`: frequency response and margins

- `evalAt(tf, ω)` evaluates `num(jω)/den(jω)` exactly. The response itself involves no
  approximation.
- `logspace(lo, hi, n)` returns exactly `n` points with the endpoints pinned, so round-tripping
  through the exponent cannot drift them.
- `frequencyResponse(tf, ω[])` returns `{w, mag, magDb, phaseDeg}`, with the phase **unwrapped**:
  whenever adjacent samples differ by more than 180°, a 360° offset is applied. Without this, both
  the Bode phase curve and the phase margin would be wrong wherever the true phase crosses the
  ±180° branch cut.
- `autoFreqRange(tf)` picks decade exponents two decades beyond the slowest and fastest non-origin
  pole/zero magnitudes, clamped to `[−3, 4]`. It falls back to `[−2, 2]` when every singularity
  is at the origin.

**`margins(L)`** follows these steps:

1. Scan grid: 4,001 log-spaced points over `autoFreqRange ± 2` further decades (up to
   `10⁻⁵ … 10⁶` rad/s). The margin search deliberately looks beyond the plotted range, because a
   crossover outside the "interesting" band would otherwise be reported as "no margin".
2. **Gain crossover `ωgc`**: the first sign change of `|L| − 1`, refined by **geometric-midpoint
   bisection** (80 steps) on `log|L(jω)|`, which stays well conditioned across many decades.
3. **Phase margin** = `180° + ∠L(jωgc)`, normalised into `(−180°, 180°]`.
4. **Phase crossover `ωpc`**: the first place the unwrapped phase passes from one side of −180°
   to the other, refined by bisection on **`Im{L(jω)}`**. At −180°, `L` is real and negative, so
   its imaginary part changes sign exactly there. Bracketing with the unwrapped phase first stops
   the bisection from latching onto the 0° crossing, where `Im{L}` also vanishes. Samples within
   1e-9° of −180° count as sitting *on* the line, not as crossings.
5. **Gain margin** = `1/|L(jωpc)|` (linear) and `−20·log₁₀|L(jωpc)|` (dB).
6. **`phaseOnBoundary`** is `true` when the phase is −180° at every scanned frequency. The
   standard case is `L = K/s²`: its Nyquist plot lies on the negative real axis, the closed loop
   `s² + K` is marginal at any gain, and there is no gain margin at all, not an infinite one.

`refineCrossing` handles a subtle degenerate case. When a crossing lands exactly on a grid point,
`f` there is zero only to within rounding, so both ends of the tight bracket can share a sign. It
tries the tight bracket first, then widens by one cell on each side, and finally returns the
endpoint closest to satisfying the condition.

Every field is `null` when its crossing does not exist: no gain crossover means PM is `null`, and
no phase crossover means GM is `null`. The tools report a `null` GM as "infinite", or as
"undefined" when `phaseOnBoundary` is set. Eighty halvings shrink the bracket far below the
1e-10 relative tolerance quoted in the README.

### 5.7 `rlocus.js`: root locus and critical gain

- `rootLocus(L)` **factors `den(s) + k·num(s)` directly** for
  `k ∈ {0} ∪ logspace(−3, 3, 200)` (201 gains). This is simpler and more robust than the classical
  construction rules (asymptotes, breakaway points, departure angles), and it handles
  non-minimum-phase and unstable plants without special cases.
  - `k` scales the **current** `L(s)`, which already includes the controller gains, so `k = 1`
    is the current operating point.
- **Continuity sorting:** at each new gain, the roots are matched to the previous positions by
  greedy global nearest-neighbour: all `(branch, root)` distances are sorted and assigned
  cheapest first. Without this, branches take whatever order the root finder returns, and drawn
  lines jump between branches wherever poles pass close together. The most visible case is the
  imaginary-axis crossing, where a conjugate pair would appear to swap. If the characteristic
  polynomial loses degree, an unmatched branch holds its last position, so every branch stays
  index-aligned with `k`.
- `criticalGain(L)` finds the gain at which the loop first goes unstable. It scans 601 gains
  over `10⁻⁶ … 10⁶` on `max Re(root)` crossing zero, then refines with 100 linear bisections. It
  starts just above `k = 0` because a loop with an open-loop integrator sits exactly on the
  boundary at `k = 0`. It works entirely in the s-plane and shares no code path with the
  frequency-domain gain margin. **It is used only by the test suite**, as an independent
  cross-check (see [9.3](#93-highlights)). At runtime, `get_pole_zero_map` reports the critical
  gain from the gain margin.

---

## 6. State and analysis (`src/ui/store.js`)

### 6.1 State and defaults

```js
{
  plantKey: "second-order",               // null for a custom plant
  plant:    { num: [1], den: [1, 0.6, 1] },
  Kp: 1, Ki: 0, Kd: 0, N: 100,
  spec: { overshoot: 10, settlingTime: 4, steadyStateError: 0.02, phaseMargin: 45 }
}
```

The default design deliberately fails the spec (50.6% overshoot, steady-state error 0.5), which
gives an agent or a human something to fix.

### 6.2 Setters and validation

All setters accept partial updates, validate before mutating, and throw an `Error` whose message
is written to be relayed to an agent or shown to a person.

| Setter | Rules |
| --- | --- |
| `setGains({Kp?, Ki?, Kd?, N?})` | Must name at least one known key. Values must be finite numbers. `Kp/Ki/Kd` are clamped to `[−1000, 1000]` and `N` to `[1, 10000]`: out-of-range numbers are clamped, non-numbers are rejected. |
| `setPlant({key})` or `({num, den})` | `key` must be in `PLANTS` (and wins if both are given). Custom coefficients must be non-empty arrays of finite numbers, of order ≤ 10; the denominator must be non-zero; `deg num ≤ deg den` (improper plants are rejected). A custom plant sets `plantKey = null`. |
| `setSpec({overshoot?, settlingTime?, steadyStateError?, phaseMargin?})` | Must name at least one key. Values must be finite and ≥ 0. |

`getState()` returns a deeply frozen copy, and the `PLANTS` catalogue is frozen at load time, so
no consumer can mutate state except through a setter.

### 6.3 Memoisation

Each setter bumps an integer `version`. `analyse()` recomputes only when
`cacheVersion !== version` and otherwise returns **the very same object**. That lets the controls,
the plots and the tool layer each call `analyse()` freely on one change, while the simulation
runs once.

### 6.4 `analyse()` never throws

The plots, the controls and the tools all depend on `analyse()` returning a well-formed object,
so it is total:

- Every numeric stage runs inside `attempt(fn, fallback)`, so one pathological plant degrades a
  single field instead of the whole page.
- `sanitiseMetrics`, `sanitiseMargins`, `sanitiseTrace` and `sanitiseLocus` replace every
  non-finite number with `null` (or truncate a trace at its first bad sample, keeping arrays
  index-aligned).
- If the derivation itself throws, `emptyAnalysis()` returns an all-null object with the same
  shape.

### 6.5 Shape of the analysis object

| Field | Content |
| --- | --- |
| `plant`, `controller`, `openLoop`, `closedLoop` | `{num, den}` transfer functions |
| `step` | `{t[], y[], tEnd}`: finite prefix of the step trace |
| `metrics` | `{stable, finalValue, overshoot, peakValue, peakTime, riseTime, settlingTime, steadyStateError}` |
| `margins` | `{gainMarginDb, gainMargin, phaseMarginDeg, gainCrossoverW, phaseCrossoverW, phaseOnBoundary}` |
| `poles`, `zeros` | Closed-loop roots |
| `openLoopPoles`, `openLoopZeros` | Open-loop roots (context on the pole-zero map) |
| `dominant` | `{pole, zeta, wn}` or `null` |
| `bode` | `{w[], magDb[], phaseDeg[]}`: 400 log-spaced points, with non-finite samples dropped |
| `locus` | `{k[], branches[][]}` |
| `stable` | `true` iff closed-loop poles were computed **and** all have `Re < −1e-9` |
| `spec` | `{targets, results: {overshoot, settlingTime, steadyStateError, phaseMargin}, allPass}` |

### 6.6 Derived judgements

- **Stability** comes from the closed-loop poles, not from the margins. Poles that could not be
  computed never read as stable.
- **Dominant pole**: when stable, the pole with the largest step weight `|R|/|Re p|`
  ([5.5](#55-simjs-step-response-and-time-domain-metrics)). Each conjugate pair is scored once,
  from its upper-half member, which is also the member displayed. Weights within 1e-9 of each
  other (relative) count as a tie, and a tie goes to the pole nearer the axis: the slower one,
  which sets the settling time. If the weights cannot be computed, it falls back to the pole
  nearest the axis. When the loop is not stable, the rightmost pole dominates, because its
  growth swamps everything else. `ζ = −Re(p)/|p|` and `ωn = |p|`; negative zero is normalised
  to 0.
  - Why not simply "the pole closest to the axis"? Integral action routinely creates a slow pole
    sitting beside a zero. With `Kp = 12, Ki = 4, Kd = 3` on the default plant, that rule picked a
    real pole at −0.336 (next to a zero at −0.367) and reported ζ = 1 while the response
    overshot 22.6%. The weighted rule picks the pair at `−1.69 ± 3.07j` (ζ = 0.48).
- **Spec verdict**: `overshoot ≤ target`, `settlingTime ≤ target`, `|ess| ≤ target` and
  `PM ≥ target`. A value that could not be measured (`null`) **never passes**. `allPass` is the
  AND of all four.

### 6.7 Subscribers

`subscribe(fn)` returns an idempotent unsubscribe function. `notify()` iterates over a **copy**
of the listener set, so a listener may subscribe or unsubscribe during dispatch, and it catches
each listener's exceptions so one failing subscriber cannot abort the state change or starve the
others.

---

## 7. WebMCP layer (`src/mcp/tools.js`)

### 7.1 Registration

```js
const ctx = typeof document !== "undefined" ? document.modelContext : undefined;
if (!ctx || typeof ctx.registerTool !== "function") {
  return { available: false, count: 0, unregister: () => {} };   // page works normally
}
const controller = new AbortController();
for (const tool of TOOLS) {
  handles.push(await ctx.registerTool(
    { name, description, inputSchema, annotations, execute: guard(tool.label, tool.run) },
    { signal: controller.signal },
  ));
}
```

- **`document.modelContext`, not `navigator.modelContext`.** The latter is the older MCP-B era
  spelling and is not what current implementations (including ChatGPT's built-in browser) expose.
- **Feature detection** makes WebMCP additive. Without it, the page is still a complete tuning
  instrument.
- Tools are registered **on the top-level document**. ChatGPT's browser does not discover tools
  inside iframes, and it does not support the declarative HTML-form API, so everything is
  registered from JavaScript.
- `unregister()` tries every withdrawal route, because implementations differ: the handle's own
  `unregister()`, then `ctx.unregisterTool(name)`, and finally `controller.abort()` on the signal
  passed at registration.

### 7.2 Tool surface

| Tool | `readOnlyHint` | Inputs (all optional) | Returns |
| --- | :---: | --- | --- |
| `get_system` | true | none | The full design report (7.4): gains, `C(s)`, `G(s)`, `T(s)`, stability, step metrics, margins, closed-loop poles, dominant pole, spec verdict. This is the orientation call. |
| `run_step_response` | true | `include_samples: boolean` | Overshoot, 10–90% rise, peak value and time, 2% settling, final value, steady-state error. With samples: about 40 evenly spaced `(t, y)` pairs. |
| `get_frequency_response` | true | `include_samples: boolean` | `L(s)`, PM with `ωgc`, GM (linear and dB) with `ωpc`. With samples: about 30 log-spaced `(ω, dB, deg)` triples. |
| `get_pole_zero_map` | true | none | Closed- and open-loop poles and zeros, the dominant pole with ζ and ωn, and the critical gain (from the GM) with the imaginary-axis crossing frequency. |
| `evaluate_design` | true | none | Every spec line: measured value, target, PASS/FAIL, and the signed margin ("inside/outside by X"), plus an overall verdict. This tells the agent when it is finished. |
| `set_controller_gains` | false | `Kp`, `Ki`, `Kd`, `N` | Applies only the gains given, redraws, and returns the full design report. |
| `set_plant` | false | `preset` (enum), or `numerator` + `denominator` | Switches the plant, redraws, and returns the full design report. |
| `set_design_spec` | false | `max_overshoot_percent`, `max_settling_time_s`, `max_steady_state_error`, `min_phase_margin_deg` | Updates the targets and returns the design re-scored against them. |

### 7.3 Schema conventions

- `type: "object"` with `additionalProperties: false` on every tool.
- Every property has a substantive `description` that states units, the effect on the design
  (for example, raising `Kp` "speeds up the response … at the cost of more overshoot and less
  phase margin"), clamping ranges and defaults.
- `required: []` everywhere. Every parameter is optional by design: `set_controller_gains` can
  nudge a single gain without restating the others, and a write given nothing to do returns an
  error rather than guessing.
- `set_plant.preset` is an `enum` generated from `Object.keys(PLANTS)`, so the schema cannot
  drift from the catalogue.
- `readOnlyHint: true` on exactly the five read tools. Read tools run without confirmation
  prompts; the three write tools change what the human is looking at, so they get the host's
  confirmation treatment.
- Tool descriptions say *why* to use the tool rather than the page, for example "Use this instead
  of trying to read the step-response plot: the plot is a canvas rendering…". In the smoke test
  the agent first reached for generic browser control, and good descriptions are what push it to
  the site tools instead.

### 7.4 Result format

Results are `{content: [{type: "text", text}]}` holding **dense plain text**, not JSON. Each line
is labelled with its units, which an LLM reads reliably while the result stays compact.

- `n(v)` formats numbers: 4 decimal places with trailing zeros trimmed, scientific notation below
  `1e-4` or at `1e6` and above, and the literal `undefined` for non-finite values.
- `formatPoly` / `formatTF` render polynomials as `s^2 + 0.6s + 1`, bracketing a multi-term
  numerator so the ratio reads unambiguously: `(2s + 1) / (s^2 + 3s)`.
- When a design has no steady state, the text names the cause from the closed-loop poles:
  right-half-plane poles (with a count), a pole at the origin (a free integrator), or poles on
  the imaginary axis (marginal). Each cause calls for a different fix.
- `formatRoots` pairs complex conjugates the way an engineer writes them: `-0.3 +/- 1.382i`.
- `formatSpec` states, for each target, the value, the relation, the target, PASS/FAIL and
  "inside/outside by X". The signed slack lets an agent tell "nearly there" from "badly wrong"
  without a second call.

**Two rules for results:**

1. **Every write returns the full post-change report.** A tuning iteration costs one round trip
   instead of two (write, then read to find out what happened). The agent's reasoning stays
   anchored to a measurement rather than to its own prediction of what the gains would do.
2. **No bare acknowledgements.** Every result carries numbers the agent can verify against, which
   is also what lets it notice when a change made things worse.

### 7.5 `guard()`: errors as results

Every `execute` is wrapped by `guard(label, fn)`:

- The tool body runs inside `try`. On success, a one-line summary goes to the on-page activity
  log and the text is returned.
- On failure, the log entry is suffixed with `- rejected: <reason>` and the tool **returns**
  `Error: <message>` rather than throwing. A thrown call gives the agent nothing to correct
  against; a message naming the offending argument lets it retry successfully.
- Non-object `args` are coerced to `{}`.

### 7.6 A real session

The outputs below were captured by running the actual tool functions in Node against a stubbed
`document.modelContext`. They are not written by hand.

**`get_system` on the default design**

```
Controller: Kp=1 Ki=0 Kd=0 (derivative filter N=100)
  C(s) = 1
Plant (preset "second-order"): 1 / (s^2 + 0.6s + 1)
Closed loop: STABLE  T(s) = 1 / (s^2 + 0.6s + 2)
Step:  overshoot 50.5629% | rise 0.8605 s | settle 12.0655 s | peak 0.7528 @ 2.2733 s | final 0.5 | ess 0.5
Freq:  PM 50.2082 deg @ 1.2806 rad/s | GM infinite (the open-loop phase never reaches -180 deg)
Closed-loop poles: -0.3 +/- 1.382i
Dominant pole -0.3 +/- 1.382i: zeta 0.2121, wn 1.4142 rad/s
SPECS NOT MET
  overshoot: 50.5629 % (target <= 10 %) FAIL, outside by 40.5629 %
  settling time: 12.0655 s (target <= 4 s) FAIL, outside by 8.0655 s
  steady-state error: 0.5 (target <= 0.02) FAIL, outside by 0.48
  phase margin: 50.2082 deg (target >= 45 deg) PASS, inside by 5.2082 deg
```

**`set_controller_gains {Kp: 12, Ki: 4, Kd: 3}`**: one call applies the change and returns the
result:

```
Controller: Kp=12 Ki=4 Kd=3 (derivative filter N=100)
  C(s) = (312s^2 + 1204s + 400) / (s^2 + 100s)
Plant (preset "second-order"): 1 / (s^2 + 0.6s + 1)
Closed loop: STABLE  T(s) = (312s^2 + 1204s + 400) / (s^4 + 100.6s^3 + 373s^2 + 1304s + 400)
Step:  overshoot 22.5622% | rise 0.2955 s | settle 4.3007 s | peak 1.2256 @ 0.7042 s | final 1 | ess 0
Freq:  PM 51.6877 deg @ 4.2431 rad/s | GM infinite (the open-loop phase never reaches -180 deg)
Closed-loop poles: -0.3361, -1.6876 +/- 3.0714i, -96.8887
Dominant pole -1.6876 +/- 3.0714i: zeta 0.4815, wn 3.5045 rad/s
SPECS NOT MET
  overshoot: 22.5622 % (target <= 10 %) FAIL, outside by 12.5622 %
  settling time: 4.3007 s (target <= 4 s) FAIL, outside by 0.3007 s
  steady-state error: 0 (target <= 0.02) PASS, inside by 0.02
  phase margin: 51.6877 deg (target >= 45 deg) PASS, inside by 6.6877 deg
```

**Invalid input comes back as a correctable message:**

```
set_controller_gains {Kp: "loud"}
  → Error: Kp must be a finite number, got "loud".
set_plant {}
  → Error: Nothing to set: give preset (one of second-order, first-order-lag, double-integrator,
    dc-motor, third-order, nonminimum-phase, unstable), or numerator and denominator coefficient arrays.
set_plant {numerator: [1, 0, 0], denominator: [1, 1]}
  → Error: Numerator degree (2) exceeds denominator degree (1); such a transfer function is
    improper and not physically realizable.
```

**A marginal design says why** (the double integrator under `Kp = 1`):

```
Closed loop: UNSTABLE  T(s) = 1 / (s^2 + 1)
Step:  no steady state - the closed loop is marginally stable (poles on the imaginary axis), so the
       response oscillates without settling; overshoot, settling time and steady-state error are undefined
Freq:  PM 0 deg @ 1 rad/s | GM undefined (the open-loop phase sits at -180 deg at every frequency,
       so the loop is marginal at any gain)
```

### 7.7 What the agent gets that scraping cannot

| Quantity | From a screenshot | From Nirnay's tools |
| --- | --- | --- |
| Overshoot, peak time | Estimated from pixels | RK4 at 20× oversampling, peak refined parabolically |
| Settling time | Usually the *first* band entry | *Last* band exit, scanned backwards and interpolated |
| Steady-state error | Guessed from where the curve seems to flatten | Exact closed-loop DC gain; `null` with a reason if no steady state exists |
| Gain and phase margins | Nearest plotted grid point | Crossovers bisected to machine precision |
| Pole locations, ζ, ωn | Not recoverable | Exact roots, conjugate pairs made exact |
| "Am I done?" | Agent's own judgement | `evaluate_design`: per-target PASS/FAIL with signed slack |

---

## 8. Human interface

### 8.1 Page (`index.html`)

- Three columns: **controls** (PID, plant, design spec), **plots** (step response full width,
  then Bode and pole-zero side by side), **readout** (metrics, agent activity, a "For agents"
  note).
- Responsive CSS grid: `320px | 1fr | 320px` above 1280 px; two columns (controls and readout,
  plots full width below) up to 820 px; a single column below that.
- Accessibility:
  - each canvas has `role="img"`, an `aria-label`, and fallback text pointing to the metrics
    panel where its numbers are listed
  - the WebMCP status line is `role="status" aria-live="polite"`
  - the agent log is `role="log" aria-live="polite"`
  - plant errors are `role="alert"`
  - every input has a `<label>`

### 8.2 Controls (`src/ui/controls.js`)

- **Holds no state of its own.** Everything is painted from the store inside a `subscribe()`
  callback, which is why an agent's `set_controller_gains` visibly moves the sliders.
- **Binding:** on each `input` event, a value that parses as a finite number is pushed to the
  store (so dragging a slider retunes live). On `blur`, the field is repainted from the store, so
  half-typed values such as `""`, `"-"` or `"1."` do not linger and clamps become visible.
- **Focus-aware sync:** `syncNumeric` leaves a focused field alone if it already parses to the
  stored value, so typing `2.50` is not rewritten to `2.5` mid-keystroke, while an agent-driven
  change or a clamp still repaints immediately. Free-text coefficient fields are never
  overwritten while focused.
- Sliders span 0–50 (step 0.01). The number fields accept anything the store accepts
  (±1000, clamped), and a slider gets `data-clamped="true"` when the value is outside its range.
- **Custom plant:** coefficients are split on whitespace or commas, highest power first, and
  applied with the button or Enter. Store errors are shown inline under the fields.
- **Agent activity log:** `logAgent()` prepends a timestamped line (a `<time>` element with an
  ISO `dateTime`) and caps the log at 50 entries. It uses `textContent` only, so agent-supplied
  strings such as preset names or coefficient arrays cannot inject markup.
- **Readout:** 12 numeric metrics at fixed precision (em dash for `null`), the dominant pole as
  `a ± bj`, PASS/FAIL chips on the four spec rows (tooltip `Target ≤ 10 %`), and STABLE/UNSTABLE
  and SPEC MET/NOT MET badges. Verdicts always come from `analyse().spec`, never from a local
  recomputation.

### 8.3 Plots (`src/ui/plots.js`)

**Rendering pipeline**

- **HiDPI:** the backing store is sized to the CSS content box × `devicePixelRatio`, capped at 3×
  because beyond that the extra pixels are invisible. The context transform is reset to the DPR
  on every paint, and 1 px lines are snapped to pixel centres (`crisp()`).
- **Sizing:** a `ResizeObserver` supplies the content box without a layout flush. Canvas
  `width`/`height` are assigned only on a real change, because assigning them resets the context.
  Resizes are coalesced into one `requestAnimationFrame` repaint.
- **Theme:** colours are read from CSS custom properties with `getComputedStyle` and cached for
  500 ms, so a 60 fps redraw does not hit the style system every frame. Missing variables fall
  back to the system colours `Canvas`/`CanvasText`.
- **Isolation:** each panel renders inside `try/catch`. A malformed analysis makes that one panel
  say "plot unavailable" while the others still draw.
- **Degenerate geometry:** series stroking skips non-finite samples (lifting the pen) and clamps
  pixel coordinates to a few box-widths outside the plot, so a diverging response cannot produce
  degenerate paths.
- Non-ASCII glyphs (ω, ζ, °, ±, ∞) are written as escapes, so the source file stays pure ASCII.

**Step panel**
- The time axis uses the simulator's horizon. The y range is capped at 6× the scale of the early
  transient, so a diverging response does not squash the plot, with a "y axis clipped" tag when
  that happens. The unit reference is always on screen.
- Shaded ±2% band around the final value, a dashed unit-reference line, a settling-time marker
  coloured by its spec verdict, and a peak marker with a drop line.
- Top-right badge with overshoot, settling time and steady-state error, each coloured by its
  PASS/FAIL result, and an "UNSTABLE" tag when appropriate.

**Bode panel**
- Magnitude (55% of the height) and phase stacked over a shared log-frequency axis snapped to
  whole decades, with minor ticks when there are 8 decades or fewer.
- Conventional steps: dB ticks from `[1, 2, 5, 10, 20, 40, 60, 100, 200]` and degree ticks from
  `[15, 30, 45, 90, 180, 360, 720]`. Magnitude is clamped to ±160 dB and phase to ±1080°.
- Reference lines at 0 dB and at **every** `−180° + 360°k` inside the range, because the phase is
  unwrapped.
- Dashed `ωgc` (green) and `ωpc` (ochre) guides, a **GM bracket** from 0 dB down to the curve at
  `ωpc`, and a **PM bracket** from the correct −180° branch up to the curve at `ωgc`.
- A margins badge. A missing gain margin shows as `∞` in green, or as `—` in ochre when the
  phase sits on −180° everywhere (`phaseOnBoundary`).

**Pole-zero panel**
- **Equal aspect ratio** (one scale for both axes). The window is fitted to the poles and zeros
  only, never to the locus branches, which run off to infinity. At least 22% of the width always
  shows the right half-plane, which is shaded so instability reads at a glance.
- Faint root-locus branches, dashed constant-ζ rays through the dominant pole (for `0 < ζ < 1`),
  open-loop markers in grey underneath, closed-loop markers in colour on top, and unstable
  closed-loop poles in the warning colour.
- A legend (drawn only if it fits within 70% of the box) and a stability/ζ/ωn badge.

### 8.4 Theme (`styles.css`)

The `:root` custom properties are the single source of truth for colour, shared by the page
chrome and the canvases.

| Token | Value | Use |
| --- | --- | --- |
| `--accent` | `#1f4e9c` ink blue | The response curve, primary pen |
| `--accent-2` | `#b03a2e` oxide red | Reference, limits, closed-loop zeros, phase curve |
| `--warn` | `#9a6b1f` ochre | Phase crossover, GM, unstable poles, RHP shading |
| `--ok` | `#1b7a4b` green | PASS, gain crossover, PM, settling band |
| `--agent` | `#0e7490` teal | Agent-facing surfaces |
| `--bg` / `--panel-2` | `#ffffff` / `#eaeef4` | Plot "paper" on a desk-coloured page |

The theme is light only (`color-scheme: light`).

---

## 9. Testing

### 9.1 Philosophy

Every expected value is **derived independently of the implementation**: from a closed-form
analytic solution, a hand-worked textbook example (with the derivation in a comment above the
test), or agreement between two code paths that share no code. None was produced by running the
code and pasting its output.

### 9.2 Node suite: `node tests/run.mjs` (53 tests, all passing)

| Module | Tests | Covers |
| --- | ---: | --- |
| complex | 2 | Hand arithmetic, divide-by-zero contract |
| poly | 7 | Multiplication, right-aligned addition, scaling, *relative* trimming, degree, derivative, Horner at complex points |
| roots | 6 | Distinct real roots, pure imaginary pairs, double and triple roots (tolerances justified by `eps^(1/m)`), origin peeling, quadratic-formula pairs, degenerate input; ordering contract |
| tf | 10 | P/PI/PD/PID forms, a PD loop's hand-derived closed-loop polynomial with every pole in the LHP, series, closed loop and error TF (identity checked at an arbitrary complex point), DC gain including `null`, poles and zeros, state-space with feedthrough, non-monic, improper |
| sim | 13 | Horizon selection, trace shape (RK4 matches the closed form to 1e-6), a 3×2 grid of analytic second-order cases, first-order exact metrics, unstable plant, `null`-not-`NaN` at the origin, non-unit DC gain, step weights from hand partial fractions |
| freq | 8 | `logspace`, hand-checked response points, phase unwrapping (monotone, no jumps over 30°), auto range, two textbook margin cases, the double integrator (phase on −180°), the "never crosses" case |
| rlocus | 4 | Branch structure, continuity (largest adjacent step ≤ 0.6 against a swap signature of about 2.8), critical-gain cross-check, `null` for an always-stable locus |
| store | 3 | Dominant pole of the default design (hand ζ and ωn), a near-cancelled pole not chosen as dominant (checked against the hand-derived characteristic polynomial), rightmost pole for an unstable loop |

### 9.3 Highlights

- **Analytic second-order grid** (ζ ∈ {0.3, 0.5, 0.7} × ωn ∈ {1, 5}):
  - overshoot must match `100·exp(−πζ/√(1−ζ²))` within 0.5%
  - peak time must match `π/(ωn√(1−ζ²))` within 0.5%
  - settling time must match, within 1%, the exact last band exit, found by root-finding on the
    closed-form response

  The test comments note that the textbook rule `4/(ζωn)` is 16% high at ζ = 0.3 (13.33 s against
  an actual 11.23 s), so it is checked only at the ~25% accuracy it actually has. Using it as
  ground truth would encode a wrong answer.
- **First order, exactly:** `1/(s+1)` must give rise time `ln 9 = 2.1972 s` and settling time
  `ln 50 = 3.9120 s`.
- **Textbook margins:** `1/(s(s+1))` gives PM 51.827° at 0.78615 rad/s with no GM.
  `1/(s(s+1)(s+2))` gives GM exactly 6 (15.563 dB) at √2 rad/s and PM 53.411° at 0.44575 rad/s,
  and `|L|` at the reported crossover must equal 1 to 1e-6, which proves bisection rather than
  nearest grid point.
- **The strongest test, a cross-check:** for `1/(s(s+1)(s+2))`, `criticalGain` (s-plane
  bisection on `max Re(root)`) and `margins` (frequency-domain phase crossover) must agree with
  each other and with Routh (`k = 6`, `ω = √2`). A third check factors `s³ + 3s² + 2s + 6` as
  `(s+3)(s² + 2)`.
- **State-space validated independently:** `C(sI − A)⁻¹B + D` is computed by complex Gaussian
  elimination with partial pivoting, which makes no assumption about `A`'s shape, and compared
  with `num/den` at three complex points.
- **Step weights from partial fractions done by hand:**
  - `(s+1.1)/((s+1)(s+5))` must give weights 0.025 and 0.039, so the pole further from the axis
    outweighs the nearly cancelled one;
  - `2/(s²+2s+2)` must give √2/2 for each pole of the pair;
  - a repeated pole must give ∞.

### 9.4 Harness

`tests/harness.mjs` has no dependencies: `test`, `assert`, `assertEqual` (`Object.is`, so
`NaN ≠ NaN` and `−0 ≠ 0`), `assertNull`, `assertClose` (relative) and `assertNear` (absolute).
Each failure message carries the expected value, the actual value and the relative error.
`run.mjs` exits non-zero on any failure.

### 9.5 Browser integration suite: `tests/browser.html`

Serve the repo and open `/tests/browser.html`; the banner and the page title report the result
(124 checks). It also runs headless, which prints `<title>ALL PASS (124)</title>` on success:

```
chrome --headless=new --virtual-time-budget=15000 --dump-dom http://127.0.0.1:8000/tests/browser.html | grep "<title>"
```

The suite:

1. fetches the **real** `index.html`, parses it and injects its body into a hidden stage, which
   verifies that every element id `controls.js` looks up actually exists;
2. stubs `document.modelContext` to capture the tool descriptors;
3. checks:
   - all 8 tools register
   - every schema is an object schema with `additionalProperties: false`, a description over 80
     characters, a description over 20 characters on every property, and nothing marked required
   - `readOnlyHint` is exact per tool
   - write tools change the store **and repaint the Kp/Kd inputs and slider** (the
     demo-critical path)
   - partial gain updates leave the other gains alone
   - a PD design reads as stable, with step metrics and no pole at the origin
   - the dominant pole reported by `get_pole_zero_map` is the one that shapes the response
   - multi-term numerators are bracketed in the tool text
   - a missing steady state is explained correctly for each cause (right-half-plane poles,
     imaginary-axis poles, a pole at the origin)
   - a phase sitting on −180° reports the gain margin and the critical gain as undefined, with no
     grid-edge artefact
   - presets and custom plants work
   - invalid input returns `Error:` text instead of throwing
   - read tools leave the state byte-identical
   - optional samples appear only on request
   - `evaluate_design` gives signed margins, `set_design_spec` retargets the evaluation, and
     instability is reported
   - the activity log receives entries, and `unregister()` runs cleanly

### 9.6 Gaps

- There is no CI configuration. Both suites run locally, the browser suite headless or in a tab.
- Before the review, one test pinned a bug in place: it expected the unreduced PD form
  `[100, 0, 0]/[1, 100, 0]` for a pure derivative. It now expects `[100, 0]/[1, 100]`. A
  test is only as good as its expected value, which is why every expected value here must be
  derived independently.

---

## 10. Robustness and error handling

The rule throughout is: **degrade one field, never the page, and never hand anyone a `NaN`.**

| Failure | Where it is caught | What the user or agent sees |
| --- | --- | --- |
| Non-numeric or non-finite gain | `setGains` validation | `Error: Kp must be a finite number, got "loud".` |
| Out-of-range gain | `setGains` clamp | Value clamped; the input repaints on blur |
| Improper or zero-denominator custom plant | `setPlant` validation | Readable error: inline in the UI, as `Error:` text to an agent |
| Custom order above 10 | `validateCoefficients` | `Numerator order is limited to 10.` |
| Unknown preset | `setPlant` and the schema `enum` | Error listing the valid presets |
| Numeric routine throws | `attempt()` in `derive()` | That field becomes `null`/empty; everything else still renders |
| Whole derivation throws | `computeAnalysis()` | `emptyAnalysis()`: well formed, all `null` |
| Response overflows | `stepResponse` | Trace truncated at the last finite sample |
| Metric undefined (unstable, no steady state) | `stepMetrics` | `null` → em dash on screen, `undefined` plus a reason in tool text, never a spec PASS |
| Renderer throws | `paint()` per panel | "plot unavailable" in that panel only |
| A subscriber throws | `notify()` | Swallowed; the other subscribers still run |
| No WebMCP in the browser | Feature detection | Status line explains it; the page works normally |
| Tool registration throws | `main.js` `try/catch` | Status line shows the error; the page works normally |

---

## 11. Performance

**Work per `analyse()` call** (one state change):

- about **211 polynomial root solves**:
  - 201 for the root locus
  - 4 for closed- and open-loop poles and zeros
  - 2 for horizon selection (step response and metrics)
  - 4 for the auto frequency range (margins and Bode)
- **16,000 RK4 steps** (800 samples × 20)
- a **4,001-point** frequency scan plus up to 2 × 80 bisection evaluations for the margins
- a **400-point** Bode trace

**Measured:** about **7.5 ms** per full recompute for a 4th-order closed loop, averaged over 20
state changes in Node 22 on the development machine. Browser timings will vary by device.

**Why this is enough for live dragging:**
- the memoisation means three consumers cost one computation;
- the canvases read no layout (sizes come from the `ResizeObserver`);
- the scratch buffers are preallocated;
- the theme cache avoids a style recalculation per frame.

**Not optimised yet:** store-driven redraws run synchronously on every `input` event. Only
resizes are coalesced with `requestAnimationFrame`. On a slow device, fast slider drags could
queue more work than one frame's worth. Coalescing `drawAll` through `requestAnimationFrame` is a
contained change.

---

## 12. Running, deploying and using it with an agent

**Local**

```
python -m http.server 8000        # any static server works
# open http://127.0.0.1:8000
node tests/run.mjs                # numeric and store suite (Node 22+)
# open http://127.0.0.1:8000/tests/browser.html for the browser suite (or run it headless, 9.5)
```

- Opening the page via `file://` does **not** work: WebMCP is a secure-context API, so
  `document.modelContext` is `undefined` and no tools register.
- `localhost` and `127.0.0.1` count as secure contexts, so plain HTTP is fine locally.
- If a parent directory contains a `package.json` without a `"type"` field, Node 22 prints a
  harmless `MODULE_TYPELESS_PACKAGE_JSON` warning before the tests run (the saved
  `test_results.png` shows this, from a `package.json` in the home folder). From a checkout with
  no `package.json` above it, there is no warning. Adding one to the repo would break the
  project's no-`package.json` rule in `CONTRIBUTING.md`.

**Production:** any static host (Vercel, Netlify, Cloudflare Pages, GitHub Pages). **HTTPS is
required.** There is nothing to build.

**Using it with ChatGPT (verified 30 Aug 2026)**

- Use the **ChatGPT desktop app's built-in browser**. Web ChatGPT does not expose site tools.
- Use a model with site tools enabled (GPT-5.6 Sol or Terra worked; Luna has WebMCP disabled).
- Turn on Settings → Browser → Permissions → **Enable site tools**. Site tools are not available
  in Enterprise or Edu workspaces.
- Test in a **plain chat**. A Codex agentic thread prefers file editing and browser control and
  reports false negatives.
- The site-tools indicator in the address bar lights up during calls, and every call is echoed
  in the page's activity log.

---

## 13. Design decisions and trade-offs

| Decision | Chosen | Alternative | Why |
| --- | --- | --- | --- |
| Where the simulation runs | Pure client-side JS | Python backend (FastAPI + scipy/`control`) | One deployable artifact and one failure point, zero latency, no CORS or cold starts. SISO loops of low order are well within reach of careful JS numerics. |
| Dependencies | None | Chart.js, math.js, a test framework | Nothing to install or build, and nothing to break. Every line is readable and explainable. It forced the numerics to be understood rather than imported. |
| Root finding | Durand-Kerner, refined | Companion-matrix eigenvalues via QR (as `numpy.roots` does) | Finds all roots simultaneously with no linear-algebra library. Its known weaknesses (roots at the origin, multiple roots, real-axis trapping) are each handled explicitly (5.3). |
| Step response | RK4 on the controllable canonical form | Partial fractions or matrix exponential | Robust to repeated poles, where partial fractions become ill-conditioned; simple; accuracy controlled by oversampling. |
| Root locus | Direct factoring over a gain sweep | Classical construction rules | No special cases for RHP zeros or unstable plants; exact at every plotted gain. |
| Derivative term | Filtered, `Kd·N·s/(s+N)` | Ideal `Kd·s` | The ideal derivative is improper and cannot be simulated; the filter is also what a real controller does. |
| Settling time | Last exit from the band | First entry into the band | The first entry is wrong for lightly damped responses. |
| Dominant pole | Largest step weight `\|R\|/\|Re p\|` | Closest to the imaginary axis | The textbook rule assumes no nearby zero; integral action breaks that assumption routinely. |
| Tool results | Dense labelled text | JSON | Compact and unambiguous for an LLM; units travel with the numbers. |
| Write-tool results | Full post-change report | "OK" | Halves the round trips and keeps the agent anchored to measurements. |
| Undefined metrics | `null` with a reason | `NaN` or `0` | A silent `NaN` or `0` could pass a spec check or mislead the agent. |
| API surface | `document.modelContext` | `navigator.modelContext` | What current implementations and the challenge require. |
| State | One store, one render path | Separate human and agent state | The human and the agent can never disagree about what the design is. |

---

## 14. Issues found in review

A review on 29 Sep 2026 reproduced each issue below by running the code in Node, not by
reading it. Issues 14.1 to 14.5 are fixed, each in its own commit with tests; 14.6 onwards are
still open.

### 14.1 PD control was reported as unstable (high) — fixed

**Symptom:** any controller with `Ki = 0` and `Kd ≠ 0` got a spurious closed-loop pole at `s = 0`,
so the loop was reported **UNSTABLE** and every step metric was `null`, even when the real loop
was stable. On the default plant with `Kp = 2, Kd = 1`:
- reported poles: `0, −0.808 ± 1.542j, −98.98`, UNSTABLE
- correct poles: `−0.808 ± 1.542j, −98.98`, stable

**Cause:** `pidTF` reduced the P and PI cases but let PD fall through to the full form
`[Kp + Kd·N, Kp·N, 0] / [1, N, 0]`. Its common factor of `s` survived `closedLoop()` as an exact
root at the origin. The simulated trace was right, because that mode is unobservable, but the
stability verdict and the metrics were wrong. A test had pinned the unreduced form.

**Impact:** "add derivative action" is a natural first move for an agent, and the README's own
sample prompt ("Add derivative action until the overshoot halves", starting from `Ki = 0`) hit
it.

**Fix:** PD is returned as `((Kp + Kd·N)s + Kp·N)/(s + N)`. The pinned test is corrected, and a
regression test checks the hand-derived PD closed-loop polynomial `s³ + 100.6s² + 163s + 300`
and that its poles are all in the LHP.

### 14.2 Instability was blamed on a "free integrator" (medium) — fixed

The tools said "the loop contains a free integrator" whenever `finalValue` was `null`, but that
is the case for **every** closed loop that is not stable. The `unstable` preset under `Kp = 1`
(`T = 1/(s² − s + 3)`, poles `0.5 ± 1.658j`, no integrator anywhere) was misdiagnosed, pointing
the agent at the wrong fix. **Fix:** the reason is now read off the closed-loop poles: right-half-plane
poles (counted), a pole at the origin, or poles on the imaginary axis. Browser tests cover all
three.

### 14.3 Dominant pole ignored near pole-zero cancellation (medium) — fixed

The dominant pole was simply the stable pole closest to the imaginary axis. With
`Kp = 12, Ki = 4, Kd = 3` on the default plant, that was a real pole at −0.336 nearly cancelled
by a zero at −0.367, so the report said ζ = 1 while the response overshot 22.6%. The same failure
shows on the DC motor with a small integral gain (a lag dipole near the origin). **Fix:**
dominance is now the largest step weight `|R|/|Re p|`
([5.5](#55-simjs-step-response-and-time-domain-metrics), [6.6](#66-derived-judgements)). The
example now reports the pair at `−1.69 ± 3.07j` with ζ = 0.48. The tests use hand-computed
partial fractions and the hand-derived characteristic polynomial.

### 14.4 Double integrator under P control: meaningless gain margin (low) — fixed

For `1/s²` the open-loop phase is −180° at every frequency, and the scan took the first grid
point as a phase crossover: `GM 1.000e-8 (-160 dB) @ 1.000e-4 rad/s`. **Fix:** a crossing now
needs the phase to pass from one side of −180° to the other, and `margins()` reports
`phaseOnBoundary`. The tools say the gain margin and the critical gain are *undefined* (the
loop is marginal at any gain) instead of infinite, and the Bode badge shows `—` in ochre.

### 14.5 Multi-term numerators were not bracketed (low) — fixed

The tool text rendered `C(s) = 312s^2 + 1204s + 400 / (s^2 + 100s)`, which by precedence reads
as `312s² + 1204s + 400/(s² + 100s)`. **Fix:** a numerator with more than one term is now
bracketed: `(312s^2 + 1204s + 400) / (s^2 + 100s)`.

### 14.6 Margins are classical, first-crossing only (low, by design) — open

`margins()` reports only the **first** gain crossover and the **first** phase crossover, so
conditionally stable loops are summarised by their first crossings. Classical margins also do
not account for open-loop RHP poles; that needs the Nyquist encirclement count. The app's
stability verdict always comes from the closed-loop poles, which is authoritative, but the margin
numbers for the `unstable` preset should be read with that caveat. The critical-gain line in
`get_pole_zero_map` derives from the same GM, so it inherits the caveat.

### 14.7 Cosmetic tool-text details (low) — open

- A real part that is zero up to rounding prints in scientific notation. The double integrator's
  closed-loop poles come out as `-7.889e-31 +/- 1i`, and its "zeta" as `7.889e-31`, instead of
  0.
- `get_pole_zero_map` prints a complex dominant pole on its own (`-1.6876 + 3.0714i`), while the
  design report prints the pair (`-1.6876 +/- 3.0714i`).

### 14.8 Submission loose ends — open

- The README's **live demo** and **demo video** links are still `TBD`.
- `nirnay.mp4` (about 155 MB) is over GitHub's 100 MB per-file limit, so it is git-ignored. It
  belongs on YouTube, linked from the README.

---

## 15. Scope limits

These are deliberate boundaries, not bugs:

- SISO, linear, time-invariant, **continuous-time** only. No discretisation or sample-rate
  effects.
- Unity negative feedback with the controller in the forward path. No pre-filter,
  feed-forward or two-degree-of-freedom structure.
- Unit-step reference only. No ramp or parabola, no disturbance or noise inputs.
- No transport delay (`e^(−sT)` or Padé), no actuator saturation, so no integrator anti-windup.
- Custom plants limited to order 10. Gains clamped to ±1000, `N` to [1, 10000].
- Step window capped at 200 s for stable loops and 30 s for unstable ones. A loop slower than
  that reports settling time `null` ("still outside the band").
- Light theme only.

---

## 16. Repository facts

- **History:** 22 commits on 30 Aug 2026, then 7 on 29 Sep 2026 (the five fixes in section 14,
  ignoring the demo video, and this document). The first 22 build up in layers:
  1. licence
  2. complex/poly/roots
  3. TF and step response
  4. frequency response and root locus
  5. store
  6. page, plots and controls
  7. WebMCP tools
  8. tests
  9. README
  10. the rename from "Control Systems Design Bench" to Nirnay, and the theme

  Authors: Gaurav Tiwari (19 commits: the whole engine, UI, WebMCP layer, tests and README, the
  final rename and theme fixes, and the 29 Sep fixes) and Harshi Singh (10 commits: the rename
  to Nirnay across the files and the switch to the light colour scheme). No commit carries a
  co-author trailer.
- **Tracked files:** 25 (the 19 source files plus `.gitattributes`, `.gitignore`,
  `CONTRIBUTING.md`, `LICENSE`, `README.md` and this document).
- **Not in the repository:** `nirnay.mp4` (git-ignored) and `nirnay-devpost/` (screenshots, a
  slide deck and PDF, and a test-results screenshot; untracked).
- `.gitattributes` normalises line endings to LF in the repository. `.gitignore` excludes OS and
  editor files, the demo video and, defensively, `node_modules/`.
- **`CONTRIBUTING.md` rules:**
  - no dependencies, `package.json`, bundler or build step
  - `src/core/` stays DOM-free
  - 2-space indent, semicolons, double quotes
  - JSDoc on every export
  - `Number.isFinite` guards and `null` rather than `NaN`
  - no `console.log`
  - any change to `src/core/` needs a test pinned to an independently derived result

---

## 17. Glossary

| Term | Meaning |
| --- | --- |
| `G(s)`, `C(s)`, `L(s)`, `T(s)` | Plant, controller, open loop `C·G`, closed loop `L/(1+L)` |
| Overshoot | How far the peak exceeds the final value, as a percentage of the final value |
| Rise time | Time from 10% to 90% of the final value |
| Settling time (2%) | Time after which the response stays within ±2% of its final value |
| Steady-state error | `1 − y∞` for a unit step |
| Gain crossover `ωgc` | Frequency where `|L(jω)| = 1` |
| Phase margin (PM) | `180° + ∠L(jωgc)`: extra phase lag the loop tolerates before instability |
| Phase crossover `ωpc` | Frequency where `∠L(jω) = −180°` |
| Gain margin (GM) | `1/|L(jωpc)|`: extra gain the loop tolerates before instability |
| ζ, ωn | Damping ratio `−Re(p)/|p|` and natural frequency `|p|` of a pole `p` |
| Dominant pole | The pole closest to the imaginary axis, which usually sets the transient |
| RHP / LHP | Right / left half of the complex s-plane (unstable / stable pole locations) |
| Type-1 system | Open loop with one pole at the origin: zero steady-state error to a step |
| Non-minimum phase | Has a right-half-plane zero; the step response initially moves the wrong way |
| Root locus | Paths of the closed-loop poles as the loop gain `k` sweeps from 0 upwards |
| WebMCP | Browser API (`document.modelContext`) through which a page exposes typed tools to an AI agent |
| `readOnlyHint` | Tool annotation telling the host that a tool does not change state, so no confirmation prompt is needed |
