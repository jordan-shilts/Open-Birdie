# Course layout and graphics data in Supabase: plan

Status: proposal only. No course data has moved; each phase waits for a yes.
The `open-birdie` Supabase project (Coattails org, us-east-2, free plan; created once the
user approves its $0 quote) is for the player's shots (`supabase/migrations/`,
`lib/bag-supabase.js`). This plan is about what else could live there.

## What the cloud keeps today

- **Course packages in Vercel Blob** (public store `open-birdie-courses`, Hobby plan):
  - Immutable, content-addressed files: `courses/<key>/blobs/<sha256>`, cached for a year.
  - One mutable `courses/<key>/manifest.json` per course, overwritten in place on every
    publish (base, then complete, then with HD holes).
  - On Vercel, build progress too: `jobs/<uuid>.json` is rewritten about every 15 s, and
    `jobs/active/<key>.json` marks the running build.
  - No index, no listing, and no clean-up of superseded blobs.
- **Hobby allowances:** 1 GB storage, 2,000 uploads a month, 10,000 reads a month. Past
  one, that feature pauses for 30 days. A build spends about 50 uploads on progress
  records, and desktops poll a running build every 10 s.
- **Sizes:** Hazeltine's package is 11.7 MB:
  - `course.json.gz` 1.6 MB, `aerial.jpg` 10.1 MB, `classmap.png` 12 KB.
  - Each HD hole is 0.25 to 0.9 MB.
  - A course with 18 HD holes comes to roughly 20 MB.
- **Layout fixes** are surface-override sidecars, `data/courses/<key>.surfaces.json`, with
  pins, surface polygons and hole boundaries:
  - Each computer has its own. They are not committed and not in packages.
  - "Distribution of curated fixes is an open question" (`docs/surface-override-sidecar.md`).
  - None exist yet.
- **Per-course graphics:**
  - One course-art pack in git: `courses/curated/chambers-bay`, with character and
    gameplay pins/surfaces.
  - A dryness value per course, keyed by the course's *name* and hard-coded twice:
    `public/render/course-character.js` and `lib/tree-obstacles.js`.
  - Graphics preferences are per browser (localStorage), not per course.
  - Researched scorecards for 5 courses are a committed, generated JSON
    (`feat/researched-scorecards`).

## Proposal

Small, changing and worth querying goes in Postgres tables. Large immutable bytes stay in
object storage, and Vercel Blob stays for now.

### Phase 1: course tables (free; the real gain)

| Table | Holds | Replaces |
| --- | --- | --- |
| `course_fixes` | per course (stable id such as `osm:way:26787026`): version, the sidecar JSON (pins, surfaces, holeBoundaries), the course fingerprint it was made against, a note | per-install `*.surfaces.json` that no other computer gets |
| `course_looks` | per course: dryness, biome, default sky / time of day, turf and grass tuning, tree species mix | the dryness map keyed by name (two copies) and the `character` block of course-art packs |
| `course_holes` | per course and hole: par, handicap, yards per tee, green notes | the generated scorecard JSON, editable without a commit |

- **Versions:** rows are insert-only, and the newest version wins. A fix made against
  older course data (a different fingerprint) is skipped, as the sidecar loader does today.
- **The game** reads with the publishable key and never writes. On course load it fetches
  the course's rows and writes the existing sidecar file. The loader stays as it is, and a
  course plays offline exactly as before.
- **Editing:**
  - Option 1: the user, from the dashboard or a small tool holding the secret key, kept
    outside the game.
  - Option 2: Supabase sign-in for curators, with row-level security by role, if more
    than one person curates.
- **Cost: $0.** Rows are a few KB each, a project's database can hold 500 MB, and a
  course load reads tens of KB.

### Phase 2 (optional): build records and manifests in Postgres

- **`course_packages`:** the manifest per course (`package_id`, `complete`, `hd`, `files`
  as JSON). The cloud service writes it with the secret key.
- **`course_builds`:** progress records for builds.
- **Gains:**
  - Frees most of Blob's 2,000 uploads a month.
  - Gives `cloud-build-courses --status` a real listing.
  - "Which blobs does any manifest still use" becomes a query, so superseded blobs can be
    cleaned up.
- **Cost:** $0, since database writes have no request quota.
- **Code to change:** `cloud/sandbox-build.js`, `cloud/sandbox-jobs.js` and
  `cloud/vercel-blob-store.js` (manifest and job reads and writes).

### Phase 3 (only if Blob's limits bite): package files in Supabase Storage

- **How:** a public-read bucket `course-packages` with the same key layout.
  - `cloud/s3.js` already speaks Supabase Storage's S3 endpoint
    (`S3_ENDPOINT=https://<ref>.supabase.co/storage/v1/s3`, path style), so the S3 store
    needs only settings.
  - The Vercel deployment would need a store module for Supabase Storage.
- **Free plan:**
  - 1 GB storage, 5 GB uncached plus 5 GB cached egress a month, and files up to 50 MB.
    The largest file today is 10 MB.
  - These quotas are **per organization**, so they are shared with the Coattails project.
  - That is about 50 full courses (the 7 featured ones are about 140 MB) and about 250
    full-course downloads a month.
- **Pro:**
  - $25 a month per organization. Each project's compute is about $10 a month, and the
    plan's $10 credit covers one, so Coattails plus open-birdie would come to about $35.
  - 100 GB storage (then $0.021/GB) and 250 GB egress (then $0.09/GB).
  - No pausing.
- **Not worth it today.** Blob Hobby also has 1 GB, never bills, and serves immutable,
  CDN-cached files. Move only if storage passes about 1 GB or reads pass 10,000 a month.

## Caveats

- **Pausing:** a free project pauses after about 7 days of low activity and can be resumed
  for 90 days. The game keeps its own copies (`bag.json`, sidecars), so a pause only
  delays updates. Regular play keeps the project awake.
- **Shared quotas:** free quotas are shared across the Coattails organization.

## Decisions for the user

1. Phase 1 tables: yes or no, and who edits fixes and looks (you alone, or signed-in
   curators)?
2. Packages: keep Vercel Blob for now (recommended), or plan Phase 2 or 3?
