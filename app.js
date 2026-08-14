(function () {
  const audio = document.getElementById('audio');
  const content = document.getElementById('content');
  const fileCount = document.getElementById('fileCount');
  const toastEl = document.getElementById('toast');

  // State
  let library = [];          // {id, name, blob, url, title, duration}
  let playlists = {};         // name -> array of track ids
  let activeView = 'library'; // 'library' or playlist name
  let currentId = null;
  let isPlaying = false;
  let shuffle = false;
  let repeatMode = 'off';     // off | all | one
  let shuffleOrder = [];
  let creatingPlaylist = false;

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
    if (activeView === 'library') return library;
    const ids = playlists[activeView] || [];
    return ids.map((id) => library.find((t) => t.id === id)).filter(Boolean);
  }

  function getTrackById(id) {
    return library.find((t) => t.id === id);
  }

  // ---------- Loading & persistence ----------

  async function bootstrap() {
    const stored = await DB.getAllTracks();
    stored.forEach((t) => {
      t.url = URL.createObjectURL(t.blob);
      library.push(t);
    });
    const storedPlaylists = await DB.getAllPlaylists();
    storedPlaylists.forEach((p) => { playlists[p.name] = p.trackIds; });

    updateFileCount();
    render();
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
    const track = { id, name: filename, blob, url, title, duration: null };
    library.push(track);
    await DB.addTrack({ id, name: filename, blob, title, duration: null });

    const probe = new Audio(url);
    probe.addEventListener('loadedmetadata', () => {
      track.duration = probe.duration;
      DB.updateTrack({ id, name: filename, blob, title, duration: probe.duration });
      render();
    });
    return track;
  }

  async function removeTrack(id) {
    const track = getTrackById(id);
    library = library.filter((t) => t.id !== id);
    Object.keys(playlists).forEach((name) => {
      playlists[name] = playlists[name].filter((tid) => tid !== id);
      DB.savePlaylist(name, playlists[name]);
    });
    await DB.deleteTrack(id);
    if (track) URL.revokeObjectURL(track.url); // bug fix: avoid leaking blob URLs
    if (currentId === id) { audio.pause(); audio.removeAttribute('src'); currentId = null; isPlaying = false; }
    updateFileCount();
    render();
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
        mime: t.blob.type || 'audio/mpeg', size: t.blob.size, duration: t.duration
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
        library.push({ id: newId, name: t.name, blob, url, title: t.title, duration: t.duration });
        await DB.addTrack({ id: newId, name: t.name, blob, title: t.title, duration: t.duration });
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

  // ---------- Discover: free, legally-downloadable music (Internet Archive) ----------
  //
  // Searches archive.org's public Advanced Search API, scoped to audio that's
  // either explicitly licensed (licenseurl set — usually Creative Commons) or
  // in collections the Archive publishes specifically for free reuse
  // (netlabels, and the Live Music Archive for bands that allow taping/sharing).
  // No API key, no server of ours involved — this talks to archive.org directly
  // from your browser, so it needs an internet connection.

  const IA_SEARCH = 'https://archive.org/advancedsearch.php';
  const IA_METADATA = 'https://archive.org/metadata/';
  const IA_DOWNLOAD = 'https://archive.org/download/';
  const IA_THUMB = 'https://archive.org/services/img/';

  let discoverOpen = false;
  let discoverQuery = '';
  let discoverLoading = false;
  let discoverError = '';
  let discoverResults = [];      // [{identifier, title, creator, licenseurl}]
  let discoverItem = null;        // identifier of item whose files are shown, or null
  let discoverItemTitle = '';
  let discoverFiles = [];         // [{name, title, size}]
  let discoverFilesLoading = false;
  let downloadingKeys = new Set(); // file identifiers currently downloading

  function licenseLabel(url) {
    if (!url) return null;
    if (/publicdomain/i.test(url)) return 'Public domain';
    const m = url.match(/creativecommons\.org\/(licenses|publicdomain)\/([a-z-]+)\/?([\d.]+)?/i);
    if (m) {
      if (m[1] === 'publicdomain') return 'Public domain';
      return 'CC ' + m[2].toUpperCase() + (m[3] ? ' ' + m[3] : '');
    }
    return 'See license';
  }

  async function searchArchive(query) {
    discoverQuery = query;
    discoverLoading = true;
    discoverError = '';
    discoverResults = [];
    discoverItem = null;
    renderDiscover();

    try {
      const q = `(${query.replace(/"/g, '')}) AND mediatype:(audio) AND (collection:(netlabels) OR collection:(etree) OR licenseurl:*)`;
      const params = new URLSearchParams({
        q,
        'fl[]': 'identifier,title,creator,licenseurl',
        rows: '24',
        output: 'json'
      });
      const res = await fetch(IA_SEARCH + '?' + params.toString());
      if (!res.ok) throw new Error('search failed: ' + res.status);
      const data = await res.json();
      discoverResults = (data.response && data.response.docs) || [];
    } catch (err) {
      console.error('Archive search failed:', err);
      discoverError = navigator.onLine === false
        ? "You're offline — free-music search needs a connection."
        : 'Search failed. Try again in a moment.';
    } finally {
      discoverLoading = false;
      renderDiscover();
    }
  }

  async function openDiscoverItem(identifier, title) {
    discoverItem = identifier;
    discoverItemTitle = title;
    discoverFiles = [];
    discoverFilesLoading = true;
    discoverError = '';
    renderDiscover();

    try {
      const res = await fetch(IA_METADATA + encodeURIComponent(identifier));
      if (!res.ok) throw new Error('metadata failed: ' + res.status);
      const data = await res.json();
      discoverFiles = (data.files || [])
        .filter((f) => /mp3/i.test(f.format || '') || /\.mp3$/i.test(f.name || ''))
        .map((f) => ({
          name: f.name,
          title: (f.title || f.name.replace(/\.[^/.]+$/, '')),
          size: f.size ? Number(f.size) : null
        }));
      if (!discoverFiles.length) discoverError = 'No mp3 files found for this item.';
    } catch (err) {
      console.error('Archive metadata failed:', err);
      discoverError = navigator.onLine === false
        ? "You're offline — free-music search needs a connection."
        : 'Could not load this item. Try again.';
    } finally {
      discoverFilesLoading = false;
      renderDiscover();
    }
  }

  async function downloadArchiveFile(file) {
    const key = discoverItem + '/' + file.name;
    if (downloadingKeys.has(key)) return;
    downloadingKeys.add(key);
    renderDiscover();

    try {
      const url = IA_DOWNLOAD + encodeURIComponent(discoverItem) + '/' + encodeURIComponent(file.name);
      const res = await fetch(url);
      if (!res.ok) throw new Error('download failed: ' + res.status);
      const blob = await res.blob();
      const filename = /\.mp3$/i.test(file.name) ? file.name : file.title + '.mp3';
      await ingestBlob(blob, filename);
      updateFileCount();
      showToast('Added "' + file.title + '" to your library');
    } catch (err) {
      console.error('Archive download failed:', err);
      showToast('Download failed — try again');
    } finally {
      downloadingKeys.delete(key);
      renderDiscover();
      render();
    }
  }

  function openDiscover() {
    discoverOpen = true;
    discoverQuery = '';
    discoverResults = [];
    discoverItem = null;
    discoverError = '';
    renderDiscover();
    setTimeout(() => document.getElementById('discoverSearchInput')?.focus(), 30);
  }

  function closeDiscover() {
    discoverOpen = false;
    renderDiscover();
  }

  function fmtSize(bytes) {
    if (!bytes) return '';
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? mb.toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
  }

  let discoverEl = null;
  function renderDiscover() {
    if (!discoverEl) {
      discoverEl = document.createElement('div');
      discoverEl.className = 'discover-overlay';
      document.body.appendChild(discoverEl);
    }
    if (!discoverOpen) { discoverEl.style.display = 'none'; discoverEl.innerHTML = ''; return; }
    discoverEl.style.display = 'flex';

    let body;
    if (discoverItem) {
      // File list view for one item
      body = `
        <div class="discover-backrow">
          <button class="icon-btn" id="discoverBack" title="Back to results">←</button>
          <div class="discover-item-title">${escapeHtml(discoverItemTitle)}</div>
        </div>
        ${discoverFilesLoading ? '<div class="discover-status">Loading tracks…</div>' : ''}
        ${discoverError ? `<div class="discover-status error">${escapeHtml(discoverError)}</div>` : ''}
        ${discoverFiles.length ? `<div class="tracklist">` + discoverFiles.map((f) => {
          const key = discoverItem + '/' + f.name;
          const busy = downloadingKeys.has(key);
          return `<div class="track">
            <span class="mono" style="background:${monoColor(f.title)}">${monoLetter(f.title)}</span>
            <div class="meta"><div class="title">${escapeHtml(f.title)}</div></div>
            <span class="dur">${fmtSize(f.size)}</span>
            <button class="icon-btn" data-dl="${encodeURIComponent(f.name)}" ${busy ? 'disabled' : ''} title="Add to library">${busy ? '…' : '⬇'}</button>
          </div>`;
        }).join('') + `</div>` : ''}
      `;
    } else {
      // Search + results grid
      body = `
        <form id="discoverSearchForm" class="discover-search-row">
          <input id="discoverSearchInput" placeholder="Search free & Creative Commons music…" value="${escapeHtml(discoverQuery)}" />
          <button class="btn btn-primary sm" type="submit">Search</button>
        </form>
        <p class="discover-hint">From Internet Archive's open audio collections — public domain, Creative Commons, and live recordings artists allow sharing. Always shown with its license.</p>
        ${discoverLoading ? '<div class="discover-status">Searching…</div>' : ''}
        ${discoverError ? `<div class="discover-status error">${escapeHtml(discoverError)}</div>` : ''}
        ${(!discoverLoading && discoverQuery && !discoverError && discoverResults.length === 0) ? '<div class="discover-status">No results. Try a different search.</div>' : ''}
        <div class="discover-grid">
          ${discoverResults.map((r) => {
            const lic = licenseLabel(r.licenseurl);
            return `<div class="discover-card" data-open="${escapeHtml(r.identifier)}" data-title="${escapeHtml(r.title || r.identifier)}">
              <img class="discover-thumb" src="${IA_THUMB}${encodeURIComponent(r.identifier)}" loading="lazy" onerror="this.style.opacity=0" />
              <div class="discover-card-title">${escapeHtml(r.title || r.identifier)}</div>
              ${r.creator ? `<div class="discover-card-sub">${escapeHtml(Array.isArray(r.creator) ? r.creator[0] : r.creator)}</div>` : ''}
              ${lic ? `<span class="discover-badge">${escapeHtml(lic)}</span>` : ''}
            </div>`;
          }).join('')}
        </div>
      `;
    }

    discoverEl.innerHTML = `
      <div class="discover-panel">
        <div class="discover-header">
          <span class="discover-heading">Get free music</span>
          <button class="icon-btn" id="discoverClose" title="Close">✕</button>
        </div>
        <div class="discover-body">${body}</div>
      </div>
    `;

    document.getElementById('discoverClose')?.addEventListener('click', closeDiscover);
    document.getElementById('discoverBack')?.addEventListener('click', () => {
      discoverItem = null; discoverError = ''; renderDiscover();
    });
    document.getElementById('discoverSearchForm')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const val = document.getElementById('discoverSearchInput').value.trim();
      if (val) searchArchive(val);
    });
    discoverEl.querySelectorAll('[data-open]').forEach((el) => {
      el.addEventListener('click', () => openDiscoverItem(el.dataset.open, el.dataset.title));
    });
    discoverEl.querySelectorAll('[data-dl]').forEach((el) => {
      el.addEventListener('click', () => {
        const name = decodeURIComponent(el.dataset.dl);
        const file = discoverFiles.find((f) => f.name === name);
        if (file) downloadArchiveFile(file);
      });
    });
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

  // ---------- Media Session (lock screen controls) ----------

  function updateMediaSession(track) {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title,
        artist: 'Your library',
        album: activeView === 'library' ? 'Library' : activeView
      });
      navigator.mediaSession.setActionHandler('play', () => { audio.play(); isPlaying = true; render(); });
      navigator.mediaSession.setActionHandler('pause', () => { audio.pause(); isPlaying = false; render(); });
      navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
      navigator.mediaSession.setActionHandler('nexttrack', () => nextTrack(false));
    }
  }

  audio.addEventListener('ended', () => nextTrack(true));
  audio.addEventListener('timeupdate', renderProgressOnly);
  audio.addEventListener('play', () => { isPlaying = true; renderControlsOnly(); });
  audio.addEventListener('pause', () => { isPlaying = false; renderControlsOnly(); });

  function renderProgressOnly() {
    const bar = document.getElementById('seek');
    const cur = document.getElementById('curTime');
    if (bar && !bar.dragging) bar.value = audio.currentTime || 0;
    if (cur) cur.textContent = fmtTime(audio.currentTime);
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
            <button class="btn btn-ghost" id="discoverBtnEmpty">Get free music</button>
            <button class="btn btn-ghost" id="importBtnEmpty">Import library file</button>
          </div>
        </div>`;
    } else if (list.length === 0) {
      listHtml = `<div class="tracklist"><div class="empty-list">No tracks in "${escapeHtml(activeView)}" yet. Add some from your Library.</div></div>`;
    } else {
      listHtml = `<div class="tracklist">` + list.map((t, i) => {
        const isPl = t.id === currentId;
        let actionBtn = '';
        if (activeView === 'library') {
          if (Object.keys(playlists).length) {
            actionBtn = `<button class="icon-btn" data-add="${t.id}" title="Add to playlist">＋</button>`;
          }
        } else {
          actionBtn = `<button class="icon-btn" data-remove-from="${t.id}" title="Remove from playlist">✕</button>`;
        }
        const eq = (isPl && isPlaying) ? '<span class="eq"><span></span><span></span><span></span></span>' : '';
        return `<div class="track ${isPl ? 'playing' : ''}" data-play="${t.id}">
          <span class="mono" style="background:${monoColor(t.title)}">${monoLetter(t.title)}</span>
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

    const header = library.length ? `
      <div class="tabs">${tabsHtml}</div>
      ${newPlaylistForm}
      <div class="section-label">${activeView === 'library' ? 'Your library' : escapeHtml(activeView)}</div>
      <div class="toolbar-row">
        <button class="btn btn-ghost sm" id="loadMoreBtn">+ Add more files</button>
        <button class="btn btn-ghost sm" id="discoverBtn">♫ Get free music</button>
        <button class="btn btn-ghost sm" id="exportBtn">↓ Export library</button>
        <button class="btn btn-ghost sm" id="importBtn">↑ Import library</button>
      </div>
    ` : '';

    content.innerHTML = header + listHtml;

    document.getElementById('loadBtn')?.addEventListener('click', triggerFilePicker);
    document.getElementById('loadMoreBtn')?.addEventListener('click', triggerFilePicker);
    document.getElementById('discoverBtn')?.addEventListener('click', openDiscover);
    document.getElementById('discoverBtnEmpty')?.addEventListener('click', openDiscover);
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

    content.querySelectorAll('[data-view]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-del-playlist]')) return;
        activeView = el.dataset.view; creatingPlaylist = false; render();
      });
    });
    content.querySelectorAll('[data-del-playlist]').forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); deletePlaylist(el.dataset.delPlaylist); });
    });
    content.querySelectorAll('[data-play]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-add],[data-remove-from]')) return;
        playTrack(el.dataset.play);
      });
    });
    content.querySelectorAll('[data-add]').forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); showAddMenu(el.dataset.add); });
    });
    content.querySelectorAll('[data-remove-from]').forEach((el) => {
      el.addEventListener('click', (e) => { e.stopPropagation(); removeFromPlaylist(el.dataset.removeFrom, activeView); });
    });

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
        <div class="np-track">${escapeHtml(track.title)}</div>
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
