"""Restaurants and their nightly reports, persisted to disk.

Self-registered restaurants are appended to `dataset/businesses.csv` itself,
alongside the 31 curated ones, using exactly that file's nine columns. They are
identifiable by `source_url` -- everything else carries a real citation, these
carry SELF_SOURCE.

Two sidecar files hold what businesses.csv has no column for:

  surplus_reports.csv       tonight's numbers, for ANY supplier. Surplus is a
                            daily thing and does not belong in a table about
                            who a business is.
  opted_out_businesses.csv  curated businesses that left the platform. Their
                            row is externally sourced, so it is filtered at
                            load rather than deleted.

⚠ `build_final_datasets.py` REGENERATES businesses.csv from raw sources. If it
is re-run, self-registered restaurants are overwritten. They are recoverable
from surplus_reports.csv, which keeps a copy of the identity fields.
"""

from __future__ import annotations

import csv
import json
import threading
from datetime import datetime
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "dataset"
BUSINESSES = DATA_DIR / "businesses.csv"
REPORTS = DATA_DIR / "surplus_reports.csv"
OPTOUTS = DATA_DIR / "opted_out_businesses.csv"
SEQ_FILE = Path(__file__).resolve().parent / "data" / "id_seq.json"

# the nine columns of businesses.csv, in order -- do not add to these
BUSINESS_COLUMNS = ["business_name", "facility_type", "address", "lon", "lat",
                    "sb1383_tier", "size_metric", "source_url", "surplus_type"]

REPORT_COLUMNS = ["business_name", "supplier_id", "lbs", "items", "time",
                  "pickup_from", "pickup_to", "expires_at", "freshness",
                  "surplus_type", "has_surplus", "updated_at",
                  # identity kept so a self-registered restaurant can be
                  # rebuilt if businesses.csv is ever regenerated
                  "address", "lon", "lat", "facility_type", "self_registered"]

OPTOUT_COLUMNS = ["business_name", "supplier_id", "opted_out_at"]

SELF_SOURCE = "self-registered via BellyUp"

_lock = threading.Lock()


def _read(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with open(path, newline="") as fh:
        return [r for r in csv.DictReader(fh) if any(v for v in r.values())]


def _write(path: Path, rows: list[dict], columns: list[str]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with open(path, "w", newline="") as fh:
        # csv defaults to \r\n, which would flip every line ending in
        # businesses.csv and make a one-row append look like a whole-file
        # rewrite in git.
        w = csv.DictWriter(fh, fieldnames=columns, lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: r.get(k, "") for k in columns})


# --------------------------------------------------------------------------
# businesses.csv
# --------------------------------------------------------------------------

def businesses() -> list[dict]:
    """Every business row, curated and self-registered alike."""
    with _lock:
        return _read(BUSINESSES)


def is_self_registered(row: dict) -> bool:
    return (row.get("source_url") or "").strip() == SELF_SOURCE


def add_business(supplier: dict) -> None:
    """Append a self-registered restaurant to businesses.csv."""
    row = {
        "business_name": supplier["name"],
        "facility_type": supplier.get("type", "restaurant"),
        "address": supplier.get("address", ""),
        "lon": supplier["lon"], "lat": supplier["lat"],
        "sb1383_tier": supplier.get("sb1383Tier") or "",
        "size_metric": "self-reported",
        "source_url": SELF_SOURCE,
        "surplus_type": supplier.get("surplus", "prepared"),
    }
    with _lock:
        rows = [r for r in _read(BUSINESSES)
                if r.get("business_name") != supplier["name"]]
        rows.append(row)
        _write(BUSINESSES, rows, BUSINESS_COLUMNS)


def remove_business(name: str) -> bool:
    """Delete a self-registered row. Curated rows are never rewritten."""
    with _lock:
        rows = _read(BUSINESSES)
        kept = [r for r in rows
                if not (r.get("business_name") == name and is_self_registered(r))]
        if len(kept) == len(rows):
            return False
        _write(BUSINESSES, kept, BUSINESS_COLUMNS)
        return True


def self_registered_names() -> set[str]:
    with _lock:
        return {r["business_name"] for r in _read(BUSINESSES) if is_self_registered(r)}


def count() -> int:
    return len(self_registered_names())


# --------------------------------------------------------------------------
# surplus_reports.csv -- tonight's numbers, for any supplier
# --------------------------------------------------------------------------

def reports() -> dict[str, dict]:
    """business_name -> report dict (or None where they reported nothing)."""
    out: dict[str, dict] = {}
    with _lock:
        for r in _read(REPORTS):
            if (r.get("has_surplus") or "").lower() in ("false", "0", "no"):
                out[r["business_name"]] = None
                continue
            if not r.get("lbs"):
                continue
            out[r["business_name"]] = {
                "lbs": float(r["lbs"]),
                "items": r.get("items") or "surplus reported by the kitchen",
                "time": r.get("time") or r.get("pickup_from") or "18:30",
                "pickupFrom": r.get("pickup_from") or None,
                "pickupTo": r.get("pickup_to") or None,
                "expiresAt": r.get("expires_at") or None,
                "freshness": r.get("freshness") or "fresh",
                "updated": True,
                "_surplus_type": r.get("surplus_type") or "",
            }
    return out


def save_report(supplier: dict, has_surplus: bool = True) -> None:
    rep = supplier.get("report") or {}
    row = {
        "business_name": supplier["name"],
        "supplier_id": supplier.get("id", ""),
        "lbs": rep.get("lbs", "") if has_surplus else "",
        "items": rep.get("items", "") if has_surplus else "",
        "time": rep.get("time", "") if has_surplus else "",
        "pickup_from": (rep.get("pickupFrom") or "") if has_surplus else "",
        "pickup_to": (rep.get("pickupTo") or "") if has_surplus else "",
        "expires_at": (rep.get("expiresAt") or "") if has_surplus else "",
        "freshness": rep.get("freshness", "") if has_surplus else "",
        "surplus_type": supplier.get("surplus", ""),
        "has_surplus": str(bool(has_surplus)),
        "updated_at": datetime.now().isoformat(timespec="seconds"),
        "address": supplier.get("address", ""),
        "lon": supplier.get("lon", ""), "lat": supplier.get("lat", ""),
        "facility_type": supplier.get("type", ""),
        "self_registered": str(bool(supplier.get("registered"))),
    }
    with _lock:
        rows = [r for r in _read(REPORTS) if r.get("business_name") != supplier["name"]]
        rows.append(row)
        _write(REPORTS, rows, REPORT_COLUMNS)


def drop_report(name: str) -> None:
    with _lock:
        rows = [r for r in _read(REPORTS) if r.get("business_name") != name]
        _write(REPORTS, rows, REPORT_COLUMNS)


# --------------------------------------------------------------------------
# opt-outs -- curated businesses that left
# --------------------------------------------------------------------------

def opted_out_names() -> set[str]:
    with _lock:
        return {r["business_name"] for r in _read(OPTOUTS)}


def opt_out(name: str, supplier_id: str = "") -> None:
    with _lock:
        rows = _read(OPTOUTS)
        if any(r["business_name"] == name for r in rows):
            return
        rows.append({"business_name": name, "supplier_id": supplier_id,
                     "opted_out_at": datetime.now().isoformat(timespec="seconds")})
        _write(OPTOUTS, rows, OPTOUT_COLUMNS)


def restore(name: str | None = None) -> int:
    with _lock:
        rows = _read(OPTOUTS)
        kept = [] if name is None else [r for r in rows if r["business_name"] != name]
        _write(OPTOUTS, kept, OPTOUT_COLUMNS)
        return len(rows) - len(kept)


def optout_count() -> int:
    with _lock:
        return len(_read(OPTOUTS))


def next_id() -> str:
    """Allocate a new, PERMANENT self-registered supplier id.

    Used to be `R100 + count of self-registered rows` -- fine until a
    restaurant is deleted. Deleting one shrinks that count, so the very
    next registration is handed the id of whoever was just removed --
    including that id's ledger history. A confirmed delivery, an accepted
    claim, a pending request are all keyed by id, not name, so the new
    restaurant inherited a stranger's "delivered" status the instant it
    registered. This is why: a restaurant reports, gets matched, and the
    business panel shows it as already delivered before anyone touched it.

    Backed by a counter file instead, so an id is never handed out twice
    regardless of what gets deleted in between. demo_data.load_suppliers
    reads the same id back by name (registry.supplier_ids()) rather than
    recomputing a row position, so the two still never disagree on what a
    self-registered restaurant is called -- they just agree on a stored
    fact now instead of a shared formula.
    """
    with _lock:
        try:
            seq = json.loads(SEQ_FILE.read_text())["next"]
        except (FileNotFoundError, json.JSONDecodeError, KeyError):
            # first run on this checkout: pick up where the old row-count
            # scheme would have, so it doesn't collide with rows already here
            seq = 100 + sum(1 for r in _read(BUSINESSES) if is_self_registered(r))
        SEQ_FILE.parent.mkdir(parents=True, exist_ok=True)
        SEQ_FILE.write_text(json.dumps({"next": seq + 1}))
        return f"R{seq}"


def supplier_ids() -> dict[str, str]:
    """business_name -> its permanent supplier id, from surplus_reports.csv.

    Saved once, at registration (register_supplier always calls
    save_report right after next_id()), and read back here instead of
    recomputed -- see next_id()'s docstring for why recomputing it broke.
    """
    with _lock:
        return {r["business_name"]: r["supplier_id"]
                for r in _read(REPORTS) if r.get("supplier_id")}
