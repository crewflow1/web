import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from "@react-pdf/renderer";

/**
 * Payslip PDF — one per staff member per payroll run.
 *
 * Lays out gross / PAYE / NI / net for the period, plus name + NI no.
 * Estimate-only banner because we're not a full payroll engine.
 */

const styles = StyleSheet.create({
  page: { padding: 40, fontFamily: "Helvetica", fontSize: 10, color: "#0f172a" },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 18,
  },
  title: { fontSize: 18, fontWeight: 700, marginBottom: 2 },
  subtitle: { fontSize: 9, color: "#475569" },
  orgName: { fontSize: 11, fontWeight: 700, color: "#0f172a" },
  orgDetail: { fontSize: 9, color: "#475569" },
  banner: {
    backgroundColor: "#fef3c7",
    borderWidth: 1,
    borderColor: "#fde68a",
    borderRadius: 4,
    padding: 8,
    marginBottom: 14,
    fontSize: 9,
    color: "#78350f",
  },
  sectionTitle: {
    fontSize: 9,
    fontWeight: 700,
    textTransform: "uppercase",
    color: "#64748b",
    marginBottom: 6,
    letterSpacing: 0.5,
  },
  meta: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 12,
    marginBottom: 14,
    backgroundColor: "#f8fafc",
    padding: 12,
    borderRadius: 6,
  },
  metaItem: { minWidth: 110 },
  metaLabel: { fontSize: 8, color: "#64748b", textTransform: "uppercase" },
  metaValue: { fontSize: 11, fontWeight: 700, color: "#0f172a", marginTop: 2 },
  totalsBlock: {
    alignSelf: "flex-end",
    width: 260,
    marginTop: 6,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
  },
  rowLabel: { fontSize: 10, color: "#334155" },
  rowValue: { fontSize: 10, color: "#0f172a" },
  netRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingTop: 8,
    marginTop: 6,
    borderTopWidth: 1,
    borderTopColor: "#0f172a",
  },
  netLabel: { fontSize: 12, fontWeight: 700 },
  netValue: { fontSize: 12, fontWeight: 700 },
  footer: {
    position: "absolute",
    bottom: 24,
    left: 40,
    right: 40,
    fontSize: 8,
    color: "#94a3b8",
    textAlign: "center",
  },
});

const GBP = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "GBP",
  minimumFractionDigits: 2,
});

export type PayslipInput = {
  org_name: string;
  org_phone: string | null;
  full_name: string;
  ni_number: string | null;
  cycle: "weekly" | "monthly" | string;
  period_start: string;
  period_end: string;
  hours: number;
  hourly_pay: number;
  gross_pay: number;
  paye_estimate: number;
  ni_estimate: number;
  net_pay: number;
  /**
   * Per-employee profile deductions. OPTIONAL — absent/0 means the deduction does
   * not apply and its line is hidden, so a standard payslip is unchanged. When a
   * tax profile applies they are shown so the payslip reconciles:
   * net = gross − salary sacrifice − PAYE − NI − student loan − employee pension.
   */
  salary_sacrifice?: number;
  student_loan_estimate?: number;
  employee_pension_estimate?: number;
  /**
   * Overtime + holiday components ALREADY included in gross_pay. OPTIONAL/0 ⇒ their
   * informational lines are hidden, so a standard payslip is unchanged. Shown as a
   * breakdown OF gross (not extra additions) so the figures reconcile.
   */
  overtime_hours?: number;
  overtime_pay?: number;
  holiday_hours?: number;
  holiday_pay?: number;
};

export function PayslipPdf({ data }: { data: PayslipInput }) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>Payslip</Text>
            <Text style={styles.subtitle}>
              {data.cycle} · {data.period_start} → {data.period_end}
            </Text>
          </View>
          <View style={{ alignItems: "flex-end" }}>
            <Text style={styles.orgName}>{data.org_name}</Text>
            {data.org_phone ? (
              <Text style={styles.orgDetail}>{data.org_phone}</Text>
            ) : null}
          </View>
        </View>

        <View style={styles.banner}>
          <Text>
            ESTIMATE ONLY. PAYE + NI are calculated against the standard
            1257L code and the 2025-26 UK thresholds. Confirm with your
            employer / accountant before relying on these figures.
          </Text>
        </View>

        <Text style={styles.sectionTitle}>Employee</Text>
        <View style={styles.meta}>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Name</Text>
            <Text style={styles.metaValue}>{data.full_name}</Text>
          </View>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>NI number</Text>
            <Text style={styles.metaValue}>{data.ni_number ?? "—"}</Text>
          </View>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Hours</Text>
            <Text style={styles.metaValue}>{data.hours.toFixed(2)}</Text>
          </View>
          <View style={styles.metaItem}>
            <Text style={styles.metaLabel}>Hourly rate</Text>
            <Text style={styles.metaValue}>{GBP.format(data.hourly_pay)}</Text>
          </View>
        </View>

        <Text style={styles.sectionTitle}>Pay summary</Text>
        <View style={styles.totalsBlock}>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Gross pay</Text>
            <Text style={styles.rowValue}>{GBP.format(data.gross_pay)}</Text>
          </View>
          {data.overtime_pay && data.overtime_pay > 0 ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>
                incl. overtime ({(data.overtime_hours ?? 0).toFixed(2)}h)
              </Text>
              <Text style={styles.rowValue}>{GBP.format(data.overtime_pay)}</Text>
            </View>
          ) : null}
          {data.holiday_pay && data.holiday_pay > 0 ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>
                incl. holiday pay ({(data.holiday_hours ?? 0).toFixed(2)}h)
              </Text>
              <Text style={styles.rowValue}>{GBP.format(data.holiday_pay)}</Text>
            </View>
          ) : null}
          {data.salary_sacrifice && data.salary_sacrifice > 0 ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Salary sacrifice</Text>
              <Text style={styles.rowValue}>− {GBP.format(data.salary_sacrifice)}</Text>
            </View>
          ) : null}
          <View style={styles.row}>
            <Text style={styles.rowLabel}>PAYE income tax (est)</Text>
            <Text style={styles.rowValue}>− {GBP.format(data.paye_estimate)}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Employee NI (est)</Text>
            <Text style={styles.rowValue}>− {GBP.format(data.ni_estimate)}</Text>
          </View>
          {data.student_loan_estimate && data.student_loan_estimate > 0 ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Student loan (est)</Text>
              <Text style={styles.rowValue}>
                − {GBP.format(data.student_loan_estimate)}
              </Text>
            </View>
          ) : null}
          {data.employee_pension_estimate && data.employee_pension_estimate > 0 ? (
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Pension contribution (est)</Text>
              <Text style={styles.rowValue}>
                − {GBP.format(data.employee_pension_estimate)}
              </Text>
            </View>
          ) : null}
          <View style={styles.netRow}>
            <Text style={styles.netLabel}>Net pay (take home)</Text>
            <Text style={styles.netValue}>{GBP.format(data.net_pay)}</Text>
          </View>
        </View>

        <Text style={styles.footer} fixed>
          {data.org_name} · Payslip · estimate only · generated by CrewFlow
        </Text>
      </Page>
    </Document>
  );
}
