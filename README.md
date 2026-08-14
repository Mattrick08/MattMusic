# MattMusic

A personal music player for the mp3s already on your device. No accounts,
no server, no upload — your files never leave your browser.

- **Library** — load mp3s (or m4a/wav/ogg/flac) from your device
- **Playlists** — group tracks, add/remove freely, saved automatically
- **Shuffle** and three repeat modes (off / all / one)
- **Export / Import** — move your whole library (tracks + playlists)
  between devices as a single portable file, no cloud involved
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
