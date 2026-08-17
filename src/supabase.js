import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// This bot writes WhatsApp device credentials (sessions table) and coin
// balances (users table) directly, with RLS enabled and no public policies
// on those tables — so it MUST use the SERVICE ROLE key, never the anon key.
// Get it from Supabase Dashboard → Project Settings → API → service_role.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error(
    '❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment (.env)'
  );
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export default supabase;
