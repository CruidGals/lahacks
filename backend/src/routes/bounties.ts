import { Router } from 'express';

export const bountyRouter = Router();

bountyRouter.get('/', (_req, res) => {
  res.json({ items: [], message: 'Bounty listing scaffold endpoint' });
});

bountyRouter.post('/', (req, res) => {
  res.status(201).json({
    message: 'Create bounty scaffold endpoint',
    payload: req.body
  });
});
