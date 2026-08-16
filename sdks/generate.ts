/**
 * SDK codegen CLI. Reads the live OpenAPI document and writes the generated
 * TypeScript + Python clients to disk under `sdks/`.
 *
 *   npx tsx sdks/generate.ts          # write the clients
 *   npx tsx sdks/generate.ts --check  # exit non-zero if anything would change
 *
 * The `--check` mode is the drift guard used in CI/dev; the vitest
 * spec-consistency test enforces the same invariant inside the test pipeline.
 * This file is the ONLY part of the SDK toolchain that touches the filesystem;
 * the generator itself (`./src/generator`) is pure.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildOpenApiDocument } from "@/lib/public-api/openapi";
import { generateAll, type GeneratedFile } from "./src/generator";

const SDK_DIR = dirname(fileURLToPath(import.meta.url));

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const doc = buildOpenApiDocument() as Record<string, unknown>;
  const files: GeneratedFile[] = generateAll(doc);

  if (check) {
    const drifted: string[] = [];
    for (const file of files) {
      const abs = join(SDK_DIR, file.path);
      const current = await readIfExists(abs);
      if (current !== file.contents) drifted.push(file.path);
    }
    if (drifted.length > 0) {
      console.error("SDK codegen drift detected in:\n" + drifted.map((p) => `  - ${p}`).join("\n"));
      console.error("Run `npx tsx sdks/generate.ts` and commit the result.");
      process.exit(1);
    }
    console.log(`SDK codegen up to date (${files.length} files).`);
    return;
  }

  for (const file of files) {
    const abs = join(SDK_DIR, file.path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.contents, "utf8");
  }
  console.log(`Generated ${files.length} SDK files under sdks/.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
