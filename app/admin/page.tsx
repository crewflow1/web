import { redirect } from "next/navigation";

/**
 * /admin → /admin/overview. The layout enforces the super-admin gate
 * before this redirect runs, so non-allowlisted users still hit 404.
 */
export default function AdminIndex() {
  redirect("/admin/overview");
}
