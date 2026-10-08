/* ============================================================
   MindFocus — Salas de Estudio (rooms.js)
   ------------------------------------------------------------
   Chat colaborativo peer-to-peer con WebRTC, SIN servidor propio.

   · Trystero (carga perezosa desde CDN) usa trackers BitTorrent públicos
     solo para que los pares se encuentren (señalización). Después los datos
     viajan directo entre navegadores por canales WebRTC (cifrados con DTLS).
   · Nada se guarda en ningún servidor; el chat es efímero (solo en memoria).
   · Se comparte con script.js a través de `StudyRooms.init(api)`:
     así este archivo no toca el `store` directamente.

   Funciones:  chat · compartir mazos de tarjetas · Pomodoro grupal · QR/enlace.
   ============================================================ */

const StudyRooms = (() => {
  'use strict';

  /* ---------- Configuración ---------- */
  const APP_ID = 'mindfocus-p2p-v1';
  const TRYSTERO_VERSION = '0.21.8';   // versión fija: la API cambió entre versiones
  const LIB_URLS = [
    `https://esm.run/trystero@${TRYSTERO_VERSION}/torrent`,
    `https://esm.sh/trystero@${TRYSTERO_VERSION}/torrent`,
    `https://esm.run/trystero@${TRYSTERO_VERSION}`          // estrategia por defecto (Nostr) como último recurso
  ];
  const ROOM_RE = /^[A-Za-z0-9_-]{8,64}$/;
  const MAX_TEXT = 1000;          // caracteres por mensaje
  const MAX_NICK = 24;
  const MAX_MSGS_DOM = 250;       // mensajes visibles (los más viejos se descartan)
  const MAX_DECK_BYTES = 1.5 * 1024 * 1024;
  const MAX_CARDS = 1500;
  const MIN_SEND_GAP_MS = 400;    // anti-spam al enviar
  const CARD_TYPES = ['flashcard', 'qa', 'tf', 'mc'];

  let api = null;                 // funciones que inyecta script.js

  const st = {
    room: null, roomId: null, isHost: false, hostPeer: null,
    peers: new Map(),             // peerId → { nick }
    act: {},                      // acciones: hello, chat, deck, pomo
    syncTimer: true,
    unread: 0, lastSend: 0,
    libPromise: null,
    // Auth del anfitrión (ECDSA P-256): evita que un invitado se haga pasar por host
    hostKeyPair: null,            // CryptoKeyPair del creador
    hostPubJwk: null,             // JWK pública exportada (se envía en hello)
    hostKeyHash: null,            // sha-256 de la pública (va en el hash de la URL)
    expectedHostHash: null,       // lo que leyeron los invitados de #hk=
    hostPubKey: null              // CryptoKey pública verificada del anfitrión legítimo
  };

  const $ = id => document.getElementById(id);

  /* ============================================================
     Utilidades: sanitización y enlaces
     ============================================================ */

  /** Limpia texto de usuarios: sin < >, sin caracteres de control, con largo máximo. */
  function clean(s, max = 500) {
    return String(s ?? '')
      .replace(/[<>]/g, '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .replace(/"/g, '”')
      .trim()
      .slice(0, max);
  }
  const cleanNick = n => clean(n, MAX_NICK) || 'Anónimo';

  function genRoomId() {
    const b = crypto.getRandomValues(new Uint8Array(16));            // 128 bits de azar
    return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  const b64url = (buf) => {
    const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    let s = btoa(String.fromCharCode(...u8));
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const b64urlToBuf = (str) => {
    const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
    const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  };

  async function sha256b64url(data) {
    const enc = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    const dig = await crypto.subtle.digest('SHA-256', enc);
    return b64url(dig);
  }

  async function createHostKeys() {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']
    );
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const jwkStr = JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
    const hash = await sha256b64url(jwkStr);
    return { pair, jwk, jwkStr, hash };
  }

  async function importHostPub(jwk) {
    if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) return null;
    try {
      return await crypto.subtle.importKey(
        'jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y },
        { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']
      );
    } catch (_) { return null; }
  }

  async function signPayload(privateKey, obj) {
    const body = JSON.stringify(obj);
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      privateKey,
      new TextEncoder().encode(body)
    );
    return { body, sig: b64url(sig) };
  }

  async function verifyPayload(publicKey, obj, sigB64) {
    if (!publicKey || !sigB64) return false;
    try {
      const body = JSON.stringify(obj);
      return await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        b64urlToBuf(sigB64),
        new TextEncoder().encode(body)
      );
    } catch (_) { return false; }
  }

  const baseUrl = () => location.href.split(/[?#]/)[0];
  const inviteLink = (id, hostHash) => {
    const base = `${baseUrl()}?room=${encodeURIComponent(id)}`;
    return hostHash ? `${base}#hk=${encodeURIComponent(hostHash)}` : base;
  };

  /** Extrae el id de sala de un enlace completo o de un código suelto. */
  function parseRoomInput(text) {
    const t = String(text || '').trim();
    if (!t) return null;
    try {
      const u = new URL(t);
      const id = u.searchParams.get('room') || new URLSearchParams(u.hash.replace(/^#/, '')).get('room');
      return ROOM_RE.test(id || '') ? id : null;
    } catch (_) { /* no era una URL */ }
    return ROOM_RE.test(t) ? t : null;
  }

  /** Lee #hk= (hash de la clave pública del anfitrión) del texto o de la URL actual. */
  function parseHostHash(text) {
    try {
      const u = text ? new URL(text) : new URL(location.href);
      const fromHash = new URLSearchParams(u.hash.replace(/^#/, '')).get('hk');
      const fromQuery = u.searchParams.get('hk');
      const h = fromHash || fromQuery;
      return h && /^[A-Za-z0-9_-]{16,128}$/.test(h) ? h : null;
    } catch (_) {
      return null;
    }
  }

  /** Lee ?room= (o #room=) de la URL actual. */
  function readRoomParam() {
    const q = new URLSearchParams(location.search).get('room');
    const h = new URLSearchParams(location.hash.replace(/^#/, '')).get('room');
    const id = q || h;
    return ROOM_RE.test(id || '') ? id : null;
  }

  function readHostHashParam() {
    return parseHostHash(location.href);
  }

  /**
   * Valida y reconstruye un mazo recibido de OTRO usuario: solo se copian campos
   * conocidos, con tipos y largos controlados. Devuelve null si no sirve.
   * (Defensa clave: la app muestra materia/temas con innerHTML en varios lugares.)
   */
  function sanitizeDeck(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const topics = [];
    (Array.isArray(raw.topics) ? raw.topics.slice(0, 60) : []).forEach(t => {
      const name = clean(t && t.name, 120);
      if (!name) return;
      topics.push({
        ref: String(t.id ?? ''),
        name,
        difficulty: ['facil', 'medio', 'dificil'].includes(t.difficulty) ? t.difficulty : 'medio'
      });
    });
    if (!topics.length) return null;

    const cards = [];
    (Array.isArray(raw.cards) ? raw.cards.slice(0, MAX_CARDS) : []).forEach(c => {
      if (!c || !CARD_TYPES.includes(c.type)) return;
      const out = { type: c.type, topicRef: String(c.topicId ?? ''), explanation: clean(c.explanation, 600) };
      if (c.type === 'flashcard') {
        out.front = clean(c.front, 600); out.back = clean(c.back, 1200);
        if (!out.front || !out.back) return;
      } else if (c.type === 'qa') {
        out.question = clean(c.question, 600); out.answer = clean(c.answer, 1200);
        if (!out.question || !out.answer) return;
      } else if (c.type === 'tf') {
        out.statement = clean(c.statement, 600); out.correct = c.correct === true;
        if (!out.statement) return;
      } else if (c.type === 'mc') {
        out.question = clean(c.question, 600);
        out.options = (Array.isArray(c.options) ? c.options.slice(0, 6) : []).map(o => clean(o, 300));
        out.correctIndex = Number.isInteger(c.correctIndex) ? c.correctIndex : -1;
        if (!out.question || out.options.length < 2 || out.options.some(o => !o)
            || out.correctIndex < 0 || out.correctIndex >= out.options.length) return;
      }
      // La fuente solo puede ser "apuntes" o un enlace https válido
      out.source = { kind: 'apuntes' };
      if (c.source && c.source.kind === 'web' && typeof c.source.url === 'string') {
        try {
          const u = new URL(c.source.url);
          if (u.protocol === 'https:') out.source = { kind: 'web', title: clean(c.source.title, 120) || u.hostname, url: u.href };
        } catch (_) { /* URL inválida: queda como apuntes */ }
      }
      cards.push(out);
    });

    const num = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
    return {
      subject: clean(raw.subject, 80) || 'Materia',
      name: clean(raw.name, 120) || 'Examen compartido',
      date: /^\d{4}-\d{2}-\d{2}$/.test(raw.date || '') ? raw.date : '',
      time: /^\d{2}:\d{2}$/.test(raw.time || '') ? raw.time : '08:00',
      dailyMins: Math.round(num(raw.dailyMins, 10, 300, 60)),
      goal: num(raw.goal, 1, 10, 7),
      topics, cards
    };
  }

  /** Arma el mazo a compartir SIN datos personales (nada de progreso, repasos ni estadísticas). */
  function buildDeckPayload(exam) {
    return {
      subject: exam.subject, name: exam.name, date: exam.date, time: exam.time,
      dailyMins: exam.dailyMins, goal: exam.goal,
      topics: (exam.topics || []).map(t => ({ id: t.id, name: t.name, difficulty: t.difficulty })),
      cards: (exam.cards || []).map(c => ({
        type: c.type, topicId: c.topicId,
        front: c.front, back: c.back, question: c.question, answer: c.answer,
        statement: c.statement, correct: c.correct, explanation: c.explanation,
        options: c.options, correctIndex: c.correctIndex,
        source: c.source && c.source.kind === 'web' ? { kind: 'web', title: c.source.title, url: c.source.url } : { kind: 'apuntes' }
      }))
    };
  }

  /* ============================================================
     Carga de la librería WebRTC (solo cuando hace falta)
     ============================================================ */

  function loadLib() {
    if (!st.libPromise) {
      st.libPromise = (async () => {
        let lastErr;
        for (const url of LIB_URLS) {
          try {
            const mod = await import(url);
            if (typeof mod.joinRoom === 'function') return mod;
          } catch (e) { lastErr = e; }
        }
        st.libPromise = null;   // permitir reintento
        throw lastErr || new Error('No se pudo cargar Trystero');
      })();
    }
    return st.libPromise;
  }

  /** Trystero 0.21: makeAction(nombre) → [enviar, recibir]. Nombres de hasta 12 bytes. */
  function makeAct(room, name) {
    const [send, recv] = room.makeAction(name);
    return { send, on: fn => recv(fn) };
  }

  /* ============================================================
     Conexión
     ============================================================ */

  async function join(roomId, { host = false, hostHash = null } = {}) {
    if (!ROOM_RE.test(roomId || '')) { api.toast('Ese código de sala no es válido'); return; }
    if (st.room) leave(true);

    st.hostKeyPair = null; st.hostPubJwk = null; st.hostKeyHash = null;
    st.expectedHostHash = hostHash || null; st.hostPubKey = null;

    if (host) {
      try {
        const keys = await createHostKeys();
        st.hostKeyPair = keys.pair;
        st.hostPubJwk = keys.jwk;
        st.hostKeyHash = keys.hash;
        st.expectedHostHash = keys.hash;
      } catch (e) {
        console.warn('No se pudieron crear claves del anfitrión', e);
        api.toast('Tu navegador no soporta firmas criptográficas; la sala igual funciona, pero sin verificación de anfitrión');
      }
    }

    setStatus('Conectando con la red P2P…');
    let lib;
    try { lib = await loadLib(); }
    catch (e) {
      console.warn(e);
      setStatus('No pude cargar la librería P2P. Revisá tu conexión e intentá de nuevo.');
      api.toast('No se pudo conectar a la red P2P');
      return;
    }

    let room;
    try {
      room = lib.joinRoom({ appId: APP_ID }, roomId, d => console.warn('Error al unirse a la sala', d));
    } catch (e) {
      console.warn(e);
      setStatus('No pude entrar a la sala.');
      return;
    }

    st.room = room; st.roomId = roomId; st.isHost = host; st.hostPeer = null; st.peers.clear();
    $('chatMessages').textContent = '';   // chat nuevo para cada sala (los mensajes nunca se guardan)
    st.act = {
      hello: makeAct(room, 'hello'),
      chat:  makeAct(room, 'chat'),
      deck:  makeAct(room, 'deck'),
      pomo:  makeAct(room, 'pomo')
    };

    // Quitar ?room= de la barra de direcciones (no queda en el historial ni se filtra al copiar la URL)
    try { if (readRoomParam()) history.replaceState(null, '', baseUrl()); } catch (_) { /* ignorar */ }

    /* --- Eventos de la sala --- */
    room.onPeerJoin(peerId => {
      st.peers.set(peerId, { nick: 'Compañero' });
      st.act.hello.send(helloPayload(), peerId);
      // Si soy anfitrión y mi Pomodoro está corriendo, le paso el estado al que acaba de entrar
      if (st.isHost) {
        const snap = api.getTimerSnapshot();
        if (snap && snap.kind === 'start') notifyTimer(snap); // firmado si hay claves
      }
      renderPeers();
    });

    room.onPeerLeave(peerId => {
      const p = st.peers.get(peerId);
      st.peers.delete(peerId);
      if (st.hostPeer === peerId) st.hostPeer = null;
      if (p) addSystem(`${p.nick} salió de la sala`);
      renderPeers();
    });

    st.act.hello.on(async (d, peerId) => {
      if (!d || typeof d !== 'object') return;
      const p = st.peers.get(peerId) || {};
      const known = !!p.helloDone;
      p.nick = cleanNick(d.nick);
      p.helloDone = true;
      st.peers.set(peerId, p);
      // Anfitrión legítimo: debe presentar pub cuya huella coincida con #hk= del enlace
      if (d.host === true && !st.isHost && d.pub) {
        try {
          const jwkStr = JSON.stringify({ kty: d.pub.kty, crv: d.pub.crv, x: d.pub.x, y: d.pub.y });
          const hash = await sha256b64url(jwkStr);
          if (st.expectedHostHash && hash !== st.expectedHostHash) {
            addSystem(`⚠️ ${p.nick} intentó presentarse como anfitrión pero la clave no coincide con la invitación.`);
          } else if (!st.hostPeer) {
            const pubKey = await importHostPub(d.pub);
            if (pubKey) {
              st.hostPubKey = pubKey;
              st.hostPeer = peerId;
              if (!st.expectedHostHash) st.expectedHostHash = hash;
            }
          }
        } catch (e) { console.warn('Verificación de anfitrión falló', e); }
      } else if (d.host === true && !st.isHost && !st.hostPeer && !st.expectedHostHash) {
        // Sala vieja sin #hk=: comportamiento previo (primer host declarado)
        st.hostPeer = peerId;
      }
      if (!known) addSystem(`${p.nick} se unió a la sala`);
      renderPeers();
    });

    st.act.chat.on((d, peerId) => {
      if (!d || typeof d !== 'object') return;
      const text = clean(d.text, MAX_TEXT);
      if (!text) return;
      addMessage({ nick: cleanNick(d.nick || (st.peers.get(peerId) || {}).nick), text, ts: safeTs(d.ts), mine: false });
    });

    st.act.deck.on((d, peerId) => {
      if (!d || typeof d !== 'object') return;
      const deck = sanitizeDeck(d.deck);
      addMessage({
        nick: cleanNick(d.nick || (st.peers.get(peerId) || {}).nick),
        ts: safeTs(d.ts), mine: false, deck, deckInvalid: !deck
      });
    });

    st.act.pomo.on(async (d, peerId) => {
      if (peerId !== st.hostPeer || !st.syncTimer) return;
      if (!d || typeof d !== 'object') return;
      // Si tenemos clave pública del anfitrión, exigir firma válida
      if (st.hostPubKey) {
        const { sig, ...rest } = d;
        const ok = await verifyPayload(st.hostPubKey, rest, sig);
        if (!ok) {
          addSystem('⚠️ Se ignoró un comando de temporizador con firma inválida.');
          return;
        }
        d = rest;
      }
      if (api.applyTimerSnapshot(d)) {
        const msg = { start: 'inició', pause: 'pausó', reset: 'reinició' }[d.kind];
        if (msg) addSystem(`⏱ El anfitrión ${msg} el temporizador`);
      }
    });

    renderState();
    addSystem(host
      ? 'Sala creada. Compartí el QR o el enlace para invitar a tus compañeros.'
      : 'Te uniste a la sala. Buscando compañeros…');
  }

  function leave(silent = false) {
    if (st.room) { try { st.room.leave(); } catch (_) { /* ignorar */ } }
    st.room = null; st.roomId = null; st.isHost = false; st.hostPeer = null; st.peers.clear(); st.act = {};
    st.hostKeyPair = null; st.hostPubJwk = null; st.hostKeyHash = null;
    st.expectedHostHash = null; st.hostPubKey = null;
    if (!silent) { addSystem('Saliste de la sala.'); api.toast('Saliste de la sala'); }
    renderState();
  }

  const helloPayload = () => {
    const p = { nick: myNick(), host: st.isHost };
    if (st.isHost && st.hostPubJwk) p.pub = st.hostPubJwk;
    return p;
  };

  const safeTs = ts => {
    const n = Number(ts), now = Date.now();
    return Number.isFinite(n) && Math.abs(n - now) < 5 * 60 * 1000 ? n : now;   // si el reloj ajeno está muy corrido, usar el nuestro
  };

  const myNick = () => {
    const cfg = api.getStore().config || {};
    return cleanNick(cfg.username || cfg.nick || '');
  };

  /* ============================================================
     Chat y mazos
     ============================================================ */

  function sendChat(text) {
    if (!st.room) return api.toast('Primero entrá a una sala');
    const now = Date.now();
    if (now - st.lastSend < MIN_SEND_GAP_MS) return;
    st.lastSend = now;
    const clean_ = clean(text, MAX_TEXT);
    if (!clean_) return;
    const msg = { nick: myNick(), text: clean_, ts: now };
    st.act.chat.send(msg);
    addMessage({ ...msg, mine: true });
    if (!st.peers.size) addSystem('Todavía no hay nadie más conectado: tu mensaje no lo vio nadie.');
  }

  function shareDeck() {
    if (!st.room) return api.toast('Primero entrá a una sala');
    const examId = $('chatDeckSelect').value;
    const exam = api.getStore().exams.find(e => e.id === examId);
    if (!exam) return api.toast('Elegí un examen para compartir');
    if (!(exam.cards || []).length) return api.toast('Ese examen todavía no tiene tarjetas');
    const deck = buildDeckPayload(exam);
    const size = new Blob([JSON.stringify(deck)]).size;
    if (size > MAX_DECK_BYTES) return api.toast('El mazo es demasiado grande para enviarlo (máx. 1,5 MB)');
    st.act.deck.send({ nick: myNick(), ts: Date.now(), deck });
    addMessage({ nick: myNick(), ts: Date.now(), mine: true, deck: sanitizeDeck(deck) });
    api.toast('Mazo enviado a la sala');
  }

  function importDeck(deck, btn) {
    const res = api.importDeck(deck);     // script.js crea el examen en store.exams y guarda
    if (res && res.ok) {
      btn.disabled = true;
      btn.textContent = '✓ Importado';
      api.toast(`Importado: ${res.cards} tarjetas en “${res.name}”`);
    } else {
      api.toast('No se pudo importar ese mazo');
    }
  }

  /* ============================================================
     Pomodoro grupal
     ============================================================ */

  /** script.js la llama cada vez que cambia el temporizador local. Solo emite si soy anfitrión. */
  async function notifyTimer(snapshot) {
    if (!st.room || !st.isHost || !snapshot || !st.act.pomo) return;
    if (st.hostKeyPair && st.hostKeyPair.privateKey) {
      try {
        const { body, sig } = await signPayload(st.hostKeyPair.privateKey, snapshot);
        // re-parse body to keep same field order as signed
        const signed = Object.assign(JSON.parse(body), { sig });
        st.act.pomo.send(signed);
        return;
      } catch (e) { console.warn('No se pudo firmar el temporizador', e); }
    }
    st.act.pomo.send(snapshot);
  }

  /* ============================================================
     Interfaz
     ============================================================ */

  function setStatus(text) { const el = $('roomStatus'); if (el) el.textContent = text; }

  function renderState() {
    const active = !!st.room;
    $('roomIdle').classList.toggle('hidden', active);
    $('roomActive').classList.toggle('hidden', !active);
    if (!active) { setStatus('Sin conexión. Creá una sala o unite con un enlace.'); renderPeers(); return; }
    $('roomCodeLabel').textContent = st.roomId.slice(0, 6) + '…';
    $('roomRoleBadge').textContent = st.isHost ? 'Anfitrión' : 'Invitado';
    $('syncRow').classList.toggle('hidden', st.isHost);
    renderDeckSelect();
    renderPeers();
  }

  function renderPeers() {
    const ul = $('peerList');
    if (!ul) return;
    ul.textContent = '';
    const addLi = (nick, tags) => {
      const li = document.createElement('li');
      li.className = 'peer-item';
      const dot = document.createElement('span'); dot.className = 'peer-dot';
      const name = document.createElement('span'); name.className = 'peer-name'; name.textContent = nick;
      li.append(dot, name);
      tags.forEach(t => { const b = document.createElement('span'); b.className = 'badge'; b.textContent = t; li.appendChild(b); });
      ul.appendChild(li);
    };
    if (st.room) addLi(myNick() + ' (vos)', st.isHost ? ['anfitrión'] : []);
    st.peers.forEach((p, id) => addLi(p.nick || 'Compañero', id === st.hostPeer ? ['anfitrión'] : []));
    const n = st.room ? st.peers.size + 1 : 0;
    $('peerCount').textContent = String(n);
    if (st.room) setStatus(st.peers.size
      ? `En sala con ${st.peers.size} compañero${st.peers.size > 1 ? 's' : ''} · conexión directa cifrada`
      : 'En sala · esperando compañeros…');
  }

  function renderDeckSelect() {
    const sel = $('chatDeckSelect');
    if (!sel) return;
    sel.textContent = '';
    api.getStore().exams.forEach(e => {
      const o = document.createElement('option');
      o.value = e.id;
      o.textContent = `${e.subject} — ${e.name} (${(e.cards || []).length} tarjetas)`;
      sel.appendChild(o);
    });
    if (!sel.options.length) {
      const o = document.createElement('option'); o.value = ''; o.textContent = 'No tenés exámenes'; sel.appendChild(o);
    }
  }

  const fmtTime = ts => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

  function pushBubble(el) {
    const box = $('chatMessages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.appendChild(el);
    while (box.children.length > MAX_MSGS_DOM) box.removeChild(box.firstChild);
    if (nearBottom || el.classList.contains('mine')) box.scrollTop = box.scrollHeight;
  }

  function addSystem(text) {
    const el = document.createElement('div');
    el.className = 'chat-msg system';
    el.textContent = text;
    pushBubble(el);
  }

  /** Todo el contenido de usuarios entra con textContent (nunca innerHTML) → sin XSS. */
  function addMessage(m) {
    const el = document.createElement('div');
    el.className = 'chat-msg ' + (m.mine ? 'mine' : 'theirs');

    const meta = document.createElement('div');
    meta.className = 'chat-meta';
    const who = document.createElement('strong'); who.textContent = m.mine ? 'Vos' : m.nick;
    const time = document.createElement('time'); time.textContent = fmtTime(m.ts);
    meta.append(who, time);

    const bubble = document.createElement('div');
    bubble.className = 'chat-bubble';

    if (m.deck || m.deckInvalid) {
      bubble.classList.add('deck');
      if (m.deckInvalid) {
        bubble.textContent = '⚠️ Recibí un mazo con formato inválido y lo descarté.';
      } else {
        const title = document.createElement('div'); title.className = 'deck-title';
        title.textContent = `📚 ${m.deck.subject} — ${m.deck.name}`;
        const info = document.createElement('div'); info.className = 'deck-info';
        info.textContent = `${m.deck.cards.length} tarjetas · ${m.deck.topics.length} temas`;
        bubble.append(title, info);
        if (!m.mine) {
          const btn = document.createElement('button');
          btn.type = 'button'; btn.className = 'btn primary btn-sm'; btn.textContent = 'Importar tarjetas';
          btn.addEventListener('click', () => importDeck(m.deck, btn));
          bubble.appendChild(btn);
        } else {
          const note = document.createElement('small'); note.textContent = 'Enviaste este mazo';
          bubble.appendChild(note);
        }
      }
    } else {
      bubble.textContent = m.text;
    }

    el.append(meta, bubble);
    pushBubble(el);

    if (!m.mine && !$('section-charlas').classList.contains('active')) {
      st.unread++;
      const b = $('navChatBadge');
      if (b) { b.textContent = String(Math.min(st.unread, 99)); b.classList.remove('hidden'); }
    }
  }

  function clearUnread() {
    st.unread = 0;
    const b = $('navChatBadge');
    if (b) b.classList.add('hidden');
  }

  /* ---------- Modal QR / invitación ---------- */

  function openQr() {
    if (!st.roomId) return;
    const link = inviteLink(st.roomId, st.hostKeyHash);
    const box = $('qrBox');
    box.textContent = '';
    if (typeof QRCode !== 'undefined') {
      // Siempre negro sobre blanco para que cualquier cámara lo lea (también en modo oscuro)
      new QRCode(box, { text: link, width: 220, height: 220, colorDark: '#000000', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
    } else {
      box.textContent = 'No se pudo cargar el generador de QR. Usá el enlace de abajo.';
    }
    $('qrLink').value = link;
    $('qrFileWarn').classList.toggle('hidden', location.protocol !== 'file:');
    $('qrModal').classList.remove('hidden');
  }

  async function copyLink() {
    const input = $('qrLink');
    try { await navigator.clipboard.writeText(input.value); }
    catch (_) { input.select(); document.execCommand('copy'); }
    api.toast('Enlace copiado');
  }

  /* ============================================================
     Arranque
     ============================================================ */

  /** Se llama desde script.js cuando el DOM y el store ya están listos. */
  function init(apiObj) {
    api = apiObj;

    const nickInput = $('chatNick');
    const cfg0 = api.getStore().config || {};
    nickInput.value = cfg0.username || cfg0.nick || '';
    nickInput.placeholder = 'Tu usuario del perfil';
    // El nick sale del perfil; no se edita aquí (solo lectura en el HTML)

    $('btnCreateRoom').addEventListener('click', () => {
      const cfg = api.getStore().config;
      if (!(cfg.username || cfg.nick)) {
        api.toast('Configurá tu nombre de usuario en Configuración');
        return;
      }
      cfg.nick = cfg.username || cfg.nick;
      api.saveStore();
      nickInput.value = cfg.nick;
      join(genRoomId(), { host: true }).then(() => { if (st.room) openQr(); });
    });

    $('btnJoinRoom').addEventListener('click', () => {
      const raw = $('roomCodeInput').value;
      const id = parseRoomInput(raw);
      if (!id) return api.toast('Pegá un enlace de invitación o un código válido');
      const hk = parseHostHash(raw);
      const cfg = api.getStore().config;
      if (!(cfg.username || cfg.nick)) {
        api.toast('Configurá tu nombre de usuario en Configuración');
        return;
      }
      cfg.nick = cfg.username || cfg.nick;
      api.saveStore();
      nickInput.value = cfg.nick;
      join(id, { hostHash: hk });
    });
    $('roomCodeInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('btnJoinRoom').click(); } });

    $('btnLeaveRoom').addEventListener('click', () => leave());
    $('btnShowQr').addEventListener('click', openQr);
    $('qrClose').addEventListener('click', () => $('qrModal').classList.add('hidden'));
    $('qrModal').addEventListener('click', e => { if (e.target === $('qrModal')) $('qrModal').classList.add('hidden'); });
    $('qrCopy').addEventListener('click', copyLink);

    $('chatForm').addEventListener('submit', e => {
      e.preventDefault();
      const input = $('chatInput');
      sendChat(input.value);
      input.value = '';
      input.focus();
    });
    $('btnShareDeck').addEventListener('click', shareDeck);
    $('syncTimerToggle').addEventListener('change', e => {
      st.syncTimer = e.target.checked;
      api.toast(st.syncTimer ? 'Temporizador sincronizado con el anfitrión' : 'Ya no seguís el temporizador del anfitrión');
    });

    window.addEventListener('beforeunload', () => { if (st.room) { try { st.room.leave(); } catch (_) { /* ignorar */ } } });
    renderState();
  }

  /** Se llama cada vez que se abre la sección "Salas". */
  function onShow() {
    clearUnread();
    if ($('chatNick') && document.activeElement !== $('chatNick')) {
      const c = api.getStore().config || {};
      $('chatNick').value = c.username || c.nick || '';
    }
    renderDeckSelect();
    const box = $('chatMessages');
    if (box) box.scrollTop = box.scrollHeight;
  }

  return { init, onShow, join, leave, notifyTimer, readRoomParam, readHostHashParam, sanitizeDeck, clean };
})();

/* Un `const` de nivel superior NO es propiedad de window; script.js la busca con `window.StudyRooms`. */
window.StudyRooms = StudyRooms;
