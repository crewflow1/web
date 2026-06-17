"use client";

import { useState } from "react";
import { CalcCard, CalcInputs, NumberField, SelectField, ResultGrid, Result, num } from "./calc-ui";

/**
 * Brick calculator. UK standard: 60 bricks per m² for a single-skin wall of
 * standard 215×102.5×65mm bricks with 10mm mortar joints; ×2 for a double
 * skin. Adds a 10% wastage allowance (cuts + breakages).
 */
const BRICKS_PER_M2 = 60;

export function BrickCalculator() {
  const [length, setLength] = useState<number | "">(10);
  const [height, setHeight] = useState<number | "">(2.4);
  const [skin, setSkin] = useState("1");

  const l = typeof length === "number" ? length : 0;
  const h = typeof height === "number" ? height : 0;

  const area = l * h;
  const skins = Number(skin);
  const base = area * BRICKS_PER_M2 * skins;
  const withWaste = Math.ceil(base * 1.1);

  return (
    <CalcCard>
      <CalcInputs>
        <NumberField label="Wall length" value={length} onChange={setLength} suffix="m" />
        <NumberField label="Wall height" value={height} onChange={setHeight} suffix="m" />
        <SelectField
          label="Wall type"
          value={skin}
          onChange={setSkin}
          options={[
            { value: "1", label: "Single skin (½ brick)" },
            { value: "2", label: "Double skin (1 brick)" },
          ]}
        />
      </CalcInputs>
      <ResultGrid>
        <Result label="Wall area" value={`${num(area, 2)} m²`} />
        <Result label="Bricks (incl. 10% waste)" value={num(withWaste, 0)} highlight />
        <Result label="At 60 bricks / m²" value={`×${skins} skin${skins > 1 ? "s" : ""}`} />
      </ResultGrid>
    </CalcCard>
  );
}
