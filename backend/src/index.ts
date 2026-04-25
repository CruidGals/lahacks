import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { healthRouter } from './routes/health.js';
import { bountyRouter } from './routes/bounties.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

app.use('/health', healthRouter);
app.use('/api/bounties', bountyRouter);

const port = Number(process.env.PORT ?? 8080);
app.listen(port, () => {
  console.log(`backend listening on http://localhost:${port}`);
});
