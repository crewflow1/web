/**
 * Transcription self-test audio — a ~2-second WAV generated IN PROCESS.
 *
 * Pure PCM synthesis (mono 16-bit 8 kHz sine), no external asset, no I/O, no
 * env read — so the super-admin self-test on /admin/ai-costs can exercise the
 * REAL governed transcription path (`transcribeVoiceNoteGoverned`) without
 * shipping a binary fixture or touching tenant audio. Our own synthetic bytes:
 * rendering the resulting transcript leaks nothing.
 *
 * THE NONCE IS LOAD-BEARING. The governor deduplicates on the SHA-256 of the
 * exact audio bytes (900s window), and the seam's persist-first check keys on
 * the same hash — byte-identical runs would collapse into duplicate/deferred
 * outcomes and the self-test would stop proving the provider. Folding the
 * nonce into the tone's frequency (and the byte stream) makes every run's
 * bytes unique, so each self-test is a genuine reservation → provider →
 * settle → ledger pass. A sine tone has no speech, so an EMPTY transcript is
 * the expected `completed` result — the test proves the PATH, not the prose.
 */

/** Nominal duration of the generated clip, for the declared-duration field. */
export const SELFTEST_WAV_SECONDS = 2;

const SAMPLE_RATE = 8_000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;

/** Build the self-test WAV. Deterministic for a given nonce; pure and total. */
export function buildSelftestWav(nonce: number): Uint8Array {
  const sampleCount = SAMPLE_RATE * SELFTEST_WAV_SECONDS;
  const dataBytes = sampleCount * (BITS_PER_SAMPLE / 8) * CHANNELS;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);

  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };

  // RIFF header.
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, "WAVE");
  // fmt chunk — PCM.
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * CHANNELS * (BITS_PER_SAMPLE / 8), true);
  view.setUint16(32, CHANNELS * (BITS_PER_SAMPLE / 8), true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  // data chunk.
  writeAscii(36, "data");
  view.setUint32(40, dataBytes, true);

  // A quiet sine whose frequency carries the nonce (300–499 Hz), so no two
  // runs share bytes and the dedupe hash never collides across self-tests.
  const freq = 300 + (Math.abs(Math.trunc(nonce)) % 200);
  const amplitude = 0.2 * 0x7fff;
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE));
    view.setInt16(44 + i * 2, sample, true);
  }

  return new Uint8Array(buf);
}
