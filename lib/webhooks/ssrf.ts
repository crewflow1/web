import "server-only";
import { lookup as dnsLookup } from "node:dns/promises";
import https from "node:https";
import type { LookupAddress } from "node:dns";
import { env } from "@/lib/env";

/**
 * Outbound-webhook SSRF policy (Train A) — the hard boundary.
 *
 * This EXTENDS the research-fetch SSRF baseline (server/services/research-fetch.ts:
 * http(s) scheme allowlist, isPrivateHost blocking RFC-1918 / link-local /
 * loopback, post-redirect re-check, body cap, timeout) and tightens it for
 * arbitrary tenant-supplied delivery URLs. The invariants, each pinned by the
 * security suite:
 *
 *   • HTTPS ONLY — http would leak the signed payload. (DB CHECK + here.)
 *   • NO IP LITERALS — v4 AND v6. A webhook target is a DNS name, never a raw IP,
 *     so an operator cannot point us straight at an internal address.
 *   • NO no-dot hosts, NO .local / .internal / .localhost, NO the platform's own
 *     hostnames (crewflow.uk, the app/supabase origins, *.vercel.app).
 *   • FULL private-range blocking, IPv4 AND IPv6: loopback, RFC-1918, link-local
 *     (169.254/16, fe80::/10), ULA (fc00::/7), v4-mapped v6 (::ffff:a.b.c.d),
 *     unspecified, multicast/reserved.
 *   • DNS RE-RESOLUTION PINNING (rebind defence): at dispatch we resolve the host
 *     to EVERY address, reject if ANY is private, then connect to the VETTED IP
 *     via an undici Agent whose custom lookup returns exactly those addresses — so
 *     the address we checked IS the address we connect to. A DNS record that flips
 *     to a private IP between the check and the connect cannot be reached.
 *   • REDIRECT REFUSAL — redirect:"manual"; any 3xx is a failure (a redirect is a
 *     second, unvetted URL).
 *   • 10s timeout; response body capped (~4KB) for the delivery log; only 2xx is
 *     success.
 *
 * The classification functions are PURE (no network) so the table-driven fuzz can
 * exercise every RFC-1918 / link-local / ULA / v4-mapped / IP-literal / no-dot /
 * .internal case directly. Only {@link safeWebhookFetch} touches the network.
 */

export const WEBHOOK_FETCH_TIMEOUT_MS = 10_000;
export const WEBHOOK_MAX_BODY_BYTES = 4_096;

export type SsrfReason =
  | "invalid-url"
  | "not-https"
  | "ip-literal"
  | "no-dot-host"
  | "internal-tld"
  | "platform-host"
  | "private-host"
  | "dns-failed"
  | "dns-private";

export class WebhookUrlError extends Error {
  reason: SsrfReason;
  constructor(reason: SsrfReason, message?: string) {
    super(message ?? reason);
    this.name = "WebhookUrlError";
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// IP classification — pure.
// ---------------------------------------------------------------------------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Is a dotted IPv4 string a private / loopback / link-local / reserved address? */
export function isPrivateIpv4(host: string): boolean {
  const m = IPV4_RE.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return true; // malformed ⇒ reject
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // RFC-1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC-1918
  if (a === 192 && b === 168) return true; // RFC-1918
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 192 && b === 0) return true; // 192.0.0/24 + 192.0.2/24 (test-net)
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** Strip a zone id and surrounding brackets from an IPv6 literal. */
function normaliseIpv6(host: string): string {
  return host.replace(/^\[/, "").replace(/\]$/, "").split("%")[0]!.toLowerCase();
}

/** Is a string a plausible IPv6 literal? (contains ':' and only hex/':'/'.') */
export function looksLikeIpv6(host: string): boolean {
  const h = normaliseIpv6(host);
  return h.includes(":") && /^[0-9a-f:.]+$/.test(h);
}

/**
 * Is an IPv6 address private / loopback / link-local / ULA / v4-mapped-private /
 * unspecified / multicast? Conservative: an address it cannot confidently clear
 * (including a mangled v4-mapped form) is treated as private.
 */
export function isPrivateIpv6(host: string): boolean {
  if (!looksLikeIpv6(host)) return false;
  const h = normaliseIpv6(host);

  if (h === "::1") return true; // loopback
  if (h === "::" || h === "::0") return true; // unspecified

  // v4-mapped (::ffff:a.b.c.d or ::ffff:xxxx:xxxx) → apply the v4 rules.
  const mappedIdx = h.indexOf("::ffff:");
  if (mappedIdx === 0) {
    const tail = h.slice("::ffff:".length);
    if (IPV4_RE.test(tail)) return isPrivateIpv4(tail);
    // hex form, e.g. ::ffff:7f00:1 → 127.0.0.1
    const groups = tail.split(":").filter(Boolean);
    if (groups.length === 2) {
      const hi = parseInt(groups[0]!, 16);
      const lo = parseInt(groups[1]!, 16);
      if (Number.isFinite(hi) && Number.isFinite(lo)) {
        const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
        return isPrivateIpv4(v4);
      }
    }
    return true; // unparseable mapped form ⇒ reject
  }

  // Prefix-based ranges.
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // fc00::/7 ULA
  if (h.startsWith("fec") || h.startsWith("fed") || h.startsWith("fee") || h.startsWith("fef")) {
    return true; // fec0::/10 site-local (deprecated)
  }
  if (h.startsWith("ff")) return true; // ff00::/8 multicast
  return false;
}

/** True iff `host` is a bare IPv4 or IPv6 literal (any form). */
export function isIpLiteral(host: string): boolean {
  return IPV4_RE.test(host) || looksLikeIpv6(host);
}

/**
 * Canonicalise a hostname before any policy check: lowercase, strip surrounding
 * IPv6 brackets, and strip a SINGLE trailing dot (the FQDN root label). Without
 * the trailing-dot strip, `crewflow.uk.` and `svc.internal.` slip past endsWith
 * checks — and `crewflow.uk.` resolves to the platform's own PUBLIC IP, which the
 * dns-private recheck would NOT catch. Every host check normalises first.
 */
export function normaliseHost(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
}

/**
 * A host that is really a numeric IP in disguise — a short-form (127.1), all-
 * decimal integer (2130706433), or hex/octal-labelled address (0x7f.0x0.0x0.0x1,
 * 0177.0.0.1). getaddrinfo happily resolves these to loopback/RFC-1918 at
 * dispatch, so the at-rest validator MUST refuse them too (they are never valid
 * public DNS names). Rule: a real webhook host ends in an ALPHABETIC TLD and
 * carries no 0x-hex label.
 */
export function isNumericHostForm(hostname: string): boolean {
  const h = normaliseHost(hostname);
  if (!h) return false;
  const labels = h.split(".");
  if (labels.some((l) => /^0x[0-9a-f]+$/i.test(l))) return true; // hex label
  const last = labels[labels.length - 1] ?? "";
  if (/^\d+$/.test(last)) return true; // numeric TLD / bare integer / short-form IP
  return false;
}

/**
 * The private/loopback/link-local/internal classification for a hostname or IP —
 * the research-fetch isPrivateHost, extended to full IPv6. Pure.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = normaliseHost(hostname);
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (isPrivateIpv4(h)) return true;
  if (isPrivateIpv6(h)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Platform-host denylist.
// ---------------------------------------------------------------------------

function platformHosts(): Set<string> {
  const hosts = new Set<string>(["crewflow.uk"]);
  for (const raw of [env.NEXT_PUBLIC_APP_URL, env.NEXT_PUBLIC_SUPABASE_URL]) {
    try {
      hosts.add(new URL(raw).hostname.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return hosts;
}

/** Is the host one of the platform's own hostnames (self-callback / SSRF-to-self)? */
export function isForbiddenPlatformHost(hostname: string): boolean {
  const h = normaliseHost(hostname);
  if (h.endsWith(".vercel.app")) return true;
  if (h === "crewflow.uk" || h.endsWith(".crewflow.uk")) return true;
  for (const p of platformHosts()) {
    if (h === p || h.endsWith(`.${p}`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// URL validation — pure (no DNS). Throws WebhookUrlError with a reason.
// ---------------------------------------------------------------------------

/**
 * Validate a tenant-supplied webhook URL at rest (create/edit) and again before
 * every dispatch. Returns the parsed URL or throws {@link WebhookUrlError}.
 */
export function assertPublicWebhookUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new WebhookUrlError("invalid-url", "not a valid URL");
  }
  if (u.protocol !== "https:") {
    throw new WebhookUrlError("not-https", "webhook URLs must be https");
  }
  const host = normaliseHost(u.hostname);
  if (isIpLiteral(host) || isNumericHostForm(host)) {
    throw new WebhookUrlError("ip-literal", "webhook URLs must use a DNS hostname, not an IP");
  }
  if (!host.includes(".")) {
    throw new WebhookUrlError("no-dot-host", "webhook host must be a fully-qualified domain");
  }
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) {
    throw new WebhookUrlError("internal-tld", "internal TLDs are not deliverable");
  }
  if (isForbiddenPlatformHost(host)) {
    throw new WebhookUrlError("platform-host", "cannot target a CrewFlow-owned host");
  }
  if (isPrivateHost(host)) {
    throw new WebhookUrlError("private-host", "host resolves to a private range");
  }
  return u;
}

/** Non-throwing shape for the settings action / validators. */
export function validateWebhookUrl(
  raw: string,
): { ok: true; url: string } | { ok: false; reason: SsrfReason } {
  try {
    const u = assertPublicWebhookUrl(raw);
    return { ok: true, url: u.toString() };
  } catch (e) {
    if (e instanceof WebhookUrlError) return { ok: false, reason: e.reason };
    return { ok: false, reason: "invalid-url" };
  }
}

// ---------------------------------------------------------------------------
// The vetted fetch — DNS-pinned, redirect-refusing, capped.
// ---------------------------------------------------------------------------

export type SafeFetchResult = {
  ok: boolean; // strictly a 2xx
  status: number;
  body: string; // capped snippet, for the delivery log
  error: string | null;
};

/**
 * A dns.lookup-compatible function pinned to the pre-vetted addresses. net/tls
 * call this during connect; we ignore the hostname and hand back the addresses we
 * already resolved AND vetted, so the connected address is provably the checked
 * address (closes DNS rebinding). SNI + Host header stay the original hostname.
 */
function pinnedLookup(vetted: LookupAddress[]) {
  return (
    _hostname: string,
    options: { all?: boolean } | ((err: Error | null, address: string, family: number) => void),
    callback?: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
  ): void => {
    // net.connect may call lookup(hostname, callback) or lookup(hostname, options, callback).
    const opts = typeof options === "function" ? {} : options;
    const cb = (typeof options === "function" ? options : callback) as (
      err: Error | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void;
    if (opts && opts.all) {
      cb(null, vetted);
    } else {
      const first = vetted[0]!;
      cb(null, first.address, first.family);
    }
  };
}

/**
 * POST a signed webhook body to a vetted, DNS-pinned target. This is the ONLY
 * function in lib/webhooks that performs network egress, and it does so only
 * after {@link assertPublicWebhookUrl} AND a full re-resolution check.
 *
 * Built on node:https (not fetch) so we can pin the connect address via a custom
 * `lookup` with no extra dependency, and because a raw request never auto-follows
 * redirects — a 3xx is simply returned and refused. `agent: false` forces a fresh
 * connection that honours our per-request lookup.
 */
export async function safeWebhookFetch(
  rawUrl: string,
  init: { body: string; headers: Record<string, string> },
): Promise<SafeFetchResult> {
  let url: URL;
  try {
    url = assertPublicWebhookUrl(rawUrl);
  } catch (e) {
    const reason = e instanceof WebhookUrlError ? e.reason : "invalid-url";
    return { ok: false, status: 0, body: "", error: `blocked:${reason}` };
  }

  // Re-resolve at dispatch and vet EVERY address (rebind defence).
  let resolved: LookupAddress[];
  try {
    resolved = await dnsLookup(url.hostname, { all: true });
  } catch {
    return { ok: false, status: 0, body: "", error: "blocked:dns-failed" };
  }
  if (resolved.length === 0) {
    return { ok: false, status: 0, body: "", error: "blocked:dns-failed" };
  }
  for (const addr of resolved) {
    if (isPrivateHost(addr.address)) {
      return { ok: false, status: 0, body: "", error: "blocked:dns-private" };
    }
  }

  const bodyBuf = Buffer.from(init.body, "utf8");
  return new Promise<SafeFetchResult>((resolve) => {
    let settled = false;
    const done = (r: SafeFetchResult) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };

    const req = https.request(
      {
        protocol: "https:",
        hostname: url.hostname,
        servername: url.hostname, // SNI stays the hostname
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        agent: false, // fresh connection so our lookup is honoured
        lookup: pinnedLookup(resolved),
        timeout: WEBHOOK_FETCH_TIMEOUT_MS,
        headers: {
          host: url.host,
          "content-type": "application/json",
          "content-length": bodyBuf.length,
          ...init.headers,
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        // A raw request does not follow redirects; a 3xx is a second, unvetted
        // URL we refuse outright.
        if (status >= 300 && status < 400) {
          res.destroy();
          done({ ok: false, status, body: "", error: "redirect-refused" });
          return;
        }
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          if (received < WEBHOOK_MAX_BODY_BYTES) {
            const room = WEBHOOK_MAX_BODY_BYTES - received;
            chunks.push(chunk.subarray(0, room));
            received += chunk.length;
          }
          if (received >= WEBHOOK_MAX_BODY_BYTES) res.destroy();
        });
        res.on("end", () => {
          const ok = status >= 200 && status < 300;
          done({
            ok,
            status,
            body: Buffer.concat(chunks).toString("utf8"),
            error: ok ? null : `http-${status}`,
          });
        });
        res.on("error", (e: Error) => done({ ok: false, status, body: "", error: e.message }));
        // A capped read triggers a client-side destroy; treat that as success.
        res.on("close", () => {
          if (!settled) {
            const ok = status >= 200 && status < 300;
            done({ ok, status, body: Buffer.concat(chunks).toString("utf8"), error: ok ? null : `http-${status}` });
          }
        });
      },
    );

    req.on("timeout", () => {
      req.destroy();
      done({ ok: false, status: 0, body: "", error: "timeout" });
    });
    req.on("error", (e: Error) => done({ ok: false, status: 0, body: "", error: e.message }));

    req.write(bodyBuf);
    req.end();
  });
}
