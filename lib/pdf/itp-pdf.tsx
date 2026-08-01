import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

/**
 * Works Quality evidence PDF (M2). Server-side only via @react-pdf
 * renderToBuffer — the existing PDF architecture (rams-pdf.tsx), no new
 * engine. Rendered from an ISSUED (or historical) ITP: plan header, the
 * ordered checks with acceptance criteria and control points, the LIVE
 * sign-offs with results and hold-point breach stamps, and the open NCR
 * register for the plan. The input is a pure shape so this is unit-testable
 * without the DB. Quality content only — no cost/margin field exists on the
 * input, and nothing is stored: the document is regenerated per request.
 */

export type ItpPdfItem = {
  item_number: number;
  title: string;
  acceptance_criteria: string;
  inspection_method: string | null;
  specification_ref: string | null;
  control_point: string;
  is_hold_point: boolean;
  required: boolean;
  // The live (non-void) sign-off against this item, if any.
  signoff: {
    result: string;
    signed_name: string;
    inspected_at: string;
    comments: string | null;
    witness_name: string | null;
    witness_organisation: string | null;
    hold_point_breach: boolean;
    open_hold_item_number: number | null;
  } | null;
};

export type ItpPdfNcr = {
  reference: string;
  title: string;
  severity: string;
  status: string;
  item_number: number | null;
  responsible: string | null;
  due_date: string | null;
};

export type ItpPdfInput = {
  org_name: string;
  reference: string;
  title: string;
  work_package: string;
  location: string | null;
  specification_ref: string | null;
  job_label: string | null;
  status: string;
  revision_number: number;
  issued_at: string | null;
  prepared_by_name: string | null;
  items: ItpPdfItem[];
  open_ncrs: ItpPdfNcr[];
  generated_at: string;
};

const c = {
  ink: "#0f172a",
  sub: "#475569",
  line: "#e2e8f0",
  head: "#1e293b",
  pass: "#059669",
  warn: "#d97706",
  fail: "#dc2626",
};

const s = StyleSheet.create({
  page: { padding: 34, fontSize: 9, color: c.ink, fontFamily: "Helvetica" },
  orgName: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  docType: { fontSize: 9, color: c.sub, marginTop: 2 },
  ref: { fontSize: 12, fontFamily: "Helvetica-Bold", textAlign: "right" },
  headRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 2,
    borderBottomColor: c.head,
    paddingBottom: 8,
    marginBottom: 12,
  },
  h1: { fontSize: 13, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  metaGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 8, marginBottom: 12 },
  metaCell: { width: "50%", marginBottom: 6 },
  metaLabel: { fontSize: 7.5, color: c.sub, textTransform: "uppercase" },
  metaVal: { fontSize: 9.5 },
  sectionH: { fontSize: 10.5, fontFamily: "Helvetica-Bold", marginTop: 10, marginBottom: 5, color: c.head },
  itemBox: { borderWidth: 1, borderColor: c.line, borderRadius: 3, padding: 6, marginBottom: 6 },
  itemHead: { flexDirection: "row", alignItems: "center", marginBottom: 3 },
  itemNo: { fontSize: 9, fontFamily: "Helvetica-Bold", marginRight: 6 },
  itemTitle: { fontSize: 9.5, fontFamily: "Helvetica-Bold", flex: 1 },
  pill: {
    fontSize: 7,
    fontFamily: "Helvetica-Bold",
    color: "#ffffff",
    paddingHorizontal: 3,
    paddingVertical: 1,
    borderRadius: 2,
    marginLeft: 3,
  },
  small: { fontSize: 8, color: c.sub },
  body: { fontSize: 8.5, color: "#334155", marginTop: 1.5 },
  tr: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: c.line,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  th: {
    flexDirection: "row",
    backgroundColor: "#f1f5f9",
    borderBottomWidth: 1,
    borderBottomColor: c.line,
    paddingVertical: 4,
    paddingHorizontal: 4,
  },
  thText: { fontSize: 7.5, fontFamily: "Helvetica-Bold", color: c.sub, textTransform: "uppercase" },
  cell: { fontSize: 8.5, paddingRight: 4 },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 34,
    right: 34,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: c.line,
    paddingTop: 6,
    fontSize: 7.5,
    color: c.sub,
  },
});

const RESULT_LABEL: Record<string, { label: string; color: string }> = {
  pass: { label: "PASS", color: c.pass },
  pass_with_comment: { label: "PASS W/ COMMENT", color: c.warn },
  fail: { label: "FAIL", color: c.fail },
};

function d(x: string | null): string {
  return x ? x.slice(0, 10) : "—";
}

export function ItpPdf({ plan }: { plan: ItpPdfInput }) {
  return (
    <Document title={`ITP ${plan.reference}`}>
      <Page size="A4" style={s.page}>
        <View style={s.headRow}>
          <View>
            <Text style={s.orgName}>{plan.org_name}</Text>
            <Text style={s.docType}>Inspection &amp; Test Plan — evidence record</Text>
          </View>
          <View>
            <Text style={s.ref}>{plan.reference}</Text>
            <Text style={{ ...s.docType, textAlign: "right" }}>
              Revision {plan.revision_number} ·{" "}
              {plan.status === "issued"
                ? "Current (issued)"
                : plan.status === "superseded"
                  ? "Superseded"
                  : plan.status}
            </Text>
          </View>
        </View>

        <Text style={s.h1}>{plan.work_package}</Text>
        <Text style={{ fontSize: 9.5, color: c.sub }}>{plan.title}</Text>

        <View style={s.metaGrid}>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Job</Text>
            <Text style={s.metaVal}>{plan.job_label || "—"}</Text>
          </View>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Location</Text>
            <Text style={s.metaVal}>{plan.location || "—"}</Text>
          </View>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Specification</Text>
            <Text style={s.metaVal}>{plan.specification_ref || "—"}</Text>
          </View>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Prepared by</Text>
            <Text style={s.metaVal}>{plan.prepared_by_name || "—"}</Text>
          </View>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Issued</Text>
            <Text style={s.metaVal}>{d(plan.issued_at)}</Text>
          </View>
        </View>

        <Text style={s.sectionH}>Inspection items &amp; sign-offs</Text>
        {plan.items.map((item) => {
          const so = item.signoff;
          const res = so ? (RESULT_LABEL[so.result] ?? { label: so.result, color: c.sub }) : null;
          return (
            <View key={item.item_number} style={s.itemBox} wrap={false}>
              <View style={s.itemHead}>
                <Text style={s.itemNo}>{item.item_number}.</Text>
                <Text style={s.itemTitle}>{item.title}</Text>
                <Text style={{ ...s.pill, backgroundColor: c.head }}>
                  {item.control_point.toUpperCase()}
                </Text>
                {item.is_hold_point ? (
                  <Text style={{ ...s.pill, backgroundColor: c.fail }}>HOLD POINT</Text>
                ) : null}
                {res ? (
                  <Text style={{ ...s.pill, backgroundColor: res.color }}>{res.label}</Text>
                ) : (
                  <Text style={{ ...s.pill, backgroundColor: c.sub }}>NOT INSPECTED</Text>
                )}
              </View>
              <Text style={s.body}>Acceptance: {item.acceptance_criteria}</Text>
              {item.inspection_method ? (
                <Text style={s.body}>Method: {item.inspection_method}</Text>
              ) : null}
              {item.specification_ref ? (
                <Text style={s.body}>Spec: {item.specification_ref}</Text>
              ) : null}
              {so ? (
                <View>
                  <Text style={s.body}>
                    Signed off by {so.signed_name} on {d(so.inspected_at)}
                    {so.witness_name
                      ? ` · witnessed by ${so.witness_name}${so.witness_organisation ? ` (${so.witness_organisation})` : ""}`
                      : ""}
                  </Text>
                  {so.comments ? <Text style={s.body}>Comments: {so.comments}</Text> : null}
                  {so.hold_point_breach ? (
                    <Text style={{ ...s.body, color: c.fail }}>
                      Recorded while hold point {so.open_hold_item_number} was still open
                      (out of sequence).
                    </Text>
                  ) : null}
                </View>
              ) : null}
            </View>
          );
        })}

        <Text style={s.sectionH}>Open non-conformance register</Text>
        {plan.open_ncrs.length === 0 ? (
          <Text style={s.small}>No open non-conformance reports against this plan.</Text>
        ) : (
          <View>
            <View style={s.th}>
              <Text style={{ ...s.thText, width: "14%" }}>Reference</Text>
              <Text style={{ ...s.thText, width: "34%" }}>Title</Text>
              <Text style={{ ...s.thText, width: "10%" }}>Item</Text>
              <Text style={{ ...s.thText, width: "12%" }}>Severity</Text>
              <Text style={{ ...s.thText, width: "18%" }}>Responsible</Text>
              <Text style={{ ...s.thText, width: "12%" }}>Due</Text>
            </View>
            {plan.open_ncrs.map((n) => (
              <View key={n.reference} style={s.tr} wrap={false}>
                <Text style={{ ...s.cell, width: "14%" }}>{n.reference}</Text>
                <Text style={{ ...s.cell, width: "34%" }}>{n.title}</Text>
                <Text style={{ ...s.cell, width: "10%" }}>
                  {n.item_number !== null ? String(n.item_number) : "—"}
                </Text>
                <Text style={{ ...s.cell, width: "12%" }}>{n.severity}</Text>
                <Text style={{ ...s.cell, width: "18%" }}>{n.responsible || "—"}</Text>
                <Text style={{ ...s.cell, width: "12%" }}>{n.due_date || "—"}</Text>
              </View>
            ))}
          </View>
        )}

        <View style={s.footer} fixed>
          <Text>
            {plan.reference} · {plan.org_name}
          </Text>
          <Text>
            Generated {plan.generated_at.slice(0, 16).replace("T", " ")} · Regenerated on demand —
            the database is the record
          </Text>
        </View>
      </Page>
    </Document>
  );
}
