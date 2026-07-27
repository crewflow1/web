import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { gatherExecutiveInput } from "@/server/services/hq-executive";
import { countOpenSupportTicketsForHq } from "@/server/services/hq-support-snapshot";
import { listAiEmployees } from "@/server/services/ai-employees";
import { getLearningCounts } from "@/server/services/hq-sales";
import { assembleCeoBoard, type CeoBoard } from "@/lib/hq/ceo";

/**
 * CrewFlow HQ — CEO Dashboard aggregator (CEO Directive 004, Phase 8).
 * Service-role only.
 *
 * Gathers the whole company in one parallel batch and hands the raw numbers
 * to the pure `assembleCeoBoard` (lib/hq/ceo.ts), keeping this layer a thin
 * shim. It reuses `gatherExecutiveInput` — the exact same bounded reads that
 * power the Phase 2 control centre — so the two dashboards never drift, then
 * adds the three departments the executive view never covered:
 *
 *   - Support  — open ticket count (cheap COUNT head)
 *   - AI       — the employed roster (active = not "disabled") + headcount
 *   - Learning — total / active / promoted pattern counts (cheap COUNT heads)
 *
 * Every query is bounded or COUNT(head), so the board scales without loading
 * the world.
 */

export type CeoDashboard = {
  board: CeoBoard;
  generatedAt: string;
};

export async function getCeoDashboard(): Promise<CeoDashboard> {
  const admin = createAdminClient();

  const [execInput, openSupportTickets, employees, learnings] =
    await Promise.all([
      gatherExecutiveInput(admin),
      countOpenSupportTicketsForHq(),
      listAiEmployees(),
      getLearningCounts(),
    ]);

  const aiEmployeesActive = employees.filter(
    (e) => e.status !== "disabled",
  ).length;

  const board = assembleCeoBoard({
    ...execInput,
    openSupportTickets,
    aiEmployeesActive,
    aiEmployeesTotal: employees.length,
    learningsTotal: learnings.total,
    learningsActive: learnings.active,
    learningsPromoted: learnings.promoted,
  });

  return { board, generatedAt: new Date().toISOString() };
}
