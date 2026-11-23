"""
Decides whether today's scheduled run should fetch new data.

The workflow wakes briefly each weekday morning and runs this script, which takes a few
seconds and downloads nothing. The full update (pipeline/update_data.py) only runs when:

  1. GOV.UK's release calendar has a confirmed release of one of our sources dated
     today or yesterday (yesterday in case files reach the page late), or
  2. one of the source pages on GOV.UK was updated in the last 2 days. This catches
     the Rough Sleeping Data Framework, which is management information and is not
     pre-announced, and any unscheduled corrections, or
  3. it is Monday: a weekly sweep for corrections and anything that slipped, or
  4. someone started the run by hand (FORCE_RUN=1).

If GOV.UK cannot be reached, it runs anyway: a run with nothing new is harmless.

It also writes docs/data/releases.json (upcoming release dates) for the dashboard.

Usage:  python pipeline/release_check.py [--date YYYY-MM-DD]   (--date for testing)
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
from pathlib import Path
from zoneinfo import ZoneInfo

import requests

UK = ZoneInfo("Europe/London")
SEARCH = "https://www.gov.uk/api/search.json"
CONTENT = "https://www.gov.uk/api/content"
OUT = Path(__file__).resolve().parent.parent / "docs" / "data" / "releases.json"
UA = {"User-Agent": "migrant-homelessness-dashboard/1.0 (release calendar check)"}

# Release calendar series we care about: (organisation slug, title pattern, label)
SERIES = [
    ("ministry-of-housing-communities-local-government", r"^statutory homelessness in england",
     "MHCLG statutory homelessness"),
    ("ministry-of-housing-communities-local-government", r"rough sleeping data framework",
     "MHCLG rough sleeping data framework"),
    ("home-office", r"^immigration system statistics", "Home Office immigration statistics"),
]
# Source pages whose "last updated" date we watch
PAGES = [
    ("/government/statistical-data-sets/live-tables-on-homelessness", "MHCLG live tables on homelessness"),
    ("/government/statistical-data-sets/immigration-system-statistics-data-tables", "Home Office immigration data tables"),
]


def get(url, **params):
    r = requests.get(url, params=params, headers=UA, timeout=60)
    r.raise_for_status()
    return r.json()


def uk_date(ts: str) -> dt.date:
    return dt.datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone(UK).date()


def announcements() -> list[dict]:
    out = []
    for org in {s[0] for s in SERIES}:
        res = get(SEARCH, filter_format="statistics_announcement", filter_organisations=org, count=200,
                  order="-release_timestamp", fields="title,release_timestamp,statistics_announcement_state,link")
        for x in res["results"]:
            for s_org, pattern, label in SERIES:
                if s_org == org and re.search(pattern, x["title"], re.I) and x.get("release_timestamp"):
                    out.append({"series": label, "title": x["title"], "state": x.get("statistics_announcement_state"),
                                "release": x["release_timestamp"], "date": uk_date(x["release_timestamp"]).isoformat(),
                                "url": "https://www.gov.uk" + x["link"]})
    return out


def recent_page_updates() -> list[tuple[str, dt.date]]:
    out = []
    for path, label in PAGES:
        d = get(CONTENT + path)
        if d.get("public_updated_at"):
            out.append((label, uk_date(d["public_updated_at"])))
    rs = get(SEARCH, q="rough sleeping data framework", count=20, fields="title,public_timestamp")["results"]
    rs = [x for x in rs if re.search(r"rough sleeping data framework", x["title"], re.I) and x.get("public_timestamp")]
    if rs:
        latest = max(rs, key=lambda x: x["public_timestamp"])
        out.append((f"Rough sleeping data framework ({latest['title']})", uk_date(latest["public_timestamp"])))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", help="pretend today is this date (YYYY-MM-DD), for testing")
    args = ap.parse_args()
    today = dt.date.fromisoformat(args.date) if args.date else dt.datetime.now(UK).date()
    window = {today, today - dt.timedelta(days=1)}
    if today.weekday() == 0:  # Monday: also cover releases on Friday
        window |= {today - dt.timedelta(days=d) for d in (2, 3)}

    reasons = []
    if os.environ.get("FORCE_RUN") == "1":
        reasons.append("run started by hand")
    if today.weekday() == 0:
        reasons.append("weekly sweep (Monday)")

    upcoming = []
    try:
        anns = announcements()
        for a in anns:
            d = dt.date.fromisoformat(a["date"])
            if a["state"] == "confirmed" and d in window:
                reasons.append(f"release day: {a['title']} ({a['date']})")
            if d >= today and a["state"] != "cancelled":
                upcoming.append(a)
        for label, d in recent_page_updates():
            if (today - d).days in (0, 1, 2):
                reasons.append(f"{label} updated {d.isoformat()}")
    except Exception as e:  # fail open
        reasons.append(f"could not read GOV.UK calendar ({e}); running to be safe")

    upcoming.sort(key=lambda a: a["release"])
    OUT.parent.mkdir(parents=True, exist_ok=True)
    # Provisional dates are often month-only: GOV.UK stores them as 23:59:59 on the last day.
    for a in upcoming:
        a["month_only"] = a["state"] == "provisional" and "23:59:59" in a["release"]
    payload = {"upcoming": [{k: a[k] for k in ("series", "title", "state", "date", "month_only", "url")} for a in upcoming[:8]]}
    new = json.dumps(payload, indent=1, ensure_ascii=False)
    if not OUT.exists() or OUT.read_text(encoding="utf-8") != new:
        OUT.write_text(new, encoding="utf-8")

    run = bool(reasons)
    print(f"Today (UK): {today.isoformat()}")
    print("Upcoming releases:")
    for a in upcoming[:8]:
        print(f"  {a['date']}  {a['state']:<11} {a['title']}")
    print(("RUN full update: " + "; ".join(reasons)) if run else "No release today: skipping the full update.")

    gh = os.environ.get("GITHUB_OUTPUT")
    if gh:
        with open(gh, "a", encoding="utf-8") as f:
            f.write(f"run={'true' if run else 'false'}\n")
            f.write(f"reason={'; '.join(reasons) or 'no release today'}\n")


if __name__ == "__main__":
    main()
