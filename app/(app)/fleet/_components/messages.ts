/**
 * Fleet result copy. One map, imported by every fleet surface, so the same
 * failure never gets two different explanations on two different screens.
 *
 * Unknown codes fall through to the raw string (the actions forward a zod
 * message verbatim for field-level validation), so a new validation rule is
 * always readable to the user even before it gets an entry here.
 */

export const FLEET_ERRORS: Record<string, string> = {
  bad_id: "That vehicle reference isn't valid.",
  not_found: "That vehicle no longer exists, or isn't in the organisation you're working in.",
  forbidden: "Only an owner or admin can do that.",
  record_failed: "Couldn't save the vehicle. Nothing was changed.",
  delete_failed: "Couldn't remove that. Nothing was changed.",
  cross_org_reference:
    "That supplier or driver belongs to a different organisation, so it can't be linked here.",
  asset_disposed:
    "This asset is sold, retired or written off, so it can't be put back in service. Reactivate it from the asset register first.",
  bad_vin: "Check the VIN — it's 11 to 17 letters and digits, with no I, O or Q.",
  finance_incoherent:
    "Agreement details need a finance type. Pick one, or clear the provider, reference, payment and end date.",
  schedule_failed: "Couldn't save that renewal date. Nothing was changed.",
  completion_failed: "Couldn't record that. Nothing was changed.",
  case_frozen: "That record is already completed and can't be rewritten.",
  fuel_failed: "Couldn't save the fuel entry. Nothing was changed.",
  future_date: "That date is in the future — check the receipt.",
};

export const FLEET_SAVED: Record<string, string> = {
  created: "Vehicle added to the fleet.",
  updated: "Vehicle updated.",
  removed: "Vehicle profile removed. The asset and all its history are still in the asset register.",
  scheduled: "Renewal date saved.",
  schedule_stopped: "Stopped tracking that renewal. The history stays.",
  completed: "Recorded. The next due date has moved on.",
  fuel_logged: "Fuel entry saved.",
  fuel_deleted: "Fuel entry deleted.",
};

export function errorMessage(code: string | undefined): string | null {
  if (!code) return null;
  return FLEET_ERRORS[code] ?? code;
}

export function savedMessage(code: string | undefined): string | null {
  if (!code) return null;
  return FLEET_SAVED[code] ?? null;
}
