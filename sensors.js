/**
 * NeoGuard — js/sensors.js
 * ---------------------------------------------------------------------------
 * Interface SensorSource + implémentation SimulatedSensor (sans matériel).
 *
 * Chaque capteur émet ~1 frame par seconde, conforme au contrat de données :
 *   { t: epochMs, hr: bpm, ecg: number[], rr: resp/min, motion: 0..100,
 *     orientation: "dos|ventre|cote-gauche|cote-droit",
 *     patchConnected: boolean, patchAppliedAt: epochMs }
 *
 * Remarques pour les autres modules :
 *  - Une pause respiratoire se lit dans les frames : rr = 0 et motion ≈ 0.
 *    Sa durée est calculée par ai.js (nombre de secondes consécutives).
 *  - Quand le patch est déconnecté, AUCUNE frame n'est émise : l'événement
 *    "disconnected" prévient (main.js gère le délai de 60 s -> vigilance).
 *  - Aide à la surveillance : données simulées, aucun usage médical.
 */

/** Fréquence d'échantillonnage de l'ECG synthétique (Hz). */
export const ECG_SAMPLE_RATE = 125;

/** Orientations valides (identiques au contrat HTML). */
export const ORIENTATIONS = Object.freeze(['dos', 'ventre', 'cote-gauche', 'cote-droit']);

/** Constante de temps du lissage : ~95 % de l'écart résorbé en 1,5 s (3 × 0,5 s). */
const SMOOTHING_TAU_S = 0.5;

/**
 * @typedef {Object} SensorFrame
 * @property {number} t
 * @property {number} hr
 * @property {number[]} ecg
 * @property {number} rr
 * @property {number} motion
 * @property {string} orientation
 * @property {boolean} patchConnected
 * @property {number} patchAppliedAt
 */

/**
 * @typedef {Object} SensorOverrides
 * @property {number} [hr]              FC forcée (20-250)
 * @property {number} [rr]              Respiration forcée (0-120)
 * @property {number} [motion]          Mouvement forcé (0-100)
 * @property {string} [orientation]     "dos|ventre|cote-gauche|cote-droit"
 * @property {boolean} [patchConnected] false = patch déconnecté
 * @property {boolean|number} [apnea]   true = pause jusqu'à annulation ;
 *                                      nombre = durée en secondes
 * @property {boolean} [arrhythmia]     (extra) battements irréguliers visibles à l'ECG
 * @property {number} [patchAppliedAt]  (extra) époque de pose de la partie collante
 * Une clé à null/undefined retire la surcharge correspondante.
 */

/**
 * Interface commune des sources de données (simulée aujourd'hui,
 * Bluetooth demain). Fournit aussi un petit émetteur d'événements.
 * Événements : "frame" (SensorFrame), "connected", "disconnected" ({ t }).
 */
export class SensorSource {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._handlers = new Map();
  }

  /** Démarre l'émission des frames. */
  start() { throw new Error('SensorSource.start() non implémentée'); }

  /** Arrête l'émission (aucun événement émis). */
  stop() { throw new Error('SensorSource.stop() non implémentée'); }

  /**
   * Remplace des paramètres par des valeurs de démonstration.
   * @param {SensorOverrides|null} _overrides null = tout retirer
   */
  setOverrides(_overrides) { /* facultatif pour une source réelle */ }

  /** @returns {boolean} le patch est-il connecté et le flux actif ? */
  isConnected() { throw new Error('SensorSource.isConnected() non implémentée'); }

  /**
   * Abonnement aux frames.
   * @param {(frame: SensorFrame) => void} cb
   * @returns {() => void} désabonnement
   */
  onFrame(cb) { return this.on('frame', cb); }

  /**
   * Abonnement générique.
   * @param {"frame"|"connected"|"disconnected"} type
   * @param {Function} cb
   * @returns {() => void} désabonnement
   */
  on(type, cb) {
    if (typeof cb !== 'function') return () => {};
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(cb);
    return () => this._handlers.get(type)?.delete(cb);
  }

  /** Émet un événement ; l'erreur d'un abonné n'arrête pas les autres. */
  _emit(type, payload) {
    const set = this._handlers.get(type);
    if (!set) return;
    for (const cb of Array.from(set)) {
      try { cb(payload); } catch (err) { console.error(`[NeoGuard/sensors] abonné "${type}" :`, err); }
    }
  }
}

/* ------------------------------ Utilitaires ------------------------------ */

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Forme d'un complexe PQRST centré sur le pic R (t en secondes, R à t = 0).
 * Somme de gaussiennes : [amplitude, centre (s), largeur (s)].
 */
const PQRST = [
  [0.12, -0.17, 0.025],  // P
  [-0.12, -0.035, 0.010], // Q
  [1.0, 0.0, 0.012],      // R
  [-0.22, 0.04, 0.012],   // S
  [0.28, 0.24, 0.045],    // T
];

function qrstShape(t) {
  if (t < -0.4 || t > 0.6) return 0; // hors du complexe : contribution nulle
  let v = 0;
  for (const [a, c, w] of PQRST) v += a * Math.exp(-((t - c) * (t - c)) / (2 * w * w));
  return v;
}

/* --------------------------- SimulatedSensor ----------------------------- */

/**
 * Capteur simulé : une frame par seconde, FC/respiration naturelles,
 * ECG synthétique à 125 Hz, sommeil calme/agité, changements de position rares.
 */
export class SimulatedSensor extends SensorSource {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.baseHr=125]   FC de repos du bébé simulé
   * @param {number} [opts.baseRr=40]    Respiration de repos
   * @param {number} [opts.seed]         Graine (tests reproductibles)
   * @param {number} [opts.patchAppliedAt] Époque de pose de la partie collante
   * @param {number} [opts.tickMs=1000]  Période d'émission (tests)
   */
  constructor(opts = {}) {
    super();
    this._baseHr = isNum(opts.baseHr) ? opts.baseHr : 125;
    this._baseRr = isNum(opts.baseRr) ? opts.baseRr : 40;
    this._tickMs = isNum(opts.tickMs) && opts.tickMs > 0 ? opts.tickMs : 1000;
    this._rand = mulberry32(isNum(opts.seed) ? opts.seed : Math.floor(Math.random() * 2 ** 31));
    this._patchAppliedAt = isNum(opts.patchAppliedAt) ? opts.patchAppliedAt : Date.now();

    this._timer = null;
    this._running = false;
    this._connected = true;      // piloté par l'override patchConnected
    this._overrides = {};
    this._apneaUntil = null;     // époque de fin d'apnée (si durée demandée)
    this._lastTickAt = 0;
    this._lastFrame = null;

    // Valeurs lissées courantes (celles qui sortent dans les frames).
    this._cur = { hr: this._baseHr, rr: this._baseRr, motion: 6 };
    this._orientation = 'dos';

    // Modèle naturel.
    this._agitated = false;
    this._agitatedLeft = 0;
    this._driftHr = 0;
    this._driftRr = 0;

    // État de l'ECG synthétique (indices d'échantillons).
    this._sample = 0;
    this._lastBeat = -ECG_SAMPLE_RATE * 0.5;
    this._nextBeat = 0;
    this._compensate = false;    // pause compensatoire après un battement prématuré
    this._respPhase = 0;         // phase respiratoire (rad) : arythmie sinusale + dérive
  }

  /* ----------------------------- Cycle de vie ---------------------------- */

  start() {
    if (this._running) return;
    this._running = true;
    this._lastTickAt = Date.now();
    this._syncConnection();
    if (this._connected) this._tick(1); // première frame immédiate
    this._timer = setInterval(() => this._onTimer(), this._tickMs);
  }

  stop() {
    if (this._timer !== null) clearInterval(this._timer);
    this._timer = null;
    this._running = false;
  }

  isConnected() {
    return this._running && this._connected;
  }

  /** Dernière frame émise (ou null). Utile aux graphes. */
  getLastFrame() {
    return this._lastFrame;
  }

  /** Copie des surcharges actives. */
  getOverrides() {
    return { ...this._overrides };
  }

  /** Redéfinit la date de pose de la partie collante (bouton « J'ai changé… »). */
  setPatchAppliedAt(epochMs) {
    if (isNum(epochMs)) this._patchAppliedAt = epochMs;
  }

  /* ------------------------------ Surcharges ----------------------------- */

  /**
   * Applique/retire des surcharges (démo). Valeurs hors plage ramenées dans
   * les bornes ; clé à null/undefined = surcharge retirée ; null = tout retirer.
   * @param {SensorOverrides|null} obj
   */
  setOverrides(obj) {
    if (obj === null) {
      this._overrides = {};
      this._apneaUntil = null;
      this._syncConnection();
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    const ov = this._overrides;

    /** Pose ou retire une surcharge numérique bornée. */
    const setNum = (key, v, lo, hi) => {
      if (v === null || v === undefined) delete ov[key];
      else if (isNum(v)) ov[key] = clamp(v, lo, hi);
    };

    for (const [key, v] of Object.entries(obj)) {
      switch (key) {
        case 'hr': setNum('hr', v, 20, 250); break;
        case 'rr': setNum('rr', v, 0, 120); break;
        case 'motion': setNum('motion', v, 0, 100); break;
        case 'orientation':
          if (v === null || v === undefined) delete ov.orientation;
          else if (ORIENTATIONS.includes(v)) ov.orientation = v;
          break;
        case 'patchConnected':
          if (v === null || v === undefined) delete ov.patchConnected;
          else ov.patchConnected = Boolean(v);
          break;
        case 'apnea':
          if (v === true) { ov.apnea = true; this._apneaUntil = null; }
          else if (isNum(v) && v > 0) { ov.apnea = true; this._apneaUntil = Date.now() + v * 1000; }
          else { delete ov.apnea; this._apneaUntil = null; }
          break;
        case 'arrhythmia':
          if (v) ov.arrhythmia = true; else delete ov.arrhythmia;
          break;
        case 'patchAppliedAt': this.setPatchAppliedAt(v); break;
        default:
          console.warn(`[NeoGuard/sensors] surcharge inconnue ignorée : ${key}`);
      }
    }
    this._syncConnection();
  }

  /* ------------------------------ Connexion ------------------------------ */

  /** Aligne l'état de connexion sur l'override et émet l'événement voulu. */
  _syncConnection() {
    const want = this._overrides.patchConnected !== false;
    if (want === this._connected) return;
    this._connected = want;
    if (this._running) this._emit(want ? 'connected' : 'disconnected', { t: Date.now() });
  }

  /* -------------------------------- Boucle ------------------------------- */

  _onTimer() {
    const now = Date.now();
    // Durée réelle écoulée (onglet en arrière-plan => timers ralentis), bornée.
    const dt = clamp((now - this._lastTickAt) / 1000, 0.5, 3);
    this._lastTickAt = now;
    this._syncConnection();
    if (!this._connected) return; // déconnecté : aucune frame
    this._tick(dt);
  }

  /** Construit et émet une frame. @param {number} dt secondes écoulées */
  _tick(dt) {
    try {
      const frame = this._buildFrame(dt);
      this._lastFrame = frame;
      this._emit('frame', frame);
    } catch (err) {
      console.error('[NeoGuard/sensors] erreur de génération :', err);
    }
  }

  /** Gaussienne centrée réduite (Box-Muller). */
  _gauss() {
    const u1 = Math.max(this._rand(), 1e-9);
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * this._rand());
  }

  /**
   * Modèle naturel : sommeil calme / agitation occasionnelle, dérive lente,
   * changements de position rares (jamais sur le ventre de lui-même).
   */
  _natural(dt) {
    // Machine à états du sommeil : agitation ~ toutes les 10 min, 20-60 s.
    if (this._agitated) {
      this._agitatedLeft -= dt;
      if (this._agitatedLeft <= 0) this._agitated = false;
    } else if (this._rand() < dt / 600) {
      this._agitated = true;
      this._agitatedLeft = 20 + this._rand() * 40;
    }
    // Dérive lente (processus AR(1)) : variations naturelles de quelques bpm.
    this._driftHr = 0.98 * this._driftHr + this._gauss() * 0.3;
    this._driftRr = 0.98 * this._driftRr + this._gauss() * 0.12;

    // Changement de position rare (~ toutes les 30 min) entre dos et côtés.
    if (this._rand() < dt / 1800) {
      const choices = ['dos', 'cote-gauche', 'cote-droit'].filter((o) => o !== this._orientation);
      this._orientation = choices[Math.floor(this._rand() * choices.length)];
    }

    const a = this._agitated;
    return {
      hr: this._baseHr * (a ? 1.0 : 0.96) + (a ? 12 : 0) + this._driftHr,
      rr: this._baseRr * (a ? 1.0 : 0.92) + (a ? 6 : 0) + this._driftRr,
      motion: a ? clamp(45 + this._gauss() * 15, 20, 90) : 5 + Math.abs(this._gauss()) * 3,
    };
  }

  /** L'apnée est-elle active ? (gère la fin automatique d'une durée demandée) */
  _apneaActive() {
    const ov = this._overrides;
    if (ov.apnea !== true) return false;
    if (this._apneaUntil !== null && Date.now() >= this._apneaUntil) {
      delete ov.apnea;
      this._apneaUntil = null;
      return false;
    }
    return true;
  }

  _buildFrame(dt) {
    const ov = this._overrides;
    const nat = this._natural(dt);
    const cur = this._cur;
    const alpha = 1 - Math.exp(-dt / SMOOTHING_TAU_S); // lissage ~1,5 s
    const apnea = this._apneaActive();

    const targetHr = ov.hr ?? nat.hr;
    const targetRr = ov.rr ?? nat.rr;
    const targetMotion = ov.motion ?? nat.motion;

    cur.hr += (targetHr - cur.hr) * alpha;

    if (apnea) {
      // Pause respiratoire : respiration plate immédiatement (l'arrêt est net),
      // mouvement thoracique ~ 0. Le retour à la normale, lui, est lissé.
      cur.rr = 0;
      cur.motion = Math.abs(this._gauss()) * 0.6;
    } else {
      cur.rr += (targetRr - cur.rr) * alpha;
      if (targetRr === 0 && cur.rr < 0.5) cur.rr = 0; // « collé » à zéro
      cur.motion += (targetMotion - cur.motion) * alpha;
    }

    // Orientation : le gyroscope réagit tout de suite.
    const orientation = ov.orientation ?? this._orientation;

    const ecg = this._generateEcg(dt);

    const rrOut = cur.rr === 0 ? 0 : Math.max(0, cur.rr + this._gauss() * 0.5);
    return {
      t: Date.now(),
      hr: Math.round(clamp(cur.hr + this._gauss() * 0.8, 20, 250)),
      ecg,
      rr: Math.round(rrOut),
      motion: Math.round(clamp(cur.motion, 0, 100)),
      orientation,
      patchConnected: true, // une frame n'existe que si le patch est connecté
      patchAppliedAt: this._patchAppliedAt,
    };
  }

  /* --------------------------------- ECG --------------------------------- */

  /** Intervalle R-R (en échantillons) du prochain battement. */
  _nextIntervalSamples() {
    const cur = this._cur;
    // Arythmie sinusale respiratoire : la FC oscille au rythme de la respiration.
    const rsa = cur.rr > 0 ? 2.5 * Math.sin(this._respPhase) : 0;
    let sec = 60 / Math.max(20, cur.hr + rsa);

    if (this._overrides.arrhythmia) {
      // Extrasystoles (battement prématuré + pause compensatoire) et jitter.
      if (this._compensate) { sec *= 1.45; this._compensate = false; }
      else if (this._rand() < 0.2) { sec *= 0.55; this._compensate = true; }
      else sec *= 1 + (this._rand() - 0.5) * 0.3;
    } else {
      sec *= 1 + this._gauss() * 0.01; // variabilité très légère
    }
    return Math.max(0.25, sec) * ECG_SAMPLE_RATE;
  }

  /**
   * Génère les échantillons ECG de la dernière seconde, en continuité avec
   * la frame précédente (les battements chevauchent les frames).
   * @param {number} dt secondes écoulées
   * @returns {number[]}
   */
  _generateEcg(dt) {
    const n = clamp(Math.round(ECG_SAMPLE_RATE * dt), 60, 375);
    const cur = this._cur;

    // Si la FC vient d'augmenter, ne pas attendre un battement trop lointain.
    if (!this._overrides.arrhythmia) {
      const maxNext = this._lastBeat + (60 / Math.max(20, cur.hr)) * ECG_SAMPLE_RATE * 1.1;
      if (this._nextBeat > maxNext) this._nextBeat = Math.max(maxNext, this._sample + 1);
    }

    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const s = this._sample;
      if (s >= this._nextBeat) {
        this._lastBeat = this._nextBeat;
        this._nextBeat = this._lastBeat + this._nextIntervalSamples();
      }
      // Complexe du battement précédent + onde P/Q du suivant.
      const v =
        qrstShape((s - this._lastBeat) / ECG_SAMPLE_RATE) +
        qrstShape((s - this._nextBeat) / ECG_SAMPLE_RATE) +
        0.04 * Math.sin(this._respPhase) +                      // ligne de base qui respire
        0.02 * Math.sin((2 * Math.PI * 0.1 * s) / ECG_SAMPLE_RATE) + // dérive lente
        this._gauss() * 0.012;                                  // bruit
      this._respPhase += (2 * Math.PI * cur.rr) / 60 / ECG_SAMPLE_RATE;
      out[i] = Math.round(v * 1000) / 1000;
      this._sample++;
    }
    return out;
  }
}

/* ----------------------- Adaptateur futur (Bluetooth) ---------------------
 * BluetoothSensor (Web Bluetooth) — NON implémenté, respecterait la même
 * interface que SensorSource :
 *
 *   export class BluetoothSensor extends SensorSource {
 *     async start() {
 *       // 1. navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE_UUID] }] })
 *       //    (geste utilisateur obligatoire, contexte HTTPS)
 *       // 2. device.gatt.connect(), puis getPrimaryService / getCharacteristic
 *       // 3. characteristic.startNotifications() ;
 *       //    addEventListener('characteristicvaluechanged', e => décoder e.target.value
 *       //    (DataView) -> { hr, ecg[], rr, motion, orientation, patchAppliedAt })
 *       //    puis this._emit('frame', frame) environ 1 fois par seconde.
 *       // 4. device 'gattserverdisconnected' -> this._emit('disconnected', { t })
 *       //    + tentative de reconnexion ; 'connected' au retour.
 *     }
 *     stop() { device.gatt.disconnect(); }
 *     isConnected() { return Boolean(device?.gatt?.connected); }
 *     // setOverrides() : sans effet (données réelles).
 *   }
 * ------------------------------------------------------------------------ */