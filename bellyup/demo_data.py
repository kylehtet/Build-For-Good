"""Loads the real datasets into the shapes the front end expects.

This is Oscar's `scripts/build_demo_data.py` turned into a live loader. His
version baked `demo/data.js` at build time; serving it from the API instead
means a restaurant can register during the demo and appear alongside the
pre-existing reports without regenerating a file.

Sources, all real (see dataset/README_DATA_PROVENANCE.md):
  hotspots.csv         382 downtown blocks, need in person-equivalents
  businesses.csv       31 food businesses that could donate
  agencies.csv         5 collection / redistribution agencies
  mobile_pantries.csv  14 distribution sites

The only simulated part is which businesses happen to report surplus tonight
and how much -- voluntary end-of-day reporting is the thing that does not
exist yet, which is the whole point of the platform.
"""

from __future__ import annotations

import csv
import random
import re
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "dataset"

SEED = 20260820
# 24 of the 31 businesses report on the demo evening. Thirteen collectors can
# receive a request (four agencies, four mobile pantries, five drop-off sites),
# so this is what gives each of them a board with something on it rather than
# one or two absorbing everything.
N_REPORTING = 24

# The demo models one fixed evening: Thursday, the 3rd Thursday of the month.
# Pantry availability resolves against this so the demo is deterministic.
DEMO_WEEKDAY, DEMO_ORDINAL = "Thursday", 3
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]

# The clock the board runs on. It MUST agree with DEMO_WEEKDAY/DEMO_ORDINAL
# above: pantry availability is resolved against "the 3rd Thursday", so a
# clock reading Wednesday would have units on site on the wrong night. 18:30
# is the evening these reports come in — kitchens close, surplus is known.
from datetime import datetime as _dt
from datetime import timedelta
DEMO_NOW = _dt(2026, 8, 20, 18, 30)   # Thursday, 3rd Thursday of Aug 2026

# Agencies with no coordinates in the source data, hand-placed to the same
# ~150 m standard the dataset itself uses. A.B. Jones & Co. runs transport
# only, with no fixed site, so it cannot anchor a HQ -> pickup -> drop model.
DEMO_GEOCODES = {
    "Feeding San Diego": (-117.1780, 32.8930),
    "Feeding San Diego (South Bay)": (-117.1040, 32.6996),
    "Catholic Charities Diocese of San Diego": (-117.0995, 32.7846),
}

SHORT_NAMES = {
    "St. Vincent de Paul / Father Joe's Villages (Imperial Ave)": "Father Joe's (Imperial Ave)",
    "St. Vincent De Paul Father Joe's Villages (E Street)": "Father Joe's (E Street)",
    "San Diego Broadway Spanish Seventh Day Adventist": "Broadway Spanish SDA",
    "31st Street Seventh Day Adventist Church": "31st St SDA Church",
}

CONSTANTS = {
    "LBS_PER_MEAL": 1.2,          # Feeding America conversion
    "WAGE_PER_HR": 17.75,         # City of San Diego minimum wage, eff. 2026-01-01
    "COST_PER_MILE": 0.76,        # IRS standard mileage rate, eff. 2026-07-01

    # --- operating cost, broken into its three real parts ---------------
    # The IRS rate above is a BLEND: it already bundles fuel with maintenance,
    # tyres, insurance and depreciation. Adding a separate gas line on top of
    # it would count fuel twice. So it is split instead, and the split is
    # calibrated so a box truck still totals $0.76/mi -- the headline figure
    # stays citable while the breakdown becomes real.
    "FUEL_PRICE_PER_GAL": 4.85,   # California average, regular
    "MPG": {                      # loaded, city driving
        "agency": 10,             #   26 ft box truck
        "pantry": 18,             #   pantry van / mobile unit
        "dropoff": 18,            #   van-equivalent single trip
    },
    "WEAR_PER_MILE": {            # maintenance, tyres, insurance, depreciation
        "agency": 0.275,          #   0.485 fuel + 0.275 wear = 0.76, the IRS rate
        "pantry": 0.22,
        "dropoff": 0.22,
    },
    # --- when a collector can next hand food out ------------------------
    # Pantries carry a real schedule in mobile_pantries.csv. Agencies carry
    # none, so a standard weekday operation is assumed and said so.
    "AGENCY_OPEN": "08:00",
    "AGENCY_CLOSE": "17:00",
    "EVENING_CUTOFF": "21:00",    # when an evening crew stands down
    "HOLD_HANDLING_MIN": 10,      # extra load/unload for storing overnight

    "STAFF_PER_RUN": {            # a 2,000 lb truck run is not a one-person job
        "agency": 2,
        "pantry": 1,
        "dropoff": 1,
    },
    "MEAL_VALUE": 4.25,           # social value per meal served
    "FMV_PER_LB": 1.79,           # fair market value, for the deduction estimate
    "AVG_SPEED_MPH": 18,          # city driving average
    "ROAD_FACTOR": 1.3,           # haversine -> road distance
    "HANDLING_MIN": 25,           # load + unload/serve per run
    "MIN_CANDIDATE_NEED": 1.0,    # blocks below this show on the map, never match
    "ACCESS_BOOST_MAX": 0.5,      # reward boost where weekly food access is poor
    "EMERGING_BOOST": 0.25,       # policy weight: prefer delivering to a block the
                                  # forecast says is growing (spatial.py + trend)
    "COOLING_PENALTY": 0.15,      # and prefer it a little less if it's fading
    "AGENCY_CAPACITY_LBS": 2000,  # box truck
    "PANTRY_CAPACITY_LBS": 150,   # pantry van / mobile unit
    "DEMO_DATE": "2026-08-20",    # the fixed demo evening (a 3rd Thursday)
    "MAX_DROPS_PER_NIGHT": 2,     # serving limit: deliveries per hotspot per night
    "DROPOFF_CREDIT": 0.5,        # value of stocking a pantry vs feeding a block tonight

    # --- added by the merge: the donor now states expiry and a pickup window,
    # so time has to enter the model ---
    "FRESHNESS_FLOOR": 0.35,      # value retained by food that arrives late in life
    "SAFETY_MARGIN_MIN": 30,      # food must land this far before stated expiry
    "MAX_TRANSIT_MIN": {"prepared": 120, "packaged/produce": 480},
}


def available_tonight(day_list: str) -> bool:
    """Does this schedule put staff on site on the demo evening?

    Handles 'Daily', 'Friday', 'Tuesday-Thursday', '1st & 4th Thursday'.
    """
    d = (day_list or "").strip()
    if d.lower() == "daily":
        return True
    if "-" in d:
        a, _, b = (x.strip() for x in d.partition("-"))
        if a in WEEKDAYS and b in WEEKDAYS:
            return WEEKDAYS.index(a) <= WEEKDAYS.index(DEMO_WEEKDAY) <= WEEKDAYS.index(b)
    if DEMO_WEEKDAY not in d:
        return False
    ordinals = [int(n) for n in re.findall(r"(\d)(?:st|nd|rd|th)", d)]
    return DEMO_ORDINAL in ordinals if ordinals else True


def pretty_location(loc: str) -> str:
    """'17TH ST & K ST' -> '17th St & K St', '09TH AV' -> '9th Av'."""
    words = []
    for w in loc.split():
        words.append((w.lstrip("0").lower() or "0") if w[0].isdigit() else w.capitalize())
    return " ".join(words)


def _rows(name: str) -> list[dict]:
    with open(DATA_DIR / name, newline="") as fh:
        return list(csv.DictReader(fh))


# --------------------------------------------------------------------------
# hotspots
# --------------------------------------------------------------------------

def _need_trend_by_block() -> dict[str, float]:
    """OLS slope of weighted need over the last 5 count dates, persons/year.

    Same rule the build spec already documents for need_trend (CLAUDE.md 3.1):
    weighted need per date = individuals + 1.75*tents_structures +
    2.03*vehicles (3.4: never sum the raw components with an already-adjusted
    total), fit over the block's own last 5 observations. Gi* answers "is
    this a real cluster right now" -- this answers "is it growing" -- and the
    two are independent questions. Only Panel261's 261 blocks carry a real
    longitudinal series; a block missing here just gets no trend claim.
    """
    import numpy as np
    from collections import defaultdict

    rows_by_block: dict[str, list[dict]] = defaultdict(list)
    for r in _rows("BlockLevel_Counts_Panel261.csv"):
        rows_by_block[r["block_id"]].append(r)

    out = {}
    for block_id, rows in rows_by_block.items():
        rows = sorted(rows, key=lambda r: r["count_date"])[-5:]
        if len(rows) < 2:
            continue
        t0 = _dt.fromisoformat(rows[0]["count_date"])
        x = np.array([(_dt.fromisoformat(r["count_date"]) - t0).days / 365.25
                      for r in rows])
        y = np.array([float(r["individuals"]) + 1.75 * float(r["tents_structures"])
                      + 2.03 * float(r["vehicles"]) for r in rows])
        slope, _ = np.polyfit(x, y, 1)
        out[block_id] = float(slope)
    return out


def load_hotspots() -> list[dict]:
    all_blocks = []
    for r in _rows("hotspots.csv"):
        all_blocks.append({
            "id": r["block_id"],
            "location": pretty_location(r["location"]),
            "area": r["area"],
            "lon": float(r["lon"]), "lat": float(r["lat"]),
            "need": float(r["need"]),
            "rank": int(r["need_rank"]),
            "priority": r["priority"],
            "persistence": float(r["persistence"]) if r["persistence"] else None,
            "accessDays": float(r["food_access_days_per_week"] or 0),
            "unservedDaily": float(r["unserved_need_daily"] or 0),
        })

    # Gi* (see GI_STAR_SPEC.md) over the FULL grid, not just the blocks that
    # will survive the need>=0.5 display cut below -- a block with zero need
    # is still evidence about its neighbours' significance, and dropping it
    # first would bias every z-score upward.
    import spatial
    gi = spatial.gi_star(all_blocks)
    for h in all_blocks:
        s = gi[h["id"]]
        h["giZ"] = s["z"]
        h["giFlag"] = s["flag"]
        h["giNeighbours"] = s["n_neighbours"]

    # Gi* is deliberately NOT predictive -- it is one snapshot's spatial
    # pattern (GI_STAR_SPEC.md 5: "not fair to say: predicts where need will
    # be"). A real forecast needs a time dimension, which only the trend can
    # give: a block that is BOTH a significant cluster now AND growing is a
    # genuine prediction ("this is where need is headed"); one that is
    # significant but flat or declining is just currently real, not a
    # forecast. The two questions are independent and both real.
    trend_by_block = _need_trend_by_block()
    for h in all_blocks:
        h["giTrend"] = trend_by_block.get(h["id"])

    clusters = [h for h in all_blocks
                if h["giFlag"] in ("hot95", "hot99") and h["giTrend"] is not None]
    if clusters:
        trends = sorted(h["giTrend"] for h in clusters)
        lo = trends[int(0.25 * (len(trends) - 1))]
        hi = trends[int(0.75 * (len(trends) - 1))]
    else:
        lo = hi = 0.0
    for h in all_blocks:
        if h["giFlag"] not in ("hot95", "hot99") or h["giTrend"] is None:
            h["giPredict"] = None            # not a cluster -- nothing to predict
        elif h["giTrend"] > hi:
            h["giPredict"] = "emerging"       # growing fastest quarter of clusters
        elif h["giTrend"] < lo:
            h["giPredict"] = "cooling"        # declining fastest quarter of clusters
        else:
            h["giPredict"] = "established"    # a real cluster, not sharply moving

    # A block's own emerging/cooling read is 5 sparse points; a real
    # neighbourhood-wide trend (area_forecast.py, 108 months of history with
    # seasonality and the fellowship program controlled for) is much sturdier
    # evidence when it exists. Only ever surface it when the area trend
    # clears p < 0.05 -- anything weaker is not shown at all, to keep noise
    # off the map rather than dress up a coin flip as a second opinion.
    import area_forecast
    areas = area_forecast.area_trends(_rows)
    for h in all_blocks:
        h["giAreaSignal"] = None
        if h["giPredict"] not in ("emerging", "cooling"):
            continue
        area = areas.get(h["area"])
        if not area or not area["significant"]:
            continue
        wants = "up" if h["giPredict"] == "emerging" else "down"
        h["giAreaSignal"] = "reinforced" if area["direction"] == wants else "contradicted"
        h["giAreaTrend"] = area["trendPerMonth"]

    out = [h for h in all_blocks if h["need"] >= 0.5]
    out.sort(key=lambda h: -h["need"])
    return out


def forecast_changes(months: float = 6.0) -> list[dict]:
    """Not a second map -- just the blocks where Gi*'s verdict actually
    changes between today and the projection.

    Same statistic as load_hotspots(), run twice: once on today's need, once
    on each block's need projected forward by its own measured trend
    (persons/year, from _need_trend_by_block -- the same one behind
    emerging/cooling). A block whose significance flips either direction is
    returned; one that stays a cluster or stays a non-cluster is not --
    that block's current marker on the map already shows what it is, and
    repeating it here would be the exact clutter the p-value gate elsewhere
    exists to avoid. Two kinds of change, both real:

      "gained"  not a cluster today, predicted to become one -- a genuinely
                new marker, since nothing is shown there right now
      "lost"    a cluster today, predicted to fall out of significance --
                drawn as an overlay ON the existing current marker, not a
                replacement for it, so both states stay visible at once

    A block with no panel coverage is projected flat, so it can only ever
    show up here as unchanged (filtered out) -- unknown trend never
    manufactures a change.
    """
    all_blocks = []
    for r in _rows("hotspots.csv"):
        all_blocks.append({
            "id": r["block_id"],
            "location": pretty_location(r["location"]),
            "area": r["area"],
            "lon": float(r["lon"]), "lat": float(r["lat"]),
            "need": float(r["need"]),
        })

    trend_by_block = _need_trend_by_block()
    for h in all_blocks:
        h["currentNeed"] = h["need"]
        trend = trend_by_block.get(h["id"]) or 0.0
        h["projectedNeed"] = max(0.0, h["need"] + trend * (months / 12.0))

    import spatial
    gi_now = spatial.gi_star([{**h, "need": h["currentNeed"]} for h in all_blocks])
    gi_future = spatial.gi_star([{**h, "need": h["projectedNeed"]} for h in all_blocks])

    out = []
    for h in all_blocks:
        was_sig = gi_now[h["id"]]["flag"] in ("hot95", "hot99")
        future = gi_future[h["id"]]
        will_sig = future["flag"] in ("hot95", "hot99")
        if was_sig == will_sig:
            continue          # no change in verdict -- nothing to overlay
        out.append({
            "id": h["id"], "location": h["location"], "area": h["area"],
            "lat": h["lat"], "lon": h["lon"],
            "currentNeed": round(h["currentNeed"], 2),
            "projectedNeed": round(h["projectedNeed"], 2),
            "giZ": future["z"] if will_sig else gi_now[h["id"]]["z"],
            "change": "gained" if will_sig else "lost",
            "hadTrendData": h["id"] in trend_by_block,
        })
    out.sort(key=lambda h: -h["projectedNeed"])
    return out


# --------------------------------------------------------------------------
# suppliers
# --------------------------------------------------------------------------

def _simulate_report(b: dict, order: int, rng: random.Random,
                     rng_window: random.Random) -> dict:
    """Quantities and items draw from `rng` in exactly the original order.

    The pickup-window jitter uses a SEPARATE stream. Drawing it from the same
    generator would shift every later supplier's quantity, silently changing
    numbers that have already been rehearsed against.
    """
    t = b["facility_type"]
    if t == "grocery":
        lbs = rng.randint(120, 420)
        items = rng.choice([
            "day-old bakery, produce, dairy nearing date",
            "produce trims, deli overstock, packaged goods",
            "bakery, prepared deli trays, bagged produce",
        ])
        hours = 36
    elif t == "hotel":
        rooms = 250
        for tok in b["size_metric"].split():
            if tok.isdigit():
                rooms = int(tok)
                break
        lbs = max(25, int(rooms * rng.uniform(0.10, 0.22)))
        items = rng.choice([
            "banquet buffet trays (hot line, chafing)",
            "conference catering overage, plated entrees",
            "breakfast buffet + event catering leftovers",
        ])
        hours = 4
    elif t == "venue":
        lbs = rng.randint(180, 600)
        items = rng.choice([
            "concession overstock + suite catering",
            "event concessions, boxed meals unclaimed",
        ])
        hours = 6
    else:  # health
        lbs = rng.randint(60, 180)
        items = "cafeteria service line overage, packaged meals"
        hours = 12

    # Reports arrive across the closing evening, spread to fit the window
    # rather than at a fixed gap: at 24 reports a fixed 11-23 min spacing ran
    # the last one past midnight and datetime rejected hour 26.
    #
    # The start matters as much as the spacing. Beginning at 16:00 put the
    # earliest pickup windows (report + ~90 min) shut before the 18:30 demo
    # clock, so the first reports had no viable collector at all. 17:30 keeps
    # every window live on the evening being demonstrated.
    span = 5 * 60 + 30                              # 17:30 to 23:00
    step = span / max(N_REPORTING, 1)
    # The old spacing consumed one rng draw per report. The spread above does
    # not need it, but the draw still has to happen: dropping it shifts the
    # stream and every later quantity with it, which is how Manchester Grand
    # Hyatt moved from 288 lb to 246.
    _stream_keeper = rng.randint(11, 23)
    hh, mm = divmod(int(17 * 60 + 30 + order * step + _stream_keeper % 9), 60)
    reported = f"{hh:02d}:{mm:02d}"
    # Pickup window: from the report time to a couple of hours later, which is
    # how long a kitchen will realistically hold food on a loading dock.
    eh, em = divmod(hh * 60 + mm + rng_window.choice([90, 120, 150]), 60)
    xh, xm = divmod(hh * 60 + mm + hours * 60, 60)
    return {
        "lbs": lbs, "items": items, "time": reported,
        "pickupFrom": reported, "pickupTo": f"{eh % 24:02d}:{em:02d}",
        "expiresAt": f"{xh % 24:02d}:{xm:02d}",
        "expiresInHours": hours,
        "freshness": "fresh",
        # A report is not a request. Surplus sitting on a loading dock is the
        # kitchen's business until it asks someone to come for it.
        "requested": False,
    }


def load_suppliers(hotspots=None) -> list[dict]:
    """Every business, curated and self-registered, with tonight's reports.

    The simulated-report draw runs over the CURATED rows only. Self-registered
    restaurants are appended to businesses.csv, and if they took part in the
    shuffle then signing one up would re-order the draw and silently change
    which fourteen businesses report and how much -- numbers that have already
    been rehearsed against.
    """
    import registry

    rows = registry.businesses()
    curated = [r for r in rows if not registry.is_self_registered(r)]
    mine = [r for r in rows if registry.is_self_registered(r)]

    rng = random.Random(SEED)
    rng_window = random.Random(SEED + 1)
    rng.shuffle(curated)

    out = []
    for i, b in enumerate(curated):
        out.append({
            "id": f"S{i:02d}",
            "name": b["business_name"],
            "type": b["facility_type"],
            "address": b["address"],
            "lon": float(b["lon"]), "lat": float(b["lat"]),
            "surplus": b["surplus_type"],
            "sb1383Tier": b.get("sb1383_tier") or None,
            "registered": False,
            "report": (_simulate_report(b, i, rng, rng_window)
                       if i < N_REPORTING else None),
        })
    out.sort(key=lambda s: (s["report"] is None, s["report"]["time"] if s["report"] else ""))

    own = []
    for n, b in enumerate(mine):
        own.append({
            "id": f"R{100 + n}",
            "name": b["business_name"],
            "type": b["facility_type"] or "restaurant",
            "address": b["address"],
            "lon": float(b["lon"]), "lat": float(b["lat"]),
            "surplus": b["surplus_type"] or "prepared",
            "sb1383Tier": b.get("sb1383_tier") or None,
            "registered": True,
            "report": None,
        })

    # persisted reports override the simulated ones, and are the ONLY source
    # of a report for a self-registered restaurant
    saved = registry.reports()
    for s in own + out:
        if s["name"] in saved:
            rep = saved[s["name"]]
            if rep is None:
                s["report"] = None
                continue
            if rep.get("_surplus_type"):
                s["surplus"] = rep["_surplus_type"]
            s["report"] = {k: v for k, v in rep.items() if not k.startswith("_")}

    gone = registry.opted_out_names()
    return [s for s in own + out if s["name"] not in gone]


# --------------------------------------------------------------------------
# collectors: agencies and mobile pantry units
# --------------------------------------------------------------------------

def load_agencies() -> list[dict]:
    """Agencies from agencies.csv, split by whether they can actually collect.

    `mobile_capable` is load-bearing. An agency with a vehicle can be sent to a
    restaurant and on to a hotspot -- that is what a collector is. An agency
    marked `no` is a fixed site that RECEIVES donations; giving it a box truck
    would invent a fleet it does not have and quietly change every dispatch.

    Both kinds are returned, tagged. Only `mobileCapable` ones become
    collectors; the rest ride along as drop-off points on the map.
    """
    out = []
    for a in _rows("agencies.csv"):
        name = a["agency_name"]
        lon, lat, geocode = a["lon"], a["lat"], a["geocode_method"]
        if not lon and name in DEMO_GEOCODES:
            lon, lat = DEMO_GEOCODES[name]
            geocode = "approximate_manual_demo"
        if not lon:
            continue     # transport-only, no fixed site to route from

        # "unknown" is treated as capable: the five original agencies are the
        # county's distribution networks, and two are only unknown because the
        # roster did not say. A new row must say `no` to be a fixed site.
        mobile = (a.get("mobile_capable") or "unknown").strip().lower() != "no"

        out.append({
            "id": name.split()[0].upper()[:4] + str(len(out)),
            "name": name,
            "program": a["program"],
            "lon": float(lon), "lat": float(lat),
            "acceptsPrepared": a["accepts_prepared"] == "yes",
            "note": a["note"],
            "geocode": geocode,
            "mobileCapable": mobile,
            "agencyType": (a.get("agency_type") or "").strip(),
            "role": (a.get("role") or "").strip(),
            "address": a.get("address", ""),
            "phone": a.get("phone", ""),
        })
    return out


def collecting_agencies(agencies=None) -> list[dict]:
    """Only the agencies that can be dispatched to collect."""
    agencies = load_agencies() if agencies is None else agencies
    return [a for a in agencies if a.get("mobileCapable", True)]


def dropoff_agencies(agencies=None) -> list[dict]:
    """Fixed sites that receive donations but cannot go and get them."""
    agencies = load_agencies() if agencies is None else agencies
    return [a for a in agencies if not a.get("mobileCapable", True)]


def load_pantries() -> list[dict]:
    out = []
    for i, p in enumerate(_rows("mobile_pantries.csv")):
        avail = available_tonight(p["day_list"])
        public = p["downtown_relevant"] == "True"
        out.append({
            "id": f"P{i:02d}",
            "name": SHORT_NAMES.get(p["site_name"], p["site_name"]),
            "operator": p["operator"],
            "lon": float(p["lon"]), "lat": float(p["lat"]),
            "program": p["program"],
            "schedule": p["day_list"] + (f" {p['start_time']}–{p['end_time']}"
                                         if p["end_time"] else ""),
            "daysPerWeek": float(p["days_per_week"]),
            "startTime": p["start_time"], "endTime": p["end_time"],
            "dayList": p["day_list"],
            "acceptsPrepared": "meal" in p["program"].lower(),
            "availableTonight": avail,
            "dispatchable": avail and public,
            "whyNot": (None if avail and public
                       else "serves home-bound individuals only" if not public
                       else f"no unit tonight — runs {p['day_list']}"),
        })
    return out


# --------------------------------------------------------------------------
# history -- the past week's confirmed deliveries
# --------------------------------------------------------------------------

def load_history(suppliers=None, agencies=None, pantries=None,
                 hotspots=None) -> list[dict]:
    """A seeded ledger of the previous seven evenings.

    Drawn from its OWN generator, and only after the caller has built
    everything else, so adding history cannot disturb tonight's simulated
    reports. Gives the ledger view something to sit on: a platform with no
    yesterday looks like a prototype.
    """
    import math

    suppliers = suppliers if suppliers is not None else load_suppliers()
    agencies = agencies if agencies is not None else load_agencies()
    pantries = pantries if pantries is not None else load_pantries()
    hotspots = hotspots if hotspots is not None else load_hotspots()

    C = CONSTANTS
    rng = random.Random(SEED + 7)

    def road_mi(a, b):
        rad = math.pi / 180
        dlat = (b["lat"] - a["lat"]) * rad
        dlon = (b["lon"] - a["lon"]) * rad
        x = (math.sin(dlat / 2) ** 2 + math.cos(a["lat"] * rad)
             * math.cos(b["lat"] * rad) * math.sin(dlon / 2) ** 2)
        return 2 * 3958.76 * math.asin(math.sqrt(x)) * C["ROAD_FACTOR"]

    hist_lbs = {"grocery": (120, 420), "hotel": (30, 160),
                "venue": (180, 600), "health": (60, 180),
                "restaurant": (25, 120)}
    # only agencies that can be dispatched -- a fixed drop-off site never
    # drove anywhere, so it cannot appear in a delivery history either
    collectors = (
        [{**a, "kind": "agency", "cap": C["AGENCY_CAPACITY_LBS"]}
         for a in agencies if a.get("mobileCapable", True)]
        + [{**p, "kind": "pantry", "cap": C["PANTRY_CAPACITY_LBS"]}
           for p in pantries if p["whyNot"] != "serves home-bound individuals only"]
    )
    top_blocks = hotspots[:30]
    demo_date = _dt.fromisoformat(C["DEMO_DATE"]).date()

    # only businesses that were on the platform back then
    pool = [s for s in suppliers if not s.get("registered")]
    if not pool or not collectors or not top_blocks:
        return []

    # A handful of real-looking receipts, not a full week of traffic --
    # BellyUp just launched, so a busy ledger reads as fabricated rather
    # than as evidence the platform works.
    out = []
    n_total = rng.randint(2, 3)
    recent_days = [demo_date - timedelta(days=b) for b in (2, 1)]
    for i in range(n_total):
        day = recent_days[i % len(recent_days)]
        b = rng.choice(pool)
        eligible = [c for c in collectors
                    if b["surplus"] != "prepared" or c["acceptsPrepared"]]
        if not eligible:
            continue
        col = rng.choice(eligible)
        lbs = rng.randint(*hist_lbs.get(b["type"], (60, 200)))
        collected = min(lbs, col["cap"])
        meals = collected / C["LBS_PER_MEAL"]
        h = rng.choice(top_blocks)
        served = min(meals, h["need"])
        boost = 1 + C["ACCESS_BOOST_MAX"] * (7 - min(h["accessDays"], 7)) / 7
        reward = served * C["MEAL_VALUE"] * boost + (meals - served) * C["MEAL_VALUE"] * 0.5
        miles = road_mi(col, b) + road_mi(b, h)
        minutes = miles / C["AVG_SPEED_MPH"] * 60 + C["HANDLING_MIN"]
        # same three-part costing the live engine uses, so a receipt from
        # last Tuesday is comparable with one from tonight
        import dispatch as _d
        cost = _d.run_cost(col["kind"], miles, minutes, C)["total"]
        out.append({
            "receipt": f"BU-{day:%Y%m%d}-{len(out):03d}",
            "date": day.isoformat(),
            "time": f"{rng.randint(17, 20)}:{rng.randint(0, 59):02d}",
            "supplierId": b["id"], "supplier": b["name"],
            "lbs": lbs, "collectedLbs": collected,
            "servedMeals": round(served), "surplusMeals": round(meals - served),
            "collector": col["name"], "kind": col["kind"],
            "hotspotId": h["id"], "hotspot": h["location"],
            "fmv": round(lbs * C["FMV_PER_LB"], 2),
            "net": round(reward - cost, 2),
        })
    return out


# --------------------------------------------------------------------------
# when a collector can next hand food out
# --------------------------------------------------------------------------

_ORDINALS = {"1st": 1, "2nd": 2, "3rd": 3, "4th": 4, "5th": 5}


def _matches_day(d, day_list: str) -> bool:
    """Does this date fall on a schedule like '1st & 4th Thursday'?"""
    txt = (day_list or "").strip()
    if not txt:
        return False
    if txt.lower() == "daily":
        return True
    name = WEEKDAYS[d.weekday()]

    if "-" in txt:                       # 'Tuesday-Thursday'
        a, _, b = (x.strip() for x in txt.partition("-"))
        if a in WEEKDAYS and b in WEEKDAYS:
            return WEEKDAYS.index(a) <= d.weekday() <= WEEKDAYS.index(b)

    if name not in txt:
        return False
    ords = [_ORDINALS[o] for o in _ORDINALS if o in txt]
    if not ords:
        return True                      # every such weekday
    return ((d.day - 1) // 7 + 1) in ords


def next_run_datetime(collector: dict, after):
    """First moment after `after` that this collector can distribute again.

    A pantry runs to its published schedule. An agency has no published hours
    in the roster, so a weekday AGENCY_OPEN-AGENCY_CLOSE operation is assumed
    -- an assumption, and labelled as one wherever it shows.
    """
    C = CONSTANTS
    if collector.get("kind") == "agency" or not collector.get("schedule"):
        oh, om = (int(x) for x in C["AGENCY_OPEN"].split(":"))
        d = after
        for _ in range(14):
            d = d + timedelta(days=1)
            if d.weekday() < 5:
                return d.replace(hour=oh, minute=om, second=0, microsecond=0)
        return None

    day_list = collector.get("dayList") or ""
    start = collector.get("startTime") or "09:00"
    sh, sm = (int(x) for x in start.split(":"))
    d = after
    for _ in range(40):                  # a monthly cadence can be weeks out
        d = d + timedelta(days=1)
        if _matches_day(d.date(), day_list):
            return d.replace(hour=sh, minute=sm, second=0, microsecond=0)
    return None
