(function () {
  const audio = document.getElementById('audio');
  const content = document.getElementById('content');
  const fileCount = document.getElementById('fileCount');
  const toastEl = document.getElementById('toast');

  // State
  let library = [];          // {id, name, blob, url, title, duration, addedAt}
  let playlists = {};         // name -> array of track ids
  let activeView = 'library'; // 'library' or playlist name
  let currentId = null;
  let isPlaying = false;
  let shuffle = false;
  let repeatMode = 'off';     // off | all | one
  let shuffleOrder = [];
  let creatingPlaylist = false;
  let searchQuery = '';
  let sortMode = 'added';     // 'added' | 'alpha' | 'duration'
  let selectMode = false;
  let selectedIds = new Set();
  let queue = [];              // array of track ids, front of array plays next
  let queuePanelOpen = false;

  // ---------- Themes ----------

  const THEMES = {
    ember: {
      '--bg': '#16221F', '--bg-2': '#182721', '--surface': '#1F2E29', '--surface-2': '#263B34',
      '--text': '#EAE3D2', '--cream': '#EAE3D2', '--muted': '#8FA098',
      '--amber': '#E8A33D', '--sage': '#6B8F71', '--line': '#33463F'
    },
    dusk: {
      '--bg': '#1A1B2E', '--bg-2': '#1E2038', '--surface': '#242640', '--surface-2': '#2E3153',
      '--text': '#E7E4F4', '--cream': '#E7E4F4', '--muted': '#9391B8',
      '--amber': '#8C7AE6', '--sage': '#5C7AEA', '--line': '#35375A'
    },
    terracotta: {
      '--bg': '#241714', '--bg-2': '#2A1B17', '--surface': '#33211B', '--surface-2': '#402A22',
      '--text': '#F3E4D8', '--cream': '#F3E4D8', '--muted': '#B08A76',
      '--amber': '#E67E52', '--sage': '#C2775A', '--line': '#4A362D'
    }
  };
  let currentTheme = 'ember';

  function applyTheme(name) {
    const t = THEMES[name] || THEMES.ember;
    currentTheme = THEMES[name] ? name : 'ember';
    Object.entries(t).forEach(([k, v]) => document.documentElement.style.setProperty(k, v));
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t['--bg']);
    try { localStorage.setItem('mattmusic-theme', currentTheme); } catch (e) { /* storage may be unavailable */ }
    document.querySelectorAll('.swatch').forEach((el) => {
      el.classList.toggle('active', el.dataset.theme === currentTheme);
    });
  }

  (function initTheme() {
    let saved = 'ember';
    try { saved = localStorage.getItem('mattmusic-theme') || 'ember'; } catch (e) { /* ignore */ }
    applyTheme(saved);
  })();

  document.querySelectorAll('.swatch').forEach((el) => {
    el.addEventListener('click', () => applyTheme(el.dataset.theme));
  });

  // ---------- Rain overlay ----------
  // A separate <audio> element looping rain.mp3 on top of the music. It is
  // deliberately NOT routed through the Web Audio graph, so the music's
  // background playback path stays untouched. The file is fetched once
  // (cached by the service worker, so it works offline afterwards) and
  // played from a blob URL to avoid range-request quirks.

  const rainAudio = document.getElementById('rainAudio');
  const rainBtn = document.getElementById('rainBtn');
  const rainVol = document.getElementById('rainVol');
  let rainOn = false;
  let rainReady = false;

  function setRainUI() {
    rainBtn.classList.toggle('active', rainOn);
    rainBtn.setAttribute('aria-pressed', String(rainOn));
  }

  async function loadRain() {
    if (rainReady) return true;
    rainBtn.classList.add('loading');
    try {
      const res = await fetch('rain.mp3');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      rainAudio.src = URL.createObjectURL(await res.blob());
      rainReady = true;
      return true;
    } catch (e) {
      showToast('Rain sound unavailable offline');
      return false;
    } finally {
      rainBtn.classList.remove('loading');
    }
  }

  async function setRain(on) {
    if (on) {
      if (!(await loadRain())) return;
      try { await rainAudio.play(); } catch (e) { showToast('Could not start rain'); return; }
    } else {
      rainAudio.pause();
    }
    rainOn = on;
    setRainUI();
    try { localStorage.setItem('mattmusic-rain', on ? '1' : '0'); } catch (e) { /* ignore */ }
  }

  rainBtn.addEventListener('click', () => setRain(!rainOn));
  rainVol.addEventListener('input', () => {
    rainAudio.volume = rainVol.value / 100;
    try { localStorage.setItem('mattmusic-rain-vol', rainVol.value); } catch (e) { /* ignore */ }
  });

  (function initRain() {
    let vol = 50;
    try {
      const v = parseInt(localStorage.getItem('mattmusic-rain-vol'), 10);
      if (!isNaN(v)) vol = Math.min(100, Math.max(0, v));
    } catch (e) { /* ignore */ }
    rainVol.value = vol;
    rainAudio.volume = vol / 100;
    // Browsers block autoplay without a gesture, so the saved on/off state
    // is not auto-resumed; the user taps Rain to start it each session.
  })();

  // ---------- Sleep timer ----------
  // Tap the Sleep button to cycle 15 → 30 → 60 min → off. For the last 20 s
  // the music and rain fade out together, then both are paused. Uses the
  // wall clock (Date.now) so a delayed tick can never overshoot the end.
  // (iOS ignores audio.volume, so there the fade is a plain stop.)

  const sleepBtn = document.getElementById('sleepBtn');
  const sleepLabel = document.getElementById('sleepLabel');
  const SLEEP_STEPS = [15, 30, 60]; // minutes
  const SLEEP_FADE_MS = 20000;
  let sleepEnd = 0;
  let sleepTimer = null;
  let sleepStep = -1;

  function rainBaseVolume() { return rainVol.value / 100; }

  function stopSleep() {
    clearInterval(sleepTimer);
    sleepTimer = null;
    sleepEnd = 0;
    sleepStep = -1;
    audio.volume = 1;
    rainAudio.volume = rainBaseVolume();
    sleepBtn.classList.remove('active');
    sleepLabel.textContent = 'Sleep';
  }

  function sleepTick() {
    const left = sleepEnd - Date.now();
    if (left <= 0) {
      audio.pause();
      if (rainOn) setRain(false);
      stopSleep();
      showToast('Sleep timer done');
      return;
    }
    const f = left < SLEEP_FADE_MS ? left / SLEEP_FADE_MS : 1;
    audio.volume = f;
    rainAudio.volume = rainBaseVolume() * f;
    const s = Math.ceil(left / 1000);
    sleepLabel.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  sleepBtn.addEventListener('click', () => {
    sleepStep++;
    if (sleepStep >= SLEEP_STEPS.length) {
      stopSleep();
      showToast('Sleep timer off');
      return;
    }
    clearInterval(sleepTimer);
    sleepEnd = Date.now() + SLEEP_STEPS[sleepStep] * 60000;
    sleepTimer = setInterval(sleepTick, 250);
    sleepBtn.classList.add('active');
    sleepTick();
    showToast('Sleep in ' + SLEEP_STEPS[sleepStep] + ' min');
  });

  // ---------- Storage usage ----------

  function fmtBytes(bytes) {
    if (!bytes) return '0 MB';
    const mb = bytes / (1024 * 1024);
    if (mb < 1024) return mb.toFixed(mb < 10 ? 1 : 0) + ' MB';
    return (mb / 1024).toFixed(2) + ' GB';
  }

  async function updateStorageInfo() {
    const tag = document.getElementById('storageTag');
    if (!tag) return;
    const libraryBytes = library.reduce((sum, t) => sum + (t.blob ? t.blob.size : 0) + (t.art ? t.art.size : 0), 0);
    let text = fmtBytes(libraryBytes) + ' in your library';
    if (navigator.storage && navigator.storage.estimate) {
      try {
        const { usage, quota } = await navigator.storage.estimate();
        if (usage != null && quota != null && quota > 0) {
          text = fmtBytes(usage) + ' of ' + fmtBytes(quota) + ' used on this device';
        }
      } catch (e) { /* fall back to library-only estimate */ }
    }
    tag.textContent = text;
  }

  function fmtTime(s) {
    if (!isFinite(s) || s == null) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60).toString().padStart(2, '0');
    return m + ':' + sec;
  }

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toastEl.classList.remove('show'), 1800);
  }

  // Special view id for the automatic Favorites list (can't clash with a
  // playlist name a user would type).
  const FAV = '__favorites__';
  function isLibLike() { return activeView === 'library' || activeView === FAV; }
  function viewLabel() {
    return activeView === 'library' ? 'Library' : activeView === FAV ? 'Favorites' : activeView;
  }

  function currentList() {
    const base = activeView === 'library'
      ? library
      : activeView === FAV
      ? library.filter((t) => t.fav)
      : (playlists[activeView] || []).map((id) => library.find((t) => t.id === id)).filter(Boolean);

    let list = base;
    const q = searchQuery.trim().toLowerCase();
    if (q) list = list.filter((t) => t.title.toLowerCase().includes(q));

    list = list.slice().sort((a, b) => {
      if (sortMode === 'alpha') return a.title.localeCompare(b.title);
      if (sortMode === 'duration') return (a.duration || 0) - (b.duration || 0);
      return (b.addedAt || 0) - (a.addedAt || 0); // recently added first
    });

    return list;
  }

  function getTrackById(id) {
    return library.find((t) => t.id === id);
  }

  // ---------- Cover art (ID3v2 APIC frame) ----------
  // Reads embedded album art straight out of the mp3's own ID3v2 tag —
  // no network calls, no third-party library, just a slice of bytes the
  // file already carries.

  function readSyncSafeInt(bytes, offset) {
    return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset + 1] & 0x7f) << 14) |
           ((bytes[offset + 2] & 0x7f) << 7) | (bytes[offset + 3] & 0x7f);
  }
  function readInt32BE(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
  }

  function parseApicFrame(bytes) {
    const encoding = bytes[0];
    let i = 1;
    let mimeEnd = i;
    while (mimeEnd < bytes.length && bytes[mimeEnd] !== 0) mimeEnd++;
    const mime = new TextDecoder('latin1').decode(bytes.slice(i, mimeEnd));
    i = mimeEnd + 1;
    const pictureType = bytes[i];
    i += 1;
    if (encoding === 1 || encoding === 2) { // UTF-16 description: 2-byte null terminator
      let descEnd = i;
      while (descEnd < bytes.length - 1 && !(bytes[descEnd] === 0 && bytes[descEnd + 1] === 0)) descEnd += 2;
      i = descEnd + 2;
    } else {
      let descEnd = i;
      while (descEnd < bytes.length && bytes[descEnd] !== 0) descEnd++;
      i = descEnd + 1;
    }
    const data = bytes.slice(i);
    if (!data.length) return null;
    return { mime: mime || 'image/jpeg', pictureType, data };
  }

  async function extractCoverArt(blob) {
    try {
      const head = new Uint8Array(await blob.slice(0, 10).arrayBuffer());
      if (head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null; // no "ID3" header
      const majorVersion = head[3];
      const flags = head[5];
      const tagSize = readSyncSafeInt(head, 6);
      if (tagSize <= 0 || tagSize > 24 * 1024 * 1024) return null; // sanity cap

      const bytes = new Uint8Array(await blob.slice(10, 10 + tagSize).arrayBuffer());
      let offset = 0;

      if (flags & 0x40) { // extended header present — skip over it
        const extSize = majorVersion >= 4 ? readSyncSafeInt(bytes, 0) : readInt32BE(bytes, 0);
        offset += extSize;
      }

      let best = null;
      while (offset < bytes.length - 10) {
        const id = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
        if (id === '\u0000\u0000\u0000\u0000') break; // padding reached
        const frameSize = majorVersion >= 4 ? readSyncSafeInt(bytes, offset + 4) : readInt32BE(bytes, offset + 4);
        const frameStart = offset + 10;
        if (frameSize <= 0 || frameStart + frameSize > bytes.length) break;

        if (id === 'APIC') {
          const parsed = parseApicFrame(bytes.slice(frameStart, frameStart + frameSize));
          if (parsed) {
            if (!best || parsed.pictureType === 3) best = parsed;
            if (parsed.pictureType === 3) break; // "front cover" — good enough, stop looking
          }
        }
        offset = frameStart + frameSize;
      }

      if (!best) return null;
      return new Blob([best.data], { type: best.mime });
    } catch (err) {
      return null; // malformed/unsupported tag — fall back to the mono avatar
    }
  }

  // ---------- Loading & persistence ----------

  async function bootstrap() {
    const stored = await DB.getAllTracks();
    stored.forEach((t) => {
      t.url = URL.createObjectURL(t.blob);
      t.addedAt = t.addedAt || 0; // tracks saved before this field existed
      t.artUrl = t.art ? URL.createObjectURL(t.art) : null;
      library.push(t);
    });
    const storedPlaylists = await DB.getAllPlaylists();
    storedPlaylists.forEach((p) => { playlists[p.name] = p.trackIds; });

    restoreResume();
    updateFileCount();
    render();
    backfillArt(); // fetch cover art for tracks added before this feature existed
  }

  async function backfillArt() {
    for (const t of library) {
      if (t.artChecked) continue;
      const art = await extractCoverArt(t.blob);
      t.artChecked = true;
      if (art) { t.art = art; t.artUrl = URL.createObjectURL(art); }
      await DB.updateTrack({ id: t.id, name: t.name, blob: t.blob, title: t.title, duration: t.duration, addedAt: t.addedAt, art: t.art || null, artChecked: true, fav: !!t.fav });
      if (art) render();
    }
  }

  async function loadFiles(fileList) {
    const arr = Array.from(fileList).filter(
      (f) => f.type.startsWith('audio/') || /\.(mp3|m4a|wav|ogg|flac)$/i.test(f.name)
    );
    for (const file of arr) {
      await ingestBlob(file, file.name);
    }
    updateFileCount();
    render();
    if (arr.length) showToast(arr.length + ' file' + (arr.length === 1 ? '' : 's') + ' added');
  }

  // Shared by the local file picker, library import, and the free-music
  // downloader below — takes any audio blob + a filename and stores it.
  async function ingestBlob(blob, filename) {
    const id = 'trk_' + Math.random().toString(36).slice(2, 10);
    const url = URL.createObjectURL(blob);
    const title = filename.replace(/\.[^/.]+$/, '');
    const addedAt = Date.now();
    const track = { id, name: filename, blob, url, title, duration: null, addedAt, art: null, artUrl: null, artChecked: false, fav: false };
    library.push(track);
    await DB.addTrack({ id, name: filename, blob, title, duration: null, addedAt, art: null, artChecked: false, fav: false });

    const probe = new Audio(url);
    probe.addEventListener('loadedmetadata', () => {
      track.duration = probe.duration;
      DB.updateTrack({ id, name: filename, blob, title, duration: probe.duration, addedAt, art: track.art, artChecked: track.artChecked, fav: !!track.fav });
      render();
    });

    extractCoverArt(blob).then((art) => {
      track.artChecked = true;
      if (art) { track.art = art; track.artUrl = URL.createObjectURL(art); }
      DB.updateTrack({ id, name: filename, blob, title, duration: track.duration, addedAt, art: track.art, artChecked: true, fav: !!track.fav });
      if (art) {
        render();
        if (currentId === id) updateMediaSession(track); // refresh lock-screen art if it's playing already
      }
    });

    return track;
  }

  async function bulkDeleteTracks(ids) {
    const idSet = new Set(ids);
    library = library.filter((t) => {
      if (idSet.has(t.id)) {
        URL.revokeObjectURL(t.url);
        if (t.artUrl) URL.revokeObjectURL(t.artUrl);
        return false;
      }
      return true;
    });
    Object.keys(playlists).forEach((name) => {
      const before = playlists[name].length;
      playlists[name] = playlists[name].filter((tid) => !idSet.has(tid));
      if (playlists[name].length !== before) DB.savePlaylist(name, playlists[name]);
    });
    queue = queue.filter((tid) => !idSet.has(tid));
    for (const id of ids) {
      await DB.deleteTrack(id);
      selectedIds.delete(id);
    }
    if (idSet.has(currentId)) { audio.pause(); audio.removeAttribute('src'); currentId = null; isPlaying = false; }
    updateFileCount();
  }

  async function removeTrack(id) {
    const track = getTrackById(id);
    await bulkDeleteTracks([id]);
    render();
    if (track) showToast('Deleted "' + track.title + '"');
  }

  async function renameTrack(id) {
    const track = getTrackById(id);
    if (!track) return;
    const next = prompt('Rename track', track.title);
    if (next == null) return; // cancelled
    const title = next.trim();
    if (!title || title === track.title) return;
    track.title = title;
    await DB.updateTrack({ id: track.id, name: track.name, blob: track.blob, title, duration: track.duration, addedAt: track.addedAt, art: track.art || null, artChecked: !!track.artChecked, fav: !!track.fav });
    render();
    showToast('Renamed to "' + title + '"');
    if (currentId === id) updateMediaSession(track); // keep lock-screen title in sync
  }

  async function toggleFav(id) {
    const track = getTrackById(id);
    if (!track) return;
    track.fav = !track.fav;
    render();
    showToast(track.fav ? 'Added to Favorites' : 'Removed from Favorites');
    await DB.updateTrack({ id: track.id, name: track.name, blob: track.blob, title: track.title, duration: track.duration, addedAt: track.addedAt, art: track.art || null, artChecked: !!track.artChecked, fav: track.fav });
  }

  function updateFileCount() {
    fileCount.textContent = library.length
      ? library.length + ' track' + (library.length === 1 ? '' : 's') + ' · saved on this device'
      : 'no files loaded';
    updateStorageInfo();
  }

  // ---------- Export / Import (portable library file) ----------
  //
  // File format ("MML1"), all little-endian:
  //   bytes 0-3    magic "MML1"
  //   bytes 4-7    uint32 header length in bytes
  //   header       UTF-8 JSON: { tracks: [{id,title,name,mime,size,duration}], playlists: {...} }
  //   ...raw audio bytes for each track, back to back, in the order listed in header.tracks
  //
  // Raw bytes (not base64) keep the exported file the same size as your
  // actual mp3s — no ~33% bloat — and it needs no external libraries,
  // so it works fully offline on both ends.

  async function exportLibrary() {
    if (!library.length) { showToast('Nothing to export yet'); return; }
    const meta = {
      tracks: library.map((t) => ({
        id: t.id, title: t.title, name: t.name,
        mime: t.blob.type || 'audio/mpeg', size: t.blob.size, duration: t.duration, addedAt: t.addedAt, fav: !!t.fav
      })),
      playlists
    };
    const headerBytes = new TextEncoder().encode(JSON.stringify(meta));
    const lenBuf = new Uint8Array(4);
    new DataView(lenBuf.buffer).setUint32(0, headerBytes.length, true);
    const magic = new TextEncoder().encode('MML1');

    const blob = new Blob([magic, lenBuf, headerBytes, ...library.map((t) => t.blob)], {
      type: 'application/octet-stream'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `mattmusic-library-${stamp}.mmlib`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    showToast('Exported ' + library.length + ' track' + (library.length === 1 ? '' : 's'));
  }

  async function importLibraryFile(file) {
    try {
      const buf = await file.arrayBuffer();
      if (buf.byteLength < 8) throw new Error('too small');
      const dv = new DataView(buf);
      const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
      if (magic !== 'MML1') { showToast('Not a MattMusic library file'); return; }

      const headerLen = dv.getUint32(4, true);
      const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, headerLen)));
      let offse
