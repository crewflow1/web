"use client";

import { useEffect, useState } from "react";

/**
 * Job photo gallery.
 *
 * Fetches the list of photos (signed URLs) on mount, lets users upload
 * more (multipart POST), and lets admins delete individual photos.
 *
 * Server is authoritative for permissions (storage + jobs RLS); this UI
 * just calls the API and reflects results.
 */

type Photo = { path: string; url: string };

const MAX_FILES = 10;
const MAX_BYTES = 10 * 1024 * 1024;

export function PhotoGallery({ jobId }: { jobId: string }) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/jobs/${jobId}/photos`, { cache: "no-store" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Failed to load photos (${res.status})`);
        setPhotos([]);
        return;
      }
      const j = (await res.json()) as { photos: Photo[] };
      setPhotos(j.photos ?? []);
    } catch (err) {
      console.error("[photo-gallery] load failed", err);
      setError("Network error loading photos.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  async function onFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (files.length > MAX_FILES) {
      setError(`Max ${MAX_FILES} files per upload.`);
      return;
    }
    for (const f of Array.from(files)) {
      if (f.size > MAX_BYTES) {
        setError(`${f.name} exceeds 10 MB.`);
        return;
      }
    }
    setUploading(true);
    setError(null);
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append("photos", f);
    try {
      const res = await fetch(`/api/jobs/${jobId}/photos`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Upload failed (${res.status})`);
      } else {
        await refresh();
      }
    } catch (err) {
      console.error("[photo-gallery] upload failed", err);
      setError("Network error uploading.");
    } finally {
      setUploading(false);
    }
  }

  async function onDelete(p: Photo) {
    const segments = p.path.split("/");
    const filename = segments[segments.length - 1];
    if (!filename) return;
    if (!confirm(`Delete ${filename}? This cannot be undone.`)) return;
    setError(null);
    try {
      const res = await fetch(
        `/api/jobs/${jobId}/photos/${encodeURIComponent(filename)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setError(j.error ?? `Delete failed (${res.status})`);
      } else {
        await refresh();
      }
    } catch (err) {
      console.error("[photo-gallery] delete failed", err);
      setError("Network error deleting.");
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">Photos</h2>
          <p className="mt-0.5 text-xs text-slate-500">
            {loading ? "Loading…" : `${photos.length} attached`}
          </p>
        </div>
        <label className="cursor-pointer rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-slate-800">
          {uploading ? "Uploading…" : "Upload"}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            multiple
            hidden
            disabled={uploading}
            onChange={(e) => onFiles(e.currentTarget.files)}
          />
        </label>
      </div>

      {error ? (
        <div
          role="alert"
          className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
        >
          {error}
        </div>
      ) : null}

      {photos.length === 0 && !loading ? (
        <p className="mt-4 text-center text-sm text-slate-500">
          No photos yet. Upload before/during/after shots so the office has
          proof of work.
        </p>
      ) : (
        <ul className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
          {photos.map((p) => {
            const segments = p.path.split("/");
            const filename = segments[segments.length - 1] ?? p.path;
            return (
              <li
                key={p.path}
                className="group relative overflow-hidden rounded-md border border-slate-200 bg-slate-50"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={p.url}
                  alt={filename}
                  className="aspect-square w-full object-cover"
                  loading="lazy"
                />
                <button
                  type="button"
                  onClick={() => onDelete(p)}
                  // Always visible on touch devices; fades in on hover for
                  // mouse users (covers both cases without a JS check).
                  className="absolute right-1.5 top-1.5 rounded-md bg-white/90 px-2 py-0.5 text-xs font-medium text-red-700 shadow-sm transition hover:bg-white md:opacity-0 md:group-hover:opacity-100"
                  aria-label={`Delete ${filename}`}
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
