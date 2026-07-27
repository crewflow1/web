"use client";

import { useState } from "react";
import { CalcCard, CalcInputs, NumberField, SelectField, ResultGrid, Result, gbp } from "./calc-ui";

/**
 * UK VAT calculator — add VAT to a net figure or strip VAT from a gross one.
 * Default 20% standard rate; 5% and 0% included for completeness.
 */
export function VatCalculator() {
  const [amount, setAmount] = useState<number | "">(1000);
  const [rate, setRate] = useState("20");
  const [mode, setMode] = useState("add");

  const a = typeof amount === "number" ? amount : 0;
  const r = Number(rate) / 100;

  let net = a;
  let vat = 0;
  let gross = a;
  if (mode === "add") {
    net = a;
    vat = a * r;
    gross = a + vat;
  } else {
    gross = a;
    net = a / (1 + r);
    vat = gross - net;
  }

  return (
    <CalcCard>
      <CalcInputs>
        <NumberField
          label={mode === "add" ? "Net amount (excl. VAT)" : "Gross amount (incl. VAT)"}
          value={amount}
          onChange={setAmount}
          suffix="£"
        />
        <SelectField
          label="VAT rate"
          value={rate}
          onChange={setRate}
          options={[
            { value: "20", label: "Standard — 20%" },
            { value: "5", label: "Reduced — 5%" },
            { value: "0", label: "Zero — 0%" },
          ]}
        />
        <SelectField
          label="Calculation"
          value={mode}
          onChange={setMode}
          options={[
            { value: "add", label: "Add VAT to a net figure" },
            { value: "remove", label: "Remove VAT from a gross figure" },
          ]}
        />
      </CalcInputs>
      <ResultGrid>
        <Result label="Net (excl. VAT)" value={gbp(net)} />
        <Result label="VAT" value={gbp(vat)} highlight />
        <Result label="Gross (incl. VAT)" value={gbp(gross)} />
      </ResultGrid>
    </CalcCard>
  );
}
