"""Address -> coordinates, for the forms.

Census Geocoder first: free, no key, federal, and authoritative for US street
addresses. Nominatim second, because Census only matches addresses it holds in
TIGER and misses things like business names, plazas and some new builds -- two
of the 78 seed addresses failed there. Nominatim will resolve "Nolita Hall, San
Diego" where Census will not.

Results are cached to disk, so a repeated lookup costs nothing and the demo
works offline once warmed.
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import requests

DATA_DIR = Path(__file__).resolve().parent / "data"
CACHE_FILE = DATA_DIR / "geocode_cache.json"

CENSUS = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
NOMINATIM = "https://nominatim.openstreetmap.org/search"

# Nominatim's usage policy requires an identifying UA and at most 1 req/sec.
UA = "BellyUp/1.0 (San Diego food recovery hackathon project)"

# Bias free-text lookups toward San Diego so "500 Main St" lands in the right city
DEFAULT_REGION = "San Diego, CA"
VIEWBOX = (-117.30, 32.60, -116.90, 32.90)  # W, S, E, N

_lock = threading.Lock()
_last_nominatim = [0.0]


def _load() -> dict:
    if CACHE_FILE.exists():
        try:
            return json.loads(CACHE_FILE.read_text())
        except json.JSONDecodeError:
            return {}
    return {}


def _save(cache: dict) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_FILE.write_text(json.dumps(cache, indent=2, sort_keys=True))


def _census(address: str) -> dict | None:
    r = requests.get(CENSUS, params={"address": address,
                                     "benchmark": "Public_AR_Current",
                                     "format": "json"}, timeout=20)
    r.raise_for_status()
    matches = r.json()["result"]["addressMatches"]
    if not matches:
        return None
    c = matches[0]["coordinates"]
    return {"lat": round(c["y"], 6), "lon": round(c["x"], 6),
            "matched": matches[0]["matchedAddress"], "source": "census"}


def _nominatim(address: str) -> dict | None:
    # rate limit: one request per second, per their usage policy
    with _lock:
        wait = 1.05 - (time.time() - _last_nominatim[0])
        if wait > 0:
            time.sleep(wait)
        _last_nominatim[0] = time.time()

    r = requests.get(NOMINATIM, params={
        "q": address, "format": "json", "limit": 1,
        "viewbox": ",".join(str(x) for x in VIEWBOX), "bounded": 0,
    }, headers={"User-Agent": UA}, timeout=20)
    r.raise_for_status()
    hits = r.json()
    if not hits:
        return None
    return {"lat": round(float(hits[0]["lat"]), 6),
            "lon": round(float(hits[0]["lon"]), 6),
            "matched": hits[0].get("display_name", address), "source": "nominatim"}


def suggest(query: str, limit: int = 5) -> list[dict]:
    """Live autocomplete candidates as someone types an address.

    Unlike lookup(), this asks for several matches, not the best one, and is
    never cached -- a partial string changes on every keystroke, so a cache
    keyed on it would only ever grow, never hit. Same rate limit and User-
    Agent as lookup()'s Nominatim call, since it is the same API and the same
    usage policy; the client is expected to debounce keystrokes so this
    still lands well under 1 req/sec in practice.
    """
    query = (query or "").strip()
    if len(query) < 3:
        return []

    with _lock:
        wait = 1.05 - (time.time() - _last_nominatim[0])
        if wait > 0:
            time.sleep(wait)
        _last_nominatim[0] = time.time()

    try:
        r = requests.get(NOMINATIM, params={
            "q": query, "format": "json", "limit": limit * 2,
            "viewbox": ",".join(str(x) for x in VIEWBOX), "bounded": 1,
            "countrycodes": "us",
        }, headers={"User-Agent": UA}, timeout=6)
        r.raise_for_status()
        hits = r.json()
    except Exception:
        return []   # a slow or unavailable provider gives no suggestions, not an error

    seen: set[str] = set()
    out = []
    for h in hits:
        label = _short_label(h.get("display_name", query))
        if label in seen:
            continue  # two Nominatim hits that collapse to the same short label look
        seen.add(label)  # like duplicate rows to whoever's picking from the dropdown
        out.append({"label": label, "lat": round(float(h["lat"]), 6),
                    "lon": round(float(h["lon"]), 6)})
        if len(out) >= limit:
            break
    return out


def _short_label(display_name: str) -> str:
    """Nominatim's display_name is exhaustive -- 'Market Street, East
    Village, Golden Hill, San Diego, San Diego County, California, 92101,
    United States' -- and unreadable as a dropdown row. Keep what it is
    (first segment) plus the actual city, state abbreviation and zip if
    present -- 'Market Street, San Diego, CA 92101', the same shape as the
    form's own placeholder text -- rather than a neighbourhood name that
    means nothing to someone who doesn't already live there."""
    parts = [p.strip() for p in display_name.split(",")]
    zip_code = next((p for p in parts if p.isdigit() and len(p) == 5), None)
    city = "San Diego" if "San Diego" in parts[1:] else (parts[3] if len(parts) > 3 else "")
    head = [parts[0]] + ([city] if city and city != parts[0] else [])
    tail = (["CA"] if "California" in parts else []) + ([zip_code] if zip_code else [])
    return ", ".join(head + tail)


def lookup(address: str, region: str = DEFAULT_REGION) -> dict | None:
    """Resolve an address. Returns {lat, lon, matched, source} or None."""
    address = (address or "").strip()
    if not address:
        return None

    # add the city if the caller did not, so bare street addresses resolve
    query = address
    low = address.lower()
    if "san diego" not in low and " ca" not in low and not any(
            z in low for z in ("9210", "9211", "9212", "9213", "9214")):
        query = f"{address}, {region}"

    cache = _load()
    key = query.lower()
    if key in cache:
        hit = cache[key]
        return dict(hit) if hit else None

    result = None
    for fn in (_census, _nominatim):
        try:
            result = fn(query)
            if result:
                break
        except Exception:
            continue      # a provider being down must not break the form

    cache[key] = result
    _save(cache)
    return dict(result) if result else None
