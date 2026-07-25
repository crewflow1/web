import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

/**
 * Evidence-grade Toolbox Talk PDF. Server-side only via @react-pdf renderToBuffer
 * (existing PDF architecture). Rendered from the talk's FROZEN issue-time snapshot —
 * so a later RAMS revision or permit expiry never rewrites historical evidence — plus
 * the LIVE acknowledgement roster (signatures accrue after issue). Pure input shape →
 * unit-testable. H&S content only; no commercial/internal data.
 *
 * Honesty (the attendance ≠ acknowledgement rule): "CrewFlow-authenticated
 * acknowledgements" are operatives who signed in the platform; "recorded attendees"
 * are manually noted (Tier B) and are NEVER presented as authenticated signatures.
 */

export type ToolboxTalkPdfSignoff = { signer_name: string; signed_name: string; acknowledged_at: string };
export type ToolboxTalkPdfAttendee = { name: string; company: string | null };

export type ToolboxTalkPdfInput = {
  org_name: string;
  reference: string;
  revision: number;
  talk_date: string;
  location: string | null;
  site_label: string | null;
  delivered_by: string;
  topic: string;
  key_points: string;
  ppe: string[];
  rams_reference: string | null;
  rams_revision: number | null;
  permit_reference: string | null;
  permit_status_at_issue: string | null;
  external_attendees: ToolboxTalkPdfAttendee[];
  attendance_note: string | null;
  attendee_count: number | null;
  issued_by_name: string | null;
  issued_on: string;
  signoffs: ToolboxTalkPdfSignoff[];
  generated_at: string;
};

const c = { ink: "#0f172a", sub: "#475569", line: "#e2e8f0", head: "#1e293b", ok: "#059669", warn: "#dc2626" };
const s = StyleSheet.create({
  page: { padding: 34, fontSize: 9, color: c.ink, fontFamily: "Helvetica" },
  orgName: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  docType: { fontSize: 9, color: c.sub, marginTop: 2 },
  ref: { fontSize: 12, fontFamily: "Helvetica-Bold", textAlign: "right" },
  headRow: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 2, borderBottomColor: c.head, paddingBottom: 8, marginBottom: 12 },
  h1: { fontSize: 13, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  metaGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 8, marginBottom: 6 },
  metaCell: { width: "50%", marginBottom: 6 },
  metaLabel: { fontSize: 7.5, color: c.sub, textTransform: "uppercase" },
  metaVal: { fontSize: 9.5 },
  sectionH: { fontSize: 10.5, fontFamily: "Helvetica-Bold", marginTop: 10, marginBottom: 5, color: c.head },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: c.line, paddingVertical: 4, paddingHorizontal: 4 },
  cell: { fontSize: 8.5, paddingRight: 4 },
  para: { fontSize: 9, lineHeight: 1.5, color: "#334155" },
  note: { fontSize: 7.5, color: c.sub, marginTop: 2, marginBottom: 2 },
  footer: { position: "absolute", bottom: 20, left: 34, right: 34, flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: c.line, paddingTop: 6, fontSize: 7.5, color: c.sub },
});

function d(x: string | null): string { return x ? x.slice(0, 16).replace("T", " ") : "—"; }

export function ToolboxTalkPdf({ t }: { t: ToolboxTalkPdfInput }) {
  const ramsLabel = t.rams_reference
    ? `${t.rams_reference}${t.rams_revision && t.rams_revision > 1 ? ` (rev ${t.rams_revision})` : ""}`
    : "—";
  const permitLabel = t.permit_reference
    ? `${t.permit_reference}${t.permit_status_at_issue ? ` · ${t.permit_status_at_issue}` : ""}`
    : "—";
  const site = t.site_label ?? t.location ?? "—";

  return (
    <Document title={`Toolbox Talk ${t.reference}`}>
      <Page size="A4" style={s.page}>
        <View style={s.headRow}>
          <View>
            <Text style={s.orgName}>{t.org_name}</Text>
            <Text style={s.docType}>Toolbox Talk Record</Text>
          </View>
          <View>
            <Text style={s.ref}>{t.reference}</Text>
            <Text style={{ ...s.docType, textAlign: "right" }}>
              {t.revision > 1 ? `Revision ${t.revision}` : "Delivered"}
            </Text>
          </View>
        </View>

        <Text style={s.h1}>{t.topic}</Text>

        <View style={s.metaGrid}>
          <View style={s.metaCell}><Text style={s.metaLabel}>Date delivered</Text><Text style={s.metaVal}>{t.talk_date}</Text></View>
          <View style={s.metaCell}><Text style={s.metaLabel}>Project / site</Text><Text style={s.metaVal}>{site}</Text></View>
          <View style={s.metaCell}><Text style={s.metaLabel}>Area / location</Text><Text style={s.metaVal}>{t.location || "—"}</Text></View>
          <View style={s.metaCell}><Text style={s.metaLabel}>Delivered by</Text><Text style={s.metaVal}>{t.delivered_by}</Text></View>
          <View style={s.metaCell}><Text style={s.metaLabel}>Linked RAMS</Text><Text style={s.metaVal}>{ramsLabel}</Text></View>
          <View style={s.metaCell}><Text style={s.metaLabel}>Linked permit</Text><Text style={s.metaVal}>{permitLabel}</Text></View>
        </View>

        <Text style={s.sectionH}>Key points briefed</Text>
        <Text style={s.para}>{t.key_points}</Text>

        {t.ppe.length ? (
          <>
            <Text style={s.sectionH}>PPE required</Text>
            <Text style={s.para}>{t.ppe.join(" · ")}</Text>
          </>
        ) : null}

        {/* Tier A — CrewFlow-authenticated acknowledgements. */}
        <Text style={s.sectionH}>CrewFlow-authenticated acknowledgements</Text>
        {t.signoffs.length === 0 ? (
          <Text style={s.cell}>No operatives have acknowledged this talk in CrewFlow yet.</Text>
        ) : (
          t.signoffs.map((so, i) => (
            <View key={i} style={s.tr} wrap={false}>
              <Text style={{ ...s.cell, width: "45%" }}>{so.signer_name}</Text>
              <Text style={{ ...s.cell, width: "33%" }}>signed “{so.signed_name}”</Text>
              <Text style={{ ...s.cell, width: "22%" }}>{d(so.acknowledged_at)}</Text>
            </View>
          ))
        )}

        {/* Tier B — recorded attendance, explicitly not authenticated. */}
        {t.attendance_note || t.attendee_count != null || t.external_attendees.length ? (
          <>
            <Text style={s.sectionH}>Recorded attendance (manual record)</Text>
            <Text style={s.note}>
              Manually recorded — not CrewFlow-authenticated. Any signed paper sheet is attached to the record.
            </Text>
            {t.attendee_count != null ? (
              <Text style={s.para}>Headcount recorded: {t.attendee_count}.</Text>
            ) : null}
            {t.attendance_note ? <Text style={s.para}>{t.attendance_note}</Text> : null}
            {t.external_attendees.map((a, i) => (
              <View key={i} style={s.tr} wrap={false}>
                <Text style={{ ...s.cell, width: "60%" }}>{a.name}</Text>
                <Text style={{ ...s.cell, width: "40%" }}>{a.company || "—"}</Text>
              </View>
            ))}
          </>
        ) : null}

        <Text style={s.sectionH}>Evidence statement</Text>
        <Text style={s.para}>
          This record confirms the above toolbox talk was delivered on {t.talk_date}
          {t.issued_by_name ? ` and issued by ${t.issued_by_name}` : ""}. The key points and PPE shown are the
          briefing as it stood when delivered, with the linked RAMS and permit references frozen at that time.
          CrewFlow-authenticated acknowledgements are operatives who signed in the platform; recorded attendees
          are noted manually and are not platform-authenticated.
        </Text>

        <View style={s.footer} fixed>
          <Text>{t.reference} · {t.org_name}</Text>
          <Text>Generated {t.generated_at.slice(0, 16).replace("T", " ")} · Operational record — not legal advice</Text>
        </View>
      </Page>
    </Document>
  );
}
