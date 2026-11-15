/* eslint-disable @typescript-eslint/no-explicit-any -- see _fixture.ts */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describeIntegration, serviceClient } from "../_harness";
import { createWorld, destroyWorld, decodeJwt, loadSurface, rawFetch, type Surface, type World } from "./_fixture";
import { writeReport } from "./_report";

/**
 * ATTACK 5 (+ the Storage half of ATTACK 1) — every bucket, catalogue-driven.
 *
 * For EVERY bucket in storage.buckets (so a bucket added next month is attacked too)
 * the service role plants one object under org B's prefix (`<orgB>/adv/…`) and one
 * under org A's. Then the anonymous public-key holder and org A's owner + staff try,
 * against the raw Storage API:
 *
 *   list        POST /object/list/<bucket>        prefix = <orgB>/, "" and a traversal
 *   download    GET  /object/<bucket>/<path>      + /authenticated/ + /public/ variants
 *   sign        POST /object/sign/<bucket>/<path> (mint a signed URL for B's object)
 *   upload      POST /object/<bucket>/<orgB>/…    (forge a file into B's folder)
 *   overwrite   PUT  /object/<bucket>/<B's path>
 *   delete      DELETE /object/<bucket>/<B's path>
 *   move / copy POST /object/move|copy            B's object → the attacker's own folder
 *   traversal   <orgA>/../<orgB>/…  and  <orgA>/%2e%2e/<orgB>/…  as the object name
 *
 * Verdict = ground truth: no attacker response may carry B's bytes (a per-object
 * marker), B's object must still exist byte-identical, and no new object may appear
 * under B's prefix.
 *
 * It also pins two platform facts the product relies on:
 *   * no bucket is public (a public bucket serves every object to anyone with the path);
 *   * clients cannot write bytes AT ALL — not even into their own org's folder. Uploads
 *     go through server routes with the service role (storage-evidence wave), so a
 *     client INSERT/UPDATE/DELETE policy appearing on storage.objects is a regression.
 */

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

type Planted = { bucket: string; pathA: string; pathB: string; marker: string; bytes: Buffer; contentType: string };

describeIntegration("ADVERSARIAL · storage — cross-org objects, traversal, signed URLs, every bucket", () => {
  let w: World | null = null;
  let surface: Surface;
  const planted: Planted[] = [];
  const unplantable: Record<string, string> = {};
  const report: any[] = [];

  beforeAll(async () => {
    surface = await loadSurface();
    w = await createWorld("sectenant-st");
    for (const b of surface.buckets) {
      // Try a PNG first (most buckets allow it), then a PDF, then CSV — whichever the
      // bucket's allowed_mime_types accepts. The marker makes B's bytes recognisable.
      const marker = `ADV-MARKER-${w.tag}-${b.id}`;
      const candidates: { ext: string; contentType: string; bytes: Buffer }[] = [
        { ext: "png", contentType: "image/png", bytes: Buffer.concat([PNG_1PX, Buffer.from(marker)]) },
        { ext: "pdf", contentType: "application/pdf", bytes: Buffer.from(`%PDF-1.4\n% ${marker}\n`) },
        { ext: "csv", contentType: "text/csv", bytes: Buffer.from(`a,b\n${marker},1\n`) },
      ];
      let done = false;
      let lastErr = "";
      for (const c of candidates) {
        const pathB = `${w.B.id}/adv/${w.tag}.${c.ext}`;
        const pathA = `${w.A.id}/adv/${w.tag}.${c.ext}`;
        const upB = await serviceClient().storage.from(b.id).upload(pathB, c.bytes, { contentType: c.contentType, upsert: true });
        if (upB.error) {
          lastErr = upB.error.message;
          continue;
        }
        await serviceClient().storage.from(b.id).upload(pathA, c.bytes, { contentType: c.contentType, upsert: true });
        planted.push({ bucket: b.id, pathA, pathB, marker, bytes: c.bytes, contentType: c.contentType });
        done = true;
        break;
      }
      if (!done) unplantable[b.id] = lastErr;
    }
  }, 300_000);

  afterAll(async () => {
    writeReport("storage.json", { buckets: surface?.buckets, planted: planted.map((p) => p.bucket), unplantable, report });
    for (const p of planted) {
      await serviceClient().storage.from(p.bucket).remove([p.pathA, p.pathB]);
    }
    await destroyWorld(w);
  }, 300_000);

  it("no bucket is public", () => {
    expect(surface.buckets.length).toBeGreaterThan(5);
    expect(surface.buckets.filter((b) => b.public).map((b) => b.id)).toEqual([]);
  });

  it("the fixture could plant an object in every bucket (the attack is not vacuous)", () => {
    expect(unplantable, "buckets the fixture could not seed").toEqual({});
    expect(planted.length).toBe(surface.buckets.length);
  });

  it("anon / A-owner / A-staff cannot list, read, sign, forge, overwrite, delete, move or copy org B's objects in ANY bucket", async () => {
    const world = w!;
    const attackers: { label: string; bearer: string | undefined }[] = [
      { label: "anon", bearer: undefined },
      { label: "A-owner", bearer: world.A.owner.token },
      { label: "A-staff", bearer: world.A.staff.token },
    ];
    const violations: string[] = [];

    for (const p of planted) {
      const enc = (s: string) => s.split("/").map(encodeURIComponent).join("/");
      const traversals = [
        `${world.A.id}/../${p.pathB}`,
        `${world.A.id}/%2e%2e/${p.pathB}`,
        `${world.A.id}/..%2f${p.pathB}`,
        `./${p.pathB}`,
        `/${p.pathB}`,
      ];
      for (const atk of attackers) {
        const tag = `${p.bucket} · ${atk.label}`;
        const leaked = (text: string) => text.includes(p.marker);

        // LIST
        for (const prefix of [`${world.B.id}/adv`, `${world.B.id}`, "", `${world.A.id}/../${world.B.id}/adv`]) {
          const r = await rawFetch(`/storage/v1/object/list/${p.bucket}`, {
            method: "POST",
            bearer: atk.bearer,
            body: { prefix, limit: 100, offset: 0 },
          });
          const names = Array.isArray(r.json) ? r.json.map((o: any) => String(o.name)) : [];
          const sees =
            names.some((n: string) => n.includes(world.tag)) && prefix.includes(world.B.id) ||
            (prefix === "" && names.includes(world.B.id));
          report.push({ op: "list", bucket: p.bucket, attacker: atk.label, prefix, status: r.status, n: names.length });
          if (sees) violations.push(`${tag} · LIST prefix="${prefix}" returned org B entries: ${names.join(",")}`);
        }

        // DOWNLOAD (all three URL shapes + traversal names)
        for (const path of [p.pathB, ...traversals]) {
          for (const shape of ["", "authenticated/", "public/"]) {
            const r = await rawFetch(`/storage/v1/object/${shape}${p.bucket}/${path.includes("%") ? path : enc(path)}`, { bearer: atk.bearer });
            if (shape === "" && path === p.pathB) report.push({ op: "download", bucket: p.bucket, attacker: atk.label, status: r.status });
            if (r.status === 200 && leaked(r.text)) violations.push(`${tag} · DOWNLOAD ${shape}${path} returned org B's bytes`);
          }
        }

        // SIGN — mint a signed URL for B's object, then try to redeem it.
        const sign = await rawFetch(`/storage/v1/object/sign/${p.bucket}/${enc(p.pathB)}`, {
          method: "POST",
          bearer: atk.bearer,
          body: { expiresIn: 600 },
        });
        report.push({ op: "sign", bucket: p.bucket, attacker: atk.label, status: sign.status });
        const signedURL: string | undefined = sign.json?.signedURL ?? sign.json?.signedUrl;
        if (sign.status === 200 && signedURL) {
          const got = await rawFetch(`/storage/v1${signedURL}`, { bearer: null });
          if (got.status === 200 && leaked(got.text)) violations.push(`${tag} · SIGN minted a working signed URL for org B's object`);
        }
        const signMany = await rawFetch(`/storage/v1/object/sign/${p.bucket}`, {
          method: "POST",
          bearer: atk.bearer,
          body: { expiresIn: 600, paths: [p.pathB] },
        });
        for (const s of Array.isArray(signMany.json) ? signMany.json : []) {
          if (s?.signedURL) {
            const got = await rawFetch(`/storage/v1${s.signedURL}`, { bearer: null });
            if (got.status === 200 && leaked(got.text)) violations.push(`${tag} · SIGN(batch) minted a working signed URL for org B's object`);
          }
        }

        // UPLOAD a forgery into B's folder (and via traversal from A's folder).
        const forged = `${world.B.id}/adv/forged-${atk.label}.${p.pathB.split(".").pop()}`;
        for (const dest of [forged, `${world.A.id}/../${forged}`]) {
          const up = await fetchUpload(p.bucket, dest, p.bytes, p.contentType, atk.bearer, "POST");
          if (dest === forged) report.push({ op: "upload-into-B", bucket: p.bucket, attacker: atk.label, status: up });
        }
        // OVERWRITE B's object.
        const ow = await fetchUpload(p.bucket, p.pathB, Buffer.from("PWNED"), p.contentType, atk.bearer, "PUT");
        report.push({ op: "overwrite", bucket: p.bucket, attacker: atk.label, status: ow });
        // DELETE B's object (single + batch form).
        const del = await rawFetch(`/storage/v1/object/${p.bucket}/${enc(p.pathB)}`, { method: "DELETE", bearer: atk.bearer });
        report.push({ op: "delete", bucket: p.bucket, attacker: atk.label, status: del.status });
        await rawFetch(`/storage/v1/object/${p.bucket}`, { method: "DELETE", bearer: atk.bearer, body: { prefixes: [p.pathB] } });
        // MOVE / COPY B's object into the attacker's folder.
        const stolen = `${world.A.id}/adv/stolen-${atk.label}.${p.pathB.split(".").pop()}`;
        for (const op of ["copy", "move"] as const) {
          const r = await rawFetch(`/storage/v1/object/${op}`, {
            method: "POST",
            bearer: atk.bearer,
            body: { bucketId: p.bucket, sourceKey: p.pathB, destinationKey: stolen },
          });
          report.push({ op, bucket: p.bucket, attacker: atk.label, status: r.status });
        }

        // GROUND TRUTH after this attacker's salvo.
        const still = await serviceClient().storage.from(p.bucket).download(p.pathB);
        if (still.error || !still.data) violations.push(`${tag} · org B's object is GONE`);
        else if (!Buffer.from(await still.data.arrayBuffer()).equals(p.bytes)) violations.push(`${tag} · org B's object was OVERWRITTEN`);
        const listB = await serviceClient().storage.from(p.bucket).list(`${world.B.id}/adv`);
        const extra = (listB.data ?? []).map((o) => o.name).filter((n) => n.startsWith("forged-"));
        if (extra.length) {
          violations.push(`${tag} · forged object(s) landed in org B's folder: ${extra.join(",")}`);
          await serviceClient().storage.from(p.bucket).remove(extra.map((n) => `${world.B.id}/adv/${n}`));
        }
        const listA = await serviceClient().storage.from(p.bucket).list(`${world.A.id}/adv`);
        const stolenHit = (listA.data ?? []).map((o) => o.name).filter((n) => n.startsWith("stolen-"));
        if (stolenHit.length) {
          violations.push(`${tag} · org B's object was copied/moved into the attacker's folder`);
          await serviceClient().storage.from(p.bucket).remove(stolenHit.map((n) => `${world.A.id}/adv/${n}`));
        }
      }
    }
    expect(violations, `STORAGE VIOLATIONS:\n  ${violations.join("\n  ")}`).toEqual([]);
  }, 900_000);

  it("positive control: org A's owner CAN download org A's own object where a read policy exists (the probes are valid)", async () => {
    const world = w!;
    const readable: string[] = [];
    for (const p of planted) {
      const r = await rawFetch(`/storage/v1/object/authenticated/${p.bucket}/${p.pathA}`, { bearer: world.A.owner.token });
      if (r.status === 200 && r.text.includes(p.marker)) readable.push(p.bucket);
    }
    writeReport("storage-control.json", { ownerReadableBuckets: readable });
    // Member/admin read policies exist for these buckets (storage.objects policies);
    // if the URL shape or auth were wrong, none would be readable and the attack above
    // would be passing for the wrong reason.
    for (const b of ["blueprints", "job-docs", "job-docs-private", "job-photos", "receipts", "signatures", "tenant-attachments"]) {
      expect(readable, `owner should read own object in ${b}`).toContain(b);
    }
  }, 120_000);

  it("clients cannot write bytes even into their OWN org folder (uploads are server-mediated)", async () => {
    const world = w!;
    const landed: string[] = [];
    for (const p of planted) {
      for (const [label, bearer] of [["A-owner", world.A.owner.token], ["A-staff", world.A.staff.token]] as const) {
        const dest = `${world.A.id}/adv/own-${label}.${p.pathA.split(".").pop()}`;
        await fetchUpload(p.bucket, dest, p.bytes, p.contentType, bearer, "POST");
        await fetchUpload(p.bucket, p.pathA, Buffer.from("SELF-OVERWRITE"), p.contentType, bearer, "PUT");
        await rawFetch(`/storage/v1/object/${p.bucket}/${p.pathA}`, { method: "DELETE", bearer });
        const list = await serviceClient().storage.from(p.bucket).list(`${world.A.id}/adv`);
        const names = (list.data ?? []).map((o) => o.name);
        if (names.some((n) => n.startsWith("own-"))) {
          landed.push(`${p.bucket} · ${label} uploaded into own folder`);
          await serviceClient().storage.from(p.bucket).remove([dest]);
        }
        const own = await serviceClient().storage.from(p.bucket).download(p.pathA);
        if (own.error || !own.data) landed.push(`${p.bucket} · ${label} deleted an object in own folder`);
        else if (!Buffer.from(await own.data.arrayBuffer()).equals(p.bytes)) landed.push(`${p.bucket} · ${label} overwrote an object in own folder`);
      }
    }
    expect(landed, `client byte-mutation reached storage:\n  ${landed.join("\n  ")}`).toEqual([]);
  }, 600_000);

  it("a signed URL minted for the attacker's OWN object cannot be re-pointed at org B's object", async () => {
    const repointed: string[] = [];
    for (const p of planted) {
      // A legitimate signed URL for A's own object (minted server-side, as the app does).
      const signed = await serviceClient().storage.from(p.bucket).createSignedUrl(p.pathA, 600);
      if (signed.error || !signed.data) continue;
      const u = new URL(signed.data.signedUrl);
      const token = u.searchParams.get("token") ?? "";
      expect(decodeJwt(token).payload.url, "signed-URL tokens bind the object path").toContain(p.pathA);
      // Same token, different object.
      const r = await rawFetch(`/storage/v1/object/sign/${p.bucket}/${p.pathB}?token=${encodeURIComponent(token)}`, { bearer: null });
      if (r.status === 200 && r.text.includes(p.marker)) repointed.push(p.bucket);
    }
    expect(repointed, "a signed URL token was accepted for a different object").toEqual([]);
  }, 300_000);
});

async function fetchUpload(
  bucket: string,
  path: string,
  bytes: Buffer,
  contentType: string,
  bearer: string | undefined,
  method: "POST" | "PUT",
): Promise<number> {
  const base = (process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").replace(/\/$/, "");
  const key = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  const res = await fetch(`${base}/storage/v1/object/${bucket}/${path}`, {
    method,
    headers: { apikey: key, Authorization: `Bearer ${bearer ?? key}`, "content-type": contentType, "x-upsert": "true" },
    body: new Uint8Array(bytes),
  });
  await res.arrayBuffer();
  return res.status;
}
