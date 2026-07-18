import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
  Image,
} from "@react-pdf/renderer";
import type { ReportContent } from "@/lib/site-reports/schema";
import type {
  DiaryLite,
  SnagLite,
  ToolboxLite,
} from "@/lib/site-reports/aggregate";
import { formatDiaryDate } from "@/lib/site-diary/schema";

/**
 * Branded Site Report PDF — the client-ready deliverable.
 *
 * Reuses the invoice/quote PDF architecture (@react-pdf/renderer, server-side
 * renderToBuffer, org letterhead + logo, fixed footer with page numbers). It
 * renders the frozen snapshot for an issued report, or the working content for a
 * draft preview — the caller decides which and passes a plain input. No customer
 * portal or storage dependency; the same buffer serves both download and (later)
 * portal.
 */

const styles = StyleSheet.create({
  page: { padding: 40, paddingBottom: 56, fontFamily: "Helvetica", fontSize: 10, color: "#0f172a" },
  headerRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 },
  logo: { width: 100, height: 50, objectFit: "contain" },
  orgName: { fontSize: 12, fontWeight: 700, color: "#0f172a", marginBottom: 4 },
  orgBlock: { fontSize: 9, color: "#475569", lineHeight: 1.4 },
  title: { fontSize: 18, fontWeight: 700, marginBottom: 2 },
  metaBlock: { fontSize: 9, textAlign: "right", color: "#475569", lineHeight: 1.5 },
  metaLabel: { color: "#64748b" },
  metaValue: { fontWeight: 700, color: "#0f172a" },
  statusPill: { fontSize: 8, fontWeight: 700, textTransform: "uppercase", paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, color: "#065f46", backgroundColor: "#d1fae5" },
  idBlock: { backgroundColor: "#f8fafc", padding: 12, borderRadius: 6, marginBottom: 16, flexDirection: "row", flexWrap: "wrap" },
  idCell: { width: "33%", marginBottom: 6 },
  idLabel: { fontSize: 7, color: "#64748b", textTransform: "uppercase", letterSpacing: 0.5 },
  idValue: { fontSize: 10, color: "#0f172a" },
  sectionTitle: { fontSize: 9, fontWeight: 700, textTransform: "uppercase", color: "#64748b", marginTop: 12, marginBottom: 6, letterSpacing: 0.5 },
  para: { fontSize: 10, lineHeight: 1.5, color: "#334155", marginBottom: 4 },
  statsRow: { flexDirection: "row", gap: 8, marginBottom: 8 },
  stat: { flex: 1, backgroundColor: "#f8fafc", borderRadius: 6, padding: 8, alignItems: "center" },
  statN: { fontSize: 14, fontWeight: 700 },
  statL: { fontSize: 7, color: "#64748b", textTransform: "uppercase" },
  table: { borderTopWidth: 1, borderTopColor: "#e2e8f0", marginBottom: 8 },
  tHead: { flexDirection: "row", backgroundColor: "#f8fafc", paddingVertical: 5, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: "#e2e8f0" },
  tRow: { flexDirection: "row", paddingVertical: 5, paddingHorizontal: 4, borderBottomWidth: 1, borderBottomColor: "#f1f5f9" },
  th: { fontSize: 8, fontWeight: 700, color: "#64748b", textTransform: "uppercase" },
  td: { fontSize: 9, color: "#0f172a" },
  approval: { marginTop: 16, padding: 10, borderWidth: 1, borderColor: "#e2e8f0", borderRadius: 6, flexDirection: "row", flexWrap: "wrap" },
  footer: { position: "absolute", bottom: 24, left: 40, right: 40, fontSize: 8, color: "#94a3b8", flexDirection: "row", justifyContent: "space-between" },
});

export type SiteReportPdfInput = {
  title: string;
  report_number: string | null;
  revision: number;
  status: string;
  period_start: string;
  period_end: string;
  customer_name: string | null;
  job_label: string | null;
  issued_at: string | null;
  content: ReportContent;
  diary: DiaryLite[];
  snags: SnagLite[];
  toolbox: ToolboxLite[];
  prepared_by_name: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  org_name: string;
  org_phone: string | null;
  org_vat_number: string | null;
  org_logo_url: string | null;
  org_address: { line1?: string; city?: string; postcode?: string } | null;
};

function Section({ title, text }: { title: string; text?: string | null }) {
  if (!text) return null;
  return (
    <View wrap={false}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <Text style={styles.para}>{text}</Text>
    </View>
  );
}

export function SiteReportPdf({ r }: { r: SiteReportPdfInput }) {
  const addr = r.org_address ?? {};
  const addrLine = [addr.line1, addr.city, addr.postcode].filter(Boolean).join(", ");
  const c = r.content ?? {};
  const period = `${formatDiaryDate(r.period_start)} – ${formatDiaryDate(r.period_end)}`;

  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerRow} fixed>
          <View style={{ flex: 1 }}>
            <Text style={styles.orgName}>{r.org_name}</Text>
            <View style={styles.orgBlock}>
              {addrLine ? <Text>{addrLine}</Text> : null}
              {r.org_phone ? <Text>{r.org_phone}</Text> : null}
              {r.org_vat_number ? <Text>VAT no. {r.org_vat_number}</Text> : null}
            </View>
          </View>
          {r.org_logo_url ? (
            // eslint-disable-next-line jsx-a11y/alt-text
            <Image style={styles.logo} src={r.org_logo_url} />
          ) : null}
        </View>

        <View style={{ flexDirection: "row", justifyContent: "space-between", marginBottom: 12 }}>
          <View style={{ flex: 1 }}>
            <Text style={styles.title}>{r.title}</Text>
            <Text style={{ fontSize: 9, color: "#64748b", marginTop: 2 }}>Progress report</Text>
          </View>
          <View style={styles.metaBlock}>
            {r.status === "issued" ? <Text style={styles.statusPill}>Issued</Text> : null}
          </View>
        </View>

        <View style={styles.idBlock}>
          <IdCell label="Report no." value={r.report_number ?? "—"} />
          <IdCell label="Revision" value={String(r.revision)} />
          <IdCell label="Period" value={period} />
          <IdCell label="Customer" value={r.customer_name ?? "—"} />
          <IdCell label="Job / site" value={r.job_label ?? "—"} />
          <IdCell label="Issued" value={r.issued_at ? r.issued_at.slice(0, 10) : "Draft"} />
        </View>

        {/* Executive summary */}
        {c.overall_status || c.current_phase || c.progress_percent != null ? (
          <>
            <Text style={styles.sectionTitle}>Project status</Text>
            <Text style={styles.para}>
              {[
                c.overall_status ? `Status: ${c.overall_status}` : null,
                c.current_phase ? `Phase: ${c.current_phase}` : null,
                c.progress_percent != null ? `Progress: ${c.progress_percent}%` : null,
              ]
                .filter(Boolean)
                .join("   ·   ")}
            </Text>
          </>
        ) : null}
        <Section title="Executive summary" text={c.summary} />
        <Section title="Achievements this period" text={c.achievements} />

        {/* Aggregated site activity */}
        <Text style={styles.sectionTitle}>Site activity this period</Text>
        <View style={styles.statsRow}>
          <Stat n={r.diary.length} l="Diary days" />
          <Stat n={r.snags.length} l="Snags" />
          <Stat n={r.toolbox.length} l="Safety talks" />
        </View>

        {r.snags.length > 0 ? (
          <>
            <Text style={styles.sectionTitle}>Snags &amp; issues</Text>
            <View style={styles.table}>
              <View style={styles.tHead}>
                <Text style={[styles.th, { flex: 4 }]}>Item</Text>
                <Text style={[styles.th, { flex: 2 }]}>Location</Text>
                <Text style={[styles.th, { flex: 1.5 }]}>Priority</Text>
                <Text style={[styles.th, { flex: 1.5 }]}>Status</Text>
              </View>
              {r.snags.slice(0, 40).map((s, i) => (
                <View style={styles.tRow} key={i} wrap={false}>
                  <Text style={[styles.td, { flex: 4 }]}>{s.title}</Text>
                  <Text style={[styles.td, { flex: 2 }]}>{s.location ?? "—"}</Text>
                  <Text style={[styles.td, { flex: 1.5 }]}>{s.priority}</Text>
                  <Text style={[styles.td, { flex: 1.5 }]}>{s.status.replace(/_/g, " ")}</Text>
                </View>
              ))}
            </View>
          </>
        ) : null}

        <Section title="Work planned next period" text={c.work_planned} />
        <Section title="Programme &amp; progress" text={c.programme_notes} />
        <Section title="Completion forecast" text={c.completion_forecast} />
        <Section title="Weather impact" text={c.weather_notes} />
        <Section title="Risks &amp; blockers" text={c.risks} />
        <Section title="Client decisions required" text={c.client_decisions} />
        <Section title="Next steps" text={c.next_steps} />

        <View style={styles.approval} wrap={false}>
          <View style={{ width: "33%" }}>
            <Text style={styles.idLabel}>Prepared by</Text>
            <Text style={styles.idValue}>{r.prepared_by_name ?? "—"}</Text>
          </View>
          <View style={{ width: "33%" }}>
            <Text style={styles.idLabel}>Approved by</Text>
            <Text style={styles.idValue}>{r.approved_by_name ?? "—"}</Text>
          </View>
          <View style={{ width: "33%" }}>
            <Text style={styles.idLabel}>Approved</Text>
            <Text style={styles.idValue}>{r.approved_at ? r.approved_at.slice(0, 10) : "—"}</Text>
          </View>
        </View>

        <View style={styles.footer} fixed>
          <Text>
            {r.org_name} · {r.title}
            {r.report_number ? ` · ${r.report_number}` : ""}
          </Text>
          <Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

function IdCell({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.idCell}>
      <Text style={styles.idLabel}>{label}</Text>
      <Text style={styles.idValue}>{value}</Text>
    </View>
  );
}

function Stat({ n, l }: { n: number; l: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statN}>{n}</Text>
      <Text style={styles.statL}>{l}</Text>
    </View>
  );
}
