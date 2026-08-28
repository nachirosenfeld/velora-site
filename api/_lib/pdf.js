import fs from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// Renders one application row into a branded, print-ready US Letter PDF.
// Pure function of the DB row — no network, no env vars. Called by the
// notification email, which attaches the result.

const PAGE_W = 612;
const PAGE_H = 792;
const M = 54; // page margin
const CONTENT_W = PAGE_W - M * 2; // 504
const GUTTER = 24;
const COL_W = (CONTENT_W - GUTTER) / 2; // 240
const HEADER_H = 110; // logo + kicker block, page 1 only
const FOOTER_TOP = 56; // content must stay above this
const LOGO_W = 150; // placed width; height follows the asset's aspect ratio

const FOREST = rgb(0x23 / 255, 0x30 / 255, 0x28 / 255); // #233028
const INK = rgb(0x18 / 255, 0x18 / 255, 0x18 / 255); // #181818
const LABEL_GRAY = rgb(0.44, 0.45, 0.44);
const HAIRLINE = rgb(0xe0 / 255, 0xe0 / 255, 0xe0 / 255); // #e0e0e0

// The real site logo (index.html's header mark), rasterized from that SVG with
// the Inter webfont applied. Read once per cold start; pdf-lib takes PNG bytes.
// Resolved via import.meta.url so the bundler traces it as a dependency.
let LOGO_PNG = null;
try {
  LOGO_PNG = fs.readFileSync(new URL('./velora-logo.png', import.meta.url));
} catch (err) {
  console.error('[pdf] logo asset missing:', err?.message || err);
}

const LABEL_SIZE = 8;
const VALUE_SIZE = 10;
const VALUE_LEADING = 13;
const DASH = '—';

// ---------------------------------------------------------------- formatting

const blank = (v) =>
  v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

const digits = (v) => String(v ?? '').replace(/\D/g, '');

// The standard PDF fonts are WinAnsi-encoded; anything outside that range makes
// drawText throw. Fold the punctuation users actually paste, drop the rest.
const FOLD = {
  '‘': "'", '’': "'", '‚': "'", '‛': "'",
  '“': '"', '”': '"', '„': '"',
  '′': "'", '″': '"', ' ': ' ',
  '‐': '-', '‑': '-', '‒': '-', '−': '-',
};
const KEEP_HIGH = new Set([0x2013, 0x2014, 0x2022, 0x2026]); // – — • …

function sanitize(text) {
  let out = '';
  for (const ch of String(text)) {
    if (FOLD[ch] !== undefined) { out += FOLD[ch]; continue; }
    const cp = ch.codePointAt(0);
    if (cp === 0x0a || cp === 0x0d || cp === 0x09) { out += ' '; continue; }
    if (cp < 0x20) continue;
    if (cp <= 0xff || KEEP_HIGH.has(cp)) out += ch;
  }
  return out;
}

function text(v) {
  if (blank(v)) return DASH;
  const s = sanitize(String(v)).trim();
  return s || DASH;
}

function fmtSSN(v) {
  const d = digits(v);
  if (d.length !== 9) return text(v);
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

function fmtEIN(v) {
  const d = digits(v);
  if (d.length !== 9) return text(v);
  return `${d.slice(0, 2)}-${d.slice(2)}`;
}

function fmtPhone(v) {
  let d = digits(v);
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  if (d.length !== 10) return text(v);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

function fmtMoney(v) {
  if (blank(v)) return DASH;
  const raw = sanitize(String(v)).trim();
  const found = raw.match(/\d[\d,]*(?:\.\d+)?/g);
  // Ranges ("50k-100k") and free text pass through untouched.
  if (!found || found.length !== 1) return raw || DASH;
  const n = Number(found[0].replace(/,/g, ''));
  if (!isFinite(n)) return raw;
  const [whole, cents] = n.toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return cents === '00' ? `$${grouped}` : `$${grouped}.${cents}`;
}

function fmtDate(v) {
  if (blank(v)) return DASH;
  const raw = String(v).trim();
  // Plain date columns ('YYYY-MM-DD') must not be shifted by a UTC parse.
  const plain = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (plain) return `${plain[2]}/${plain[3]}/${plain[1]}`;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return text(raw);
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getUTCFullYear()}`;
}

function fmtBool(v) {
  if (v === true || v === 'true' || v === 'Yes') return 'Yes';
  if (v === false || v === 'false' || v === 'No') return 'No';
  return DASH;
}

function fmtPct(v) {
  if (blank(v)) return DASH;
  const s = sanitize(String(v)).trim();
  return s.endsWith('%') ? s : `${s}%`;
}

function joinLines(parts, sep = ', ') {
  const kept = parts.filter((p) => !blank(p)).map((p) => sanitize(String(p)).trim());
  return kept.length ? kept.join(sep) : DASH;
}

// Original upload name, recovered from the stored object path
// ("<appId>/bank-statements/0-march.pdf" -> "march.pdf").
export function fileNameFromPath(path) {
  const last = String(path || '').split('/').pop() || 'document';
  return last.replace(/^\d+-/, '') || 'document';
}

// ------------------------------------------------------------------- helpers

function trackedWidth(str, font, size, tracking) {
  return font.widthOfTextAtSize(str, size) + tracking * Math.max(0, str.length - 1);
}

function drawTracked(page, str, { x, y, size, font, color, tracking }) {
  let cx = x;
  for (const ch of str) {
    page.drawText(ch, { x: cx, y, size, font, color });
    cx += font.widthOfTextAtSize(ch, size) + tracking;
  }
}

function wrap(str, font, size, maxW) {
  const words = String(str).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  const push = () => { if (line) { lines.push(line); line = ''; } };

  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxW) { line = candidate; continue; }
    push();
    if (font.widthOfTextAtSize(word, size) <= maxW) { line = word; continue; }
    // A single token wider than the column (a long URL, a run-on string).
    let chunk = '';
    for (const ch of word) {
      if (chunk && font.widthOfTextAtSize(chunk + ch, size) > maxW) {
        lines.push(chunk);
        chunk = ch;
      } else {
        chunk += ch;
      }
    }
    line = chunk;
  }
  push();
  return lines.length ? lines : [DASH];
}

// ---------------------------------------------------------------- the builder

export async function buildApplicationPdf(app = {}) {
  const pdf = await PDFDocument.create();
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);

  const submittedOn = fmtDate(app.created_at || app.agreed_terms_at || new Date().toISOString());

  let logo = null;
  if (LOGO_PNG) {
    try {
      logo = await pdf.embedPng(LOGO_PNG);
    } catch (err) {
      // Header still renders without it — better than failing the whole PDF.
      console.error('[pdf] logo embed failed:', err?.message || err);
    }
  }

  pdf.setTitle(`Velora Capital Funding Application - ${text(app.legal_name)}`);
  pdf.setAuthor('Velora Capital Group');
  pdf.setSubject('Funding Application');
  pdf.setProducer('veloracapitalgrp.com');

  let page = null;
  let y = 0;

  function drawHeader() {
    // Logo top-left, as the embedded image — never redrawn from primitives.
    if (logo) {
      const h = LOGO_W * (logo.height / logo.width);
      page.drawImage(logo, { x: M, y: PAGE_H - 48 - h, width: LOGO_W, height: h });
    }

    const kicker = 'FUNDING APPLICATION';
    const kickerW = trackedWidth(kicker, bold, 10, 2);
    drawTracked(page, kicker, {
      x: PAGE_W - M - kickerW, y: PAGE_H - 70, size: 10, font: bold, color: INK, tracking: 2,
    });
    const dateLine = `Submitted ${submittedOn}`;
    page.drawText(dateLine, {
      x: PAGE_W - M - regular.widthOfTextAtSize(dateLine, 9),
      y: PAGE_H - 86, size: 9, font: regular, color: LABEL_GRAY,
    });

    // Hairline separating the header block from the body.
    page.drawRectangle({
      x: M, y: PAGE_H - HEADER_H - 8, width: CONTENT_W, height: 0.75, color: HAIRLINE,
    });
  }

  function newPage() {
    const first = pdf.getPageCount() === 0;
    page = pdf.addPage([PAGE_W, PAGE_H]);
    if (first) {
      drawHeader();
      y = PAGE_H - HEADER_H - 34;
    } else {
      // Continuation pages carry no header, so content starts at the margin.
      y = PAGE_H - M;
    }
  }

  function ensure(height) {
    if (!page || y - height < FOOTER_TOP + 14) newPage();
  }

  function section(title) {
    ensure(56);
    drawTracked(page, title.toUpperCase(), {
      x: M, y: y - 9, size: 8.5, font: bold, color: FOREST, tracking: 1.6,
    });
    const ruleY = y - 18;
    page.drawRectangle({ x: M, y: ruleY, width: CONTENT_W, height: 0.75, color: HAIRLINE });
    y = ruleY - 16;
  }

  function fieldHeight(value, font, maxW) {
    const lines = wrap(value, font, VALUE_SIZE, maxW);
    return 20 + (lines.length - 1) * VALUE_LEADING + 11;
  }

  function drawField(x, top, width, label, value) {
    page.drawText(sanitize(label).toUpperCase(), {
      x, y: top - LABEL_SIZE, size: LABEL_SIZE, font: regular, color: LABEL_GRAY,
    });
    const lines = wrap(value, regular, VALUE_SIZE, width);
    let ly = top - 20;
    for (const line of lines) {
      page.drawText(line, { x, y: ly, size: VALUE_SIZE, font: regular, color: INK });
      ly -= VALUE_LEADING;
    }
  }

  // Two-column row; pass a single pair for a half-width field on its own line.
  function row(left, right) {
    const lh = fieldHeight(left[1], regular, COL_W);
    const rh = right ? fieldHeight(right[1], regular, COL_W) : 0;
    const h = Math.max(lh, rh);
    ensure(h);
    const top = y;
    drawField(M, top, COL_W, left[0], left[1]);
    if (right) drawField(M + COL_W + GUTTER, top, COL_W, right[0], right[1]);
    y = top - h;
    page.drawRectangle({ x: M, y: y + 4, width: CONTENT_W, height: 0.5, color: HAIRLINE });
  }

  // Full-width field, for prose and long lists.
  function rowFull(label, value) {
    const h = fieldHeight(value, regular, CONTENT_W);
    ensure(h);
    const top = y;
    drawField(M, top, CONTENT_W, label, value);
    y = top - h;
    page.drawRectangle({ x: M, y: y + 4, width: CONTENT_W, height: 0.5, color: HAIRLINE });
  }

  newPage();

  // -- Business Information ---------------------------------------------------
  section('Business Information');
  row(
    ['Legal / Corporate Name', text(app.legal_name)],
    ['DBA / Trade Name', text(app.dba)],
  );
  row(
    ['Business Address', joinLines([app.business_street, app.business_street2], ' ')],
    ['City / State / ZIP', joinLines([app.business_city, joinLines([app.business_state, app.business_zip], ' ')])],
  );
  row(
    ['EIN', fmtEIN(app.ein)],
    ['Entity Type', text(app.entity_type)],
  );
  row(['Date Established', fmtDate(app.established_date)]);
  rowFull('Products / Services', text(app.products_services));

  // -- Owner Information ------------------------------------------------------
  section('Owner Information');
  row(
    ['Owner Name', joinLines([app.owner_first, app.owner_last], ' ')],
    ['Date of Birth', fmtDate(app.dob)],
  );
  row(
    ['Social Security Number', fmtSSN(app.ssn)],
    ['Ownership', fmtPct(app.ownership_pct)],
  );
  row(
    ['Cell Phone', fmtPhone(app.owner_cell)],
    ['Email', text(app.owner_email)],
  );
  row(
    ['Home Address', joinLines([app.home_street, app.home_street2], ' ')],
    ['City / State / ZIP', joinLines([app.home_city, joinLines([app.home_state, app.home_zip], ' ')])],
  );
  row(
    ['Estimated Credit Score', text(app.credit_score)],
    ['Best Time to Contact', text(app.best_contact_time)],
  );
  row(['Additional Owner(s)', fmtBool(app.has_additional_owner)]);

  // -- Financials -------------------------------------------------------------
  section('Financials');
  row(
    ['Total Monthly Sales', fmtMoney(app.total_monthly_sales)],
    ['Funding Requested', fmtMoney(app.funding_requested)],
  );
  row(['Open Advances / Positions', fmtBool(app.has_open_advances)]);

  // -- Consent & Compliance ---------------------------------------------------
  section('Consent & Compliance');
  row(
    ['Terms & Privacy Policy', fmtBool(app.agreed_terms)],
    ['Agreed At', fmtDate(app.agreed_terms_at)],
  );
  row(
    ['SMS Transactional Consent', fmtBool(app.sms_transactional_consent)],
    ['SMS Marketing Consent', fmtBool(app.sms_marketing_consent)],
  );

  // Signature — stored on the row as a data-URL PNG from the browser canvas.
  const signedName = joinLines([app.owner_first, app.owner_last], ' ');
  let sigImage = null;
  if (!blank(app.signature_image)) {
    try {
      const raw = String(app.signature_image);
      const base64 = raw.includes(',') ? raw.slice(raw.indexOf(',') + 1) : raw;
      sigImage = await pdf.embedPng(Buffer.from(base64, 'base64'));
    } catch (err) {
      console.error('[pdf] signature embed failed:', err?.message || err);
      sigImage = null;
    }
  }

  const SIG_MAX_W = 220;
  const SIG_MAX_H = 56;
  let sigW = 0;
  let sigH = 0;
  if (sigImage) {
    const scale = Math.min(SIG_MAX_W / sigImage.width, SIG_MAX_H / sigImage.height, 1);
    sigW = sigImage.width * scale;
    sigH = sigImage.height * scale;
  }

  const blockH = 14 + Math.max(sigH, 24) + 26;
  ensure(blockH);
  y -= 10;
  page.drawText('SIGNATURE', {
    x: M, y: y - LABEL_SIZE, size: LABEL_SIZE, font: regular, color: LABEL_GRAY,
  });
  y -= 16;

  const lineY = y - Math.max(sigH, 24);
  if (sigImage) {
    page.drawImage(sigImage, { x: M + 2, y: lineY + 4, width: sigW, height: sigH });
  }
  page.drawRectangle({ x: M, y: lineY, width: 260, height: 0.75, color: INK });
  page.drawText(signedName === DASH ? DASH : signedName, {
    x: M, y: lineY - 13, size: 9, font: regular, color: INK,
  });
  const signedOn = `Signed ${fmtDate(app.agreed_terms_at || app.created_at)}`;
  page.drawText(signedOn, {
    x: M + 260 - regular.widthOfTextAtSize(signedOn, 9),
    y: lineY - 13, size: 9, font: regular, color: LABEL_GRAY,
  });
  y = lineY - 26;

  // -- Footers (every page; drawn last so the page total is known) -------------
  const pages = pdf.getPages();
  const total = pages.length;
  const contact = 'support@veloracapitalgrp.com · 845-552-4810 · veloracapitalgrp.com';
  pages.forEach((p, i) => {
    p.drawRectangle({ x: M, y: FOOTER_TOP - 12, width: CONTENT_W, height: 0.5, color: HAIRLINE });
    // 6.5pt keeps the contact line clear of the centered CONFIDENTIAL mark.
    p.drawText(contact, {
      x: M, y: FOOTER_TOP - 26, size: 6.5, font: regular, color: LABEL_GRAY,
    });
    const mid = 'CONFIDENTIAL';
    const midW = trackedWidth(mid, bold, 7, 1.2);
    drawTracked(p, mid, {
      x: (PAGE_W - midW) / 2, y: FOOTER_TOP - 26, size: 7, font: bold, color: LABEL_GRAY, tracking: 1.2,
    });
    const pageLabel = `Page ${i + 1} of ${total}`;
    p.drawText(pageLabel, {
      x: PAGE_W - M - regular.widthOfTextAtSize(pageLabel, 7.5),
      y: FOOTER_TOP - 26, size: 7.5, font: regular, color: LABEL_GRAY,
    });
  });

  return Buffer.from(await pdf.save());
}
