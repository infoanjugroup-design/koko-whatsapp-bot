import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

// This bot writes WhatsApp device credentials (public.sessions) and reads/
// writes coin balances on the site's REAL wallet tables — public.user_wallets
// and public.coin_transactions (see supabase/migrations/0006 + 0010 + 0011).
// RLS is enabled with no public policies on these tables, so this MUST use
// the SERVICE ROLE key, never the anon key.
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
