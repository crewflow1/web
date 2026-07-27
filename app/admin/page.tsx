import { redirect } from "next/navigation";

/**
 * /admin → /admin/command-centre, the live executive control centre
 * (CEO Directive 004, Phase 2). The layout enforces the super-admin gate
 * before this redirect runs, so non-allowlisted users still hit 404.
 */
export default function AdminIndex() {
  redirect("/admin/command-centre");
}
