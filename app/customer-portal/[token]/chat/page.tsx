import { createAdminClient } from "@/lib/supabase/admin";
import { loadCustomerByPortalToken } from "../../_helpers";
import { readPortalChatMessages } from "./_chat-reads";
import { PortalShell } from "../_shell";
import { ChatPanel } from "./_chat-panel";
import { InvalidLinkPage } from "@/app/_components/invalid-link";

export const metadata = { title: "Chat · CrewFlow" };

/**
 * MP Phase 8 "Live Chat" — the customer portal chat tab.
 *
 * Loads the token-authenticated customer (the ONE authority → InvalidLinkPage on
 * a bad/expired token), reads their OWN chat thread (customer-safe, paged, org +
 * customer pinned in _chat-reads), and renders the client panel. The panel then
 * tails staff replies by honest polling of ./poll. Delivery is IN-APP: a message
 * is a row; there is no external transport.
 */

type SP = Promise<{ sent?: string; error?: string }>;

export default async function PortalChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: SP;
}) {
  const { token } = await params;
  const sp = await searchParams;
  const loaded = await loadCustomerByPortalToken(token);
  if (!loaded) return <InvalidLinkPage kind="portal" />;
  const { customer, org } = loaded;

  const admin = createAdminClient();
  const messages = await readPortalChatMessages(admin, {
    orgId: customer.org_id,
    customerId: customer.id,
  });

  // Error CODES only through an allowlist — forged query text can never render.
  const banner = (() => {
    if (sp.sent) return null; // the sent message is already in the thread below
    const errors: Record<string, string> = {
      invalid_token: "This link is not valid.",
      rate_limited: "Too many messages — please wait a minute and try again.",
      invalid_input: "Please enter a message and try again.",
      could_not_send: "Something went wrong sending your message. Please try again.",
    };
    if (sp.error)
      return errors[sp.error] ?? "Something went wrong. Please try again.";
    return null;
  })();

  return (
    <PortalShell customer={customer} org={org} token={token} active="chat">
      <header className="space-y-1">
        <h2 className="text-xl font-bold text-slate-900">Chat with {org.name}</h2>
        <p className="text-sm text-slate-600">
          Send a message and a team member will reply here. Replies appear
          automatically.
        </p>
      </header>

      {banner ? (
        <div
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900"
        >
          {banner}
        </div>
      ) : null}

      <ChatPanel token={token} orgName={org.name} initialMessages={messages} />
    </PortalShell>
  );
}
