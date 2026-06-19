import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from "@react-pdf/renderer";
import type {
  RevenueAnalytics,
  CustomerAnalytics,
  Benchmarks,
  Insight,
} from "@/lib/hq/analytics";
import { formatGbp } from "@/lib/hq/customer-financials";

/**
 * CrewFlow HQ — Executive analytics PDF (HQ-6).
 *
 * Single-page printable summary. Renders the same numbers the
 * /admin/analytics page shows but in a CEO-friendly print layout
 * (no charts — they're heavy in react-pdf and the executive can
 * always open the live page for trends).
 *
 * Server-side only via @react-pdf renderToBuffer.
 */

const styles = StyleSheet.create({
  page: {
    padding: 36,
    fontFamily: "Helvetica",
    fontSize: 10,
    color: "#0f172a",
  },
  header: {
    marginBottom: 18,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  brand: {
    fontSize: 11,
    color: "#64748b",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
    marginTop: 2,
  },
  subtitle: {
    fontSize: 9,
    color: "#475569",
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    color: "#1e293b",
    letterSpacing: 0.5,
    marginTop: 14,
    marginBottom: 6,
  },
  kpiGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  kpi: {
    width: "32%",
    padding: 8,
    borderWidth: 1,
    borderColor: "#e2e8f0",
    borderRadius: 4,
    marginBottom: 6,
    marginRight: 4,
  },
  kpiLabel: {
    fontSize: 8,
    textTransform: "uppercase",
    color: "#64748b",
    marginBottom: 2,
  },
  kpiValue: {
    fontSize: 13,
    fontWeight: 700,
  },
  insight: {
    paddingVertical: 4,
    paddingHorizontal: 6,
    borderLeftWidth: 3,
    marginBottom: 4,
    backgroundColor: "#f8fafc",
  },
  insightHead: {
    fontSize: 10,
    fontWeight: 700,
  },
  insightDetail: {
    fontSize: 9,
    color: "#475569",
    marginTop: 2,
  },
  topRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e8f0",
  },
  topCol: {
    fontSize: 9,
  },
  footer: {
    marginTop: 18,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    fontSize: 8,
    color: "#94a3b8",
    textAlign: "center",
  },
});

const insightColours: Record<Insight["kind"], string> = {
  positive: "#15803d",
  neutral: "#475569",
  negative: "#b91c1c",
};

function pct(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return `${n.toFixed(1)}%`;
}

function num(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return String(n);
}

export type AnalyticsPdfInput = {
  generatedAt: string;
  revenue: RevenueAnalytics;
  customer: CustomerAnalytics;
  benchmarks: Benchmarks;
  insights: ReadonlyArray<Insight>;
};

export function AnalyticsPdf({ data }: { data: AnalyticsPdfInput }) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.brand}>CrewFlow HQ · Analytics</Text>
          <Text style={styles.title}>Executive summary</Text>
          <Text style={styles.subtitle}>
            Generated {data.generatedAt.slice(0, 19).replace("T", " ")} UTC ·
            Deterministic rules engine (HQ-6)
          </Text>
        </View>

        <Text style={styles.sectionTitle}>Revenue</Text>
        <View style={styles.kpiGrid}>
          {[
            ["MRR", formatGbp(data.revenue.mrrGbp)],
            ["ARR", formatGbp(data.revenue.arrGbp)],
            ["Growth % MoM", pct(data.revenue.growthPct)],
            ["Churn % 30d", pct(data.revenue.churnPct)],
            ["Forecast 90d", formatGbp(data.revenue.forecast90dGbp)],
            ["Avg cust. value", formatGbp(data.revenue.avgCustomerValueGbp)],
            ["Outstanding", formatGbp(data.revenue.outstandingGbp)],
            ["Paid", formatGbp(data.revenue.paidGbp)],
            ["Lost revenue", formatGbp(data.revenue.lostRevenueGbp)],
          ].map(([label, value], idx) => (
            <View key={idx} style={styles.kpi}>
              <Text style={styles.kpiLabel}>{label}</Text>
              <Text style={styles.kpiValue}>{value}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.sectionTitle}>Customers</Text>
        <View style={styles.kpiGrid}>
          {[
            ["Healthy (≥70)", num(data.customer.healthy)],
            ["At risk (40–69)", num(data.customer.atRisk)],
            ["Critical (<40)", num(data.customer.critical)],
            ["Unscored", num(data.customer.unscored)],
            ["Avg migration %", pct(data.customer.migration.averagePct)],
            [
              "Avg days to migrate",
              num(data.customer.migration.averageDaysToComplete),
            ],
            ["Stalled migrations", num(data.customer.migration.stalledCount)],
            ["Active last 7d", num(data.customer.usage.activeLast7Days)],
            ["Active last 30d", num(data.customer.usage.activeLast30Days)],
          ].map(([label, value], idx) => (
            <View key={idx} style={styles.kpi}>
              <Text style={styles.kpiLabel}>{label}</Text>
              <Text style={styles.kpiValue}>{value}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.sectionTitle}>AI COO insights</Text>
        {data.insights.length === 0 ? (
          <Text style={{ fontSize: 9, color: "#64748b" }}>
            No insights surfaced — portfolio is steady.
          </Text>
        ) : (
          data.insights.slice(0, 8).map((insight) => (
            <View
              key={insight.id}
              style={{
                ...styles.insight,
                borderLeftColor: insightColours[insight.kind],
              }}
            >
              <Text style={styles.insightHead}>{insight.headline}</Text>
              <Text style={styles.insightDetail}>{insight.detail}</Text>
            </View>
          ))
        )}

        <Text style={styles.sectionTitle}>Top customers by MRR</Text>
        {data.benchmarks.topByMrr.length === 0 ? (
          <Text style={{ fontSize: 9, color: "#64748b" }}>None yet.</Text>
        ) : (
          data.benchmarks.topByMrr.map((c) => (
            <View key={c.id} style={styles.topRow}>
              <Text style={[styles.topCol, { fontWeight: 700 }]}>{c.name}</Text>
              <Text style={styles.topCol}>
                {formatGbp(c.mrr)} · Health {num(c.health)}
              </Text>
            </View>
          ))
        )}

        <Text style={styles.sectionTitle}>Benchmarks</Text>
        <View style={styles.kpiGrid}>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>Avg health</Text>
            <Text style={styles.kpiValue}>
              {num(data.benchmarks.averageHealth)}
            </Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>Avg MRR</Text>
            <Text style={styles.kpiValue}>
              {formatGbp(data.benchmarks.averageMrrGbp)}
            </Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>Avg LTV</Text>
            <Text style={styles.kpiValue}>
              {formatGbp(data.benchmarks.averageLtvGbp)}
            </Text>
          </View>
          <View style={styles.kpi}>
            <Text style={styles.kpiLabel}>Avg migration days</Text>
            <Text style={styles.kpiValue}>
              {num(data.benchmarks.averageMigrationDays)}
            </Text>
          </View>
        </View>

        <Text style={styles.footer}>
          CrewFlow HQ executive analytics · confidential · for super-admin use
          only.
        </Text>
      </Page>
    </Document>
  );
}
