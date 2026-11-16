import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Optional evidence dump. When ADV_REPORT_DIR is set, each adversarial suite writes the
 * raw outcome of every probe it ran (what anon could reach, which RPC answered what) so
 * the surface documents under docs/programme/security-tenant/ can be regenerated from a
 * real run rather than maintained by hand. A no-op in CI unless the variable is set.
 */
export function writeReport(name: string, data: unknown): void {
  const dir = process.env.ADV_REPORT_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), JSON.stringify(data, null, 1));
}
