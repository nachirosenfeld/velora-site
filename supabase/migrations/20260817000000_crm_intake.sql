-- CRM intake support.
--
-- Adds: the referral code, the storage-folder id (previously minted and then
-- thrown away), CRM sync bookkeeping, the second-owner block, the open-advance
-- detail, and per-file metadata.
--
-- Every column is nullable and additive. application_id is backfilled from the
-- folder prefix already embedded in the stored path strings, but intentionally
-- gets NO not-null constraint yet — rows predating the upload step could have
-- no paths to parse.

alter table public.applications
  add column if not exists ref                   text,
  add column if not exists application_id        uuid,
  add column if not exists crm_sync_status       text,
  add column if not exists crm_synced_at         timestamptz,
  add column if not exists crm_last_error        text,
  add column if not exists crm_record_id         text,
  add column if not exists partner_first_name    text,
  add column if not exists partner_last_name     text,
  add column if not exists partner_cell          text,
  add column if not exists partner_email         text,
  add column if not exists partner_home_street   text,
  add column if not exists partner_home_street2  text,
  add column if not exists partner_home_city     text,
  add column if not exists partner_home_state    text,
  add column if not exists partner_home_zip      text,
  add column if not exists partner_dob           date,
  add column if not exists partner_ssn           text,
  add column if not exists partner_credit_score  integer,
  add column if not exists partner_ownership_pct integer,
  add column if not exists open_advance_detail   text;

-- Per-file metadata.
--
-- Supabase Storage already records size and mimetype per object in
-- storage.objects.metadata; the applications row stored only bare path strings
-- (bank_statement_paths text[], license_path text, voided_check_path text) with
-- nowhere to hang size/mime off. Rather than a second parallel path list, this
-- denormalises the storage metadata onto the row, keyed by the same path:
--
--   [{ "category", "path", "filename", "sizeBytes", "mimeType" }, ...]
--
-- The three legacy path columns stay authoritative for the notification email
-- (_lib/email.js documentPaths()) and are still written on every insert.
alter table public.applications
  add column if not exists files jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'applications_crm_sync_status_check'
  ) then
    alter table public.applications
      add constraint applications_crm_sync_status_check
      check (crm_sync_status is null or crm_sync_status in ('pending', 'synced', 'failed'));
  end if;
end $$;

create index if not exists applications_application_id_idx
  on public.applications (application_id);
create index if not exists applications_crm_sync_status_idx
  on public.applications (crm_sync_status)
  where crm_sync_status is distinct from 'synced';

-- Backfill 1: application_id from the folder prefix of any stored path.
-- Paths are "<uuid>/<folder>/<n>-<name>", so the prefix is field 1.
update public.applications
set application_id = split_part(
      coalesce(bank_statement_paths[1], license_path, voided_check_path), '/', 1
    )::uuid
where application_id is null
  and split_part(
        coalesce(bank_statement_paths[1], license_path, voided_check_path), '/', 1
      ) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Backfill 2: files[] from the legacy path columns, joined to the size/mimetype
-- Storage already holds. Objects that no longer exist yield null size/mime
-- rather than dropping the entry.
with expanded as (
  select a.id, 'bank'::text as category, p.path, p.ord::bigint as ord
    from public.applications a
    cross join lateral unnest(coalesce(a.bank_statement_paths, '{}')) with ordinality as p(path, ord)
  union all
  select a.id, 'license', a.license_path, 1000
    from public.applications a where a.license_path is not null
  union all
  select a.id, 'voided_check', a.voided_check_path, 1001
    from public.applications a where a.voided_check_path is not null
),
joined as (
  select e.id, e.category, e.path, e.ord,
         regexp_replace(e.path, '^.*/', '') as filename,
         (o.metadata->>'size')::bigint      as size_bytes,
         o.metadata->>'mimetype'            as mime_type
    from expanded e
    left join storage.objects o
      on o.bucket_id = 'application-files' and o.name = e.path
),
agg as (
  select id, jsonb_agg(
           jsonb_build_object(
             'category',  category,
             'path',      path,
             'filename',  filename,
             'sizeBytes', size_bytes,
             'mimeType',  mime_type
           ) order by ord
         ) as files
    from joined
   group by id
)
update public.applications a
   set files = agg.files
  from agg
 where agg.id = a.id
   and (a.files is null or a.files = '[]'::jsonb);
