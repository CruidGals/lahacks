import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuthUser } from '../lib/auth.js';

export const usersRouter = Router();

const createUserSchema = z.object({
  id: z.string().uuid().optional(),
  wallet_address: z.string().min(1).max(256),
  verified: z.boolean().optional(),
  world_id_hash: z.string().min(1).max(2048).optional()
});

const verifyWorldIdSchema = z.object({
  world_id_hash: z.string().min(1).max(2048)
});

usersRouter.post('/', async (req, res) => {
  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const parsed = createUserSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const payload = {
    id: parsed.data.id,
    wallet_address: parsed.data.wallet_address,
    verified: parsed.data.verified ?? false,
    world_id_hash: parsed.data.world_id_hash ?? null
  };

  const { data: created, error } = await supabase
    .from('users')
    .insert(payload)
    .select('*')
    .single();

  if (error) {
    if (error.code === '23505') {
      res.status(409).json({ error: 'User already exists.' });
      return;
    }
    res.status(500).json({ error: 'Failed to create user.' });
    return;
  }

  res.status(201).json({ ok: true, user: created });
});

usersRouter.get('/:id', async (req, res) => {
  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const idSchema = z.string().uuid();
  const parsedId = idSchema.safeParse(req.params.id);
  if (!parsedId.success) {
    res.status(400).json({ error: 'Invalid user id.' });
    return;
  }

  const { data: user, error } = await supabase
    .from('users')
    .select('*')
    .eq('id', parsedId.data)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: 'Failed to load user.' });
    return;
  }
  if (!user) {
    res.status(404).json({ error: 'User not found.' });
    return;
  }

  res.json({ user });
});

usersRouter.post('/verify', async (req, res) => {
  const user = await requireAuthUser(req, res);
  if (!user) return;

  if (!supabase) {
    res.status(500).json({ error: 'Supabase is not configured.' });
    return;
  }

  const parsed = verifyWorldIdSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const { data: updated, error } = await supabase
    .from('users')
    .update({
      world_id_hash: parsed.data.world_id_hash,
      verified: true
    })
    .eq('id', user.id)
    .select('*')
    .single();

  if (error || !updated) {
    res.status(500).json({ error: 'Failed to store World ID verification.' });
    return;
  }

  res.json({ ok: true, user: updated });
});
