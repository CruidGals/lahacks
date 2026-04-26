"""Static JSON fixtures used by the pipeline tests + CLI driver."""

from __future__ import annotations

import json
from pathlib import Path

FIXTURES_DIR = Path(__file__).resolve().parent

DINO_REFERENCE_PATH = FIXTURES_DIR / "dino_reference_sample.json"
DINO_SUBMISSION_PATH = FIXTURES_DIR / "dino_submission_sample.json"
DINO_CLEAN_SUBMISSION_PATH = FIXTURES_DIR / "dino_clean_submission_sample.json"


def load_dino_reference() -> dict:
    return json.loads(DINO_REFERENCE_PATH.read_text(encoding="utf-8"))


def load_dino_submission() -> dict:
    return json.loads(DINO_SUBMISSION_PATH.read_text(encoding="utf-8"))


def load_dino_clean_submission() -> dict:
    return json.loads(DINO_CLEAN_SUBMISSION_PATH.read_text(encoding="utf-8"))
