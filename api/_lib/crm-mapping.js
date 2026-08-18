// Our applications row -> the CRM's public intake body.
//
// One pure function. No I/O, no env, no logging — give it a row, get an object.
//
// THE ALLOWLIST IS LOAD-BEARING, NOT STYLE. The CRM's honeypot trips on a
// company_website key holding a non-empty string: it answers 200 with no
// submission_id and nothing is created. Their schema otherwise strips unknown
// keys silently, so a stray field is not itself fatal — but a spread of our row
// would ship every column we ever add, and one of them landing on that name
// loses the application with a success response. The output is assembled key by
// key from EMIT below and nothing else. Adding a field to the payload means
// adding a line here on purpose.

// Their entity_type check constraint accepts exactly these six. Our form offers
// five labels (apply.html select), which cover all but s_corp — we have no
// source value that could produce it, so it is simply never emitted. Anything
// unrecognised omits the key rather than guessing a default.
const ENTITY_TYPES = {
  'sole proprietor': 'sole_prop',
  'partnership': 'partnership',
  'non-profit': 'non_profit',
  'llc': 'llc',
  'corporation': 'corp',
};

// Keys that must never appear in the outgoing body. Nothing below can produce
// one — every value is written through put() from an explicit name — so this is
// a tripwire for a future edit, not a filter the happy path relies on.
const FORBIDDEN = new Set(['company_website', 'website_url_hp', 'url', 'homepage']);

const str = (v) => {
  if (v == null) return undefined;
  const s = String(v).trim();
  return s ? s : undefined;
};

// Their parser coerces a non-numeric string to 0 and strips minus signs, so a
// junk value lands as wrong data instead of an error. Everything that is not
// unambiguously a non-negative number is dropped instead of sent.
const num = (v) => {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : undefined;
  if (v == null) return undefined;
  const cleaned = String(v).replace(/[$,\s%]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return undefined; // rejects '', '-5', 'n/a', 'approx 50k'
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
};

// owner_credit_score / ownership_pct / partner_* are integer columns there.
const int = (v, { max } = {}) => {
  const n = num(v);
  if (n === undefined) return undefined;
  const rounded = Math.round(n);
  if (max !== undefined && rounded > max) return undefined;
  return rounded;
};

// Our booleans arrive as real booleans (validate.js coerces before insert), but
// accept the raw "Yes"/"No" the form posts too. Anything else omits the key.
const bool = (v) => {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (s === 'yes' || s === 'true') return true;
  if (s === 'no' || s === 'false') return false;
  return undefined;
};

// dob / established_date / partner_dob are `date` columns, so PostgREST hands
// them back as 'YYYY-MM-DD' already. Tolerate a Date or a full ISO timestamp in
// case a caller passes a pre-insert payload instead of a row.
const date = (v) => {
  if (!v) return undefined;
  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? undefined : v.toISOString().slice(0, 10);
  }
  const m = String(v).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : undefined;
};

const entityType = (v) => {
  const s = str(v);
  return s ? ENTITY_TYPES[s.toLowerCase()] : undefined;
};

// Every emitted key, in one table: [outgoing name, source column, converter].
// Read this as the contract.
const EMIT = [
  // Business
  ['legal_name',               'legal_name',            str],
  ['dba',                      'dba',                   str],
  ['business_street',          'business_street',       str],
  ['business_street2',         'business_street2',      str],
  ['business_city',            'business_city',         str],
  ['business_state',           'business_state',        str],
  ['business_zip',             'business_zip',          str],
  ['ein',                      'ein',                   str],
  ['entity_type',              'entity_type',           entityType],
  ['business_established_date', 'established_date',     date],
  ['products_or_services',     'products_services',     str],

  // Owner
  ['owner_first_name',         'owner_first',           str],
  ['owner_last_name',          'owner_last',            str],
  ['owner_cell',               'owner_cell',            str],
  ['owner_email',              'owner_email',           str],
  ['owner_home_street',        'home_street',           str],
  ['owner_home_street2',       'home_street2',          str],
  ['owner_home_city',          'home_city',             str],
  ['owner_home_state',         'home_state',            str],
  ['owner_home_zip',           'home_zip',              str],
  ['owner_dob',                'dob',                   date],
  ['owner_ssn',                'ssn',                   str],
  ['owner_credit_score',       'credit_score',          int],
  ['ownership_pct',            'ownership_pct',         (v) => int(v, { max: 100 })],
  ['contact_preference',       'best_contact_time',     str],
  ['additional_owner',         'has_additional_owner',  bool],

  // Financials
  ['total_monthly_sales',      'total_monthly_sales',   num],
  ['has_open_advances',        'has_open_advances',     bool],
  ['open_advance_lender',      'open_advance_detail',   str],
  ['funding_amount_requested', 'funding_requested',     num],

  // Second owner — passes through under its own names.
  ['partner_first_name',       'partner_first_name',    str],
  ['partner_last_name',        'partner_last_name',     str],
  ['partner_cell',             'partner_cell',          str],
  ['partner_email',            'partner_email',         str],
  ['partner_home_street',      'partner_home_street',   str],
  ['partner_home_street2',     'partner_home_street2',  str],
  ['partner_home_city',        'partner_home_city',     str],
  ['partner_home_state',       'partner_home_state',    str],
  ['partner_home_zip',         'partner_home_zip',      str],
  ['partner_dob',              'partner_dob',           date],
  ['partner_ssn',              'partner_ssn',           str],
  ['partner_credit_score',     'partner_credit_score',  int],
  ['partner_ownership_pct',    'partner_ownership_pct', (v) => int(v, { max: 100 })],

  // Consent + signature
  ['signature',                'signature_image',       str],
  ['agreed_to_terms',          'agreed_terms',          bool],
  ['sms_transactional_consent', 'sms_transactional_consent', bool],
  ['sms_marketing_consent',    'sms_marketing_consent', bool],
];

/**
 * @param {object} row - an inserted public.applications row
 * @returns {object} the CRM body, minus `ref` and `files` which the caller adds
 */
export function mapApplicationToCrm(row) {
  const src = row || {};
  const out = {};

  for (const [key, column, convert] of EMIT) {
    if (FORBIDDEN.has(key)) continue; // unreachable by construction; kept as the tripwire
    const value = convert(src[column]);
    if (value !== undefined) out[key] = value;
  }

  return out;
}

// Exported for tests and for the report; not used by the mapper's callers.
export const CRM_ENTITY_TYPES = ENTITY_TYPES;
export const CRM_EMITTED_KEYS = EMIT.map(([key]) => key);
