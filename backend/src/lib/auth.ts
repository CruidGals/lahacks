import type { Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import type { Tables } from '../types/database.types.js';

export type AuthedUser = Tables<'users'>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function extractBearerToken(headerValue?: string): string | null {
  if (!headerValue) return null;
  const [scheme, ...rest] = headerValue.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || rest.length === 0) return null;
  return rest.join(' ').trim();
}

function looksLikeJwt(token: string): boolean {
  const parts = token.split('.');
  return parts.length === 3 && parts.every((p) => p.length > 0);
}

export async function requireAuthUser(
  req: Request,
  res: Response
): Promise<AuthedUser | null> {
  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return null;
  }

  const bearer = extractBearerToken(req.header('authorization'));
  const headerUserId = req.header('x-user-id')?.trim() ?? null;
  const token = bearer ?? headerUserId;

  if (!token) {
    res.status(401).json({
      error:
        'Missing auth. Use Authorization: Bearer <Supabase JWT> or Bearer <user uuid>, or x-user-id.'
    });
    return null;
  }

  if (looksLikeJwt(token)) {
    const { data: authData, error: authError } =
      await supabase.auth.getUser(token);
    if (!authError && authData.user?.id) {
      const { data: user, error } = await supabase
        .from('users')
        .select('*')
        .eq('id', authData.user.id)
        .maybeSingle();
      if (error) {
        res.status(500).json({ error: 'Failed to load authenticated user.' });
        return null;
      }
      if (user) return user;
    }
  }

  if (UUID_RE.test(token)) {
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', token)
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

  res.status(401).json({
    error: 'Invalid token. Provide a Supabase session JWT or a valid user id.'
  });
  return null;
}

export function requireInternalToken(req: Request, res: Response): boolean {
  const configured = process.env.INTERNAL_API_TOKEN?.trim();
  if (!configured) {
    return true;
  }

  const headerToken = req.header('x-internal-token')?.trim();
  const bearer = extractBearerToken(req.header('authorization'));
  const token = headerToken ?? bearer;

  if (!token || token !== configured) {
    res.status(401).json({
      error: 'Invalid internal token. Send x-internal-token or Authorization: Bearer <token>.'
    });
    return false;
  }
  return true;
}
