// Validation + coercion for the application payload.
// Returns { ok:true, data } or { ok:false, errors:[...] }.

const digits = (v) => (v == null ? '' : String(v).replace(/\D/g, ''));
const s = (v) => (v == null ? '' : String(v).trim());

const ENTITY_TYPES = ['Sole Proprietor', 'Partnership', 'Non-Profit', 'LLC', 'Corporation'];

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
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push('Valid email is required');

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

  // Consent — the gate
  if (body.agreed_terms !== true && body.agreed_terms !== 'true') {
    errors.push('You must agree to the Terms & Conditions and Privacy Policy');
  }

  if (errors.length) return { ok: false, errors };

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
    has_additional_owner: body.has_additional_owner === true || body.has_additional_owner === 'true' || body.has_additional_owner === 'Yes',

    total_monthly_sales: s(body.total_monthly_sales) || null,
    has_open_advances: body.has_open_advances === true || body.has_open_advances === 'true' || body.has_open_advances === 'Yes',
    funding_requested: s(body.funding_requested) || null,

    sms_transactional_consent: body.sms_transactional_consent === true || body.sms_transactional_consent === 'true',
    sms_marketing_consent: body.sms_marketing_consent === true || body.sms_marketing_consent === 'true',
    signature_image: s(body.signature_image) || null,
    agreed_terms: true,
  };

  return { ok: true, data };
}

export const ALLOWED_ENTITY_TYPES = ENTITY_TYPES;
