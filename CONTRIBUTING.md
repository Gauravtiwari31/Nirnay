# Contributing

Bug reports, plant models and numerical corrections are all welcome. Control-systems maths is
easy to get subtly wrong, so a report that includes the transfer function and the number you
expected is worth a lot.

## Running it

```
python -m http.server 8000
```

Then open <http://127.0.0.1:8000>. Any static file server works. `file://` does not — WebMCP is a
secure-context API, so `document.modelContext` is `undefined` and no tools register.

## No dependencies

This is the one rule that is not negotiable. No npm, no build step, no bundler, no third-party
libraries, not even for tests. Every file is a native ES module the browser loads directly, and
the whole project deploys by copying the directory to a static host. A pull request that adds a
`package.json` or a build pipeline will not be merged.

Everything under `src/core/` must stay free of DOM access, because `tests/run.mjs` imports those
modules straight into Node 22.

## Code style

- 2-space indent, semicolons, double quotes.
- A JSDoc block with `@param` and `@returns` on every export.
- Polynomials are `number[]` in descending powers; complex numbers are `{ re, im }`; angles are
  degrees and frequencies are rad/s at API boundaries, radians internally.
- Guard with `Number.isFinite`. Never return a silent `NaN` — return `null` and say why.
- No `console.log` in shipped code.

## Before opening a pull request

```
node tests/run.mjs
```

It must pass. If you change anything in `src/core/`, add a case that pins the new behaviour to a
result derived independently of the implementation — an analytic formula, a textbook worked
example, or a cross-check against another code path in the project.
