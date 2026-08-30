/**
 * Minimal zero-dependency test harness.
 *
 * Tests register themselves at module load time; `run()` executes them in
 * registration order, prints one PASS/FAIL line each, and sets a non-zero
 * process exit code if anything failed.
 *
 * Assertion failures throw. Every message is built to be read by someone
 * debugging numerics at 2am, so it always carries expected, actual and the
 * relative error.
 */

/** @type {{name: string, fn: () => (void|Promise<void>)}[]} */
const tests = [];

/**
 * Format any value compactly for an assertion message.
 * @param {unknown} v
 * @returns {string}
 */
function fmt(v) {
  if (v === null) return "null";
  if (typeof v === "number") return Object.is(v, -0) ? "-0" : String(v);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Register a test case.
 * @param {string} name human-readable test name
 * @param {() => (void|Promise<void>)} fn body; throws to fail
 * @returns {void}
 */
export function test(name, fn) {
  tests.push({ name, fn });
}

/**
 * Fail unless `cond` is truthy.
 * @param {unknown} cond
 * @param {string} msg
 * @returns {void}
 */
export function assert(cond, msg) {
  if (!cond) throw new Error(`${msg}\n    expected: truthy\n    actual:   ${fmt(cond)}`);
}

/**
 * Strict equality (`Object.is`, so NaN !== NaN and -0 !== 0).
 * @param {unknown} actual
 * @param {unknown} expected
 * @param {string} msg
 * @returns {void}
 */
export function assertEqual(actual, expected, msg) {
  if (!Object.is(actual, expected)) {
    throw new Error(`${msg}\n    expected: ${fmt(expected)}\n    actual:   ${fmt(actual)}`);
  }
}

/**
 * Assert a value is exactly `null` (not undefined, not NaN).
 * @param {unknown} actual
 * @param {string} msg
 * @returns {void}
 */
export function assertNull(actual, msg) {
  if (actual !== null) throw new Error(`${msg}\n    expected: null\n    actual:   ${fmt(actual)}`);
}

/**
 * Assert `actual` matches `expected` to a RELATIVE tolerance.
 * When `expected` is exactly 0 the tolerance is applied absolutely.
 * @param {number} actual
 * @param {number} expected
 * @param {number} relTol e.g. 1e-3 for 0.1%
 * @param {string} msg
 * @returns {void}
 */
export function assertClose(actual, expected, relTol, msg) {
  if (typeof actual !== "number" || !Number.isFinite(actual)) {
    throw new Error(`${msg}\n    expected: ${fmt(expected)} (+/- ${relTol} rel)\n    actual:   ${fmt(actual)}  <- not a finite number`);
  }
  const diff = Math.abs(actual - expected);
  const rel = Math.abs(expected) > 0 ? diff / Math.abs(expected) : diff;
  if (rel > relTol) {
    throw new Error(
      `${msg}\n    expected: ${expected}\n    actual:   ${actual}` +
      `\n    abs err:  ${diff.toExponential(4)}\n    rel err:  ${rel.toExponential(4)}  (tol ${relTol.toExponential(4)})`
    );
  }
}

/**
 * Assert `actual` matches `expected` to an ABSOLUTE tolerance. Use where the
 * expected value is zero or near zero and a relative test is meaningless.
 * @param {number} actual
 * @param {number} expected
 * @param {number} absTol
 * @param {string} msg
 * @returns {void}
 */
export function assertNear(actual, expected, absTol, msg) {
  if (typeof actual !== "number" || !Number.isFinite(actual)) {
    throw new Error(`${msg}\n    expected: ${fmt(expected)} (+/- ${absTol} abs)\n    actual:   ${fmt(actual)}  <- not a finite number`);
  }
  const diff = Math.abs(actual - expected);
  if (diff > absTol) {
    throw new Error(
      `${msg}\n    expected: ${expected}\n    actual:   ${actual}` +
      `\n    abs err:  ${diff.toExponential(4)}  (tol ${absTol.toExponential(4)})`
    );
  }
}

/**
 * Run every registered test. Prints per-test status and a summary.
 * @returns {Promise<number>} number of failures (also sets process.exitCode)
 */
export async function run() {
  let passed = 0;
  const failed = [];
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed += 1;
      process.stdout.write(`PASS  ${name}\n`);
    } catch (err) {
      failed.push(name);
      const body = String(err && err.message ? err.message : err).replace(/\n/g, "\n      ");
      process.stdout.write(`FAIL  ${name}\n      ${body}\n`);
    }
  }
  process.stdout.write(`\n${passed}/${tests.length} passed, ${failed.length} failed\n`);
  if (failed.length > 0) {
    process.stdout.write(`failing: ${failed.join(", ")}\n`);
    process.exitCode = 1;
  }
  return failed.length;
}
