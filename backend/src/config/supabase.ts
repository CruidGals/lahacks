import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabase =
  supabaseUrl && serviceRole ? createClient(supabaseUrl, serviceRole) : null;
