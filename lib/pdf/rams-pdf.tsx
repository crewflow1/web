import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import { riskRating, riskBand, RISK_BAND_META } from "@/lib/health-safety/rams";

/**
 * Evidence-grade RAMS (Risk Assessment & Method Statement) PDF. Server-side only
 * via @react-pdf renderToBuffer (reuses the existing PDF architecture — no new
 * engine). Rendered from an ISSUED RAMS: a frozen, numbered legal record. The
 * input is a pure shape so this is unit-testable without the DB. Contains ONLY
 * H&S content — no cost/margin/internal-note fields exist on the input.
 */

export type RamsPdfHazard = {
  hazard: string; who_at_risk: string | null;
  likelihood: number; severity: number;
  control_measures: string;
  residual_likelihood: number | null; residual_severity: number | null;
};
export type RamsPdfSignoff = { signer_name: string; signed_name: string; acknowledged_at: string };
export type RamsPdfInput = {
  org_name: string;
  reference: string;
  title: string;
  activity: string;
  location: string | null;
  assessor_name: string | null;
  assessment_date: string | null;
  review_date: string | null;
  ppe: string[];
  method_statement: string | null;
  status: string;
  // Revision lineage (M6a) — so a downloaded historical PDF is unambiguous years
  // later about which revision it is and whether it was still current.
  revision_number: number;
  issued_at: string | null;
  hazards: RamsPdfHazard[];
  signoffs: RamsPdfSignoff[];
  generated_at: string;
};

const c = { ink: "#0f172a", sub: "#475569", line: "#e2e8f0", head: "#1e293b", band: { low: "#059669", medium: "#d97706", high: "#ea580c", critical: "#dc2626" } };
const s = StyleSheet.create({
  page: { padding: 34, fontSize: 9, color: c.ink, fontFamily: "Helvetica" },
  orgName: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  docType: { fontSize: 9, color: c.sub, marginTop: 2 },
  ref: { fontSize: 12, fontFamily: "Helvetica-Bold", textAlign: "right" },
  headRow: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 2, borderBottomColor: c.head, paddingBottom: 8, marginBottom: 12 },
  h1: { fontSize: 13, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  metaGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 8, marginBottom: 12 },
  metaCell: { width: "50%", marginBottom: 6 },
  metaLabel: { fontSize: 7.5, color: c.sub, textTransform: "uppercase" },
  metaVal: { fontSize: 9.5 },
  sectionH: { fontSize: 10.5, fontFamily: "Helvetica-Bold", marginTop: 10, marginBottom: 5, color: c.head },
  th: { flexDirection: "row", backgroundColor: "#f1f5f9", borderBottomWidth: 1, borderBottomColor: c.line, paddingVertical: 4, paddingHorizontal: 4 },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: c.line, paddingVertical: 4, paddingHorizontal: 4 },
  thText: { fontSize: 7.5, fontFamily: "Helvetica-Bold", color: c.sub, textTransform: "uppercase" },
  cell: { fontSize: 8.5, paddingRight: 4 },
  bandPill: { fontSize: 7.5, fontFamily: "Helvetica-Bold", color: "#ffffff", paddingHorizontal: 3, paddingVertical: 1, borderRadius: 2 },
  method: { fontSize: 9, lineHeight: 1.5, color: "#334155" },
  footer: { position: "absolute", bottom: 20, left: 34, right: 34, flexDirection: "row", justifyContent: "space-between", borderTopWidth: 1, borderTopColor: c.line, paddingTop: 6, fontSize: 7.5, color: c.sub },
});

function d(x: string | null): string {
  return x ? x.slice(0, 10) : "—";
}

export function RamsPdf({ ra }: { ra: RamsPdfInput }) {
  return (
    <Document title={`RAMS ${ra.reference}`}>
      <Page size="A4" style={s.page}>
        <View style={s.headRow}>
          <View>
            <Text style={s.orgName}>{ra.org_name}</Text>
            <Text style={s.docType}>Risk Assessment & Method Statement</Text>
          </View>
          <View>
            <Text style={s.ref}>{ra.reference}</Text>
            <Text style={{ ...s.docType, textAlign: "right" }}>
              Revision {ra.revision_number} · {ra.status === "issued" ? "Current (issued)" : ra.status === "superseded" ? "Superseded" : ra.status}
            </Text>
          </View>
        </View>

        <Text style={s.h1}>{ra.title}</Text>
        <Text style={{ fontSize: 9.5, color: c.sub }}>{ra.activity}</Text>

        <View style={s.metaGrid}>
          <View style={s.metaCell}><Text style={s.metaLabel}>Location</Text><Text style={s.metaVal}>{ra.location || "—"}</Text></View>
          <View style={s.metaCell}><Text style={s.metaLabel}>Assessor</Text><Text style={s.metaVal}>{ra.assessor_name || "—"}</Text></View>
          <View style={s.metaCell}><Text style={s.metaLabel}>Assessment date</Text><Text style={s.metaVal}>{d(ra.assessment_date)}</Text></View>
          <View style={s.metaCell}><Text style={s.metaLabel}>Review date</Text><Text style={s.metaVal}>{d(ra.review_date)}</Text></View>
          <View style={s.metaCell}><Text style={s.metaLabel}>Issued</Text><Text style={s.metaVal}>{d(ra.issued_at)}</Text></View>
          <View style={s.metaCell}><Text style={s.metaLabel}>PPE</Text><Text style={s.metaVal}>{ra.ppe.length ? ra.ppe.join(", ") : "—"}</Text></View>
        </View>

        <Text style={s.sectionH}>Hazards & controls</Text>
        <View style={s.th}>
          <Text style={{ ...s.thText, width: "20%" }}>Hazard</Text>
          <Text style={{ ...s.thText, width: "14%" }}>Persons at risk</Text>
          <Text style={{ ...s.thText, width: "14%" }}>Initial (L×S)</Text>
          <Text style={{ ...s.thText, width: "38%" }}>Control measures</Text>
          <Text style={{ ...s.thText, width: "14%" }}>Residual</Text>
        </View>
        {ra.hazards.map((h, i) => {
          const rating = riskRating(h.likelihood, h.severity);
          const band = riskBand(rating);
          const hasRes = h.residual_likelihood != null && h.residual_severity != null;
          const resRating = hasRes ? riskRating(h.residual_likelihood!, h.residual_severity!) : null;
          const resBand = resRating != null ? riskBand(resRating) : null;
          return (
            <View key={i} style={s.tr} wrap={false}>
              <Text style={{ ...s.cell, width: "20%" }}>{h.hazard}</Text>
              <Text style={{ ...s.cell, width: "14%" }}>{h.who_at_risk || "—"}</Text>
              <View style={{ width: "14%", flexDirection: "row", alignItems: "center" }}>
                <Text style={s.cell}>{h.likelihood}×{h.severity}={rating} </Text>
                <Text style={{ ...s.bandPill, backgroundColor: c.band[band] }}>{RISK_BAND_META[band].label}</Text>
              </View>
              <Text style={{ ...s.cell, width: "38%" }}>{h.control_measures}</Text>
              <View style={{ width: "14%", flexDirection: "row", alignItems: "center" }}>
                {resRating != null && resBand ? (
                  <>
                    <Text style={s.cell}>{resRating} </Text>
                    <Text style={{ ...s.bandPill, backgroundColor: c.band[resBand] }}>{RISK_BAND_META[resBand].label}</Text>
                  </>
                ) : <Text style={s.cell}>—</Text>}
              </View>
            </View>
          );
        })}

        {ra.method_statement ? (
          <>
            <Text style={s.sectionH}>Method statement</Text>
            <Text style={s.method}>{ra.method_statement}</Text>
          </>
        ) : null}

        {ra.signoffs.length ? (
          <>
            <Text style={s.sectionH}>Operative sign-off register</Text>
            {ra.signoffs.map((so, i) => (
              <View key={i} style={s.tr} wrap={false}>
                <Text style={{ ...s.cell, width: "40%" }}>{so.signer_name}</Text>
                <Text style={{ ...s.cell, width: "35%" }}>signed “{so.signed_name}”</Text>
                <Text style={{ ...s.cell, width: "25%" }}>{d(so.acknowledged_at)}</Text>
              </View>
            ))}
          </>
        ) : null}

        <View style={s.footer} fixed>
          <Text>{ra.reference} · {ra.org_name}</Text>
          <Text>Generated {ra.generated_at.slice(0, 16).replace("T", " ")} · Not a substitute for a competent H&S professional</Text>
        </View>
      </Page>
    </Document>
  );
}
