import { Resend } from 'resend';
import { createClient } from '@supabase/supabase-js';
import { buildApplicationPdf, fileNameFromPath } from './pdf.js';

const resend = new Resend(process.env.RESEND_API_KEY);

// NOTE: onboarding@resend.dev can only deliver to the address that owns the
// Resend account. Until veloracapitalgrp.com is verified in Resend, notify the
// account owner's inbox. Swap NOTIFY_TO to admin@veloracapitalgrp.com once the
// sending domain is verified.
const NOTIFY_TO = 'nachirosenfeld51@gmail.com';
const FROM = 'Velora Applications <onboarding@resend.dev>';

const BUCKET = 'application-files';

// Ceiling on the raw (pre-base64) bytes we will attach. Anything past it is
// skipped and named in the email body rather than failing the whole send.
// Note: base64 inflates the wire payload by ~4/3, so a full 38MB of raw
// attachments is ~51MB on the wire — above Resend's 40MB cap. Real applications
// (a handful of statements and photos) land far below this, but lower it to
// ~28MB if large uploads ever start bouncing.
const ATTACHMENT_BUDGET = 38 * 1024 * 1024;

// Service-role client. Reads the private bucket; never reaches the browser.
function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('[email] missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    return null;
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function slug(v) {
  return String(v || 'Application')
    .normalize('NFC')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 48) || 'Application';
}

function phoneOut(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  if (d.length !== 10) return v || '—';
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function stamp(iso) {
  const d = iso ? new Date(iso) : new Date();
  const use = isNaN(d.getTime()) ? new Date() : d;
  return use.toISOString().slice(0, 10); // YYYY-MM-DD, for the filename
}

// Every stored path on the row, in the order they should be attached.
function documentPaths(application) {
  return [
    ...(Array.isArray(application.bank_statement_paths) ? application.bank_statement_paths : []),
    application.license_path,
    application.voided_check_path,
  ].filter((p) => typeof p === 'string' && p);
}

async function downloadDocuments(application) {
  const paths = documentPaths(application);
  if (!paths.length) return { files: [], failed: [] };

  const supabase = serviceClient();
  if (!supabase) return { files: [], failed: paths.map(fileNameFromPath) };

  const files = [];
  const failed = [];
  for (const path of paths) {
    try {
      const { data, error } = await supabase.storage.from(BUCKET).download(path);
      if (error || !data) {
        console.error(`[email] download failed for ${path}:`, error?.message || 'no data');
        failed.push(fileNameFromPath(path));
        continue;
      }
      const bytes = Buffer.from(await data.arrayBuffer());
      files.push({ filename: fileNameFromPath(path), bytes });
    } catch (err) {
      console.error(`[email] download threw for ${path}:`, err?.message || err);
      failed.push(fileNameFromPath(path));
    }
  }
  return { files, failed };
}

function bodyHtml({ application, projectRef, skipped, failed }) {
  const businessName = application.legal_name || '—';
  const owner = [application.owner_first, application.owner_last].filter(Boolean).join(' ') || '—';
  const reviewUrl = projectRef
    ? `https://supabase.com/dashboard/project/${projectRef}/editor`
    : null;

  const rows = [
    ['Business', businessName],
    ['Owner', owner],
    ['Amount requested', application.funding_requested || '—'],
    ['Phone', phoneOut(application.owner_cell)],
    ['Email', application.owner_email || '—'],
  ]
    .map(
      ([label, value]) => `
      <tr>
        <td style="padding:6px 16px 6px 0;color:#6b6b6b;font-size:13px;white-space:nowrap;">${esc(label)}</td>
        <td style="padding:6px 0;color:#181818;font-size:14px;font-weight:600;">${esc(value)}</td>
      </tr>`,
    )
    .join('');

  const notes = [];
  if (skipped.length) {
    notes.push(
      `<p style="margin:16px 0 0;color:#8a6d1f;font-size:13px;">Not attached (size limit): ${esc(skipped.join(', '))} — download them from Supabase Storage.</p>`,
    );
  }
  if (failed.length) {
    notes.push(
      `<p style="margin:8px 0 0;color:#a13b3b;font-size:13px;">Could not download: ${esc(failed.join(', '))}</p>`,
    );
  }

  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;">
  <div style="background:#233028;border-bottom:3px solid #d8f477;padding:20px 24px;">
    <div style="color:#ffffff;font-size:20px;font-weight:700;letter-spacing:-0.2px;">velora</div>
    <div style="color:#d8f477;font-size:9px;letter-spacing:3px;margin-top:2px;">CAPITAL</div>
  </div>
  <div style="padding:24px;">
    <p style="margin:0 0 16px;color:#181818;font-size:15px;">
      A new funding application was submitted on veloracapitalgrp.com.
    </p>
    <table style="border-collapse:collapse;">${rows}</table>
    <p style="margin:20px 0 0;color:#6b6b6b;font-size:13px;">
      The full application is attached as a PDF, along with every document the applicant uploaded.
    </p>
    ${notes.join('')}
    ${reviewUrl ? `<p style="margin:16px 0 0;font-size:13px;"><a href="${esc(reviewUrl)}" style="color:#233028;">Open in Supabase</a></p>` : ''}
  </div>
</div>`;
}

// Non-fatal by contract: the application row is already saved before this runs,
// so every failure path logs and returns instead of throwing.
export async function sendApplicationNotification({ application, projectRef } = {}) {
  try {
    if (!application) {
      console.error('[email] no application row provided');
      return { ok: false };
    }

    const businessName = application.legal_name || 'Application';
    const attachments = [];
    let used = 0;

    // 1. The branded PDF always goes first and is never budgeted away.
    try {
      const pdfBytes = await buildApplicationPdf(application);
      used += pdfBytes.length;
      attachments.push({
        filename: `Velora-Application-${slug(businessName)}-${stamp(application.created_at)}.pdf`,
        content: pdfBytes.toString('base64'),
      });
    } catch (err) {
      console.error('[email] pdf build failed:', err?.message || err);
    }

    // 2. Then the uploaded documents, until the budget runs out.
    const { files, failed } = await downloadDocuments(application);
    const skipped = [];
    for (const file of files) {
      if (used + file.bytes.length > ATTACHMENT_BUDGET) {
        skipped.push(file.filename);
        continue;
      }
      used += file.bytes.length;
      attachments.push({
        filename: file.filename,
        content: file.bytes.toString('base64'),
      });
    }
    if (skipped.length) {
      console.warn(`[email] skipped ${skipped.length} attachment(s) over budget:`, skipped.join(', '));
    }

    const { error } = await resend.emails.send({
      from: FROM,
      to: NOTIFY_TO,
      subject: `New Application — ${businessName}`,
      html: bodyHtml({ application, projectRef, skipped, failed }),
      attachments,
    });
    if (error) {
      console.error('[email] send rejected:', error.message || error);
      return { ok: false };
    }

    return { ok: true, attached: attachments.length, skipped };
  } catch (err) {
    console.error('[email] notification failed:', err?.message || err);
    return { ok: false };
  }
}
