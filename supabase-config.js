// supabase-config.js
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);
export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export const SUPABASE_CONFIG = {
  url: supabaseUrl,
  serviceKey: supabaseServiceKey,
  anonKey: supabaseAnonKey
};
