"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import {
  authorEmployeeCapabilities,
  authorEmployeeMemoryScope,
} from "@/server/sdk/registry-authoring";
import { readEmployeeGrantTokens } from "@/server/sdk/registry-parity";
import {
  AI_EMPLOYEE_STATUSES,
  MEMORY_SCOPES,
  TASK_STATUSES,
} from "@/lib/ai-employees/model";

/**
 * AI Boardroom — server actions (CEO Directive 001, Phase 1).
 *
 * SAFE CONFIG ONLY. Operators can edit descriptive/operational config
 * (status, current task, system prompt, planned model strings, role,
 * description) and append task-history / memory entries.
 *
 * Capability AUTHORITY (the token SET and memory scope) is authored AT the
 * Capability Registry, never written direct to the legacy model (Directive
 * #015 / D-05, LR1 + LR2 — the Mirror Integrity Rule): see
 * authorAiEmployeeCapabilities / authorAiEmployeeMemoryScope below.
 *
 * Deliberately NOT exposed: anything that would grant execution. The
 * `permissions.can_execute` flag is never written here — it stays at
 * its locked-down seeded value and renders read-only in the UI. There
 * is no "run", "connect provider", or "execute" action in Phase 1.
 *
 * Gating: every action re-checks isSuperAdminEmail. The /admin/* layout
 * already 404s non-allowlisted users; this is defence-in-depth against
 * a stolen-cookie attempt that reaches an action URL directly.
 */

async function requireAdmin(): Promise<{ id: string; email: string }> {
  const user = await requireUser();
  if (!isSuperAdminEmail(user.email)) redirect("/dashboard");
  return { id: user.id, email: user.email ?? "" };
}

const SLUG_RE = /^[a-z0-9-]{1,60}$/;
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .or(z.literal("").transform(() => null));

// --------------------------------------------------------------------
// Update configuration (safe fields only)
// --------------------------------------------------------------------

// memory_scope is DELIBERATELY absent: it is capability authority, authored at the
// registry via authorAiEmployeeMemoryScope (Directive #015 / D-05, LR2 — the Mirror
// Integrity Rule). This action writes descriptive/operational fields only.
const configSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().regex(SLUG_RE),
  status: z.enum(AI_EMPLOYEE_STATUSES),
  role: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000).optional().or(z.literal("")),
  system_prompt: z.string().trim().max(20_000).optional().or(z.literal("")),
  model_provider: optionalText(60),
  model_name: optionalText(120),
  current_task: optionalText(500),
});

export async function updateAiEmployeeConfig(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = configSchema.safeParse({
    id: formData.get("id"),
    slug: formData.get("slug"),
    status: formData.get("status"),
    role: formData.get("role"),
    description: formData.get("description") ?? "",
    system_prompt: formData.get("system_prompt") ?? "",
    model_provider: formData.get("model_provider") ?? "",
    model_name: formData.get("model_name") ?? "",
    current_task: formData.get("current_task") ?? "",
  });
  if (!parsed.success) {
    redirect(
      `/admin/ai-boardroom?error=${encodeURIComponent("Invalid configuration input")}`,
    );
  }

  const d = parsed.data;
  const supabase = createAdminClient();

  // Pull previous status so the audit entry can carry old → new.
  const { data: prev } = await supabase
    .from("ai_employees" as never)
    .select("status")
    .eq("id", d.id)
    .maybeSingle();
  const prevRow = prev as unknown as {
    status: string | null;
  } | null;

  const { error } = await supabase
    .from("ai_employees" as never)
    .update({
      status: d.status,
      role: d.role,
      description: d.description ?? "",
      system_prompt: d.system_prompt ?? "",
      model_provider: d.model_provider ?? null,
      model_name: d.model_name ?? null,
      current_task: d.current_task ?? null,
    } as never)
    .eq("id", d.id);
  if (error) {
    console.error("[ai-boardroom] updateAiEmployeeConfig failed", error);
    redirect(
      `/admin/ai-boardroom/${d.slug}?error=${encodeURIComponent("Couldn't save — try again.")}`,
    );
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "ai_employee.config_updated",
    targetTable: "ai_employees",
    targetId: d.id,
    metadata: {
      status_from: prevRow?.status ?? null,
      status_to: d.status,
    },
  });

  revalidatePath(`/admin/ai-boardroom/${d.slug}`);
  revalidatePath("/admin/ai-boardroom");
  redirect(`/admin/ai-boardroom/${d.slug}?saved=config`);
}

// --------------------------------------------------------------------
// Retire (terminal) — the only admitted exit from the roster
// --------------------------------------------------------------------
//
// Retirement is NOT a status edit, so it is deliberately absent from the
// configSchema status enum: it is a one-way admin action. The database trigger
// (migration 20261222000000) is the authority — only disabled → retired is
// admitted, and a retired row refuses every later update and delete. This
// action re-states the precondition for a friendly message, then lets the
// trigger be the enforcement.

const retireSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().regex(SLUG_RE),
});

export async function retireAiEmployee(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = retireSchema.safeParse({
    id: formData.get("id"),
    slug: formData.get("slug"),
  });
  if (!parsed.success) {
    redirect(
      `/admin/ai-boardroom?error=${encodeURIComponent("Invalid retire input")}`,
    );
  }

  const d = parsed.data;
  const supabase = createAdminClient();

  const { data: prev } = await supabase
    .from("ai_employees" as never)
    .select("status")
    .eq("id", d.id)
    .maybeSingle();
  const prevStatus = (prev as unknown as { status: string | null } | null)?.status ?? null;
  if (prevStatus !== "disabled") {
    redirect(
      `/admin/ai-boardroom/${d.slug}?error=${encodeURIComponent(
        "Only a disabled employee can be retired — disable it first.",
      )}`,
    );
  }

  // The trigger stamps retired_at and refuses anything but disabled → retired.
  const { error } = await supabase
    .from("ai_employees" as never)
    .update({ status: "retired" } as never)
    .eq("id", d.id)
    .eq("status", "disabled");
  if (error) {
    console.error("[ai-boardroom] retireAiEmployee failed", error);
    redirect(
      `/admin/ai-boardroom/${d.slug}?error=${encodeURIComponent("Couldn't retire — try again.")}`,
    );
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "ai_employee.retired",
    targetTable: "ai_employees",
    targetId: d.id,
    metadata: { status_from: prevStatus, status_to: "retired" },
  });

  revalidatePath(`/admin/ai-boardroom/${d.slug}`);
  revalidatePath("/admin/ai-boardroom");
  redirect(`/admin/ai-boardroom/${d.slug}?saved=retired`);
}

// --------------------------------------------------------------------
// Append a task-history entry (manual, descriptive — no execution)
// --------------------------------------------------------------------

const taskSchema = z.object({
  ai_employee_id: z.string().uuid(),
  slug: z.string().regex(SLUG_RE),
  title: z.string().trim().min(1).max(300),
  status: z.enum(TASK_STATUSES),
  summary: optionalText(8000),
});

export async function addAiEmployeeTask(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = taskSchema.safeParse({
    ai_employee_id: formData.get("ai_employee_id"),
    slug: formData.get("slug"),
    title: formData.get("title"),
    status: formData.get("status"),
    summary: formData.get("summary") ?? "",
  });
  if (!parsed.success) {
    redirect(
      `/admin/ai-boardroom?error=${encodeURIComponent("Invalid task input")}`,
    );
  }

  const d = parsed.data;
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  const completedAt =
    d.status === "completed" || d.status === "cancelled" || d.status === "failed"
      ? now
      : null;

  const { error } = await supabase.from("ai_employee_tasks" as never).insert({
    ai_employee_id: d.ai_employee_id,
    title: d.title,
    status: d.status,
    summary: d.summary ?? null,
    created_by_id: admin.id,
    created_by_email: admin.email,
    completed_at: completedAt,
  } as never);
  if (error) {
    console.error("[ai-boardroom] addAiEmployeeTask failed", error);
    redirect(
      `/admin/ai-boardroom/${d.slug}?error=${encodeURIComponent("Couldn't log task.")}`,
    );
  }

  // Stamp the employee's last activity so the roster feels live.
  await supabase
    .from("ai_employees" as never)
    .update({ last_activity_at: now } as never)
    .eq("id", d.ai_employee_id);

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "ai_employee.task_logged",
    targetTable: "ai_employees",
    targetId: d.ai_employee_id,
    metadata: { title: d.title, status: d.status },
  });

  revalidatePath(`/admin/ai-boardroom/${d.slug}`);
  redirect(`/admin/ai-boardroom/${d.slug}?saved=task`);
}

// --------------------------------------------------------------------
// Append a memory entry (manual, descriptive)
// --------------------------------------------------------------------

const memorySchema = z.object({
  ai_employee_id: z.string().uuid(),
  slug: z.string().regex(SLUG_RE),
  scope: z.enum(MEMORY_SCOPES),
  mem_key: optionalText(200),
  content: z.string().trim().min(1).max(20_000),
});

export async function addAiEmployeeMemory(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const parsed = memorySchema.safeParse({
    ai_employee_id: formData.get("ai_employee_id"),
    slug: formData.get("slug"),
    scope: formData.get("scope"),
    mem_key: formData.get("mem_key") ?? "",
    content: formData.get("content"),
  });
  if (!parsed.success) {
    redirect(
      `/admin/ai-boardroom?error=${encodeURIComponent("Invalid memory input")}`,
    );
  }

  const d = parsed.data;
  const supabase = createAdminClient();

  const { error } = await supabase.from("ai_employee_memory" as never).insert({
    ai_employee_id: d.ai_employee_id,
    scope: d.scope,
    mem_key: d.mem_key ?? null,
    content: d.content,
  } as never);
  if (error) {
    console.error("[ai-boardroom] addAiEmployeeMemory failed", error);
    redirect(
      `/admin/ai-boardroom/${d.slug}?error=${encodeURIComponent("Couldn't save memory.")}`,
    );
  }

  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "ai_employee.memory_added",
    targetTable: "ai_employees",
    targetId: d.ai_employee_id,
    metadata: { scope: d.scope, key: d.mem_key ?? null },
  });

  revalidatePath(`/admin/ai-boardroom/${d.slug}`);
  redirect(`/admin/ai-boardroom/${d.slug}?saved=memory`);
}

// --------------------------------------------------------------------
// Author capabilities — registry-native authoring (Directive #015 / D-05, LR1; reads LR5.2)
// --------------------------------------------------------------------
//
// The token SET only. Authority is authored AT the Capability Registry through the
// atomic SECURITY DEFINER RPC (server/sdk/registry-authoring.ts), which defines new
// tokens and upserts the employee-scoped grant (tokens only). The legacy ai_employees
// mirror is RETIRED (LR5.1 — tools_allowed / permissions are inert), so authoring no longer
// writes it, and the audit's before-snapshot now reads the registry grant rather than the
// inert columns (LR5.2 — the Read Migration Rule). Posture (`can_execute`) is deliberately
// NOT touched here — the execution lock stays where the model has it (Directive 001), exactly
// as updateAiEmployeeConfig.

// The catalogue token shape (hq_capabilities.token): lowercase segments joined by
// a single '.', '_' or '-'. Validated here for a clean message; the RPC + the table
// constraint are the hard backstops.
const TOKEN_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

const capabilitiesSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().regex(SLUG_RE),
  tokens: z.array(z.string().regex(TOKEN_RE).max(120)).max(200),
});

export async function authorAiEmployeeCapabilities(formData: FormData): Promise<void> {
  const admin = await requireAdmin();

  // Accept tokens as a free-text field (comma / whitespace separated), normalised
  // to a lowercase sorted-distinct set — the forgiving shape a paste-in editor wants.
  const rawTokens = String(formData.get("tokens") ?? "");
  const tokens = Array.from(
    new Set(
      rawTokens
        .split(/[\s,]+/)
        .map((t) => t.trim().toLowerCase())
        .filter((t) => t.length > 0),
    ),
  ).sort();

  const parsed = capabilitiesSchema.safeParse({
    id: formData.get("id"),
    slug: formData.get("slug"),
    tokens,
  });
  if (!parsed.success) {
    redirect(
      `/admin/ai-boardroom?error=${encodeURIComponent(
        "Invalid capability tokens — use lowercase letters, digits and . _ - only.",
      )}`,
    );
  }

  const d = parsed.data;

  // Snapshot the employee grant's CURRENT token set BEFORE authoring so the audit entry
  // carries before → after (the immutable admin_activity_log is the audit trail). Read from
  // the AUTHORITATIVE registry grant — NOT the now-inert legacy columns LR5.1 froze
  // (Directive #015 / D-05, LR5.2 — the Read Migration Rule). before/after are then symmetric:
  // both the employee-scoped token set the authoring RPC replaces.
  const beforeTokens = await readEmployeeGrantTokens(d.slug);

  const result = await authorEmployeeCapabilities({
    slug: d.slug,
    tokens: d.tokens,
    actorId: admin.id,
    actorEmail: admin.email,
  });

  if (!result.ok) {
    const message =
      result.reason === "invalid_token"
        ? `Unknown or malformed token: ${result.token}`
        : result.reason === "unknown_employee"
          ? "Employee not found."
          : "Couldn't save capabilities — try again.";
    console.error("[ai-boardroom] authorAiEmployeeCapabilities failed", result);
    redirect(`/admin/ai-boardroom/${d.slug}?error=${encodeURIComponent(message)}`);
  }

  // `redirect` above returns `never`, so `result` is narrowed to the ok variant here.
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "ai_employee.capabilities_authored",
    targetTable: "ai_employees",
    targetId: d.id,
    metadata: {
      grant_action: result.action,
      tokens_before: beforeTokens,
      tokens_after: result.tokens,
      tools_allowed: result.toolsAllowed,
      scopes: result.scopes,
    },
  });

  revalidatePath(`/admin/ai-boardroom/${d.slug}`);
  revalidatePath("/admin/ai-boardroom");
  redirect(`/admin/ai-boardroom/${d.slug}?saved=capabilities`);
}

// --------------------------------------------------------------------
// Author memory scope — registry-native authoring (Directive #015 / D-05, LR2)
// --------------------------------------------------------------------
//
// The memory scope only. Authority is authored AT the Capability Registry through the
// atomic SECURITY DEFINER RPC (server/sdk/registry-authoring.ts), which upserts the
// employee-scoped grant (memory_scope only — tokens + posture preserved) and mirrors
// the new value to the retained legacy ai_employees.memory_scope column in ONE
// transaction. This CLOSES the last direct legacy authoring path — memory_scope used to
// be written straight to the legacy column by updateAiEmployeeConfig, which left the
// registry grant to drift. The derived legacy column is now never edited directly (the
// Mirror Integrity Rule). Posture (`can_execute`) is deliberately NOT touched here.

const memoryScopeSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().regex(SLUG_RE),
  memory_scope: z.enum(MEMORY_SCOPES),
});

export async function authorAiEmployeeMemoryScope(formData: FormData): Promise<void> {
  const admin = await requireAdmin();

  const parsed = memoryScopeSchema.safeParse({
    id: formData.get("id"),
    slug: formData.get("slug"),
    memory_scope: formData.get("memory_scope"),
  });
  if (!parsed.success) {
    redirect(
      `/admin/ai-boardroom?error=${encodeURIComponent("Invalid memory scope.")}`,
    );
  }

  const d = parsed.data;
  const supabase = createAdminClient();

  // Snapshot the legacy memory scope BEFORE authoring so the audit entry carries
  // before → after (the immutable admin_activity_log is the LR2 audit trail).
  const { data: prev } = await supabase
    .from("ai_employees" as never)
    .select("memory_scope")
    .eq("id", d.id)
    .maybeSingle();
  const prevRow = prev as unknown as { memory_scope: string | null } | null;

  const result = await authorEmployeeMemoryScope({
    slug: d.slug,
    memoryScope: d.memory_scope,
    actorId: admin.id,
    actorEmail: admin.email,
  });

  if (!result.ok) {
    const message =
      result.reason === "invalid_memory_scope"
        ? `Invalid memory scope: ${result.memoryScope}`
        : result.reason === "unknown_employee"
          ? "Employee not found."
          : "Couldn't save memory scope — try again.";
    console.error("[ai-boardroom] authorAiEmployeeMemoryScope failed", result);
    redirect(`/admin/ai-boardroom/${d.slug}?error=${encodeURIComponent(message)}`);
  }

  // `redirect` above returns `never`, so `result` is narrowed to the ok variant here.
  await recordAdminActivity({
    actorId: admin.id,
    actorEmail: admin.email,
    action: "ai_employee.memory_scope_authored",
    targetTable: "ai_employees",
    targetId: d.id,
    metadata: {
      grant_action: result.action,
      memory_scope_from: prevRow?.memory_scope ?? null,
      memory_scope_to: result.memoryScope,
    },
  });

  revalidatePath(`/admin/ai-boardroom/${d.slug}`);
  revalidatePath("/admin/ai-boardroom");
  redirect(`/admin/ai-boardroom/${d.slug}?saved=memory_scope`);
}
