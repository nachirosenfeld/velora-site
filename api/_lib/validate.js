// Validation + coercion for the application payload.
// Returns { ok:true, data } or { ok:false, errors:[...] }.

const digits = (v) => (v == null ? '' : String(v).replace(/\D/g, ''));
const s = (v) => (v == null ? '' : String(v).trim());

const ENTITY_TYPES = ['Sole Proprietor', 'Partnership', 'Non-Profit', 'LLC', 'Corporation'];

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Referral code. Must survive the same test the page applied before storing it;
// anything else is dropped whole rather than sanitised into something valid.
const REF_RE = /^[a-z0-9]{2,8}$/;

const OPEN_ADVANCE_DETAIL_MAX = 500;

const yes = (v) => v === true || v === 'true' || v === 'Yes';

// integer column on our side and theirs — null rather than a partial number.
function intOrNull(v, { max } = {}) {
  const raw = s(v).replace(/[%,\s]/g, '');
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  if (max !== undefined && n > max) return null;
  return n;
}

function ageFrom(dobStr) {
  const d = new Date(dobStr);
  if (isNaN(d)) return null;
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age;
}

export function validateApplication(body) {
  const errors = [];
  const req = (val, label) => {
    if (!s(val)) errors.push(`${label} is required`);
  };

  // Business
  req(body.legal_name, 'Legal / Corporate Name');
  req(body.business_street, 'Business street');
  req(body.business_city, 'Business city');
  req(body.business_state, 'Business state');
  req(body.business_zip, 'Business zip');

  const ein = digits(body.ein);
  if (ein.length !== 9) errors.push('EIN must be 9 digits');

  if (!ENTITY_TYPES.includes(s(body.entity_type))) errors.push('Valid entity type is required');
  req(body.products_services, 'Products or services');

  // Owner
  req(body.owner_first, 'Owner first name');
  req(body.owner_last, 'Owner last name');

  const cell = digits(body.owner_cell);
  if (cell.length !== 10) errors.push('Cell phone must be 10 digits');

  const email = s(body.owner_email);
  if (!EMAIL_RE.test(email)) errors.push('Valid email is required');

  req(body.home_street, 'Home street');
  req(body.home_city, 'Home city');
  req(body.home_state, 'Home state');
  req(body.home_zip, 'Home zip');

  const ssn = digits(body.ssn);
  if (ssn.length !== 9) errors.push('SSN must be 9 digits');

  const dob = s(body.dob);
  const age = dob ? ageFrom(dob) : null;
  if (dob && (age == null || age < 18)) errors.push('Owner must be at least 18');

  const ownPct = Number(s(body.ownership_pct).replace('%', ''));
  if (isNaN(ownPct) || ownPct < 0 || ownPct > 100) errors.push('Ownership % must be 0-100');

  // Second owner. Only trusted when the additional-owner answer is Yes — if it
  // is No the whole block is discarded server-side too, so a stale value that
  // survived the client-side clear can never reach the row.
  const hasPartner = yes(body.has_additional_owner);
  const partnerEmail = s(body.partner_email);
  if (hasPartner && !EMAIL_RE.test(partnerEmail)) {
    errors.push('Valid second owner email is required');
  }

  // Open advances detail, same conditional-trust rule.
  const hasAdvances = yes(body.has_open_advances);
  const advanceDetail = s(body.open_advance_detail);
  if (hasAdvances && advanceDetail.length > OPEN_ADVANCE_DETAIL_MAX) {
    errors.push(`Open advance details must be ${OPEN_ADVANCE_DETAIL_MAX} characters or fewer`);
  }

  // Consent — the gate
  if (body.agreed_terms !== true && body.agreed_terms !== 'true') {
    errors.push('You must agree to the Terms & Conditions and Privacy Policy');
  }

  if (errors.length) return { ok: false, errors };

  const refRaw = s(body.ref).toLowerCase();
  const ref = REF_RE.test(refRaw) ? refRaw : null;

  const data = {
    legal_name: s(body.legal_name),
    dba: s(body.dba) || null,
    business_street: s(body.business_street),
    business_street2: s(body.business_street2) || null,
    business_city: s(body.business_city),
    business_state: s(body.business_state),
    business_zip: s(body.business_zip),
    ein,
    entity_type: s(body.entity_type),
    established_date: s(body.established_date) || null,
    products_services: s(body.products_services),

    owner_first: s(body.owner_first),
    owner_last: s(body.owner_last),
    owner_cell: cell,
    owner_email: email,
    home_street: s(body.home_street),
    home_street2: s(body.home_street2) || null,
    home_city: s(body.home_city),
    home_state: s(body.home_state),
    home_zip: s(body.home_zip),
    dob: dob || null,
    ssn,
    credit_score: s(body.credit_score) || null,
    ownership_pct: s(body.ownership_pct) || null,
    best_contact_time: s(body.best_contact_time) || null,
    has_additional_owner: hasPartner,

    partner_first_name: hasPartner ? s(body.partner_first_name) || null : null,
    partner_last_name: hasPartner ? s(body.partner_last_name) || null : null,
    partner_cell: hasPartner ? digits(body.partner_cell) || null : null,
    partner_email: hasPartner ? partnerEmail || null : null,
    partner_home_street: hasPartner ? s(body.partner_home_street) || null : null,
    partner_home_street2: hasPartner ? s(body.partner_home_street2) || null : null,
    partner_home_city: hasPartner ? s(body.partner_home_city) || null : null,
    partner_home_state: hasPartner ? s(body.partner_home_state) || null : null,
    partner_home_zip: hasPartner ? s(body.partner_home_zip) || null : null,
    partner_dob: hasPartner ? s(body.partner_dob) || null : null,
    partner_ssn: hasPartner ? digits(body.partner_ssn) || null : null,
    partner_credit_score: hasPartner ? intOrNull(body.partner_credit_score) : null,
    partner_ownership_pct: hasPartner ? intOrNull(body.partner_ownership_pct, { max: 100 }) : null,

    total_monthly_sales: s(body.total_monthly_sales) || null,
    has_open_advances: hasAdvances,
    open_advance_detail: hasAdvances ? advanceDetail.slice(0, OPEN_ADVANCE_DETAIL_MAX) || null : null,
    funding_requested: s(body.funding_requested) || null,

    ref,

    sms_transactional_consent: body.sms_transactional_consent === true || body.sms_transactional_consent === 'true',
    sms_marketing_consent: body.sms_marketing_consent === true || body.sms_marketing_consent === 'true',
    signature_image: s(body.signature_image) || null,
    agreed_terms: true,
  };

  return { ok: true, data };
}

export const ALLOWED_ENTITY_TYPES = ENTITY_TYPES;
