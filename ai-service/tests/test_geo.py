from app.geo import (
    haversine_meters,
    trajectory_avg_distance_m,
    trajectory_within_radius_pct,
)
from app.models import GpsPing


def test_haversine_zero_distance():
    assert haversine_meters(34.0, -118.0, 34.0, -118.0) == 0.0


def test_haversine_small_distance_under_75m():
    d = haversine_meters(34.0, -118.0, 34.0001, -118.0001)
    assert 10 < d < 75


def test_trajectory_within_radius_all_inside():
    pings = [
        GpsPing(lat=34.0, lng=-118.0, accuracy=5.0, timestamp=1.0),
        GpsPing(lat=34.0001, lng=-118.0, accuracy=5.0, timestamp=2.0),
    ]
    assert trajectory_within_radius_pct(pings, 34.0, -118.0, 75.0) == 1.0


def test_trajectory_within_radius_some_outside():
    pings = [
        GpsPing(lat=34.0, lng=-118.0, accuracy=5.0, timestamp=1.0),
        GpsPing(lat=35.0, lng=-119.0, accuracy=5.0, timestamp=2.0),
    ]
    pct = trajectory_within_radius_pct(pings, 34.0, -118.0, 75.0)
    assert 0.0 < pct < 1.0


def test_trajectory_within_radius_empty_returns_zero():
    assert trajectory_within_radius_pct([], 34.0, -118.0, 75.0) == 0.0


def test_trajectory_avg_distance_empty_returns_zero():
    assert trajectory_avg_distance_m([], 34.0, -118.0) == 0.0
