"use client";

import { useState } from "react";
import { CalcCard, CalcInputs, NumberField, SelectField, ResultGrid, Result, gbp, num } from "./calc-ui";

/**
 * Markup vs margin calculator. Markup and margin are the most-confused
 * numbers in construction pricing, so this shows price, profit AND the
 * equivalent of whichever the user didn't enter.
 */
export function MarkupCalculator() {
  const [cost, setCost] = useState<number | "">(1000);
  const [mode, setMode] = useState("margin");
  const [pct, setPct] = useState<number | "">(30);

  const c = typeof cost === "number" ? cost : 0;
  const p = (typeof pct === "number" ? pct : 0) / 100;

  let price = c;
  let marginPct = 0;
  let markupPct = 0;
  if (mode === "margin") {
    price = p < 1 ? c / (1 - p) : 0;
    marginPct = p * 100;
    markupPct = p < 1 ? (p / (1 - p)) * 100 : 0;
  } else {
    price = c * (1 + p);
    markupPct = p * 100;
    marginPct = 1 + p > 0 ? (p / (1 + p)) * 100 : 0;
  }
  const profit = price - c;

  return (
    <CalcCard>
      <CalcInputs>
        <NumberField label="Job cost (labour + materials)" value={cost} onChange={setCost} suffix="£" />
        <SelectField
          label="Price using"
          value={mode}
          onChange={setMode}
          options={[
            { value: "margin", label: "Target margin %" },
            { value: "markup", label: "Markup %" },
          ]}
        />
        <NumberField
          label={mode === "margin" ? "Target margin" : "Markup"}
          value={pct}
          onChange={setPct}
          suffix="%"
        />
      </CalcInputs>
      <ResultGrid>
        <Result label="Price to quote" value={gbp(price)} highlight />
        <Result label="Profit" value={gbp(profit)} />
        <Result
          label={mode === "margin" ? `Equivalent markup` : `Equivalent margin`}
          value={`${num(mode === "margin" ? markupPct : marginPct, 1)}%`}
        />
      </ResultGrid>
    </CalcCard>
  );
}
