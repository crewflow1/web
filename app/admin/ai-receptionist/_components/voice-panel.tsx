import { createAdminClient } from "@/lib/supabase/admin";
import { readFailure, type SupabaseReadError } from "@/lib/supabase/read-failure";
import { voiceInboundFeatureEnabled } from "@/lib/telephony/config";
import { provisionPhoneNumber, setPhoneNumberActive } from "../actions";

/**
 * HQ voice-telephony panel (Wave 8) — phone_numbers provisioning (admin-write)
 * + a read-only calls / call_events viewer, scoped to ONE org.
 *
 * DARK-AWARE: when NEXT_PUBLIC_FEATURE_VOICE_INBOUND is off the whole feature is
 * dark, so this renders a "not configured" notice instead of the provisioning
 * controls. The routing rows can still be pre-provisioned (they carry no live
 * effect until the flag AND a provider credential are set), so provisioning is
 * shown even while dark — but the panel says so plainly.
 */

type NumberRow = {
  id: string;
  provider: string;
  e164: string;
  provider_number_sid: string | null;
  label: string | null;
  active: boolean;
  created_at: string;
};

type CallRow = {
  id: string;
  direction: string;
  status: string;
  caller_number: string | null;
  receiver_number: string | null;
  provider: string;
  started_at: string | null;
  created_at: string;
};

type EventRow = {
  id: string;
  call_id: string;
  event_type: string;
  provider_event_id: string | null;
  occurred_at: string;
};

export async function VoicePanel({ orgId, setupId }: { orgId: string; setupId: string }) {
  const enabled = voiceInboundFeatureEnabled();
  const admin = createAdminClient();

  const numbersRes = await (
    admin.from("phone_numbers" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          order: (
            c: string,
            o: { ascending: boolean },
          ) => Promise<{ data: NumberRow[] | null; error: SupabaseReadError | null }>;
        };
      };
    }
  )
    .select("id, provider, e164, provider_number_sid, label, active, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false });
  // Loud: a failed read must not render as an empty/healthy state.
  if (numbersRes.error) throw readFailure("voice panel: phone_numbers", numbersRes.error);
  const numbers = numbersRes.data ?? [];

  const callsRes = await (
    admin.from("calls" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          order: (
            c: string,
            o: { ascending: boolean },
          ) => {
            limit: (n: number) => Promise<{ data: CallRow[] | null; error: SupabaseReadError | null }>;
          };
        };
      };
    }
  )
    .select("id, direction, status, caller_number, receiver_number, provider, started_at, created_at")
    .eq("org_id", orgId)
    .order("created_at", { ascending: false })
    .limit(20);
  if (callsRes.error) throw readFailure("voice panel: calls", callsRes.error);
  const calls = callsRes.data ?? [];

  const eventsRes = await (
    admin.from("call_events" as never) as unknown as {
      select: (c: string) => {
        eq: (k: string, v: unknown) => {
          order: (
            c: string,
            o: { ascending: boolean },
          ) => {
            limit: (n: number) => Promise<{ data: EventRow[] | null; error: SupabaseReadError | null }>;
          };
        };
      };
    }
  )
    .select("id, call_id, event_type, provider_event_id, occurred_at")
    .eq("org_id", orgId)
    .order("occurred_at", { ascending: false })
    .limit(30);
  if (eventsRes.error) throw readFailure("voice panel: call_events", eventsRes.error);
  const events = eventsRes.data ?? [];

  return (
    <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-900">Voice telephony</h2>
        <span
          className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
            enabled ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"
          }`}
        >
          {enabled ? "Feature on" : "Not configured (dark)"}
        </span>
      </div>

      {!enabled ? (
        <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
          Inbound voice is dark: <code>NEXT_PUBLIC_FEATURE_VOICE_INBOUND</code> is off and no
          provider credential is set, so the webhooks 503 and no call is processed. Numbers may be
          pre-provisioned below; they carry no live effect until the feature is activated.
        </p>
      ) : null}

      {/* Routed numbers */}
      <div>
        <h3 className="text-sm font-semibold text-slate-800">Routed numbers</h3>
        {numbers.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">No numbers provisioned for this org.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
            {numbers.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <div>
                  <span className="font-mono text-slate-900">{n.e164}</span>
                  <span className="ml-2 text-xs text-slate-500">
                    {n.provider}
                    {n.label ? ` · ${n.label}` : ""}
                    {n.provider_number_sid ? " · provisioned" : " · no SID"}
                  </span>
                </div>
                <form action={setPhoneNumberActive} className="flex items-center gap-2">
                  <input type="hidden" name="setup_id" value={setupId} />
                  <input type="hidden" name="id" value={n.id} />
                  <input type="hidden" name="org_id" value={orgId} />
                  <input type="hidden" name="active" value={(!n.active).toString()} />
                  <span
                    className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                      n.active ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {n.active ? "Active" : "Inactive"}
                  </span>
                  <button
                    type="submit"
                    className="rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
                  >
                    {n.active ? "Deactivate" : "Activate"}
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Provision a new number */}
      <form action={provisionPhoneNumber} className="grid grid-cols-1 gap-2 sm:grid-cols-5">
        <input type="hidden" name="setup_id" value={setupId} />
        <input type="hidden" name="org_id" value={orgId} />
        <select name="provider" className="rounded-md border border-slate-300 px-2 py-1.5 text-sm" defaultValue="twilio">
          <option value="twilio">Twilio</option>
          <option value="vapi">Vapi</option>
        </select>
        <input
          name="e164"
          placeholder="+441234567890"
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm sm:col-span-1"
          required
        />
        <input
          name="provider_number_sid"
          placeholder="Provider SID"
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
        <input
          name="label"
          placeholder="Label (optional)"
          className="rounded-md border border-slate-300 px-2 py-1.5 text-sm"
        />
        <button
          type="submit"
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800"
        >
          Provision
        </button>
      </form>

      {/* Recent calls */}
      <div>
        <h3 className="text-sm font-semibold text-slate-800">Recent calls</h3>
        {calls.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">No calls recorded.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-xs">
              <thead className="text-left font-semibold text-slate-500">
                <tr>
                  <th className="px-2 py-1">When</th>
                  <th className="px-2 py-1">Dir</th>
                  <th className="px-2 py-1">Status</th>
                  <th className="px-2 py-1">Caller</th>
                  <th className="px-2 py-1">Dialed</th>
                  <th className="px-2 py-1">Provider</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {calls.map((c) => (
                  <tr key={c.id}>
                    <td className="px-2 py-1">{(c.started_at ?? c.created_at).slice(0, 16).replace("T", " ")}</td>
                    <td className="px-2 py-1">{c.direction}</td>
                    <td className="px-2 py-1">{c.status}</td>
                    <td className="px-2 py-1 font-mono">{c.caller_number ?? "—"}</td>
                    <td className="px-2 py-1 font-mono">{c.receiver_number ?? "—"}</td>
                    <td className="px-2 py-1">{c.provider}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent call events (append-only audit) */}
      <div>
        <h3 className="text-sm font-semibold text-slate-800">Recent call events</h3>
        {events.length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">No call events recorded.</p>
        ) : (
          <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
            {events.map((e) => (
              <li key={e.id} className="font-mono">
                {e.occurred_at.slice(0, 19).replace("T", " ")} · {e.event_type}
                {e.provider_event_id ? ` (${e.provider_event_id})` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
