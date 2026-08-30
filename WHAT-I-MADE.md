# What I Made

A plain-language explanation of this project: what it does, why it needed to exist,
and how the pieces fit together.

---

## The one-sentence version

I built a web page where you tune a control system by dragging sliders and watching
graphs move — and an AI agent sitting in the same page can read the real numbers
behind those graphs and tune it alongside you.

---

## Part 1: What problem is this even about?

### What a control system is

Imagine cruise control in a car. You set the speed to 100 km/h. The car is currently
doing 80. Something has to decide how hard to press the accelerator.

That "something" is a **controller**. It looks at the gap between what you asked for
and what you're getting, and it pushes on the system to close the gap.

The thing being controlled — the engine, the car, its weight and drag — is called the
**plant**. You don't get to redesign the plant. You only get to design the controller.

### Why this is harder than it sounds

Press too gently and the car takes forever to reach 100. Press too hard and it shoots
past to 115, then falls back to 90, then overshoots again — wobbling around the target
instead of settling on it. Push harder still and the wobble grows instead of shrinking.
That's an unstable system, and in a real machine it's how things break.

So there's a trade-off, and engineers measure it with specific numbers:

| Number | Plain meaning |
| --- | --- |
| **Overshoot** | How far past the target it shoots, as a percentage. Aim for 100, hit 115 → 15% overshoot. |
| **Rise time** | How long to first get close to the target. Lower = snappier. |
| **Settling time** | How long until it stops wobbling and stays there. |
| **Steady-state error** | How far off it is once it's finally settled. Ideally zero. |
| **Phase margin** | How much safety margin before the system goes unstable. Bigger = safer. Below ~30° is nervous. |
| **Gain margin** | How much stronger you could crank the controller before it destabilises. |

Tuning a controller means turning three knobs — called **Kp**, **Ki** and **Kd** — until
all six of those numbers are acceptable at the same time. Turning one knob changes all
six numbers, usually improving some and ruining others. That's the whole game.

---

## Part 2: The thing that makes this a WebMCP project

Engineers tune controllers by looking at **graphs**. Three of them, traditionally:

- **Step response** — you ask for a sudden jump to the target, and this shows the wobble.
- **Bode plot** — shows how the system responds to fast versus slow inputs. Safety margins are read off this.
- **Root locus / pole-zero map** — shows mathematically where the system sits relative to going unstable.

### Here's the problem

Those graphs are drawn on an HTML `<canvas>`. A canvas is just **coloured pixels**. There
is no text, no numbers, no structure — nothing underneath for a program to read.

So if you connect an AI agent to a normal control-design page:

- It **cannot read the graph.** There's no DOM text to scrape. It's a picture.
- **Screenshots don't rescue it.** Show a vision model a step response and ask for the
  overshoot, and you get "roughly 25%". That's a guess from pixel positions. You cannot
  tune a controller on "roughly" — the whole point is hitting a number like "under 10%".
- **So it's stuck.** It can see that a wobble exists. It cannot tell you if the wobble is
  12% or 18%, and those two answers call for different fixes.

### What WebMCP changes

WebMCP lets a web page hand an agent **actual tools** instead of making it stare at the screen.

This page runs the whole simulation in JavaScript, in the browser. It already computes
every number exactly — it has to, in order to draw the graphs. WebMCP just exposes those
same numbers as tools the agent can call.

So instead of squinting at a picture, the agent asks `run_step_response` and gets back:

```
overshoot:          50.5629 %
rise time (10-90%): 0.8605 s
settling time (2%): 12.0655 s
steady-state error: 0.5 (unit step reference)
```

Exact values, from the same maths that drew the curve.

**That closes the loop.** The agent can now: change a gain → measure the real result →
compare against your target → decide the next change → repeat. That's exactly what a
control engineer does by hand, except it can run ten rounds in the time it takes to
explain the first one.

This is the honest answer to "what can the agent do here that it couldn't do by scraping
the DOM?" — the answer is **everything**, because there is no DOM to scrape. The
information only exists as numbers inside the running program, and WebMCP is what lets
those numbers out.

---

## Part 3: What you actually see on the page

**Left column — the controls.** Sliders and number boxes for the three gains (Kp, Ki, Kd)
plus a filter setting (N). A dropdown with seven ready-made plants to control, and boxes
to type in your own. Below that, four boxes where you set your **design targets** — the
maximum overshoot you'll accept, the maximum settling time, and so on.

**Middle — the three graphs.** They redraw instantly as anything changes.

**Right column — the scoreboard.** Every number listed, each with a green PASS or red FAIL
chip against your target. Underneath, an **agent activity log** that prints a line every
time the AI calls a tool — so a person watching the screen can see exactly what the agent
just did.

The important detail: **there is one shared brain behind all of it.** The sliders and the
AI tools both write to the same place. So when the agent changes a gain, the sliders
physically move, the graphs redraw, and the scoreboard updates — live, while you watch.
And you can grab a slider back mid-conversation; the agent's next reading reflects it.
Neither side is a second-class citizen.

---

## Part 4: The eight tools I gave the agent

Five that **read** (safe, no confirmation prompt) and three that **write**.

### Reading

| Tool | What it does, plainly |
| --- | --- |
| `get_system` | "Tell me everything about the current setup." The orientation call. |
| `run_step_response` | "Simulate a sudden jump to the target and give me the exact wobble numbers." |
| `get_frequency_response` | "How close to unstable am I? Give me the safety margins." |
| `get_pole_zero_map` | "Show me the mathematical fingerprint, and how much I could crank the gain before it blows up." |
| `evaluate_design` | "Am I done? Score me against the targets and tell me what's still failing, and by how much." |

### Writing

| Tool | What it does, plainly |
| --- | --- |
| `set_controller_gains` | "Set the knobs to these values." |
| `set_plant` | "Swap in a different system to control." |
| `set_design_spec` | "Here's the new goal to aim for." |

### The two design decisions I care most about

**1. Every write tool hands back the full result.**

`set_controller_gains` doesn't reply "done". It replies with the new overshoot, the new
settling time, the new margins, the new pole positions, and a pass/fail verdict — all in
the same response.

Why that matters: the obvious way to build this is write-then-read, two calls per attempt.
Returning the result *with* the write makes it one call. It halves the round trips, and
more importantly it keeps the agent anchored to a **measurement** instead of to its own
prediction of what those gains would do. Agents are quite good at confidently predicting
the wrong outcome.

**2. No tool ever returns a bare "OK".**

Every single response carries numbers the agent can check itself against. That's what lets
it notice when a change made things *worse* and back it out, instead of marching confidently
in the wrong direction.

There's a third, smaller one: when you give a tool bad input, it doesn't crash — it replies
with a readable sentence like `Error: Kp must be a finite number, got a string.` A crashed
tool call teaches the agent nothing. A sentence naming the mistake lets it fix itself and
retry.

---

## Part 5: How it works under the hood

Everything runs in your browser. **No server, no backend, no libraries, no build step.**
It's plain JavaScript files that the browser loads directly. You could host it on anything
that serves files.

The maths, roughly in order:

1. **Polynomials.** Control systems are described as fractions made of polynomials. So the
   base layer is just polynomial arithmetic — multiply, add, evaluate.

2. **Root finding.** To know if a system is stable you need the *roots* of those polynomials.
   I used the **Durand–Kerner** method, which chases all the roots at once. One subtlety:
   roots sitting exactly at zero make it stall, so those get peeled off first.

3. **Simulation.** To draw the wobble I convert the system into a set of differential
   equations and integrate them step by step with **RK4** (a standard, accurate recipe).
   It runs 20× finer than it records, so the recorded curve is smooth and trustworthy.

4. **Frequency response.** Safety margins come from evaluating the system along the
   imaginary axis. The two crossover points are found by **bisection** — repeatedly halving
   an interval — so they're exact, not "closest point on the grid".

5. **Root locus.** Sweeping the gain from tiny to huge and tracking where the roots travel.
   Each root gets matched to its nearest previous position so the drawn lines follow one
   root smoothly, instead of jumping between them where two roots pass close by.

### How I know the maths is right

This is the part I'm most confident about, because I didn't just trust the code.

The tests were written **before and independently of** the implementation, and they check
against answers known from theory, not from my code:

- **Textbook formulas.** For a standard second-order system there are exact closed-form
  answers for overshoot and peak time. The simulation has to match them to within 0.5%.
- **Textbook examples.** Classic systems whose safety margins can be worked out by hand.
- **The best one — a cross-check.** The gain at which the system goes unstable can be
  computed two completely different ways: from the root locus (tracking roots in one
  mathematical space) and from the frequency response (tracking phase in a totally
  different one). They share no code. If both say **exactly 6**, that's real evidence, not
  a tautology.

That cross-check earned its keep. It caught a genuine bug: the root-locus path said 6, the
frequency path said 6.0577. The root-locus one was right. The bug was a rare edge case — the
search grid happened to land *exactly* on the answer, which broke the assumption the
refinement step relied on. I'd never have found that by eyeballing a graph, and it's exactly
the kind of quiet wrongness that makes a tool untrustworthy.

**Results: 46/46 maths tests pass, 111/111 browser tests pass.** Both run clean from a fresh
clone of the repo.

There's a second test suite because Node.js can't test browser things. It loads the real page
markup, fakes the WebMCP connection, and checks the parts that only exist in a browser: that
all eight tools register, that every tool describes its inputs properly, that read tools are
correctly marked read-only, that bad input produces a readable error instead of a crash, and —
most importantly — that when a tool changes a gain, **the sliders on the page actually move.**
That last one is the entire human-and-agent story in one assertion.

---

## Part 6: Things worth knowing

- **The starting setup deliberately fails.** Open the page and it's at 50.6% overshoot
  against a 10% target — three of the four targets failing. That's on purpose. It gives the
  agent something real to fix, and it makes the demo show actual work rather than a victory lap.

- **`file://` will not work.** You have to serve the page over http. WebMCP is a
  secure-context feature, so opening the HTML file directly from your hard drive means
  `document.modelContext` is undefined and no tools exist. `localhost` counts as secure, so
  a plain local server is fine.

- **The page works perfectly without any AI.** Tool registration is behind a feature check.
  In a browser with no WebMCP support it just... doesn't register tools, and you have a
  normal, complete engineering tool. Nothing breaks and nothing looks broken.

- **Seven built-in plants,** including deliberately awkward ones: a system that's already
  unstable before you start, and a "non-minimum phase" system that initially moves the
  *wrong way* before correcting — the control equivalent of a trick question.

---

## Part 7: If I kept going

- Disturbance and noise simulation — how well does the design reject a shove, not just follow a command?
- Discrete-time / digital control, since real controllers run on a clock.
- Saturation limits, because real actuators have a maximum and pretending they don't is the
  most common way a good design fails in hardware.
- Letting the agent export a tuning session as a written design report.

---

## Running it

```
git clone https://github.com/Gauravtiwari31/webmcp_gh.git
cd webmcp_gh
python -m http.server 8000
```

Open <http://127.0.0.1:8000>.

Tests: `node tests/run.mjs`, and open <http://127.0.0.1:8000/tests/browser.html> in a browser.

To use it with an agent you need the ChatGPT desktop app's built-in browser, with
**Settings → Browser → Permissions → Enable site tools** turned on. Then try:

> "Tune this controller for under 10% overshoot and settling under 3 seconds."
