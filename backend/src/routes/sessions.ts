import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuthUser } from '../lib/auth.js';
import { isClaimExpired } from '../lib/bounties.js';

export const sessionRouter = Router();

const startSessionSchema = z.object({
  bounty_id: z.uuid()
});

const pingSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(1_000).optional(),
  timestamp: z.iso.datetime()
});

function createNonce(length = 8): string {
  return Math.random()
    .toString(36)
    .slice(2, 2 + length)
    .toUpperCase();
}

sessionRouter.post('/start', async (req, res) => {
  const user = await requireAuthUser(req, res);
  if (!user) return;

  if (!user.verified) {
    res.status(403).json({ error: 'World ID verification is required.' });
    return;
  }

  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const parsed = startSessionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { data: bounty, error: bountyError } = await supabase
    .from('bounties')
    .select('*')
    .eq('id', parsed.data.bounty_id)
    .maybeSingle();

  if (bountyError) {
    res.status(500).json({ error: 'Failed to load bounty.' });
    return;
  }
  if (!bounty) {
    res.status(404).json({ error: 'Bounty not found.' });
    return;
  }
  if (bounty.status !== 'claimed' || bounty.claimer_id !== user.id) {
    res.status(403).json({ error: 'You must claim this bounty first.' });
    return;
  }
  if (isClaimExpired(bounty.claimed_at)) {
    res.status(409).json({ error: 'Claim lock has expired.' });
    return;
  }

  const nonce = createNonce();
  const nowIso = new Date().toISOString();
  const { data: existingSession, error: existingSessionError } = await supabase
    .from('sessions')
    .select('*')
    .eq('bounty_id', bounty.id)
    .eq('user_id', user.id)
    .order('started_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existingSessionError) {
    res.status(500).json({ error: 'Failed to load existing session state.' });
    return;
  }

  // If an active session already exists, return it idempotently so clients can
  // safely retry "start" without creating duplicate rows.
  if (existingSession?.status === 'active') {
    res.status(200).json({
      session_id: existingSession.id,
      nonce: existingSession.nonce
    });
    return;
  }

  let session: { id: string } | null = null;
  let sessionError: { message?: string } | null = null;

  if (existingSession) {
    const { data: reactivatedSession, error: reactivatedSessionError } =
      await supabase
        .from('sessions')
        .update({
          nonce,
          status: 'active',
          started_at: nowIso,
          ended_at: null
        })
        .eq('id', existingSession.id)
        .select('*')
        .single();

    if (!reactivatedSessionError && reactivatedSession) {
      // Start from a clean trajectory window for the new claim/session run.
      const { error: deletePingError } = await supabase
        .from('gps_pings')
        .delete()
        .eq('session_id', reactivatedSession.id);
      if (deletePingError) {
        res.status(500).json({ error: 'Failed to reset previous GPS pings.' });
        return;
      }
    }

    session = reactivatedSession;
    sessionError = reactivatedSessionError;
  } else {
    const { data: insertedSession, error: insertedSessionError } = await supabase
      .from('sessions')
      .insert({
        bounty_id: bounty.id,
        user_id: user.id,
        nonce,
        status: 'active'
      })
      .select('*')
      .single();

    session = insertedSession;
    sessionError = insertedSessionError;
  }

  if (sessionError || !session) {
    res.status(500).json({ error: 'Failed to start session.' });
    return;
  }

  res.status(201).json({
    session_id: session.id,
    nonce
  });
});

sessionRouter.post('/:id/ping', async (req, res) => {
  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const user = await requireAuthUser(req, res);
  if (!user) return;

  if (!user.verified) {
    res.status(403).json({ error: 'World ID verification is required.' });
    return;
  }

  const parsed = pingSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { data: session, error: sessionError } = await supabase
    .from('sessions')
    .select('*')
    .eq('id', req.params.id)
    .maybeSingle();

  if (sessionError) {
    res.status(500).json({ error: 'Failed to load session.' });
    return;
  }
  if (!session) {
    res.status(404).json({ error: 'Session not found.' });
    return;
  }
  if (session.user_id !== user.id) {
    res.status(403).json({ error: 'Cannot append pings to another user session.' });
    return;
  }
  if (session.status !== 'active') {
    res.status(409).json({ error: 'Session is not active.' });
    return;
  }

  const { error: pingError } = await supabase.from('gps_pings').insert({
    session_id: session.id,
    lat: parsed.data.lat,
    lng: parsed.data.lng,
    accuracy: parsed.data.accuracy ?? null,
    timestamp: parsed.data.timestamp
  });

  if (pingError) {
    res.status(500).json({ error: 'Failed to store GPS ping.' });
    return;
  }

  res.status(200).json({ ok: true });
});
