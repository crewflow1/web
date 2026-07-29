"use server";

import { createClient } from "@/lib/supabase/server";
import { requireOrgContext } from "@/server/auth/session";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import {
  assertTemplateTransition,
  createTemplateSchema,
  type CheckLevel,
  templateDefinitionSchema,
  templateItemSchema,
  validateForPublish,
  type TemplateDefinition,
  type TemplateStatus,
} from "@/lib/assets/inspection-template";
import { formError, formSuccess, type FormState } from "@/lib/forms/state";

/**
 * Inspection template actions (M4b). The app owns the state machine and
 * definition validation; the DB (20260929) freezes published substance,
 * guarantees one published version per family, and backstops publish integrity.
 * All writes go through the tenant (user-JWT) client so RLS scopes them; all
 * lifecycle changes are audited.
 *
 * These actions return `FormState` (the client navigates via `redirectTo`
 * through <StateForm>, a full document load) instead of calling `redirect()`.
 * A Server-Action redirect between routes under /assets/templates/* loses a
 * race in the Next 15.5 client router (upstream vercel/next.js#83386): the
 * rejected redirect error can strand React's still-suspended commit, so the
 * row is written but the URL never changes and no error surfaces. Measured on
 * this exact page under `next start`: addSection lost 100% of reps. See
 * components/forms/StateForm.tsx and the fleet fix (8e4a846).
 *
 * No revalidatePath, deliberately: every /assets/templates surface renders
 * per-request (cookie-authed reads, no Next data cache), and the client router
 * treats dynamic content as immediately stale — the post-navigation document
 * load is always fresh.
 */

type TemplateRow = {
  id: string;
  family_id: string;
  version: number;
  name: string;
  description: string | null;
  categories: string[] | null;
  check_level: CheckLevel;
  status: TemplateStatus;
  definition: TemplateDefinition;
};

type LoadOne = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (
        k: string,
        v: unknown,
      ) => { maybeSingle: () => Promise<{ data: TemplateRow | null; error: SupabaseReadError | null }> };
    };
  };
};
type InsertOne = {
  insert: (row: unknown) => {
    select: (c: string) => {
      single: () => Promise<{ data: { id: string } | null; error: { message: string } | null }>;
    };
  };
};
type UpdateChain = {
  update: (
    patch: unknown,
    opts?: { count?: string },
  ) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        eq: (
          k: string,
          v: unknown,
        ) => Promise<{ error: { message: string } | null; count: number | null }>;
      };
    };
  };
};
type ListChain = {
  select: (c: string) => {
    eq: (k: string, v: unknown) => {
      eq: (k: string, v: unknown) => {
        order: (c: string, o: { ascending: boolean }) => Promise<{ data: { id: string; version: number; status: string }[] | null }>;
      };
    };
  };
};

const templates = (t: Awaited<ReturnType<typeof createClient>>) =>
  t.from("asset_inspection_templates" as never);

async function loadTemplate(orgId: string, id: string): Promise<TemplateRow | null> {
  const tenant = await createClient();
  const { data, error } = await (templates(tenant) as unknown as LoadOne)
    .select("id, family_id, version, name, description, categories, check_level, status, definition")
    .eq("id", id)
    .eq("org_id", orgId)
    .maybeSingle();
  // Loud fail: callers turn null into "?error=template_missing" — a query
  // failure must not wear that banner.
  if (error) throw readFailure("templates: load", error);
  return data;
}

function parseCategories(raw: FormDataEntryValue | null): string[] | undefined {
  const list = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return list.length > 0 ? list : undefined;
}

/** URL-safe unique key for sections/items (Web Crypto — no node: import). */
function newKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

async function audit(user: { id: string; email?: string | null }, action: string, id: string, metadata: Record<string, unknown> = {}) {
  await recordAdminActivity({
    actorId: user.id,
    actorEmail: user.email ?? null,
    action,
    targetTable: "asset_inspection_templates",
    targetId: id,
    metadata,
  });
}

// ── Create / clone / next version ─────────────────────────────────────────────

export async function createTemplate(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const parsed = createTemplateSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description"),
    categories: parseCategories(formData.get("categories")),
    check_level: formData.get("check_level"),
  });
  if (!parsed.success) return formError("Something went wrong — try again.");

  const tenant = await createClient();
  const { data, error } = await (templates(tenant) as unknown as InsertOne)
    .insert({
      org_id: ctx.org.id,
      family_id: crypto.randomUUID(),
      version: 1,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
      categories: parsed.data.categories ?? null,
      check_level: parsed.data.check_level,
      status: "draft",
      definition: { sections: [] },
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[asset-template] create failed", error);
    return formError("Something went wrong — try again.");
  }

  await audit(user, "asset.template_created", data.id, { name: parsed.data.name });
  return formSuccess({ redirectTo: `/assets/templates/${data.id}?saved=created` });
}

export async function cloneTemplate(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const sourceId = String(formData.get("template_id") ?? "");
  const source = await loadTemplate(ctx.org.id, sourceId);
  if (!source) return formError("Template not found.");

  const tenant = await createClient();
  const { data, error } = await (templates(tenant) as unknown as InsertOne)
    .insert({
      org_id: ctx.org.id,
      family_id: crypto.randomUUID(), // a clone starts a NEW family
      version: 1,
      name: `Copy of ${source.name}`.slice(0, 160),
      description: source.description,
      categories: source.categories,
      check_level: source.check_level,
      status: "draft",
      definition: source.definition,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[asset-template] clone failed", error);
    return formError("Something went wrong — try again.");
  }

  await audit(user, "asset.template_cloned", data.id, { source_id: sourceId });
  return formSuccess({ redirectTo: `/assets/templates/${data.id}?saved=cloned` });
}

export async function createNextVersion(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const sourceId = String(formData.get("template_id") ?? "");
  const source = await loadTemplate(ctx.org.id, sourceId);
  if (!source) return formError("Template not found.");

  const tenant = await createClient();
  // One draft per family at a time — a second concurrent draft is confusing, not
  // dangerous (the DB (family,version) uniqueness is the hard invariant).
  const { data: family } = await (templates(tenant) as unknown as ListChain)
    .select("id, version, status")
    .eq("family_id", source.family_id)
    .eq("org_id", ctx.org.id)
    .order("version", { ascending: false });
  if ((family ?? []).some((v) => v.status === "draft")) {
    return formError("This family already has a draft version.");
  }
  const nextVersion = (family?.[0]?.version ?? source.version) + 1;

  const { data, error } = await (templates(tenant) as unknown as InsertOne)
    .insert({
      org_id: ctx.org.id,
      family_id: source.family_id,
      version: nextVersion,
      name: source.name,
      description: source.description,
      categories: source.categories,
      check_level: source.check_level,
      status: "draft",
      definition: source.definition,
      supersedes_id: source.id,
      created_by: user.id,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[asset-template] next version failed", error);
    return formError("Something went wrong — try again.");
  }

  await audit(user, "asset.template_version_created", data.id, {
    family_id: source.family_id,
    version: nextVersion,
  });
  return formSuccess({ redirectTo: `/assets/templates/${data.id}?saved=version` });
}

// ── Draft definition editing ──────────────────────────────────────────────────

async function writeDraftDefinition(
  templateId: string,
  definition: TemplateDefinition,
): Promise<"ok" | "not_draft" | "failed"> {
  const { ctx } = await requireOrgContext();
  const parsed = templateDefinitionSchema.safeParse(definition);
  if (!parsed.success) return "failed";

  const tenant = await createClient();
  // status='draft' filter + the DB immutability trigger are the gates.
  const { error, count } = await (templates(tenant) as unknown as UpdateChain)
    .update({ definition: parsed.data }, { count: "exact" })
    .eq("id", templateId)
    .eq("org_id", ctx.org.id)
    .eq("status", "draft");
  if (error) {
    console.error("[asset-template] definition write failed", error);
    return "failed";
  }
  return count ? "ok" : "not_draft";
}

export async function addSection(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  const templateId = String(formData.get("template_id") ?? "");
  const title = String(formData.get("title") ?? "").trim();
  const t = await loadTemplate(ctx.org.id, templateId);
  if (!t) return formError("Template not found.");
  if (!title) return formError("Give the section a title.");

  const def = { sections: [...t.definition.sections, { key: newKey("sec"), title: title.slice(0, 120), items: [] }] };
  const res = await writeDraftDefinition(templateId, def);
  if (res !== "ok") return formError(res === "not_draft" ? "Only draft templates can be edited." : "Something went wrong — try again.");
  return formSuccess({ redirectTo: `/assets/templates/${templateId}?saved=section` });
}

export async function removeSection(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  const templateId = String(formData.get("template_id") ?? "");
  const sectionKey = String(formData.get("section_key") ?? "");
  const t = await loadTemplate(ctx.org.id, templateId);
  if (!t) return formError("Template not found.");

  const def = { sections: t.definition.sections.filter((s) => s.key !== sectionKey) };
  const res = await writeDraftDefinition(templateId, def);
  if (res !== "ok") return formError(res === "not_draft" ? "Only draft templates can be edited." : "Something went wrong — try again.");
  return formSuccess({ redirectTo: `/assets/templates/${templateId}?saved=section_removed` });
}

export async function moveSection(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  const templateId = String(formData.get("template_id") ?? "");
  const sectionKey = String(formData.get("section_key") ?? "");
  const dir = String(formData.get("dir") ?? "") === "up" ? -1 : 1;
  const t = await loadTemplate(ctx.org.id, templateId);
  if (!t) return formError("Template not found.");

  const sections = [...t.definition.sections];
  const idx = sections.findIndex((s) => s.key === sectionKey);
  const swap = idx + dir;
  const a = sections[idx];
  const b = sections[swap];
  if (idx >= 0 && a && b) {
    sections[idx] = b;
    sections[swap] = a;
    const res = await writeDraftDefinition(templateId, { sections });
    if (res !== "ok") return formError("Something went wrong — try again.");
  }
  // Same URL, no query — the document reload shows the new order.
  return formSuccess({ redirectTo: `/assets/templates/${templateId}` });
}

export async function addItem(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  const templateId = String(formData.get("template_id") ?? "");
  const sectionKey = String(formData.get("section_key") ?? "");
  const t = await loadTemplate(ctx.org.id, templateId);
  if (!t) return formError("Template not found.");

  const rawMin = String(formData.get("min") ?? "").trim();
  const rawMax = String(formData.get("max") ?? "").trim();
  const choices = parseCategories(formData.get("choices"));
  const failingChoices = parseCategories(formData.get("failing_choices"));
  const parsed = templateItemSchema.safeParse({
    key: newKey("itm"),
    prompt: formData.get("prompt"),
    guidance: formData.get("guidance"),
    response_type: formData.get("response_type"),
    required: formData.get("required") === "on",
    safety_critical: formData.get("safety_critical") === "on",
    severity: String(formData.get("severity") ?? "minor"),
    fail_on: String(formData.get("fail_on") ?? "") || undefined,
    choices,
    failing_choices: failingChoices,
    min: rawMin === "" ? undefined : Number(rawMin),
    max: rawMax === "" ? undefined : Number(rawMax),
    allow_na: formData.get("allow_na") === "on",
    requires_photo: formData.get("requires_photo") === "on",
    requires_photo_on_fail: formData.get("requires_photo_on_fail") === "on",
    requires_comment_on_fail: formData.get("requires_comment_on_fail") === "on",
    requires_signature: formData.get("requires_signature") === "on",
  });
  if (!parsed.success) return formError("Check the item fields and try again.");

  const sections = t.definition.sections.map((s) =>
    s.key === sectionKey ? { ...s, items: [...s.items, parsed.data] } : s,
  );
  const res = await writeDraftDefinition(templateId, { sections });
  if (res !== "ok") return formError(res === "not_draft" ? "Only draft templates can be edited." : "Something went wrong — try again.");
  return formSuccess({ redirectTo: `/assets/templates/${templateId}?saved=item` });
}

export async function removeItem(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  const templateId = String(formData.get("template_id") ?? "");
  const itemKey = String(formData.get("item_key") ?? "");
  const t = await loadTemplate(ctx.org.id, templateId);
  if (!t) return formError("Template not found.");

  const sections = t.definition.sections.map((s) => ({
    ...s,
    items: s.items.filter((i) => i.key !== itemKey),
  }));
  const res = await writeDraftDefinition(templateId, { sections });
  if (res !== "ok") return formError(res === "not_draft" ? "Only draft templates can be edited." : "Something went wrong — try again.");
  return formSuccess({ redirectTo: `/assets/templates/${templateId}?saved=item_removed` });
}

export async function moveItem(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx } = await requireOrgContext();
  const templateId = String(formData.get("template_id") ?? "");
  const itemKey = String(formData.get("item_key") ?? "");
  const dir = String(formData.get("dir") ?? "") === "up" ? -1 : 1;
  const t = await loadTemplate(ctx.org.id, templateId);
  if (!t) return formError("Template not found.");

  const sections = t.definition.sections.map((s) => {
    const idx = s.items.findIndex((i) => i.key === itemKey);
    const swap = idx + dir;
    const items = [...s.items];
    const a = items[idx];
    const b = items[swap];
    if (idx < 0 || !a || !b) return s;
    items[idx] = b;
    items[swap] = a;
    return { ...s, items };
  });
  const res = await writeDraftDefinition(templateId, { sections });
  if (res !== "ok") return formError("Something went wrong — try again.");
  // Same URL, no query — the document reload shows the new order.
  return formSuccess({ redirectTo: `/assets/templates/${templateId}` });
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

export async function publishTemplate(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const templateId = String(formData.get("template_id") ?? "");
  const t = await loadTemplate(ctx.org.id, templateId);
  if (!t) return formError("Template not found.");

  try {
    assertTemplateTransition(t.status, "published");
  } catch {
    return formError("Only a draft template can be published.");
  }
  const parsed = templateDefinitionSchema.safeParse(t.definition);
  if (!parsed.success || validateForPublish(parsed.data).length > 0) {
    return formError("The template isn't complete enough to publish.");
  }

  const tenant = await createClient();
  // Atomic supersede-old + publish-new (SECURITY INVOKER RPC; RLS still applies).
  const { error } = await (
    tenant as unknown as {
      rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
    }
  ).rpc("publish_inspection_template", {
    p_template_id: templateId,
    p_org_id: ctx.org.id,
    p_user: user.id,
  });
  if (error) {
    console.error("[asset-template] publish failed", error);
    return formError("Something went wrong — try again.");
  }

  await audit(user, "asset.template_published", templateId, { version: t.version });
  return formSuccess({ redirectTo: `/assets/templates/${templateId}?saved=published` });
}

export async function archiveTemplate(_prev: FormState, formData: FormData): Promise<FormState> {
  const { ctx, user } = await requireOrgContext();
  const templateId = String(formData.get("template_id") ?? "");
  const t = await loadTemplate(ctx.org.id, templateId);
  if (!t) return formError("Template not found.");

  try {
    assertTemplateTransition(t.status, "archived");
  } catch {
    return formError("This template is already archived.");
  }

  const tenant = await createClient();
  const { error, count } = await (templates(tenant) as unknown as UpdateChain)
    .update({ status: "archived" }, { count: "exact" })
    .eq("id", templateId)
    .eq("org_id", ctx.org.id)
    .eq("status", t.status);
  if (error || !count) {
    console.error("[asset-template] archive failed", error);
    return formError("Something went wrong — try again.");
  }

  await audit(user, "asset.template_archived", templateId, { from_status: t.status });
  return formSuccess({ redirectTo: `/assets/templates/${templateId}?saved=archived` });
}
