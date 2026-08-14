# MattMusic

A personal music player for the mp3s already on your device. No accounts,
no server, no upload — your files never leave your browser.

- **Library** — load mp3s (or m4a/wav/ogg/flac) from your device
- **Playlists** — group tracks, add/remove freely, saved automatically
- **Shuffle** and three repeat modes (off / all / one)
- **Export / Import** — move your whole library (tracks + playlists)
  between devices as a single portable file, no cloud involved
- **Get free music** — search and download from Internet Archive's open
  audio collections (Creative Commons and public-domain tracks, plus
  live recordings artists have opened up for taping/sharing) — legally,
  directly into your library
- **Offline & installable** — a service worker caches the app shell, and
  your files + playlists are stored locally in IndexedDB, so once you've
  loaded a library, MattMusic opens and plays without a network connection
- **Lock-screen controls** on mobile, via the Media Session API

## Try it locally

Browsers require a real origin (not `file://`) for service workers and
some storage APIs, so serve the folder instead of opening index.html
directly:

```bash
cd mattmusic
python3 -m http.server 8080
# visit http://localhost:8080
```

## Deploy it (GitHub Pages)

1. Push this folder to a GitHub repo.
2. In the repo, go to **Settings → Pages**, set source to the `main`
   branch (root), and save.
3. Visit the published URL. On mobile, use "Add to Home Screen" (iOS
   Safari) or the install prompt / Chrome menu → "Install app" (Android)
   to add it like a native app.

## How persistence works

- Audio files are stored as blobs in **IndexedDB** (`db.js`), so your
  library survives closing the tab or going offline.
- Playlists are also stored in IndexedDB and saved automatically the
  moment you create one, add a track, or remove a track — no explicit
  save step.
- The **service worker** (`service-worker.js`) caches the app's own
  code (HTML/CSS/JS/icons) so the app itself loads with no connection.
  It does not cache your music — that's already local, in IndexedDB.

## Moving your library between devices

MattMusic on your PC and MattMusic on your phone each keep their own
local copy — nothing syncs automatically, by design (your files never
leave the device you loaded them on). To bring a library from one
device to another:

1. On the source device, tap **↓ Export library**. This downloads a
   single `mattmusic-library-YYYY-MM-DD.mmlib` file containing every
   track and playlist.
2. Get that file onto the other device — AirDrop, a cable, a cloud
   drive, email to yourself, whatever you'd normally use to move a
   file across.
3. On the other device, open MattMusic and tap **↑ Import library**
   (it's available from the empty state too, if that device has no
   library yet). Importing merges into whatever's already there —
   existing playlists with the same name get the new tracks added in,
   rather than being overwritten.

The `.mmlib` file is just your raw audio bytes plus a small JSON
header describing titles and playlists — no re-encoding, no quality
loss, and no external service ever sees it.

## Get free music

Tap **♫ Get free music** to search Internet Archive's open audio
collections directly from inside MattMusic — no separate site, no
account, and it's a straight call from your browser to
`archive.org`'s public search API.

- Results are scoped to items that are explicitly licensed for reuse
  (Creative Commons or public domain — shown as a badge on each result)
  or that belong to collections the Archive runs specifically for open
  sharing, like **Netlabels** (independent labels that release under
  CC) and the **Live Music Archive** (bands who've opted in to letting
  their shows be taped and shared).
- Opening a result shows its individual mp3 tracks; tapping ⬇ downloads
  that one file straight into your library, same as loading a local
  file.
- This is the one part of MattMusic that needs an internet connection
  — searching and downloading talk to archive.org directly. Everything
  you've already added keeps working offline as usual.

This is intentionally **not** a way to pull audio from arbitrary sites
or streaming services — it's scoped to sources that are actually
licensed for this. If there's a specific artist you're after who isn't
on the Archive, the honest options are usually Bandcamp, an official
purchase, or ripping a CD you own.

## Known limits

- **Background playback with the screen fully off** depends on your
  phone and browser. Installed as a PWA with Media Session support,
  most modern Android/Chrome setups keep audio playing through a lock
  screen; iOS Safari is stricter about this than a true native app.
- Files are matched by content, not a live link to their original
  location on disk — if you want to swap in a re-encoded or renamed
  version of a track, just re-add it.

## Project structure

```
mattmusic/
├── index.html          # app shell
├── style.css            # styles
├── app.js                # UI + playback logic
├── db.js                 # IndexedDB wrapper (tracks + playlists)
├── service-worker.js     # offline app-shell caching
├── manifest.webmanifest  # installability metadata
└── icons/
    ├── icon-192.png
    └── icon-512.png
```

## Changelog

**Get free music**
- Added a "♫ Get free music" search inside MattMusic, backed by
  Internet Archive's public API — search, preview, and download
  Creative Commons / public-domain / openly-shared tracks straight into
  your library. See "Get free music" above for how it's scoped.
- Bumped the service worker cache version again for this update, and
  hardened it to never intercept cross-origin requests (like the new
  archive.org calls), only the app's own same-origin files.

**Export / Import**
- Added a portable `.mmlib` library format so you can move your whole
  collection (tracks + playlists) between devices without a cloud
  service — see "Moving your library between devices" above.
- Bumped the service worker cache version so this update replaces any
  previously cached app shell.

**Rename + polish pass**
- Renamed the app to MattMusic throughout (title, manifest, icons, DB
  namespace).
- Fixed a memory leak: removed tracks now release their blob URL
  instead of leaking it.
- Fixed playback not fully stopping (stale `<audio>` src) when the
  currently-playing track was deleted.
- Bumped the service worker cache version so the new shell replaces
  any previously cached version instead of serving stale files.
- Visual pass: monogrammed track tiles, a spinning disc mark that
  turns with playback, a playing-track equalizer indicator, warmer
  background gradient, visible keyboard focus states, and
  `prefers-reduced-motion` support.

## License

MIT — do whatever you like with it.
