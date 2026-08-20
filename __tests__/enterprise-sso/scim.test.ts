import { describe, it, expect } from "vitest";
import {
  extractScimEmail,
  readActivePatch,
  parseScimUserNameFilter,
  toScimUser,
  scimListResponse,
  SCIM_USER_SCHEMA,
} from "@/lib/enterprise-sso/scim";

describe("extractScimEmail", () => {
  it("prefers the primary email", () => {
    expect(
      extractScimEmail({
        emails: [
          { value: "second@x.com" },
          { value: "Primary@X.com", primary: true },
        ],
      }),
    ).toBe("primary@x.com");
  });

  it("falls back to the first email, then to an email userName", () => {
    expect(extractScimEmail({ emails: [{ value: "a@b.com" }] })).toBe("a@b.com");
    expect(extractScimEmail({ userName: "U@B.com" })).toBe("u@b.com");
  });

  it("returns null when no email is present", () => {
    expect(extractScimEmail({ userName: "not-an-email" })).toBeNull();
    expect(extractScimEmail({})).toBeNull();
    expect(extractScimEmail(null)).toBeNull();
  });
});

describe("readActivePatch", () => {
  it("reads active:false from a value-object replace op", () => {
    expect(
      readActivePatch({ Operations: [{ op: "replace", value: { active: false } }] }),
    ).toBe(false);
  });

  it("reads active:false from a path-based replace op (string value)", () => {
    expect(
      readActivePatch({ Operations: [{ op: "Replace", path: "active", value: "False" }] }),
    ).toBe(false);
  });

  it("reads active:true", () => {
    expect(readActivePatch({ Operations: [{ op: "replace", path: "active", value: true }] })).toBe(
      true,
    );
  });

  it("returns null when the patch does not touch active", () => {
    expect(readActivePatch({ Operations: [{ op: "replace", path: "displayName", value: "x" }] })).toBeNull();
    expect(readActivePatch({})).toBeNull();
  });
});

describe("parseScimUserNameFilter", () => {
  it('parses userName eq "email"', () => {
    expect(parseScimUserNameFilter('userName eq "A@b.com"')).toBe("a@b.com");
  });
  it("returns null for no/other filter", () => {
    expect(parseScimUserNameFilter(null)).toBeNull();
    expect(parseScimUserNameFilter('displayName eq "x"')).toBeNull();
  });
});

describe("toScimUser + list", () => {
  it("projects a member into a SCIM User", () => {
    const u = toScimUser({ userId: "u1", email: "a@b.com", fullName: "A B", active: true });
    expect(u.schemas).toContain(SCIM_USER_SCHEMA);
    expect(u.id).toBe("u1");
    expect(u.userName).toBe("a@b.com");
    expect(u.active).toBe(true);
    expect(u.name?.formatted).toBe("A B");
  });

  it("wraps resources in a ListResponse", () => {
    const list = scimListResponse([toScimUser({ userId: "u1", email: "a@b.com", active: true })]);
    expect(list.totalResults).toBe(1);
    expect(list.Resources).toHaveLength(1);
  });
});
