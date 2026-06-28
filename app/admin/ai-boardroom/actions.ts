"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/server/auth/session";
import { isSuperAdminEmail } from "@/server/auth/superadmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { recordAdminActivity } from "@/server/services/hq-audit";
import { authorEmployeeCapabilities } from "@/server/sdk/registry-authoring";
import {
  AI_EMPLOYEE_STATUSES,
  MEMORY_SCOPES,
  TASK_STATUSES,
} from "@/lib/ai-employees/model";

/**
 * AI Boardroom — server actions (CEO Directive 001, Phase 1).
 *
 * SAFE CONFIG ONLY. Operators can edit descriptive/operational config
 * (status, current task, system prompt, planned model strings, memory
 * scope, role, description) and append task-history / memory entries.
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

const configSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().regex(SLUG_RE),
  status: z.enum(AI_EMPLOYEE_STATUSES),
  memory_scope: z.enum(MEMORY_SCOPES),
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
    memory_scope: formData.get("memory_scope"),
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
    .select("status, memory_scope")
    .eq("id", d.id)
    .maybeSingle();
  const prevRow = prev as unknown as {
    status: string | null;
    memory_scope: string | null;
  } | null;

  const { error } = await supabase
    .from("ai_employees" as never)
    .update({
      status: d.status,
      memory_scope: d.memory_scope,
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
      memory_scope_from: prevRow?.memory_scope ?? null,
      memory_scope_to: d.memory_scope,
    },
  });

  revalidatePath(`/admin/ai-boardroom/${d.slug}`);
  revalidatePath("/admin/ai-boardroom");
  redirect(`/admin/ai-boardroom/${d.slug}?saved=config`);
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
// Author capabilities — registry-native authoring (Directive #015 / D-05, LR1)
// --------------------------------------------------------------------
//
// The token SET only. Authority is authored AT the Capability Registry through the
// atomic SECURITY DEFINER RPC (server/sdk/registry-authoring.ts), which defines new
// tokens, upserts the employee-scoped grant, and mirrors the parity-faithful split
// back to the retained legacy ai_employees columns in ONE transaction. Posture
// (`can_execute`) is deliberately NOT touched here — the execution lock stays where
// the legacy model has it (Directive 001), exactly as updateAiEmployeeConfig.

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
  const supabase = createAdminClient();

  // Snapshot the legacy token set BEFORE authoring so the audit entry carries
  // before → after (the immutable admin_activity_log is the LR1 audit trail).
  const { data: prev } = await supabase
    .from("ai_employees" as never)
    .select("tools_allowed, permissions")
    .eq("id", d.id)
    .maybeSingle();
  const prevRow = prev as unknown as {
    tools_allowed: string[] | null;
    permissions: { scopes?: string[] | null } | null;
  } | null;
  const beforeTokens = Array.from(
    new Set([...(prevRow?.tools_allowed ?? []), ...(prevRow?.permissions?.scopes ?? [])]),
  ).sort();

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
