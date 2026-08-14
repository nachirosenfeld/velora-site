import { createClient } from '@supabase/supabase-js';

// Service-role client. Used ONLY server-side inside API functions.
// The service_role key bypasses RLS — it must never reach the browser.
const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  // Fail loud at cold start rather than silently mis-behaving per request.
  console.error('[supabase] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env var');
}

export const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const BUCKET = 'application-files';
