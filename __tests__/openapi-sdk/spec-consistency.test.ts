import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildOpenApiDocument } from "@/lib/public-api/openapi";
import { generateAll, specOperationKeys } from "@/sdks/src/generator";

/**
 * SDK spec-consistency smoke test.
 *
 * The TypeScript and Python clients under `sdks/` are pure codegen off the SAME
 * OpenAPI document the API serves. This test is the gate that keeps them honest:
 *
 *   1. DRIFT — regenerate every file in-memory and assert byte-equality with
 *      what is checked in. If someone changes the spec (or a client) without
 *      regenerating, this fails, so the committed clients can never silently
 *      diverge from the API.
 *   2. TYPED PATHS — assert the operation maps both clients expose cover EXACTLY
 *      the operations (method + path) the OpenAPI `paths` describe — no missing
 *      endpoint, no invented one.
 *   3. MODELS — assert every component schema has a generated type in both
 *      clients.
 */

const SDK_DIR = join(process.cwd(), "sdks");

type JsonObject = Record<string, unknown>;

function doc(): JsonObject {
  return buildOpenApiDocument() as JsonObject;
}

/** The (METHOD path) set the spec's `paths` describe. */
function specMethodPaths(d: JsonObject): Set<string> {
  const out = new Set<string>();
  const paths = d.paths as Record<string, Record<string, unknown>>;
  const methods = ["get", "post", "put", "patch", "delete"];
  for (const [path, item] of Object.entries(paths)) {
    for (const method of methods) {
      if (item[method]) out.add(`${method.toUpperCase()} ${path}`);
    }
  }
  return out;
}

describe("SDK codegen is consistent with the OpenAPI spec", () => {
  it("checked-in clients match a fresh regeneration (no drift)", () => {
    const files = generateAll(doc());
    expect(files.length).toBeGreaterThan(0);
    const drifted: string[] = [];
    for (const file of files) {
      const onDisk = readFileSync(join(SDK_DIR, file.path), "utf8");
      if (onDisk !== file.contents) drifted.push(file.path);
    }
    expect(
      drifted,
      `SDK drift — run \`npx tsx sdks/generate.ts\` and commit:\n${drifted.join("\n")}`,
    ).toEqual([]);
  });

  it("emits both a TypeScript and a Python client package", () => {
    const paths = generateAll(doc()).map((f) => f.path);
    expect(paths).toContain("typescript/src/client.ts");
    expect(paths).toContain("typescript/src/types.ts");
    expect(paths).toContain("typescript/src/operations.ts");
    expect(paths).toContain("python/crewflow_api/client.py");
    expect(paths).toContain("python/crewflow_api/models.py");
    expect(paths).toContain("python/crewflow_api/operations.py");
  });

  it("TypeScript OPERATIONS cover exactly the spec's method+path set", () => {
    const d = doc();
    const src = readFileSync(join(SDK_DIR, "typescript/src/operations.ts"), "utf8");
    // Parse each `id: { method: "x", path: "y", ... }` line.
    const re = /^\s{2}(\w+): \{ method: "(\w+)", path: (".*?"),/gm;
    const found = new Set<string>();
    let m: RegExpExecArray | null;
    const ids: string[] = [];
    while ((m = re.exec(src)) !== null) {
      const method = m[2] as string;
      const path = JSON.parse(m[3] as string) as string;
      found.add(`${method.toUpperCase()} ${path}`);
      ids.push(m[1] as string);
    }
    expect(found).toEqual(specMethodPaths(d));
    // The operationId list must match the generator's own derivation exactly.
    expect(ids).toEqual(specOperationKeys(d));
  });

  it("Python OPERATIONS cover exactly the spec's method+path set", () => {
    const d = doc();
    const src = readFileSync(join(SDK_DIR, "python/crewflow_api/operations.py"), "utf8");
    const re = /^\s{4}"(\w+)": \{"method": "(\w+)", "path": (".*?"),/gm;
    const found = new Set<string>();
    const ids: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      const method = m[2] as string;
      const path = JSON.parse(m[3] as string) as string;
      found.add(`${method.toUpperCase()} ${path}`);
      ids.push(m[1] as string);
    }
    expect(found).toEqual(specMethodPaths(d));
    expect(ids).toEqual(specOperationKeys(d));
  });

  it("every component schema has a generated type in both clients", () => {
    const d = doc();
    const schemas = Object.keys(
      ((d.components as JsonObject).schemas as JsonObject) ?? {},
    );
    expect(schemas.length).toBeGreaterThan(0);

    const tsTypes = readFileSync(join(SDK_DIR, "typescript/src/types.ts"), "utf8");
    const pyModels = readFileSync(join(SDK_DIR, "python/crewflow_api/models.py"), "utf8");

    for (const name of schemas) {
      expect(tsTypes, `TS missing ${name}`).toContain(`export interface ${name} `);
      expect(pyModels, `Python missing ${name}`).toContain(`class ${name}(TypedDict`);
    }
  });

  it("the generated code is stamped DO-NOT-EDIT and carries no secrets", () => {
    const files = generateAll(doc());
    for (const file of files) {
      if (file.path.endsWith(".md") || file.path.endsWith(".json") || file.path.endsWith(".toml")) {
        continue;
      }
      expect(file.contents, `${file.path} banner`).toContain("GENERATED, DO NOT EDIT");
    }
    // No accidental key material anywhere in the emitted output.
    const all = files.map((f) => f.contents).join("\n");
    expect(all).not.toMatch(/crewflow_sk_[A-Za-z0-9]{8,}/);
    expect(all).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY\s*=/);
  });
});
