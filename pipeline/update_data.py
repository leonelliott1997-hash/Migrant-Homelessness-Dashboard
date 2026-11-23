"""
Migrant homelessness data pipeline.

Finds the latest official releases on GOV.UK, downloads anything new, extracts the
figures about people leaving Home Office asylum accommodation, and writes the files
the dashboard reads (docs/data/*.json and *.csv).

Sources (all discovered automatically through the GOV.UK Content API):
  1. MHCLG Statutory homelessness - detailed local authority tables (quarterly)
       Tables A2P / A2R: households owed a prevention / relief duty whose reason for
       loss of last settled home was "Required to leave accommodation provided by
       Home Office as asylum support".
  2. MHCLG Rough Sleeping Data Framework (monthly figures, published quarterly)
       Table 12: people sleeping rough over the month who left asylum support in the
       last 85 days. Table 1: everyone sleeping rough over the month.
  3. Home Office Immigration System Statistics
       Asy_D11: people in receipt of asylum support by local authority (quarterly).
       Asy_D02: initial decisions - grants of protection (UK, quarterly).

Run:  python pipeline/update_data.py            (normal run - only fetches what changed)
      python pipeline/update_data.py --force    (re-parse everything)

Parsed results for every source file are cached in pipeline/cache/ (small JSON
files, committed to the repo) keyed by the file URL. Revised files get a new URL on
GOV.UK, so revisions are picked up automatically.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "pipeline" / "cache"
DOWNLOADS = ROOT / "pipeline" / ".downloads"
OUT = ROOT / "docs" / "data"

GOVUK_CONTENT = "https://www.gov.uk/api/content"
GOVUK_SEARCH = "https://www.gov.uk/api/search.json"
HL_PAGE = "/government/statistical-data-sets/live-tables-on-homelessness"
IMM_PAGE = "/government/statistical-data-sets/immigration-system-statistics-data-tables"

# Earliest quarter of homelessness data to include (H-CLIC quarterly LA tables start
# April-June 2019; before that only financial-year files exist).
HL_START = "2019-Q2"
SUPPORT_START = "2019-Q2"
GRANTS_START = "2019-Q2"

UA = {"User-Agent": "migrant-homelessness-dashboard/1.0 (open data pipeline)"}

MONTHS = {m: i + 1 for i, m in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august",
     "september", "october", "november", "december"])}

ENGLAND = "E92000001"
REST = "REST"  # "Rest of England" (England minus London) aggregate

REGION_NAMES = {
    "E12000001": "North East",
    "E12000002": "North West",
    "E12000003": "Yorkshire and The Humber",
    "E12000004": "East Midlands",
    "E12000005": "West Midlands",
    "E12000006": "East of England",
    "E12000007": "London",
    "E12000008": "South East",
    "E12000009": "South West",
}
REGION_BY_NAME = {v.lower(): k for k, v in REGION_NAMES.items()}
REGION_BY_NAME["yorkshire and the humber"] = "E12000003"
REGION_BY_NAME["east"] = "E12000006"

LA_CODE = re.compile(r"^E0[6-9]\d{6}$")


def log(*a):
    print(*a, flush=True)


# --------------------------------------------------------------------------- utils

def http_get(url: str, **kw) -> requests.Response:
    last = None
    for attempt in range(4):
        try:
            r = requests.get(url, headers=UA, timeout=180, **kw)
            r.raise_for_status()
            return r
        except Exception as e:  # network hiccups on CI are common
            last = e
            time.sleep(3 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {last}")


def content_api(path: str) -> dict:
    return http_get(GOVUK_CONTENT + path).json()


def download(url: str) -> Path:
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    # short names: Windows has a 260-character path limit
    name = hashlib.sha1(url.encode()).hexdigest()[:12] + Path(url).suffix.lower()
    p = DOWNLOADS / name
    if not p.exists():
        log(f"  downloading {url}")
        p.write_bytes(http_get(url).content)
    return p


def to_num(v):
    """Convert a spreadsheet cell to int/float, or None for suppressed/missing."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        if v != v:  # NaN
            return None
        return int(v) if float(v).is_integer() else float(v)
    s = str(v).strip().replace(",", "")
    if s == "":
        return None
    try:
        f = float(s)
        return int(f) if f.is_integer() else f
    except ValueError:
        return None  # [x], [c], [z], .., -, etc.


def marker(v) -> str | None:
    """MHCLG shorthand: [x] = missing data (council did not submit, or data quality
    issues); [c] = suppressed to protect households from being identified.
    Older files use '..' for missing."""
    if v is None:
        return None
    s = str(v).strip().lower()
    if s in {"[x]", "x", ".."}:
        return "x"
    if s in {"[c]", "c"}:
        return "c"
    return None


def period_label(q: str) -> str:
    y, n = q.split("-Q")
    return {"1": "Jan–Mar", "2": "Apr–Jun", "3": "Jul–Sep", "4": "Oct–Dec"}[n] + " " + y


def quarter_range(start: str, end: str) -> list[str]:
    y, q = map(int, start.split("-Q"))
    ey, eq = map(int, end.split("-Q"))
    out = []
    while (y, q) <= (ey, eq):
        out.append(f"{y}-Q{q}")
        q += 1
        if q == 5:
            y, q = y + 1, 1
    return out


def read_sheets(path: Path, wanted) -> dict[str, list[list]]:
    """Return {sheet_name: rows} for sheets whose name passes `wanted(name)`.
    Works for .xlsx and .ods. Rows are lists of raw cell values."""
    suffix = path.suffix.lower()
    out = {}
    if suffix in (".xlsx", ".xlsm"):
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        for ws in wb.worksheets:
            if wanted(ws.title):
                out[ws.title] = [list(r) for r in ws.iter_rows(values_only=True)]
        wb.close()
    elif suffix == ".ods":
        import pandas as pd
        names = list(pd.ExcelFile(path, engine="odf").sheet_names)
        pick = [n for n in names if wanted(n)]
        if pick:
            frames = pd.read_excel(path, sheet_name=pick, header=None, engine="odf", dtype=object)
            for n, df in frames.items():
                out[n] = df.where(df.notna(), None).values.tolist()
    else:
        raise ValueError(f"Unsupported file type: {path}")
    return out


def cache_get(kind: str, url: str):
    p = CACHE / kind / (hashlib.sha1(url.encode()).hexdigest()[:16] + ".json")
    if p.exists():
        return json.loads(p.read_text(encoding="utf-8"))
    return None


def cache_put(kind: str, url: str, data):
    d = CACHE / kind
    d.mkdir(parents=True, exist_ok=True)
    p = d / (hashlib.sha1(url.encode()).hexdigest()[:16] + ".json")
    p.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")


# ----------------------------------------------------- 1. MHCLG statutory homelessness

HL_TITLE = re.compile(
    r"^Detailed local authority level tables:\s*(January|April|July|October)\s+to\s+"
    r"(March|June|September|December)\s+(\d{4})", re.I)


def discover_homelessness() -> tuple[dict, dict]:
    page = content_api(HL_PAGE)
    found: dict[str, dict] = {}
    for a in page["details"].get("attachments", []):
        t = (a.get("title") or "").strip()
        m = HL_TITLE.match(t)
        if not m or "accessible" in t.lower():
            continue
        url = a.get("url") or ""
        if not url.lower().endswith((".ods", ".xlsx")):
            continue
        end_month = MONTHS[m.group(2).lower()]
        q = f"{m.group(3)}-Q{(end_month - 1) // 3 + 1}"
        if q < HL_START:
            continue
        # If several files exist for one quarter, prefer the one marked revised.
        prev = found.get(q)
        if prev is None or ("revised" in t.lower() and "revised" not in prev["title"].lower()):
            found[q] = {"period": q, "title": t, "url": url}
    meta = {"page": "https://www.gov.uk" + HL_PAGE, "page_updated": page.get("public_updated_at")}
    return dict(sorted(found.items())), meta


def _find_col(rows, test, max_rows=15):
    for c in range(max(len(r) for r in rows[:max_rows])):
        for r in rows[:max_rows]:
            if c < len(r) and r[c] is not None and test(str(r[c])):
                return c
    return None


def parse_duty_table(rows) -> dict:
    """Parse an A2P/A2R sheet -> {code: {"name", "ho", "total", "ho_flag"}}"""
    ho_col = _find_col(rows, lambda s: "home office" in s.lower() and "asylum" in s.lower())
    # Header is "Total owed a prevention duty" (older files) or "Owed a prevention duty\n\nTotal" (newer).
    tot_col = _find_col(rows, lambda s: re.match(
        r"^\s*(total owed a|owed a (prevention|relief) duty\s+total|owed a prevention or relief duty\s+total)",
        s, re.I) is not None)
    if ho_col is None or tot_col is None:
        raise ValueError("could not find Home Office / total column")
    out = {}
    for r in rows:
        if not r or len(r) <= ho_col:
            continue
        c0 = str(r[0]).strip() if r[0] is not None else ""
        name = str(r[1]).strip() if len(r) > 1 and r[1] is not None else ""
        if name.lower() == "rest of england":
            code = REST
        elif c0 == ENGLAND or c0 in REGION_NAMES or LA_CODE.match(c0):
            code = c0
        else:
            continue
        if code in out:  # London appears twice (top + regional list)
            continue
        out[code] = {
            "name": name,
            "ho": to_num(r[ho_col]),
            "total": to_num(r[tot_col]),
            "ho_flag": marker(r[ho_col]),
        }
    if ENGLAND not in out:
        raise ValueError("England row not found")
    return out


def load_homelessness(force=False) -> tuple[dict, dict]:
    files, meta = discover_homelessness()
    log(f"Homelessness: {len(files)} quarterly files on GOV.UK ({min(files)} to {max(files)})")
    parsed = {}
    for q, f in files.items():
        hit = None if force else cache_get("homelessness", f["url"])
        if hit is None:
            log(f"  parsing {q}: {f['title']}")
            path = download(f["url"])
            norm = lambda n: n.strip().upper().rstrip("_")
            try:
                sheets = {norm(k): v for k, v in read_sheets(path, lambda n: norm(n) in ("A2", "A2P", "A2R")).items()}
                hit = {"period": q, "url": f["url"], "title": f["title"]}
                if "A2P" in sheets and "A2R" in sheets:
                    hit["prevention"] = parse_duty_table(sheets["A2P"])
                    hit["relief"] = parse_duty_table(sheets["A2R"])
                elif "A2" in sheets:
                    # Before April 2020 prevention and relief were published combined.
                    hit["combined"] = parse_duty_table(sheets["A2"])
                else:
                    raise ValueError(f"no A2/A2P/A2R sheet (found {list(sheets)})")
                cache_put("homelessness", f["url"], hit)
            except Exception as e:
                log(f"  !! could not parse {q}: {e}")
                hit = None
        if hit:
            parsed[q] = hit
    meta["files"] = [{"period": q, "title": f["title"], "url": f["url"]} for q, f in files.items()]
    return parsed, meta


# ------------------------------------------------------ 2. Rough sleeping data framework

RS_TITLE = re.compile(r"rough sleeping data framework", re.I)


def discover_rough_sleeping() -> dict:
    res = http_get(GOVUK_SEARCH, params={
        "q": "rough sleeping data framework", "count": 50,
        "fields": "title,link,public_timestamp", "filter_content_store_document_type": "research"}).json()["results"]
    if not res:  # fallback without document-type filter
        res = http_get(GOVUK_SEARCH, params={
            "q": "rough sleeping data framework", "count": 50,
            "fields": "title,link,public_timestamp"}).json()["results"]
    pubs = [r for r in res if RS_TITLE.search(r["title"]) and "quality" not in r["title"].lower()]
    pubs.sort(key=lambda r: r.get("public_timestamp", ""), reverse=True)
    for pub in pubs:
        d = content_api(pub["link"])
        for a in d["details"].get("attachments", []):
            url = a.get("url") or ""
            if url.lower().endswith((".ods", ".xlsx")) and "data" in (a.get("title") or "").lower():
                return {"title": d["title"], "page": "https://www.gov.uk" + pub["link"], "url": url,
                        "published": pub.get("public_timestamp")}
    raise RuntimeError("No rough sleeping data framework release found")


MONTH_HDR = re.compile(r"^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})$", re.I)


def parse_rs_sheet(rows) -> tuple[list[str], dict]:
    hdr_i = next(i for i, r in enumerate(rows[:20]) if r and str(r[0]).strip().lower() == "local authority code")
    hdr = rows[hdr_i]
    cols = []
    for c, v in enumerate(hdr):
        m = MONTH_HDR.match(str(v).strip()) if v is not None else None
        if m:
            cols.append((c, f"{m.group(2)}-{MONTHS[m.group(1).lower()]:02d}"))
    months = [m for _, m in cols]
    data = {}
    for r in rows[hdr_i + 1:]:
        if not r or len(r) < 4:
            continue
        la, reg, regname = (str(x).strip() if x is not None else "" for x in (r[0], r[2], r[3]))
        if LA_CODE.match(la):
            code = la
        elif regname.lower() == "rest of england":
            code = REST
        elif reg == ENGLAND or reg in REGION_NAMES:
            code = reg
        else:
            continue
        data[code] = {"name": str(r[1]).strip() if LA_CODE.match(la) else regname,
                      "region": reg if LA_CODE.match(la) else None,
                      "v": [to_num(r[c]) if c < len(r) else None for c, _ in cols]}
    return months, data


def load_rough_sleeping(force=False) -> tuple[dict, dict]:
    src = discover_rough_sleeping()
    log(f"Rough sleeping: {src['title']}")
    hit = None if force else cache_get("rough_sleeping", src["url"])
    if hit is None:
        path = download(src["url"])
        sheets = read_sheets(path, lambda n: "asylum" in n.lower() or re.match(r"table_?1_monthly$", n.strip(), re.I) is not None)
        asy = next(v for k, v in sheets.items() if "asylum" in k.lower())
        tot = next(v for k, v in sheets.items() if "asylum" not in k.lower())
        m1, d1 = parse_rs_sheet(asy)
        m2, d2 = parse_rs_sheet(tot)
        # Align the "all rough sleeping" series to the asylum months
        idx = {m: i for i, m in enumerate(m2)}
        for code, rec in d1.items():
            t = d2.get(code, {}).get("v", [])
            rec["t"] = [t[idx[m]] if m in idx and idx[m] < len(t) else None for m in m1]
        hit = {"months": m1, "data": d1, **src}
        cache_put("rough_sleeping", src["url"], hit)
    return hit, src


# ---------------------------------------------------------------- 3. Home Office data

def discover_immigration() -> dict:
    page = content_api(IMM_PAGE)
    out = {"page": "https://www.gov.uk" + IMM_PAGE, "page_updated": page.get("public_updated_at")}
    for a in page["details"].get("attachments", []):
        t = (a.get("title") or "").lower()
        url = a.get("url") or ""
        if not url.lower().endswith((".xlsx", ".ods")):
            continue
        if t.startswith("asylum seekers in receipt of home office support by local authority detailed datasets"):
            out["support"] = {"title": a["title"], "url": url}
        elif t.startswith("asylum claims and initial decisions detailed datasets"):
            out["decisions"] = {"title": a["title"], "url": url}
    for k in ("support", "decisions"):
        if k not in out:
            raise RuntimeError(f"Immigration statistics attachment not found: {k}")
    return out


def date_to_quarter(v) -> str | None:
    if isinstance(v, (dt.date, dt.datetime)):
        d = v
    else:
        s = str(v).strip()
        d = None
        for fmt in ("%d %b %Y", "%d %B %Y", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                d = dt.datetime.strptime(s, fmt)
                break
            except ValueError:
                pass
        if d is None:
            return None
    return f"{d.year}-Q{(d.month - 1) // 3 + 1}"


def _header_index(rows, first):
    return next(i for i, r in enumerate(rows[:10]) if r and r[0] is not None and str(r[0]).strip().lower().startswith(first))


def load_support(src: dict, force=False) -> dict:
    hit = None if force else cache_get("support", src["url"])
    if hit is not None:
        return hit
    log(f"  parsing {src['title']}")
    path = download(src["url"])
    rows = read_sheets(path, lambda n: n.strip().lower().startswith("data_asy_d11"))
    rows = next(iter(rows.values()))
    h = _header_index(rows, "date")
    hdr = [str(x).strip().lower() if x is not None else "" for x in rows[h]]
    ci = {k: next(i for i, x in enumerate(hdr) if x.startswith(k)) for k in
          ("date", "support type", "uk region", "local authority", "lad code", "accommodation type", "people")}
    total = defaultdict(int)
    by_type = defaultdict(lambda: defaultdict(int))
    names, regions = {}, {}
    for r in rows[h + 1:]:
        if not r or r[ci["date"]] is None:
            continue
        code = str(r[ci["lad code"]] or "").strip()
        if not LA_CODE.match(code):
            continue
        q = date_to_quarter(r[ci["date"]])
        n = to_num(r[ci["people"]])
        if q is None or q < SUPPORT_START or n is None:
            continue
        total[(q, code)] += n
        by_type[(q, code)][str(r[ci["accommodation type"]] or "Other").strip()] += n
        names[code] = str(r[ci["local authority"]]).strip()
        reg = REGION_BY_NAME.get(str(r[ci["uk region"]] or "").strip().lower())
        if reg:
            regions[code] = reg
    quarters = sorted({q for q, _ in total})
    latest = quarters[-1]
    hit = {
        "title": src["title"], "url": src["url"], "quarters": quarters,
        "total": {code: [total.get((q, code)) for q in quarters] for code in names},
        "latest_by_type": {code: dict(by_type[(latest, code)]) for code in names if (latest, code) in by_type},
        "names": names, "regions": regions,
    }
    cache_put("support", src["url"], hit)
    return hit


def load_grants(src: dict, force=False) -> dict:
    hit = None if force else cache_get("grants", src["url"])
    if hit is not None:
        return hit
    log(f"  parsing {src['title']}")
    path = download(src["url"])
    rows = read_sheets(path, lambda n: n.strip().lower() == "data_asy_d02")
    rows = next(iter(rows.values()))
    h = _header_index(rows, "year")
    hdr = [str(x).strip().lower() if x is not None else "" for x in rows[h]]
    iq, ig, ia, idec = (hdr.index("quarter"), hdr.index("case outcome group"),
                        hdr.index("applicant type"), hdr.index("decisions"))
    grants = defaultdict(int)
    decisions = defaultdict(int)
    for r in rows[h + 1:]:
        if not r or r[iq] is None or str(r[ia]).strip() != "Main Applicant":
            continue
        m = re.match(r"(\d{4}) Q([1-4])", str(r[iq]))
        if not m:
            continue
        q = f"{m.group(1)}-Q{m.group(2)}"
        if q < GRANTS_START:
            continue
        n = to_num(r[idec]) or 0
        decisions[q] += n
        if str(r[ig]).strip() == "Grant of Protection":
            grants[q] += n
    quarters = sorted(decisions)
    hit = {"title": src["title"], "url": src["url"], "quarters": quarters,
           "grants": [grants.get(q, 0) for q in quarters],
           "decisions": [decisions[q] for q in quarters]}
    cache_put("grants", src["url"], hit)
    return hit


# ------------------------------------------------------------------------ assemble

def build(force=False):
    hl, hl_meta = load_homelessness(force)
    rs, rs_meta = load_rough_sleeping(force)
    imm = discover_immigration()
    log(f"Home Office: {imm['support']['title']}")
    support = load_support(imm["support"], force)
    grants = load_grants(imm["decisions"], force)

    quarters = quarter_range(min(hl), max(hl))
    latest_q = quarters[-1]

    # ---- area register (names from the latest homelessness file; regions from RS/HO)
    areas: dict[str, dict] = {}
    for q in quarters:  # later quarters overwrite names -> latest naming wins
        for table in ("prevention", "relief", "combined"):
            for code, rec in hl.get(q, {}).get(table, {}).items():
                a = areas.setdefault(code, {})
                a["name"] = rec["name"]
    region_of = {}
    region_of.update(support["regions"])
    for code, rec in rs["data"].items():
        if LA_CODE.match(code) and rec.get("region") in REGION_NAMES:
            region_of[code] = rec["region"]
    for code, rec in rs["data"].items():
        areas.setdefault(code, {"name": rec["name"]})
    for code, name in support["names"].items():
        areas.setdefault(code, {"name": name})
    for code, a in areas.items():
        if code == ENGLAND:
            a.update(type="country", name="England")
        elif code == REST:
            a.update(type="aggregate", name="Rest of England")
        elif code in REGION_NAMES:
            a.update(type="region", name=REGION_NAMES[code])
        else:
            a["type"] = "la"
            a["region"] = region_of.get(code)
            if code == "E06000053":  # Isles of Scilly
                a["region"] = a["region"] or "E12000009"
    # LAs present in the current homelessness file = "current" authorities
    current = set(hl[latest_q]["prevention"]) | set(hl[latest_q]["relief"])
    for code, a in areas.items():
        if a["type"] == "la":
            a["current"] = code in current
    missing_region = [c for c, a in areas.items() if a["type"] == "la" and not a.get("region") and a.get("current")]
    if missing_region:
        log(f"  warning: no region for {missing_region}")

    # ---- homelessness series
    def series(table, field):
        out = {}
        for code in areas:
            vals = [hl.get(q, {}).get(table, {}).get(code, {}).get(field) for q in quarters]
            if any(v is not None for v in vals):
                out[code] = vals
        return out

    def flags(table):
        """Per quarter: "x" = missing (not submitted / data quality), "c" = suppressed, 0 = fine."""
        out = {}
        for code in areas:
            f = [hl.get(q, {}).get(table, {}).get(code, {}).get("ho_flag") or 0 for q in quarters]
            if any(f):
                out[code] = f
        return out

    prevention, relief = series("prevention", "ho"), series("relief", "ho")
    prevention_all, relief_all = series("prevention", "total"), series("relief", "total")
    combined, combined_all = series("combined", "ho"), series("combined", "total")

    def total_of(p, r, c):
        out = {}
        for code in set(p) | set(r) | set(c):
            vals = []
            for i in range(len(quarters)):
                pv = p.get(code, [None] * len(quarters))[i]
                rv = r.get(code, [None] * len(quarters))[i]
                cv = c.get(code, [None] * len(quarters))[i]
                vals.append(pv + rv if pv is not None and rv is not None else cv)
            out[code] = vals
        return out

    homelessness = {
        "quarters": quarters,
        # first quarter with separate prevention / relief figures
        "split_from": next(q for q in quarters if "prevention" in hl.get(q, {})),
        "prevention": prevention,
        "relief": relief,
        "total": total_of(prevention, relief, combined),
        "prevention_all": prevention_all,
        "relief_all": relief_all,
        "total_all": total_of(prevention_all, relief_all, combined_all),
        "flags_prevention": flags("prevention"),
        "flags_relief": flags("relief"),
        "flags_combined": flags("combined"),
    }

    # ---- rough sleeping (monthly)
    rough = {"months": rs["months"],
             "asylum": {c: r["v"] for c, r in rs["data"].items()},
             "all": {c: r["t"] for c, r in rs["data"].items()}}

    # ---- asylum support (quarterly, LA) + region / England sums
    sq = support["quarters"]
    sup_total = dict(support["total"])
    agg = defaultdict(lambda: [0] * len(sq))
    for code, vals in support["total"].items():
        reg = areas.get(code, {}).get("region") or support["regions"].get(code)
        for i, v in enumerate(vals):
            if v is None:
                continue
            agg[ENGLAND][i] += v
            if reg:
                agg[reg][i] += v
                if reg != "E12000007":
                    agg[REST][i] += v
    sup_total.update(agg)
    asylum_support = {"quarters": sq, "people": sup_total, "latest_by_type": support["latest_by_type"]}

    grants_out = {"quarters": grants["quarters"], "grants": grants["grants"], "decisions": grants["decisions"]}

    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    meta = {
        "generated": now,
        "latest_quarter": latest_q,
        "latest_quarter_label": period_label(latest_q),
        "sources": {
            "homelessness": {"name": "MHCLG, Statutory homelessness: detailed local authority-level tables",
                             "page": hl_meta["page"], "page_updated": hl_meta["page_updated"],
                             "latest_file": hl_meta["files"][-1]},
            "rough_sleeping": {"name": "MHCLG, Rough Sleeping Data Framework", "title": rs_meta["title"],
                               "page": rs_meta["page"], "url": rs_meta["url"], "published": rs_meta.get("published"),
                               "latest_month": rs["months"][-1]},
            "asylum_support": {"name": "Home Office, Immigration system statistics (Asy_D11)",
                               "title": support["title"], "url": support["url"], "page": imm["page"],
                               "latest_quarter": sq[-1]},
            "grants": {"name": "Home Office, Immigration system statistics (Asy_D02)",
                       "title": grants["title"], "url": grants["url"], "page": imm["page"],
                       "latest_quarter": grants["quarters"][-1]},
        },
    }

    data = {"meta": meta, "areas": areas, "homelessness": homelessness,
            "rough_sleeping": rough, "asylum_support": asylum_support, "grants": grants_out}

    OUT.mkdir(parents=True, exist_ok=True)
    new = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    old_path = OUT / "data.json"
    changed = True
    new_releases = []
    if old_path.exists():
        old = json.loads(old_path.read_text(encoding="utf-8"))
        old_src = old["meta"].get("sources", {})
        checks = [("homelessness", lambda s: s["latest_file"]["title"]),
                  ("rough_sleeping", lambda s: s["title"]),
                  ("asylum_support", lambda s: s["title"]),
                  ("grants", lambda s: s["title"])]
        for key, get in checks:
            try:
                before = get(old_src[key])
            except Exception:
                before = None
            after = get(meta["sources"][key])
            if before != after:
                new_releases.append(f"- {meta['sources'][key]['name']}: {after}")
        old["meta"]["generated"] = now
        changed = json.dumps(old, separators=(",", ":"), ensure_ascii=False) != new
    gh_out = os.environ.get("GITHUB_OUTPUT")
    if gh_out and new_releases:
        with open(gh_out, "a", encoding="utf-8") as f:
            f.write("new_releases<<EOF\n" + "\n".join(new_releases) + "\nEOF\n")
    for line in new_releases:
        log("NEW " + line)
    if changed:
        old_path.write_text(new, encoding="utf-8")
        write_csvs(data)
        log(f"Wrote {old_path} ({len(new)//1024} KB) - latest quarter {latest_q}")
    else:
        log("No changes in the data.")
    return changed


def write_csvs(data):
    areas = data["areas"]
    H = data["homelessness"]

    def area_cols(code):
        a = areas.get(code, {})
        reg = a.get("region")
        return [code, a.get("name"), a.get("type"), REGION_NAMES.get(reg, "") if reg else ""]

    with open(OUT / "homelessness_duties_asylum_support_leavers.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["area_code", "area_name", "area_type", "region", "quarter", "period",
                    "prevention_duties_home_office_leavers", "relief_duties_home_office_leavers",
                    "total_duties_home_office_leavers", "prevention_duties_all_reasons", "relief_duties_all_reasons",
                    "data_note"])
        note = {"x": "missing: not submitted or data quality issues", "c": "suppressed"}
        codes = sorted(H["total"],
                       key=lambda c: ({"country": 0, "aggregate": 1, "region": 2}.get(areas[c]["type"], 3), areas[c]["name"]))
        none = [None] * len(H["quarters"])
        for code in codes:
            for i, q in enumerate(H["quarters"]):
                p = H["prevention"].get(code, none)[i]
                r = H["relief"].get(code, none)[i]
                t = H["total"].get(code, none)[i]
                flag = next((F[code][i] for F in (H["flags_prevention"], H["flags_relief"], H["flags_combined"])
                             if code in F and F[code][i]), None)
                if p is None and r is None and t is None and not flag:
                    continue
                w.writerow(area_cols(code) + [q, period_label(q), p, r, t,
                           H["prevention_all"].get(code, none)[i], H["relief_all"].get(code, none)[i],
                           note.get(flag, "")])

    R = data["rough_sleeping"]
    with open(OUT / "rough_sleeping_asylum_support_leavers.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["area_code", "area_name", "area_type", "region", "month",
                    "people_sleeping_rough_left_asylum_support_last_85_days", "people_sleeping_rough_all"])
        for code, vals in R["asylum"].items():
            for i, m in enumerate(R["months"]):
                w.writerow(area_cols(code) + [m, vals[i], R["all"].get(code, [None] * 999)[i]])

    S = data["asylum_support"]
    with open(OUT / "people_in_asylum_support_by_area.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["area_code", "area_name", "area_type", "region", "quarter_end", "people_in_receipt_of_asylum_support"])
        for code, vals in S["people"].items():
            for i, q in enumerate(S["quarters"]):
                if vals[i] is not None:
                    w.writerow(area_cols(code) + [q, vals[i]])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="re-parse all source files")
    args = ap.parse_args()
    try:
        build(force=args.force)
    except Exception as e:
        log(f"ERROR: {e}")
        raise
