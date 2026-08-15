import "server-only";
import { createClient } from "@/lib/supabase/server";
import { readFailure } from "@/lib/supabase/read-failure";
import { fetchAllRows } from "@/lib/supabase/paginate";

/**
 * Server-only readers for job templates. ACTIVE-org pinned — RLS admits every
 * org a multi-org user belongs to, so the org pin is the real scope. Paged in
 * full so a large template library is never silently truncated at the PostgREST
 * cap (the F-1 picker-class rule), on a stable (name, id) order.
 */

export type JobTemplateOption = {
  id: string;
  name: string;
  job_type: string | null;
};

/** Active templates for the create-job picker. */
export async function listActiveJobTemplates(
  orgId: string,
): Promise<JobTemplateOption[]> {
  const supabase = await createClient();
  const { data, error } = await fetchAllRows<JobTemplateOption>((from, to) =>
    supabase
      .from("job_templates")
      .select("id, name, job_type")
      .eq("org_id", orgId)
      .eq("is_active", true)
      .order("name", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (error) throw readFailure("job templates: active list", error);
  return data ?? [];
}
