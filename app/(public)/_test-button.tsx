"use client";

import { useState } from "react";
import { testAction } from "./test-action";

/**
 * Diagnostic-only test trigger. Visible only when ?probe=1 is in the URL.
 * Calls a minimal server action so we can isolate whether dispatch works
 * at all. Delete after the demo flow is fixed.
 */
export function TestButton() {
  const [out, setOut] = useState<string>("");
  const [show, setShow] = useState<boolean>(false);
  if (typeof window !== "undefined" && !show && window.location.search.includes("probe=1")) {
    setShow(true);
  }
  if (!show) return null;
  return (
    <div style={{ position: "fixed", bottom: 8, right: 8, zIndex: 9999 }}>
      <button
        type="button"
        onClick={async () => {
          setOut("…");
          try {
            const r = await testAction();
            setOut(JSON.stringify(r));
          } catch (err) {
            setOut(`ERR: ${(err as Error).message}`);
          }
        }}
        style={{ padding: "6px 10px", background: "#111", color: "#fff", borderRadius: 6 }}
      >
        Probe minimal action
      </button>
      <div
        style={{
          marginTop: 6,
          fontSize: 11,
          color: "#111",
          background: "#fff",
          padding: 4,
          border: "1px solid #ccc",
        }}
      >
        {out}
      </div>
    </div>
  );
}
