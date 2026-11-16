#!/usr/bin/env node
/**
 * scripts/load/teardown.mjs — remove one synthetic load-test dataset.
 *
 *   node scripts/load/teardown.mjs --tag lt1 [--db URL]
 *
 * Thin, discoverable entry point for `seed.mjs --teardown`: deletes ONLY rows
 * belonging to organisations whose slug is `lt-<tag>-%` and users whose email is
 * `lt-<tag>-%@loadtest.crewflow.invalid` (plus their Storage objects through
 * the Storage API, and orphans that only those deletions created). Same target
 * guard as the seeder: production is refused; staging needs LOAD_STAGING_REF +
 * the database sentinel. Exits 2 if any tagged residue remains.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [resolve(here, "seed.mjs"), "--teardown", ...process.argv.slice(2)], { stdio: "inherit" });
process.exit(r.status ?? 1);
