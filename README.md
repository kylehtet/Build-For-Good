# BellyUp

**Surplus food → the streets that need it. San Diego.**

Food businesses report end-of-day surplus. The platform picks the best
**collector → hotspot** dispatch — an agency box truck or a mobile pantry unit —
by maximising need-weighted meals served net of what the run actually costs to
operate.

```
business reports surplus  ──►  COLLECTOR  ──►  HOTSPOT
   (restaurant, hotel,          (agency truck      (block where unsheltered
    grocery, venue)              or pantry van)     people are counted)
```

Nobody pays to donate. The collector absorbs the cost of the run, so cost
efficiency is optimised on *their* books — and the donor gets a fair-market-value
figure for the deduction.

---

## Run it

```bash
python3 -m venv .venv
./.venv/bin/pip install fastapi uvicorn numpy scipy requests

cd bellyup
../.venv/bin/python -m uvicorn app:app --port 8000
```

Then open **http://localhost:8000** — the dispatch board is the only view;
the earlier three-role `/roles` prototype (`agencies.py`, `collection.py`,
`needs.py` and the rest) has been removed as superseded, along with its
`run_demo.py`/`verify.py` console harnesses.

---

## Three views, one board

A role switcher in the header. What each role may see is enforced on the
server, not just hidden in the UI — a business asking for `/api/board/business`
is never sent a hotspot, and neither is the public view.

The left panel always answers *which one of these am I looking at*; the right
panel is where that role does its work.

**Business** — the left lists tonight's restaurants. Click one and its match
appears **beside it**: which agency is collecting, when, how far, and the
estimated deduction. The map draws that one line, agency to restaurant, and
nothing else. Never a hotspot. A donor offers food; it does not assign anyone's
van.

**Agency** — the left lists the collectors; pick which one you are. Everything
offered to you appears on the right, where you **build a run**: add offers and
the optimal route previews as you go, or take a single job with *Accept just
this*. Adding is free — only accepting books anything.

**Find food** — an address on the left, and the closest open pantry called out
under it. Every option within range is listed on the right, ranked by distance,
and the map draws the way from where you are to the nearest one. Pantry
locations only.

### Combining trips

Pickup order is solved exactly — every permutation, so there is no heuristic to
defend — and constrained by each donor's window: the shortest order is not
automatically a legal one, and a route reaching a loading dock after it closes
is not a route. Feasible orders win outright; among them, the shortest.

Deliveries are then assigned greedily by need-weighted value per mile of
detour, up to what each block can still absorb tonight.

A vehicle is filled smallest-first, so a 150 lb van takes as many donors as it
can rather than being blocked by one pallet it cannot lift; the last one aboard
may be a **partial** take. Anything that will not fit stays on offer and is
named.

Three grocery pickups on one truck: **35.8 mi, $142.07 — against $313.49 run
separately, saving $171.42.**

**Empty miles are reported separately.** That same run is 7.2 mi carrying food
and **28.5 mi empty** to and from a depot 19 km north — 80% deadhead. The plan
says so, and the map draws those legs faint so they cannot be mistaken for the
working route. A depot that far out spends most of its miles empty, and a
closer collector will usually beat it.

### Route lines follow real streets

Every route was a straight line between two points. `bellyup/routing.py`
asks OSRM (`router.project-osrm.org`, free, no key) for the actual driving
path and swaps a route's points in once it answers — the straight line
draws first and stays if OSRM is slow, rate-limited, or unreachable, so a
flaky public demo server never blocks or breaks the map. This is geometry
only: `dispatch.py`'s distance/cost math still uses the haversine ×
`ROAD_FACTOR` estimate it always has, so no dispatch decision depends on a
live network call. **The public OSRM demo is explicitly not rated for
production traffic** (their own usage policy) — a real deployment needs a
self-hosted OSRM instance or a paid routing provider; said here so it is
not discovered in an outage.

## The dispatch board

**Left — tonight's reports.** Twenty-four businesses reporting surplus, each
with pounds, what it is, a pickup window and an expiry. Click one to compute its
dispatch.

**Centre — the map.** 207 hotspot blocks sized by need, suppliers, agency HQs,
fixed drop-off sites and mobile pantry sites. The match animates: it scans candidate blocks, shortlists,
then locks a route.

**Right — the recommendation.** The winning collector → pickup → hotspot triple,
people fed, route miles, net benefit, the reward/cost breakdown, what got ruled
out and why, and the runners-up.

**Confirm to book it.** A dispatch is a recommendation until you confirm it.
Confirming issues a receipt, enters the delivery ledger, and marks the hotspot
served on the map.

**Ledger** (top right). Every confirmed dispatch: tonight's plus the past week.
Delivery log, donor receipts aggregated for tax records, and which hotspots have
been served. "Reset tonight" clears the evening; history stays.

**Dashboard** (top right, `GET /api/board/dashboard`). One aggregate view of
tonight for anyone running the board, not just reading the map: every
report's stage in the reported → requested → accepted → delivered pipeline,
which collectors have a request waiting, and the prediction model's current
read — how many real clusters, the emerging/cooling split, and the fastest
mover in each direction. Computed server-side, once, from the same `board()`
every other route reads, so it can never disagree with what the map shows.

**Light / dark** toggle beside it. The choice persists per browser, and the map
tiles and geometry follow it.

### A report is not a request

Having surplus and asking someone to drive out for it are different facts, and
the board keeps them apart. A restaurant that reports 129 lb has not asked for
anything yet, and until it asks, **no collector sees it** — the agency boards
show requests, never reports. A donor should not discover a van has been
assigned to it.

So each report walks four states, visible on both sides:

```
reported  ──request──▶  requested  ──accept──▶  accepted  ──run──▶  delivered
                            │
                          decline
                            ├─ fallback allowed → open to every other collector
                            └─ fallback refused → declined, off every board
```

**Requests are addressed, not broadcast.** The engine matches one collector and
the request goes to that collector alone. Twenty-four reports fanned out to
everyone would be a noticeboard; each agency instead gets around three offers it
is actually expected to answer. Assignment is least-loaded-first with best net
value as the tie-break, so the spread is even without being uniform — a
prepared-food report only has three collectors that accept prepared food, and
forcing an exact split would send food to whoever was next in line rather than
to whoever should have it.

**What a decline means is the donor's choice**, made with a checkbox when they
request:

| | A decline from the matched collector |
|---|---|
| fallback allowed *(default)* | opens the request to every other collector, minus the decliner. A no from one agency is not a no from the city. |
| fallback refused | ends the request. It leaves every board. |

The second option exists because some kitchens will only hand food to the
partner they have an agreement with, and a platform that quietly shopped their
food around after that partner said no would be overriding them. The collector
is told which kind of no it is giving before it clicks. A donor whose exclusive
request was declined can re-ask openly; nothing is lost.

**A closed pickup window removes the request from the collectors' boards.** A
request nobody took before the dock shut is not actionable, so it stops sitting
there being declined by everyone. The donor still sees it, marked, because it is
their food and reopening the window puts it back.

Requests can be withdrawn until someone accepts. After that the donor's view
says who is coming and offers nothing to click, because the run is no longer
theirs to cancel.

**A pending request is red, everywhere a collector might see it** — a
pulsing dot on its map marker, a badge in the agency picker — because
"someone needs an answer from you" is a different urgency than any other
colour already on the board, and it should not have to be discovered by
opening a run to check. It clears the moment the request is accepted,
declined, or withdrawn.

### Restaurants can register themselves

The **"+ Report surplus · new restaurant"** button takes a name and an address
(geocoded — no coordinates to look up), then tonight's numbers: pounds, food
type, pickup window, expiry, condition.

A registered restaurant is **appended to `dataset/businesses.csv`** and is a
partner from then on. Every business on the board — curated or self-registered —
has an **UPDATE** button, because surplus differs every night and a fixed
quantity per partner would make the feed a fixture rather than a report.
"Nothing to donate tonight" is a real answer and clears the report.

---

## The model

```
net    = reward − cost

reward = meals served × $4.25 × accessBoost × forecastBoost × freshness
       + overflow meals × $4.25 × 0.5
cost   = fuel     miles ÷ mpg × $4.85/gal
       + vehicle  miles × wear/mi
       + crew     (drive + 25 min) × $17.75/hr × crew size
```

**Operating cost has three parts, and they differ by vehicle.** The IRS
mileage rate is a *blend* — it already bundles fuel with maintenance, tyres,
insurance and depreciation — so adding a separate gas line on top would count
fuel twice. It is split instead, calibrated so a box truck still totals the
citable $0.76/mi:

| | mpg | fuel | wear | crew | per mile |
|---|---|---|---|---|---|
| Box truck (2,000 lb) | 10 | $0.485 | $0.275 | 2 | **$0.76** = IRS rate |
| Pantry van (150 lb) | 18 | $0.269 | $0.220 | 1 | $0.49 |

A 2,000 lb truck run is not a one-person job, and it burns nearly twice the
fuel. That is why a van beats it on small loads and loses on bulk: tonight,
nine of the fourteen reports go to vans and the five largest go to trucks.

**`accessBoost`** weights up blocks with poor scheduled food access:
`1 + 0.5 × (7 − access days/week) / 7`. A block already served daily needs the
next van less than one served twice a month.

**`forecastBoost`** is [Getis-Ord Gi\*](GI_STAR_SPEC.md) plus the trend model
actually reaching a dispatch decision — `1.25×` if the hotspot is an
**emerging** cluster (a real cluster today, growing fastest quarter of
clusters), `0.85×` if it is **cooling** (real today, fading), `1.0×`
otherwise (`EMERGING_BOOST`/`COOLING_PENALTY` in `CONSTANTS`). The reasoning:
delivering to a block whose need is measurably growing reaches people who
will still be there tomorrow, not just tonight; a block on its way out is
worth a little less, need-for-need, than one on its way up. This was
originally kept display-only — the paragraph used to say so, in these words
— and was reinstated deliberately, on request, as the one place the
prediction layer is allowed to touch matching. `dispatch.need_boost()` is
the single function both `compute()` and `combine_run()` call, so a combined
run and the single dispatch that fed it can never disagree on a hotspot's
score.

Hotspots are scored over the **full 382-block grid**, before the map's
`need ≥ 0.5` display cut — scoring only the survivors would condition the
statistic on its own outcome and bias every z-score upward. Reference numbers,
computed on `dataset/hotspots.csv`:

```
382 blocks | mean need 2.58 | sd 5.75
161 blocks pass need ≥ 1
 54 significant clusters (z > 1.96)
114 of the 161 are isolated, not clustered

top clusters:            16th St & K St     z=7.58  need  4.5
                          16th St & J St     z=7.27  need 13.3
                          16th St & Imperial z=6.98  need  5.9

high need, not significant: Park Bl & J St  z=1.73  need 23.2
                             03rd Av & A St  z=1.18  need 21.4
```

16th & K St has a fifth of Park Bl & J St's counted need and five times the
significance, because it sits inside a dense band rather than standing alone.

**The neighbour radius is a choice** (250 m — downtown blocks run ~90×60 m, so
this reaches the immediate ring, typically 8–16 blocks), and the honest way to
say so is to show what changes when it moves:

| radius | significant clusters | avg neighbours/block |
|---|---|---|
| 150 m | 32 |  5.2 |
| 250 m | 54 | 13.3 |
| 400 m | 59 | 31.8 |
| 600 m | 81 | 65.0 |

The count keeps climbing at wider radii rather than washing out — a bigger
neighbourhood pulls in more of downtown's genuinely-elevated blocks before it
dilutes any one of them enough to matter. 250 m is used because it matches the
grid's own block scale (§"Two radii" above), not because it gives the most
flattering count.

Gi\* still touches only **preference** (`forecastBoost` above), never
**eligibility** — the candidate filter stays `need ≥ MIN_CANDIDATE_NEED`,
untouched. Park Bl & J St has 23.2 real person-equivalents and is not a
statistical cluster (z = 1.73); refusing to feed 23 counted people because
the block sits alone would be the wrong answer regardless of trend, and
eligibility is where that mistake would show up. A cooling block still gets
served — `0.85×` is a smaller reward, not a rejection.

### Emerging, established, cooling — the one part that IS predictive

Gi\* is a snapshot statistic. It has no time dimension, so no reading of it
answers *where need is headed* — only *is this pattern real right now*
(GI_STAR_SPEC.md §5 says this explicitly: "not fair to say: predicts where
need will be"). Getting an actual forecast out of the data means bringing in
a second, independent signal that Gi\* cannot supply: change over time.

`dataset/BlockLevel_Counts_Panel261.csv` has that — 261 blocks, 12 real count
dates, 2018 to 2025. For each block, `need_trend` is the OLS slope of weighted
need (`individuals + 1.75×tents_structures + 2.03×vehicles`, the same
composite `need` already uses — see "Data rules" above) over its last 5
observations, in persons/year. This is the exact method the build spec
already documents for trend (§3.1); it was reintroduced here for hotspots.csv
after being dropped along with the earlier, now-superseded `/roles` view.

Crossed with Gi\*, every significant cluster gets one of three reads, split at
the top and bottom quartile of trend **among clusters** (not a picked
threshold — whatever the data currently says the fastest-moving quarter is):

| | meaning | today's example |
|---|---|---|
| **emerging** | growing fastest quarter of clusters — becoming a bigger cluster | 15th St & Imperial Av: need 28.4, z=3.8, **+3.1/yr** |
| **established** | a real cluster, not sharply moving either way | most significant clusters |
| **cooling** | declining fastest quarter of clusters — fading from a peak | 17th St & K St: need 74.8 (the single highest-need block downtown), z=5.9, **−34.7/yr** |

That last pair is the actual finding, not a hypothetical: the block with the
**most** counted need downtown is also declining the fastest of any
significant cluster, while a block a third its size is the fastest-growing
cluster in the dataset. Only "emerging" and "cooling" are ever fair to call
predictive — they extrapolate a real, measured trajectory. "Established"
and Gi\* on its own are not; they describe now.

**A second opinion from a real model, not just a 5-point slope.** A block's
own trend is 5 sparse points; `bellyup/area_forecast.py` fits an actual
regression — linear trend + month-of-year seasonal dummies + a control for
a known one-off program effect (`fellowship_month`) — on each neighbourhood's
full monthly history back to 2017 (up to 108 months), by ordinary least
squares. That is enough data to ask for a p-value, and the rule is strict:
**an area's trend is only ever shown when it clears p < 0.05.** Below that,
nothing is shown — not a caveated maybe, nothing, because a block-level
pattern too thin to call is still clutter even with a hedge attached.

Real result: East Village and Gaslamp do **not** clear that bar — despite
containing most of the significant block-level clusters above, including
17th & K St's sharp decline, neither neighbourhood has a statistically real
month-over-month trend once seasonality and the fellowship effect are
controlled for. So a block-level swing there is reported as exactly that: a
block-level pattern, not evidence the whole neighbourhood is moving. City
Center, Columbia, Cortez, Marina and Outside Perimeter *do* clear p < 0.05,
so a handful of emerging/cooling blocks there get one extra line: whether
their own neighbourhood is trending the same way (reinforcing) or the
opposite way (worth a second look before trusting the block's own read).

**`freshness`** decays with the share of the food's life spent by the time it
reaches a person, floored at 0.35. This is why a four-hour hotel tray behaves
differently from bakery goods with two days on them — without hard-coding a
preference for either.

**Hard constraints** reject a pair outright, each with a reason the donor can act
on: `PICKUP_WINDOW_MISSED`, `EXPIRES_BEFORE_SERVED`, `TRANSIT_TOO_LONG`,
`BLOCK_NEED_MET`, `NO_PREPARED_HANDLING`.

**`mobile_capable`** decides who can be dispatched, and it changes the shape of
the match. An agency with a vehicle runs two legs — out to the restaurant, on to
a hotspot. One marked `no` is a fixed site with no vehicle, so it is **one leg**:
the food goes to the site and people come to it. There is no hotspot to serve
and no distribution run to cost.

A drop-off is credited at `DROPOFF_CREDIT` (0.5) — the same rate the model
already gives overflow meals that "ride along to the pantry network", because
that is exactly what it is. Stocking a pantry is worth less than feeding a
counted block tonight, so a drop-off only outranks a routed run when that run
genuinely was not worth making. Tonight, routed wins all 14 reports.

**A run is a round trip.** The crew leaves base, collects, delivers and comes
home, so all three legs are costed. A one-way route is not a run.

**Two ways to deliver, and the clock decides.** If the crew can reach the block
before standing down (`EVENING_CUTOFF`, 21:00), it goes straight out. If not —
a hotel reporting at 22:24 cannot have food carried to a block that night — the
food goes back to the agency and out on its **next scheduled run**, costed for
both trips and with freshness measured at the later handover. Deferring is
therefore more expensive and less fresh, so it is only chosen when going
straight out is impossible.

Pantries carry real schedules (`Daily`, `1st & 4th Thursday`, `Tuesday-Thursday`),
so the next run can be days out. Agencies publish no hours in the roster, so a
weekday 08:00–17:00 operation is assumed and labelled as one.

**If the food will not keep that long, it is refused** with
`EXPIRES_BEFORE_NEXT_RUN` and the donor sees which other collectors could still
take it. Prepared food reported at 22:24 with four hours of life rejects 483
pairs on exactly this and falls to a nearby drop-off instead.

**Every run has to pay for itself**, routed or drop-off. Sorting by net value
descending is not a viability test — without an explicit check the best of a bad
set still wins, and a 2 lb donation gets a *−$4.39* "recommendation". A pair
whose reward does not cover its fuel and staff time is rejected
(`NET_NEGATIVE`, or `DROPOFF_NOT_WORTH_IT` for a site you cannot afford to
reach), and when nothing survives the board says **"Nothing here is worth the
run"** and shows why each option failed. Refusing is the correct answer, not a
failure state.

**Serving limits** come out of the ledger, and they answer two different
questions. A block only holds so many people, so once its need is met further
food there is food left on a pavement. And nobody sends five separate vans to
one corner in an evening, so `MAX_DROPS_PER_NIGHT` caps deliveries per block
regardless of need remaining. A block hitting either limit leaves the candidate
pool and turns green on the map; a partially served one only offers what is
left.

---

## Data

Read from `dataset/`. Sources and provenance in `README_DATA_PROVENANCE.md`;
`COLUMN_PROVENANCE.csv` marks every column EVENT or EXTERNAL.

| File | Rows | What it is |
|---|---|---|
| `hotspots.csv` | 382 | Blocks with need in person-equivalents, from the DSDP count |
| `businesses.csv` | 31 + | Food businesses. **Self-registered restaurants are appended here** |
| `agencies.csv` | 10 | Agencies. `mobile_capable` splits them: 4 collect, 5 receive at a fixed site |
| `mobile_pantries.csv` | 14 | Distribution sites, with schedules |
| `surplus_reports.csv` | — | Tonight's numbers, any supplier. Written by the app |
| `opted_out_businesses.csv` | — | Businesses that left the platform. Written by the app |

Tonight's confirmed deliveries live in memory and clear with "Reset tonight".
The previous week's ledger is generated from a seeded draw so the view has a
yesterday — a platform with no history looks like a prototype.

Plus the raw DSDP event files (`BlockLevel_Counts_Panel261.csv`,
`Downtown_BlockGrid.geojson`, `DowntownCounts_Monthly.csv`, …) that the derived
datasets are built from.

### Where writes go, and why

Self-registered restaurants go into `businesses.csv` itself, using its exact nine
columns, identified by `source_url = "self-registered via BellyUp"`. Everything
else in that file carries a real citation.

Nightly reports live in `surplus_reports.csv` rather than `businesses.csv` —
that table describes *who a business is*, not what it happened to have on one
evening.

Removing a restaurant does one of two things. A self-registered row is deleted
outright. A curated one is recorded as an **opt-out** and filtered at load, so
its externally sourced row is never rewritten — that is also the truer
description: they left the platform, they did not stop existing. The footer
offers an undo.

> ⚠ `build_final_datasets.py` **regenerates** `businesses.csv` from raw sources.
> Re-running it overwrites self-registered restaurants. Their identity fields are
> kept in `surplus_reports.csv` so they can be rebuilt.

---

## Layout

```
bellyup/
  app.py            FastAPI: the dispatch board's routes
  demo_data.py      loads the datasets into the shapes the UI expects
  dispatch.py       the reward−cost engine, freshness, ledger      ← core
  claims.py         request lifecycle: who was asked, who said no
  registry.py       persistence: registrations, reports, opt-outs
  geocode.py        address → coordinates (Census, then Nominatim)
  spatial.py        Getis-Ord Gi* — is a block's need a real cluster
  area_forecast.py  neighbourhood-level trend regression, p-value gated
  static/board/     the dispatch board UI

dataset/            all data, curated + app-written
```

The earlier role-scoped build (`agencies.py`, `collection.py`, `distribution.py`,
`needs.py`, `pipeline.py`, `pantry_finder.py`, `economics.py`, `demand.py`,
`schedule.py`, `rules.py`, `matching.py`, `seed.py`, `run_demo.py`, `verify.py`,
served at `/roles`) has been removed as superseded by the dispatch board above,
which reads the same real `dataset/*.csv` files.

---

## Constants, and where they came from

| Constant | Value | Source |
|---|---|---|
| Meal conversion | 1.2 lb | Feeding America |
| Labour | $17.75/hr | City of San Diego minimum wage, eff. 2026-01-01 |
| Vehicle | $0.76/mi blended | IRS standard mileage rate, eff. 2026-07-01 |
| Fuel | $4.85/gal | California average, regular |
| Meal value | $4.25 | Demo assumption |
| FMV of donated food | $1.79/lb | Demo assumption, for the deduction estimate |

Distances are straight-line × 1.3 at 18 mph — fine for triage, not dispatch.

---

## Known limitations

- **Surplus reports are simulated.** Which businesses report tonight and how much
  is a seeded draw. Voluntary end-of-day reporting is the thing that does not
  exist yet — it is what the platform is for. Everything else is real data.
- The count is a monthly visual street sweep: a known undercount, measuring
  visibility as much as prevalence.
- Two agencies have hand-placed coordinates; A.B. Jones & Co. has no fixed site
  and cannot anchor a cost model, so it is excluded.
- Registrations and reports persist to CSV, not a database. Fine for a demo,
  not concurrent-safe under real load.
- **Gi\* cluster significance is not the same claim as "validated need."** It
  tests spatial pattern on one snapshot, not whether the underlying count is
  accurate, and it does not predict where need will be next. The DSDP panel
  behind it is 12 count dates, so everything downstream inherits that
  thinness. And "unlikely under spatial randomness" is a weaker question than
  "unlikely given how a city actually works" — downtown need is shaped by
  shelters, transit and enforcement, not scattered at random; that is the null
  Gi\* tests against anyway. See [GI_STAR_SPEC.md](GI_STAR_SPEC.md) §5.
- **The emerging/cooling trend is 5 unevenly-spaced points, not a clean
  time series.** Two of the panel's 12 dates sit five weeks apart
  (Jan/Mar 2022) while the rest are roughly a year apart, so an OLS slope
  over the last 5 can be pulled around by whichever count happens to land in
  that gap. It is a real signal, not noise dressed up — but "trend" here
  means "this block's own last five surveys," not a stable multi-year rate.

---

## Also in this repo

`demo/` is the earlier static prototype of the dispatch board — no server, open
`demo/index.html` directly. Its data is generated by
`scripts/build_demo_data.py` from `newdata/`, whose provenance is documented in
`newdata/README_DATA_PROVENANCE.md`. `bellyup/` above supersedes it; the
prototype is kept because it runs with no Python environment at all.

---

## Background

- [Idea doc](https://docs.google.com/document/d/1nCFYEG20TWInWzfGQdEUBfr9bYeSWD21FrcXUpcACO8/edit?usp=sharing)
- [Notes](https://docs.google.com/document/d/1N3y-IhrwdAa8J013vRXJEiilZxjxhp-DVIZHVV5tT_o/edit?usp=sharing)
- [Datasets](https://drive.google.com/drive/folders/1cJ6_sIiJ8FG_IqZ7LN4ET__ZR_N8yWwv)
