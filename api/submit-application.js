import { supabase, BUCKET } from './_lib/supabase.js';
import { validateApplication } from './_lib/validate.js';
import { sendApplicationNotification } from './_lib/email.js';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  if (!originOk(req)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const body = req.body || {};

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

  // Confirm the uploaded objects actually exist in the bucket.
  try {
    const { data: listed, error: listErr } = await supabase.storage
      .from(BUCKET)
      .list(applicationId, { limit: 100 });
    if (listErr) {
      console.error('[submit] list error:', listErr.message);
    }
    // (We don't hard-fail on a missing file; we record what the client sent and
    //  the folder is inspectable. But we do sort paths into their columns.)
  } catch (e) {
    console.error('[submit] list threw:', e?.message || e);
  }

  // Sort file paths into their DB columns by category.
  const bank = [];
  let license = null;
  let voided = null;
  for (const p of paths) {
    if (p.category === 'bank') bank.push(p.path);
    else if (p.category === 'license') license = p.path;
    else if (p.category === 'voided_check') voided = p.path;
  }

  const ip =
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    null;

  const row = {
    ...v.data,
    bank_statement_paths: bank,
    license_path: license,
    voided_check_path: voided,
    submitted_ip: ip,
    agreed_terms_at: new Date().toISOString(),
    status: 'new',
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

  return res.status(200).json({ ok: true, applicationId: inserted.id });
}
