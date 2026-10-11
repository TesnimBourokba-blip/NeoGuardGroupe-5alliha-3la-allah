/**
 * NeoGuard — js/state.js
 * ---------------------------------------------------------------------------
 * Store minimal (sans bibliothèque) + gestion de l'isolation mode live / demo.
 *
 * Règles importantes :
 *  - Aucune variable globale : tout vit dans ce module (portée de module ES).
 *  - setMode("demo") fige un instantané de l'état réel, vide l'état transitoire
 *    et active l'isolation : isWriteBlocked() renvoie true (db.js DOIT le
 *    consulter avant toute écriture IndexedDB / localStorage).
 *  - setMode("live") restaure l'état réel et efface TOUT l'état de démo.
 *
 * Aide à la surveillance — ce module ne produit aucun avis médical.
 */

/** Réglages par défaut (copiés, jamais partagés par référence). */
const DEFAULT_SETTINGS = Object.freeze({
  sound: true,
  vibration: true,
  notifications: false,
  emergencyNumber: '190',
  theme: 'day', // "day" | "night"
});

/** Clés de l'état « transitoire » : vidées à l'entrée de la démo. */
const TRANSIENT_KEYS = ['latestFrame', 'latestAssessment', 'alertActive'];

/**
 * @typedef {Object} AppState
 * @property {"live"|"demo"} mode
 * @property {Object|null} profile        Profil du bébé (prénom, naissance, sexe, risques…)
 * @property {Object|null} latestFrame    Dernière frame capteur (contrat de données)
 * @property {Object|null} latestAssessment Dernier résultat de l'IA
 * @property {Object} settings            Réglages utilisateur
 * @property {number|null} patchAppliedAt Époque (ms) de pose de la partie collante
 * @property {boolean} alertActive        Une alerte d'urgence est-elle affichée ?
 */

/** @returns {AppState} */
function createInitialState() {
  return {
    mode: 'live',
    profile: null,
    latestFrame: null,
    latestAssessment: null,
    settings: { ...DEFAULT_SETTINGS },
    patchAppliedAt: null,
    alertActive: false,
  };
}

/** État courant (privé au module). */
let state = createInitialState();

/** Abonnés : fonctions appelées à chaque changement. */
const listeners = new Set();

/** Instantané de l'état réel, conservé pendant la démo (sinon null). */
let liveSnapshot = null;

/** Copie profonde simple (les états sont des données JSON-compatibles). */
function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

/**
 * Retourne l'état courant (copie superficielle : modifier l'objet renvoyé
 * n'altère pas le store ; passer par setState).
 * @returns {AppState}
 */
export function getState() {
  return { ...state };
}

/**
 * Fusionne un patch dans l'état puis notifie les abonnés.
 * `settings` est fusionné champ par champ (pas écrasé en bloc).
 * Une exception dans un abonné n'empêche jamais les autres d'être notifiés.
 * @param {Partial<AppState>} patch
 * @returns {AppState} le nouvel état
 */
export function setState(patch) {
  if (!patch || typeof patch !== 'object') return getState();
  const prev = state;
  const next = { ...prev, ...patch };
  if (patch.settings && typeof patch.settings === 'object') {
    next.settings = { ...prev.settings, ...patch.settings };
  }
  state = next;
  notify(prev, patch);
  return getState();
}

/**
 * S'abonne aux changements.
 * @param {(state: AppState, prev: AppState, patch: Object) => void} fn
 * @returns {() => void} fonction de désabonnement
 */
export function subscribe(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Notifie tous les abonnés en isolant leurs erreurs. */
function notify(prev, patch) {
  const current = getState();
  for (const fn of Array.from(listeners)) {
    try {
      fn(current, { ...prev }, patch);
    } catch (err) {
      console.error('[NeoGuard/state] erreur dans un abonné :', err);
    }
  }
}

/**
 * Indique si le mode démo est actif.
 * @returns {boolean}
 */
export function isDemo() {
  return state.mode === 'demo';
}

/**
 * Garde d'isolation à consulter par db.js AVANT toute écriture
 * (IndexedDB, localStorage…). En démo : true => écriture interdite.
 * @returns {boolean}
 */
export function isWriteBlocked() {
  return state.mode === 'demo';
}

/**
 * Change de mode.
 *  - "demo" : mémorise l'état réel, vide l'état transitoire (frame, évaluation,
 *    alerte), garde profil et réglages en lecture pour calculer les seuils par
 *    âge. Rien n'est écrit en base (voir isWriteBlocked()).
 *  - "live" : restaure l'état réel mémorisé et efface TOUT l'état de démo
 *    (patchAppliedAt de test, frames de test, alerte de test…).
 * Met à jour <body data-mode="…">.
 * @param {"live"|"demo"} mode
 * @returns {AppState}
 */
export function setMode(mode) {
  if (mode !== 'live' && mode !== 'demo') {
    throw new RangeError(`Mode inconnu : ${mode}`);
  }
  if (mode === state.mode) return getState();

  const prev = state;
  let next;

  if (mode === 'demo') {
    // Instantané de l'état réel (sans les réglages, inchangés par la démo).
    liveSnapshot = clone({
      profile: prev.profile,
      latestFrame: prev.latestFrame,
      latestAssessment: prev.latestAssessment,
      patchAppliedAt: prev.patchAppliedAt,
      alertActive: prev.alertActive,
    });
    next = { ...prev, mode: 'demo' };
    for (const key of TRANSIENT_KEYS) next[key] = key === 'alertActive' ? false : null;
    // Pose du patch fictive : la démo pilote sa propre valeur (#demo-patch-hours).
    next.patchAppliedAt = Date.now();
  } else {
    const snap = liveSnapshot || {};
    next = {
      ...prev,
      mode: 'live',
      profile: snap.profile ?? prev.profile,
      latestFrame: snap.latestFrame ?? null,
      latestAssessment: snap.latestAssessment ?? null,
      patchAppliedAt: snap.patchAppliedAt ?? null,
      alertActive: false,
    };
    liveSnapshot = null; // plus aucune trace de la démo
  }

  state = next;
  if (typeof document !== 'undefined' && document.body) {
    document.body.setAttribute('data-mode', mode);
  }
  notify(prev, { mode });
  return getState();
}

/**
 * Remet le store à zéro (réinitialisation des données).
 * @returns {AppState}
 */
export function resetState() {
  const prev = state;
  liveSnapshot = null;
  state = createInitialState();
  if (typeof document !== 'undefined' && document.body) {
    document.body.setAttribute('data-mode', 'live');
  }
  notify(prev, { reset: true });
  return getState();
}

/**
 * Convertit "YYYY-MM-DD" en Date locale à midi (évite les décalages de fuseau
 * et d'heure d'été). Retourne null si le format ou la date est invalide.
 * @param {string} iso
 * @returns {Date|null}
 */
function parseISODate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d, 12, 0, 0);
  const valid =
    date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d;
  return valid ? date : null;
}

/** Nombre de jours dans un mois (mois 0-11). */
function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

/**
 * Âge en mois révolus à une date donnée.
 * Règle de fin de mois : un bébé né le 31 a « un mois » le dernier jour du mois
 * suivant s'il compte moins de 31 jours (ex. né le 31/01 -> 1 mois le 28/02).
 * Retourne null si la date est invalide ou dans le futur.
 *
 * Tests simples (valeurs attendues) :
 *   computeAgeMonths('2026-06-10', new Date(2026, 9, 10))  // 4  (jour pour jour)
 *   computeAgeMonths('2026-06-11', new Date(2026, 9, 10))  // 3  (le 11 n'est pas atteint)
 *   computeAgeMonths('2026-01-31', new Date(2026, 1, 28))  // 1  (fin de mois)
 *   computeAgeMonths('2026-01-31', new Date(2026, 1, 27))  // 0  (28 février pas encore atteint)
 *   computeAgeMonths('2024-10-10', new Date(2026, 9, 10))  // 24
 *   computeAgeMonths('2026-10-10', new Date(2026, 9, 10))  // 0  (né aujourd'hui)
 *   computeAgeMonths('2027-01-01', new Date(2026, 9, 10))  // null (date future)
 *   computeAgeMonths('abc', new Date(2026, 9, 10))         // null (invalide)
 *
 * @param {string} birthdateISO "YYYY-MM-DD"
 * @param {Date} [today=new Date()]
 * @returns {number|null}
 */
export function computeAgeMonths(birthdateISO, today = new Date()) {
  const birth = parseISODate(birthdateISO);
  if (!birth || !(today instanceof Date) || Number.isNaN(today.getTime())) return null;

  // Comparaison au jour près (on ignore l'heure).
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0);
  if (birth.getTime() > t.getTime()) return null;

  let months =
    (t.getFullYear() - birth.getFullYear()) * 12 + (t.getMonth() - birth.getMonth());

  if (t.getDate() < birth.getDate()) {
    // Le « jour anniversaire » du mois n'est pas atteint… sauf si on est au
    // dernier jour d'un mois plus court que le jour de naissance.
    const isLastDay = t.getDate() === daysInMonth(t.getFullYear(), t.getMonth());
    if (!isLastDay) months -= 1;
  }
  return Math.max(0, months);
}