"""Geospatial helpers for trajectory analysis."""

from __future__ import annotations

import math
from collections.abc import Sequence

from app.models import GpsPing

EARTH_RADIUS_METERS = 6_371_000.0


def haversine_meters(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance between two coordinates in meters."""

    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lng2 - lng1)

    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return EARTH_RADIUS_METERS * c


def trajectory_within_radius_pct(
    trajectory: Sequence[GpsPing],
    bounty_lat: float,
    bounty_lng: float,
    radius_meters: float,
) -> float:
    """Fraction of pings within `radius_meters` of the bounty pin (0.0 if empty)."""

    if not trajectory:
        return 0.0
    inside = sum(
        1
        for p in trajectory
        if haversine_meters(p.lat, p.lng, bounty_lat, bounty_lng) <= radius_meters
    )
    return inside / len(trajectory)


def trajectory_avg_distance_m(
    trajectory: Sequence[GpsPing],
    bounty_lat: float,
    bounty_lng: float,
) -> float:
    """Average distance from each ping to the bounty pin (0.0 if empty)."""

    if not trajectory:
        return 0.0
    total = sum(
        haversine_meters(p.lat, p.lng, bounty_lat, bounty_lng) for p in trajectory
    )
    return total / len(trajectory)
