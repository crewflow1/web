import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { EotNotice } from "@/lib/eot/letter";

/**
 * EOT contractual NOTICE OF DELAY — PDF. Server-side only via @react-pdf
 * renderToBuffer (the rams-pdf / eot-pack-pdf architecture, no new engine).
 * The input is the pure notice shape from lib/eot/letter.ts, so this template
 * is unit-testable without the DB and cannot itself invent a fact.
 *
 * A NOTICE, NOT A CLAIM — and the document SAYS SO on its face (the standing
 * disclaimer). Particulars the record does not hold print as [not specified]
 * exactly as the composer produced them; this template neither hides them nor
 * fills them in. No money field exists in the notice shape to render.
 */

export type EotNoticePdfInput = {
  notice: EotNotice;
};

const c = {
  ink: "#0f172a",
  sub: "#475569",
  line: "#e2e8f0",
  head: "#1e293b",
  amber: "#b45309",
};
const s = StyleSheet.create({
  page: { padding: 40, fontSize: 10, color: c.ink, fontFamily: "Helvetica", lineHeight: 1.5 },
  headRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 2,
    borderBottomColor: c.head,
    paddingBottom: 8,
    marginBottom: 14,
  },
  orgName: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  docType: { fontSize: 9, color: c.sub, marginTop: 2 },
  metaRight: { fontSize: 9, color: c.sub, textAlign: "right" },
  parties: { flexDirection: "row", justifyContent: "space-between", marginBottom: 14 },
  partyCol: { width: "48%" },
  partyLabel: { fontSize: 7.5, color: c.sub, textTransform: "uppercase", marginBottom: 2 },
  partyName: { fontSize: 10.5, fontFamily: "Helvetica-Bold" },
  partyAddr: { fontSize: 9, color: "#334155", marginTop: 1 },
  h1: { fontSize: 12.5, fontFamily: "Helvetica-Bold", marginBottom: 8 },
  sectionH: {
    fontSize: 10.5,
    fontFamily: "Helvetica-Bold",
    marginTop: 12,
    marginBottom: 6,
    color: c.head,
  },
  row: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: c.line,
    paddingVertical: 4,
  },
  rowLabel: { width: "40%", fontSize: 9, color: c.sub },
  rowVal: { width: "60%", fontSize: 9.5 },
  placeholder: { color: c.amber, fontFamily: "Helvetica-Oblique" },
  para: { fontSize: 10, marginBottom: 8, lineHeight: 1.5 },
  gaps: {
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: "#fffbeb",
    padding: 8,
    marginTop: 10,
  },
  gapText: { fontSize: 8.5, color: c.amber, lineHeight: 1.4 },
  disclaimer: {
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: "#f8fafc",
    padding: 8,
    marginTop: 12,
  },
  disclaimerText: { fontSize: 8, color: c.sub, lineHeight: 1.5 },
  sign: { marginTop: 20, fontSize: 9.5 },
  signLine: {
    marginTop: 22,
    borderTopWidth: 1,
    borderTopColor: c.head,
    width: "45%",
    paddingTop: 3,
    fontSize: 8,
    color: c.sub,
  },
  footer: {
    position: "absolute",
    bottom: 22,
    left: 40,
    right: 40,
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: c.line,
    paddingTop: 6,
    fontSize: 7.5,
    color: c.sub,
  },
});

function ParticularRow({ label, value, specified }: { label: string; value: string; specified: boolean }) {
  return (
    <View style={s.row} wrap={false}>
      <Text style={s.rowLabel}>{label}</Text>
      <Text style={specified ? s.rowVal : { ...s.rowVal, ...s.placeholder }}>{value}</Text>
    </View>
  );
}

export function EotNoticePdf({ input }: { input: EotNoticePdfInput }) {
  const { notice } = input;
  return (
    <Document title={`Notice of delay — ${notice.reference}`}>
      <Page size="A4" style={s.page}>
        <View style={s.headRow}>
          <View>
            <Text style={s.orgName}>{notice.contractor.name.value}</Text>
            <Text style={s.docType}>Extension of Time — Notice of Delay</Text>
          </View>
          <View>
            <Text style={s.metaRight}>Notice date: {notice.noticeDate}</Text>
            <Text style={s.metaRight}>Ref: {notice.reference}</Text>
          </View>
        </View>

        <View style={s.parties}>
          <View style={s.partyCol}>
            <Text style={s.partyLabel}>From (Contractor)</Text>
            <Text style={s.partyName}>{notice.contractor.name.value}</Text>
            <Text style={notice.contractor.address.specified ? s.partyAddr : { ...s.partyAddr, ...s.placeholder }}>
              {notice.contractor.address.value}
            </Text>
          </View>
          <View style={s.partyCol}>
            <Text style={s.partyLabel}>To (Employer / Client)</Text>
            <Text style={notice.employer.name.specified ? s.partyName : { ...s.partyName, ...s.placeholder }}>
              {notice.employer.name.value}
            </Text>
            <Text style={notice.employer.address.specified ? s.partyAddr : { ...s.partyAddr, ...s.placeholder }}>
              {notice.employer.address.value}
            </Text>
          </View>
        </View>

        <Text style={s.h1}>Notice of Delay to the Progress of the Works</Text>

        {notice.statements.map((p, i) => (
          <Text key={`stmt-${i}`} style={s.para}>
            {p}
          </Text>
        ))}

        <Text style={s.sectionH}>Particulars</Text>
        {notice.particulars.map((f) => (
          <ParticularRow key={f.label} label={f.label} value={f.value} specified={f.specified} />
        ))}

        {notice.unspecified.length > 0 ? (
          <View style={s.gaps} wrap={false}>
            <Text style={{ ...s.gapText, fontFamily: "Helvetica-Bold" }}>
              To complete before issue ({notice.unspecified.length})
            </Text>
            <Text style={s.gapText}>
              The following particulars are not held in the record and are shown as{" "}
              [not specified]: {notice.unspecified.join("; ")}.
            </Text>
          </View>
        ) : null}

        <View style={s.sign} wrap={false}>
          <Text>Signed for and on behalf of {notice.contractor.name.value}:</Text>
          <Text style={s.signLine}>Signature</Text>
          <Text style={s.signLine}>Name / position</Text>
          <Text style={s.signLine}>Date</Text>
        </View>

        <View style={s.disclaimer} wrap={false}>
          <Text style={s.disclaimerText}>{notice.disclaimer}</Text>
        </View>

        <View style={s.footer} fixed>
          <Text>
            {notice.contractor.name.value} — EOT notice of delay {notice.reference}. Draft for
            review; not a determination of entitlement.
          </Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
