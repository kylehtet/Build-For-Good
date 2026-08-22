"""Real street geometry for route lines, via OSRM's public routing API.

Every route on this board was previously drawn as a straight line between
two points (haversine x ROAD_FACTOR for the DISTANCE estimate, a literal
straight segment for the DRAWING). The distance estimate stays exactly as
it was -- dispatch.py's cost/reward math is untouched, so nothing about who
gets matched to what changes. This module only asks "what does the actual
street path between these points look like", for drawing.

OSRM's public demo server (router.project-osrm.org) is free and needs no
API key, which is why it is used here -- but it is explicitly NOT rated for
production traffic (OSRM's own usage policy). That is fine for a demo and
would not be fine for a deployed service: a real deployment needs a
self-hosted OSRM instance or a paid routing provider. Said here once,
plainly, rather than left for someone to discover in an outage.

Every call degrades to a straight line on any failure -- timeout, rate
limit, no network -- so a slow or unavailable routing server never breaks
the board. `None` is never returned; a straight two-point line always is,
at minimum.
"""

from __future__ import annotations

import time

_OSRM_BASE = "https://router.project-osrm.org/route/v1/driving/"
_TIMEOUT_S = 3.0
_CACHE_TTL_S = 3600  # street geometry does not change mid-demo

_cache: dict[tuple, tuple[float, list[list[float]]]] = {}


def _straight_line(points: list[tuple[float, float]]) -> list[list[float]]:
    """[(lat, lon), ...] -> the same points, unchanged. The honest fallback:
    no invented geometry, just what was already being drawn before this
    module existed."""
    return [[lat, lon] for lat, lon in points]


def route_geometry(points: list[tuple[float, float]]) -> dict:
    """points: [(lat, lon), ...], at least 2, in visit order.

    Returns {"coords": [[lat, lon], ...], "distanceMi": float | None,
    "source": "osrm" | "straight"}. distanceMi is None when falling back --
    callers already have their own road-factor estimate and should keep
    using it; this is geometry only, not a second distance model.
    """
    if len(points) < 2:
        return {"coords": _straight_line(points), "distanceMi": None, "source": "straight"}

    key = tuple(round(c, 5) for p in points for c in p)
    cached = _cache.get(key)
    if cached and time.time() - cached[0] < _CACHE_TTL_S:
        return cached[1]

    fallback = {"coords": _straight_line(points), "distanceMi": None, "source": "straight"}
    try:
        import requests
        coord_str = ";".join(f"{lon:.6f},{lat:.6f}" for lat, lon in points)
        r = requests.get(
            f"{_OSRM_BASE}{coord_str}",
            params={"overview": "full", "geometries": "geojson"},
            timeout=_TIMEOUT_S,
        )
        r.raise_for_status()
        data = r.json()
        if data.get("code") != "Ok" or not data.get("routes"):
            _cache[key] = (time.time(), fallback)
            return fallback
        route = data["routes"][0]
        # GeoJSON is [lon, lat]; every consumer here works in [lat, lon].
        coords = [[lat, lon] for lon, lat in route["geometry"]["coordinates"]]
        result = {
            "coords": coords,
            "distanceMi": round(route["distance"] / 1609.34, 2),
            "source": "osrm",
        }
        _cache[key] = (time.time(), result)
        return result
    except Exception:
        _cache[key] = (time.time(), fallback)
        return fallback
