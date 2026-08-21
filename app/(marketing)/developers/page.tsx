import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { isPublicApiJobsEnabled } from "@/lib/public-api/flag";
import { buildOpenApiDocument } from "@/lib/public-api/openapi";

/**
 * /developers, the rendered developer docs portal for the public API (v1).
 *
 * Renders the SAME openapi document served at /api/v1/openapi.json into human
 * docs (auth, scopes, rate limits, endpoints, request bodies, examples). It is
 * built from buildOpenApiDocument() so the page can never drift from the spec.
 *
 * DARK BY DEFAULT behind the SAME FEATURE_PUBLIC_API_JOBS flag as every other
 * v1 surface: while off, this page 404s, no point documenting endpoints that
 * 404, and it would out the surface. force-dynamic so the env flag is read per
 * request, not baked at build.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "CrewFlow API, Developer docs",
  description:
    "Reference for the CrewFlow public API: authentication, scopes, rate limits, and every read and write endpoint.",
};

// --- the slice of the OpenAPI document this page reads ----------------------

type SchemaNode = {
  type?: string | string[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode & { $ref?: string };
  enum?: unknown[];
  $ref?: string;
  description?: string;
  format?: string;
  maxLength?: number;
};

type Operation = {
  tags?: string[];
  summary?: string;
  security?: Array<Record<string, string[]>>;
  requestBody?: {
    content: { "application/json": { schema: { $ref?: string } } };
  };
  responses?: Record<string, { description?: string }>;
};

type OpenApiDoc = {
  info: { title: string; version: string; description: string };
  servers: Array<{ url: string; description?: string }>;
  "x-scopes": Record<string, string>;
  "x-api-versioning": { strategy: string; breaking_change_policy: string };
  components: {
    securitySchemes: { apiKey: { bearerFormat: string; description: string } };
    schemas: Record<string, SchemaNode>;
  };
  paths: Record<string, Record<string, Operation>>;
};

const METHOD_ORDER = ["get", "post", "patch", "put", "delete"] as const;

const METHOD_STYLES: Record<string, string> = {
  get: "bg-sky-100 text-sky-800",
  post: "bg-green-100 text-green-800",
  patch: "bg-amber-100 text-amber-800",
  put: "bg-amber-100 text-amber-800",
  delete: "bg-red-100 text-red-800",
};

function refName(ref: string | undefined): string | null {
  if (!ref) return null;
  const m = /#\/components\/schemas\/(.+)$/.exec(ref);
  return m ? m[1]! : null;
}

function typeLabel(node: SchemaNode): string {
  if (node.$ref) return refName(node.$ref) ?? "object";
  if (node.enum) return node.enum.map((v) => JSON.stringify(v)).join(" | ");
  if (Array.isArray(node.type)) {
    return node.type.filter((t) => t !== "null").join(" | ") || "string";
  }
  if (node.type === "array" && node.items) {
    const itemName = node.items.$ref
      ? refName(node.items.$ref)
      : node.items.type;
    return `${itemName ?? "object"}[]`;
  }
  return node.type ?? "string";
}

/** A small property table for a request-body schema. */
function FieldTable({
  schema,
  doc,
}: {
  schema: SchemaNode | undefined;
  doc: OpenApiDoc;
}) {
  if (!schema?.properties) return null;
  const required = new Set(schema.required ?? []);
  const entries = Object.entries(schema.properties);
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-slate-500">
            <th className="py-2 pr-4 font-medium">Field</th>
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 font-medium">Required</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([name, node]) => (
            <tr key={name} className="border-b border-slate-100 align-top">
              <td className="py-2 pr-4 font-mono text-slate-800">{name}</td>
              <td className="py-2 pr-4 font-mono text-xs text-slate-600">
                {typeLabel(node)}
              </td>
              <td className="py-2 text-slate-600">
                {required.has(name) ? "Yes" : "No"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {schema.description ? (
        <p className="mt-2 text-xs text-slate-500">{schema.description}</p>
      ) : null}
      {/* Nested item schema (e.g. quote line items). */}
      {entries.map(([name, node]) =>
        node.type === "array" && node.items?.$ref ? (
          <div key={`${name}-items`} className="mt-3 rounded-md bg-slate-50 p-3">
            <p className="text-xs font-medium text-slate-600">
              {name}[] items ({refName(node.items.$ref)})
            </p>
            <FieldTable
              schema={doc.components.schemas[refName(node.items.$ref)!]}
              doc={doc}
            />
          </div>
        ) : null,
      )}
    </div>
  );
}

function scopeOf(op: Operation): string | null {
  const entry = op.security?.[0];
  if (!entry) return null;
  const scopes = Object.values(entry)[0];
  return scopes && scopes.length > 0 ? scopes[0]! : null;
}

function curlExample(
  method: string,
  base: string,
  path: string,
  bodySchema: SchemaNode | undefined,
): string {
  const url = `${base}${path.replace("{id}", "{id}")}`;
  const header = `-H "Authorization: Bearer crewflow_sk_..."`;
  if (method === "get") {
    return `curl ${url} \\\n  ${header}`;
  }
  const sample: Record<string, unknown> = {};
  if (bodySchema?.properties) {
    for (const req of bodySchema.required ?? []) {
      const node = bodySchema.properties[req];
      if (!node) continue;
      if (node.type === "array") sample[req] = [];
      else if (node.enum) sample[req] = node.enum[0];
      else if (node.type === "number") sample[req] = 0;
      else sample[req] = "...";
    }
  }
  const body = JSON.stringify(sample);
  return `curl -X ${method.toUpperCase()} ${url} \\\n  ${header} \\\n  -H "Content-Type: application/json" \\\n  -d '${body}'`;
}

export default function DevelopersPage() {
  if (!isPublicApiJobsEnabled()) notFound();

  const doc = buildOpenApiDocument() as unknown as OpenApiDoc;
  const base = doc.servers[0]?.url ?? "https://app.crewflow.uk/api/v1";

  // Group operations by tag, preserving path/method order.
  const groups = new Map<
    string,
    Array<{ method: string; path: string; op: Operation }>
  >();
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const method of METHOD_ORDER) {
      const op = methods[method];
      if (!op) continue;
      const tag = op.tags?.[0] ?? "Other";
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag)!.push({ method, path, op });
    }
  }

  return (
    <div className="mx-auto max-w-4xl px-6 py-16">
      <header className="border-b border-slate-200 pb-8">
        <p className="text-sm font-semibold uppercase tracking-wide text-sky-600">
          Developers
        </p>
        <h1 className="mt-2 text-4xl font-bold text-slate-900">
          {doc.info.title}
        </h1>
        <p className="mt-2 text-sm text-slate-500">Version {doc.info.version}</p>
        <p className="mt-4 max-w-2xl text-slate-600">{doc.info.description}</p>
        <p className="mt-4 text-sm text-slate-500">
          Base URL:{" "}
          <code className="rounded bg-slate-100 px-2 py-1 font-mono text-slate-800">
            {base}
          </code>{" "}
          &middot; Machine-readable spec:{" "}
          <a
            href="/api/v1/openapi.json"
            className="font-medium text-sky-600 hover:underline"
          >
            openapi.json
          </a>
        </p>
      </header>

      {/* Authentication */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold text-slate-900">Authentication</h2>
        <p className="mt-3 text-slate-600">
          {doc.components.securitySchemes.apiKey.description}
        </p>
        <pre className="mt-4 overflow-x-auto rounded-lg bg-slate-900 p-4 text-sm text-slate-100">
          <code>Authorization: Bearer crewflow_sk_...</code>
        </pre>
      </section>

      {/* Scopes */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold text-slate-900">Scopes</h2>
        <p className="mt-3 text-slate-600">
          Every key is granted a specific set of scopes. Read and write are
          distinct: a key needs the matching write scope to create or update,
          even if it can already read that resource.
        </p>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 pr-4 font-medium">Scope</th>
                <th className="py-2 font-medium">Grants</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(doc["x-scopes"]).map(([scope, label]) => (
                <tr key={scope} className="border-b border-slate-100">
                  <td className="py-2 pr-4 font-mono text-slate-800">{scope}</td>
                  <td className="py-2 text-slate-600">{label}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Rate limits */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold text-slate-900">Rate limits</h2>
        <p className="mt-3 text-slate-600">
          Requests are limited to <strong>120 per minute per key</strong>
          (shared across every v1 endpoint, keyed by the API key, not by IP).
          Over budget returns <code className="font-mono">429</code>.
        </p>
      </section>

      {/* Endpoints */}
      <section className="mt-12">
        <h2 className="text-2xl font-semibold text-slate-900">Endpoints</h2>
        {[...groups.entries()].map(([tag, ops]) => (
          <div key={tag} className="mt-8">
            <h3 className="text-xl font-semibold text-slate-800">{tag}</h3>
            <div className="mt-4 space-y-6">
              {ops.map(({ method, path, op }) => {
                const scope = scopeOf(op);
                const bodyRef = refName(
                  op.requestBody?.content["application/json"].schema.$ref,
                );
                const bodySchema = bodyRef
                  ? doc.components.schemas[bodyRef]
                  : undefined;
                return (
                  <div
                    key={`${method}-${path}`}
                    className="rounded-lg border border-slate-200 p-5"
                  >
                    <div className="flex flex-wrap items-center gap-3">
                      <span
                        className={`rounded px-2 py-1 text-xs font-bold uppercase ${
                          METHOD_STYLES[method] ?? "bg-slate-100 text-slate-700"
                        }`}
                      >
                        {method}
                      </span>
                      <code className="font-mono text-slate-800">{path}</code>
                      {scope ? (
                        <span className="ml-auto rounded bg-slate-100 px-2 py-1 font-mono text-xs text-slate-600">
                          {scope}
                        </span>
                      ) : (
                        <span className="ml-auto rounded bg-slate-100 px-2 py-1 text-xs text-slate-500">
                          any valid key
                        </span>
                      )}
                    </div>
                    {op.summary ? (
                      <p className="mt-3 text-slate-600">{op.summary}</p>
                    ) : null}
                    {bodySchema ? (
                      <>
                        <p className="mt-4 text-sm font-medium text-slate-700">
                          Request body
                        </p>
                        <FieldTable schema={bodySchema} doc={doc} />
                      </>
                    ) : null}
                    <p className="mt-4 text-sm font-medium text-slate-700">
                      Example
                    </p>
                    <pre className="mt-2 overflow-x-auto rounded-lg bg-slate-900 p-4 text-xs text-slate-100">
                      <code>{curlExample(method, base, path, bodySchema)}</code>
                    </pre>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </section>

      {/* Versioning */}
      <section className="mt-12 border-t border-slate-200 pt-8">
        <h2 className="text-2xl font-semibold text-slate-900">Versioning</h2>
        <p className="mt-3 text-slate-600">
          {doc["x-api-versioning"].breaking_change_policy} Additive changes (new
          optional fields, new endpoints) are made in place.
        </p>
      </section>
    </div>
  );
}
