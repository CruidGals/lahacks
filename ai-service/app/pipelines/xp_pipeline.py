"""XP-reward pipeline: estimate difficulty / importance / XP for a bounty.

This is a *text-only* LLM call (no DINO, no frame extraction) used by the
backend at bounty creation time. The user describes the cleanup task and we
ask GPT to score difficulty + civic importance and convert that into an
``xp_award`` integer the claimer will earn on a verified completion.

Two flows feed into the same pipeline:

* **XP-staked bounties** -- the poster picks how much XP they want to put up.
  The pipeline still runs so the bounty record carries an honest difficulty
  score, but the returned ``xp_award`` is overridden upstream to match the
  poster's stake (you can't game the system by claiming a tiny task and
  collecting 5x the stake).
* **SOL bounties** -- the poster doesn't stake XP, so the pipeline's
  ``xp_award`` becomes the claimer's XP boost on top of the SOL payout. The
  pipeline blends difficulty + importance + reward magnitude so a $50 task in
  a high-importance category earns a meaningfully higher XP grant than a
  pocket-change cleanup.

The output schema is intentionally small so it can live next to the bounty
record without bloating list responses.
"""

from __future__ import annotations

import json
import logging

from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.pipelines.llm_client import (
    LLMRequest,
    OpenAIPipelineClient,
    join_text_blocks,
)

logger = logging.getLogger(__name__)


# --- Output schema -------------------------------------------------------- #


class XpReward(BaseModel):
    """Result returned by the XP pipeline."""

    xp_award: int = Field(
        ge=0,
        le=10_000,
        description="XP the claimer should earn for completing this bounty.",
    )
    difficulty_score: int = Field(
        ge=1,
        le=10,
        description="1=trivial, 10=major effort/expertise required.",
    )
    importance_score: int = Field(
        ge=1,
        le=10,
        description="1=cosmetic, 10=urgent civic/health risk.",
    )
    reasoning: str = Field(
        min_length=1,
        max_length=600,
        description="Short justification quoted in the UI.",
    )


# --- Prompt --------------------------------------------------------------- #


SYSTEM_PROMPT = (
    "You are the reward-calibration brain for a civic-cleanup bounty "
    "marketplace. A poster has just described a piece of work that needs "
    "doing. Your job is to score it on two axes and convert that into an "
    "integer XP reward the claimer will earn on a verified completion.\n\n"
    "Difficulty (1-10):\n"
    "  1-2  Tiny: pick up one item, a minute of work.\n"
    "  3-4  Light: a small bag of trash, single graffiti tag, < 15 minutes.\n"
    "  5-6  Moderate: a clear pile of litter, multiple items, ~30 minutes.\n"
    "  7-8  Heavy: bulky/illegal dumping, large area, special tools needed.\n"
    "  9-10 Major: hazardous waste, multi-hour, requires safety gear.\n\n"
    "Importance (1-10):\n"
    "  1-2  Cosmetic: low-traffic, minor visual impact.\n"
    "  3-4  Routine maintenance.\n"
    "  5-6  Public space, kids/pedestrians passing through.\n"
    "  7-8  Health or safety concern (broken glass, sharps, blocked path).\n"
    "  9-10 Hazardous: chemical spill, biohazard, urgent threat.\n\n"
    "XP formula guidance (you may deviate slightly when justified):\n"
    "  base = 25 * difficulty + 25 * importance\n"
    "  if a SOL reward is provided, add round(reward_sol * 200) as a bonus\n"
    "    (small SOL stakes nudge XP up a little; large stakes scale linearly).\n"
    "  Clamp the final value to [10, 5000] and round to the nearest 5.\n\n"
    "Be tight in your reasoning -- one or two sentences max, plain English, "
    "no marketing fluff. If the description is suspiciously vague or doesn't "
    "actually describe a cleanup, return a small XP value (10-25) and call "
    "that out in `reasoning`.\n\n"
    "Respond with STRICT JSON matching this schema -- no prose, no markdown:\n"
    "{\n"
    "  \"xp_award\": int,\n"
    "  \"difficulty_score\": int,  // 1..10\n"
    "  \"importance_score\": int,  // 1..10\n"
    "  \"reasoning\": str          // 1-2 sentences\n"
    "}"
)


# --- Public entrypoint ---------------------------------------------------- #


async def run_xp_pipeline(
    *,
    title: str,
    description: str,
    category: str | None = None,
    reward_sol: float | None = None,
    lat: float | None = None,
    lng: float | None = None,
    settings: Settings | None = None,
    client: OpenAIPipelineClient | None = None,
) -> XpReward:
    """Score a bounty and return an :class:`XpReward`.

    All fields besides ``description`` are optional but help the LLM ground
    its reasoning. Stub mode returns a deterministic mid-range reward so
    backend tests don't need network access.
    """

    settings = settings or get_settings()
    client = client or OpenAIPipelineClient(settings)

    payload = {
        "title": title.strip() or "(untitled)",
        "description": description.strip() or "(no description)",
        "category": category or "unspecified",
        "reward_sol": reward_sol if reward_sol is not None else 0.0,
        "location": (
            {"lat": round(lat, 5), "lng": round(lng, 5)}
            if lat is not None and lng is not None
            else None
        ),
    }

    user_text = join_text_blocks(
        [
            "Score this bounty and emit an XpReward JSON object.",
            "Bounty payload:\n```json\n"
            + json.dumps(payload, indent=2, sort_keys=True)
            + "\n```",
            "Reply with JSON only matching the schema in the system prompt.",
        ]
    )

    request = LLMRequest(
        system_prompt=SYSTEM_PROMPT,
        user_text=user_text,
        images=[],
    )

    return await client.call_json(
        request,
        XpReward,
        stub_factory=lambda: _stub_reward(payload),
    )


def _stub_reward(payload: dict) -> XpReward:
    """Deterministic stub used in offline/test mode.

    Mirrors the formula in the prompt so the stub answer stays in the same
    ballpark as a real LLM call.
    """

    description = str(payload.get("description") or "")
    reward_sol = float(payload.get("reward_sol") or 0.0)

    word_count = len(description.split())
    difficulty = max(1, min(10, 3 + word_count // 25))
    importance = max(1, min(10, 4 + (1 if reward_sol >= 0.25 else 0)))

    base = 25 * difficulty + 25 * importance
    bonus = round(reward_sol * 200)
    raw = max(10, min(5000, base + bonus))
    xp_award = int(round(raw / 5) * 5)

    return XpReward(
        xp_award=xp_award,
        difficulty_score=difficulty,
        importance_score=importance,
        reasoning=(
            f"[STUB] difficulty={difficulty} importance={importance} "
            f"sol_bonus={bonus}; deterministic stub used in offline mode."
        ),
    )
