/**
 * Test entry point.
 *
 * Importing a test module registers its cases with the harness as a side effect,
 * so the import order below is also the run order.
 *
 * Usage: node tests/run.mjs
 */

import { run } from "./harness.mjs";
import "./core.test.mjs";

const failures = await run();
process.exit(failures > 0 ? 1 : 0);
