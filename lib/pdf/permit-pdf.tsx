import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import { PERMIT_TYPE_LABELS, type PermitType } from "@/lib/health-safety/permits";

/**
 * Evidence-grade Permit-to-Work PDF. Server-side only via @react-pdf renderToBuffer
 * (existing PDF architecture). Rendered from an issued/live permit — a controlled,
 * time-bound authorisation. Pure input shape → unit-testable. H&S content only.
 */

export type PermitPdfCondition = { label: string; required: boolean; confirmed: boolean; confirmed_at: string | null };
export type PermitPdfSignoff = { signer_name: string; signed_name: string; acknowledged_at: string };
export type PermitPdfInput = {
  org_name: string;
  reference: string;
  permit_type: string;
  title: string;
  scope: string;
  location: string | null;
  responsible_person: string | null;
  isolation_details: string | null;
  emergency_arrangements: string | null;
  rams_reference: string | null;
  valid_from: string | null;
  valid_until: string | null;
  status: string;
  // Derived display status: "expired" when a live permit is past valid_until, so
  // an evidence PDF can never read "active" for a permit whose window has passed.
  effective_status: string;
  issued_at: string | null;
  closeout_notes: string | null;
  closed_at: string | null;
  conditions: PermitPdfCondition[];
  signoffs: PermitPdfSignoff[];
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
  footer: { position: "absolute", bottom: 20, left: 34, right: 34, flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: c.line, paddingTop: 6, fontSize: 7.5, color: c.sub },
});

function d(x: string | null): string { return x ? x.slice(0, 16).replace("T", " ") : "—"; }

export function PermitPdf({ p }: { p: PermitPdfInput }) {
  const typeLabel = PERMIT_TYPE_LABELS[p.permit_type as PermitType] ?? p.permit_type;
  return (
    <Document title={`Permit ${p.reference}`}>
      <Page size="A4" style={s.page}>
        <View style={s.headRow}>
          <View>
            <Text style={s.orgName}>{p.org_name}</Text>
            <Text style={s.docType}>Permit to Work — {typeLabel}</Text>
          </View>
          <View>
            <Text style={s.ref}>{p.reference}</Text>
            <Text style={{ ...s.docType, textAlign: "right", color: p.effective_status === "expired" ? c.warn : c.sub }}>
              {p.effective_status === "expired" ? "EXPIRED" : p.effective_status}
            </Text>
          </View>
        </View>

        <Text style={s.h1}>{p.title}</Text>
        <Text style={{ fontSize: 9.5, color: c.sub }}>{p.scope}</Text>

        <View style={s.metaGrid}>
          <View style={s.metaCell}><Text style={s.metaLabel}>Location</Text><Text style={s.metaVal}>{p.location || "—"}</Text></View>
          <View style={s.metaCell}><Text style={s.metaLabel}>Responsible person</Text><Text style={s.metaVal}>{p.responsible_person || "—"}</Text></View>
          <View style={s.metaCell}><Text style={s.metaLabel}>Valid from</Text><Text style={s.metaVal}>{d(p.valid_from)}</Text></View>
          <View style={s.metaCell}><Text style={s.metaLabel}>Valid until</Text><Text style={s.metaVal}>{d(p.valid_until)}</Text></View>
          <View style={s.metaCell}><Text style={s.metaLabel}>RAMS reference</Text><Text style={s.metaVal}>{p.rams_reference || "—"}</Text></View>
          <View style={s.metaCell}><Text style={s.metaLabel}>Issued</Text><Text style={s.metaVal}>{d(p.issued_at)}</Text></View>
        </View>

        <Text style={s.sectionH}>Control conditions</Text>
        {p.conditions.length === 0 ? <Text style={s.cell}>None recorded.</Text> : p.conditions.map((cond, i) => (
          <View key={i} style={s.tr} wrap={false}>
            <Text style={{ ...s.cell, width: "8%", color: cond.confirmed ? c.ok : c.warn }}>{cond.confirmed ? "✓" : "✗"}</Text>
            <Text style={{ ...s.cell, width: "58%" }}>{cond.label}{cond.required ? "" : " (optional)"}</Text>
            <Text style={{ ...s.cell, width: "34%" }}>{cond.confirmed ? `confirmed ${d(cond.confirmed_at)}` : "not confirmed"}</Text>
          </View>
        ))}

        {p.isolation_details ? (<><Text style={s.sectionH}>Isolation details</Text><Text style={s.para}>{p.isolation_details}</Text></>) : null}
        {p.emergency_arrangements ? (<><Text style={s.sectionH}>Emergency arrangements</Text><Text style={s.para}>{p.emergency_arrangements}</Text></>) : null}

        {p.signoffs.length ? (
          <>
            <Text style={s.sectionH}>Operative sign-off register</Text>
            {p.signoffs.map((so, i) => (
              <View key={i} style={s.tr} wrap={false}>
                <Text style={{ ...s.cell, width: "40%" }}>{so.signer_name}</Text>
                <Text style={{ ...s.cell, width: "35%" }}>signed “{so.signed_name}”</Text>
                <Text style={{ ...s.cell, width: "25%" }}>{d(so.acknowledged_at)}</Text>
              </View>
            ))}
          </>
        ) : null}

        {p.status === "closed" ? (
          <>
            <Text style={s.sectionH}>Close-out</Text>
            <Text style={s.para}>Closed {d(p.closed_at)}. {p.closeout_notes || ""}</Text>
          </>
        ) : null}

        <View style={s.footer} fixed>
          <Text>{p.reference} · {p.org_name}</Text>
          <Text>Generated {p.generated_at.slice(0, 16).replace("T", " ")} · Operational record — not legal advice</Text>
        </View>
      </Page>
    </Document>
  );
}
