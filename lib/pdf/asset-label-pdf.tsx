import {
  Document,
  Page,
  Text,
  View,
  Svg,
  Rect,
  StyleSheet,
} from "@react-pdf/renderer";
import QRCode from "qrcode";

/**
 * Asset QR label PDF — reuses the invoice/quote/site-report react-pdf
 * architecture (no new PDF engine). The QR is rendered as TRUE VECTOR: QRCode
 * .create() gives the module matrix, and each dark module is a react-pdf <Rect>
 * inside an <Svg> — crisp at any print size, no rasterised image.
 *
 * Labels carry ONLY safe, public fields (name, reference, category, optional
 * serial/registration, the QR, a scan instruction, org branding). Financial
 * fields (price, value, supplier pricing) and internal notes are never passed in
 * and never rendered.
 */

const styles = StyleSheet.create({
  page: { padding: 18, fontFamily: "Helvetica", color: "#0f172a" },
  sheet: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  label: {
    width: 168,
    borderWidth: 1,
    borderColor: "#cbd5e1",
    borderRadius: 6,
    padding: 10,
    alignItems: "center",
  },
  org: { fontSize: 7, fontWeight: 700, color: "#475569", marginBottom: 4, textAlign: "center" },
  name: { fontSize: 10, fontWeight: 700, textAlign: "center", marginTop: 6 },
  meta: { fontSize: 7, color: "#64748b", textAlign: "center", marginTop: 1 },
  ref: { fontSize: 8, fontFamily: "Courier", color: "#0f172a", marginTop: 2 },
  scan: { fontSize: 7, fontWeight: 700, color: "#0f172a", marginTop: 6, textAlign: "center" },
});

export type AssetLabelInput = {
  org_name: string;
  asset_name: string;
  asset_ref: string | null;
  category: string | null;
  serial_number: string | null;
  registration: string | null;
  scan_url: string;
};

/** A vector QR for `text` at `size` pt (dark modules as <Rect>s). */
function QrCode({ text, size }: { text: string; size: number }) {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const data = qr.modules.data;
  const cell = size / n;
  const rects: React.ReactElement[] = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      if (data[row * n + col]) {
        rects.push(
          <Rect key={row * n + col} x={col * cell} y={row * cell} width={cell} height={cell} fill="#000000" />,
        );
      }
    }
  }
  return (
    <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      {/* Quiet zone / background. */}
      <Rect x={0} y={0} width={size} height={size} fill="#ffffff" />
      {rects}
    </Svg>
  );
}

function Label({ l }: { l: AssetLabelInput }) {
  const idn = l.registration || l.serial_number;
  return (
    <View style={styles.label} wrap={false}>
      <Text style={styles.org}>{l.org_name}</Text>
      <QrCode text={l.scan_url} size={104} />
      <Text style={styles.name}>{l.asset_name}</Text>
      {l.category ? <Text style={styles.meta}>{l.category}</Text> : null}
      {l.asset_ref ? <Text style={styles.ref}>{l.asset_ref}</Text> : null}
      {idn ? <Text style={styles.ref}>{idn}</Text> : null}
      <Text style={styles.scan}>Scan to view asset</Text>
    </View>
  );
}

/**
 * Render `copies` of an asset's label (1 = single; >1 = a print sheet, e.g. 12
 * per A4). The caller resolves the asset + active QR token and builds scan_url.
 */
export function AssetLabelPdf({
  label,
  copies = 1,
}: {
  label: AssetLabelInput;
  copies?: number;
}) {
  const n = Math.max(1, Math.min(60, Math.floor(copies)));
  const items = Array.from({ length: n }, (_, i) => i);
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.sheet}>
          {items.map((i) => (
            <Label key={i} l={label} />
          ))}
        </View>
      </Page>
    </Document>
  );
}
