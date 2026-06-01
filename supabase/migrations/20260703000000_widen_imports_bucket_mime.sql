-- ---------------------------------------------------------------------------
-- Migration OS — widen the `imports` storage bucket allowed_mime_types
-- ---------------------------------------------------------------------------
--
-- The import wizard accepts (and parses) ~18 file formats: CSV, TSV/TAB, TXT,
-- PSV, the whole Excel family (xls/xlsx/xlsm/xlsb/xlt/xltx/xltm), OpenDocument
-- (ods/fods), Apple Numbers, SheetJS oddities (dif/prn/slk/dbf), PDF + photos
-- (jpg/png/webp/gif/heic/heif) for OCR, and ZIP archives of any of these.
--
-- The original bucket (20260526000000_migration_os.sql) only whitelisted
-- CSV / XLS / XLSX / octet-stream. Supabase Storage enforces allowed_mime_types
-- on EVERY .upload() — including the service-role admin client (it is a
-- bucket-level constraint, NOT RLS, so service_role does not bypass it). A
-- faithfully-typed upload of any other format was therefore rejected at the
-- storage step *after* a successful parse, surfacing as a generic
-- `upload_failed` for everything except CSV/XLS/XLSX.
--
-- The upload action now normalises the *stored* content-type to
-- application/octet-stream (the bytes are an opaque archival copy, re-parsed by
-- extension on re-download), which already satisfies the old allowlist. THIS
-- migration is defense-in-depth: it widens the bucket to admit the real browser
-- MIME of every supported format, so any alternate/future upload path (or a
-- regression of the code-side normalisation) still succeeds. Idempotent.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'imports',
  'imports',
  false,
  52428800, -- 50 MB per file (xlsx exports get chunky)
  array[
    -- delimited / plain text (csv, tsv, tab, txt, psv)
    'text/csv',
    'application/csv',
    'text/tab-separated-values',
    'text/plain',
    -- excel: binary, ooxml, templates, macro-enabled, binary workbook
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.template',
    'application/vnd.ms-excel.sheet.macroEnabled.12',
    'application/vnd.ms-excel.template.macroEnabled.12',
    'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
    -- opendocument spreadsheet (+ template + flat-xml variant: fods is XML)
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.spreadsheet-template',
    'application/xml',
    'text/xml',
    -- apple numbers (a zip bundle; browsers report these, or zip/octet-stream)
    'application/vnd.apple.numbers',
    'application/x-iwork-numbers-sffnumbers',
    -- pdf (OCR)
    'application/pdf',
    -- images (OCR): jpg/png/webp/gif/heic/heif
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence',
    -- zip archives of any of the above
    'application/zip',
    'application/x-zip-compressed',
    'application/x-zip',
    'multipart/x-zip',
    -- catch-all: many browsers send empty/octet-stream for the above, AND the
    -- upload action normalises every stored object to this type.
    'application/octet-stream'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
