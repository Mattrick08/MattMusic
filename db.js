// db.js — tiny IndexedDB wrapper.
// "tracks" store holds the actual audio file blobs, so your library
// survives offline / after closing the app. "playlists" store holds
// named arrays of track ids.

const DB_NAME = 'mattmusic-db';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('tracks')) {
        db.createObjectStore('tracks', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('playlists')) {
        db.createObjectStore('playlists', { keyPath: 'name' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const DB = {
  async addTrack(track) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('tracks', 'readwrite');
      tx.objectStore('tracks').put(track);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async getAllTracks() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('tracks', 'readonly');
      const req = tx.objectStore('tracks').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async updateTrack(track) {
    return this.addTrack(track); // put() upserts
  },

  async deleteTrack(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('tracks', 'readwrite');
      tx.objectStore('tracks').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async savePlaylist(name, trackIds) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('playlists', 'readwrite');
      tx.objectStore('playlists').put({ name, trackIds });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async deletePlaylist(name) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('playlists', 'readwrite');
      tx.objectStore('playlists').delete(name);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async getAllPlaylists() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('playlists', 'readonly');
      const req = tx.objectStore('playlists').getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }
};
