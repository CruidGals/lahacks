import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../config/supabase.js';
import { requireAuthUser } from '../lib/auth.js';

export const usersRouter = Router();

const verifyWorldIdSchema = z.object({
  world_id_hash: z.string().min(1).max(2048)
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
