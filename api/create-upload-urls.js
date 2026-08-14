import { supabase, BUCKET } from './_lib/supabase.js';
import crypto from 'node:crypto';

// Step 1 of the two-step upload. The client sends only file metadata (names,
// counts, categories) — a tiny JSON body. We mint one single-use signed upload
// URL per file, each scoped to exactly one object path under a fresh
// applicationId prefix. The service key never leaves the server.

const MAX = { bank: 4, license: 1, voided_check: 1 };

function safeName(name) {
  return String(name || 'file')
    .normalize('NFC')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '_')
    .slice(-80);
}

const ALLOWED_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'tif', 'tiff']);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { files } = req.body || {};
    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No files specified' });
    }

    // Count guard per category.
    const counts = { bank: 0, license: 0, voided_check: 0 };
    for (const f of files) {
      if (!['bank', 'license', 'voided_check'].includes(f.category)) {
        return res.status(400).json({ error: 'Bad file category' });
      }
      const ext = String(f.name || '').split('.').pop().toLowerCase();
      if (!ALLOWED_EXT.has(ext)) {
        return res.status(400).json({ error: `File type .${ext} not allowed` });
      }
      counts[f.category]++;
    }
    if (counts.bank > MAX.bank || counts.license > MAX.license || counts.voided_check > MAX.voided_check) {
      return res.status(400).json({ error: 'Too many files' });
    }

    const applicationId = crypto.randomUUID();
    const folder = {
      bank: 'bank-statements',
      license: 'license',
      voided_check: 'voided-check',
    };

    const uploads = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const path = `${applicationId}/${folder[f.category]}/${i}-${safeName(f.name)}`;
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUploadUrl(path);
      if (error) {
        console.error('[create-upload-urls] sign error:', error.message);
        return res.status(500).json({ error: 'Could not prepare upload' });
      }
      uploads.push({
        category: f.category,
        path,
        token: data.token,
        signedUrl: data.signedUrl,
      });
    }

    return res.status(200).json({ applicationId, uploads });
  } catch (err) {
    console.error('[create-upload-urls] error:', err?.message || err);
    return res.status(500).json({ error: 'Server error' });
  }
}
