import { supabase, BUCKET } from './supabase.js';
import { mapApplicationToCrm } from './crm-mapping.js';

// Three-phase push of a saved application into the CRM's public intake.
//
// Contract with the caller: this NEVER throws and NEVER fails the submission.
// The row is already committed and the merchant already has their 200 before
// this runs. Every exit path funnels through recordOutcome(), which writes the
// single status UPDATE.
//
// No retry. Their endpoint is not idempotent yet, so a second attempt risks a
// duplicate submission — worse than a failed one we can see and re-drive by
// hand off crm_sync_status.

const CRM_BASE = 'https://mca-crm-six.vercel.app/api/public/application';
const UPLOAD_URL_ENDPOINT = `${CRM_BASE}/upload-url`;

const MAX_FILES = 12;

// Their accepted upload extensions. Ours is wider (we also take gif/tif/tiff),
// so anything they will not take is dropped here and named in crm_last_error
// rather than failing the whole push.
const CRM_EXTENSIONS = new Set(['pdf', 'png', 'jpg', 'jpeg', 'heic', 'webp']);

// Our category names -> theirs (submission_files.file_category check constraint).
const CATEGORY = {
  bank: 'bank_statement',
  license: 'drivers_license',
  voided_check: 'voided_check',
};

const TIMEOUT_PREPARE = 15000;
const TIMEOUT_TRANSFER = 30000;
const TIMEOUT_SUBMIT = 20000;

const ERROR_MAX = 500;

// crm_last_error is operator-facing and sits next to the applicant's row; it must
// never become a second copy of their PII. Strip anything that looks like an
// email or a run of digits (SSN, EIN, phone, account numbers) before storing.
function scrub(input) {
  return String(input ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
    .replace(/\d[\d\s().-]{5,}\d/g, '[number]')
    .replace(/\b\d{4,}\b/g, '[number]')
    .slice(0, ERROR_MAX);
}

function extensionOf(name) {
  return String(name || '').split('.').pop().toLowerCase();
}

// The row's files[] is canonical. Fall back to the legacy path columns for rows
// written before that column existed.
function filesFromRow(application) {
  const listed = Array.isArray(application.files) ? application.files : [];
  if (listed.length) return listed;

  const legacy = [];
  for (const path of Array.isArray(application.bank_statement_paths) ? application.bank_statement_paths : []) {
    legacy.push({ category: 'bank', path });
  }
  if (application.license_path) legacy.push({ category: 'license', path: application.license_path });
  if (application.voided_check_path) legacy.push({ category: 'voided_check', path: application.voided_check_path });
  return legacy.map((f) => ({ ...f, filename: String(f.path).replace(/^.*\//, '') }));
}

async function recordOutcome(applicationRowId, patch) {
  try {
    const { error } = await supabase
      .from('applications')
      .update(patch)
      .eq('id', applicationRowId);
    if (error) console.error('[crm] status update failed:', error.message);
  } catch (err) {
    console.error('[crm] status update threw:', err?.message || err);
  }
}

function failure(reason) {
  return { crm_sync_status: 'failed', crm_last_error: scrub(reason) };
}

// Turn a non-2xx (or ambiguous 2xx) CRM response into the recorded status.
async function classifyResponse(res, phaseLabel) {
  const { status } = res;

  if (status === 400) return failure('invalid_json');
  if (status === 401) return failure('auth: secret rejected');
  if (status === 429) {
    const retry = res.headers.get('retry-after');
    return failure(`rate_limited${retry ? ` (retry-after: ${retry})` : ''}`);
  }
  if (status === 422) {
    let issues = [];
    try {
      const body = await res.json();
      if (Array.isArray(body?.issues)) {
        issues = body.issues.map((i) => {
          const path = Array.isArray(i?.path) ? i.path.join('.') : String(i?.path ?? '');
          return `${path}: ${i?.message ?? ''}`.trim();
        });
      }
    } catch {
      /* body was not JSON — fall through to the bare label */
    }
    return failure(issues.length ? `422 ${issues.join('; ')}` : '422 validation failed');
  }
  if (status >= 500) return failure('submission_failed');
  return failure(`${phaseLabel}: unexpected HTTP ${status}`);
}

export async function pushApplicationToCrm({ application } = {}) {
  const rowId = application?.id;
  if (!rowId) {
    console.error('[crm] no application row id — nothing to push');
    return;
  }

  const secret = process.env.INTAKE_SHARED_SECRET;
  if (!secret) {
    // Never log the value; only its absence.
    console.error('[crm] INTAKE_SHARED_SECRET is unset — skipping push');
    await recordOutcome(rowId, failure('config: INTAKE_SHARED_SECRET unset'));
    return;
  }

  const headers = {
    'content-type': 'application/json',
    'x-intake-secret': secret,
  };

  try {
    // ---- Phase 0: decide what we are sending -----------------------------
    const all = filesFromRow(application);
    const eligible = [];
    const dropped = [];

    for (const f of all) {
      const filename = f.filename || String(f.path || '').replace(/^.*\//, '');
      if (!CRM_EXTENSIONS.has(extensionOf(filename))) {
        dropped.push(`.${extensionOf(filename)}`);
        continue;
      }
      if (!CATEGORY[f.category]) {
        dropped.push(`category:${f.category}`);
        continue;
      }
      eligible.push({
        path: f.path,
        filename,
        category: CATEGORY[f.category],
        sizeBytes: Number.isFinite(Number(f.sizeBytes)) ? Number(f.sizeBytes) : undefined,
        mimeType: f.mimeType || undefined,
      });
    }

    const overflow = Math.max(0, eligible.length - MAX_FILES);
    const sending = eligible.slice(0, MAX_FILES);

    const notes = [];
    if (dropped.length) notes.push(`dropped ${dropped.length} unsupported file(s): ${[...new Set(dropped)].join(', ')}`);
    if (overflow) notes.push(`dropped ${overflow} file(s) over the ${MAX_FILES} limit`);

    // Same rule as a failed transfer: a submission that lands with no documents
    // is worse than one that never lands. Stop here rather than create an empty
    // record someone has to notice and chase.
    if (!sending.length) {
      await recordOutcome(rowId, failure(
        all.length
          ? `phase 0: no CRM-supported files (${notes.join('; ') || 'all rejected'})`
          : 'phase 0: application row has no files'
      ));
      return;
    }

    // ---- Phase 1: one call, all files ------------------------------------
    let slots = [];
    if (sending.length) {
      let res;
      try {
        res = await fetch(UPLOAD_URL_ENDPOINT, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            files: sending.map((f) => ({
              category: f.category,
              filename: f.filename,
              sizeBytes: f.sizeBytes,
              mimeType: f.mimeType,
            })),
          }),
          signal: AbortSignal.timeout(TIMEOUT_PREPARE),
        });
      } catch (err) {
        await recordOutcome(rowId, failure(`phase 1 (upload-url) network/timeout: ${err?.name || err?.message || 'failed'}`));
        return;
      }

      if (!res.ok) {
        await recordOutcome(rowId, await classifyResponse(res, 'phase 1 (upload-url)'));
        return;
      }

      let json;
      try {
        json = await res.json();
      } catch {
        await recordOutcome(rowId, failure('phase 1 (upload-url): response was not JSON'));
        return;
      }

      const raw =
        (Array.isArray(json?.uploads) && json.uploads) ||
        (Array.isArray(json?.files) && json.files) ||
        (Array.isArray(json?.slots) && json.slots) ||
        (Array.isArray(json) && json) ||
        null;

      if (!raw || raw.length !== sending.length) {
        await recordOutcome(rowId, failure(
          `phase 1 (upload-url): expected ${sending.length} slot(s), got ${raw ? raw.length : 'none'}`
        ));
        return;
      }

      slots = raw.map((s, i) => ({
        ...sending[i],
        signedUrl: s?.signedUrl || s?.uploadUrl || s?.url,
        storagePath: s?.storagePath || s?.path || s?.storage_path,
      }));

      const incomplete = slots.find((s) => !s.signedUrl || !s.storagePath);
      if (incomplete) {
        await recordOutcome(rowId, failure('phase 1 (upload-url): slot missing signedUrl or storagePath'));
        return;
      }

      // ---- Phase 2: sequential transfer ----------------------------------
      // One file in memory at a time. Parallelising this would multiply peak
      // memory by the file count for no useful latency win in a background task.
      for (const slot of slots) {
        let bytes;
        try {
          const { data, error } = await supabase.storage.from(BUCKET).download(slot.path);
          if (error || !data) {
            await recordOutcome(rowId, failure(`phase 2 (transfer): could not read ${slot.category} from storage`));
            return;
          }
          bytes = Buffer.from(await data.arrayBuffer());
        } catch (err) {
          await recordOutcome(rowId, failure(`phase 2 (transfer): storage read threw for ${slot.category}`));
          return;
        }

        try {
          const put = await fetch(slot.signedUrl, {
            method: 'PUT',
            headers: slot.mimeType ? { 'content-type': slot.mimeType } : undefined,
            body: bytes,
            signal: AbortSignal.timeout(TIMEOUT_TRANSFER),
          });
          if (!put.ok) {
            await recordOutcome(rowId, failure(`phase 2 (transfer): PUT returned HTTP ${put.status} for ${slot.category}`));
            return;
          }
        } catch (err) {
          await recordOutcome(rowId, failure(`phase 2 (transfer) network/timeout for ${slot.category}: ${err?.name || 'failed'}`));
          return;
        }
      }
    }

    // Phases 1 and 2 both clean. Only now is it safe to create the record —
    // a submission that lands with no files is worse than one that never lands.

    // ---- Phase 3: the submission -----------------------------------------
    const body = mapApplicationToCrm(application);
    if (application.ref) body.ref = application.ref;
    body.files = slots.map((s) => ({
      category: s.category,
      storagePath: s.storagePath,
      filename: s.filename,
      sizeBytes: s.sizeBytes,
      mimeType: s.mimeType,
    }));

    let res;
    try {
      res = await fetch(CRM_BASE, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_SUBMIT),
      });
    } catch (err) {
      await recordOutcome(rowId, failure(`phase 3 (submit) network/timeout: ${err?.name || err?.message || 'failed'}`));
      return;
    }

    if (!res.ok) {
      await recordOutcome(rowId, await classifyResponse(res, 'phase 3 (submit)'));
      return;
    }

    let json = null;
    try {
      json = await res.json();
    } catch {
      /* handled as a missing submission_id below */
    }

    const submissionId = json?.submission_id;
    if (!submissionId) {
      // 200 with no id is their honeypot: the body carried a key it treats as a
      // bot signal and the submission was silently discarded. That can only mean
      // our allowlist leaked a forbidden key — a code bug in crm-mapping.js, not
      // a transient failure. Retrying will not help.
      console.error(
        '[crm] HONEYPOT: 200 with no submission_id — the outgoing body contained a forbidden key. ' +
        'Check the EMIT allowlist in _lib/crm-mapping.js. Keys sent: ' + Object.keys(body).join(', ')
      );
      await recordOutcome(rowId, failure('honeypot: silently discarded'));
      return;
    }

    await recordOutcome(rowId, {
      crm_sync_status: 'synced',
      crm_synced_at: new Date().toISOString(),
      crm_record_id: String(submissionId),
      crm_last_error: notes.length ? scrub(notes.join('; ')) : null,
    });
  } catch (err) {
    // Belt and braces: nothing above should escape, and if it does the merchant
    // must still be unaffected.
    console.error('[crm] push threw:', err?.message || err);
    await recordOutcome(rowId, failure(`unexpected: ${err?.message || 'error'}`));
  }
}
