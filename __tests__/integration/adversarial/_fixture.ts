/* eslint-disable @typescript-eslint/no-explicit-any -- the adversarial suite is
   catalogue-driven: it addresses tables and functions by NAME discovered at run time,
   which the generated Database types cannot express. Loose client shapes are confined
   to this directory. */
/**
 * Adversarial tenant-isolation suite — shared fixture.
 *
 * Everything here attacks the LOCAL Supabase stack directly (PostgREST / GoTrue /
 * Storage), never through the Next.js frontend. Three building blocks:
 *
 *   loadSurface()   — the live catalogue (every relation, client-executable function
 *                     and bucket) via public._introspect_adversarial_surface()
 *                     (migration 20261300000000). Tests iterate THIS, so a table or
 *                     RPC added next month is attacked without anyone editing a list.
 *   createWorld()   — two independent synthetic organisations (A, B), each with a
 *                     real owner, admin and staff user holding REAL GoTrue sessions.
 *   seedOrgRows()   — a generic row factory that plants one row in every org-scoped
 *                     table it can satisfy the constraints of (FK-ordered, type- and
 *                     CHECK-aware). What it cannot seed is returned, never hidden.
 */
import { randomUUID, createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { anonClient, serviceClient, userClient } from "../_harness";

export type Loose = SupabaseClient<any, any, any>;
export const svc = (): Loose => serviceClient() as unknown as Loose;
export const anon = (): Loose => anonClient() as unknown as Loose;
export const as = (token: string): Loose => userClient(token) as unknown as Loose;

// ── catalogue ────────────────────────────────────────────────────────────────

export type Column = {
  name: string;
  type: string;
  notnull: boolean;
  has_default: boolean;
  generated: boolean;
  identity: boolean;
  enum: string[] | null;
};
export type Fk = { cols: string[]; ref_schema: string; ref_table: string; ref_cols: string[] };
export type Relation = {
  schema: string;
  name: string;
  kind: "r" | "p" | "v" | "m";
  rls: boolean;
  anon: string[];
  authenticated: string[];
  columns: Column[];
  pk: string[];
  fks: Fk[];
  checks: string[];
};
export type Fn = {
  name: string;
  identity_args: string;
  arg_names: string[];
  arg_types: string[];
  n_defaults: number;
  returns: string;
  secdef: boolean;
  volatile: boolean;
  anon: boolean;
  authenticated: boolean;
};
export type Surface = {
  relations: Relation[];
  functions: Fn[];
  buckets: { id: string; public: boolean }[];
};

let cachedSurface: Surface | null = null;

export async function loadSurface(): Promise<Surface> {
  if (cachedSurface) return cachedSurface;
  const { data, error } = await svc().rpc("_introspect_adversarial_surface");
  if (error) {
    throw new Error(
      `adversarial fixture: _introspect_adversarial_surface() failed (${error.message}). ` +
        "Is migration 20261300000000 applied?",
    );
  }
  cachedSurface = data as Surface;
  return cachedSurface;
}

export const ORG_COLUMNS = ["org_id", "organization_id"] as const;

export function orgColumnOf(rel: Relation): string | null {
  for (const c of ORG_COLUMNS) if (rel.columns.some((col) => col.name === c)) return c;
  return null;
}

/** Base tables in `public` (the only schema with application rows). */
export function publicTables(s: Surface): Relation[] {
  return s.relations.filter((r) => r.schema === "public" && (r.kind === "r" || r.kind === "p"));
}

// ── connection facts (for raw fetch attacks) ─────────────────────────────────

export function apiUrl(): string {
  const u = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!u) throw new Error("adversarial fixture: SUPABASE_URL missing");
  return u.replace(/\/$/, "");
}
export function anonKey(): string {
  const k = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!k) throw new Error("adversarial fixture: SUPABASE_ANON_KEY missing");
  return k;
}

/** Raw PostgREST/GoTrue/Storage call with an arbitrary bearer (forged tokens etc.). */
export async function rawFetch(
  path: string,
  init: { method?: string; bearer?: string | null; body?: unknown; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = { apikey: anonKey(), ...(init.headers ?? {}) };
  if (init.bearer !== null) headers.Authorization = `Bearer ${init.bearer ?? anonKey()}`;
  if (init.body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
  const res = await fetch(`${apiUrl()}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// ── JWT helpers (forge / tamper / expire) ────────────────────────────────────

const b64u = (b: Buffer | string): string =>
  Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

export function decodeJwt(token: string): { header: any; payload: any; signature: string } {
  const [h = "", p = "", s = ""] = token.split(".");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(p, "base64url").toString("utf8")),
    signature: s,
  };
}

/** Sign an arbitrary payload HS256 with `secret`. */
export function signHs256(payload: Record<string, unknown>, secret: string, header: Record<string, unknown> = {}): string {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT", ...header }));
  const p = b64u(JSON.stringify(payload));
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest();
  return `${h}.${p}.${b64u(sig)}`;
}

/** Re-encode a token with a modified payload but the ORIGINAL signature (tamper). */
export function tamperPayload(token: string, patch: Record<string, unknown>): string {
  const [h, , s] = token.split(".");
  const { payload } = decodeJwt(token);
  return `${h}.${b64u(JSON.stringify({ ...payload, ...patch }))}.${s}`;
}

/** `alg: none` variant of a token (unsigned). */
export function algNone(token: string, patch: Record<string, unknown> = {}): string {
  const { payload } = decodeJwt(token);
  return `${b64u(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64u(JSON.stringify({ ...payload, ...patch }))}.`;
}

// ── actors / world ───────────────────────────────────────────────────────────

export type Role = "owner" | "admin" | "staff";
export type Actor = { id: string; email: string; password: string; token: string; refreshToken: string; role: Role | null };
export type Org = { id: string; slug: string; owner: Actor; admin: Actor; staff: Actor };
export type World = {
  tag: string;
  A: Org;
  B: Org;
  /** Extra users created through mkActor — tracked for cleanup. */
  extras: Actor[];
  extraOrgIds: string[];
};

const must = <T>(r: { data: T | null; error: { message: string } | null }, what: string): T => {
  if (r.error || r.data === null) throw new Error(`adversarial fixture: ${what}: ${r.error?.message ?? "no data"}`);
  return r.data;
};

export function newTag(prefix = "sectenant"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function signIn(email: string, password: string): Promise<{ token: string; refreshToken: string }> {
  const s = await anon().auth.signInWithPassword({ email, password });
  if (s.error || !s.data.session) throw new Error(`adversarial fixture: sign-in ${email}: ${s.error?.message}`);
  return { token: s.data.session.access_token, refreshToken: s.data.session.refresh_token };
}

/** Create a real GoTrue user (+ public.users mirror), optionally a membership, and sign in. */
export async function mkActor(tag: string, label: string, orgId: string | null, role: Role | null): Promise<Actor> {
  const email = `${tag}-${label}@example.test`;
  const password = `Pw-${tag}-${label}-9!x`;
  const created = await serviceClient().auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw new Error(`adversarial fixture: createUser ${email}: ${created.error?.message}`);
  const id = created.data.user.id;
  // A handle_new_user-style trigger may already have mirrored the row.
  const mirror = await svc().from("users").upsert({ id, email, full_name: `${label} ${tag}` }, { onConflict: "id" });
  if (mirror.error) throw new Error(`adversarial fixture: users mirror ${email}: ${mirror.error.message}`);
  if (orgId && role) {
    const m = await svc().from("memberships").insert({ org_id: orgId, user_id: id, role });
    if (m.error) throw new Error(`adversarial fixture: membership ${email}: ${m.error.message}`);
  }
  const { token, refreshToken } = await signIn(email, password);
  return { id, email, password, token, refreshToken, role };
}

export async function mkOrg(tag: string, label: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const row = must(
    await svc()
      .from("organizations")
      .insert({ name: `Adv ${label} ${tag}`, slug: `${tag}-${label}`.toLowerCase(), status: "active", ...overrides })
      .select("id")
      .single(),
    `org ${label}`,
  ) as { id: string };
  return row.id;
}

export async function createWorld(prefix = "sectenant"): Promise<World> {
  const tag = newTag(prefix);
  const mk = async (label: string): Promise<Org> => {
    const id = await mkOrg(tag, label);
    const owner = await mkActor(tag, `${label}-owner`, id, "owner");
    const admin = await mkActor(tag, `${label}-admin`, id, "admin");
    const staff = await mkActor(tag, `${label}-staff`, id, "staff");
    return { id, slug: `${tag}-${label}`, owner, admin, staff };
  };
  const A = await mk("a");
  const B = await mk("b");
  return { tag, A, B, extras: [], extraOrgIds: [] };
}

export async function destroyWorld(w: World | null): Promise<void> {
  if (!w) return;
  for (const id of [w.A.id, w.B.id, ...w.extraOrgIds]) {
    if (id) await svc().from("organizations").delete().eq("id", id);
  }
  const actors = [w.A.owner, w.A.admin, w.A.staff, w.B.owner, w.B.admin, w.B.staff, ...w.extras];
  for (const a of actors) {
    if (!a?.id) continue;
    await svc().from("users").delete().eq("id", a.id);
    await serviceClient().auth.admin.deleteUser(a.id);
  }
}

// ── generic row factory ──────────────────────────────────────────────────────

export type SeedResult = {
  /** table → the row as stored (service-role representation). */
  rows: Map<string, Record<string, any>>;
  /** table → why it could not be seeded. */
  unseeded: Map<string, string>;
};

function firstAllowedValue(rel: Relation, col: string): string | null {
  // Prefer an enumerated set — CHECK ((status = ANY (ARRAY['a'::text, 'b'::text]))) —
  // over a lone equality, which is usually one arm of a multi-column coherence rule.
  for (const chk of rel.checks) {
    const any = new RegExp(`\\(\\(?${col}\\)?(?:::text)? = ANY \\(\\(?ARRAY\\['([^']*)'`).exec(chk);
    if (any) return any[1] ?? null;
  }
  for (const chk of rel.checks) {
    const eq = new RegExp(`^CHECK \\(\\(${col} = '([^']*)'::[a-z ]+\\)\\)$`).exec(chk);
    if (eq) return eq[1] ?? null;
  }
  return null;
}

const hex64 = (): string => createHmac("sha256", randomUUID()).update("adv").digest("hex");
const alnum = (n: number): string => {
  let out = "";
  while (out.length < n) out += randomUUID().replace(/-/g, "");
  return out.slice(0, n);
};

/**
 * Hand-written column values for security-sensitive tables whose CHECKs the generic
 * synthesiser cannot satisfy (format regexes, multi-column coherence). Merged OVER the
 * synthesised row. Keep this short: it exists so the highest-value tables (API keys,
 * webhook secrets, SSO config, budgets) are never silently absent from the attack.
 */
const OVERRIDES: Record<string, (ctx: { tag: string; userId: string; rows: Map<string, Record<string, any>> }) => Record<string, unknown>> = {
  api_keys: () => ({ key_prefix: `crewflow_sk_${alnum(8)}`, key_hash: hex64() }),
  webhook_endpoints: ({ tag }) => ({ url: `https://example.test/${tag}/hook`, secret: `whsec_${alnum(43)}`, status: "paused" }),
  job_budgets: () => ({ total_cost: 100 }),
  rota_entries: () => ({ starts_at: "2031-01-06T08:00:00Z", ends_at: "2031-01-06T16:00:00Z" }),
  retention_policies: () => ({ table_name: "notifications", retention_days: 365 }),
  retention_purge_log: () => ({ table_name: "notifications", retention_days: 365 }),
  ai_invocations: () => ({ success: true, task_class: "classification" }),
  cis_contractor_profiles: () => ({ employer_paye_reference: "123/AB456" }),
  org_sso_config: () => ({
    protocol: "saml",
    saml_idp_entity_id: "https://idp.example.test/entity",
    saml_idp_sso_url: "https://idp.example.test/sso",
    saml_idp_x509_cert: "ADV-NOT-A-REAL-CERT",
  }),
  site_inductions: () => ({ person_name: "Adv Visitor" }),
  stock_movements: () => ({ movement_type: "receipt" }),
  ai_quote_drafts: ({ rows }) => ({ lead_id: rows.get("leads")?.id, prompt_checksum: hex64(), provenance: "anthropic" }),
  service_booking_slots: () => ({ starts_at: "2031-01-06T08:00:00Z", ends_at: "2031-01-06T10:00:00Z" }),
  telematics_readings: () => ({ odometer_miles: 10 }),
};

function synth(rel: Relation, col: Column, tag: string): unknown {
  if (col.enum && col.enum.length) return col.enum[0];
  const t = col.type;
  const n = col.name;
  if (t.endsWith("[]")) return [];
  if (t === "uuid") return randomUUID();
  if (t === "boolean") return false;
  if (t === "jsonb" || t === "json") return {};
  if (t === "date") return new Date().toISOString().slice(0, 10);
  if (t.startsWith("timestamp")) return new Date().toISOString();
  if (t.startsWith("time")) return "09:00:00";
  if (t === "interval") return "1 hour";
  if (/^(integer|bigint|smallint|numeric|double precision|real)/.test(t)) return 1;
  if (t === "bytea") return "\\x00";
  if (t === "inet") return "127.0.0.1";
  // text-like
  const allowed = firstAllowedValue(rel, n);
  if (allowed !== null) return allowed;
  const rnd = Math.random().toString(36).slice(2, 10);
  if (/email/.test(n)) return `${tag}-${rnd}@example.test`;
  if (/e164|phone|msisdn/.test(n)) return `+4477009${Math.floor(10000 + Math.random() * 89999)}`;
  if (/currency/.test(n)) return "GBP";
  if (/country|region/.test(n)) return "GB";
  if (/hash|digest|sha/.test(n)) return createHmac("sha256", rnd).update(tag).digest("hex");
  if (/slug/.test(n)) return `${tag}-${rnd}`;
  if (/url/.test(n)) return `https://example.test/${tag}/${rnd}`;
  if (/path/.test(n)) return `${tag}/${rnd}.bin`;
  return `adv-${tag}-${rnd}`;
}

/**
 * Plant one row per org-scoped table for `orgId`. FK-ordered by repeated passes: a
 * table is attempted once every NOT NULL foreign key it has points at something
 * already seeded (or at organizations / users, which the world provides).
 */
export async function seedOrgRows(surface: Surface, orgId: string, userId: string, tag: string): Promise<SeedResult> {
  const rows = new Map<string, Record<string, any>>();
  const unseeded = new Map<string, string>();
  const tables = publicTables(surface).filter((r) => orgColumnOf(r) && r.name !== "memberships");
  // The world already created the memberships; expose the seeding user's so tables
  // that hang off a membership (membership_permissions, staff_qualifications) can link.
  const mem = await svc().from("memberships").select("*").eq("org_id", orgId).eq("user_id", userId).maybeSingle();
  if (mem.data) rows.set("memberships", mem.data as Record<string, any>);
  const byName = new Map(tables.map((t) => [t.name, t]));
  const pending = new Set(tables.map((t) => t.name));

  const build = (rel: Relation): { row: Record<string, unknown> } | { missing: string } => {
    const row: Record<string, unknown> = {};
    const orgCol = orgColumnOf(rel)!;
    for (const col of rel.columns) {
      if (col.generated || col.identity) continue;
      if (col.name === orgCol) {
        row[col.name] = orgId;
        continue;
      }
      const fk = rel.fks.find((f) => f.cols.includes(col.name));
      if (fk) {
        if (!col.notnull) continue; // leave optional links null
        const refCol = fk.ref_cols[fk.cols.indexOf(col.name)];
        if (fk.ref_table === "organizations") row[col.name] = orgId;
        else if (fk.ref_table === "users") row[col.name] = userId;
        else if (fk.ref_table === rel.name) return { missing: `self-referencing NOT NULL fk ${col.name}` };
        else {
          const parent = rows.get(fk.ref_table);
          if (!parent) return { missing: fk.ref_table };
          row[col.name] = refCol ? parent[refCol] : undefined;
        }
        continue;
      }
      if (col.notnull && !col.has_default) row[col.name] = synth(rel, col, tag);
    }
    const over = OVERRIDES[rel.name]?.({ tag, userId, rows }) ?? {};
    for (const [k, v] of Object.entries(over)) {
      if (v !== undefined && rel.columns.some((c) => c.name === k)) row[k] = v;
    }
    return { row };
  };

  let progress = true;
  while (pending.size && progress) {
    progress = false;
    for (const name of [...pending]) {
      const rel = byName.get(name)!;
      const built = build(rel);
      if ("missing" in built) {
        unseeded.set(name, `needs ${built.missing}`);
        continue;
      }
      const ins = await svc().from(name).insert(built.row).select("*").maybeSingle();
      pending.delete(name);
      if (ins.error || !ins.data) {
        unseeded.set(name, (ins.error?.message ?? "no row returned").slice(0, 160));
      } else {
        unseeded.delete(name);
        rows.set(name, ins.data as Record<string, any>);
        progress = true;
      }
    }
  }
  return { rows, unseeded };
}

/** PostgREST filter that pins exactly `row` by primary key (or by every scalar column). */
export function pkFilter(rel: Relation, row: Record<string, any>): Record<string, string> | null {
  const keys = rel.pk.length ? rel.pk : rel.columns.some((c) => c.name === "id") ? ["id"] : [];
  if (!keys.length) return null;
  const f: Record<string, string> = {};
  for (const k of keys) {
    if (row[k] === null || row[k] === undefined) return null;
    f[k] = `eq.${row[k]}`;
  }
  return f;
}

export function qs(filter: Record<string, string>): string {
  return Object.entries(filter)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
}
