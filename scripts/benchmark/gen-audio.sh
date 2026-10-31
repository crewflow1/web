#!/bin/bash
# Generate SYNTHETIC audio fixtures for the STT benchmark using macOS `say`.
# No real voice, no real data. Output WAVs are gitignored (see .gitignore).
# Usage: bash scripts/benchmark/gen-audio.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/audio"
mkdir -p "$OUT"

if ! command -v say >/dev/null 2>&1; then
  echo "macOS 'say' not available — cannot generate synthetic audio here."
  exit 2
fi

node -e '
const fs=require("fs");
const f=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
for(const it of f.items){ console.log(it.id+"\t"+(it.voice||"Daniel")+"\t"+it.reference.replace(/\n/g," ")); }
' "$DIR/fixtures/12-stt-transcripts.json" | while IFS=$'\t' read -r id voice text; do
  echo "Generating $id ($voice)"
  # AIFF then convert to 16k mono WAV (faster-whisper/whisper.cpp friendly)
  say -v "$voice" -o "$OUT/$id.aiff" "$text" 2>/dev/null || say -o "$OUT/$id.aiff" "$text"
  if command -v ffmpeg >/dev/null 2>&1; then
    ffmpeg -y -loglevel error -i "$OUT/$id.aiff" -ar 16000 -ac 1 "$OUT/$id.wav"
    rm -f "$OUT/$id.aiff"
  else
    # afconvert is always present on macOS
    afconvert -f WAVE -d LEI16@16000 -c 1 "$OUT/$id.aiff" "$OUT/$id.wav"
    rm -f "$OUT/$id.aiff"
  fi
done
echo "Audio written to $OUT"
ls -la "$OUT"
