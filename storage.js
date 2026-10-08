/* ============================================================
   MindFocus — Almacenamiento (storage.js)
   ------------------------------------------------------------
   IndexedDB (cientos de MB) con aislamiento por usuario:
   - profiles  → mapa de credenciales { user → { passwordHash, passwordSalt } }
   - user:NAME → store de ese usuario (exámenes, progreso, config sin secretos)
   Migración automática desde el store único antiguo ('store' / studymate_v2).
   ============================================================ */

const SMStorage = (() => {
  'use strict';

  const DB_NAME = 'mindfocus';
  const DB_VERSION = 1;
  const OS = 'kv';
  const KEY_LEGACY_STORE = 'store';       // store único de versiones anteriores
  const KEY_PROFILES = 'profiles';
  const LEGACY_LS = 'studymate_v2';
  const DEBOUNCE_MS = 250;

  let dbPromise = null;
  let mode = 'idb';             // 'idb' | 'local'
  let activeUser = '';          // usuario cuyo store se está guardando
  let pending = null;
  let timer = null;
  let queue = Promise.resolve();
  let onError = () => {};

  function userKey(username) {
    return 'user:' + String(username || '').trim().toLowerCase();
  }

  function localKey(username) {
    return LEGACY_LS + '::' + String(username || '').trim().toLowerCase();
  }

  /* ---------- IndexedDB básico ---------- */

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB no disponible'));
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { return reject(e); }
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(OS)) req.result.createObjectStore(OS);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB bloqueada por otra pestaña'));
    });
    return dbPromise;
  }

  function idbGet(key) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const req = db.transaction(OS, 'readonly').objectStore(OS).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  function idbPut(key, value) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(OS, 'readwrite');
      tx.objectStore(OS).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transacción abortada'));
    }));
  }

  function idbDelete(key) {
    return openDB().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(OS, 'readwrite');
      tx.objectStore(OS).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }));
  }

  /* ---------- localStorage respaldo ---------- */

  function readLegacyLS() {
    try {
      const raw = localStorage.getItem(LEGACY_LS);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn('No pude leer localStorage', e);
      return null;
    }
  }

  const looksValid = d => d && typeof d === 'object' && Array.isArray(d.exams);

  function normalizeProfiles(raw) {
    if (!raw || typeof raw !== 'object') return {};
    const out = {};
    Object.keys(raw).forEach(k => {
      const u = String(k || '').trim();
      if (!u) return;
      const p = raw[k];
      if (p && p.passwordHash && p.passwordSalt) {
        out[u] = { passwordHash: String(p.passwordHash), passwordSalt: String(p.passwordSalt) };
      }
    });
    return out;
  }

  /* ---------- API pública ---------- */

  async function loadProfiles() {
    try {
      if (mode === 'local') {
        try {
          const raw = localStorage.getItem(LEGACY_LS + '::profiles');
          return normalizeProfiles(raw ? JSON.parse(raw) : {});
        } catch (_) { return {}; }
      }
      return normalizeProfiles(await idbGet(KEY_PROFILES));
    } catch (e) {
      console.warn('No pude cargar perfiles', e);
      return {};
    }
  }

  async function saveProfiles(profiles) {
    const data = normalizeProfiles(profiles);
    if (mode === 'local') {
      try { localStorage.setItem(LEGACY_LS + '::profiles', JSON.stringify(data)); }
      catch (e) { onError(e); }
      return;
    }
    queue = queue.then(() => idbPut(KEY_PROFILES, data)).catch(e => { console.warn('Error guardando perfiles', e); onError(e); });
    return queue;
  }

  /**
   * Migra el store único antiguo a user:NAME + profiles.
   * Devuelve { data, username } si había datos migrables.
   */
  async function migrateLegacyIfNeeded() {
    let legacy = null;
    try { legacy = await idbGet(KEY_LEGACY_STORE); } catch (_) { /* ignorar */ }
    if (!looksValid(legacy)) {
      const ls = readLegacyLS();
      if (looksValid(ls)) legacy = ls;
    }
    if (!looksValid(legacy)) return null;

    const username = String((legacy.config && (legacy.config.username || legacy.config.nick)) || '').trim();
    if (!username) {
      // Datos sin usuario: se dejan para que el primer registro los tome si hace falta
      return { data: legacy, username: '', orphan: true };
    }

    const profiles = await loadProfiles();
    if (!profiles[username] && legacy.config && legacy.config.passwordHash && legacy.config.passwordSalt) {
      profiles[username] = {
        passwordHash: legacy.config.passwordHash,
        passwordSalt: legacy.config.passwordSalt
      };
      await saveProfiles(profiles);
    }

    // Guardar bajo user:NAME si todavía no existe
    const existing = await idbGet(userKey(username)).catch(() => null);
    if (!looksValid(existing)) {
      await idbPut(userKey(username), legacy);
    }

    // Borrar clave global antigua (ya migrada)
    try { await idbDelete(KEY_LEGACY_STORE); } catch (_) { /* ignorar */ }
    try { localStorage.removeItem(LEGACY_LS); } catch (_) { /* ignorar */ }

    return { data: legacy, username, orphan: false };
  }

  /**
   * Carga el store de un usuario. Devuelve { data, source, profiles }.
   * Si no se pasa username, solo migra y devuelve perfiles (data null).
   */
  async function load(username) {
    try {
      await migrateLegacyIfNeeded();
      const profiles = await loadProfiles();

      if (!username) {
        return { data: null, source: 'empty', profiles };
      }

      const key = userKey(username);
      let saved = await idbGet(key);
      if (looksValid(saved)) {
        activeUser = username;
        return { data: saved, source: 'idb', profiles };
      }

      // Fallback localStorage por usuario
      if (mode === 'local') {
        try {
          const raw = localStorage.getItem(localKey(username));
          const parsed = raw ? JSON.parse(raw) : null;
          if (looksValid(parsed)) {
            activeUser = username;
            return { data: parsed, source: 'localStorage', profiles };
          }
        } catch (_) { /* ignorar */ }
      }

      activeUser = username;
      return { data: null, source: 'empty', profiles };
    } catch (e) {
      console.warn('IndexedDB no disponible, uso localStorage', e);
      mode = 'local';
      const profiles = await loadProfiles();
      if (!username) return { data: null, source: 'empty', profiles };
      try {
        const raw = localStorage.getItem(localKey(username));
        const parsed = raw ? JSON.parse(raw) : null;
        activeUser = username;
        return { data: looksValid(parsed) ? parsed : null, source: parsed ? 'localStorage' : 'empty', profiles };
      } catch (_) {
        return { data: null, source: 'empty', profiles };
      }
    }
  }

  function writeNow(data) {
    if (!activeUser) {
      console.warn('SMStorage.save sin usuario activo: no se guarda');
      return Promise.resolve();
    }
    if (mode === 'local') {
      try { localStorage.setItem(localKey(activeUser), JSON.stringify(data)); }
      catch (e) { onError(e); }
      return Promise.resolve();
    }
    const key = userKey(activeUser);
    queue = queue.then(() => idbPut(key, data)).catch(e => { console.warn('Error guardando', e); onError(e); });
    return queue;
  }

  function snapshot(data) {
    try {
      if (typeof structuredClone === 'function') return structuredClone(data);
    } catch (_) {}
    return JSON.parse(JSON.stringify(data));
  }

  /** Guarda en segundo plano el store del usuario activo. */
  function save(data) {
    if (!activeUser) return;
    pending = snapshot(data);
    clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE_MS);
  }

  function flush() {
    clearTimeout(timer);
    if (!pending) return queue;
    const data = pending;
    pending = null;
    return writeNow(data);
  }

  function setActiveUser(username) {
    activeUser = String(username || '').trim();
  }

  /** Borra solo el usuario indicado (datos + credencial). */
  async function clearUser(username) {
    clearTimeout(timer);
    pending = null;
    const u = String(username || '').trim();
    if (!u) return;

    const profiles = await loadProfiles();
    delete profiles[u];
    // También borrar variante por minúsculas si difiere
    Object.keys(profiles).forEach(k => {
      if (k.toLowerCase() === u.toLowerCase()) delete profiles[k];
    });
    await saveProfiles(profiles);

    if (mode === 'local') {
      try { localStorage.removeItem(localKey(u)); } catch (_) { /* ignorar */ }
      return;
    }
    queue = queue.then(() => idbDelete(userKey(u))).catch(e => console.warn('Error borrando usuario', e));
    if (activeUser && activeUser.toLowerCase() === u.toLowerCase()) activeUser = '';
    return queue;
  }

  /** Borra TODO (todos los usuarios + perfiles + legado). */
  async function clear() {
    clearTimeout(timer);
    pending = null;
    activeUser = '';
    try {
      localStorage.removeItem(LEGACY_LS);
      // Limpiar claves locales por usuario
      const toRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k === LEGACY_LS + '::profiles' || k.startsWith(LEGACY_LS + '::'))) toRemove.push(k);
      }
      toRemove.forEach(k => { try { localStorage.removeItem(k); } catch (_) {} });
    } catch (_) { /* ignorar */ }

    if (mode === 'local') return Promise.resolve();

    queue = queue.then(async () => {
      const profiles = normalizeProfiles(await idbGet(KEY_PROFILES).catch(() => ({})));
      const names = Object.keys(profiles);
      for (const n of names) {
        try { await idbDelete(userKey(n)); } catch (_) {}
      }
      try { await idbDelete(KEY_PROFILES); } catch (_) {}
      try { await idbDelete(KEY_LEGACY_STORE); } catch (_) {}
    }).catch(e => console.warn('Error borrando todo', e));
    return queue;
  }

  async function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        if (await navigator.storage.persisted()) return true;
        return await navigator.storage.persist();
      }
    } catch (_) { /* ignorar */ }
    return false;
  }

  async function estimate() {
    const out = { mode, usage: null, quota: null, persisted: false };
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const e = await navigator.storage.estimate();
        out.usage = e.usage; out.quota = e.quota;
      }
      if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted();
    } catch (_) { /* ignorar */ }
    return out;
  }

  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  return {
    load, save, flush, clear, clearUser, loadProfiles, saveProfiles, setActiveUser,
    requestPersistence, estimate,
    setErrorHandler: fn => { onError = fn || (() => {}); },
    get mode() { return mode; },
    get activeUser() { return activeUser; }
  };
})();
