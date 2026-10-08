/**
 * MindFocus — Aplicación de estudio inteligente (v4)
 * Datos persistentes en IndexedDB (ver storage.js). Sin backend.
 * Fácil de modificar: todo el estado vive en `store` (en memoria) y se
 * guarda en segundo plano con saveStore().
 */

// ============================================
// ESTADO Y PERSISTENCIA
// ============================================

const defaultConfig = {
  dailyMins: 60,
  reminders: true,
  dark: false,
  username: '',
  passwordHash: '',
  passwordSalt: '',
  nick: ''
};

const SESSION_KEY = 'mindfocus_session';

/** Estructura inicial VACÍA: el usuario crea sus propios exámenes y temas */
function getDefaultData() {
  return {
    exams: [],
    progress: {
      streak: 0,
      lastStudyDate: null,
      totalMins: 0,
      studyDays: [],
      dailyMins: {},
      accuracyByDay: {},
      achievements: [],
      pomodoroCycles: 0
    },
    config: { ...defaultConfig },
    selectedCalDate: formatDateISO(new Date())
  };
}

/** Estado en memoria. Se reemplaza con lo guardado en IndexedDB en bootStore(). */
let store = getDefaultData();

/** Completa campos faltantes de datos guardados por versiones anteriores. */
function normalizeStore(data) {
  const base = getDefaultData();
  data.exams = Array.isArray(data.exams) ? data.exams : [];
  data.exams.forEach(ex => {
    ex.topics = ex.topics || [];
    if (!ex.plan || ex.plan.length === 0) ex.plan = generatePlan(ex);
    if (!ex.cards) ex.cards = generateCardsForExam(ex);
    if (!ex.stats) ex.stats = { correct: 0, total: 0, studiedMins: 0 };
  });
  data.config = { ...base.config, ...(data.config || {}) };
  // Migración: nick viejo → username si no hay perfil
  if (!data.config.username && data.config.nick) {
    data.config.username = String(data.config.nick).slice(0, 24);
  }
  if (data.config.username && !data.config.nick) {
    data.config.nick = data.config.username;
  }
  data.selectedCalDate = data.selectedCalDate || base.selectedCalDate;
  ensureProgressShape(data);
  return data;
}

// ============================================
// PERFIL LOCAL (usuario + contraseña)
// ============================================

/** Mapa de perfiles locales: username → { passwordHash, passwordSalt } */
let profiles = {};

function listProfileNames() {
  return Object.keys(profiles || {}).sort((a, b) => a.localeCompare(b, 'es'));
}

function hasProfile() {
  return listProfileNames().length > 0;
}

function getSessionUser() {
  try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch (_) { return ''; }
}

function setSessionUser(username) {
  try {
    if (username) sessionStorage.setItem(SESSION_KEY, username);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch (_) { /* ignorar */ }
}

function isLoggedIn() {
  const u = getSessionUser();
  return !!(u && profiles[u] && store.config.username === u);
}

function bufToB64(buf) {
  const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = '';
  u8.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s);
}

function b64ToBuf(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

/** Hash de contraseña con PBKDF2-SHA-256 (solo local; no hay servidor). */
async function hashPassword(password, saltB64) {
  const salt = saltB64
    ? new Uint8Array(b64ToBuf(saltB64))
    : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial,
    256
  );
  return { hash: bufToB64(bits), salt: bufToB64(salt) };
}

async function verifyPasswordForUser(username, password) {
  const p = profiles[username];
  if (!p || !p.passwordHash || !p.passwordSalt) return false;
  const { hash } = await hashPassword(password, p.passwordSalt);
  return hash === p.passwordHash;
}

async function verifyPassword(password) {
  const u = store.config.username || getSessionUser();
  return verifyPasswordForUser(u, password);
}

function cleanUsername(s) {
  return String(s || '')
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, 24);
}

function showAuthError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hidden', !msg);
}

function showAuthScreen(opts = {}) {
  const screen = document.getElementById('authScreen');
  if (!screen) return;
  screen.classList.remove('hidden');
  document.body.classList.add('auth-locked');
  const reg = document.getElementById('authRegister');
  const login = document.getElementById('authLogin');
  const names = listProfileNames();
  const preferRegister = !!opts.register || names.length === 0;

  // Selector de usuario en login (si hay varios perfiles)
  const userSel = document.getElementById('loginUserSelect');
  if (userSel) {
    userSel.innerHTML = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    const session = getSessionUser();
    const pick = names.includes(session) ? session : (store.config.username && names.includes(store.config.username) ? store.config.username : names[0]);
    if (pick) userSel.value = pick;
  }

  if (!preferRegister && names.length) {
    reg.classList.add('hidden');
    login.classList.remove('hidden');
    const label = document.getElementById('loginUserLabel');
    const selected = (userSel && userSel.value) || names[0];
    if (label) label.textContent = selected || '';
    const pass = document.getElementById('loginPass');
    if (pass) { pass.value = ''; setTimeout(() => pass.focus(), 50); }
  } else {
    login.classList.add('hidden');
    reg.classList.remove('hidden');
    const u = document.getElementById('regUser');
    if (u) { u.value = ''; setTimeout(() => u.focus(), 50); }
  }
}

function hideAuthScreen() {
  const screen = document.getElementById('authScreen');
  if (screen) screen.classList.add('hidden');
  document.body.classList.remove('auth-locked');
}

function syncChatNickUI() {
  const nick = store.config.username || store.config.nick || '';
  store.config.nick = nick;
  const el = document.getElementById('chatNick');
  if (el) el.value = nick;
  const cfgUser = document.getElementById('cfgUsername');
  if (cfgUser && document.activeElement !== cfgUser) cfgUser.value = nick;
}

async function loadUserStore(username) {
  const res = await SMStorage.load(username);
  profiles = res.profiles || profiles;
  store = normalizeStore(res.data || getDefaultData());
  store.config.username = username;
  store.config.nick = username;
  // No guardar hashes en el store del usuario (viven en profiles)
  store.config.passwordHash = '';
  store.config.passwordSalt = '';
  SMStorage.setActiveUser(username);
  return res;
}

async function registerProfile(username, password) {
  const u = cleanUsername(username);
  if (u.length < 2) throw new Error('El nombre de usuario debe tener al menos 2 caracteres');
  if (password.length < 4) throw new Error('La contraseña debe tener al menos 4 caracteres');
  // Evitar colisión de nombres (comparación sin mayúsculas)
  const taken = listProfileNames().some(n => n.toLowerCase() === u.toLowerCase());
  if (taken) throw new Error('Ese nombre de usuario ya existe en este navegador. Elegí otro o iniciá sesión.');
  const { hash, salt } = await hashPassword(password);
  profiles[u] = { passwordHash: hash, passwordSalt: salt };
  await SMStorage.saveProfiles(profiles);
  // Store vacío SOLO para este usuario
  store = getDefaultData();
  store.config.username = u;
  store.config.nick = u;
  store.config.passwordHash = '';
  store.config.passwordSalt = '';
  SMStorage.setActiveUser(u);
  setSessionUser(u);
  saveStore();
  await SMStorage.flush();
  syncChatNickUI();
}

async function loginProfile(username, password) {
  const u = cleanUsername(username);
  if (!profiles[u]) throw new Error('Usuario no encontrado');
  if (!(await verifyPasswordForUser(u, password))) throw new Error('Contraseña incorrecta');
  await loadUserStore(u);
  setSessionUser(u);
  saveStore();
  syncChatNickUI();
}

function logoutProfile() {
  // Solo cierra sesión: NO borra los datos de este ni de otros usuarios
  try { SMStorage.flush(); } catch (_) { /* ignorar */ }
  setSessionUser('');
  store = getDefaultData();
  SMStorage.setActiveUser('');
  window._mindfocusAppReady = false;
  showAuthScreen();
  toast('Sesión cerrada');
}

/** Borra solo el usuario actual (o todos si no hay sesión). */
async function clearProfileAndStartOver() {
  const sel = document.getElementById('loginUserSelect');
  const current = getSessionUser() || (sel && sel.value) || store.config.username;
  const names = listProfileNames();
  // Resolver nombre real en el mapa (puede diferir solo en mayúsculas)
  const match = names.find(n => n === current) || names.find(n => n.toLowerCase() === String(current || '').toLowerCase()) || '';
  const msg = match
    ? `¿Borrar el perfil “${match}” y TODOS sus datos (exámenes, apuntes, progreso)?\n\nLos otros usuarios de este navegador no se tocan.`
    : '¿Borrar TODOS los perfiles y datos de MindFocus en este navegador?';
  if (!confirm(msg)) return;

  try {
    if (match && names.length > 1) {
      await SMStorage.clearUser(match);
      // Quitar de memoria todas las variantes de mayúsculas
      Object.keys(profiles).forEach(k => {
        if (k.toLowerCase() === match.toLowerCase()) delete profiles[k];
      });
    } else {
      await SMStorage.clear();
      profiles = {};
    }
  } catch (_) { /* ignorar */ }

  setSessionUser('');
  store = getDefaultData();
  SMStorage.setActiveUser('');
  applyTheme();
  ['loginPass', 'regUser', 'regPass', 'regPass2'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  // Vaciar el selector de la app de inmediato (no esperar al reload)
  if (sel) sel.innerHTML = '';
  showAuthError('loginError', '');
  showAuthError('regError', '');
  window._mindfocusAppReady = false;
  try {
    const res = await SMStorage.load();
    profiles = res.profiles || {};
  } catch (_) { profiles = {}; }
  // Defensa: si el borrado falló a medias, forzar que no reaparezca
  if (match) {
    Object.keys(profiles).forEach(k => {
      if (k.toLowerCase() === match.toLowerCase()) delete profiles[k];
    });
    try { await SMStorage.saveProfiles(profiles); } catch (_) { /* ignorar */ }
  }
  showAuthScreen({ register: listProfileNames().length === 0 });
  toast(listProfileNames().length ? 'Perfil borrado. Ya no aparece en la lista de esta app.' : 'Datos borrados. Creá un perfil nuevo.');
}

/** Carga el store desde IndexedDB (y migra los datos viejos de localStorage si existen). */
async function bootStore() {
  SMStorage.setErrorHandler(() => toast('⚠️ No pude guardar tus datos. Exportá un respaldo desde Configuración.', 5000));
  let res = { data: null, source: 'empty', profiles: {} };
  try { res = await SMStorage.load(); } catch (e) { console.warn('Error cargando datos', e); }
  profiles = res.profiles || {};

  // Si hay sesión activa, cargar SOLO el store de ese usuario
  const session = getSessionUser();
  if (session && profiles[session]) {
    try {
      await loadUserStore(session);
    } catch (e) {
      console.warn('No pude cargar el usuario de la sesión', e);
      store = getDefaultData();
      setSessionUser('');
    }
  } else {
    store = getDefaultData();
    SMStorage.setActiveUser('');
  }
  SMStorage.requestPersistence();
}

/** Mismo nombre y uso de siempre; ahora escribe en IndexedDB en segundo plano. */
function saveStore() {
  SMStorage.save(store);
}

function ensureProgressShape(data) {
  data.progress = data.progress || {};
  data.progress.dailyMins = data.progress.dailyMins || {};
  data.progress.accuracyByDay = data.progress.accuracyByDay || {};
  data.progress.achievements = data.progress.achievements || [];
  data.progress.pomodoroCycles = data.progress.pomodoroCycles || 0;
  data.progress.rescued = data.progress.rescued || 0;
}

function recordStudyMins(mins) {
  if (!mins || mins < 0) return;
  const today = formatDateISO(new Date());
  store.progress.totalMins = (store.progress.totalMins || 0) + mins;
  store.progress.dailyMins = store.progress.dailyMins || {};
  store.progress.dailyMins[today] = (store.progress.dailyMins[today] || 0) + mins;
}

function recordAccuracy(knew) {
  const today = formatDateISO(new Date());
  store.progress.accuracyByDay = store.progress.accuracyByDay || {};
  const day = store.progress.accuracyByDay[today] || { correct: 0, total: 0 };
  day.total += 1;
  if (knew) day.correct += 1;
  store.progress.accuracyByDay[today] = day;
}

const ACHIEVEMENTS = [
  { id: 'first_step', icon: '🌱', name: 'Primer paso', desc: 'Registrá tu primer minuto de estudio', check: s => (s.progress.totalMins || 0) >= 1 },
  { id: 'steel_brain', icon: '🧠', name: 'Cerebro de Acero', desc: 'Estudia 5 días seguidos', check: s => (s.progress.streak || 0) >= 5 },
  { id: 'week_fire', icon: '🔥', name: 'Semana en llamas', desc: 'Mantené una racha de 7 días', check: s => (s.progress.streak || 0) >= 7 },
  { id: 'book_eater', icon: '📚', name: 'Devorador de Libros', desc: 'Generá más de 100 tarjetas', check: s => s.exams.reduce((n, e) => n + (e.cards?.length || 0), 0) >= 100 },
  { id: 'card_starter', icon: '🃏', name: 'Coleccionista', desc: 'Llegá a 25 tarjetas generadas', check: s => s.exams.reduce((n, e) => n + (e.cards?.length || 0), 0) >= 25 },
  { id: 'sharpshooter', icon: '🎯', name: 'Francotirador', desc: 'Acertá 50 respuestas', check: s => s.exams.reduce((n, e) => n + (e.stats?.correct || 0), 0) >= 50 },
  { id: 'pomodoro_set', icon: '🍅', name: 'Ciclo maestro', desc: 'Completá 4 sesiones Pomodoro', check: s => (s.progress.pomodoroCycles || 0) >= 4 },
  { id: 'hour_hero', icon: '⏱️', name: 'Hora extra', desc: 'Acumulá 60 minutos de estudio', check: s => (s.progress.totalMins || 0) >= 60 },
  { id: 'mock_ace', icon: '🎓', name: 'Sobresaliente', desc: 'Sacá 9 o más en un simulacro', check: s => s.exams.some(e => (e.mocks || []).some(m => m.grade >= 9)) },
  { id: 'grave_digger', icon: '⚰️', name: 'Resucitador', desc: 'Sacá 5 tarjetas del cementerio', check: s => (s.progress.rescued || 0) >= 5 }
];

function unlockAchievements(silent = false) {
  store.progress.achievements = store.progress.achievements || [];
  ACHIEVEMENTS.forEach(a => {
    if (store.progress.achievements.includes(a.id)) return;
    if (a.check(store)) {
      store.progress.achievements.push(a.id);
      if (!silent) toast(`Logro desbloqueado: ${a.name} ${a.icon}`);
    }
  });
}

// ============================================
// UTILIDADES
// ============================================

function uid() {
  return 'id_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** Fecha local YYYY-MM-DD (evita el desfase de toISOString() que usa UTC). */
function formatDateISO(d) {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, '0');
  const day = String(x.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDate(str) {
  const [y, m, day] = str.split('-').map(Number);
  return new Date(y, m - 1, day);
}

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = parseDate(dateStr);
  target.setHours(0, 0, 0, 0);
  return Math.ceil((target - today) / 86400000);
}

function formatDisplayDate(dateStr) {
  const d = parseDate(dateStr);
  return d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' });
}

function diffWeight(diff) {
  return { facil: 1, medio: 2, dificil: 3 }[diff] || 2;
}

function toast(msg, ms = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), ms);
}

const esc = (s) => (typeof SM !== 'undefined' && SM.esc) ? SM.esc(s) : String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeDiff = d => (d === 'facil' || d === 'medio' || d === 'dificil') ? d : 'medio';


function getNextExam() {
  const sorted = [...store.exams].sort((a, b) => a.date.localeCompare(b.date));
  const upcoming = sorted.filter(e => daysUntil(e.date) >= 0);
  return upcoming[0] || sorted[sorted.length - 1] || null;
}

function examPrepPercent(exam) {
  if (!exam.topics.length) return 0;
  const avg = exam.topics.reduce((s, t) => s + (t.mastery || 0), 0) / exam.topics.length;
  return Math.round(avg);
}

// ============================================
// PLAN DE ESTUDIO AUTOMÁTICO
// ============================================

/**
 * Genera un plan día a día priorizando temas difíciles,
 * con sesiones cortas + descansos y repasos finales.
 * Si quedan pocos días → modo intensivo.
 */
function generatePlan(exam) {
  const daysLeft = Math.max(1, daysUntil(exam.date));
  const dailyMins = exam.dailyMins || 60;
  const intensive = daysLeft <= 3;

  // Ordenar temas: difíciles primero, luego por menor mastery
  const topics = [...exam.topics].sort((a, b) => {
    const dw = diffWeight(b.difficulty) - diffWeight(a.difficulty);
    if (dw !== 0) return dw;
    return (a.mastery || 0) - (b.mastery || 0);
  });

  if (!topics.length) return [];

  const plan = [];
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  // Distribución: más tiempo a difíciles
  const totalWeight = topics.reduce((s, t) => s + diffWeight(t.difficulty), 0);

  for (let d = 0; d < daysLeft; d++) {
    const dayDate = new Date(start);
    dayDate.setDate(start.getDate() + d);
    const dateStr = formatDateISO(dayDate);
    const isReviewDay = d >= daysLeft - 2; // últimos 2 días: repaso

    let remaining = intensive ? Math.min(dailyMins * 1.4, 120) : dailyMins;
    const sessions = [];

    // Sesiones de estudio de 15-25 min + micro-descanso
    const sessionLen = intensive ? 20 : 18;
    let topicIdx = 0;

    while (remaining >= 10 && topicIdx < topics.length * 3) {
      const topic = topics[topicIdx % topics.length];
      const weight = diffWeight(topic.difficulty);
      let mins = Math.round(sessionLen * (weight / 2));
      mins = Math.min(mins, remaining, intensive ? 25 : 22);
      mins = Math.max(12, mins);

      const type = isReviewDay ? 'repaso' : 'estudio';
      sessions.push({
        id: uid(),
        topicId: topic.id,
        topicName: topic.name,
        mins,
        type,
        done: false
      });

      remaining -= mins;
      // Micro-descanso implícito (no suma al remaining de estudio)
      topicIdx++;
      if (topicIdx % topics.length === 0 && remaining < 15) break;
    }

    // Asegurar al menos una sesión si hay temas
    if (!sessions.length && topics.length) {
      sessions.push({
        id: uid(),
        topicId: topics[0].id,
        topicName: topics[0].name,
        mins: Math.min(15, dailyMins),
        type: 'estudio',
        done: false
      });
    }

    plan.push({ date: dateStr, sessions });
  }

  return plan;
}

// ============================================
// GENERACIÓN DE FLASHCARDS / PREGUNTAS (simulada)
// ============================================

function generateCardsForExam(/* exam */) {
  // Ya NO se crean tarjetas de relleno: las tarjetas salen del contenido real
  // del usuario (Apuntes) o de información investigada en internet.
  return [];
}

// ============================================
// REPETICIÓN ESPACIADA (SM-2 simplificado)
// ============================================

function updateSpacedRepetition(card, knewIt) {
  card.seen = (card.seen || 0) + 1;
  card.lastResult = knewIt ? 'ok' : 'fail';
  if (!knewIt) card.lapses = (card.lapses || 0) + 1;   // cuántas veces falló (alimenta "Puntos débiles")
  if (knewIt) {
    card.reps = (card.reps || 0) + 1;
    if (card.reps === 1) card.interval = 1;
    else if (card.reps === 2) card.interval = 3;
    else card.interval = Math.round((card.interval || 1) * (card.ease || 2.5));
    card.ease = Math.min(3.0, (card.ease || 2.5) + 0.1);
  } else {
    card.reps = 0;
    card.interval = 1;
    card.ease = Math.max(1.3, (card.ease || 2.5) - 0.2);
  }
  const next = new Date();
  next.setDate(next.getDate() + (card.interval || 1));
  card.nextReview = formatDateISO(next);
}

/**
 * Repasa una tarjeta y avisa si salió del "cementerio" (dejó de ser un punto débil).
 * Devuelve 'rescued' en ese caso.
 */
function reviewCard(card, ok) {
  const wasWeak = SM.isWeak(card);
  updateSpacedRepetition(card, ok);
  if (wasWeak && !SM.isWeak(card)) {
    store.progress.rescued = (store.progress.rescued || 0) + 1;
    return 'rescued';
  }
  return null;
}

// ============================================
// NAVEGACIÓN
// ============================================

const sectionTitles = {
  inicio: 'Inicio',
  materias: 'Mis materias',
  calendario: 'Calendario',
  memorizar: 'Memorizar',
  enfoque: 'Enfoque',
  progreso: 'Progreso',
  apuntes: 'Apuntes',
  charlas: 'Salas de estudio',
  config: 'Configuración'
};

function showSection(name) {
  if (name !== 'memorizar') {
    if (mockState.phase === 'running') {
      clearInterval(mockState.timerId);
      mockState.timerId = null;
      mockState.phase = 'idle';
      const mc = document.getElementById('mockCard');
      if (mc) mc.classList.add('hidden');
      const memo = document.getElementById('memoCard');
      if (memo) memo.classList.add('hidden');
    } else if (mockState.phase === 'review' && !mockState.committed) {
      commitMock(true);
    }
  }
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const sec = document.getElementById('section-' + name);
  if (sec) sec.classList.add('active');
  const nav = document.querySelector(`.nav-item[data-section="${name}"]`);
  if (nav) nav.classList.add('active');
  document.getElementById('pageTitle').textContent = sectionTitles[name] || name;
  closeSidebar();

  if (name === 'inicio') renderInicio();
  if (name === 'materias') renderMaterias();
  if (name === 'calendario') renderCalendario();
  if (name === 'memorizar') renderMemorizarSelects();
  if (name === 'enfoque') renderTimerSelects();
  if (name === 'progreso') renderProgreso();
  if (name === 'apuntes') renderApuntesSelects();
  if (name === 'charlas' && window.StudyRooms) StudyRooms.onShow();
  if (name === 'config') renderConfig();
}

function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('overlay').classList.add('show');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('overlay').classList.remove('show');
}

// ============================================
// RENDER: INICIO
// ============================================

function renderInicio() {
  renderReminders();
  const exam = getNextExam();
  const card = document.getElementById('nextExamCard');

  if (!exam) {
    // Vaciar el hero: tras esto #nextExamName / #prepRing dejan de existir
    card.innerHTML = `
      <div class="empty-state">
        <div class="emoji">📭</div>
        <p>No tenés exámenes cargados.</p>
        <button class="btn primary" style="margin-top:1rem" onclick="openExamModal()">+ Crear primer examen</button>
      </div>`;
    document.getElementById('todayPlan').innerHTML = '<p class="empty-state">Agregá un examen para ver tu plan.</p>';
    return;
  }

  const days = daysUntil(exam.date);
  const pct = examPrepPercent(exam);
  const circumference = 2 * Math.PI * 52;
  const offset = circumference - (pct / 100) * circumference;
  const daysLabel = days < 0 ? 'Pasado' : days === 0 ? '¡Hoy!' : days === 1 ? 'Mañana' : days + ' días';
  const todayStr = formatDateISO(new Date());
  const todayPlan = (exam.plan || []).find(p => p.date === todayStr);
  const nextSession = todayPlan?.sessions?.find(s => !s.done) || todayPlan?.sessions?.[0];
  const nextText = nextSession
    ? `Próxima sesión: ${nextSession.topicName} (${nextSession.mins} min)`
    : 'Sin sesiones pendientes para hoy';

  // Siempre reconstruir el hero: tras el empty-state los nodos originales ya no existen
  card.innerHTML = `
    <div class="card-label">Próximo escrito</div>
    <h2 class="hero-title" id="nextExamName">${esc(exam.name)}</h2>
    <p class="hero-meta" id="nextExamMeta">${esc(exam.subject)} · ${formatDisplayDate(exam.date)} ${esc(exam.time || '')} · ${daysLabel}</p>
    <div class="progress-ring-wrap">
      <svg class="progress-ring" viewBox="0 0 120 120">
        <circle class="ring-bg" cx="60" cy="60" r="52" />
        <circle class="ring-fill" id="prepRing" cx="60" cy="60" r="52"
          style="stroke-dasharray:${circumference};stroke-dashoffset:${offset}" />
      </svg>
      <div class="ring-text">
        <span id="prepPercent">${pct}%</span>
        <small>preparado</small>
      </div>
    </div>
    <p class="next-session" id="nextSessionText">${esc(nextText)}</p>
    <button class="btn primary btn-lg" id="btnStartStudy">Empezar a estudiar</button>
  `;
  document.getElementById('btnStartStudy').addEventListener('click', () => {
    const ex = getNextExam();
    if (ex) startStudyForExam(ex.id);
    else toast('Creá un examen primero');
  });

  renderTodayPlan();
}

function renderTodayPlan() {
  const todayStr = formatDateISO(new Date());
  const container = document.getElementById('todayPlan');
  let items = [];

  store.exams.forEach(ex => {
    const day = (ex.plan || []).find(p => p.date === todayStr);
    if (day) {
      day.sessions.forEach(s => {
        items.push({ ...s, examId: ex.id, subject: ex.subject });
      });
    }
  });

  document.getElementById('todaySessionsCount').textContent = items.length + ' sesiones';

  if (!items.length) {
    container.innerHTML = '<p class="empty-state">Hoy no tenés sesiones programadas. ¡Día libre o creá un examen!</p>';
    return;
  }

  container.innerHTML = items.map(s => `
    <div class="session-item ${s.done ? 'done' : ''}" data-exam="${esc(s.examId)}" data-sid="${esc(s.id)}">
      <div class="dot"></div>
      <div class="info">
        <strong>${esc(s.topicName)}</strong>
        <small>${esc(s.subject)} · ${s.type === 'repaso' ? 'Repaso' : 'Estudio'}</small>
      </div>
      <span class="mins">${s.mins} min</span>
      ${!s.done ? `<button class="btn btn-sm" onclick="markSessionDone('${esc(s.examId)}','${esc(s.id)}')">✓</button>` : '<span style="color:var(--success)">✓</span>'}
    </div>
  `).join('');
}

function markSessionDone(examId, sessionId) {
  const exam = store.exams.find(e => e.id === examId);
  if (!exam) return;
  if (!exam.stats) exam.stats = { correct: 0, total: 0, studiedMins: 0 };
  for (const day of exam.plan || []) {
    const s = day.sessions.find(x => x.id === sessionId);
    if (s) {
      s.done = true;
      exam.stats.studiedMins = (exam.stats.studiedMins || 0) + s.mins;
      recordStudyMins(s.mins);
      const topic = exam.topics.find(t => t.id === s.topicId);
      if (topic) topic.mastery = Math.min(100, (topic.mastery || 0) + 8);
      updateStreak();
      unlockAchievements();
      saveStore();
      toast('Sesión completada 🎉');
      renderInicio();
      return;
    }
  }
}

function renderReminders() {
  const box = document.getElementById('reminders');
  if (!store.config.reminders) {
    box.innerHTML = '';
    return;
  }
  const msgs = [];
  store.exams.forEach(ex => {
    const d = daysUntil(ex.date);
    if (d >= 0 && d <= 5) {
      msgs.push(`Te quedan ${d === 0 ? 'horas' : d + ' día' + (d > 1 ? 's' : '')} para <strong>${esc(ex.subject)}</strong> (${esc(ex.name)}).`);
    }
    const todayStr = formatDateISO(new Date());
    const day = (ex.plan || []).find(p => p.date === todayStr);
    if (day) {
      const pending = day.sessions.filter(s => !s.done);
      if (pending.length) {
        const topic = pending[0].topicName;
        msgs.push(`Hoy tenés que repasar/estudiar: <strong>${esc(topic)}</strong>.`);
        const leftMins = pending.reduce((s, x) => s + x.mins, 0);
        msgs.push(`Te faltan <strong>${leftMins} minutos</strong> de estudio para completar tu objetivo de hoy.`);
      }
    }
  });
  box.innerHTML = msgs.slice(0, 3).map(m => `<div class="reminder">${m}</div>`).join('');
}

// ============================================
// RENDER: MATERIAS
// ============================================

function renderMaterias() {
  const grid = document.getElementById('examsList');
  if (!store.exams.length) {
    grid.innerHTML = '<div class="empty-state"><div class="emoji">📖</div><p>Todavía no hay exámenes.</p></div>';
    return;
  }
  grid.innerHTML = store.exams
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(ex => {
      const d = daysUntil(ex.date);
      const pct = examPrepPercent(ex);
      return `
        <div class="exam-card">
          <div class="subject">${esc(ex.subject)}</div>
          <h3>${esc(ex.name)}</h3>
          <div class="meta">${formatDisplayDate(ex.date)} ${ex.time || ''} · ${d < 0 ? 'Pasado' : d + ' días'} · Meta: ${ex.goal || '—'}</div>
          <div class="topics-preview">
            ${ex.topics.map(t => `<span class="diff-tag diff-${safeDiff(t.difficulty)}">${esc(t.name)}</span>`).join(' ')}
          </div>
          <div style="margin-bottom:0.75rem">
            <div class="bar" style="height:8px;background:var(--border);border-radius:99px;overflow:hidden">
              <div class="bar-fill" style="width:${pct}%;height:100%;background:var(--primary)"></div>
            </div>
            <small style="color:var(--text-muted)">${pct}% preparado</small>
          </div>
          <div class="actions">
            <button class="btn btn-sm primary" onclick="startStudyForExam('${ex.id}')">Estudiar</button>
            <button class="btn btn-sm" onclick="editExam('${ex.id}')">Editar</button>
            <button class="btn btn-sm danger" onclick="deleteExam('${ex.id}')">Borrar</button>
          </div>
        </div>`;
    }).join('');
}

function deleteExam(id) {
  if (!confirm('¿Borrar este examen y su plan?')) return;
  store.exams = store.exams.filter(e => e.id !== id);
  saveStore();
  toast('Examen eliminado');
  renderMaterias();
  renderInicio();
}

function startStudyForExam(id) {
  showSection('memorizar');
  setTimeout(() => {
    const sel = document.getElementById('memoExamSelect');
    if (sel) {
      sel.value = id;
      // auto start flashcards
      document.querySelector('.mode-btn[data-mode="flashcards"]')?.click();
    }
  }, 100);
}

// ============================================
// MODAL EXAMEN
// ============================================

let tempTopics = [];

function openExamModal(exam = null) {
  const modal = document.getElementById('examModal');
  document.getElementById('examModalTitle').textContent = exam ? 'Editar examen' : 'Nuevo examen';
  document.getElementById('examId').value = exam ? exam.id : '';
  document.getElementById('examSubject').value = exam ? exam.subject : '';
  document.getElementById('examName').value = exam ? exam.name : '';
  document.getElementById('examDate').value = exam ? exam.date : '';
  document.getElementById('examTime').value = exam ? (exam.time || '08:00') : '08:00';
  document.getElementById('examDailyMins').value = exam ? exam.dailyMins : (store.config.dailyMins || 60);
  document.getElementById('examGoal').value = exam ? (exam.goal || 7) : 7;
  tempTopics = exam ? exam.topics.map(t => ({ ...t })) : [];
  renderTempTopics();
  modal.classList.remove('hidden');
}

function closeExamModal() {
  document.getElementById('examModal').classList.add('hidden');
}

function renderTempTopics() {
  const ul = document.getElementById('topicList');
  ul.innerHTML = tempTopics.map((t, i) => `
    <li>
      <span class="diff-tag diff-${safeDiff(t.difficulty)}">${esc(safeDiff(t.difficulty))}</span>
      ${esc(t.name)}
      <button type="button" class="rm" onclick="removeTempTopic(${i})">✕</button>
    </li>
  `).join('');
}

function removeTempTopic(i) {
  tempTopics.splice(i, 1);
  renderTempTopics();
}

function editExam(id) {
  const exam = store.exams.find(e => e.id === id);
  if (exam) openExamModal(exam);
}

// ============================================
// CALENDARIO
// ============================================

let calCursor = new Date();

function renderCalendario() {
  const year = calCursor.getFullYear();
  const month = calCursor.getMonth();
  document.getElementById('calMonthLabel').textContent =
    calCursor.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' });

  const first = new Date(year, month, 1);
  let startDay = first.getDay() - 1; // Lun=0
  if (startDay < 0) startDay = 6;

  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const prevDays = new Date(year, month, 0).getDate();

  const sessionDates = new Set();
  const examDates = new Set();
  store.exams.forEach(ex => {
    examDates.add(ex.date);
    (ex.plan || []).forEach(p => {
      if (p.sessions.length) sessionDates.add(p.date);
    });
  });

  const selected = store.selectedCalDate || formatDateISO(new Date());
  const todayStr = formatDateISO(new Date());
  const grid = document.getElementById('calGrid');
  let html = '';

  for (let i = 0; i < startDay; i++) {
    const day = prevDays - startDay + i + 1;
    html += `<div class="cal-day other">${day}</div>`;
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = formatDateISO(new Date(year, month, d));
    const classes = ['cal-day'];
    if (dateStr === todayStr) classes.push('today');
    if (dateStr === selected) classes.push('selected');
    if (sessionDates.has(dateStr)) classes.push('has-session');
    if (examDates.has(dateStr)) classes.push('exam-day');
    html += `<div class="${classes.join(' ')}" data-date="${dateStr}" onclick="selectCalDay('${dateStr}')">${d}</div>`;
  }
  grid.innerHTML = html;
  renderCalDayDetail(selected);
}

function selectCalDay(dateStr) {
  store.selectedCalDate = dateStr;
  saveStore();
  renderCalendario();
}

function renderCalDayDetail(dateStr) {
  const box = document.getElementById('calDayDetail');
  let items = [];
  store.exams.forEach(ex => {
    if (ex.date === dateStr) {
      items.push({ type: 'exam', text: `📝 EXAMEN: ${ex.subject} — ${ex.name} (${ex.time || ''})` });
    }
    const day = (ex.plan || []).find(p => p.date === dateStr);
    if (day) {
      day.sessions.forEach(s => {
        items.push({
          type: 'session',
          text: `${s.topicName} (${s.mins} min)`,
          subject: ex.subject,
          done: s.done
        });
      });
    }
  });
  if (!items.length) {
    box.innerHTML = '<p class="empty-state">Sin eventos este día.</p>';
    return;
  }
  box.innerHTML = items.map(it => {
    if (it.type === 'exam') return `<div class="session-item" style="border-color:var(--warning)"><div class="info"><strong>${esc(it.text)}</strong></div></div>`;
    return `<div class="session-item ${it.done ? 'done' : ''}"><div class="dot"></div><div class="info"><strong>${esc(it.text)}</strong><small>${esc(it.subject)}</small></div></div>`;
  }).join('');
}

// ============================================
// MEMORIZAR
// ============================================

let memoState = { examId: null, mode: null, queue: [], index: 0 };

function renderMemorizarSelects() {
  const sel = document.getElementById('memoExamSelect');
  sel.innerHTML = store.exams.map(e =>
    `<option value="${esc(e.id)}">${esc(e.subject)} — ${esc(e.name)}</option>`
  ).join('') || '<option value="">Sin exámenes</option>';
  document.getElementById('memoCard').classList.add('hidden');
  if (mockState.phase === 'idle') document.getElementById('mockCard').classList.add('hidden');
  renderGraveyard();
}

function startMemo(mode) {
  const examId = document.getElementById('memoExamSelect').value;
  const exam = store.exams.find(e => e.id === examId);
  if (!exam) {
    toast('Elegí un examen primero');
    return;
  }

  // Simulacro en curso: pedir confirmación antes de cambiar de modo
  if (mockState.phase === 'running') {
    if (mode === 'mock' || !confirm('Hay un simulacro en curso. ¿Abandonarlo?')) return;
    abortMock(true);
  }
  if (mockState.phase === 'review' && !mockState.committed) commitMock(true);
  if (mode === 'mock') return startMock();
  mockState.phase = 'idle';
  document.getElementById('mockCard').classList.add('hidden');

  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.mode-btn[data-mode="${mode}"]`)?.classList.add('active');

  let cards = (exam.cards || []).filter(c => {
    if (mode === 'flashcards') return c.type === 'flashcard';
    if (mode === 'qa') return c.type === 'qa';
    if (mode === 'tf') return c.type === 'tf';
    if (mode === 'mc') return c.type === 'mc';
    if (mode === 'weak') return SM.isWeak(c);   // "Mis puntos débiles": cualquier tipo
    return true; // quiz = todos
  });

  // Priorizar fallidos / próximos a repasar
  const today = formatDateISO(new Date());
  if (mode === 'weak') {
    cards.sort((a, b) => SM.weakScore(b) - SM.weakScore(a));   // las que más te cuestan primero
    cards = cards.slice(0, 40);
  } else {
    cards.sort((a, b) => {
      const aDue = (a.nextReview || today) <= today ? 0 : 1;
      const bDue = (b.nextReview || today) <= today ? 0 : 1;
      if (aDue !== bDue) return aDue - bDue;
      return (a.reps || 0) - (b.reps || 0);
    });
  }

  if (mode === 'quiz') cards = cards.slice(0, 10);
  if (!cards.length) {
    toast(mode === 'weak'
      ? 'No tenés puntos débiles en este examen. ¡Buen trabajo! 🎉'
      : 'Todavía no hay tarjetas de este tipo. Cargá tus apuntes o investigá un tema en la sección Apuntes.');
    return;
  }

  memoState = { examId, mode, queue: cards, index: 0 };
  document.getElementById('memoCard').classList.remove('hidden');
  renderMemoCard();
}

function renderMemoCard() {
  const { queue, index, mode } = memoState;
  if (index >= queue.length) {
    document.getElementById('memoContent').innerHTML = `
      <div class="empty-state">
        <div class="emoji">🏆</div>
        <p>¡Sesión terminada!</p>
        <button class="btn primary" onclick="document.getElementById('memoCard').classList.add('hidden')">Cerrar</button>
      </div>`;
    document.getElementById('memoActions').innerHTML = '';
    document.getElementById('memoCounter').textContent = `${queue.length} / ${queue.length}`;
    document.getElementById('memoBar').style.width = '100%';
    return;
  }

  const card = queue[index];
  document.getElementById('memoCounter').textContent = `${index + 1} / ${queue.length}`;
  document.getElementById('memoBar').style.width = `${((index) / queue.length) * 100}%`;

  const content = document.getElementById('memoContent');
  const actions = document.getElementById('memoActions');

  if (card.type === 'flashcard') {
    content.innerHTML = `
      <div class="flashcard" id="fc" onclick="this.classList.toggle('flipped')">
        <div class="flashcard-inner">
          <div class="flashcard-front">${esc(card.front)}</div>
          <div class="flashcard-back">${esc(card.back)}</div>
        </div>
      </div>
      <small style="color:var(--text-muted);margin-top:0.5rem">Tocá la tarjeta o presioná Espacio para voltear</small>`;
    actions.innerHTML = `
      <button class="btn danger" onclick="answerMemo(false)">✗ No lo sabía</button>
      <button class="btn primary" onclick="answerMemo(true)">✓ Lo sabía</button>`;
  } else if (card.type === 'qa') {
    content.innerHTML = `
      <div class="question">${esc(card.question)}</div>
      <button class="btn" id="showAnsBtn" onclick="document.getElementById('hiddenAns').classList.remove('hidden');this.classList.add('hidden')">Ver respuesta</button>
      <div class="answer hidden" id="hiddenAns">${esc(card.answer)}</div>`;
    actions.innerHTML = `
      <button class="btn danger" onclick="answerMemo(false)">✗ No lo sabía</button>
      <button class="btn primary" onclick="answerMemo(true)">✓ Lo sabía</button>`;
  } else if (card.type === 'tf') {
    content.innerHTML = `<div class="question">${esc(card.statement)}</div><p style="color:var(--text-muted)">¿Verdadero o Falso?</p>`;
    actions.innerHTML = `
      <button class="btn" onclick="answerTF(true)">Verdadero</button>
      <button class="btn" onclick="answerTF(false)">Falso</button>`;
  } else if (card.type === 'mc') {
    content.innerHTML = `
      <div class="question">${esc(card.question)}</div>
      <div class="mc-options">
        ${card.options.map((o, i) => `<button class="mc-opt" data-i="${i}" onclick="answerMC(${i})">${esc(o)}</button>`).join('')}
      </div>`;
    actions.innerHTML = '';
  }
  if (card.source && card.source.kind === 'web') {
    content.insertAdjacentHTML('beforeend', `<div class="card-source">🌐 Fuente: ${sourceBadge(card.source)}</div>`);
  }
  syncFlashcardHeight();
}

function syncFlashcardHeight() {
  const fc = document.getElementById('fc');
  if (!fc) return;
  const front = fc.querySelector('.flashcard-front');
  const back = fc.querySelector('.flashcard-back');
  if (!front || !back) return;
  const prev = front.style.position;
  front.style.position = 'relative';
  back.style.position = 'relative';
  const h = Math.max(front.scrollHeight, back.scrollHeight, 160);
  front.style.position = prev || 'absolute';
  back.style.position = 'absolute';
  fc.style.height = h + 'px';
}

function answerMemo(knew) {
  applyAnswer(knew);
}

function answerTF(userSaysTrue) {
  const card = memoState.queue[memoState.index];
  const correct = userSaysTrue === card.correct;
  toast(correct ? '¡Correcto!' : 'Incorrecto. ' + (card.explanation || ''));
  applyAnswer(correct);
}

function answerMC(idx) {
  const card = memoState.queue[memoState.index];
  const opts = document.querySelectorAll('.mc-opt');
  opts.forEach((el, i) => {
    el.disabled = true;
    if (i === card.correctIndex) el.classList.add('correct');
    else if (i === idx) el.classList.add('wrong');
  });
  const correct = idx === card.correctIndex;
  setTimeout(() => applyAnswer(correct), 700);
}

function applyAnswer(knew) {
  const card = memoState.queue[memoState.index];
  const exam = store.exams.find(e => e.id === memoState.examId);
  if (!exam) return;

  // Actualizar tarjeta en el examen
  const real = exam.cards.find(c => c.id === card.id);
  if (real) {
    const outcome = reviewCard(real, knew);
    if (outcome === 'rescued' && memoState.mode === 'weak') toast('⚰️→✅ ¡Esa tarjeta salió del cementerio!');
    // Si falló, reinsertar pronto en la cola
    if (!knew && memoState.index < memoState.queue.length - 1) {
      memoState.queue.splice(memoState.index + 2, 0, { ...real });
    }
  }

  exam.stats.total = (exam.stats.total || 0) + 1;
  if (knew) exam.stats.correct = (exam.stats.correct || 0) + 1;
  recordAccuracy(knew);

  const topic = exam.topics.find(t => t.id === card.topicId);
  if (topic) {
    topic.mastery = Math.min(100, Math.max(0, (topic.mastery || 0) + (knew ? 6 : -4)));
  }

  updateStreak();
  unlockAchievements();
  saveStore();
  memoState.index++;
  renderMemoCard();
  renderGraveyard();
}

// ============================================
// CEMENTERIO DE TARJETAS ("Mis puntos débiles")
// ============================================

const TYPE_ICON = { flashcard: '🃏', qa: '❓', tf: '✓✗', mc: 'ABCD' };

function selectedMemoExam() {
  return store.exams.find(e => e.id === document.getElementById('memoExamSelect').value);
}

function weakCardsOf(exam) {
  return ((exam && exam.cards) || []).filter(SM.isWeak).sort((a, b) => SM.weakScore(b) - SM.weakScore(a));
}

const cardLabel = c => c.front || c.question || c.statement || '';

function renderGraveyard() {
  const exam = selectedMemoExam();
  const weak = weakCardsOf(exam);

  const countEl = document.getElementById('weakCount');
  if (countEl) { countEl.textContent = weak.length; countEl.classList.toggle('hidden', !weak.length); }
  document.getElementById('graveyardBadge').textContent = `${weak.length} ${weak.length === 1 ? 'tarjeta' : 'tarjetas'}`;
  document.getElementById('btnGraveyardStart').disabled = !weak.length;

  const list = document.getElementById('graveyardList');
  if (!exam) {
    list.innerHTML = '<p class="hint">Elegí un examen para ver tus puntos débiles.</p>';
  } else if (!weak.length) {
    list.innerHTML = '<p class="hint">Todavía no tenés puntos débiles. Cuando falles una tarjeta (← o 1) y no la consolides, aparecerá acá.</p>';
  } else {
    list.innerHTML = weak.slice(0, 8).map(c => {
      const label = cardLabel(c);
      return `<div class="grave-item">
        <span class="grave-type">${TYPE_ICON[c.type] || '🃏'}</span>
        <span class="grave-text">${esc(label.length > 90 ? label.slice(0, 90) + '…' : label)}</span>
        <span class="grave-meta" title="Fallos · facilidad">💀×${Math.max(1, c.lapses || 0)} · ${(c.ease == null ? 2.5 : c.ease).toFixed(1)}</span>
      </div>`;
    }).join('') + (weak.length > 8 ? `<p class="hint">…y ${weak.length - 8} más.</p>` : '');
  }

  const last = exam && (exam.mocks || []).slice(-1)[0];
  const lastEl = document.getElementById('mockLast');
  if (lastEl) lastEl.textContent = last
    ? `Último simulacro: nota ${last.grade.toFixed(1)} (${last.points}/${last.total}) · ${formatDisplayDate(last.date)}`
    : '';
}

// ============================================
// SIMULACRO DE EXAMEN (10 minutos, nota de 1 a 10)
// ============================================

const MOCK_SECONDS = 10 * 60;
let mockState = { phase: 'idle', examId: null, items: [], results: [], startedAt: 0, endAt: 0, elapsed: 0, timerId: null, committed: true };

const fmtClock = sec => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;

function startMock() {
  const exam = selectedMemoExam();
  if (!exam) return toast('Elegí un examen primero');
  const built = SM.buildMockExam(exam.cards || []);
  if (built.items.length < 3) {
    return toast('Para un simulacro necesitás al menos 3 tarjetas de tipo V/F, opción múltiple o preguntas. Cargá más apuntes.');
  }
  clearInterval(mockState.timerId);
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
  document.querySelector('.mode-btn[data-mode="mock"]')?.classList.add('active');
  document.getElementById('memoCard').classList.add('hidden');   // desactiva los atajos del teclado de práctica

  const now = Date.now();
  mockState = {
    phase: 'running', examId: exam.id, items: built.items, spec: built.spec, wanted: built.wanted,
    results: [], startedAt: now, endAt: now + MOCK_SECONDS * 1000, elapsed: 0, committed: false,
    timerId: setInterval(tickMock, 500)
  };
  renderMockExam();
  document.getElementById('mockCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (built.items.length < built.wanted) {
    toast(`Armé un simulacro de ${built.items.length} preguntas (no había suficientes tarjetas para ${built.wanted}).`, 4000);
  }
}

function tickMock() {
  if (mockState.phase !== 'running') return clearInterval(mockState.timerId);
  const left = Math.max(0, Math.ceil((mockState.endAt - Date.now()) / 1000));
  const clock = document.getElementById('mockClock');
  if (clock) {
    clock.textContent = fmtClock(left);
    clock.classList.toggle('warn', left <= 60);
  }
  if (left <= 0) finishMock(true);
}

function renderMockExam() {
  const exam = store.exams.find(e => e.id === mockState.examId);
  const box = document.getElementById('mockCard');
  box.classList.remove('hidden');
  const titles = { tf: 'Parte A · Verdadero o Falso', mc: 'Parte B · Opción múltiple', open: 'Parte C · Desarrollo' };

  let html = `
    <div class="mock-head">
      <div>
        <h3 class="card-title">🎓 Simulacro — ${esc(exam ? exam.subject : '')}</h3>
        <p class="card-desc">${mockState.items.length} preguntas · cada una vale 1 punto · nota final de 1 a 10</p>
      </div>
      <div class="mock-clock" id="mockClock" role="timer" aria-label="Tiempo restante">${fmtClock(MOCK_SECONDS)}</div>
    </div>`;

  let lastKind = null;
  mockState.items.forEach((it, i) => {
    if (it.kind !== lastKind) { html += `<h4 class="mock-part">${titles[it.kind]}</h4>`; lastKind = it.kind; }
    html += `<div class="mock-q"><div class="question">${i + 1}. ${esc(it.prompt)}</div>`;
    if (it.kind === 'tf') {
      html += `<label class="mock-opt"><input type="radio" name="mq${i}" value="1"> Verdadero</label>
               <label class="mock-opt"><input type="radio" name="mq${i}" value="0"> Falso</label>`;
    } else if (it.kind === 'mc') {
      html += it.options.map((o, k) => `<label class="mock-opt"><input type="radio" name="mq${i}" value="${k}"> ${esc(o)}</label>`).join('');
    } else {
      html += `<textarea id="mockOpen${i}" rows="3" maxlength="800" placeholder="Escribí tu respuesta con tus palabras…"></textarea>`;
    }
    html += '</div>';
  });

  html += `<div class="btn-row" style="margin-top:1rem">
      <button class="btn primary" onclick="submitMock()">Entregar examen</button>
      <button class="btn danger" onclick="abortMock()">Abandonar</button>
    </div>`;
  box.innerHTML = html;
}

/** Lee lo que respondió el alumno: V/F → true/false/null · opción → índice/null · abierta → texto. */
function collectMockAnswers() {
  return mockState.items.map((it, i) => {
    if (it.kind === 'open') return (document.getElementById('mockOpen' + i)?.value || '').trim();
    const sel = document.querySelector(`input[name="mq${i}"]:checked`);
    if (!sel) return null;
    return it.kind === 'tf' ? sel.value === '1' : parseInt(sel.value, 10);
  });
}

function submitMock() {
  if (mockState.phase !== 'running') return;
  const blanks = collectMockAnswers().filter(a => a === null || a === '').length;
  if (blanks && !confirm(`Te quedan ${blanks} pregunta${blanks > 1 ? 's' : ''} sin responder. ¿Entregar igual?`)) return;
  finishMock(false);
}

function finishMock(timeUp) {
  if (mockState.phase !== 'running') return;
  clearInterval(mockState.timerId);
  const answers = collectMockAnswers();
  mockState.elapsed = Math.min(MOCK_SECONDS, Math.round((Date.now() - mockState.startedAt) / 1000));
  mockState.results = mockState.items.map((it, i) => {
    const given = answers[i];
    let points = 0;
    if (it.kind === 'tf') points = given === it.correct ? 1 : 0;
    else if (it.kind === 'mc') points = given === it.correctIndex ? 1 : 0;
    else points = SM.scoreOpen(given, it.answer);   // sugerencia automática: el alumno la puede corregir
    return { given, points };
  });
  mockState.phase = 'review';
  mockState.committed = false;
  if (timeUp) toast('⏰ ¡Se acabó el tiempo! Se entregó lo que tenías.', 4000);
  renderMockReview();
  document.getElementById('mockCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function mockTotals() {
  const points = mockState.results.reduce((s, r) => s + r.points, 0);
  const total = mockState.items.length;
  return { points, total, grade: SM.gradeFromScore(points, total) };
}

function mockSummaryHtml() {
  const { points, total, grade } = mockTotals();
  const exam = store.exams.find(e => e.id === mockState.examId);
  const goal = exam && exam.goal;
  const goalLine = goal
    ? (grade >= goal ? `✅ ¡Superaste tu objetivo de ${goal}!` : `Te faltaron ${(goal - grade).toFixed(1)} para tu objetivo de ${goal}.`)
    : '';
  return `
    <div class="mock-grade ${grade >= 6 ? 'pass' : 'fail'}">${grade.toFixed(1)}</div>
    <div class="mock-grade-info">
      <strong>${points} de ${total} puntos</strong>
      <span>${goalLine}</span>
      <small>Tiempo usado: ${fmtClock(mockState.elapsed)}</small>
    </div>`;
}

function renderMockReview() {
  const box = document.getElementById('mockCard');
  const yn = v => v === null || v === '' || v === undefined ? '<em>Sin responder</em>' : v;
  let html = `
    <h3 class="card-title">🎓 Resultado del simulacro</h3>
    <div class="mock-result" id="mockSummary">${mockSummaryHtml()}</div>`;

  mockState.items.forEach((it, i) => {
    const r = mockState.results[i];
    let detail = '';
    if (it.kind === 'tf') {
      detail = `<p>Tu respuesta: <strong>${r.given === null ? yn(null) : (r.given ? 'Verdadero' : 'Falso')}</strong> · Correcta: <strong>${it.correct ? 'Verdadero' : 'Falso'}</strong></p>`;
    } else if (it.kind === 'mc') {
      detail = `<p>Tu respuesta: <strong>${r.given === null ? yn(null) : esc(it.options[r.given])}</strong></p>
                <p>Correcta: <strong>${esc(it.options[it.correctIndex])}</strong></p>`;
    } else {
      detail = `<p>Tu respuesta: ${r.given ? esc(r.given) : yn(null)}</p>
                <p>Respuesta modelo: <strong>${esc(it.answer)}</strong></p>
                <div class="self-grade" id="sg${i}">
                  <span>Autoevaluación:</span>
                  ${[[0, '✗ 0'], [0.5, '½'], [1, '✓ 1']].map(([v, l]) =>
                    `<button type="button" class="chip ${r.points === v ? 'active' : ''}" data-v="${v}" onclick="setMockOpenGrade(${i}, ${v})">${l}</button>`).join('')}
                  <small class="hint">La sugerencia sale de comparar palabras clave; ajustala con honestidad.</small>
                </div>`;
    }
    if (it.explanation) detail += `<p class="hint">💡 ${esc(it.explanation)}</p>`;
    html += `<div class="mock-q review">
        <div class="question"><span id="mockIcon${i}">${mockIcon(it, r)}</span> ${i + 1}. ${esc(it.prompt)}</div>${detail}
      </div>`;
  });

  html += `<div class="btn-row" style="margin-top:1rem">
      <button class="btn primary" onclick="closeMock()">Guardar y cerrar</button>
      <button class="btn" onclick="retryMock()">Guardar y hacer otro simulacro</button>
    </div>
    <p class="hint">Al guardar, tus respuestas actualizan el repaso espaciado y tus puntos débiles.</p>`;
  box.innerHTML = html;
}

const mockIcon = (it, r) => r.points >= 1 ? '✅' : r.points > 0 ? '🟡' : '❌';

function setMockOpenGrade(i, v) {
  if (mockState.phase !== 'review' || mockState.committed) return;
  mockState.results[i].points = v;
  document.querySelectorAll(`#sg${i} .chip`).forEach(c => c.classList.toggle('active', parseFloat(c.dataset.v) === v));
  document.getElementById('mockIcon' + i).textContent = mockIcon(mockState.items[i], mockState.results[i]);
  document.getElementById('mockSummary').innerHTML = mockSummaryHtml();
}

/** Aplica el resultado al repaso espaciado, estadísticas y racha. */
function commitMock(silent) {
  if (mockState.phase !== 'review' || mockState.committed) return;
  const exam = store.exams.find(e => e.id === mockState.examId);
  mockState.committed = true;
  if (!exam) return;

  mockState.items.forEach((it, i) => {
    const ok = mockState.results[i].points >= 0.5;
    const real = (exam.cards || []).find(c => c.id === it.cardId);
    if (real) reviewCard(real, ok);
    exam.stats.total = (exam.stats.total || 0) + 1;
    if (ok) exam.stats.correct = (exam.stats.correct || 0) + 1;
    recordAccuracy(ok);
    const topic = exam.topics.find(t => t.id === it.topicId);
    if (topic) topic.mastery = Math.min(100, Math.max(0, (topic.mastery || 0) + (ok ? 6 : -4)));
  });

  const { points, total, grade } = mockTotals();
  exam.mocks = (exam.mocks || []).concat({ date: formatDateISO(new Date()), grade, points, total, secs: mockState.elapsed }).slice(-20);

  const mins = Math.max(1, Math.round(mockState.elapsed / 60));
  recordStudyMins(mins);
  exam.stats.studiedMins = (exam.stats.studiedMins || 0) + mins;

  updateStreak();
  unlockAchievements();
  saveStore();
  renderGraveyard();
  if (!silent) toast(`Simulacro guardado: nota ${grade.toFixed(1)} ✓`);
}

function closeMock() {
  commitMock(false);
  mockState.phase = 'idle';
  document.getElementById('mockCard').classList.add('hidden');
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
}

function retryMock() {
  commitMock(false);
  mockState.phase = 'idle';
  startMock();
}

function abortMock(silent) {
  if (!silent && mockState.phase === 'running' && !confirm('¿Abandonar el simulacro? No se guardará nada.')) return;
  clearInterval(mockState.timerId);
  mockState.phase = 'idle';
  mockState.committed = true;
  document.getElementById('mockCard').classList.add('hidden');
  document.querySelectorAll('.mode-btn').forEach(b => b.classList.remove('active'));
}

// ============================================
// IMPORTAR UN MAZO RECIBIDO EN UNA SALA
// ============================================

/**
 * Agrega a store.exams un mazo ya sanitizado (ver StudyRooms.sanitizeDeck).
 * Se crean IDs nuevos y el progreso empieza de cero: solo viaja el contenido.
 */
function importSharedDeck(deck) {
  if (!deck || !Array.isArray(deck.cards) || !deck.cards.length || !Array.isArray(deck.topics) || !deck.topics.length) {
    return { ok: false };
  }
  const today = formatDateISO(new Date());
  const idMap = new Map();
  const topics = deck.topics.map(t => {
    const id = uid();
    idMap.set(t.ref, id);
    return { id, name: t.name, difficulty: t.difficulty, mastery: 0 };
  });

  // Fecha: si la del mazo ya pasó (o no vino), se pone en 14 días para que el plan tenga sentido
  let date = deck.date;
  if (!date || date < today) {
    const d = new Date(); d.setDate(d.getDate() + 14);
    date = formatDateISO(d);
  }
  let name = deck.name;
  if (store.exams.some(e => e.subject === deck.subject && e.name === name)) name += ' (importado)';

  const cards = deck.cards.map(c => {
    const { topicRef, ...rest } = c;
    return { ...rest, id: uid(), topicId: idMap.get(topicRef) || topics[0].id, interval: 1, ease: 2.5, reps: 0, nextReview: today };
  });

  const exam = {
    id: uid(), subject: deck.subject, name, date, time: deck.time || '08:00',
    dailyMins: deck.dailyMins || 60, goal: deck.goal || 7,
    topics, plan: [], cards, stats: { correct: 0, total: 0, studiedMins: 0 }
  };
  exam.plan = generatePlan(exam);
  store.exams.push(exam);
  saveStore();
  return { ok: true, cards: cards.length, name };
}

// ============================================
// POMODORO GRUPAL (sincronización con la sala)
// ============================================

/** Foto del temporizador local para enviarla a los invitados. */
function timerSnapshot(kind) {
  return {
    kind, totalSec: timer.totalSec, remaining: timer.remaining,
    isBreak: timer.isBreak, breakKind: timer.breakKind, focusInSet: timer.focusInSet
  };
}

/** Estado actual para quien se une tarde a la sala (null si no está corriendo). */
function currentTimerSnapshot() {
  return timer.running ? timerSnapshot('start') : null;
}

/** Aplica un evento del anfitrión. Valida todo: viene de otra persona. Devuelve true si lo aplicó. */
function applyTimerSnapshot(s) {
  if (!s || typeof s !== 'object' || !['start', 'pause', 'reset'].includes(s.kind)) return false;
  const okSec = v => Number.isFinite(v) && v >= 0 && v <= 4 * 3600;

  clearInterval(timer.interval);
  timer.running = false;

  if (s.kind === 'reset') {
    timerReset();
    return true;
  }
  if (!okSec(s.totalSec) || !okSec(s.remaining) || s.totalSec < 1) return false;
  timer.totalSec = Math.floor(s.totalSec);
  timer.remaining = Math.floor(Math.min(s.remaining, s.totalSec));
  timer.isBreak = s.isBreak === true;
  timer.breakKind = s.breakKind === 'long' ? 'long' : 'short';
  timer.focusInSet = Number.isInteger(s.focusInSet) ? Math.min(3, Math.max(0, s.focusInSet)) : 0;
  updateTimerUI();
  if (s.kind === 'start') timerStart();
  return true;
}

// ============================================
// MODO POCO TIEMPO
// ============================================

function quickStudy(mins) {
  document.querySelectorAll('#quickTimeChips .chip').forEach(c => c.classList.remove('active'));
  document.querySelector(`#quickTimeChips .chip[data-mins="${mins}"]`)?.classList.add('active');

  const exam = getNextExam();
  const box = document.getElementById('quickStudyResult');
  if (!exam) {
    box.classList.remove('hidden');
    box.innerHTML = '<p>No hay exámenes próximos.</p>';
    return;
  }

  // Priorizar difíciles y bajo mastery
  const ranked = [...exam.topics].sort((a, b) => {
    const score = (t) => diffWeight(t.difficulty) * 10 + (100 - (t.mastery || 0));
    return score(b) - score(a);
  });

  let left = mins;
  const picks = [];
  for (const t of ranked) {
    if (left < 8) break;
    const slot = Math.min(left, t.difficulty === 'dificil' ? 20 : 15);
    picks.push({ name: t.name, mins: slot, diff: t.difficulty });
    left -= slot;
  }

  box.classList.remove('hidden');
  box.innerHTML = `
    <h4>Plan de ${mins} minutos — ${esc(exam.subject)}</h4>
    <ul>
      ${picks.map(p => `<li><strong>${esc(p.name)}</strong> (${p.mins} min) <span class="diff-tag diff-${safeDiff(p.diff)}">${esc(safeDiff(p.diff))}</span></li>`).join('')}
    </ul>
    <button class="btn primary btn-sm" style="margin-top:0.75rem" onclick="startStudyForExam('${esc(exam.id)}')">Empezar ahora</button>
  `;
}

// ============================================
// TIMER DE ENFOQUE
// ============================================

let timer = {
  totalSec: 15 * 60,
  remaining: 15 * 60,
  running: false,
  interval: null,
  isBreak: false,
  breakKind: 'short',
  focusInSet: 0
};

function renderTimerSelects() {
  const sel = document.getElementById('timerExamSelect');
  sel.innerHTML = '<option value="">— Ninguno —</option>' +
    store.exams.map(e => `<option value="${esc(e.id)}">${esc(e.subject)} — ${esc(e.name)}</option>`).join('');
}

function setTimerPreset(mins) {
  document.querySelectorAll('.timer-presets .chip').forEach(c => c.classList.remove('active'));
  document.querySelector(`.timer-presets .chip[data-timer="${mins}"]`)?.classList.add('active');
  if (timer.running) return;
  timer.totalSec = mins * 60;
  timer.remaining = mins * 60;
  timer.isBreak = false;
  timer.breakKind = 'short';
  updateTimerUI();
}

function updateTimerUI() {
  const m = Math.floor(timer.remaining / 60);
  const s = timer.remaining % 60;
  document.getElementById('timerDisplay').textContent =
    `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  document.getElementById('timerStatus').textContent = timer.isBreak
    ? (timer.breakKind === 'long' ? '☕ Descanso largo — 15 min' : '☕ Descanso corto — 5 min')
    : timer.running ? '🔥 Concentración en curso' : 'Listo para empezar';
  const cycleEl = document.getElementById('pomodoroCycles');
  if (cycleEl) {
    const n = timer.focusInSet;
    const dots = [0, 1, 2, 3].map(i => i < n ? '●' : '○').join(' ');
    cycleEl.textContent = `${dots}  Ciclo Pomodoro ${n} / 4 · Descanso largo cada 4 sesiones`;
  }
  document.getElementById('timerStart').disabled = timer.running;
  document.getElementById('timerPause').disabled = !timer.running;
  document.getElementById('timerEnd').disabled = !timer.running && timer.remaining === timer.totalSec;
}

function timerStart() {
  if (timer.running) return;
  timer.running = true;
  updateTimerUI();
  window.StudyRooms?.notifyTimer(timerSnapshot('start'));   // Pomodoro grupal: avisa a los invitados (solo si soy anfitrión)
  timer.interval = setInterval(() => {
    timer.remaining--;
    updateTimerUI();
    if (timer.remaining <= 0) {
      clearInterval(timer.interval);
      timer.running = false;
      if (!timer.isBreak) {
        const studied = Math.round(timer.totalSec / 60);
        const examId = document.getElementById('timerExamSelect').value;
        if (examId) {
          const ex = store.exams.find(e => e.id === examId);
          if (ex) {
            ex.stats.studiedMins = (ex.stats.studiedMins || 0) + studied;
          }
        }
        recordStudyMins(studied);
        timer.focusInSet = (timer.focusInSet % 4) + 1;
        store.progress.pomodoroCycles = (store.progress.pomodoroCycles || 0) + 1;
        updateStreak();
        unlockAchievements();
        saveStore();
        const longBreak = timer.focusInSet === 4;
        const breakMins = longBreak ? 15 : 5;
        toast(longBreak
          ? `¡Ciclo de 4 sesiones! Descanso largo de ${breakMins} min.`
          : `¡Sesión de ${studied} min completada! Descanso de ${breakMins} min.`);
        if (longBreak) timer.focusInSet = 0;
        timer.isBreak = true;
        timer.breakKind = longBreak ? 'long' : 'short';
        timer.totalSec = breakMins * 60;
        timer.remaining = breakMins * 60;
        timerStart();
      } else {
        toast(timer.breakKind === 'long' ? 'Descanso largo terminado. ¡Nuevo ciclo!' : 'Descanso terminado. ¡A seguir!');
        timer.isBreak = false;
        timer.breakKind = 'short';
        const preset = document.querySelector('.timer-presets .chip.active');
        const mins = preset ? parseInt(preset.dataset.timer) : 15;
        timer.totalSec = mins * 60;
        timer.remaining = mins * 60;
        updateTimerUI();
      }
    }
  }, 1000);
}

function timerPause() {
  clearInterval(timer.interval);
  timer.running = false;
  updateTimerUI();
  window.StudyRooms?.notifyTimer(timerSnapshot('pause'));
}

function timerReset() {
  clearInterval(timer.interval);
  timer.running = false;
  timer.isBreak = false;
  timer.breakKind = 'short';
  const preset = document.querySelector('.timer-presets .chip.active');
  const mins = preset ? parseInt(preset.dataset.timer) : 15;
  timer.totalSec = mins * 60;
  timer.remaining = mins * 60;
  updateTimerUI();
  window.StudyRooms?.notifyTimer(timerSnapshot('reset'));
}

function timerEnd() {
  clearInterval(timer.interval);
  const studied = Math.round((timer.totalSec - timer.remaining) / 60);
  if (studied > 0 && !timer.isBreak) {
    recordStudyMins(studied);
    const examId = document.getElementById('timerExamSelect').value;
    if (examId) {
      const ex = store.exams.find(e => e.id === examId);
      if (ex) ex.stats.studiedMins = (ex.stats.studiedMins || 0) + studied;
    }
    updateStreak();
    unlockAchievements();
    saveStore();
    toast(`Sesión finalizada: ${studied} min registrados`);
  }
  timerReset();
}

// ============================================
// PROGRESO
// ============================================

function renderProgreso() {
  const totalCorrect = store.exams.reduce((s, e) => s + (e.stats?.correct || 0), 0);
  const totalQ = store.exams.reduce((s, e) => s + (e.stats?.total || 0), 0);
  const avgPrep = store.exams.length
    ? Math.round(store.exams.reduce((s, e) => s + examPrepPercent(e), 0) / store.exams.length)
    : 0;

  let dominated = 0, pending = 0, hard = 0;
  store.exams.forEach(ex => {
    ex.topics.forEach(t => {
      if ((t.mastery || 0) >= 70) dominated++;
      else pending++;
      if (t.difficulty === 'dificil') hard++;
    });
  });

  document.getElementById('statsGrid').innerHTML = `
    <div class="stat-card"><div class="value">${avgPrep}%</div><div class="label">Preparación total</div></div>
    <div class="stat-card"><div class="value">${dominated}</div><div class="label">Temas dominados</div></div>
    <div class="stat-card"><div class="value">${pending}</div><div class="label">Temas pendientes</div></div>
    <div class="stat-card"><div class="value">${hard}</div><div class="label">Temas difíciles</div></div>
    <div class="stat-card"><div class="value">${totalCorrect}/${totalQ}</div><div class="label">Respuestas correctas</div></div>
    <div class="stat-card"><div class="value">${store.progress.totalMins || 0}</div><div class="label">Minutos estudiados</div></div>
    <div class="stat-card"><div class="value">${store.progress.streak || 0}</div><div class="label">Racha de días</div></div>
  `;

  const topicsBox = document.getElementById('topicsProgress');
  let html = '';
  store.exams.forEach(ex => {
    html += `<h4 style="margin:1rem 0 0.5rem;color:var(--primary)">${esc(ex.subject)} — ${esc(ex.name)}</h4>`;
    ex.topics.forEach(t => {
      const m = t.mastery || 0;
      html += `
        <div class="topic-progress-item">
          <span class="diff-tag diff-${safeDiff(t.difficulty)}">${esc(safeDiff(t.difficulty))}</span>
          <span class="name">${esc(t.name)}</span>
          <div class="bar-wrap"><div class="bar-fill" style="width:${m}%"></div></div>
          <span style="font-weight:700;min-width:36px">${m}%</span>
        </div>`;
    });
  });
  topicsBox.innerHTML = html || '<p class="empty-state">Sin temas aún.</p>';

  renderProgressCharts();
  renderAchievements();
}

let chartMinsInst = null;
let chartLearnInst = null;

function lastNDays(n) {
  const days = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(formatDateISO(d));
  }
  return days;
}

function renderProgressCharts() {
  if (typeof Chart === 'undefined') return;
  const days = lastNDays(7);
  const labels = days.map(ds => parseDate(ds).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric' }));
  const mins = days.map(ds => store.progress.dailyMins?.[ds] || 0);
  const acc = days.map(ds => {
    const d = store.progress.accuracyByDay?.[ds];
    if (!d || !d.total) return null;
    return Math.round((d.correct / d.total) * 100);
  });

  const grid = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#e2e8f0';
  const primary = getComputedStyle(document.documentElement).getPropertyValue('--primary').trim() || '#6366f1';
  const muted = getComputedStyle(document.documentElement).getPropertyValue('--text-muted').trim() || '#64748b';

  const common = {
    plugins: { legend: { display: false } },
    scales: {
      x: { ticks: { color: muted }, grid: { color: grid } },
      y: { beginAtZero: true, ticks: { color: muted }, grid: { color: grid } }
    }
  };

  const minsCanvas = document.getElementById('chartMins');
  const learnCanvas = document.getElementById('chartLearn');
  if (chartMinsInst) chartMinsInst.destroy();
  if (chartLearnInst) chartLearnInst.destroy();
  if (minsCanvas) {
    chartMinsInst = new Chart(minsCanvas, {
      type: 'bar',
      data: { labels, datasets: [{ data: mins, backgroundColor: primary, borderRadius: 8 }] },
      options: { ...common, scales: { ...common.scales, y: { ...common.scales.y, title: { display: true, text: 'minutos', color: muted } } } }
    });
  }
  if (learnCanvas) {
    chartLearnInst = new Chart(learnCanvas, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: acc,
          borderColor: primary,
          backgroundColor: 'transparent',
          tension: 0.35,
          spanGaps: true,
          pointRadius: 4,
          pointBackgroundColor: primary
        }]
      },
      options: { ...common, scales: { ...common.scales, y: { ...common.scales.y, max: 100, title: { display: true, text: '% aciertos', color: muted } } } }
    });
  }
}

function renderAchievements() {
  const box = document.getElementById('achievementsGrid');
  if (!box) return;
  const unlocked = new Set(store.progress.achievements || []);
  box.innerHTML = ACHIEVEMENTS.map(a => `
    <div class="achievement ${unlocked.has(a.id) ? 'unlocked' : ''}">
      <span class="ach-icon">${a.icon}</span>
      <strong>${a.name}</strong>
      <small>${a.desc}</small>
    </div>
  `).join('');
}

function updateStreak() {
  const today = formatDateISO(new Date());
  const last = store.progress.lastStudyDate;
  if (last === today) return;
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (last === formatDateISO(yesterday)) {
    store.progress.streak = (store.progress.streak || 0) + 1;
  } else {
    store.progress.streak = 1;
  }
  store.progress.lastStudyDate = today;
  document.getElementById('streakCount').textContent = store.progress.streak;
}

// ============================================
// APUNTES
// ============================================

function renderApuntesSelects() {
  const sel = document.getElementById('notesExamSelect');
  sel.innerHTML = store.exams.map(e =>
    `<option value="${esc(e.id)}">${esc(e.subject)} — ${esc(e.name)}</option>`
  ).join('') || '<option value="">Sin exámenes</option>';
}

const sourceBadge = src => src && src.kind === 'web'
  ? `<a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.title)} (Wikipedia)</a>` : '';

/** Agrega tarjetas al examen evitando repetidas. Devuelve cuántas se agregaron por tipo. */
function addCardsToExam(exam, cards) {
  const keyOf = c => (c.front || c.question || c.statement || '').toLowerCase().trim();
  const existing = new Set(exam.cards.map(keyOf));
  const added = { flashcard: 0, qa: 0, tf: 0, mc: 0 };
  cards.forEach(c => {
    const k = keyOf(c);
    if (!k || existing.has(k)) return;
    existing.add(k);
    exam.cards.push(c);
    added[c.type] = (added[c.type] || 0) + 1;
  });
  return added;
}

function setNotesStatus(msg) {
  const el = document.getElementById('notesStatus');
  if (el) el.textContent = msg || '';
}

function renderMaterial(blocks, totals, warnings) {
  const out = document.getElementById('notesOutput');
  const totalN = Object.values(totals).reduce((a, b) => a + b, 0);
  let html = '';
  blocks.forEach(b => {
    html += `<div class="${b.source && b.source.kind === 'web' ? 'notes-source' : 'notes-block'}">`;
    html += `<h4>${b.source && b.source.kind === 'web' ? '🌐 Internet: ' + esc(b.label) : '📝 De tus apuntes'}</h4>`;
    if (b.source && b.source.kind === 'web') html += `<p class="hint" style="margin-top:0">Fuente: ${sourceBadge(b.source)}. Verificá siempre con tu libro o carpeta.</p>`;
    if (b.material.explanation && b.material.explanation.length) {
      html += `<h5 style="margin:.6rem 0 .3rem">Explicación</h5>`;
      b.material.explanation.forEach(p => { html += `<p style="margin:0.35rem 0;line-height:1.45">${esc(p)}</p>`; });
    }
    if (b.material.summary && b.material.summary.length) html += `<h5 style="margin:.6rem 0 .3rem">Resumen</h5><ul>${b.material.summary.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
    if (b.material.definitions && b.material.definitions.length) html += `<h5 style="margin:.6rem 0 .3rem">Definiciones clave</h5><ul>${b.material.definitions.slice(0, 6).map(d => `<li><strong>${esc(d.term)}</strong>: ${esc(d.def)}</li>`).join('')}</ul>`;
    if (b.material.keywords && b.material.keywords.length) html += `<h5 style="margin:.6rem 0 .3rem">Conceptos clave</h5><p>${b.material.keywords.map(k => `<span class="badge">${esc(k)}</span>`).join(' ')}</p>`;
    html += '</div>';
  });
  warnings.forEach(w => { html += `<p class="hint">⚠️ ${esc(w)}</p>`; });
  html += `<p class="memo-feedback">✓ Se agregaron <strong>${totalN}</strong> tarjetas nuevas al examen: ` +
    `${totals.flashcard} flashcards, ${totals.qa} preguntas abiertas, ${totals.tf} verdadero/falso y ${totals.mc} opción múltiple. ` +
    `Practicalas en <strong>Memorizar</strong>.</p>`;
  out.innerHTML = html;
  document.getElementById('notesResult').classList.remove('hidden');
}

async function generateFromNotes() {
  const text = document.getElementById('notesText').value.trim();
  const useWeb = document.getElementById('notesUseWeb').checked;
  const examId = document.getElementById('notesExamSelect').value;
  const exam = store.exams.find(e => e.id === examId);

  if (!exam) { toast('Primero creá un examen y elegilo acá'); return; }
  const hasText = text.length >= 40;
  if (!hasText && !useWeb) { toast('Pegá tus apuntes (al menos un párrafo) o activá la búsqueda en internet'); return; }
  if (!hasText && text.length > 0) { toast('Tus apuntes son muy cortos; agregá más contenido'); return; }

  const btn = document.getElementById('btnGenerateNotes');
  btn.disabled = true;
  const blocks = [], warnings = [];
  const totals = { flashcard: 0, qa: 0, tf: 0, mc: 0 };
  const tally = added => Object.keys(added).forEach(k => totals[k] = (totals[k] || 0) + added[k]);

  try {
    // 1) Apuntes del usuario
    if (hasText) {
      setNotesStatus('Analizando tus apuntes…');
      const extraTerms = (exam.topics || []).map(t => t.name);
      const fromOcr = !!window._mindfocusLastNotesFromOcr || (typeof SM.looksLikeOcr === 'function' && SM.looksLikeOcr(text));
      let material = SM.generate(text, {
        topics: exam.topics, maxCards: 40, source: { kind: 'apuntes' }, extraTerms,
        ocr: fromOcr
      });
      window._mindfocusLastNotesFromOcr = false;
      material = await SM.enhanceWithAI(material, { exam });
      if (material.warning) warnings.push(material.warning);
      tally(addCardsToExam(exam, material.cards));
      blocks.push({ source: { kind: 'apuntes' }, label: 'Tus apuntes', material });
    }

    // 2) Internet: un artículo por cada tema del examen
    if (useWeb) {
      if (!exam.topics.length) warnings.push('Este examen no tiene temas cargados; agregalos para poder buscar en internet.');
      for (let i = 0; i < exam.topics.length; i++) {
        const topic = exam.topics[i];
        setNotesStatus(`Buscando en internet (${i + 1}/${exam.topics.length}): ${topic.name}…`);
        try {
          const art = await SM.findArticleForTopic(topic.name, exam.subject);
          if (!art) { warnings.push(`No encontré un artículo confiable para “${topic.name}”. Probá con la búsqueda manual de abajo.`); continue; }
          const source = { kind: 'web', title: art.title, url: art.url };
          const material = SM.generate(art.text, {
            topic, topics: exam.topics, maxCards: 12, source, stripParens: true,
            contextLabel: topic.name, maxKeywords: 8, ocr: false,
            extraTerms: (exam.topics || []).map(t => t.name)
          });
          tally(addCardsToExam(exam, material.cards));
          blocks.push({ source, label: topic.name, material });
        } catch (err) {
          console.warn('Búsqueda web falló', err);
          warnings.push('No pude conectarme a internet. Se usaron solo tus apuntes (si había). Revisá tu conexión e intentá de nuevo.');
          break;
        }
      }
    }

    if (!blocks.length) { setNotesStatus(''); toast('No se pudo generar material'); renderMaterial([], totals, warnings); return; }
    saveStore();
    renderMaterial(blocks, totals, warnings);
    setNotesStatus('');
    unlockAchievements();
    saveStore();
    toast('Material generado');
  } finally {
    btn.disabled = false;
    setNotesStatus('');
  }
}

/** Búsqueda manual: el usuario elige el artículo correcto. */
async function webSearchManual() {
  const q = document.getElementById('webQuery').value.trim();
  const box = document.getElementById('webResults');
  if (q.length < 2) { toast('Escribí un tema para buscar'); return; }
  box.innerHTML = '<p class="hint">Buscando…</p>';
  try {
    const res = await SM.wikiSearch(q, 5);
    if (!res.length) { box.innerHTML = '<p class="hint">No encontré resultados. Probá con otras palabras.</p>'; return; }
    box.innerHTML = res.map((r, i) => `
      <div class="web-result">
        <div class="info">
          <strong>${esc(r.title)}</strong>
          <small>${esc(r.snippet)}…</small>
          <small><a href="${esc(r.url)}" target="_blank" rel="noopener">Ver en Wikipedia ↗</a></small>
        </div>
        <button class="btn primary btn-sm" data-i="${i}">Usar este</button>
      </div>`).join('');
    box.querySelectorAll('button[data-i]').forEach(btn => btn.addEventListener('click', () => useWebArticle(res[+btn.dataset.i], btn)));
  } catch (e) {
    console.warn(e);
    box.innerHTML = '<p class="hint">⚠️ No pude conectarme a internet. Revisá tu conexión e intentá de nuevo.</p>';
  }
}

async function useWebArticle(r, btn) {
  const examId = document.getElementById('notesExamSelect').value;
  const exam = store.exams.find(e => e.id === examId);
  if (!exam) { toast('Primero creá un examen y elegilo arriba'); return; }
  btn.disabled = true; btn.textContent = 'Procesando…';
  try {
    const art = await SM.wikiExtract(r.title);
    if (!art || art.text.length < 200) { toast('Ese artículo es demasiado corto'); return; }
    const topicId = SM.assignTopic(r.title, exam.topics);
    const topic = exam.topics.find(t => t.id === topicId);
    const source = { kind: 'web', title: art.title, url: art.url };
    const material = SM.generate(art.text, {
      topic: topic || null, topics: exam.topics, maxCards: 12, source, stripParens: true,
      contextLabel: art.title, maxKeywords: 8, ocr: false,
      extraTerms: (exam.topics || []).map(t => t.name)
    });
    const added = addCardsToExam(exam, material.cards);
    saveStore();
    unlockAchievements();
    saveStore();
    renderMaterial([{ source, label: art.title, material }], { flashcard: 0, qa: 0, tf: 0, mc: 0, ...added }, material.warning ? [material.warning] : []);
    toast('Tarjetas agregadas');
    document.getElementById('notesResult').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    console.warn(e);
    toast('No pude descargar el artículo (¿sin internet?)');
  } finally {
    btn.disabled = false; btn.textContent = 'Usar este';
  }
}

// ============================================
// CONFIG
// ============================================

function renderConfig() {
  document.getElementById('cfgDailyMins').value = store.config.dailyMins || 60;
  document.getElementById('cfgReminders').checked = store.config.reminders !== false;
  document.getElementById('cfgDark').checked = !!store.config.dark;
  const cfgUser = document.getElementById('cfgUsername');
  if (cfgUser) cfgUser.value = store.config.username || store.config.nick || '';
  const p1 = document.getElementById('cfgNewPass');
  const p2 = document.getElementById('cfgNewPass2');
  if (p1) p1.value = '';
  if (p2) p2.value = '';
  renderStorageInfo();
}

/** Muestra dónde se guardan los datos y cuánto espacio usan. */
async function renderStorageInfo() {
  const el = document.getElementById('storageInfo');
  if (!el) return;
  const e = await SMStorage.estimate();
  const mb = n => n >= 1024 * 1024 * 1024 ? (n / 1024 / 1024 / 1024).toFixed(1) + ' GB' : (n / 1024 / 1024).toFixed(1) + ' MB';
  const where = e.mode === 'idb' ? 'IndexedDB' : 'localStorage (modo respaldo: este navegador no permite IndexedDB)';
  el.textContent = `Almacenamiento: ${where}` +
    (e.usage != null ? ` · usando ${mb(e.usage)}${e.quota ? ' de ~' + mb(e.quota) + ' disponibles' : ''}` : '') +
    (e.persisted ? ' · protegido contra borrado automático' : '');
}

function applyTheme() {
  if (store.config.dark) {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.getElementById('themeToggle').textContent = '☀️';
  } else {
    document.documentElement.removeAttribute('data-theme');
    document.getElementById('themeToggle').textContent = '🌙';
  }
}

// ============================================
// EVENTOS
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
  // 1) Cargar los datos (IndexedDB) antes de pintar nada
  await bootStore();

  // Perfil: registro / login local
  document.getElementById('registerForm').addEventListener('submit', async e => {
    e.preventDefault();
    showAuthError('regError', '');
    const u = document.getElementById('regUser').value;
    const p1 = document.getElementById('regPass').value;
    const p2 = document.getElementById('regPass2').value;
    if (p1 !== p2) { showAuthError('regError', 'Las contraseñas no coinciden'); return; }
    try {
      await registerProfile(u, p1);
      hideAuthScreen();
      finishAppInit();
      toast('Perfil creado. ¡Bienvenido/a, ' + store.config.username + '!');
    } catch (err) {
      showAuthError('regError', err.message || 'No se pudo crear el perfil');
    }
  });
  document.getElementById('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    showAuthError('loginError', '');
    try {
      const sel = document.getElementById('loginUserSelect');
      const user = (sel && sel.value) || document.getElementById('loginUserLabel')?.textContent || '';
      await loginProfile(user, document.getElementById('loginPass').value);
      hideAuthScreen();
      window._mindfocusAppReady = false; // forzar reinicio de UI con datos del usuario
      finishAppInit();
      toast('Hola, ' + store.config.username);
    } catch (err) {
      showAuthError('loginError', err.message || 'No se pudo ingresar');
    }
  });
  document.getElementById('loginUserSelect')?.addEventListener('change', e => {
    const label = document.getElementById('loginUserLabel');
    if (label) label.textContent = e.target.value || '';
  });
  document.getElementById('btnAuthLogout')?.addEventListener('click', () => {
    clearProfileAndStartOver();
  });
  document.getElementById('btnAuthNewUser')?.addEventListener('click', () => {
    showAuthScreen({ register: true });
  });

  // Nav
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => showSection(btn.dataset.section));
  });
  document.getElementById('menuToggle').addEventListener('click', openSidebar);
  document.getElementById('sidebarClose').addEventListener('click', closeSidebar);
  document.getElementById('overlay').addEventListener('click', closeSidebar);

  // Theme
  document.getElementById('themeToggle').addEventListener('click', () => {
    store.config.dark = !store.config.dark;
    saveStore();
    applyTheme();
  });

  // Nuevo examen
  document.getElementById('btnNewExam').addEventListener('click', () => openExamModal());
  document.getElementById('btnNewExam2').addEventListener('click', () => openExamModal());
  document.getElementById('examModalClose').addEventListener('click', closeExamModal);
  document.getElementById('examCancel').addEventListener('click', closeExamModal);

  document.getElementById('btnAddTopic').addEventListener('click', () => {
    const name = document.getElementById('topicName').value.trim();
    const diff = document.getElementById('topicDiff').value;
    if (!name) return toast('Escribí el nombre del tema');
    tempTopics.push({ id: uid(), name, difficulty: diff, mastery: 0 });
    document.getElementById('topicName').value = '';
    renderTempTopics();
  });

  document.getElementById('examForm').addEventListener('submit', e => {
    e.preventDefault();
    if (!tempTopics.length) {
      toast('Agregá al menos un tema');
      return;
    }
    const id = document.getElementById('examId').value || uid();
    const existing = store.exams.find(x => x.id === id);
    const exam = {
      id,
      subject: document.getElementById('examSubject').value.trim(),
      name: document.getElementById('examName').value.trim(),
      date: document.getElementById('examDate').value,
      time: document.getElementById('examTime').value,
      dailyMins: parseInt(document.getElementById('examDailyMins').value) || 60,
      goal: parseFloat(document.getElementById('examGoal').value) || 7,
      topics: tempTopics.map(t => ({ ...t, mastery: t.mastery || 0 })),
      plan: [],
      cards: existing?.cards || [],
      stats: existing?.stats || { correct: 0, total: 0, studiedMins: 0 }
    };
    exam.plan = generatePlan(exam);
    if (!exam.cards.length) exam.cards = generateCardsForExam(exam);

    if (existing) {
      const idx = store.exams.findIndex(x => x.id === id);
      store.exams[idx] = exam;
    } else {
      store.exams.push(exam);
    }
    saveStore();
    closeExamModal();
    toast('Examen guardado y plan creado ✓');
    showSection('materias');
  });

  // Quick time
  document.querySelectorAll('#quickTimeChips .chip').forEach(chip => {
    chip.addEventListener('click', () => quickStudy(parseInt(chip.dataset.mins)));
  });

  // Start study from home (puede no existir si renderInicio ya pintó empty-state)
  document.getElementById('btnStartStudy')?.addEventListener('click', () => {
    const ex = getNextExam();
    if (ex) startStudyForExam(ex.id);
    else toast('Creá un examen primero');
  });

  // Memo modes
  document.querySelectorAll('.mode-btn').forEach(btn => {
    btn.addEventListener('click', () => startMemo(btn.dataset.mode));
  });
  document.getElementById('memoExamSelect').addEventListener('change', renderGraveyard);
  document.getElementById('btnGraveyardStart').addEventListener('click', () => startMemo('weak'));

  // Timer
  document.querySelectorAll('.timer-presets .chip').forEach(chip => {
    chip.addEventListener('click', () => setTimerPreset(parseInt(chip.dataset.timer)));
  });
  document.getElementById('timerStart').addEventListener('click', timerStart);
  document.getElementById('timerPause').addEventListener('click', timerPause);
  document.getElementById('timerReset').addEventListener('click', timerReset);
  document.getElementById('timerEnd').addEventListener('click', timerEnd);

  // Cal
  document.getElementById('calPrev').addEventListener('click', () => {
    calCursor.setMonth(calCursor.getMonth() - 1);
    renderCalendario();
  });
  document.getElementById('calNext').addEventListener('click', () => {
    calCursor.setMonth(calCursor.getMonth() + 1);
    renderCalendario();
  });

  // Apuntes
  document.getElementById('btnGenerateNotes').addEventListener('click', generateFromNotes);
  document.getElementById('btnWebSearch').addEventListener('click', webSearchManual);
  document.getElementById('webQuery').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); webSearchManual(); } });
  document.getElementById('notesFile').addEventListener('change', e => {
    const file = e.target.files[0];
    if (!file) return;
    loadNotesFile(file);
  });
  const drop = document.getElementById('notesDropZone');
  if (drop) {
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault();
      drop.classList.add('dragover');
    }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, e => {
      e.preventDefault();
      drop.classList.remove('dragover');
    }));
    drop.addEventListener('drop', e => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) loadNotesFile(file);
    });
  }

  document.addEventListener('keydown', handleMemoKeys);

  // Config
  document.getElementById('btnSaveConfig').addEventListener('click', () => {
    store.config.dailyMins = parseInt(document.getElementById('cfgDailyMins').value) || 60;
    store.config.reminders = document.getElementById('cfgReminders').checked;
    store.config.dark = document.getElementById('cfgDark').checked;
    saveStore();
    applyTheme();
    toast('Preferencias guardadas');
  });
  document.getElementById('btnSaveProfile').addEventListener('click', async () => {
    const current = store.config.username || getSessionUser();
    if (!current || !profiles[current]) {
      toast('No hay sesión activa');
      return;
    }
    // El nombre de usuario identifica el almacén: no se cambia acá (creá otro perfil si hace falta)
    const p1 = document.getElementById('cfgNewPass').value;
    const p2 = document.getElementById('cfgNewPass2').value;
    if (p1 || p2) {
      if (p1.length < 4) { toast('La contraseña debe tener al menos 4 caracteres'); return; }
      if (p1 !== p2) { toast('Las contraseñas no coinciden'); return; }
      const { hash, salt } = await hashPassword(p1);
      profiles[current] = { passwordHash: hash, passwordSalt: salt };
      await SMStorage.saveProfiles(profiles);
      document.getElementById('cfgNewPass').value = '';
      document.getElementById('cfgNewPass2').value = '';
    }
    store.config.username = current;
    store.config.nick = current;
    store.config.passwordHash = '';
    store.config.passwordSalt = '';
    setSessionUser(current);
    saveStore();
    syncChatNickUI();
    toast(p1 ? 'Contraseña actualizada' : 'Perfil actualizado');
  });
  document.getElementById('btnLogout').addEventListener('click', () => {
    logoutProfile();
  });
  document.getElementById('btnExport').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'mindfocus-backup-' + (store.config.username || 'user') + '.json';
    a.click();
  });
  document.getElementById('btnExportAnki').addEventListener('click', exportAnkiCsv);
  document.getElementById('btnReset').addEventListener('click', async () => {
    if (!confirm('¿Borrar el perfil actual y todos SUS datos? Los otros usuarios de este navegador no se tocan.')) return;
    const u = store.config.username || getSessionUser();
    try {
      if (u) await SMStorage.clearUser(u);
      else await SMStorage.clear();
    } catch (_) { /* ignorar */ }
    if (u) delete profiles[u];
    setSessionUser('');
    store = getDefaultData();
    SMStorage.setActiveUser('');
    window._mindfocusAppReady = false;
    applyTheme();
    toast('Datos de este perfil borrados');
    try {
      const res = await SMStorage.load();
      profiles = res.profiles || {};
    } catch (_) { profiles = {}; }
    showAuthScreen({ register: listProfileNames().length === 0 });
  });

  // Init base (tema, etc.) antes de decidir si mostrar login
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  ensureProgressShape(store);
  applyTheme();

  if (!hasProfile() || !isLoggedIn()) {
    showAuthScreen();
    window._mindfocusPendingInit = true;
  } else {
    finishAppInit();
  }
});

/** Inicializa la UI principal una vez autenticado (también tras registro/login). */
function finishAppInit() {
  if (window._mindfocusAppReady) {
    syncChatNickUI();
    return;
  }
  window._mindfocusAppReady = true;
  window._mindfocusPendingInit = false;

  unlockAchievements(true);
  saveStore();
  document.getElementById('streakCount').textContent = store.progress.streak || 0;
  updateTimerUI();
  syncChatNickUI();

  // Salas de estudio (P2P)
  if (window.StudyRooms) {
    StudyRooms.init({
      getStore: () => store,
      saveStore,
      toast,
      importDeck: importSharedDeck,
      getTimerSnapshot: currentTimerSnapshot,
      applyTimerSnapshot
    });
  }

  const roomParam = window.StudyRooms ? StudyRooms.readRoomParam() : null;
  if (roomParam) {
    showSection('charlas');
    if (!store.config.nick && store.config.username) {
      store.config.nick = store.config.username;
      saveStore();
    }
    if (!store.config.nick) {
      store.config.nick = store.config.username || ('Estudiante-' + Math.floor(1000 + Math.random() * 9000));
      saveStore();
    }
    syncChatNickUI();
    const hk = typeof StudyRooms.readHostHashParam === 'function' ? StudyRooms.readHostHashParam() : null;
    StudyRooms.join(roomParam, { hostHash: hk });
  } else {
    showSection('inicio');
  }
}

// Exponer funciones usadas en onclick inline
window.markSessionDone = markSessionDone;
window.openExamModal = openExamModal;
window.editExam = editExam;
window.deleteExam = deleteExam;
window.startStudyForExam = startStudyForExam;
window.removeTempTopic = removeTempTopic;
window.selectCalDay = selectCalDay;
window.answerMemo = answerMemo;
window.answerTF = answerTF;
window.answerMC = answerMC;

function handleMemoKeys(e) {
  const section = document.getElementById('section-memorizar');
  const box = document.getElementById('memoCard');
  if (!section || !section.classList.contains('active') || !box || box.classList.contains('hidden')) return;
  const tag = (e.target && e.target.tagName) || '';
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.target.isContentEditable) return;
  if (!memoState.queue.length || memoState.index >= memoState.queue.length) return;

  const card = memoState.queue[memoState.index];
  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    const fc = document.getElementById('fc');
    if (fc) fc.classList.toggle('flipped');
    const showBtn = document.getElementById('showAnsBtn');
    if (showBtn && !showBtn.classList.contains('hidden')) showBtn.click();
    return;
  }
  if (card.type !== 'flashcard' && card.type !== 'qa') return;
  if (e.key === 'ArrowLeft' || e.key === '1') {
    e.preventDefault();
    answerMemo(false);
  } else if (e.key === 'ArrowRight' || e.key === '2') {
    e.preventDefault();
    answerMemo(true);
  }
}

function csvCell(s) {
  return '"' + String(s ?? '').replace(/"/g, '""') + '"';
}

function cardToAnki(c) {
  if (c.type === 'flashcard') return [c.front, c.back];
  if (c.type === 'qa') return [c.question, c.answer];
  if (c.type === 'tf') {
    return [
      (c.statement || '') + '\n¿Verdadero o Falso?',
      (c.correct ? 'Verdadero' : 'Falso') + (c.explanation ? '\n' + c.explanation : '')
    ];
  }
  if (c.type === 'mc') {
    const opts = (c.options || []).map((o, i) => String.fromCharCode(65 + i) + ') ' + o).join('\n');
    return [(c.question || '') + '\n' + opts, (c.options || [])[c.correctIndex] || ''];
  }
  return ['', ''];
}

function exportAnkiCsv() {
  const lines = ['Front,Back'];
  store.exams.forEach(ex => {
    (ex.cards || []).forEach(c => {
      const [front, back] = cardToAnki(c);
      if (!front) return;
      lines.push(csvCell(front) + ',' + csvCell(back));
    });
  });
  if (lines.length < 2) {
    toast('No hay tarjetas para exportar. Generá material en Apuntes.');
    return;
  }
  const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mindfocus-anki.csv';
  a.click();
  toast('CSV para Anki descargado');
}

/** Carga un script externo una sola vez (PDF.js / mammoth). */
function loadScriptOnce(src, globalCheck) {
  return new Promise((resolve, reject) => {
    if (globalCheck()) return resolve();
    const existing = document.querySelector(`script[data-sm-src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('No se pudo cargar ' + src)));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.smSrc = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar ' + src));
    document.head.appendChild(s);
  });
}

async function ensurePdfJs() {
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    return;
  }
  await loadScriptOnce(
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
    () => typeof pdfjsLib !== 'undefined'
  );
  if (typeof pdfjsLib === 'undefined') throw new Error('PDF.js no disponible');
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

async function ensureMammoth() {
  if (typeof mammoth !== 'undefined') return;
  await loadScriptOnce(
    'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.8.0/mammoth.browser.min.js',
    () => typeof mammoth !== 'undefined'
  );
  if (typeof mammoth === 'undefined') throw new Error('mammoth.js no disponible');
}

function isImageFile(file) {
  if (!file) return false;
  if ((file.type || '').startsWith('image/')) return true;
  return /\.(jpe?g|png|gif|webp|bmp|tiff?)$/i.test(file.name || '');
}

async function ensureTesseract() {
  if (typeof Tesseract !== 'undefined') return;
  await loadScriptOnce(
    'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js',
    () => typeof Tesseract !== 'undefined'
  );
  if (typeof Tesseract === 'undefined') throw new Error('Tesseract.js no disponible');
}

/**
 * Prepara la imagen para OCR.
 * mode: 'soft' (letra manuscrita: NO binarizar) | 'print' (texto impreso, más contraste)
 */
async function preprocessImageForOcr(file, mode = 'soft') {
  const bitmap = await createImageBitmap(file);
  try {
    const maxSide = 2400;
    let w = bitmap.width;
    let h = bitmap.height;
    const minSide = Math.min(w, h);
    let scale = 1;
    // Letra a mano necesita más resolución
    if (minSide < 1200) scale = Math.min(3, 1600 / minSide);
    else if (Math.max(w, h) > maxSide) scale = maxSide / Math.max(w, h);
    w = Math.round(w * scale);
    h = Math.round(h * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    if (mode === 'soft') {
      // Solo grises + contraste suave: la tinta manuscrita es gris, no negra
      for (let i = 0; i < d.length; i += 4) {
        let y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        y = (y - 128) * 1.15 + 128;
        y = Math.max(0, Math.min(255, y));
        d[i] = d[i + 1] = d[i + 2] = y;
      }
    } else {
      // Impreso / captura de pantalla: más contraste, sin matar grises medios del todo
      for (let i = 0; i < d.length; i += 4) {
        let y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        y = (y - 128) * 1.45 + 128;
        y = Math.max(0, Math.min(255, y));
        if (y > 210) y = 255;
        else if (y < 55) y = 0;
        d[i] = d[i + 1] = d[i + 2] = y;
      }
    }
    ctx.putImageData(img, 0, 0);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(b => (b ? resolve(b) : reject(new Error('No se pudo preparar la imagen'))), 'image/png');
    });
    return blob;
  } finally {
    try { bitmap.close(); } catch (_) { /* ignorar */ }
  }
}

/** Qué tan “legible” parece un texto de OCR (0–100). */
function scoreOcrText(text, confidence) {
  if (!text || text.length < 8) return 0;
  const letters = (text.match(/\p{L}/gu) || []).length;
  const letterRatio = letters / text.length;
  const words = text.split(/\s+/).filter(Boolean);
  const realWords = words.filter(w => w.length >= 2 && /^[\p{L}0-9áéíóúüñÁÉÍÓÚÜÑ.,;:¿?¡!\-()]+$/u.test(w));
  const wordRatio = words.length ? realWords.length / words.length : 0;
  // Palabras típicas de estudio en español (bonus si aparecen)
  const hints = /\b(la|el|los|las|de|del|en|es|son|por|para|con|una|uno|que|se|y|revoluci[oó]n|historia|causa|crisis|estado|siglo|guerra|proceso|teor[ií]a|definici[oó]n)\b/gi;
  const hintHits = (text.match(hints) || []).length;
  let score = letterRatio * 35 + wordRatio * 35 + Math.min(15, text.length / 80) + Math.min(15, hintHits);
  if (typeof confidence === 'number' && confidence > 0) {
    score = score * 0.55 + Math.min(100, confidence) * 0.45;
  }
  // Penalizar basura típica de OCR fallido
  const garbage = (text.match(/[|=_]{2,}|(?:^|\s)[^\s]{1}(?:\s[^\s]{1}){4,}/g) || []).length;
  score -= garbage * 8;
  return Math.max(0, Math.min(100, score));
}

async function runTesseractOnce(input, psm, label) {
  const result = await Tesseract.recognize(input, 'spa+eng', {
    logger: m => {
      if (m.status === 'recognizing text' && typeof m.progress === 'number') {
        setNotesStatus(`${label}… ${Math.round(m.progress * 100)}%`);
      } else if (m.status === 'loading tesseract core' || m.status === 'initializing tesseract' || m.status === 'loading language traineddata') {
        setNotesStatus('Preparando motor de OCR (la primera vez puede tardar)…');
      }
    },
    tessedit_pageseg_mode: String(psm)
  });
  let text = (result && result.data && result.data.text ? result.data.text : '').trim();
  const confidence = result && result.data && typeof result.data.confidence === 'number'
    ? result.data.confidence : 0;
  if (text && typeof SM !== 'undefined' && SM.cleanOcrText) text = SM.cleanOcrText(text);
  return { text, confidence, score: scoreOcrText(text, confidence), psm };
}

/**
 * OCR en la nube (OCR.space engine 2): mucho mejor con letra manuscrita.
 * Si falla por red/límite, cae a Tesseract local.
 */
async function extractImageTextOcrSpace(file) {
  setNotesStatus('Leyendo la foto con motor de letra manuscrita…');
  const form = new FormData();
  form.append('file', file, file.name || 'apuntes.jpg');
  form.append('language', 'spa');
  form.append('isOverlayRequired', 'false');
  form.append('OCREngine', '2');
  form.append('scale', 'true');
  form.append('detectOrientation', 'true');

  const apiKey = (store.config && store.config.ocrApiKey) || 'helloworld';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const res = await fetch('https://api.ocr.space/parse/image', {
      method: 'POST',
      headers: { apikey: apiKey },
      body: form,
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (json.IsErroredOnProcessing) {
      const msg = Array.isArray(json.ErrorMessage) ? json.ErrorMessage.join(' ') : (json.ErrorMessage || 'Error OCR');
      throw new Error(msg);
    }
    const parts = (json.ParsedResults || []).map(r => r.ParsedText || '').filter(Boolean);
    let text = parts.join('\n').trim();
    if (text && typeof SM !== 'undefined' && SM.cleanOcrText) text = SM.cleanOcrText(text);
    const score = scoreOcrText(text, 70);
    window._mindfocusLastOcrScore = score;
    window._mindfocusLastOcrEngine = 'ocrspace';
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** OCR local con Tesseract (respaldo offline). Débil con letra cursiva. */
async function extractImageTextTesseract(file) {
  await ensureTesseract();
  window._mindfocusLastOcrScore = 0;
  setNotesStatus('Motor local (Tesseract)…');

  let soft = null;
  let printed = null;
  try { soft = await preprocessImageForOcr(file, 'soft'); } catch (e) { console.warn(e); }
  try { printed = await preprocessImageForOcr(file, 'print'); } catch (e) { console.warn(e); }

  const attempts = [
    soft && { input: soft, psm: 4, label: 'Leyendo letra a mano' },
    soft && { input: soft, psm: 3, label: 'Reintentando (auto)' },
    { input: file, psm: 3, label: 'Leyendo foto original' },
    printed && { input: printed, psm: 6, label: 'Leyendo con más contraste' }
  ].filter(Boolean);

  let best = { text: '', score: -1, confidence: 0 };
  for (const a of attempts) {
    try {
      const r = await runTesseractOnce(a.input, a.psm, a.label);
      if (r.score > best.score) best = r;
      if (best.score >= 50 && best.text.length > 60) break;
    } catch (e) {
      console.warn('Intento OCR falló', a.label, e);
    }
  }
  window._mindfocusLastOcrScore = best.score;
  window._mindfocusLastOcrEngine = 'tesseract';
  if (best.score < 18 || best.text.length < 20) return '';
  return best.text;
}

/**
 * OCR de imagen: primero motor en la nube (letra a mano), si falla Tesseract local.
 */
async function extractImageText(file) {
  window._mindfocusLastOcrScore = 0;
  window._mindfocusLastOcrEngine = '';

  try {
    const text = await extractImageTextOcrSpace(file);
    if (text && text.length >= 20 && scoreOcrText(text, 70) >= 22) {
      return text;
    }
    console.warn('OCR.space devolvió poco texto, pruebo Tesseract');
  } catch (e) {
    console.warn('OCR.space no disponible, uso Tesseract local', e);
    setNotesStatus('Sin motor en la nube, uso OCR local (peor con letra a mano)…');
  }

  return extractImageTextTesseract(file);
}

async function loadNotesFile(file) {
  const status = document.getElementById('notesStatus');
  const area = document.getElementById('notesText');
  try {
    setNotesStatus('Leyendo ' + (file.name || 'archivo') + '…');
    const name = (file.name || '').toLowerCase();
    let text = '';
    if (isImageFile(file)) {
      setNotesStatus('Detectando texto en la imagen…');
      try {
        text = await extractImageText(file);
        if (!text || text.length < 15) {
          setNotesStatus('No pude leer bien esa foto (letra a mano es difícil para el OCR). Probá: más cerca, buena luz, sin sombra, o escribí/pegá el texto a mano.');
          toast('OCR ilegible — pegá o corregí el texto a mano');
          return;
        }
        window._mindfocusLastNotesFromOcr = true;
        const ocrScore = window._mindfocusLastOcrScore || 0;
        const engine = window._mindfocusLastOcrEngine || '';
        if (ocrScore > 0 && ocrScore < 40) {
          setNotesStatus('⚠️ El texto salió dudoso. Revisalo y corregilo en el cuadro antes de generar el material.');
          toast('Revisá el texto detectado antes de generar');
        } else if (engine === 'ocrspace') {
          setNotesStatus('Texto detectado (motor de letra manuscrita). Revisalo un momento y generá el material.');
        }
      } catch (e) {
        console.warn(e);
        setNotesStatus('No pude leer la imagen (¿sin conexión al CDN de OCR?). Pegá el texto a mano.');
        toast('OCR no disponible: pegá el texto manualmente');
        return;
      }
    } else if (name.endsWith('.pdf') || file.type === 'application/pdf') {
      setNotesStatus('Cargando lector de PDF…');
      try {
        await ensurePdfJs();
        text = await extractPdfText(file);
      } catch (e) {
        console.warn(e);
        setNotesStatus('No pude leer el PDF (¿sin conexión al CDN?). Pegá el texto a mano en el cuadro de arriba.');
        toast('PDF no disponible: pegá el texto manualmente');
        return;
      }
    } else if (name.endsWith('.docx') || (file.type || '').includes('wordprocessingml')) {
      setNotesStatus('Cargando lector de Word…');
      try {
        await ensureMammoth();
        text = await extractDocxText(file);
      } catch (e) {
        console.warn(e);
        setNotesStatus('No pude leer el .docx. Abrilo y pegá el texto a mano en el cuadro de arriba.');
        toast('Word no disponible: pegá el texto manualmente');
        return;
      }
    } else {
      text = await file.text();
    }
    const prev = (area.value || '').trim();
    area.value = prev && text ? (prev + '\n\n' + text) : text;
    if (isImageFile(file)) {
      setNotesStatus('Texto detectado. Revisalo (el OCR a veces confunde letras) y tocá «Generar material de estudio».');
      toast('Texto de la imagen listo — revisalo y generá el material');
    } else {
      setNotesStatus(text ? 'Archivo cargado. Revisá el texto y generá el material.' : '');
      toast('Archivo cargado');
      window._mindfocusLastNotesFromOcr = false;
    }
  } catch (err) {
    console.warn(err);
    toast('No pude leer ese archivo. Probá pegar el texto a mano.');
    if (status) setNotesStatus('Error al leer el archivo. Pegá el contenido en el cuadro de texto.');
  }
}

async function extractPdfText(file) {
  await ensurePdfJs();
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const parts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    parts.push(content.items.map(it => it.str).join(' '));
  }
  return parts.join('\n\n').replace(/[ \t]+\n/g, '\n').trim();
}

async function extractDocxText(file) {
  await ensureMammoth();
  const arrayBuffer = await file.arrayBuffer();
  const res = await mammoth.extractRawText({ arrayBuffer });
  return (res.value || '').trim();
}
