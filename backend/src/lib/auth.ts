import type { Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import type { Tables } from '../types/database.types.js';

export type AuthedUser = Tables<'users'>;

function extractUserIdFromAuthHeader(headerValue?: string): string | null {
  if (!headerValue) return null;
  const [scheme, token] = headerValue.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token.trim();
}

export async function requireAuthUser(
  req: Request,
  res: Response
): Promise<AuthedUser | null> {
  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return null;
  }

  const userId =
    extractUserIdFromAuthHeader(req.header('authorization')) ??
    req.header('x-user-id') ??
    null;

  if (!userId) {
    res.status(401).json({
      error:
        'Missing auth. Provide Authorization: Bearer <user_id> or x-user-id header.'
    });
    return null;
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: 'Failed to load authenticated user.' });
    return null;
  }

  if (!user) {
    res.status(401).json({ error: 'Authenticated user does not exist.' });
    return null;
  }

  return user;
}

export function requireInternalToken(req: Request, res: Response): boolean {
  const configured = process.env.INTERNAL_API_TOKEN;
  if (!configured) {
    return true;
  }

  const token = req.header('x-internal-token');
  if (!token || token !== configured) {
    res.status(401).json({ error: 'Invalid internal token.' });
    return false;
  }
  return true;
}
