/**
 * NeoGuard — js/alerts.js
 * ---------------------------------------------------------------------------
 * Alertes et notifications.
 *
 *  - vigilance / pathologie-legere : toast doux (#vigilance-toast), sonnerie
 *    douce unique, Notification silencieuse. Limite : 1 notification toutes les
 *    2 min pour le même motif.
 *  - urgence : écran rouge (#emergency-overlay), bip-bip fort en boucle,
 *    vibration en boucle, Notification persistante, focus sur #btn-ok-intervened.
 *  - rappel des 24 h : toast #reminder-toast, puis re-rappel toutes les 6 h.
 *
 * Isolation du mode démo :
 *  - en démo, RIEN n'est transmis à persistAlert / persistPatchAppliedAt ;
 *    les alertes ne sont diffusées qu'aux abonnés (subscribeAlerts), dont
 *    demo.js qui les écrit dans #demo-log ;
 *  - toutes les notifications sont préfixées « [TEST] », l'overlay affiche
 *    « TEST — ceci n'est pas une vraie alerte » et le bouton « Appeler SAMU »
 *    NE compose JAMAIS le numéro (appel simulé).
 *
 * Aide à la surveillance : ce module n'annonce jamais de diagnostic.
 */

import { getState, setState, subscribe, isDemo } from './state.js';

/* ------------------------------ Configuration ----------------------------- */

const CFG = Object.freeze({
  THROTTLE_MS: 2 * 60 * 1000,          // 1 notification / 2 min / motif
  GRACE_MS: 60 * 1000,                 // période de grâce après « j'ai intervenu »
  REMINDER_FIRST_MS: 24 * 3600 * 1000, // rappel de la partie collante
  REMINDER_REPEAT_MS: 6 * 3600 * 1000, // re-rappel
  TOAST_VIGILANCE_MS: 12000,
  TOAST_REMINDER_MS: 20000,
  BEEP_PERIOD_MS: 400,                 // 0,25 s son + 0,15 s silence
  BEEP_ON_S: 0.25,
  SOFT_VOLUME: 0.06,
  BEEP_VOLUME: 0.35,
});

/* --------------------------- État privé du module -------------------------- */

/** Branchements fournis par main.js (tous facultatifs). */
let options = {
  /** @type {null|((alert:Object)=>Promise<void>|void)} enregistre une alerte (LIVE uniquement) */
  persistAlert: null,
  /** @type {null|((epochMs:number)=>Promise<void>|void)} enregistre la nouvelle date de pose (LIVE uniquement) */
  persistPatchAppliedAt: null,
  /** @type {null|((epochMs:number)=>void)} informe la source capteur (setPatchAppliedAt) */
  setSensorPatchAppliedAt: null,
  /** Délai anti-répétition des notifications (ms). */
  throttleMs: CFG.THROTTLE_MS,
};

let initialized = false;
/** @type {AudioContext|null} */
let audioCtx = null;
let beepTimer = null;
let vibrateTimer = null;

/** Overlay d'urgence : état courant. */
const emergency = {
  active: false,
  cats: new Set(),
  returnFocus: null,
  notif: null,
  renderKey: '',
};

/** motif -> dernière notification (ms). */
const lastNotifiedAt = new Map();
/** motif -> fin de la période de grâce (ms). */
const graceUntil = new Map();
/** Rappel 24 h : pour quelle pose, et dernier rappel. */
const reminder = { forPatch: null, lastAt: null };
const toastTimers = { vigilance: null, reminder: null };
const listeners = new Set();
let seq = 0;

/* -------------------------------- Utilitaires ------------------------------ */

const $ = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const testPrefix = () => (isDemo() ? '[TEST] ' : '');
const soundEnabled = () => getState().settings.sound !== false;
const vibrationEnabled = () => getState().settings.vibration !== false;
const babyName = () => String(getState().profile?.firstName || '').trim() || 'votre bébé';

/** Classe de gravité : 0 normal, 1 vigilance/pathologie légère, 2 urgence. */
function levelClass(level) {
  if (level === 'urgence') return 2;
  if (level === 'vigilance' || level === 'pathologie-legere') return 1;
  return 0;
}

/**
 * Catégories (« motifs ») d'une liste de raisons : sert à l'anti-répétition et
 * à la période de grâce, sans dépendre des chiffres qui changent chaque seconde.
 * @param {string[]} reasons
 * @returns {string[]}
 */
function categorize(reasons) {
  const cats = new Set();
  for (const raw of reasons || []) {
    const r = String(raw).toLowerCase();
    if (r.includes('respirat')) cats.add('respiration');
    else if (r.includes('cardiaque')) cats.add('coeur');
    else if (r.includes('ventre')) cats.add('position');
    else if (r.includes('déconnect') || r.includes('patch')) cats.add('patch');
    else if (r.includes('agité')) cats.add('mouvement');
  }
  return cats.size ? Array.from(cats) : ['general'];
}

/** Garde uniquement chiffres, +, * et # d'un numéro de téléphone (défaut 190). */
function sanitizePhone(value) {
  const cleaned = String(value ?? '').replace(/[^\d+*#]/g, '');
  return cleaned || '190';
}

/* ------------------------------ Journal d'alertes -------------------------- */

/**
 * S'abonne aux alertes produites ({ id, t, level, reasons, source, action }).
 * Les abonnés doivent filtrer sur `source` : l'historique réel ignore "demo",
 * le journal de test ignore "live".
 * @param {(alert:Object)=>void} fn
 * @returns {() => void} désabonnement
 */
export function subscribeAlerts(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Crée l'objet d'alerte, l'enregistre (LIVE uniquement, niveau != normal) et
 * le diffuse aux abonnés.
 */
function record(level, reasons, action) {
  const t = Date.now();
  const alert = {
    id: `${t.toString(36)}-${(++seq).toString(36)}`,
    t,
    level,
    reasons: [...reasons],
    source: isDemo() ? 'demo' : 'live',
    action,
  };
  if (alert.source === 'live' && level !== 'normal' && typeof options.persistAlert === 'function') {
    try {
      Promise.resolve(options.persistAlert(alert)).catch((e) =>
        console.warn('[NeoGuard/alerts] enregistrement impossible :', e));
    } catch (e) {
      console.warn('[NeoGuard/alerts] enregistrement impossible :', e);
    }
  }
  for (const fn of Array.from(listeners)) {
    try { fn(alert); } catch (e) { console.error('[NeoGuard/alerts] abonné :', e); }
  }
  return alert;
}

/* ---------------------------------- Audio ---------------------------------- */

/** Le son est-il débloqué (AudioContext en cours d'exécution) ? */
export function isAudioUnlocked() {
  return Boolean(audioCtx) && audioCtx.state === 'running';
}

/**
 * Crée/reprend l'AudioContext. À appeler lors d'un GESTE utilisateur
 * (lié à #btn-enable-audio ; aussi déclenché au premier toucher de la page).
 * @returns {Promise<boolean>} true si le son est prêt
 */
export async function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return false;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    // Impulsion inaudible : déverrouille certains navigateurs mobiles (iOS).
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    gain.gain.value = 0.0001;
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.02);
  } catch (err) {
    console.warn('[NeoGuard/alerts] audio indisponible :', err);
  }
  updateAudioUi();
  return isAudioUnlocked();
}

/** Contexte audio utilisable maintenant (ou null si bloqué). */
function readyContext() {
  if (!audioCtx) return null;
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx.state === 'running' ? audioCtx : null;
}

/** Joue une note avec une enveloppe courte (évite les « clacs »). */
function tone(ctx, freq, type, start, dur, vol) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, start);
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(vol, start + 0.012);
  gain.gain.setValueAtTime(vol, start + Math.max(0.013, dur - 0.03));
  gain.gain.linearRampToValueAtTime(0, start + dur);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.02);
}

/** Sonnerie douce unique : sinus 523 Hz puis 659 Hz, volume bas. */
function playSoftChime() {
  if (!soundEnabled()) return;
  const ctx = readyContext();
  if (!ctx) { updateAudioUi(); return; }
  const t0 = ctx.currentTime;
  tone(ctx, 523, 'sine', t0, 0.3, CFG.SOFT_VOLUME);
  tone(ctx, 659, 'sine', t0 + 0.3, 0.4, CFG.SOFT_VOLUME);
}

/** Bip-bip fort en boucle : onde carrée ~1000 Hz, 0,25 s son / 0,15 s silence. */
function startEmergencySound() {
  if (!soundEnabled() || beepTimer !== null) return;
  const beep = () => {
    const ctx = readyContext();
    if (ctx) tone(ctx, 1000, 'square', ctx.currentTime, CFG.BEEP_ON_S, CFG.BEEP_VOLUME);
  };
  beep();
  beepTimer = setInterval(beep, CFG.BEEP_PERIOD_MS);
}

function stopEmergencySound() {
  if (beepTimer !== null) clearInterval(beepTimer);
  beepTimer = null;
}

/** Vibration en boucle (si disponible et autorisée). */
function startVibration() {
  if (!vibrationEnabled() || vibrateTimer !== null) return;
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return;
  const buzz = () => { try { navigator.vibrate(250); } catch { /* ignoré */ } };
  buzz();
  vibrateTimer = setInterval(buzz, CFG.BEEP_PERIOD_MS);
}

function stopVibration() {
  if (vibrateTimer !== null) clearInterval(vibrateTimer);
  vibrateTimer = null;
  try { if (typeof navigator !== 'undefined' && navigator.vibrate) navigator.vibrate(0); } catch { /* ignoré */ }
}

/**
 * Affiche (ou retire) l'avertissement « son bloqué » et met à jour le bouton
 * #btn-enable-audio (attribut data-audio="locked|ready").
 */
function updateAudioUi() {
  if (typeof document === 'undefined') return;
  const unlocked = isAudioUnlocked();
  const btn = $('btn-enable-audio');
  if (btn) btn.setAttribute('data-audio', unlocked ? 'ready' : 'locked');

  const needWarning = soundEnabled() && !unlocked && Boolean(getState().profile);
  let warn = $('audio-warning');
  if (needWarning && !warn) {
    warn = document.createElement('button');
    warn.id = 'audio-warning';
    warn.type = 'button';
    warn.className = 'btn btn-ghost pill';
    warn.textContent = '🔇 Son bloqué par le navigateur : touchez ici pour activer les alertes sonores';
    warn.addEventListener('click', () => { unlockAudio(); });
    const header = $('app-header');
    if (header && header.parentNode) header.insertAdjacentElement('afterend', warn);
    else document.body.prepend(warn);
  } else if (!needWarning && warn) {
    warn.remove();
  }
}

/* ------------------------------ Notifications ------------------------------ */

/**
 * Demande la permission de notification. À appeler UNIQUEMENT depuis un geste
 * utilisateur (par ex. quand on active #setting-notifications).
 * @returns {Promise<"granted"|"denied"|"default"|"unsupported">}
 */
export async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); } catch { return Notification.permission; }
}

/**
 * Affiche une notification système si autorisée et activée dans les réglages.
 * Utilise le service worker quand il existe (nécessaire sur mobile).
 * @returns {Promise<{close:()=>void}|null>}
 */
async function showNotification(title, opts) {
  if (!getState().settings.notifications) return null;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return null;
  const full = { lang: 'fr', ...opts };
  try {
    const reg = navigator.serviceWorker?.getRegistration ? await navigator.serviceWorker.getRegistration() : null;
    if (reg && typeof reg.showNotification === 'function') {
      const worker = reg.active || navigator.serviceWorker.controller;
      if (worker) {
        const level = String(full.tag || '').includes('urgence') ? 'urgence' : 'vigilance';
        worker.postMessage({ type: 'notify', level, title, body: String(full.body || '') });
      } else {
        // Repli si le worker est en cours d'activation ou n'est pas contrôlant.
        await reg.showNotification(title, full);
      }
      return {
        close() {
          reg.getNotifications({ tag: full.tag }).then((list) => list.forEach((n) => n.close())).catch(() => {});
        },
      };
    }
    const n = new Notification(title, full);
    return { close() { n.close(); } };
  } catch (err) {
    console.warn('[NeoGuard/alerts] notification impossible :', err);
    return null;
  }
}

/* ---------------------------------- Toasts --------------------------------- */

/** Zone de texte d'un toast : [data-toast-text] / .toast-text si présent, sinon le toast. */
function toastSlot(el) {
  return el.querySelector('[data-toast-text], .toast-text') || el;
}

function showToast(kind, text, ms) {
  const el = $(kind === 'reminder' ? 'reminder-toast' : 'vigilance-toast');
  if (!el) return;
  toastSlot(el).textContent = text;
  el.hidden = false;
  el.classList.remove('is-hidden');
  clearTimeout(toastTimers[kind]);
  toastTimers[kind] = setTimeout(() => hideToast(kind), ms);
}

function hideToast(kind) {
  clearTimeout(toastTimers[kind]);
  toastTimers[kind] = null;
  const el = $(kind === 'reminder' ? 'reminder-toast' : 'vigilance-toast');
  if (!el) return;
  el.hidden = true;
  el.classList.add('is-hidden');
}

/* ------------------------------ Overlay d'urgence -------------------------- */

/** (Re)construit le contenu de l'overlay ; ne touche pas au DOM si rien n'a changé. */
function renderEmergency(result) {
  const title = $('emergency-title');
  const detail = $('emergency-detail');
  const name = babyName();
  const reasons = (result.reasons || []).slice(0, 4);
  const calmed = result.level !== 'urgence';
  const soundBlocked = soundEnabled() && !isAudioUnlocked();
  const key = JSON.stringify([isDemo(), name, reasons, calmed, soundBlocked]);
  if (key === emergency.renderKey) return;
  emergency.renderKey = key;

  if (title) title.textContent = `${testPrefix()}URGENCE — vérifiez ${name} maintenant`;
  if (!detail) return;
  const nodes = [];
  const para = (text, strong = false) => {
    const p = document.createElement(strong ? 'strong' : 'p');
    p.textContent = text;
    if (strong) p.style.display = 'block';
    return p;
  };
  if (isDemo()) nodes.push(para("TEST — ceci n'est pas une vraie alerte", true));
  for (const r of reasons) nodes.push(para(r));
  if (calmed) {
    nodes.push(para("La situation semble revenue à la normale. Vérifiez votre bébé, puis appuyez sur « Ça va, j'ai intervenu »."));
  }
  if (soundBlocked) nodes.push(para('⚠ Son bloqué par le navigateur : touchez « Activer le son » dans les Réglages.'));
  detail.replaceChildren(...nodes);
}

function setOverlayVisible(visible) {
  const overlay = $('emergency-overlay');
  if (!overlay) return;
  overlay.hidden = !visible;
  overlay.classList.toggle('is-hidden', !visible);
  overlay.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function openEmergency(result, reescalation) {
  const now = Date.now();
  hideToast('vigilance');
  emergency.active = true;
  emergency.cats = new Set(categorize(result.reasons));
  emergency.returnFocus = typeof document !== 'undefined' ? document.activeElement : null;
  emergency.renderKey = '';
  for (const c of emergency.cats) graceUntil.delete(c);
  setState({ alertActive: true });

  const overlay = $('emergency-overlay');
  const samu = $('btn-call-samu');
  if (samu) samu.setAttribute('href', `tel:${sanitizePhone(getState().settings.emergencyNumber)}`);

  if (overlay) {
    renderEmergency(result);
    setOverlayVisible(true);
    const ok = $('btn-ok-intervened');
    if (ok) ok.focus({ preventScroll: true });
  } else {
    // Dernier recours : l'overlay est absent du HTML, on ne reste jamais silencieux.
    console.error('[NeoGuard/alerts] #emergency-overlay introuvable');
    try { window.alert(`${testPrefix()}URGENCE — ${(result.reasons || []).join(' ')}`); } catch { /* ignoré */ }
  }

  startEmergencySound();
  startVibration();
  updateAudioUi();

  showNotification(`${testPrefix()}NeoGuard — URGENCE`, {
    body: (result.reasons || [])[0] || `Vérifiez ${babyName()} immédiatement.`,
    tag: 'neoguard-urgence',
    requireInteraction: true,
    renotify: true,
    silent: false,
  }).then((handle) => {
    if (emergency.active) emergency.notif = handle; else if (handle) handle.close();
  });

  record('urgence', result.reasons || [], reescalation ? 'reescalade' : 'overlay-ouvert');
  void now;
}

/** Met à jour l'overlay déjà ouvert (raisons à jour, retour au calme). */
function refreshEmergency(result) {
  for (const c of categorize(result.reasons)) emergency.cats.add(c);
  renderEmergency(result);
}

/** Coupe tout (son, vibration, notification) et ferme l'overlay. */
function closeEmergency() {
  stopEmergencySound();
  stopVibration();
  if (emergency.notif) { emergency.notif.close(); emergency.notif = null; }
  setOverlayVisible(false);
  const back = emergency.returnFocus;
  emergency.active = false;
  emergency.returnFocus = null;
  emergency.renderKey = '';
  setState({ alertActive: false });
  if (back && typeof back.focus === 'function' && document.contains(back)) back.focus({ preventScroll: true });
}

/* ------------------------------ Gestion des niveaux ------------------------ */

/**
 * Point d'entrée : à appeler une fois par seconde avec le résultat de l'IA
 * (live ET démo). Gère toasts, sons, overlay, notifications, rappel des 24 h.
 * @param {{level:string, reasons:string[]}} result sortie de ai.assess()
 */
export function handleAssessment(result) {
  if (!result || typeof result !== 'object') return;
  try {
    const now = Date.now();
    const cls = levelClass(result.level);

    if (cls === 2) {
      if (emergency.active) {
        refreshEmergency(result);
      } else {
        const cats = categorize(result.reasons);
        const allGraced = cats.every((c) => (graceUntil.get(c) || 0) > now);
        if (!allGraced) openEmergency(result, cats.some((c) => graceUntil.has(c)));
      }
    } else {
      if (emergency.active) refreshEmergency(result);
      else if (cls === 1) notifyVigilance(result, now);
    }
    checkPatchReminder(now);
  } catch (err) {
    console.error('[NeoGuard/alerts] erreur de traitement :', err);
  }
}

/** Vigilance : toast + sonnerie douce + notification silencieuse, avec anti-répétition. */
function notifyVigilance(result, now) {
  const cats = categorize(result.reasons);
  const fresh = cats.filter((c) => now - (lastNotifiedAt.get(c) ?? -Infinity) >= options.throttleMs);
  if (!fresh.length) return;
  for (const c of cats) lastNotifiedAt.set(c, now);

  const first = (result.reasons || [])[0] || `Restez attentif à ${babyName()}.`;
  showToast('vigilance', `${testPrefix()}${first}`, CFG.TOAST_VIGILANCE_MS);
  playSoftChime();
  showNotification(
    `${testPrefix()}NeoGuard — ${result.level === 'pathologie-legere' ? 'à surveiller' : 'vigilance'}`,
    { body: first, tag: 'neoguard-vigilance', silent: true },
  );
  record(result.level, result.reasons || [], 'notification');
}

/* ------------------------------- Rappel des 24 h --------------------------- */

/**
 * Rappel de changement de la partie collante : une notification douce à 24 h,
 * puis toutes les 6 h tant que la pose n'a pas été renouvelée. Appelée par
 * handleAssessment ; à appeler aussi chaque minute si le patch est déconnecté.
 * @param {number} [now=Date.now()]
 */
export function checkPatchReminder(now = Date.now()) {
  const applied = getState().patchAppliedAt;
  if (!isNum(applied)) return;
  if (reminder.forPatch !== applied) {
    reminder.forPatch = applied; // nouvelle pose : on repart de zéro
    reminder.lastAt = null;
  }
  const age = now - applied;
  if (age < CFG.REMINDER_FIRST_MS) return;
  if (reminder.lastAt !== null && now - reminder.lastAt < CFG.REMINDER_REPEAT_MS) return;
  if (emergency.active) return; // pas pendant une urgence : on réessaiera

  reminder.lastAt = now;
  const hours = Math.floor(age / 3600000);
  const text = `Pensez à changer la partie collante du patch (posée depuis ${hours} h).`;
  showToast('reminder', `${testPrefix()}${text}`, CFG.TOAST_REMINDER_MS);
  playSoftChime();
  showNotification(`${testPrefix()}NeoGuard — rappel`, { body: text, tag: 'neoguard-rappel', silent: true });
  record('vigilance', [text], 'rappel-24h');
}

/* --------------------------- Actions de l'utilisateur ---------------------- */

/** « Ça va, j'ai intervenu » : coupe tout, ferme l'overlay, grâce de 60 s. */
function onIntervened() {
  if (!emergency.active) return;
  const cats = Array.from(emergency.cats);
  closeEmergency();
  const until = Date.now() + CFG.GRACE_MS;
  for (const c of cats) graceUntil.set(c, until);
  record('urgence', ['Parent intervenu'], 'parent-intervenu');
}

/** « Appeler SAMU » : href mis à jour au clic ; en démo, aucun appel n'est passé. */
function onCallSamu(event) {
  const num = sanitizePhone(getState().settings.emergencyNumber);
  stopEmergencySound();
  stopVibration();
  if (isDemo()) {
    event.preventDefault(); // SÉCURITÉ : jamais de vrai appel en mode test
    record('urgence', [`Appel SAMU lancé (simulé : aucun appel passé en mode test)`], 'appel-samu');
    return;
  }
  const link = $('btn-call-samu');
  if (link) link.setAttribute('href', `tel:${num}`);
  record('urgence', ['Appel SAMU lancé'], 'appel-samu');
}

/** « J'ai changé la partie collante » : remet la pose à maintenant. */
function onPatchChanged() {
  const now = Date.now();
  setState({ patchAppliedAt: now });
  if (typeof options.setSensorPatchAppliedAt === 'function') {
    try { options.setSensorPatchAppliedAt(now); } catch (e) { console.warn(e); }
  }
  if (!isDemo() && typeof options.persistPatchAppliedAt === 'function') {
    try {
      Promise.resolve(options.persistPatchAppliedAt(now)).catch((e) =>
        console.warn('[NeoGuard/alerts] enregistrement de la pose impossible :', e));
    } catch (e) { console.warn(e); }
  }
  reminder.forPatch = now;
  reminder.lastAt = null;
  hideToast('reminder');
  record('normal', ['Partie collante changée'], 'patch-change');
}

/** Piège le focus dans l'overlay (aria-modal) : Tab alterne entre les 2 boutons. */
function onOverlayKeydown(event) {
  if (event.key === 'Escape') { event.preventDefault(); return; } // on ne ferme que par action
  if (event.key !== 'Tab') return;
  const items = ['btn-ok-intervened', 'btn-call-samu'].map($).filter(Boolean);
  if (!items.length) return;
  const idx = items.indexOf(document.activeElement);
  const next = event.shiftKey ? (idx <= 0 ? items.length - 1 : idx - 1) : (idx + 1) % items.length;
  event.preventDefault();
  items[next].focus();
}

/* ------------------------------- Initialisation ---------------------------- */

/**
 * Branche les boutons et prépare les zones d'alerte. À appeler une fois au
 * démarrage (après le chargement du DOM). Rappeler la fonction ne fait que
 * mettre à jour les options.
 *
 * @param {Object} [opts]
 * @param {(alert:Object)=>Promise<void>|void} [opts.persistAlert]  enregistre une alerte (appelé en LIVE uniquement)
 * @param {(epochMs:number)=>Promise<void>|void} [opts.persistPatchAppliedAt] enregistre la pose (LIVE uniquement)
 * @param {(epochMs:number)=>void} [opts.setSensorPatchAppliedAt]  informe le capteur de la nouvelle pose
 * @param {number} [opts.throttleMs]  anti-répétition (défaut 120 000 ms)
 */
export function initAlerts(opts = {}) {
  options = { ...options, ...opts };
  if (initialized || typeof document === 'undefined') return;
  initialized = true;

  // Zones d'annonce pour les lecteurs d'écran.
  const overlay = $('emergency-overlay');
  if (overlay) {
    overlay.setAttribute('aria-live', 'assertive');
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.addEventListener('keydown', onOverlayKeydown);
  }
  for (const id of ['vigilance-toast', 'reminder-toast']) {
    const el = $(id);
    if (!el) continue;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.addEventListener('click', () => hideToast(id === 'reminder-toast' ? 'reminder' : 'vigilance'));
  }

  $('btn-ok-intervened')?.addEventListener('click', onIntervened);
  $('btn-call-samu')?.addEventListener('click', onCallSamu);
  $('btn-patch-changed')?.addEventListener('click', onPatchChanged);
  $('btn-enable-audio')?.addEventListener('click', () => { unlockAudio(); });

  // Premier geste n'importe où : débloque le son sans attendre les Réglages.
  const gestures = ['click', 'touchend', 'keydown'];
  const firstGesture = () => {
    for (const type of gestures) document.removeEventListener(type, firstGesture, true);
    unlockAudio();
  };
  for (const type of gestures) document.addEventListener(type, firstGesture, true);

  // Reprise audio si l'onglet revient au premier plan pendant une urgence.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && emergency.active) readyContext();
  });

  // Réglages ou profil modifiés : met à jour l'avertissement « son bloqué ».
  subscribe((state, prev) => {
    if (state.settings.sound !== prev.settings.sound || state.profile !== prev.profile) updateAudioUi();
  });

  setOverlayVisible(false);
  hideToast('vigilance');
  hideToast('reminder');
  updateAudioUi();
}

/* ------------------------------ Remise à zéro ------------------------------ */

/**
 * Oublie l'anti-répétition, les périodes de grâce et le rappel 24 h (utile
 * pour #demo-reset, à l'entrée et à la sortie de la démo).
 */
export function resetAlertState() {
  lastNotifiedAt.clear();
  graceUntil.clear();
  reminder.forPatch = null;
  reminder.lastAt = null;
}

/**
 * Coupe sons et vibration, ferme l'overlay et les toasts, oublie l'état
 * d'anti-répétition (sortie de la démo, réinitialisation des données).
 */
export function stopAllAlerts() {
  try {
    stopEmergencySound();
    stopVibration();
    if (emergency.active) closeEmergency();
    else setOverlayVisible(false);
    hideToast('vigilance');
    hideToast('reminder');
    resetAlertState();
  } catch (err) {
    console.error('[NeoGuard/alerts] arrêt des alertes :', err);
  }
}