import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import type { EotEvidencePack, EotPackEvent, EotWeatherEvidence } from "@/lib/eot/pack";

/**
 * EOT evidence pack PDF. Server-side only via @react-pdf renderToBuffer —
 * the rams-pdf architecture, no new engine. The input is the pure pack shape
 * from lib/eot/pack.ts, so this template is unit-testable without the DB.
 *
 * EVIDENCE ASSEMBLY, NOT A CLAIM — and the document SAYS SO, in its own
 * header: recorded delay events only (the pack excludes drafts and withdrawn
 * events by construction), the working-days figures are the recorder's
 * claims, the gaps are printed rather than hidden, and no contractual claim
 * letter is generated. Human review is the point.
 *
 * Carries NO money: the pack shape has no amount/cost/total field to render.
 */

export type EotPackPdfInput = {
  org_name: string;
  job_label: string;
  pack: EotEvidencePack;
};

const c = {
  ink: "#0f172a",
  sub: "#475569",
  line: "#e2e8f0",
  head: "#1e293b",
  amber: "#b45309",
};
const s = StyleSheet.create({
  page: { padding: 34, fontSize: 9, color: c.ink, fontFamily: "Helvetica" },
  orgName: { fontSize: 14, fontFamily: "Helvetica-Bold" },
  docType: { fontSize: 9, color: c.sub, marginTop: 2 },
  headRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 2,
    borderBottomColor: c.head,
    paddingBottom: 8,
    marginBottom: 10,
  },
  h1: { fontSize: 13, fontFamily: "Helvetica-Bold", marginBottom: 2 },
  notice: {
    borderWidth: 1,
    borderColor: c.line,
    backgroundColor: "#f8fafc",
    padding: 8,
    marginTop: 8,
    marginBottom: 10,
  },
  noticeText: { fontSize: 8, color: c.sub, lineHeight: 1.5 },
  sectionH: {
    fontSize: 10.5,
    fontFamily: "Helvetica-Bold",
    marginTop: 12,
    marginBottom: 5,
    color: c.head,
  },
  metaGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 6, marginBottom: 6 },
  metaCell: { width: "25%", marginBottom: 6 },
  metaLabel: { fontSize: 7.5, color: c.sub, textTransform: "uppercase" },
  metaVal: { fontSize: 9.5 },
  event: {
    borderWidth: 1,
    borderColor: c.line,
    borderRadius: 2,
    padding: 8,
    marginBottom: 6,
  },
  eventHead: { flexDirection: "row", justifyContent: "space-between", marginBottom: 3 },
  eventDates: { fontSize: 8.5, color: c.sub },
  desc: { fontSize: 9, lineHeight: 1.45, color: "#334155", marginTop: 2 },
  evidence: { fontSize: 8, color: c.sub, marginTop: 4, lineHeight: 1.4 },
  gap: { fontSize: 8.5, color: c.amber, marginBottom: 2 },
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

const dd = (x: string | null): string => (x ? x.slice(0, 10) : "—");

/**
 * The dark-state weather line — printed ONLY when a weather event carries a
 * postcode district but the caller resolved no observed readings (provider
 * dark, cache empty). Honest by construction: it says none is today.
 */
export function weatherDarkLine(district: string): string {
  return `Postcode district ${district} — observed weather readings will attach here when a weather provider is connected (none is today).`;
}

/**
 * Render the OBSERVED weather evidence for one delay event as a single sentence.
 *
 * Every metric is `number | null`, and `null` means "no reading reported this
 * metric" (the assembly layer's rule) — so a null is OMITTED, never printed as
 * zero, which would read as calm/dry on a contractual document. Present metrics
 * are printed with their observed values and units. Used INSTEAD OF the dark
 * placeholder whenever real readings exist, so the false "none is today" can
 * never print alongside evidence.
 */
export function weatherEvidenceLine(ev: EotWeatherEvidence): string {
  const parts: string[] = [];
  if (ev.minAirTempC !== null) parts.push(`min air temp ${ev.minAirTempC}°C`);
  if (ev.maxWindSpeedMs !== null) parts.push(`max mean wind ${ev.maxWindSpeedMs} m/s`);
  if (ev.maxWindGustMs !== null) parts.push(`max gust ${ev.maxWindGustMs} m/s`);
  if (ev.maxPrecipRateMmH !== null) parts.push(`peak rainfall ${ev.maxPrecipRateMmH} mm/h`);
  if (ev.totalPrecipMm !== null) parts.push(`total rainfall ${ev.totalPrecipMm} mm`);
  const readings = `${ev.readingCount} observed reading${ev.readingCount === 1 ? "" : "s"}`;
  const metrics = parts.length > 0 ? `: ${parts.join(", ")}.` : " — no metric values reported.";
  return `Postcode district ${ev.district} — ${readings} over the delay window${metrics}`;
}

function EventBlock({ e }: { e: EotPackEvent }) {
  return (
    <View style={s.event} wrap={false}>
      <View style={s.eventHead}>
        <Text style={{ fontSize: 9.5, fontFamily: "Helvetica-Bold" }}>
          {dd(e.startedOn)} → {e.endedOn ? dd(e.endedOn) : "ongoing"}
          {e.calendarDaysSpanned !== null ? `  (${e.calendarDaysSpanned} calendar days)` : ""}
        </Text>
        <Text style={{ fontSize: 9 }}>
          {e.workingDaysLost !== null
            ? `${e.workingDaysLost} working day${e.workingDaysLost === 1 ? "" : "s"} claimed`
            : "not yet quantified"}
        </Text>
      </View>
      <Text style={s.desc}>{e.description}</Text>
      {e.diaryEntry ? (
        <Text style={s.evidence}>
          Site diary, {dd(e.diaryEntry.entry_date)}
          {e.diaryEntry.weather ? ` — weather: ${e.diaryEntry.weather}` : ""}
          {e.diaryEntry.labour_count !== null ? ` — ${e.diaryEntry.labour_count} on site` : ""}
          {e.diaryEntry.delays ? ` — delays noted: ${e.diaryEntry.delays}` : ""}
        </Text>
      ) : (
        <Text style={{ ...s.evidence, color: c.amber }}>No site diary entry linked.</Text>
      )}
      {e.variation ? (
        <Text style={s.evidence}>
          Variation #{String(e.variation.variationNumber ?? 0).padStart(3, "0")}
          {e.variation.title ? ` — ${e.variation.title}` : ""}
          {e.variation.requestedCompletionDate
            ? ` — EoT requested to ${dd(e.variation.requestedCompletionDate)}`
            : ""}
          {e.variation.agreedCompletionDate
            ? `, agreed to ${dd(e.variation.agreedCompletionDate)}`
            : ""}
        </Text>
      ) : null}
      {e.weatherEvidence ? (
        <Text style={s.evidence}>{weatherEvidenceLine(e.weatherEvidence)}</Text>
      ) : e.weatherDistrict ? (
        <Text style={s.evidence}>{weatherDarkLine(e.weatherDistrict)}</Text>
      ) : null}
      <Text style={{ ...s.evidence, fontSize: 7 }}>
        Recorded {e.recordedAt ? e.recordedAt.slice(0, 16).replace("T", " ") : "—"} · ref {e.id}
      </Text>
    </View>
  );
}

export function EotPackPdf({ input }: { input: EotPackPdfInput }) {
  const { pack } = input;
  const progress = pack.progress;
  return (
    <Document title={`EOT evidence pack — ${input.job_label}`}>
      <Page size="A4" style={s.page}>
        <View style={s.headRow}>
          <View>
            <Text style={s.orgName}>{input.org_name}</Text>
            <Text style={s.docType}>Extension of Time — Evidence Pack</Text>
          </View>
          <View>
            <Text style={{ ...s.docType, textAlign: "right" }}>
              Generated {pack.generatedAt.slice(0, 16).replace("T", " ")}
            </Text>
          </View>
        </View>

        <Text style={s.h1}>{input.job_label}</Text>

        <View style={s.notice}>
          <Text style={s.noticeText}>
            This document ASSEMBLES the delay evidence recorded for this job. It is not
            a contractual claim and no claim letter is generated: whether any event is a
            relevant/compensation event under the contract, and what extension it
            justifies, are judgements for the person preparing the claim. It contains
            RECORDED events only (drafts and withdrawn events are excluded and counted
            below). All working-days figures are the recorder&apos;s own claims — nothing
            in this pack is computed from the calendar. Evidence gaps are listed, not
            hidden.
          </Text>
        </View>

        <View style={s.metaGrid}>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Recorded events</Text>
            <Text style={s.metaVal}>{pack.recordedEventCount}</Text>
          </View>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Working days claimed</Text>
            <Text style={s.metaVal}>{pack.totalClaimedWorkingDaysLost}</Text>
          </View>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Drafts (excluded)</Text>
            <Text style={s.metaVal}>{pack.draftEventCount}</Text>
          </View>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Withdrawn (excluded)</Text>
            <Text style={s.metaVal}>{pack.withdrawnEventCount}</Text>
          </View>
        </View>

        {pack.categories.map((block) => (
          <View key={block.category}>
            <Text style={s.sectionH}>
              {block.label} — {block.events.length} event
              {block.events.length === 1 ? "" : "s"}, {block.claimedWorkingDaysLost} working
              day{block.claimedWorkingDaysLost === 1 ? "" : "s"} claimed
              {block.unquantifiedEvents > 0
                ? ` (${block.unquantifiedEvents} not yet quantified)`
                : ""}
            </Text>
            {block.events.map((e) => (
              <EventBlock key={e.id} e={e} />
            ))}
          </View>
        ))}

        {pack.eotVariations.length > 0 ? (
          <View>
            <Text style={s.sectionH}>Extensions of time formally requested</Text>
            {pack.eotVariations.map((v) => (
              <Text key={v.id} style={{ fontSize: 9, marginBottom: 3 }}>
                Variation #{String(v.variationNumber ?? 0).padStart(3, "0")}
                {v.title ? ` — ${v.title}` : ""}: requested completion{" "}
                {dd(v.requestedCompletionDate)}
                {v.agreedCompletionDate
                  ? `; agreed ${dd(v.agreedCompletionDate)}${
                      v.agreedVsRequestedDays !== null
                        ? ` (${v.agreedVsRequestedDays >= 0 ? "+" : ""}${v.agreedVsRequestedDays} days vs requested)`
                        : ""
                    }`
                  : "; not yet agreed"}
                {v.accepted ? " · variation accepted" : ""}
              </Text>
            ))}
          </View>
        ) : null}

        {progress ? (
          <View>
            <Text style={s.sectionH}>Progress context</Text>
            <Text style={{ fontSize: 9, lineHeight: 1.45 }}>
              {progress.points.length === 0
                ? "No progress readings exist for this job."
                : `${progress.points.length} progress reading${
                    progress.points.length === 1 ? "" : "s"
                  } between ${dd(progress.points[0]?.day ?? null)} and ${dd(
                    progress.latest?.day ?? null,
                  )}; latest ${progress.percent ?? "—"}% on ${dd(progress.latest?.day ?? null)}.`}
            </Text>
          </View>
        ) : null}

        {pack.gaps.length > 0 ? (
          <View>
            <Text style={s.sectionH}>Evidence gaps ({pack.gaps.length})</Text>
            {pack.gaps.map((g, i) => (
              <Text key={`${g.kind}-${g.eventId ?? "job"}-${i}`} style={s.gap}>
                • {g.message}
                {g.eventId ? ` (event ${g.eventId.slice(0, 8)}…)` : ""}
              </Text>
            ))}
          </View>
        ) : null}

        <View style={s.footer} fixed>
          <Text>
            {input.org_name} — EOT evidence pack. Assembled for human review; not a
            contractual claim.
          </Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}
