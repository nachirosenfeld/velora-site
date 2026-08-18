import { waitUntil } from '@vercel/functions';
import { supabase, BUCKET } from './_lib/supabase.js';
import { validateApplication } from './_lib/validate.js';
import { sendApplicationNotification } from './_lib/email.js';
import { pushApplicationToCrm } from './_lib/crm-push.js';

// Step 3 of the two-step upload. Files are already in the private bucket (the
// browser uploaded them directly using the signed URLs from step 1). This
// endpoint receives a small JSON body: all text fields + the applicationId +
// the file paths. It re-verifies the paths belong to this application, confirms
// the objects exist, inserts one row, then fires a notification email.

const ALLOWED_ORIGINS = [
  'https://veloracapitalgrp.com',
  'https://www.veloracapitalgrp.com',
];

function originOk(req) {
  const o = req.headers.origin || '';
  if (!o) return true; // some browsers omit Origin on same-origin POST
  if (ALLOWED_ORIGINS.includes(o)) return true;
  if (o.endsWith('.vercel.app')) return true; // preview deployments
  return false;
}

// The three folders create-upload-urls writes into, under the applicationId.
const CATEGORY_FOLDERS = ['bank-statements', 'license', 'voided-check'];

// Storage already records size and mimetype per object, so read them back from
// there rather than trusting what the browser claimed. Anything we cannot read
// stays null; this is metadata, never a reason to fail a submission.
async function collectFileMetadata(applicationId) {
  const map = new Map();
  for (const folder of CATEGORY_FOLDERS) {
    try {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .list(`${applicationId}/${folder}`, { limit: 100 });
      if (error) {
        console.error(`[submit] list error for ${folder}:`, error.message);
        continue;
      }
      for (const obj of data || []) {
        const size = Number(obj?.metadata?.size);
        map.set(`${applicationId}/${folder}/${obj.name}`, {
          sizeBytes: Number.isFinite(size) ? size : null,
          mimeType: obj?.metadata?.mimetype || null,
        });
      }
    } catch (e) {
      console.error(`[submit] list threw for ${folder}:`, e?.message || e);
    }
  }
  return map;
}

function clientIp(req) {
  return (
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    null
  );
}

const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Cloudflare Turnstile. Every branch here fails closed: a missing secret, an
// unset hostname allowlist, a network blip, or an unparseable response all deny
// the submission rather than letting it through.
async function verifyTurnstile(token, ip) {
  if (typeof token !== 'string' || !token || token.length > 2048) {
    return { ok: false, reason: 'missing or malformed token' };
  }

  const allowedHosts = String(process.env.TURNSTILE_HOSTNAMES || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (!allowedHosts.length) {
    return { ok: false, reason: 'TURNSTILE_HOSTNAMES is unset — refusing to verify' };
  }

  let result;
  try {
    const params = new URLSearchParams();
    params.set('secret', process.env.TURNSTILE_SECRET || '');
    params.set('response', token);
    if (ip) params.set('remoteip', ip);

    const res = await fetch(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, reason: `siteverify returned HTTP ${res.status}` };
    result = await res.json();
  } catch (err) {
    return { ok: false, reason: `siteverify request failed: ${err?.message || err}` };
  }

  if (result?.success !== true) {
    const codes = Array.isArray(result?.['error-codes']) ? result['error-codes'].join(', ') : 'none';
    return { ok: false, reason: `challenge not passed (${codes})` };
  }
  if (result.action !== 'apply') {
    return { ok: false, reason: `unexpected action: ${result.action}` };
  }
  if (!allowedHosts.includes(result.hostname)) {
    return { ok: false, reason: `unexpected hostname: ${result.hostname}` };
  }
  return { ok: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!originOk(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const body = req.body || {};
  const ip = clientIp(req);

  // Bot gate. Nothing below this runs until Cloudflare vouches for the token.
  const turnstile = await verifyTurnstile(body['cf-turnstile-response'], ip);
  if (!turnstile.ok) {
    console.error('[submit] turnstile rejected:', turnstile.reason);
    return res.status(403).json({ error: 'Verification failed. Please reload the page and try again.' });
  }

  // Honeypot — a hidden field real users never fill. If present, pretend success.
  if (body.website_url_hp) {
    return res.status(200).json({ ok: true });
  }

  // Validate all text fields.
  const v = validateApplication(body);
  if (!v.ok) {
    return res.status(400).json({ error: 'Validation failed', details: v.errors });
  }

  const applicationId = String(body.applicationId || '');
  if (!/^[0-9a-f-]{36}$/i.test(applicationId)) {
    return res.status(400).json({ error: 'Bad application id' });
  }

  // Verify every claimed path is under this applicationId prefix.
  const paths = Array.isArray(body.paths) ? body.paths : [];
  for (const p of paths) {
    if (typeof p?.path !== 'string' || !p.path.startsWith(`${applicationId}/`)) {
      return res.status(400).json({ error: 'Invalid file path' });
    }
  }

  // Confirm the uploaded objects actually exist, and pick up the size/mimetype
  // Storage recorded for each. We don't hard-fail on a missing file; the folder
  // stays inspectable and the paths are recorded either way.
  const fileMeta = await collectFileMetadata(applicationId);

  // Sort file paths into their DB columns by category, and build the canonical
  // files[] alongside. The three path columns remain the read path for the
  // notification email (_lib/email.js), so both are written.
  const bank = [];
  let license = null;
  let voided = null;
  const files = [];
  for (const p of paths) {
    const known = fileMeta.get(p.path) || {};
    files.push({
      category: p.category,
      path: p.path,
      filename: String(p.path).replace(/^.*\//, ''),
      sizeBytes: known.sizeBytes ?? null,
      mimeType: known.mimeType ?? null,
    });
    if (p.category === 'bank') bank.push(p.path);
    else if (p.category === 'license') license = p.path;
    else if (p.category === 'voided_check') voided = p.path;
  }

  const row = {
    ...v.data,
    application_id: applicationId,
    bank_statement_paths: bank,
    license_path: license,
    voided_check_path: voided,
    files,
    submitted_ip: ip,
    agreed_terms_at: new Date().toISOString(),
    status: 'new',
    // Flipped to synced/failed by the background push. A row still reading
    // 'pending' means the push never resolved at all.
    crm_sync_status: 'pending',
  };

  const { data: inserted, error: insErr } = await supabase
    .from('applications')
    .insert(row)
    .select('*')
    .single();

  if (insErr) {
    console.error('[submit] insert failed:', insErr.message);
    // Best-effort cleanup of orphaned uploads.
    try {
      if (paths.length) {
        await supabase.storage.from(BUCKET).remove(paths.map((p) => p.path));
      }
    } catch (e) {
      console.error('[submit] orphan cleanup failed:', e?.message || e);
    }
    return res.status(500).json({ error: 'Could not save application' });
  }

  // Notification is non-fatal — the row is already saved. It carries the full
  // application PDF plus the uploaded documents, so give it the inserted row.
  const projectRef = (process.env.SUPABASE_URL || '').match(/https:\/\/([^.]+)\./)?.[1] || '';
  try {
    await sendApplicationNotification({ application: inserted, projectRef });
  } catch (e) {
    console.error('[submit] notification failed:', e?.message || e);
  }

  // CRM push — after the insert and after the email, and deliberately not
  // awaited: the merchant gets their 200 now while the file transfer continues
  // in the background. pushApplicationToCrm never throws and never touches the
  // response, so a CRM outage cannot turn a saved application into an error.
  try {
    waitUntil(pushApplicationToCrm({ application: inserted }));
  } catch (e) {
    // waitUntil throws if there is no surrounding request context (local `vercel
    // dev`, or a runtime that doesn't provide it). Fall back to inline so the
    // push still happens; it costs the merchant the transfer latency.
    console.error('[submit] waitUntil unavailable, pushing inline:', e?.message || e);
    await pushApplicationToCrm({ application: inserted });
  }

  return res.status(200).json({ ok: true, applicationId: inserted.id });
}
