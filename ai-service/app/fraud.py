"""Fraud-signal aggregation for cleanup verifications.

Each rule appends a short, machine-readable string to `fraud_flags`. Flags are
kept stable so the backend can render them and we can assert on them in tests.
"""

from __future__ import annotations

from dataclasses import dataclass

from app import vision
from app.config import Settings
from app.geo import trajectory_within_radius_pct
from app.models import VerifyRequest


# Stable flag identifiers (used by backend + tests).
FLAG_NONCE_MISMATCH = "nonce_mismatch"
FLAG_TRAJECTORY_OUTSIDE_RADIUS = "trajectory_outside_radius"
FLAG_NO_GPS_DATA = "no_gps_data"
FLAG_SESSION_TOO_SHORT = "session_too_short"
FLAG_STATIC_FRAME_SUSPECTED = "static_frame_suspected"
FLAG_REPLAY_SUSPECTED = "replay_similarity_suspected"


# Minimum fraction of pings that must be inside the bounty radius.
MIN_TRAJECTORY_INSIDE_RATIO = 0.5


@dataclass
class FraudReport:
    flags: list[str]
    notes: list[str]


async def aggregate_fraud_signals(req: VerifyRequest, settings: Settings) -> FraudReport:
    """Run all fraud checks and return the resulting report."""

    flags: list[str] = []
    notes: list[str] = []

    _check_session_duration(req, settings, flags, notes)
    _check_trajectory(req, settings, flags, notes)
    await _check_nonce(req, flags, notes)
    await _check_static_video(req, flags, notes)
    await _check_replay(req, flags, notes)

    return FraudReport(flags=flags, notes=notes)


def _check_session_duration(
    req: VerifyRequest,
    settings: Settings,
    flags: list[str],
    notes: list[str],
) -> None:
    if req.session_duration_s < settings.min_session_duration_seconds:
        flags.append(FLAG_SESSION_TOO_SHORT)
        notes.append(
            f"session_duration_s={req.session_duration_s} < "
            f"min={settings.min_session_duration_seconds}"
        )


def _check_trajectory(
    req: VerifyRequest,
    settings: Settings,
    flags: list[str],
    notes: list[str],
) -> None:
    if not req.gps_trajectory:
        flags.append(FLAG_NO_GPS_DATA)
        notes.append("gps_trajectory was empty")
        return

    inside_ratio = trajectory_within_radius_pct(
        req.gps_trajectory,
        req.bounty_lat,
        req.bounty_lng,
        settings.bounty_radius_meters,
    )
    if inside_ratio < MIN_TRAJECTORY_INSIDE_RATIO:
        flags.append(FLAG_TRAJECTORY_OUTSIDE_RADIUS)
        notes.append(
            f"only {inside_ratio:.0%} of pings within "
            f"{settings.bounty_radius_meters:.0f}m radius"
        )


async def _check_nonce(req: VerifyRequest, flags: list[str], notes: list[str]) -> None:
    try:
        observed = await vision.extract_nonce_from_video(str(req.submission_video_url))
    except Exception as exc:  # noqa: BLE001 - never fail verification on optional helper
        notes.append(f"nonce extractor errored: {exc}")
        return
    if observed is None:
        return
    if observed.strip() != req.issued_nonce.strip():
        flags.append(FLAG_NONCE_MISMATCH)
        notes.append(f"watermark='{observed}' issued='{req.issued_nonce}'")


async def _check_static_video(
    req: VerifyRequest, flags: list[str], notes: list[str]
) -> None:
    try:
        is_static = await vision.is_static_video(str(req.submission_video_url))
    except Exception as exc:  # noqa: BLE001
        notes.append(f"static-frame check errored: {exc}")
        return
    if is_static:
        flags.append(FLAG_STATIC_FRAME_SUSPECTED)


async def _check_replay(req: VerifyRequest, flags: list[str], notes: list[str]) -> None:
    try:
        replay = await vision.looks_like_replay(
            str(req.reference_video_url), str(req.submission_video_url)
        )
    except Exception as exc:  # noqa: BLE001
        notes.append(f"replay check errored: {exc}")
        return
    if replay:
        flags.append(FLAG_REPLAY_SUSPECTED)
