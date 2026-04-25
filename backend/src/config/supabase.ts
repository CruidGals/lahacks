import { createClient } from '@supabase/supabase-js';

function isValidHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

const supabaseUrlRaw = process.env.SUPABASE_URL?.trim();
const serviceRoleRaw = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

const supabaseUrl =
  supabaseUrlRaw && isValidHttpUrl(supabaseUrlRaw) ? supabaseUrlRaw : undefined;
const serviceRole =
  serviceRoleRaw && serviceRoleRaw.length > 0 ? serviceRoleRaw : undefined;

if (supabaseUrlRaw && !supabaseUrl) {
  console.warn(
    '[supabase] SUPABASE_URL is set but invalid (must be http/https). Database client disabled until fixed.'
  );
}

export const supabase =
  supabaseUrl && serviceRole ? createClient(supabaseUrl, serviceRole) : null;
