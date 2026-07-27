"use client";

import { useState } from "react";
import { CalcCard, CalcInputs, NumberField, ResultGrid, Result, num } from "./calc-ui";

/**
 * Concrete volume calculator. Volume = L × W × depth, +10% waste allowance.
 * Bag estimate uses ~0.0095 m³ yield per 20kg bag of ready-mix (a standard
 * trade figure; stated on the page).
 */
const M3_PER_20KG_BAG = 0.0095;

export function ConcreteCalculator() {
  const [length, setLength] = useState<number | "">(5);
  const [width, setWidth] = useState<number | "">(3);
  const [depthMm, setDepthMm] = useState<number | "">(100);

  const l = typeof length === "number" ? length : 0;
  const w = typeof width === "number" ? width : 0;
  const d = (typeof depthMm === "number" ? depthMm : 0) / 1000;

  const volume = l * w * d;
  const withWaste = volume * 1.1;
  const bags = Math.ceil(withWaste / M3_PER_20KG_BAG);

  return (
    <CalcCard>
      <CalcInputs>
        <NumberField label="Length" value={length} onChange={setLength} suffix="m" />
        <NumberField label="Width" value={width} onChange={setWidth} suffix="m" />
        <NumberField label="Depth / thickness" value={depthMm} onChange={setDepthMm} suffix="mm" />
      </CalcInputs>
      <ResultGrid>
        <Result label="Volume" value={`${num(volume, 2)} m³`} />
        <Result label="Incl. 10% waste" value={`${num(withWaste, 2)} m³`} highlight />
        <Result label="20kg ready-mix bags" value={num(bags, 0)} />
      </ResultGrid>
    </CalcCard>
  );
}
