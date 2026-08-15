import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

/**
 * Fire muster roll PDF — the evacuation register a fire marshal carries to the
 * assembly point: everyone recorded ON a site at the moment of generation.
 * Server-side only via @react-pdf renderToBuffer (existing PDF architecture).
 * Pure input shape → unit-testable. No commercial/internal data.
 *
 * Honesty: the roll is derived from CrewFlow records (inductions + clock-in +
 * visitor sign-in). It is only as complete as those records — the footer says so
 * rather than implying it is an infallible headcount.
 */

export type MusterPdfPerson = {
  name: string;
  kind: "Worker" | "Visitor";
  company: string | null;
  onSince: string; // HH:MM (UTC)
};

export type MusterRollPdfInput = {
  org_name: string;
  site_name: string;
  site_address: string | null;
  generated_at: string; // ISO
  present_count: number;
  people: MusterPdfPerson[];
};

const c = { ink: "#0f172a", sub: "#475569", line: "#e2e8f0", head: "#1e293b", warn: "#dc2626" };
const s = StyleSheet.create({
  page: { padding: 34, fontSize: 9, color: c.ink, fontFamily: "Helvetica" },
  orgName: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  docType: { fontSize: 9, color: c.sub, marginTop: 2 },
  bigCount: { fontSize: 26, fontFamily: "Helvetica-Bold", textAlign: "right" },
  countLabel: { fontSize: 8, color: c.sub, textAlign: "right" },
  headRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 2,
    borderBottomColor: c.head,
    paddingBottom: 8,
    marginBottom: 12,
  },
  h1: { fontSize: 15, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  meta: { fontSize: 9, color: c.sub },
  banner: {
    marginTop: 4,
    marginBottom: 10,
    padding: 6,
    backgroundColor: "#fef2f2",
    borderWidth: 1,
    borderColor: "#fecaca",
    borderRadius: 3,
  },
  bannerText: { fontSize: 9, color: c.warn, fontFamily: "Helvetica-Bold" },
  th: { flexDirection: "row", borderBottomWidth: 2, borderBottomColor: c.head, paddingVertical: 5, paddingHorizontal: 4 },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: c.line, paddingVertical: 5, paddingHorizontal: 4 },
  thc: { fontSize: 8.5, fontFamily: "Helvetica-Bold" },
  cell: { fontSize: 9, paddingRight: 4 },
  colName: { width: "38%" },
  colType: { width: "16%" },
  colCompany: { width: "30%" },
  colSince: { width: "16%" },
  empty: { fontSize: 10, color: c.sub, marginTop: 16 },
  footer: { position: "absolute", bottom: 24, left: 34, right: 34, fontSize: 7.5, color: c.sub, textAlign: "center" },
});

export function MusterRollPdf({ m }: { m: MusterRollPdfInput }) {
  const stamp = `${m.generated_at.slice(0, 10)} ${m.generated_at.slice(11, 16)} UTC`;
  return (
    <Document
      title={`Fire muster — ${m.site_name}`}
      author={m.org_name}
      subject="Fire muster roll"
    >
      <Page size="A4" style={s.page}>
        <View style={s.headRow}>
          <View>
            <Text style={s.orgName}>{m.org_name}</Text>
            <Text style={s.docType}>Fire Muster Roll</Text>
          </View>
          <View>
            <Text style={s.bigCount}>{m.present_count}</Text>
            <Text style={s.countLabel}>on site</Text>
          </View>
        </View>

        <Text style={s.h1}>{m.site_name}</Text>
        {m.site_address ? <Text style={s.meta}>{m.site_address}</Text> : null}
        <Text style={s.meta}>Generated {stamp}</Text>

        <View style={s.banner}>
          <Text style={s.bannerText}>
            ACCOUNT FOR EVERYONE LISTED BELOW AT THE ASSEMBLY POINT
          </Text>
        </View>

        {m.people.length === 0 ? (
          <Text style={s.empty}>
            No one is recorded on this site at the time of generation.
          </Text>
        ) : (
          <View>
            <View style={s.th}>
              <Text style={[s.thc, s.colName]}>Name</Text>
              <Text style={[s.thc, s.colType]}>Type</Text>
              <Text style={[s.thc, s.colCompany]}>Company</Text>
              <Text style={[s.thc, s.colSince]}>On since</Text>
            </View>
            {m.people.map((p, i) => (
              <View style={s.tr} key={i} wrap={false}>
                <Text style={[s.cell, s.colName]}>{p.name}</Text>
                <Text style={[s.cell, s.colType]}>{p.kind}</Text>
                <Text style={[s.cell, s.colCompany]}>{p.company ?? "—"}</Text>
                <Text style={[s.cell, s.colSince]}>{p.onSince}</Text>
              </View>
            ))}
          </View>
        )}

        <Text style={s.footer} fixed>
          Derived from CrewFlow site inductions, clock-in records and visitor sign-ins at {stamp}. Only
          as complete as those records — verify against a physical headcount.
        </Text>
      </Page>
    </Document>
  );
}
