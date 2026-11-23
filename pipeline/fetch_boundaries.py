"""
One-off helper: downloads simplified local authority boundaries for England from the
ONS Open Geography Portal and writes docs/data/la_boundaries.geojson for the map.

Only needs re-running if local government boundaries change (e.g. a reorganisation).
Edit SERVICE to point at a newer ONS boundary set when one is needed.

Source: Office for National Statistics licensed under the Open Government Licence v3.0.
Contains OS data © Crown copyright and database right.
"""
import json
from pathlib import Path

import requests

SERVICE = "Local_Authority_Districts_December_2024_Boundaries_UK_BUC"
CODE, NAME = "LAD24CD", "LAD24NM"
URL = f"https://services1.arcgis.com/ESMARspQHYMw9BZ9/arcgis/rest/services/{SERVICE}/FeatureServer/0/query"
OUT = Path(__file__).resolve().parent.parent / "docs" / "data" / "la_boundaries.geojson"


def rnd(coords):
    if isinstance(coords[0], (int, float)):
        return [round(coords[0], 4), round(coords[1], 4)]
    return [rnd(c) for c in coords]


def main():
    feats = []
    offset = 0
    while True:
        r = requests.get(URL, params={
            "where": f"{CODE} LIKE 'E%'", "outFields": f"{CODE},{NAME}", "outSR": 4326,
            "f": "geojson", "resultOffset": offset, "resultRecordCount": 200}, timeout=120)
        r.raise_for_status()
        page = r.json()["features"]
        feats += page
        if len(page) < 200:
            break
        offset += 200
    out = {"type": "FeatureCollection", "features": [
        {"type": "Feature", "properties": {"code": f["properties"][CODE], "name": f["properties"][NAME]},
         "geometry": {"type": f["geometry"]["type"], "coordinates": rnd(f["geometry"]["coordinates"])}}
        for f in feats]}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    print(f"Wrote {len(feats)} boundaries to {OUT} ({OUT.stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
