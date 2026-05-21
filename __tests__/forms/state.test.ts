import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  INITIAL_FORM_STATE,
  validateFormData,
  formError,
  formSuccess,
  isPristine,
} from "@/lib/forms/state";

const sampleSchema = z.object({
  email: z.string().email("Enter a valid email"),
  name: z.string().min(1, "Required"),
  age: z.coerce.number().int().positive().optional(),
});

function fd(record: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(record)) f.append(k, v);
  return f;
}

describe("validateFormData", () => {
  it("returns parsed data when input is valid", () => {
    const r = validateFormData(fd({ email: "a@b.test", name: "Jane" }), sampleSchema);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.email).toBe("a@b.test");
      expect(r.data.name).toBe("Jane");
    }
  });

  it("returns a structured failure state with per-field errors", () => {
    const r = validateFormData(fd({ email: "bad", name: "" }), sampleSchema);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.state.ok).toBe(false);
      expect(r.state.error).toBeTruthy();
      expect(r.state.fieldErrors.email).toBeTruthy();
      expect(r.state.fieldErrors.name).toBeTruthy();
      expect(r.state.submittedAt).toBeGreaterThan(0);
    }
  });

  it("echoes the submitted values so the form repopulates", () => {
    const r = validateFormData(fd({ email: "bad", name: "Jane" }), sampleSchema);
    if (!r.ok) {
      expect(r.state.values.email).toBe("bad");
      expect(r.state.values.name).toBe("Jane");
    } else {
      throw new Error("expected failure");
    }
  });

  it("merges previous values so unsubmitted fields persist across retries", () => {
    const r = validateFormData(
      fd({ email: "bad" }),
      sampleSchema,
      { name: "Jane" },
    );
    if (!r.ok) {
      expect(r.state.values.name).toBe("Jane");
      expect(r.state.values.email).toBe("bad");
    } else {
      throw new Error("expected failure");
    }
  });

  it("only captures string FormData entries (ignores File/Blob values)", () => {
    const f = new FormData();
    f.append("email", "a@b.test");
    f.append("name", "Jane");
    f.append("avatar", new Blob(["fake"], { type: "image/png" }), "avatar.png");
    const r = validateFormData(f, sampleSchema);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rawValues.avatar).toBeUndefined();
  });
});

describe("formError", () => {
  it("returns ok=false with the given message and echo", () => {
    const s = formError("Network down", { email: "a@b.test" });
    expect(s.ok).toBe(false);
    expect(s.error).toBe("Network down");
    expect(s.values.email).toBe("a@b.test");
    expect(s.fieldErrors).toEqual({});
  });
});

describe("formSuccess", () => {
  it("returns ok=true with success message + optional redirect", () => {
    const s = formSuccess({ successMessage: "Saved.", redirectTo: "/customers" });
    expect(s.ok).toBe(true);
    expect(s.successMessage).toBe("Saved.");
    expect(s.redirectTo).toBe("/customers");
  });

  it("defaults to no message and no redirect", () => {
    const s = formSuccess();
    expect(s.ok).toBe(true);
    expect(s.successMessage).toBeUndefined();
    expect(s.redirectTo).toBeUndefined();
  });
});

describe("isPristine", () => {
  it("is true for the initial state and false after a submit", () => {
    expect(isPristine(INITIAL_FORM_STATE)).toBe(true);
    expect(isPristine({ ...INITIAL_FORM_STATE, submittedAt: Date.now() })).toBe(false);
  });
});
