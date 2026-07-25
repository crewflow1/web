// Copy the pinned pdf.js worker into /public so it is served same-origin
// (satisfies the existing `worker-src 'self'` CSP) and always matches the
// installed pdfjs-dist version. Run by predev/prebuild.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs");
const destDir = join(root, "public");
const dest = join(destDir, "pdf.worker.min.mjs");
if (!existsSync(src)) {
  console.warn("[copy-pdf-worker] pdfjs-dist worker not found — skipping (pdfjs-dist not installed?)");
  process.exit(0);
}
mkdirSync(destDir, { recursive: true });
copyFileSync(src, dest);
console.log("[copy-pdf-worker] copied pdf.worker.min.mjs → public/");
