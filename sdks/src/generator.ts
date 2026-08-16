/**
 * OpenAPI → SDK code generator (pure, deterministic).
 *
 * The single source of truth for CrewFlow's official client SDKs. It reads the
 * SAME OpenAPI 3.1 document the public API serves (`buildOpenApiDocument()` in
 * `@/lib/public-api/openapi`) and emits a typed TypeScript client and a typed
 * Python client. Nothing here is hand-authored per-endpoint: every model,
 * operation and method is derived from the spec, so the checked-in clients can
 * NEVER silently drift from the API. The spec-consistency smoke test regenerates
 * in-memory and asserts byte-equality with what is committed.
 *
 * PURE: no env, no I/O, no clock, no randomness. `generateAll(doc)` returns the
 * complete file set as `{ path, contents }` records; the CLI (`sdks/generate.ts`)
 * is the only thing that touches the filesystem. Determinism is load-bearing —
 * object insertion order in the spec drives output order, and the generator adds
 * no sorting that could reorder against it.
 *
 * NO NEW API SURFACE: this is pure codegen off the existing spec. It introduces
 * no endpoint, field, scope or default the API does not already describe.
 */

/** One emitted file, path relative to the `sdks/` directory. */
export type GeneratedFile = { readonly path: string; readonly contents: string };

/** Banner stamped on every generated source file so nobody hand-edits them. */
const BANNER_LINES = [
  "CrewFlow API client — GENERATED, DO NOT EDIT.",
  "Regenerate with `npx tsx sdks/generate.ts` (source of truth:",
  "lib/public-api/openapi.ts). Edits are overwritten and the",
  "spec-consistency test (__tests__/openapi-sdk) will fail on drift.",
];

// ── minimal typed views over the OpenAPI document ────────────────────────────

type JsonObject = Record<string, unknown>;

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

interface ExtractedOperation {
  /** Deterministic id derived from method + path (spec carries none). */
  readonly operationId: string;
  /** PascalCase form of operationId, for type names. */
  readonly pascalId: string;
  readonly method: HttpMethod;
  /** Templated path, e.g. `/jobs/{id}`. */
  readonly path: string;
  readonly tag: string;
  readonly summary: string;
  /** Scopes the operation's apiKey security requires (may be empty). */
  readonly scopes: readonly string[];
  readonly pathParams: readonly string[];
  readonly queryParams: readonly QueryParam[];
  /** Component schema name of the request body, if any. */
  readonly bodyType: string | null;
  readonly successStatus: string;
  /** Type name of the parsed success body (a component or a synthesized *Response). */
  readonly resultType: string;
}

interface QueryParam {
  readonly name: string;
  readonly required: boolean;
  readonly tsType: string;
  readonly pyType: string;
  readonly description: string;
}

function asObject(value: unknown): JsonObject {
  return value && typeof value === "object" ? (value as JsonObject) : {};
}

function refName(ref: string): string {
  const parts = ref.split("/");
  return parts[parts.length - 1] ?? ref;
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Derive a stable operationId from method + path (the spec omits operationId).
 * `{id}` path params collapse to `ById`. Fully deterministic:
 *   GET /me            → getMe
 *   GET /jobs          → getJobs
 *   POST /jobs         → postJobs
 *   GET /jobs/{id}     → getJobsById
 *   PATCH /jobs/{id}   → patchJobsById
 */
function deriveOperationId(method: HttpMethod, path: string): string {
  const segments = path.split("/").filter((s) => s.length > 0);
  let id = method;
  for (const seg of segments) {
    if (seg.startsWith("{") && seg.endsWith("}")) {
      id += "By" + capitalize(seg.slice(1, -1));
    } else {
      id += capitalize(seg);
    }
  }
  return id;
}

function pascalCase(operationId: string): string {
  return capitalize(operationId);
}

function extractPathParams(path: string): string[] {
  const out: string[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

/** Scopes required by an operation's `security: [{ apiKey: [...] }]`, if any. */
function extractScopes(op: JsonObject): string[] {
  const security = op.security;
  if (!Array.isArray(security)) return [];
  const scopes = new Set<string>();
  for (const entry of security) {
    const apiKey = asObject(entry).apiKey;
    if (Array.isArray(apiKey)) {
      for (const s of apiKey) if (typeof s === "string") scopes.add(s);
    }
  }
  return [...scopes];
}

// ── schema → TypeScript type printer ─────────────────────────────────────────

function tsPrimitive(t: string): string {
  switch (t) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      return "unknown";
  }
}

function tsEnumUnion(values: readonly unknown[]): string {
  return values
    .map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v)))
    .join(" | ");
}

function needsQuote(key: string): boolean {
  return !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key);
}

function tsKey(key: string): string {
  return needsQuote(key) ? JSON.stringify(key) : key;
}

/** Print a TypeScript type for a JSON-schema-subset node. */
function printTsType(schema: JsonObject, indent: string): string {
  if (typeof schema.$ref === "string") return refName(schema.$ref);

  if (Array.isArray(schema.enum)) return tsEnumUnion(schema.enum);

  const type = schema.type;

  if (Array.isArray(type)) {
    // e.g. ["string", "null"] → string | null
    return type.map((t) => tsPrimitive(String(t))).join(" | ");
  }

  if (type === "object") {
    const props = asObject(schema.properties);
    if (Object.keys(props).length === 0) return "Record<string, unknown>";
    return printTsObjectBody(schema, indent);
  }

  if (type === "array") {
    const items = asObject(schema.items);
    const inner = printTsType(items, indent);
    // Wrap unions so `(A | B)[]` reads correctly.
    return /[| ]/.test(inner) && !inner.endsWith("]") ? `(${inner})[]` : `${inner}[]`;
  }

  if (typeof type === "string") return tsPrimitive(type);

  return "unknown";
}

function printTsObjectBody(schema: JsonObject, indent: string): string {
  const props = asObject(schema.properties);
  const required = new Set(
    Array.isArray(schema.required) ? (schema.required as string[]) : [],
  );
  const inner = indent + "  ";
  const lines: string[] = ["{"];
  for (const [key, raw] of Object.entries(props)) {
    const value = asObject(raw);
    const optional = required.has(key) ? "" : "?";
    lines.push(`${inner}${tsKey(key)}${optional}: ${printTsType(value, inner)};`);
  }
  lines.push(`${indent}}`);
  return lines.join("\n");
}

// ── schema → Python type printer ─────────────────────────────────────────────

function pyPrimitive(t: string): string {
  switch (t) {
    case "string":
      return "str";
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    default:
      return "Any";
  }
}

function pyEnumLiteral(values: readonly unknown[]): string {
  const inner = values
    .map((v) => (typeof v === "string" ? JSON.stringify(v) : String(v)))
    .join(", ");
  return `Literal[${inner}]`;
}

/** Print a Python type hint for a JSON-schema-subset node. */
function printPyType(schema: JsonObject): string {
  if (typeof schema.$ref === "string") return `"${refName(schema.$ref)}"`;

  if (Array.isArray(schema.enum)) return pyEnumLiteral(schema.enum);

  const type = schema.type;

  if (Array.isArray(type)) {
    const nonNull = type.filter((t) => t !== "null").map((t) => pyPrimitive(String(t)));
    const base = nonNull.length === 1 ? (nonNull[0] as string) : `Union[${nonNull.join(", ")}]`;
    return type.includes("null") ? `Optional[${base}]` : base;
  }

  if (type === "object") {
    const props = asObject(schema.properties);
    // Named object schemas become their own TypedDict elsewhere; nested inline
    // objects degrade to a permissive mapping to stay dependency-free.
    return Object.keys(props).length === 0 ? "Dict[str, Any]" : "Dict[str, Any]";
  }

  if (type === "array") {
    return `List[${printPyType(asObject(schema.items))}]`;
  }

  if (typeof type === "string") return pyPrimitive(type);

  return "Any";
}

// ── operation extraction ─────────────────────────────────────────────────────

function extractOperations(doc: JsonObject): ExtractedOperation[] {
  const paths = asObject(doc.paths);
  const operations: ExtractedOperation[] = [];

  for (const [path, rawItem] of Object.entries(paths)) {
    const item = asObject(rawItem);
    for (const method of HTTP_METHODS) {
      const rawOp = item[method];
      if (!rawOp || typeof rawOp !== "object") continue;
      const op = asObject(rawOp);

      const operationId = deriveOperationId(method, path);
      const pascalId = pascalCase(operationId);
      const pathParams = extractPathParams(path);

      const queryParams: QueryParam[] = [];
      if (Array.isArray(op.parameters)) {
        for (const rawParam of op.parameters) {
          const param = asObject(rawParam);
          if (param.in !== "query") continue;
          const pschema = asObject(param.schema);
          queryParams.push({
            name: String(param.name),
            required: param.required === true,
            tsType: printTsType(pschema, ""),
            pyType: printPyType(pschema),
            description: typeof param.description === "string" ? param.description : "",
          });
        }
      }

      // Request body: a $ref to a component schema (that is the only shape used).
      let bodyType: string | null = null;
      const requestBody = asObject(op.requestBody);
      const bodySchema = asObject(
        asObject(asObject(requestBody.content)["application/json"]).schema,
      );
      if (typeof bodySchema.$ref === "string") bodyType = refName(bodySchema.$ref);

      // Success response: pick the 2xx and resolve its JSON body schema.
      const responses = asObject(op.responses);
      const successStatus =
        Object.keys(responses).find((s) => s.startsWith("2")) ?? "200";
      const successSchema = asObject(
        asObject(
          asObject(asObject(responses[successStatus]).content)["application/json"],
        ).schema,
      );

      // If the body is a $ref → use the component name; otherwise synthesize a
      // `<Pascal>Response` type from the inline schema.
      const resultType =
        typeof successSchema.$ref === "string"
          ? refName(successSchema.$ref)
          : `${pascalId}Response`;

      operations.push({
        operationId,
        pascalId,
        method,
        path,
        tag: Array.isArray(op.tags) && typeof op.tags[0] === "string" ? op.tags[0] : "Default",
        summary: typeof op.summary === "string" ? op.summary : "",
        scopes: extractScopes(op),
        pathParams,
        queryParams,
        bodyType,
        successStatus,
        resultType,
      });
    }
  }

  return operations;
}

/** The inline (non-$ref) success schemas, keyed by their synthesized type name. */
function extractInlineResponseSchemas(doc: JsonObject): Map<string, JsonObject> {
  const out = new Map<string, JsonObject>();
  const paths = asObject(doc.paths);
  for (const [path, rawItem] of Object.entries(paths)) {
    const item = asObject(rawItem);
    for (const method of HTTP_METHODS) {
      const rawOp = item[method];
      if (!rawOp || typeof rawOp !== "object") continue;
      const op = asObject(rawOp);
      const responses = asObject(op.responses);
      const successStatus =
        Object.keys(responses).find((s) => s.startsWith("2")) ?? "200";
      const successSchema = asObject(
        asObject(
          asObject(asObject(responses[successStatus]).content)["application/json"],
        ).schema,
      );
      if (typeof successSchema.$ref === "string") continue;
      if (Object.keys(successSchema).length === 0) continue;
      const pascalId = pascalCase(deriveOperationId(method, path));
      out.set(`${pascalId}Response`, successSchema);
    }
  }
  return out;
}

// ── TypeScript client emission ───────────────────────────────────────────────

function tsBanner(): string {
  return ["/**", ...BANNER_LINES.map((l) => ` * ${l}`), " */"].join("\n");
}

function emitTsTypes(doc: JsonObject): string {
  const schemas = asObject(asObject(doc.components).schemas);
  const inline = extractInlineResponseSchemas(doc);

  const blocks: string[] = [tsBanner(), ""];
  blocks.push("// Component schemas (from components.schemas), in spec order.");
  for (const [name, raw] of Object.entries(schemas)) {
    const schema = asObject(raw);
    const description =
      typeof schema.description === "string" ? `/** ${schema.description} */\n` : "";
    blocks.push(`${description}export interface ${name} ${printTsObjectBody(schema, "")}`);
    blocks.push("");
  }

  blocks.push("// Synthesized response envelopes for operations with inline bodies.");
  for (const [name, schema] of inline) {
    blocks.push(`export type ${name} = ${printTsType(schema, "")};`);
    blocks.push("");
  }

  return blocks.join("\n").trimEnd() + "\n";
}

function emitTsOperations(doc: JsonObject): string {
  const operations = extractOperations(doc);
  const lines: string[] = [tsBanner(), ""];
  lines.push("/** An HTTP method used by the API. */");
  lines.push('export type HttpMethod = "get" | "post" | "put" | "patch" | "delete";');
  lines.push("");
  lines.push("/** One operation the API exposes: its method, templated path and scopes. */");
  lines.push("export interface OperationDescriptor {");
  lines.push("  readonly method: HttpMethod;");
  lines.push("  readonly path: string;");
  lines.push("  readonly scopes: readonly string[];");
  lines.push("}");
  lines.push("");
  lines.push(
    "/** Every operation, keyed by operationId — the typed path map the client drives. */",
  );
  lines.push("export const OPERATIONS = {");
  for (const op of operations) {
    const scopes = op.scopes.map((s) => JSON.stringify(s)).join(", ");
    lines.push(
      `  ${op.operationId}: { method: "${op.method}", path: ${JSON.stringify(op.path)}, scopes: [${scopes}] },`,
    );
  }
  lines.push("} as const satisfies Record<string, OperationDescriptor>;");
  lines.push("");
  lines.push("/** The set of operationIds this client implements. */");
  lines.push("export type OperationId = keyof typeof OPERATIONS;");
  return lines.join("\n") + "\n";
}

function emitTsClient(doc: JsonObject): string {
  const operations = extractOperations(doc);

  // Import only the types the client actually references (body + result types),
  // in first-use order, so the generated file has no unused imports.
  const usedTypes: string[] = [];
  const seen = new Set<string>();
  for (const op of operations) {
    for (const name of [op.bodyType, op.resultType]) {
      if (name && !seen.has(name)) {
        seen.add(name);
        usedTypes.push(name);
      }
    }
  }
  const modelNames = usedTypes;
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const defaultBase =
    asObject(servers[0]).url && typeof asObject(servers[0]).url === "string"
      ? String(asObject(servers[0]).url)
      : "https://app.crewflow.uk/api/v1";

  const lines: string[] = [tsBanner(), ""];
  lines.push(`import type {\n${modelNames.map((n) => `  ${n},`).join("\n")}\n} from "./types.js";`);
  lines.push('import { OPERATIONS } from "./operations.js";');
  lines.push("");
  lines.push("/** Default production base URL (from the spec's `servers`). */");
  lines.push(`export const DEFAULT_BASE_URL = ${JSON.stringify(defaultBase)};`);
  lines.push("");
  lines.push(...tsSupportBlock());
  lines.push("");
  lines.push("/**");
  lines.push(" * The CrewFlow public API client. One method per OpenAPI operation, each");
  lines.push(" * derived from the spec. Bearer-authenticated with your API key; every");
  lines.push(" * request is scoped server-side to the key's organisation.");
  lines.push(" */");
  lines.push("export class CrewFlowClient {");
  lines.push("  private readonly apiKey: string;");
  lines.push("  private readonly baseUrl: string;");
  lines.push("  private readonly fetchImpl: typeof fetch;");
  lines.push("");
  lines.push("  constructor(options: CrewFlowClientOptions) {");
  lines.push("    if (!options || typeof options.apiKey !== \"string\" || options.apiKey.length === 0) {");
  lines.push('      throw new Error("CrewFlowClient requires an apiKey.");');
  lines.push("    }");
  lines.push("    this.apiKey = options.apiKey;");
  lines.push("    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\\/$/, \"\");");
  lines.push("    const f = options.fetch ?? globalThis.fetch;");
  lines.push('    if (typeof f !== "function") {');
  lines.push('      throw new Error("No fetch implementation available; pass options.fetch.");');
  lines.push("    }");
  lines.push("    this.fetchImpl = f.bind(globalThis);");
  lines.push("  }");
  lines.push("");

  for (const op of operations) {
    lines.push(...tsMethod(op));
    lines.push("");
  }

  lines.push(...tsRequestMethod());
  lines.push("}");
  return lines.join("\n") + "\n";
}

function tsSupportBlock(): string[] {
  return [
    "/** Options for constructing a {@link CrewFlowClient}. */",
    "export interface CrewFlowClientOptions {",
    "  /** Your API key, e.g. `crewflow_sk_...`. Sent as `Authorization: Bearer`. */",
    "  apiKey: string;",
    "  /** Override the base URL (defaults to production). */",
    "  baseUrl?: string;",
    "  /** Inject a fetch implementation (defaults to the global `fetch`). */",
    "  fetch?: typeof fetch;",
    "}",
    "",
    "/** Per-call options. */",
    "export interface RequestOptions {",
    "  /** Abort signal for cancellation/timeout. */",
    "  signal?: AbortSignal;",
    "}",
    "",
    "/** Thrown on any non-2xx response; carries the status and parsed error body. */",
    "export class CrewFlowApiError extends Error {",
    "  readonly status: number;",
    "  readonly body: unknown;",
    "  constructor(status: number, body: unknown, message: string) {",
    "    super(message);",
    '    this.name = "CrewFlowApiError";',
    "    this.status = status;",
    "    this.body = body;",
    "  }",
    "}",
  ];
}

function tsMethodSignatureArgs(op: ExtractedOperation): string[] {
  const args: string[] = [];
  for (const p of op.pathParams) args.push(`${p}: string`);
  if (op.bodyType) args.push(`body: ${op.bodyType}`);
  if (op.queryParams.length > 0) {
    const qFields = op.queryParams
      .map((q) => `${tsKey(q.name)}${q.required ? "" : "?"}: ${q.tsType}`)
      .join("; ");
    const optional = op.queryParams.every((q) => !q.required) ? "?" : "";
    args.push(`query${optional}: { ${qFields} }`);
  }
  args.push("options?: RequestOptions");
  return args;
}

function tsMethod(op: ExtractedOperation): string[] {
  const args = tsMethodSignatureArgs(op).join(", ");
  const scopeNote =
    op.scopes.length > 0 ? `\n   * Requires scope: ${op.scopes.join(", ")}.` : "";
  const lines: string[] = [
    `  /**`,
    `   * ${op.method.toUpperCase()} ${op.path} — ${op.summary}${scopeNote}`,
    `   */`,
    `  ${op.operationId}(${args}): Promise<${op.resultType}> {`,
  ];

  // Build the path with param substitution.
  let pathExpr = JSON.stringify(op.path);
  for (const p of op.pathParams) {
    pathExpr = pathExpr.replace(`{${p}}`, `\${encodeURIComponent(${p})}`);
  }
  pathExpr = "`" + pathExpr.slice(1, -1) + "`";

  const queryArg = op.queryParams.length > 0 ? "query" : "undefined";
  const bodyArg = op.bodyType ? "body" : "undefined";
  lines.push(
    `    return this.request<${op.resultType}>(OPERATIONS.${op.operationId}.method, ${pathExpr}, ${queryArg}, ${bodyArg}, options);`,
  );
  lines.push("  }");
  return lines;
}

function tsRequestMethod(): string[] {
  return [
    "  /** Execute one request, applying auth, query, body and error mapping. */",
    "  private async request<T>(",
    "    method: string,",
    "    path: string,",
    "    query: Record<string, unknown> | undefined,",
    "    body: unknown,",
    "    options: RequestOptions | undefined,",
    "  ): Promise<T> {",
    "    const url = new URL(this.baseUrl + path);",
    "    if (query) {",
    "      for (const [key, value] of Object.entries(query)) {",
    "        if (value !== undefined && value !== null) url.searchParams.set(key, String(value));",
    "      }",
    "    }",
    "    const headers: Record<string, string> = {",
    "      authorization: `Bearer ${this.apiKey}`,",
    '      accept: "application/json",',
    "    };",
    "    if (body !== undefined) headers[\"content-type\"] = \"application/json\";",
    "    const response = await this.fetchImpl(url.toString(), {",
    "      method: method.toUpperCase(),",
    "      headers,",
    "      body: body === undefined ? undefined : JSON.stringify(body),",
    "      signal: options?.signal,",
    "    });",
    "    const text = await response.text();",
    "    let parsed: unknown = undefined;",
    "    if (text.length > 0) {",
    "      try {",
    "        parsed = JSON.parse(text);",
    "      } catch {",
    "        parsed = text;",
    "      }",
    "    }",
    "    if (!response.ok) {",
    "      throw new CrewFlowApiError(",
    "        response.status,",
    "        parsed,",
    "        `CrewFlow API ${method.toUpperCase()} ${path} failed with ${response.status}`,",
    "      );",
    "    }",
    "    return parsed as T;",
    "  }",
  ];
}

function emitTsIndex(): string {
  return [
    tsBanner(),
    "",
    'export * from "./types.js";',
    'export * from "./operations.js";',
    'export * from "./client.js";',
    "",
  ].join("\n");
}

function emitTsPackageJson(doc: JsonObject): string {
  const info = asObject(doc.info);
  const version = typeof info.version === "string" ? info.version : "1.0.0";
  const pkg = {
    name: "@crewflow/api-client",
    version,
    private: true,
    description: "Official TypeScript client for the CrewFlow public API (generated from OpenAPI).",
    type: "module",
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
    },
    files: ["dist", "src", "README.md"],
    scripts: {
      build: "tsc -p tsconfig.json",
    },
    license: "UNLICENSED",
    sideEffects: false,
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function emitTsTsconfig(): string {
  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2022", "DOM"],
      declaration: true,
      outDir: "dist",
      rootDir: "src",
      strict: true,
      noUncheckedIndexedAccess: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    },
    include: ["src/**/*.ts"],
  };
  return JSON.stringify(tsconfig, null, 2) + "\n";
}

function emitTsReadme(doc: JsonObject): string {
  const operations = extractOperations(doc);
  const info = asObject(doc.info);
  const title = typeof info.title === "string" ? info.title : "CrewFlow Public API";
  const rows = operations
    .map(
      (op) =>
        `| \`${op.operationId}\` | \`${op.method.toUpperCase()} ${op.path}\` | ${
          op.scopes.length > 0 ? op.scopes.map((s) => `\`${s}\``).join(", ") : "—"
        } |`,
    )
    .join("\n");
  return `# @crewflow/api-client

Official **TypeScript** client for the ${title} (v1).

> Generated from the OpenAPI spec (\`lib/public-api/openapi.ts\`) by
> \`npx tsx sdks/generate.ts\`. Do not edit the generated sources by hand — run
> the generator and commit the result. A spec-consistency test fails on drift.

## Install & build

This package ships source; build the JS + types with:

\`\`\`bash
cd sdks/typescript
npm install   # no runtime dependencies; dev-only TypeScript
npm run build
\`\`\`

## Usage

\`\`\`ts
import { CrewFlowClient } from "@crewflow/api-client";

const client = new CrewFlowClient({ apiKey: process.env.CREWFLOW_API_KEY! });

const jobs = await client.getJobs({ page: 1, per_page: 25 });
for (const job of jobs.data ?? []) {
  console.log(job.id, job.status);
}

const created = await client.postCustomers({ name: "Acme Ltd" });
console.log(created.data?.id);
\`\`\`

Every method is Bearer-authenticated with your key and scoped server-side to the
key's organisation. Non-2xx responses throw \`CrewFlowApiError\` (carrying
\`.status\` and the parsed \`.body\`).

## Operations

| Method | HTTP | Scopes |
| --- | --- | --- |
${rows}
`;
}

// ── Python client emission ───────────────────────────────────────────────────

function pyBanner(): string {
  return ['"""', ...BANNER_LINES, '"""'].join("\n");
}

function emitPyModels(doc: JsonObject): string {
  const schemas = asObject(asObject(doc.components).schemas);
  const inline = extractInlineResponseSchemas(doc);

  const lines: string[] = [pyBanner(), ""];
  lines.push("from __future__ import annotations");
  lines.push("");
  lines.push("from typing import Any, Dict, List, Literal, Optional, TypedDict, Union");
  lines.push("");
  lines.push("__all__ = [");
  for (const name of [...Object.keys(schemas), ...inline.keys()]) {
    lines.push(`    ${JSON.stringify(name)},`);
  }
  lines.push("]");

  const emitTypedDict = (name: string, schema: JsonObject): void => {
    const props = asObject(schema.properties);
    lines.push("");
    lines.push("");
    lines.push(`class ${name}(TypedDict, total=False):`);
    const description = typeof schema.description === "string" ? schema.description : "";
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    const docParts: string[] = [];
    if (description) docParts.push(description);
    if (required.length > 0) docParts.push(`Required keys: ${required.join(", ")}.`);
    if (docParts.length > 0) lines.push(`    """${docParts.join(" ")}"""`);
    if (Object.keys(props).length === 0) {
      lines.push("    pass");
      return;
    }
    for (const [key, raw] of Object.entries(props)) {
      lines.push(`    ${pySafeKey(key)}: ${printPyType(asObject(raw))}`);
    }
  };

  for (const [name, raw] of Object.entries(schemas)) emitTypedDict(name, asObject(raw));
  for (const [name, schema] of inline) emitTypedDict(name, schema);

  return lines.join("\n") + "\n";
}

function pySafeKey(key: string): string {
  // All spec keys are valid Python identifiers; guard defensively anyway.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? key : `# invalid key: ${key}`;
}

function emitPyOperations(doc: JsonObject): string {
  const operations = extractOperations(doc);
  const lines: string[] = [pyBanner(), ""];
  lines.push("from __future__ import annotations");
  lines.push("");
  lines.push("from typing import Dict, List, TypedDict");
  lines.push("");
  lines.push("");
  lines.push("class OperationDescriptor(TypedDict):");
  lines.push('    """One operation the API exposes: HTTP method, templated path, scopes."""');
  lines.push("");
  lines.push("    method: str");
  lines.push("    path: str");
  lines.push("    scopes: List[str]");
  lines.push("");
  lines.push("");
  lines.push("#: Every operation, keyed by operationId (mirrors the OpenAPI paths).");
  lines.push("OPERATIONS: Dict[str, OperationDescriptor] = {");
  for (const op of operations) {
    const scopes = op.scopes.map((s) => JSON.stringify(s)).join(", ");
    lines.push(
      `    ${JSON.stringify(op.operationId)}: {"method": ${JSON.stringify(op.method)}, "path": ${JSON.stringify(op.path)}, "scopes": [${scopes}]},`,
    );
  }
  lines.push("}");
  return lines.join("\n") + "\n";
}

function emitPyClient(doc: JsonObject): string {
  const operations = extractOperations(doc);

  // Import only the models the client references (body + result types).
  const modelNames: string[] = [];
  const seen = new Set<string>();
  for (const op of operations) {
    for (const name of [op.bodyType, op.resultType]) {
      if (name && !seen.has(name)) {
        seen.add(name);
        modelNames.push(name);
      }
    }
  }

  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const defaultBase =
    typeof asObject(servers[0]).url === "string"
      ? String(asObject(servers[0]).url)
      : "https://app.crewflow.uk/api/v1";

  const lines: string[] = [pyBanner(), ""];
  lines.push("from __future__ import annotations");
  lines.push("");
  lines.push("import json");
  lines.push("import urllib.error");
  lines.push("import urllib.parse");
  lines.push("import urllib.request");
  lines.push("from typing import Any, Optional");
  lines.push("");
  lines.push(`from .models import (\n${modelNames.map((n) => `    ${n},`).join("\n")}\n)`);
  lines.push("from .operations import OPERATIONS");
  lines.push("");
  lines.push(`DEFAULT_BASE_URL = ${JSON.stringify(defaultBase)}`);
  lines.push("");
  lines.push("");
  lines.push("class CrewFlowApiError(Exception):");
  lines.push('    """Raised on any non-2xx response; carries the status and parsed body."""');
  lines.push("");
  lines.push("    def __init__(self, status: int, body: Any, message: str) -> None:");
  lines.push("        super().__init__(message)");
  lines.push("        self.status = status");
  lines.push("        self.body = body");
  lines.push("");
  lines.push("");
  lines.push("class CrewFlowClient:");
  lines.push('    """Official Python client for the CrewFlow public API.');
  lines.push("");
  lines.push("    One method per OpenAPI operation, generated from the spec. Bearer-");
  lines.push("    authenticated with your API key; every request is scoped server-side to");
  lines.push("    the key's organisation. Uses only the Python standard library.");
  lines.push('    """');
  lines.push("");
  lines.push("    def __init__(self, api_key: str, base_url: str = DEFAULT_BASE_URL) -> None:");
  lines.push("        if not api_key:");
  lines.push('            raise ValueError("CrewFlowClient requires an api_key.")');
  lines.push("        self.api_key = api_key");
  lines.push('        self.base_url = base_url.rstrip("/")');
  lines.push("");

  for (const op of operations) {
    lines.push(...pyMethod(op));
    lines.push("");
  }

  lines.push(...pyRequestMethod());
  return lines.join("\n") + "\n";
}

function pyMethod(op: ExtractedOperation): string[] {
  const params: string[] = ["self"];
  for (const p of op.pathParams) params.push(`${p}: str`);
  if (op.bodyType) params.push(`body: ${op.bodyType}`);
  for (const q of op.queryParams) {
    const base = q.pyType;
    params.push(`${pySafeKey(q.name)}: Optional[${base}] = None`);
  }

  // Build the path expression with param substitution.
  let pathExpr: string;
  if (op.pathParams.length > 0) {
    let templ = op.path;
    for (const p of op.pathParams) {
      templ = templ.replace(`{${p}}`, `{urllib.parse.quote(str(${p}))}`);
    }
    pathExpr = `f${JSON.stringify(templ)}`;
  } else {
    pathExpr = JSON.stringify(op.path);
  }

  const queryEntries = op.queryParams
    .map((q) => `${JSON.stringify(q.name)}: ${pySafeKey(q.name)}`)
    .join(", ");
  const queryArg = op.queryParams.length > 0 ? `{${queryEntries}}` : "None";
  const bodyArg = op.bodyType ? "body" : "None";

  const scopeNote = op.scopes.length > 0 ? ` Requires scope: ${op.scopes.join(", ")}.` : "";

  return [
    `    def ${op.operationId}(${params.join(", ")}) -> ${op.resultType}:`,
    `        """${op.method.toUpperCase()} ${op.path} — ${op.summary}${scopeNote}"""`,
    `        return self._request(OPERATIONS[${JSON.stringify(op.operationId)}]["method"], ${pathExpr}, ${queryArg}, ${bodyArg})  # type: ignore[return-value]`,
  ];
}

function pyRequestMethod(): string[] {
  return [
    "    def _request(",
    "        self,",
    "        method: str,",
    "        path: str,",
    "        query: Optional[dict] = None,",
    "        body: Any = None,",
    "    ) -> Any:",
    '        """Execute one request, applying auth, query, body and error mapping."""',
    "        url = self.base_url + path",
    "        if query:",
    "            filtered = {k: v for k, v in query.items() if v is not None}",
    "            if filtered:",
    '                url = url + "?" + urllib.parse.urlencode(filtered)',
    "        headers = {",
    '            "Authorization": f"Bearer {self.api_key}",',
    '            "Accept": "application/json",',
    "        }",
    "        data: Optional[bytes] = None",
    "        if body is not None:",
    '            data = json.dumps(body).encode("utf-8")',
    '            headers["Content-Type"] = "application/json"',
    "        request = urllib.request.Request(",
    "            url, data=data, headers=headers, method=method.upper()",
    "        )",
    "        try:",
    "            with urllib.request.urlopen(request) as response:  # noqa: S310",
    '                text = response.read().decode("utf-8")',
    "                return json.loads(text) if text else None",
    "        except urllib.error.HTTPError as exc:",
    '            raw = exc.read().decode("utf-8") if exc.fp is not None else ""',
    "            try:",
    "                parsed = json.loads(raw) if raw else None",
    "            except json.JSONDecodeError:",
    "                parsed = raw",
    "            raise CrewFlowApiError(",
    "                exc.code,",
    "                parsed,",
    '                f"CrewFlow API {method.upper()} {path} failed with {exc.code}",',
    "            ) from exc",
  ];
}

function emitPyInit(doc: JsonObject): string {
  const info = asObject(doc.info);
  const version = typeof info.version === "string" ? info.version : "1.0.0";
  return [
    pyBanner(),
    "",
    "from .client import CrewFlowApiError, CrewFlowClient, DEFAULT_BASE_URL",
    "from .operations import OPERATIONS",
    "",
    `__version__ = ${JSON.stringify(version)}`,
    "",
    "__all__ = [",
    '    "CrewFlowClient",',
    '    "CrewFlowApiError",',
    '    "DEFAULT_BASE_URL",',
    '    "OPERATIONS",',
    '    "__version__",',
    "]",
    "",
  ].join("\n");
}

function emitPyProjectToml(doc: JsonObject): string {
  const info = asObject(doc.info);
  const version = typeof info.version === "string" ? info.version : "1.0.0";
  return `[build-system]
requires = ["setuptools>=61.0"]
build-backend = "setuptools.build_meta"

[project]
name = "crewflow-api"
version = "${version}"
description = "Official Python client for the CrewFlow public API (generated from OpenAPI)."
readme = "README.md"
requires-python = ">=3.9"
license = { text = "UNLICENSED" }
dependencies = []

[tool.setuptools.packages.find]
include = ["crewflow_api*"]
`;
}

function emitPyReadme(doc: JsonObject): string {
  const operations = extractOperations(doc);
  const info = asObject(doc.info);
  const title = typeof info.title === "string" ? info.title : "CrewFlow Public API";
  const rows = operations
    .map(
      (op) =>
        `| \`${op.operationId}\` | \`${op.method.toUpperCase()} ${op.path}\` | ${
          op.scopes.length > 0 ? op.scopes.map((s) => `\`${s}\``).join(", ") : "—"
        } |`,
    )
    .join("\n");
  return `# crewflow-api (Python)

Official **Python** client for the ${title} (v1). Standard library only — no
runtime dependencies.

> Generated from the OpenAPI spec (\`lib/public-api/openapi.ts\`) by
> \`npx tsx sdks/generate.ts\`. Do not edit the generated sources by hand — run
> the generator and commit the result. A spec-consistency test fails on drift.

## Install

\`\`\`bash
cd sdks/python
pip install -e .
\`\`\`

## Usage

\`\`\`python
import os
from crewflow_api import CrewFlowClient

client = CrewFlowClient(api_key=os.environ["CREWFLOW_API_KEY"])

jobs = client.getJobs(page=1, per_page=25)
for job in jobs["data"]:
    print(job["id"], job["status"])
\`\`\`

Every method is Bearer-authenticated with your key and scoped server-side to the
key's organisation. Non-2xx responses raise \`CrewFlowApiError\` (carrying
\`.status\` and the parsed \`.body\`).

## Operations

| Method | HTTP | Scopes |
| --- | --- | --- |
${rows}
`;
}

// ── the full file set ────────────────────────────────────────────────────────

/**
 * Generate the complete SDK file set from the OpenAPI document. Deterministic
 * and pure — same document in, byte-identical files out. Paths are relative to
 * the `sdks/` directory.
 */
export function generateAll(doc: JsonObject): GeneratedFile[] {
  return [
    // TypeScript client.
    { path: "typescript/package.json", contents: emitTsPackageJson(doc) },
    { path: "typescript/tsconfig.json", contents: emitTsTsconfig() },
    { path: "typescript/README.md", contents: emitTsReadme(doc) },
    { path: "typescript/src/types.ts", contents: emitTsTypes(doc) },
    { path: "typescript/src/operations.ts", contents: emitTsOperations(doc) },
    { path: "typescript/src/client.ts", contents: emitTsClient(doc) },
    { path: "typescript/src/index.ts", contents: emitTsIndex() },
    // Python client.
    { path: "python/pyproject.toml", contents: emitPyProjectToml(doc) },
    { path: "python/README.md", contents: emitPyReadme(doc) },
    { path: "python/crewflow_api/__init__.py", contents: emitPyInit(doc) },
    { path: "python/crewflow_api/models.py", contents: emitPyModels(doc) },
    { path: "python/crewflow_api/operations.py", contents: emitPyOperations(doc) },
    { path: "python/crewflow_api/client.py", contents: emitPyClient(doc) },
  ];
}

/** The list of operationIds the spec describes (for the consistency test). */
export function specOperationKeys(doc: JsonObject): string[] {
  return extractOperations(doc).map((op) => op.operationId);
}

export type { ExtractedOperation };
export { extractOperations };
