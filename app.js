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

  function currentList() {
    const base = activeView === 'library'
      ? library
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
      await DB.updateTrack({ id: t.id, name: t.name, blob: t.blob, title: t.title, duration: t.duration, addedAt: t.addedAt, art: t.art || null, artChecked: true });
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
    const track = { id, name: filename, blob, url, title, duration: null, addedAt, art: null, artUrl: null, artChecked: false };
    library.push(track);
    await DB.addTrack({ id, name: filename, blob, title, duration: null, addedAt, art: null, artChecked: false });

    const probe = new Audio(url);
    probe.addEventListener('loadedmetadata', () => {
      track.duration = probe.duration;
      DB.updateTrack({ id, name: filename, blob, title, duration: probe.duration, addedAt, art: track.art, artChecked: track.artChecked });
      render();
    });

    extractCoverArt(blob).then((art) => {
      track.artChecked = true;
      if (art) { track.art = art; track.artUrl = URL.createObjectURL(art); }
      DB.updateTrack({ id, name: filename, blob, title, duration: track.duration, addedAt, art: track.art, artChecked: true });
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
    await DB.updateTrack({ id: track.id, name: track.name, blob: track.blob, title, duration: track.duration, addedAt: track.addedAt, art: track.art || null, artChecked: !!track.artChecked });
    render();
    showToast('Renamed to "' + title + '"');
    if (currentId === id) updateMediaSession(track); // keep lock-screen title in sync
  }

  function updateFileCount() {
    fileCount.textContent = library.length
      ? library.length + ' track' + (library.length === 1 ? '' : 's') + ' · saved on this device'
      : 'no files loaded';
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
        mime: t.blob.type || 'audio/mpeg', size: t.blob.size, duration: t.duration, addedAt: t.addedAt
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
      let offset = 8 + headerLen;

      const idMap = {};
      let added = 0;
      for (const t of (meta.tracks || [])) {
        const size = t.size || 0;
        const slice = buf.slice(offset, offset + size);
        offset += size;

        const blob = new Blob([slice], { type: t.mime || 'audio/mpeg' });
        const newId = 'trk_' + Math.random().toString(36).slice(2, 10);
        idMap[t.id] = newId;

        const url = URL.createObjectURL(blob);
        const addedAt = t.addedAt || Date.now();
        const art = await extractCoverArt(blob);
        const artUrl = art ? URL.createObjectURL(art) : null;
        library.push({ id: newId, name: t.name, blob, url, title: t.title, duration: t.duration, addedAt, art, artUrl, artChecked: true });
        await DB.addTrack({ id: newId, name: t.name, blob, title: t.title, duration: t.duration, addedAt, art, artChecked: true });
        added++;
      }

      let newPlaylists = 0;
      for (const [name, ids] of Object.entries(meta.playlists || {})) {
        const mapped = (ids || []).map((id) => idMap[id]).filter(Boolean);
        if (playlists[name]) {
          playlists[name] = Array.from(new Set([...playlists[name], ...mapped]));
        } else {
          playlists[name] = mapped;
          newPlaylists++;
        }
        await DB.savePlaylist(name, playlists[name]);
      }

      updateFileCount();
      render();
      const bits = [added + ' track' + (added === 1 ? '' : 's')];
      if (newPlaylists) bits.push(newPlaylists + ' playlist' + (newPlaylists === 1 ? '' : 's'));
      showToast('Imported ' + bits.join(', '));
    } catch (err) {
      console.error('Import failed:', err);
      showToast('Import failed — file may be corrupted');
    }
  }

  function triggerImportPicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.mmlib';
    input.addEventListener('change', (e) => {
      if (e.target.files[0]) importLibraryFile(e.target.files[0]);
    });
    input.click();
  }

  function playTrack(id) {
    const track = getTrackById(id);
    if (!track) return;
    currentId = id;
    audio.src = track.url;
    audio.play().then(() => { isPlaying = true; render(); }).catch(() => { isPlaying = false; render(); });
    updateMediaSession(track);
    render();
  }

  function togglePlay() {
    if (!currentId) {
      const list = currentList();
      if (list.length) playTrack(list[0].id);
      return;
    }
    if (isPlaying) { audio.pause(); isPlaying = false; }
    else { audio.play(); isPlaying = true; }
    render();
  }

  function buildShuffleOrder() {
    const list = currentList().map((t) => t.id);
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    shuffleOrder = list;
  }

  function nextTrack(auto) {
    const list = currentList();
    if (!list.length) return;
    let order = shuffle ? shuffleOrder : list.map((t) => t.id);
    if (shuffle && (!order.length || !order.includes(currentId))) { buildShuffleOrder(); order = shuffleOrder; }
    let idx = order.indexOf(currentId);
    if (repeatMode === 'one' && auto) { playTrack(currentId); return; }
    idx = (idx + 1) % order.length;
    if (idx === 0 && auto && repeatMode !== 'all' && !shuffle) {
      isPlaying = false; render(); return;
    }
    playTrack(order[idx]);
  }

  function prevTrack() {
    const list = currentList();
    if (!list.length) return;
    let order = shuffle ? shuffleOrder : list.map((t) => t.id);
    let idx = order.indexOf(currentId);
    idx = (idx - 1 + order.length) % order.length;
    playTrack(order[idx]);
  }

  function toggleShuffle() {
    shuffle = !shuffle;
    if (shuffle) buildShuffleOrder();
    render();
  }

  function cycleRepeat() {
    repeatMode = repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off';
    render();
  }

  // ---------- Playlists ----------

  function createPlaylist(name) {
    name = name.trim();
    if (!name || playlists[name]) return;
    playlists[name] = [];
    DB.savePlaylist(name, []);
    activeView = name;
    creatingPlaylist = false;
    render();
    showToast('Playlist "' + name + '" created');
  }

  function deletePlaylist(name) {
    if (!confirm('Delete playlist "' + name + '"? Tracks stay in your library.')) return;
    delete playlists[name];
    DB.deletePlaylist(name);
    if (activeView === name) activeView = 'library';
    render();
  }

  function addToPlaylist(trackId, plName) {
    if (!playlists[plName].includes(trackId)) {
      playlists[plName].push(trackId);
      DB.savePlaylist(plName, playlists[plName]);
      showToast('Added to ' + plName);
    }
    render();
  }

  function removeFromPlaylist(trackId, plName) {
    playlists[plName] = playlists[plName].filter((id) => id !== trackId);
    DB.savePlaylist(plName, playlists[plName]);
    render();
  }

  // ---------- Bulk selection ----------

  function toggleSelect(id) {
    if (selectedIds.has(id)) selectedIds.delete(id); else selectedIds.add(id);
    render();
  }

  function selectAllVisible() {
    const list = currentList();
    const allSelected = list.length > 0 && list.every((t) => selectedIds.has(t.id));
    if (allSelected) list.forEach((t) => selectedIds.delete(t.id));
    else list.forEach((t) => selectedIds.add(t.id));
    render();
  }

  async function bulkDelete() {
    if (!selectedIds.size) return;
    const ids = Array.from(selectedIds);
    const n = ids.length;
    if (!confirm('Delete ' + n + ' track' + (n === 1 ? '' : 's') + ' from your library? This removes the files from this device.')) return;
    await bulkDeleteTracks(ids);
    selectMode = false;
    render();
    showToast('Deleted ' + n + ' track' + (n === 1 ? '' : 's'));
  }

  function bulkAddToPlaylist() {
    const names = Object.keys(playlists);
    if (!names.length) { showToast('Create a playlist first'); return; }
    const n = selectedIds.size;
    const choice = names.length === 1 ? names[0] : prompt('Add ' + n + ' track' + (n === 1 ? '' : 's') + ' to which playlist?\n' + names.join(', '));
    if (!choice || !playlists[choice]) return;
    let added = 0;
    selectedIds.forEach((id) => {
      if (!playlists[choice].includes(id)) { playlists[choice].push(id); added++; }
    });
    DB.savePlaylist(choice, playlists[choice]);
    selectedIds.clear();
    selectMode = false;
    render();
    showToast('Added ' + added + ' track' + (added === 1 ? '' : 's') + ' to ' + choice);
  }

  function bulkRemoveFromPlaylist() {
    const n = selectedIds.size;
    if (!n) return;
    playlists[activeView] = playlists[activeView].filter((id) => !selectedIds.has(id));
    DB.savePlaylist(activeView, playlists[activeView]);
    selectedIds.clear();
    selectMode = false;
    render();
    showToast('Removed ' + n + ' track' + (n === 1 ? '' : 's') + ' from ' + activeView);
  }

  // ---------- Media Session (lock screen controls + background playback) ----------
  //
  // Properly declaring playbackState, artwork, and position on every change
  // is what tells the phone's OS "this is real, active media" — it's the
  // same signal Spotify/YouTube Music use to keep playing with the screen
  // off. Without it, mobile browsers are much quicker to suspend a
  // backgrounded tab/PWA and cut the audio.

  function updateMediaSession(track) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: 'Your library',
      album: activeView === 'library' ? 'Library' : activeView,
      artwork: track.artUrl ? [
        { src: track.artUrl, sizes: '512x512', type: (track.art && track.art.type) || 'image/jpeg' }
      ] : []
    });
    navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
    navigator.mediaSession.setActionHandler('play', () => audio.play());
    navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
    navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack(false));
    navigator.mediaSession.setActionHandler('stop', () => { audio.pause(); audio.currentTime = 0; });
    try {
      navigator.mediaSession.setActionHandler('seekto', (details) => {
        if (details.seekTime != null) audio.currentTime = details.seekTime;
      });
    } catch (e) { /* not supported on every browser */ }
  }

  audio.addEventListener('ended', () => nextTrack(true));
  audio.addEventListener('timeupdate', renderProgressOnly);
  audio.addEventListener('play', () => {
    isPlaying = true;
    renderControlsOnly();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing';
  });
  audio.addEventListener('pause', () => {
    isPlaying = false;
    renderControlsOnly();
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });

  function renderProgressOnly() {
    const bar = document.getElementById('seek');
    const cur = document.getElementById('curTime');
    if (bar && !bar.dragging) bar.value = audio.currentTime || 0;
    if (cur) cur.textContent = fmtTime(audio.currentTime);
    if ('mediaSession' in navigator && 'setPositionState' in navigator.mediaSession && isFinite(audio.duration) && audio.duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          playbackRate: audio.playbackRate || 1,
          position: Math.min(audio.currentTime, audio.duration)
        });
      } catch (e) { /* duration/position can be momentarily out of range mid-seek */ }
    }
  }
  function renderControlsOnly() {
    const playBtn = document.getElementById('playBtnIcon');
    if (playBtn) playBtn.innerHTML = isPlaying ? iconPause() : iconPlay();
    syncBrandMark();
  }

  function syncBrandMark() {
    const mark = document.getElementById('brandMark');
    if (!mark) return;
    mark.classList.toggle('spinning', isPlaying);
  }

  function iconPlay() { return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>'; }
  function iconPause() { return '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>'; }

  // ---------- Rendering ----------

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // A few warm tints drawn from the palette, rotated by a hash of the
  // title so each track gets a stable, distinct monogram color.
  const MONO_COLORS = ['#E8A33D', '#6B8F71', '#C97B4A', '#7FA8A0', '#D9B15C'];
  function monoColor(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
    return MONO_COLORS[h % MONO_COLORS.length];
  }
  function monoLetter(title) {
    const m = title.trim().match(/[a-zA-Z0-9]/);
    return m ? m[0].toUpperCase() : '♪';
  }

  function render() {
    // Preserve focus/cursor in the search box across the innerHTML rebuild below.
    const searchFocused = document.activeElement && document.activeElement.id === 'searchInput';
    const searchSel = searchFocused ? document.activeElement.selectionStart : null;

    const tabsHtml = ['library', ...Object.keys(playlists)].map((name) => {
      const label = name === 'library' ? 'Library' : escapeHtml(name);
      const del = name !== 'library' ? `<span class="del" data-del-playlist="${escapeHtml(name)}">✕</span>` : '';
      return `<div class="tab ${activeView === name ? 'active' : ''}" data-view="${escapeHtml(name)}">${label}${del}</div>`;
    }).join('') + `<div class="tab new" id="newPlaylistTab">+ New playlist</div>`;

    const list = currentList();

    let listHtml;
    if (library.length === 0) {
      listHtml = `
        <div class="empty">
          <svg width="52" height="52" viewBox="0 0 24 24" fill="none" stroke="#6B8F71" stroke-width="1.3"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.4"/><path d="M12 3v3M12 18v3"/></svg>
          <p>Load mp3s from your device to start. They're stored on this device so they're here next time, even offline.</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center;">
            <button class="btn btn-primary" id="loadBtn">Choose files</button>
            <button class="btn btn-ghost" id="loadFolderBtnEmpty">Add a folder</button>
            <button class="btn btn-ghost" id="importBtnEmpty">Import library file</button>
          </div>
        </div>`;
    } else if (list.length === 0) {
      listHtml = searchQuery.trim()
        ? `<div class="tracklist"><div class="empty-list">No tracks match "${escapeHtml(searchQuery.trim())}".</div></div>`
        : `<div class="tracklist"><div class="empty-list">No tracks in "${escapeHtml(activeView)}" yet. Add some from your Library.</div></div>`;
    } else {
      listHtml = `<div class="tracklist">` + list.map((t, i) => {
        const isPl = t.id === currentId;
        const isSel = selectedIds.has(t.id);
        let actionBtn = '';
        if (!selectMode) {
          if (activeView === 'library') {
            const addBtn = Object.keys(playlists).length
              ? `<button class="icon-btn" data-add="${t.id}" title="Add to playlist">＋</button>`
              : '';
            actionBtn = `<button class="icon-btn" data-rename="${t.id}" title="Rename">✎</button>` + addBtn + `<button class="icon-btn" data-delete="${t.id}" title="Delete from library">🗑</button>`;
          } else {
            actionBtn = `<button class="icon-btn" data-rename="${t.id}" title="Rename">✎</button><button class="icon-btn" data-remove-from="${t.id}" title="Remove from playlist">✕</button>`;
          }
        }
        const eq = (isPl && isPlaying) ? '<span class="eq"><span></span><span></span><span></span></span>' : '';
        const leading = selectMode
          ? `<input type="checkbox" class="track-check" ${isSel ? 'checked' : ''} />`
          : (t.artUrl
              ? `<img class="art-thumb" src="${t.artUrl}" alt="" />`
              : `<span class="mono" style="background:${monoColor(t.title)}">${monoLetter(t.title)}</span>`);
        return `<div class="track ${isPl ? 'playing' : ''} ${isSel ? 'selected' : ''}" data-play="${t.id}">
          ${leading}
          <div class="meta"><div class="title">${eq}${escapeHtml(t.title)}</div></div>
          <span class="dur">${t.duration ? fmtTime(t.duration) : '--:--'}</span>
          ${actionBtn}
        </div>`;
      }).join('') + `</div>`;
    }

    const newPlaylistForm = creatingPlaylist ? `
      <div class="new-playlist-form">
        <input id="newPlName" placeholder="Playlist name" autofocus />
        <button class="btn btn-primary" id="confirmNewPl">Create</button>
      </div>` : '';

    const searchSortRow = library.length ? `
      <div class="search-sort-row">
        <input type="search" id="searchInput" class="search-input" placeholder="Search titles…" value="${escapeHtml(searchQuery)}" />
        <select id="sortSelect" class="sort-select" title="Sort by">
          <option value="added" ${sortMode === 'added' ? 'selected' : ''}>Recently added</option>
          <option value="alpha" ${sortMode === 'alpha' ? 'selected' : ''}>Title (A–Z)</option>
          <option value="duration" ${sortMode === 'duration' ? 'selected' : ''}>Duration</option>
        </select>
      </div>` : '';

    let toolbarRow;
    if (selectMode) {
      const allVisibleSelected = list.length > 0 && list.every((t) => selectedIds.has(t.id));
      const addAction = (activeView === 'library' && Object.keys(playlists).length)
        ? `<button class="btn btn-ghost sm" id="bulkAddBtn">＋ Add to playlist</button>` : '';
      const removeAction = activeView !== 'library'
        ? `<button class="btn btn-ghost sm" id="bulkRemoveBtn">✕ Remove from playlist</button>` : '';
      const deleteAction = activeView === 'library'
        ? `<button class="btn btn-ghost sm danger" id="bulkDeleteBtn">🗑 Delete</button>` : '';
      toolbarRow = `
        <div class="bulk-bar">
          <span class="bulk-count">${selectedIds.size} selected</span>
          <button class="btn btn-ghost sm" id="selectAllBtn">${allVisibleSelected ? 'Deselect all' : 'Select all'}</button>
          ${addAction}${removeAction}${deleteAction}
          <button class="btn btn-ghost sm" id="cancelSelectBtn">Cancel</button>
        </div>`;
    } else {
      toolbarRow = `
        <div class="toolbar-row">
          <button class="btn btn-ghost sm" id="loadMoreBtn">+ Add more files</button>
          <button class="btn btn-ghost sm" id="loadFolderBtn">+ Add folder</button>
          <button class="btn btn-ghost sm" id="selectModeBtn">☑ Select</button>
          <button class="btn btn-ghost sm" id="exportBtn">↓ Export library</button>
          <button class="btn btn-ghost sm" id="importBtn">↑ Import library</button>
        </div>`;
    }

    const header = library.length ? `
      <div class="tabs">${tabsHtml}</div>
      ${newPlaylistForm}
      <div class="section-label">${activeView === 'library' ? 'Your library' : escapeHtml(activeView)}</div>
      ${searchSortRow}
      ${toolbarRow}
    ` : '';

    content.innerHTML = header + listHtml;

    document.getElementById('loadBtn')?.addEventListener('click', triggerFilePicker);
    document.getElementById('loadMoreBtn')?.addEventListener('click', triggerFilePicker);
    document.getElementById('loadFolderBtn')?.addEventListener('click', triggerFolderPicker);
    document.getElementById('loadFolderBtnEmpty')?.addEventListener('click', triggerFolderPicker);
    document.getElementById('exportBtn')?.addEventListener('click', exportLibrary);
    document.getElementById('importBtn')?.addEventListener('click', triggerImportPicker);
    document.getElementById('importBtnEmpty')?.addEventListener('click', triggerImportPicker);
    document.getElementById('newPlaylistTab')?.addEventListener('click', () => {
      creatingPlaylist = true; render();
      setTimeout(() => document.getElementById('newPlName')?.focus(), 0);
    });
    document.getElementById('confirmNewPl')?.addEventListener('click', () => {
      createPlaylist(document.getElementById('newPlName').value);
    });
    document.getElementById('newPlName')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') createPlaylist(e.target.value);
    });
    document.getElementById('searchInput')?.addEventListener('input', (e) => {
      searchQuery = e.target.value; render();
    });
    document.getElementById('sortSelect')?.addEventListener('change', (e) => {
      sortMode = e.target.value; render();
    });
    document.getElementById('selectModeBtn')?.addEventListener('click', () => {
      selectMode = true; selectedIds.clear(); render();
    });
    document.getElementById('cancelSelectBtn')?.addEventListener('click', () => {
      selectMode = false; selectedIds.clear(); render();
    });
    document.getElementById('selectAllBtn')?.addEventListener('click', selectAllVisible);
    document.getElementById('bulkAddBtn')?.addEventListener('click', bulkAddToPlaylist);
    document.getElementById('bulkRemoveBtn')?.addEventListener('click', bulkRemoveFromPlaylist);
    document.getElementById('bulkDeleteBtn')?.addEventListener('click', bulkDelete);

    content.querySelectorAll('[data-view]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-del-playlist]')) return;
        activeView = el.dataset.view; creatingPlaylist = false; selectMode = false; selectedIds.clear(); render();
      });
    });
    content.querySelectorAll('[data-del-playlist]').forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); deletePlaylist(el.dataset.delPlaylist); });
    });
    content.querySelectorAll('[data-play]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-add],[data-remove-from],[data-delete],[data-rename]')) return;
        if (selectMode) { toggleSelect(el.dataset.play); return; }
        playTrack(el.dataset.play);
      });
    });
    content.querySelectorAll('[data-add]').forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); showAddMenu(el.dataset.add); });
    });
    content.querySelectorAll('[data-remove-from]').forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); removeFromPlaylist(el.dataset.removeFrom, activeView); });
    });
    content.querySelectorAll('[data-rename]').forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); renameTrack(el.dataset.rename); });
    });
    content.querySelectorAll('[data-delete]').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        const track = getTrackById(el.dataset.delete);
        const label = track ? track.title : 'this track';
        if (confirm('Delete "' + label + '" from your library? This removes the file from this device.')) {
          removeTrack(el.dataset.delete);
        }
      });
    });

    if (searchFocused) {
      const si = document.getElementById('searchInput');
      if (si) { si.focus(); si.setSelectionRange(searchSel, searchSel); }
    }

    renderNowPlaying();
    syncBrandMark();
  }

  function showAddMenu(trackId) {
    const names = Object.keys(playlists);
    if (!names.length) return;
    const choice = names.length === 1 ? names[0] : prompt('Add to which playlist?\n' + names.join(', '));
    if (choice && playlists[choice]) addToPlaylist(trackId, choice);
  }

  function triggerFilePicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = 'audio/*';
    input.addEventListener('change', (e) => loadFiles(e.target.files));
    input.click();
  }

  function triggerFolderPicker() {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.webkitdirectory = true; // recursive folder picker (Chrome/Edge/Safari; Firefox falls back to normal picker)
    input.addEventListener('change', (e) => loadFiles(e.target.files));
    input.click();
  }

  let npEl = null;
  function renderNowPlaying() {
    const track = currentId ? getTrackById(currentId) : null;
    if (!npEl) {
      npEl = document.createElement('div');
      npEl.className = 'now-playing';
      document.body.appendChild(npEl);
    }
    if (!track) { npEl.style.display = 'none'; return; }
    npEl.style.display = 'block';

    npEl.innerHTML = `
      <div class="np-inner">
        <div class="np-header">
          ${track.artUrl
            ? `<img class="np-art" src="${track.artUrl}" alt="" />`
            : `<span class="np-art np-art-mono" style="background:${monoColor(track.title)}">${monoLetter(track.title)}</span>`}
          <div class="np-track">${escapeHtml(track.title)}</div>
        </div>
        <div class="np-progress">
          <span class="np-time" id="curTime">${fmtTime(audio.currentTime)}</span>
          <input type="range" id="seek" min="0" max="${track.duration || 0}" value="${audio.currentTime || 0}" step="0.1"/>
          <span class="np-time end">${track.duration ? fmtTime(track.duration) : '--:--'}</span>
        </div>
        <div class="np-controls">
          <button class="toggle ${shuffle ? 'on' : ''}" id="shuffleBtn" title="Shuffle">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 4h4l7 16h5M4 20h4l3.5-8M17 4h4v4M17 20h4v-4"/></svg>
          </button>
          <button id="prevBtn"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM20 6L10 12l10 6z"/></svg></button>
          <button class="play-btn" id="playBtn"><span id="playBtnIcon">${isPlaying ? iconPause() : iconPlay()}</span></button>
          <button id="nextBtn"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM4 6l10 6L4 18z"/></svg></button>
          <button class="toggle ${repeatMode !== 'off' ? 'on' : ''}" id="repeatBtn" title="Repeat">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17 2l4 4-4 4M3 11V9a4 4 0 014-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 01-4 4H3"/>${repeatMode === 'one' ? '<text x="9" y="15.5" font-size="7" fill="currentColor" stroke="none">1</text>' : ''}</svg>
          </button>
        </div>
      </div>`;

    const seek = document.getElementById('seek');
    seek.addEventListener('input', () => { seek.dragging = true; document.getElementById('curTime').textContent = fmtTime(seek.value); });
    seek.addEventListener('change', () => { audio.currentTime = parseFloat(seek.value); seek.dragging = false; });

    document.getElementById('playBtn').addEventListener('click', togglePlay);
    document.getElementById('prevBtn').addEventListener('click', prevTrack);
    document.getElementById('nextBtn').addEventListener('click', () => nextTrack(false));
    document.getElementById('shuffleBtn').addEventListener('click', toggleShuffle);
    document.getElementById('repeatBtn').addEventListener('click', cycleRepeat);
  }

  // ---------- Install prompt ----------

  let deferredInstallPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const btn = document.getElementById('installBtn');
    if (btn) btn.style.display = 'inline-block';
  });
  document.getElementById('installBtn')?.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    document.getElementById('installBtn').style.display = 'none';
  });

  // ---------- Service worker ----------

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js').catch(() => {});
    });
  }

  bootstrap();
})();
