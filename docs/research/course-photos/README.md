# Located course photos

Real photos of the seven featured courses, with where each photographer stood and which way they were looking. They are the ground truth for the three-way comparison in the `golf-sim-graphics` skill (section 3): a sim frame from the same spot, the real photo, and a benchmark game frame.

Everything is on Wikimedia Commons under a free licence or in the public domain. **The repo holds links and metadata only.** Open a photo at `https://commons.wikimedia.org/wiki/File:<file>` (spaces become underscores). If you reuse an image anywhere, credit the author and licence given in `photos.json`.

Gathered November 2026.

## What's here

| Path | What it is |
|---|---|
| `photos.json` | 47 photos across the seven courses: Commons file name, author, licence, date, hole, subject, camera position, heading, the capture role and band it matches, and the light. 36 have a camera position and heading. |
| `../../../tools/visual-capture/photo-suite.mjs` | Turns `photos.json` into a visual-capture suite whose free camera stands where each photo was taken. |

| Course | Photos | Placed | Best for |
|---|---|---|---|
| Chambers Bay | 4 | 4 | Elevated overviews and the Puget Sound horizon |
| Old Course, St Andrews | 13 | 13 | The 18th and the town, Swilken Bridge, Road Hole, Hell Bunker |
| Pebble Beach | 7 | 5 | 7th from the tee, 18th from The Lodge, sea fog |
| Bandon Dunes | 7 | 6 | Nos. 4, 16, 17, 18 in low winter sun, dormant fescue |
| TPC Sawgrass | 6 | 3 | The 17th island green at dawn, the 18th |
| Whistling Straits | 4 | 1 | The 11th, lakeside holes |
| Hazeltine National | 6 | 4 | Nos. 10, 15 and 17 in late spring |

## How each position was found

`camera.source` says where a position came from, and `camera.accuracyM` how far off it may be.

- **`photographer`**: the photographer's own location on the Commons page (`{{Location}}`, usually from the camera's GPS or a Flickr geotag). About 30–50 m.
- **`geograph`**: imported from Geograph Britain and Ireland, which records the photographer's grid reference and the direction they faced. 50–100 m, since some grid references are only 100 m squares. The St Andrews photos near the 18th tee sit about 100 m west of where their pictures show they were taken.
- **`derived`**: the photo's title or description names a hole and a viewpoint ("16th at Bandon from the tee", "looking back up the 10th"), and the position was placed on that hole's OpenStreetMap geometry: the start of the hole line for a tee, a point along it for a fairway, 15–40 m short of or beyond the green for green shots. 20–50 m.

`heading.source` works the same way: `photographer` and `geograph` come with the photo, `description` from words like "looking north", `derived` from the hole geometry (the tee toward the green, a fairway point toward the green, behind the green back toward the tee), and `estimated` from what the photo shows. Treat `estimated` headings as rough.

Photos with no `camera` are kept because they are still good look references: aerials (no ground position), shots across water from outside the course, and holes that could not be identified. Their subject says what they show.

Some photos on Commons carry a location that is wrong. The TPC Sawgrass set from 2009 is geotagged to a point in downtown Jacksonville, about 30 km away, and several Pebble Beach photos use the town's centroid. Those locations were ignored.

## Using them in a capture

```bash
node tools/visual-capture/photo-suite.mjs --data-dir data --out /tmp/photo-match.json
npm run visual:capture -- --suite /tmp/photo-match.json --data-dir data
```

The tool finds each course's cache in `<data-dir>/courses` (the `osm-<type>-<id>.json` file, or a legacy cache with the same source or name), projects every placed photo into that cache's local coordinates and writes a free-camera pose 1.7 m above the ground, looking along the photo's heading. Courses without a cache are listed and skipped. Make the suite again after a course is downloaded again, because the poses follow the cache's projection origin.

When comparing:

- The sim's lens is wider than most photos (58° vertical, about 89° horizontal at 16:9; a phone's main camera is about 69° horizontal). Compare the middle of the frame, or crop the capture to the photo's framing.
- Match the light before judging colour. Each photo's `light` says what it was taken in (St Andrews in snow is geometry only; Pebble Beach in sea fog is the haze reference).
- A placed position can be tens of metres off. If the framing is wrong, move the camera in free mode until landmarks line up (a tree, a bunker, the clubhouse) rather than trusting the numbers.
- Courses change. Each photo has a date; the Hazeltine photos (2024) and Chambers Bay (2015, before the greens were re-sodded) show different eras.

## Adding a photo

Add an entry to the course's `photos` list in `photos.json` with a free licence, and give a camera position only when it can be traced to the photographer, Geograph or a named hole and viewpoint. Then run `npm test`: `test/visual-capture-photo-suite.test.mjs` checks ids, licences, roles, bands and that every position is within 300 m of the course.
