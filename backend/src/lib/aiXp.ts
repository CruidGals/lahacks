import { clampXp } from './bounties.js';

/**
 * Result of an XP-pipeline evaluation. Mirrors the Pydantic ``XpReward``
 * model in ``ai-service/app/pipelines/xp_pipeline.py``.
 */
export type AiXpResult = {
  xp_award: number;
  difficulty_score: number;
  importance_score: number;
  reasoning: string;
  source: 'ai' | 'fallback';
};

type AiXpInput = {
  title?: string | null;
  description: string;
  category?: string | null;
  reward_sol?: number | null;
  lat?: number | null;
  lng?: number | null;
};

const DEFAULT_TIMEOUT_MS = 12_000;

function pipelineUrl(): string | null {
  const explicit = process.env.AI_XP_URL?.trim();
  if (explicit) return explicit;

  // Reuse AI_VERIFY_URL's host: most deployments will set it once for the
  // /verify endpoint, and the XP pipeline lives on the same FastAPI app at
  // /pipelines/xp.
  const verifyUrl = process.env.AI_VERIFY_URL?.trim();
  if (verifyUrl) {
    try {
      const url = new URL(verifyUrl);
      url.pathname = '/pipelines/xp';
      url.search = '';
      url.hash = '';
      return url.toString();
    } catch {
      return null;
    }
  }

  return null;
}

function clampScore(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(10, Math.round(n)));
}

function fallbackEstimate(input: AiXpInput): AiXpResult {
  // Cheap deterministic estimator used when the AI service is unreachable.
  // Mirrors the formula in the pipeline's system prompt so dev mode and
  // production hand back broadly comparable numbers.
  const description = (input.description ?? '').trim();
  const wordCount = description.split(/\s+/).filter(Boolean).length;
  const reward = Number.isFinite(input.reward_sol ?? NaN)
    ? Number(input.reward_sol)
    : 0;

  const difficulty = Math.max(1, Math.min(10, 3 + Math.floor(wordCount / 25)));
  const importance = Math.max(1, Math.min(10, 4 + (reward >= 0.25 ? 1 : 0)));
  const base = 25 * difficulty + 25 * importance;
  const bonus = Math.round(reward * 200);
  const xp = clampXp(base + bonus);

  return {
    xp_award: xp,
    difficulty_score: difficulty,
    importance_score: importance,
    reasoning:
      '[fallback] AI service unavailable; used the deterministic difficulty/importance heuristic.',
    source: 'fallback'
  };
}

/**
 * Call the AI service's ``/pipelines/xp`` endpoint to score a bounty.
 *
 * Failures are *non-throwing* on purpose: if the AI service is offline we
 * still want bounty creation to succeed, just with a heuristic XP value.
 * Callers can inspect the ``source`` field to surface "AI"/"fallback" in
 * the UI when relevant.
 */
export async function calculateXpReward(input: AiXpInput): Promise<AiXpResult> {
  const url = pipelineUrl();
  if (!url) {
    return fallbackEstimate(input);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: input.title ?? '',
        description: input.description,
        category: input.category ?? null,
        reward_sol: input.reward_sol ?? null,
        lat: input.lat ?? null,
        lng: input.lng ?? null
      })
    });

    if (!response.ok) {
      console.warn(
        `[ai-xp] pipeline returned ${response.status}; using fallback estimate.`
      );
      return fallbackEstimate(input);
    }

    const json = (await response.json()) as Record<string, unknown>;
    return {
      xp_award: clampXp(Number(json.xp_award)),
      difficulty_score: clampScore(json.difficulty_score, 5),
      importance_score: clampScore(json.importance_score, 5),
      reasoning:
        typeof json.reasoning === 'string' && json.reasoning.length > 0
          ? json.reasoning
          : 'AI scoring did not include a reasoning string.',
      source: 'ai'
    };
  } catch (err) {
    console.warn(
      '[ai-xp] pipeline call failed; using fallback estimate:',
      err instanceof Error ? err.message : err
    );
    return fallbackEstimate(input);
  } finally {
    clearTimeout(timeout);
  }
}
