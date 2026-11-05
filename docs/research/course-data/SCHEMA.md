# Course data schema

One JSON file per course, written to `courses/<slug>.json` (this folder). The data feeds a golf simulator (Open-Birdie), so accuracy and provenance matter more than completeness. A field you cannot source is `null`, never a guess.

```json
{
  "course": "Pebble Beach Golf Links",
  "slug": "pebble-beach",
  "osm": "relation/3741806 (optional: the course's OpenStreetMap feature; without it, the nearest courses/featured.json entry's)",
  "location": { "city": "Pebble Beach", "region": "California", "country": "USA", "lat": 36.5683, "lon": -121.9506 },
  "data_as_of": "the scorecard/edition year the yardages come from, e.g. 2025 scorecard",
  "sources": [
    { "id": "S1", "title": "Official scorecard", "url": "https://...", "publisher": "Pebble Beach Company" }
  ],
  "tees": [
    { "name": "Blue", "total_yards": 6828, "par": 72, "rating": 74.9, "slope": 144, "sex": "M", "source": "S1" }
  ],
  "greens": {
    "grass": "Poa annua",
    "typical_stimp": "10-11 daily; 13+ for tournaments",
    "average_size_sqft": 3500,
    "notes": "smallest greens on the PGA Tour",
    "source": "S3"
  },
  "boundaries": {
    "ob_summary": "Where out of bounds exists course-wide (white stakes/walls/fences/roads/property lines).",
    "penalty_area_summary": "Water/cliff/gorse areas marked red or yellow, which are NOT out of bounds.",
    "source": "S4"
  },
  "holes": [
    {
      "number": 7,
      "name": "hole name if it has one, else null",
      "par": 3,
      "handicap": 18,
      "yards": { "Blue": 106, "White": 98 },
      "elevation": {
        "change_ft": -40,
        "direction": "downhill",
        "description": "Tee sits ~40 ft above the green; plays a club shorter.",
        "source": "S2",
        "confidence": "high | medium | low"
      },
      "out_of_bounds": {
        "present": false,
        "sides": [],
        "description": null,
        "source": "S4",
        "confidence": "high | medium | low"
      },
      "penalty_areas": {
        "description": "Pacific Ocean and rocks left and long (red penalty area).",
        "source": "S2"
      },
      "green": {
        "size_sqft": 2000,
        "depth_yards": 22,
        "width_yards": null,
        "slope": "back-to-front, falls toward the ocean",
        "features": "tiny, surrounded by six bunkers",
        "source": "S3",
        "confidence": "high | medium | low"
      },
      "notes": "anything else a simulator should know: dogleg direction, carry distances, wind exposure"
    }
  ],
  "gaps": ["What you looked for and could not find, per field type."]
}
```

## Rules

- **Elevation:** `change_ft` is the green's height relative to the tee (negative = downhill), from a published figure ("drops 50 feet", "100-foot elevation change", topographic surveys, tournament hole guides, course guide books). If sources only say "uphill" or "elevated green" without a number, set `change_ft` to null, fill `direction` and `description`, and mark confidence low. Elevated tees or greens that do not change the overall tee-to-green height can go in `description`.
- **Out of bounds vs penalty areas:** keep them separate. OB = white stakes, walls, fences, roads, property lines (stroke and distance). Penalty areas = water, cliffs, gorse/environmental areas marked red or yellow. Cite local rules or tournament notices when available.
- **Yardages:** use the current official scorecard where possible and name every tee. Record which year/edition. Per-hole yardages for each tee should sum to that tee's published total; if they do not, say so in `gaps`.
- **Green info:** size in square feet, depth in yards, slope/tiers/shape, grass and speed. Tournament guides (PGA Tour, USGA, R&A), course guides and reputable golf publications are good sources.
- **Sources:** every non-null fact must point to a source id. Prefer official course sites, PGA Tour/USGA/R&A material, and established golf publications. Do not use fan wikis as the sole source for numbers when an official one exists.
- Keep descriptions short and in your own words; do not copy long passages.
- Validate the file parses as JSON before finishing.
