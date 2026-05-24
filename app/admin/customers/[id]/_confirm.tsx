"use client";

/**
 * Back-compat re-export. The canonical home for ClientConfirmForm is
 * now app/admin/_client-confirm.tsx so every HQ page can share it.
 * Existing imports under app/admin/customers/[id]/page.tsx keep
 * working unchanged.
 */
export { ClientConfirmForm } from "../../_client-confirm";
