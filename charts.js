/**
 * NeoGuard — js/charts.js
 * ---------------------------------------------------------------------------
 * Graphiques en canvas pur (aucune bibliothèque) :
 *   - drawLiveECG(canvas, source)   : ECG défilant sur 8 s
 *   - drawLiveResp(canvas, source)  : onde respiratoire (fréquence = RR,
 *                                     amplitude = motion, apnée = ligne plate)
 *   - drawHistory(canvas, series, range, options) : courbes sur 24h / 7j / 30j
 *
 * Principes communs :
 *   - requestAnimationFrame + devicePixelRatio (rendu net sur écrans HiDPI) ;
 *   - rendu mis en pause quand l'onglet est caché OU que le canvas n'est pas
 *     visible (écran masqué par l'attribut hidden) → économie de batterie ;
 *   - transitions lissées (lerp exponentiel indépendant du framerate) ;
 *   - couleurs lues dans les variables CSS (--ecg-color, --resp-color, --danger…),
 *     avec valeurs de secours si absentes → compatible thème jour/nuit ;
 *   - le quadrillé « papier ECG » est dessiné par le CSS du canvas (style.css) :
 *     charts.js ne dessine donc pas de grille en plus (pas de double quadrillage) ;
 *   - aucune variable globale exposée : tout est encapsulé dans le module.
 *
 * Hypothèses d'interface (à respecter dans main.js / sensors.js) :
 *   - `source` (graphes live) est un objet { getFrame(), getLevel?(),
 *     getPauseSeconds?() } — voir typedef ChartSource ci-dessous ;
 *   - chaque frame du capteur apporte ses NOUVEAUX échantillons ECG
 *     (~125 par seconde à 125 Hz), sans recouvrement avec la frame précédente.
 *
 * Accessibilité : les graphes sont des <canvas> décoratifs pour le live
 * (les valeurs chiffrées sont dans #hr-value / #rr-value). Pour l'historique,
 * un résumé textuel est posé en aria-label et le journal #alert-list reste
 * l'équivalent clavier/lecteur d'écran des marqueurs cliquables.
 * ---------------------------------------------------------------------------
 */

/**
 * Source de données fournie aux graphes live.
 * @typedef {Object} ChartSource
 * @property {() => (Object|null)} getFrame  Dernière frame (contrat de données :
 *   { t, hr, ecg[], rr, motion, orientation, patchConnected, patchAppliedAt }).
 * @property {() => string} [getLevel]  Niveau courant : "normal" | "vigilance" |
 *   "pathologie-legere" | "urgence" (défaut "normal").
 * @property {() => (number|null)} [getPauseSeconds]  Durée de la pause
 *   respiratoire en cours, si l'IA la calcule (sinon le graphe la mesure).
 */

/**
 * Point d'une série d'historique.
 * @typedef {Object} HistoryPoint
 * @property {number} t        Horodatage epoch ms.
 * @property {number} v        Valeur (bpm, resp/min ou score 0-100).
 * @property {string} [level]  Niveau associé (sert à teinter l'arrière-plan).
 */

/**
 * Alerte affichable sur l'historique.
 * @typedef {Object} HistoryAlert
 * @property {number} t
 * @property {string} level
 * @property {string[]} [reasons]
 */

/**
 * Options de drawHistory.
 * @typedef {Object} HistoryOptions
 * @property {"hr"|"rr"|"risk"} [kind="hr"]  Type de courbe.
 * @property {HistoryAlert[]} [alerts]       Marqueurs d'alertes cliquables.
 * @property {{min:number,max:number}} [normalRange]  Plage normale (FC/RR) selon l'âge.
 * @property {number} [now]                  Fin de fenêtre (défaut Date.now()).
 * @property {(alert: HistoryAlert) => void} [onMarkerSelect]  Callback au clic.
 */

// ===========================================================================
// 1. Utilitaires
// ===========================================================================

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, k) => a + (b - a) * k;
/** Coefficient de lissage exponentiel : indépendant de la fréquence d'affichage. */
const smooth = (dt, tau) => 1 - Math.exp(-dt / tau);

/** Registre canvas → contrôleur, pour éviter deux graphes sur le même canvas. */
const registry = new Map();

/** Couleurs de secours si une variable CSS du contrat est absente. */
const FALLBACK = {
  text: '#e8eef7', muted: '#8a97ab', primary: '#4f8cff', primaryStrong: '#1f5fa8',
  ok: '#2ecc71', warn: '#f5a623', danger: '#e5484d',
  warnText: '#7a4a00', dangerText: '#b3202a', surface: '#1b2230',
  fontBody: 'system-ui, -apple-system, "Segoe UI", sans-serif',
};

let themeCache = null;
let themeStamp = 0;

/**
 * Lit les variables CSS du thème (mises en cache 500 ms : le thème jour/nuit
 * peut changer, mais on évite d'appeler getComputedStyle à chaque image).
 * @returns {Object} couleurs du thème (text, muted, primary, primaryStrong, ok,
 *   warn, danger, warnText, dangerText, surface, ecg, resp, fontBody)
 */
function readTheme() {
  const now = performance.now();
  if (themeCache && now - themeStamp < 500) return themeCache;
  const cs = getComputedStyle(document.body || document.documentElement);
  const get = (name, fb) => (cs.getPropertyValue(name) || '').trim() || fb;
  const primary = get('--primary', FALLBACK.primary);
  themeCache = {
    text: get('--text', FALLBACK.text),
    muted: get('--muted', FALLBACK.muted),
    primary,
    primaryStrong: get('--primary-strong', FALLBACK.primaryStrong),
    ok: get('--ok', FALLBACK.ok),
    warn: get('--warn', FALLBACK.warn),
    danger: get('--danger', FALLBACK.danger),
    warnText: get('--warn-text', FALLBACK.warnText),
    dangerText: get('--danger-text', FALLBACK.dangerText),
    surface: get('--surface', FALLBACK.surface),
    ecg: get('--ecg-color', primary),
    resp: get('--resp-color', primary),
    fontBody: get('--font-body', FALLBACK.fontBody),
  };
  themeStamp = now;
  return themeCache;
}

/** Trace un rectangle arrondi (sans dépendre de ctx.roundRect). */
function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Découpe un texte en lignes qui tiennent dans maxW pixels. */
function wrapText(ctx, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/**
 * Met à jour l'aria-label d'un canvas au plus toutes les 2 s, et seulement
 * si le texte change (les canvas du HTML démarrent sur « en attente de données »).
 */
function makeLabelUpdater(canvas) {
  let lastText = '';
  let lastAt = -Infinity; // -Infinity : le premier libellé passe toujours
  return (text) => {
    const now = performance.now();
    if (text === lastText || now - lastAt < 2000) return;
    lastText = text;
    lastAt = now;
    canvas.setAttribute('aria-label', text);
  };
}

/** Affiche un message centré (ex. « Patch déconnecté »). */
function drawCenterText(ctx, w, h, text, th, size = 14) {
  ctx.save();
  ctx.fillStyle = th.muted;
  ctx.font = `${size}px ${th.fontBody}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h / 2);
  ctx.restore();
}

// ===========================================================================
// 2. Moteur de rendu commun (DPR, redimensionnement, pause hors écran)
// ===========================================================================

/**
 * Crée un moteur de rendu lié à un canvas.
 * - continuous = true  : boucle rAF tant que le canvas est visible ;
 * - continuous = false : un seul rendu à chaque kick() (historique).
 *
 * @param {HTMLCanvasElement} canvas
 * @param {(ctx:CanvasRenderingContext2D, w:number, h:number, dt:number, resumed:boolean) => void} draw
 * @param {boolean} continuous
 * @returns {{kick:() => void, destroy:() => void}}
 */
function createRenderer(canvas, draw, continuous) {
  const ctx = canvas.getContext('2d');
  let w = 0;
  let h = 0;
  let raf = 0;
  let last = 0;
  let destroyed = false;
  let inView = true;
  let errorLogged = false;

  /** Adapte la résolution interne du canvas à sa taille CSS × devicePixelRatio. */
  function fit() {
    // clientWidth/Height = zone de dessin réelle (sans la bordure CSS de 1 px),
    // sinon le bitmap serait légèrement étiré.
    const dpr = window.devicePixelRatio || 1;
    w = Math.max(0, canvas.clientWidth);
    h = Math.max(0, canvas.clientHeight);
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw || canvas.height !== ph) {
      canvas.width = pw;
      canvas.height = ph;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Vrai si l'onglet est actif et le canvas réellement affiché. */
  function isVisible() {
    return !destroyed && !document.hidden && inView && canvas.getClientRects().length > 0;
  }

  function frame(ts) {
    raf = 0;
    if (destroyed) return;
    if (!isVisible()) {
      last = 0; // on reprendra proprement au retour (kick par les observateurs)
      return;
    }
    fit();
    if (w > 0 && h > 0) {
      let dt = last ? (ts - last) / 1000 : 0;
      last = ts;
      const resumed = dt === 0 || dt > 0.5; // reprise après pause ou gros ralentissement
      if (resumed) dt = 1 / 60;
      ctx.clearRect(0, 0, w, h);
      try {
        draw(ctx, w, h, dt, resumed);
      } catch (err) {
        // Jamais d'écran blanc : on journalise une seule fois et on continue.
        if (!errorLogged) {
          console.error('[NeoGuard/charts] Erreur de rendu :', err);
          errorLogged = true;
        }
      }
    }
    if (continuous) raf = requestAnimationFrame(frame);
  }

  /** (Re)lance un rendu si aucun n'est déjà planifié. */
  function kick() {
    if (!raf && !destroyed) raf = requestAnimationFrame(frame);
  }

  // Observateurs : relancent le rendu quand le canvas redevient visible/change de taille.
  const onVisibility = () => kick();
  document.addEventListener('visibilitychange', onVisibility);

  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => kick()) : null;
  if (ro) ro.observe(canvas);

  const io = typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((entries) => {
      inView = entries[entries.length - 1].isIntersecting;
      kick();
    })
    : null;
  if (io) io.observe(canvas);

  kick();

  return {
    kick,
    destroy() {
      destroyed = true;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      document.removeEventListener('visibilitychange', onVisibility);
      if (ro) ro.disconnect();
      if (io) io.disconnect();
    },
  };
}

/**
 * Détruit le graphe attaché à un canvas (arrête rAF et observateurs).
 * @param {HTMLCanvasElement} canvas
 */
export function destroyChart(canvas) {
  const ctrl = registry.get(canvas);
  if (ctrl) ctrl.destroy();
}

/** Détruit tous les graphes (ex. changement de mode live ↔ démo). */
export function destroyAllCharts() {
  for (const ctrl of [...registry.values()]) ctrl.destroy();
}

// ===========================================================================
// 3. ECG en direct
// ===========================================================================

/**
 * ECG défilant (fenêtre de 8 s, tracé continu).
 *
 * Les échantillons de chaque frame (~125 / s) sont placés dans une file puis
 * consommés à 125 Hz réels : le tracé défile de façon fluide même si les frames
 * n'arrivent qu'une fois par seconde (latence d'affichage ≈ 0,6 s). La vitesse
 * de consommation s'adapte légèrement pour ne jamais accumuler de retard.
 * Le rythme visible (distance entre pics R) vient directement des échantillons
 * du capteur : si la FC change, l'espacement des pics change ; une arythmie
 * simulée reste visible.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {ChartSource} source
 * @returns {{destroy: () => void}}
 */
export function drawLiveECG(canvas, source) {
  destroyChart(canvas);

  const FS = 125; // Hz
  const WINDOW_S = 8; // secondes visibles
  const N = FS * WINDOW_S;
  const TARGET_BUFFER = Math.round(FS * 0.6); // marge de lecture
  const buf = new Float32Array(N); // tampon circulaire des valeurs affichées
  let head = 0;
  let count = 0;
  let queue = []; // échantillons reçus, pas encore affichés
  let qi = 0; // index de lecture dans la file
  let acc = 0; // reste fractionnaire d'échantillons à consommer
  let lastT = null;
  let lastFrameAt = 0;
  let lo = -1;
  let hi = 1;
  let ranged = false;
  let dangerMix = 0; // 0 = couleur normale, 1 = rouge urgence
  const setLabel = makeLabelUpdater(canvas);

  /** Récupère la dernière frame et empile ses nouveaux échantillons. */
  function pull() {
    const frame = source.getFrame();
    if (frame && frame.t !== lastT) {
      lastT = frame.t;
      lastFrameAt = performance.now();
      if (frame.patchConnected !== false && Array.isArray(frame.ecg)) {
        const s = frame.ecg.length > 2 * FS ? frame.ecg.slice(-2 * FS) : frame.ecg;
        for (const v of s) if (Number.isFinite(v)) queue.push(v);
      }
    }
    return frame;
  }

  function draw(ctx, w, h, dt, resumed) {
    const th = readTheme();

    // Reprise après une pause : on repart d'une file vide (évite un rattrapage brutal).
    if (resumed) {
      queue = [];
      qi = 0;
      acc = 0;
    }

    const frame = pull();
    const connected = !!frame && frame.patchConnected !== false
      && performance.now() - lastFrameAt < 3000;

    // --- Consommation des échantillons à vitesse adaptative ---
    let avail = queue.length - qi;
    if (avail > 4 * FS) { // trop de retard : on saute les plus anciens
      qi = queue.length - 2 * FS;
      avail = 2 * FS;
    }
    const rate = FS * clamp(1 + (avail - TARGET_BUFFER) / FS, 0.5, 3);
    acc += rate * dt;
    const want = Math.floor(acc);
    acc -= want;
    const n = Math.min(want, avail);
    for (let i = 0; i < n; i++) {
      buf[head] = queue[qi++];
      head = (head + 1) % N;
      if (count < N) count++;
    }
    if (qi > 4 * FS) { // compactage de la file
      queue = queue.slice(qi);
      qi = 0;
    }

    // --- Couleur selon le niveau (fondu vers le rouge en urgence) ---
    const level = typeof source.getLevel === 'function' ? source.getLevel() : 'normal';
    dangerMix = lerp(dangerMix, level === 'urgence' ? 1 : 0, smooth(dt, 0.25));

    // --- Normalisation d'amplitude (extension immédiate, contraction lissée) ---
    if (count > 1) {
      let mn = Infinity;
      let mx = -Infinity;
      for (let i = 0; i < count; i++) {
        const v = buf[(head - count + i + N) % N];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const span = Math.max(mx - mn, 1e-3);
      const tlo = mn - span * 0.12;
      const thi = mx + span * 0.12;
      if (!ranged) {
        lo = tlo;
        hi = thi;
        ranged = true;
      } else {
        const k = smooth(dt, 1.2);
        lo = tlo < lo ? tlo : lerp(lo, tlo, k);
        hi = thi > hi ? thi : lerp(hi, thi, k);
      }
    }

    // (Le quadrillé « papier ECG » est fourni par le CSS du canvas.)
    const pps = w / (N - 1); // pixels par échantillon

    // --- Tracé ---
    if (count > 1) {
      const padY = 8;
      const range = Math.max(hi - lo, 1e-6);
      const path = new Path2D();
      for (let i = 0; i < count; i++) {
        const v = buf[(head - count + i + N) % N];
        const x = w - (count - 1 - i) * pps;
        const y = padY + (1 - (v - lo) / range) * (h - 2 * padY);
        if (i === 0) path.moveTo(x, y);
        else path.lineTo(x, y);
      }
      ctx.save();
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.globalAlpha = connected ? 1 : 0.3;
      ctx.strokeStyle = th.ecg;
      ctx.stroke(path);
      if (dangerMix > 0.01) { // superposition rouge, d'autant plus opaque que l'urgence est installée
        ctx.globalAlpha = (connected ? 1 : 0.3) * dangerMix;
        ctx.strokeStyle = th.danger;
        ctx.stroke(path);
      }
      ctx.restore();
    }

    // --- Messages d'état + libellé accessible ---
    if (!frame) drawCenterText(ctx, w, h, 'En attente du patch…', th);
    else if (!connected) drawCenterText(ctx, w, h, 'Patch déconnecté — pas de signal', th);
    setLabel(connected
      ? `Courbe ECG en direct : ${Math.round(Number(frame.hr) || 0)} battements par minute`
      : 'Courbe ECG en direct : pas de signal du patch');
  }

  const renderer = createRenderer(canvas, draw, true);
  const ctrl = {
    destroy() {
      renderer.destroy();
      registry.delete(canvas);
    },
  };
  registry.set(canvas, ctrl);
  return ctrl;
}

// ===========================================================================
// 4. Respiration en direct
// ===========================================================================

/**
 * Onde respiratoire : la fréquence suit RR, l'amplitude suit motion,
 * une apnée (rr ≈ 0) donne une ligne plate et un badge « pause N s ».
 *
 * L'onde est synthétisée côté affichage (50 Hz) à partir de rr/motion, avec
 * lissage : un changement de paramètre est immédiatement lisible mais naturel.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {ChartSource} source
 * @returns {{destroy: () => void}}
 */
export function drawLiveResp(canvas, source) {
  destroyChart(canvas);

  const RS = 50; // points / seconde
  const WINDOW_S = 8;
  const N = RS * WINDOW_S;
  const buf = new Float32Array(N); // démarre à 0 : ligne plate immédiate
  let head = 0;
  let phase = 0;
  let freq = 0.25; // Hz (≈ 15/min au départ, converge vers RR)
  let amp = 0.4;
  let acc = 0;
  let pauseSec = 0;
  let dangerMix = 0;
  let lastT = null;
  let lastFrameAt = 0;
  const setLabel = makeLabelUpdater(canvas);

  function draw(ctx, w, h, dt, resumed) {
    const th = readTheme();
    const frame = source.getFrame();
    if (frame && frame.t !== lastT) {
      lastT = frame.t;
      lastFrameAt = performance.now();
    }
    const connected = !!frame && frame.patchConnected !== false
      && performance.now() - lastFrameAt < 3000;

    const rr = connected ? clamp(Number(frame.rr) || 0, 0, 90) : 0;
    const motion = connected ? clamp(Number(frame.motion) || 0, 0, 100) : 0;
    const apnea = connected && rr < 0.5;
    const targetAmp = connected && !apnea ? 0.3 + 0.7 * clamp(motion / 50, 0, 1) : 0;

    // Durée de pause : valeur de l'IA si fournie, sinon mesurée ici.
    if (apnea) pauseSec += dt;
    else pauseSec = 0;
    let pause = pauseSec;
    if (apnea && typeof source.getPauseSeconds === 'function') {
      const p = source.getPauseSeconds();
      if (Number.isFinite(p)) pause = p;
    }

    const level = typeof source.getLevel === 'function' ? source.getLevel() : 'normal';
    const dangerTarget = level === 'urgence' || (apnea && pause >= 20) ? 1 : 0;
    dangerMix = lerp(dangerMix, dangerTarget, smooth(dt, 0.25));

    // --- Simulation de l'onde, pas de 20 ms ---
    acc += (resumed ? 0 : dt) * RS;
    const nSteps = Math.min(Math.floor(acc), N);
    acc -= Math.floor(acc);
    const sdt = 1 / RS;
    for (let i = 0; i < nSteps; i++) {
      if (connected && !apnea) freq = lerp(freq, rr / 60, smooth(sdt, 0.8));
      amp = lerp(amp, targetAmp, smooth(sdt, apnea ? 0.3 : 0.6));
      phase = (phase + 2 * Math.PI * freq * sdt) % (2 * Math.PI);
      // Forme légèrement asymétrique (inspiration plus rapide que l'expiration)
      buf[head] = (amp * (Math.sin(phase) + 0.18 * Math.sin(2 * phase + 0.6))) / 1.18;
      head = (head + 1) % N;
    }

    const pps = w / (N - 1);

    // --- Tracé ---
    const mid = h / 2;
    const scale = h / 2 - 10;
    const path = new Path2D();
    for (let i = 0; i < N; i++) {
      const v = buf[(head + i) % N];
      const x = i * pps;
      const y = mid - v * scale;
      if (i === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    }
    ctx.save();
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.globalAlpha = connected ? 1 : 0.3;
    ctx.strokeStyle = th.resp;
    ctx.stroke(path);
    if (dangerMix > 0.01) {
      ctx.globalAlpha = (connected ? 1 : 0.3) * dangerMix;
      ctx.strokeStyle = th.danger;
      ctx.stroke(path);
    }
    ctx.restore();

    // --- Badge « pause N s » (discret, dès 3 s) ---
    if (apnea && pause >= 3) {
      const label = `pause ${Math.floor(pause)} s`;
      const color = pause >= 20 ? th.dangerText : pause >= 15 ? th.warnText : th.muted;
      ctx.save();
      ctx.font = `600 12px ${th.fontBody}`;
      const tw = ctx.measureText(label).width;
      const bw = tw + 16;
      const bh = 22;
      const bx = w - bw - 8;
      const by = 8;
      roundedRect(ctx, bx, by, bw, bh, 11);
      ctx.fillStyle = th.surface;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = color;
      ctx.stroke();
      ctx.fillStyle = color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + bw / 2, by + bh / 2 + 0.5);
      ctx.restore();
    }

    if (!frame) drawCenterText(ctx, w, h, 'En attente du patch…', th);
    else if (!connected) drawCenterText(ctx, w, h, 'Patch déconnecté — pas de signal', th);
    setLabel(!connected ? 'Courbe de respiration en direct : pas de signal du patch'
      : apnea ? `Courbe de respiration en direct : aucun mouvement respiratoire depuis ${Math.floor(pause)} secondes`
        : `Courbe de respiration en direct : ${Math.round(rr)} respirations par minute`);
  }

  const renderer = createRenderer(canvas, draw, true);
  const ctrl = {
    destroy() {
      renderer.destroy();
      registry.delete(canvas);
    },
  };
  registry.set(canvas, ctrl);
  return ctrl;
}

// ===========================================================================
// 5. Historique (FC, RR, score de risque)
// ===========================================================================

const RANGE_MS = { '24h': 24 * 3600e3, '7j': 7 * 24 * 3600e3, '30j': 30 * 24 * 3600e3 };
const RANGE_TEXT = {
  '24h': 'les dernières 24 heures',
  '7j': 'les 7 derniers jours',
  '30j': 'les 30 derniers jours',
};

/** Description des trois types de courbes. `ticks` = graduations imposées. */
const KINDS = {
  hr: { label: 'Fréquence cardiaque', unit: 'bpm' },
  rr: { label: 'Respiration', unit: '/min' },
  risk: { label: 'Score de risque', unit: '/100', ticks: [0, 35, 65, 100] },
};

/** Rang de gravité (sert à choisir le pire niveau d'un paquet de points). */
const LEVEL_RANK = { normal: 0, vigilance: 1, 'pathologie-legere': 2, urgence: 3 };
const LEVEL_LABEL = {
  normal: 'Normal',
  vigilance: 'Vigilance',
  'pathologie-legere': 'À surveiller (écart modéré persistant)',
  urgence: 'Urgence',
};

const fmtTime = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' });
const fmtDayWeek = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric' });
const fmtDayMonth = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit' });
const fmtFull = new Intl.DateTimeFormat('fr-FR', {
  day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
});

/** Couleur associée à un rang de gravité (null = pas de teinte). */
function rankColor(rank, th) {
  if (rank >= 3) return th.danger;
  if (rank >= 1) return th.warn;
  return null;
}

/** Filtre les points valides dans la fenêtre [xmin, xmax]. */
function cleanPoints(series, xmin, xmax) {
  if (!Array.isArray(series)) return [];
  return series.filter((p) => p && Number.isFinite(p.t) && Number.isFinite(p.v)
    && p.t >= xmin && p.t <= xmax);
}

/** Filtre les alertes valides dans la fenêtre. */
function cleanAlerts(alerts, xmin, xmax) {
  if (!Array.isArray(alerts)) return [];
  return alerts.filter((a) => a && Number.isFinite(a.t) && a.t >= xmin && a.t <= xmax);
}

/**
 * Regroupe les points en paquets (≈ 1 par 3 px) pour garder un tracé lisible
 * et rapide, même avec 43 000 mesures sur 30 jours.
 * FC/RR : moyenne du paquet ; risque : maximum (on ne masque pas un pic).
 */
function bucketize(pts, kind, xmin, spanMs, nb) {
  const slots = new Array(nb).fill(null);
  for (const p of pts) {
    const i = clamp(Math.floor(((p.t - xmin) / spanMs) * nb), 0, nb - 1);
    let s = slots[i];
    if (!s) {
      s = slots[i] = { sum: 0, n: 0, max: -Infinity, tSum: 0, rank: 0 };
    }
    s.sum += p.v;
    s.n += 1;
    s.tSum += p.t;
    if (p.v > s.max) s.max = p.v;
    const r = LEVEL_RANK[p.level] || 0;
    if (r > s.rank) s.rank = r;
  }
  const out = [];
  for (const s of slots) {
    if (s) out.push({ t: s.tSum / s.n, v: kind === KINDS.risk ? s.max : s.sum / s.n, rank: s.rank });
  }
  return out;
}

/** Pas « agréable » pour les graduations (1, 2, 5, 10 × 10^n). */
function niceStep(raw) {
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

/** Graduations de l'axe horizontal (heures ou jours selon la plage). */
function buildTicks(range, xmin, xmax) {
  const ticks = [];
  const d = new Date(xmin);
  if (range === '24h') {
    d.setMinutes(0, 0, 0);
    while (d.getTime() < xmin || d.getHours() % 4 !== 0) d.setHours(d.getHours() + 1);
    while (d.getTime() <= xmax) {
      ticks.push({ t: d.getTime(), label: fmtTime.format(d) });
      d.setHours(d.getHours() + 4);
    }
  } else {
    d.setHours(0, 0, 0, 0);
    if (d.getTime() < xmin) d.setDate(d.getDate() + 1);
    const step = range === '7j' ? 1 : 5;
    const fmt = range === '7j' ? fmtDayWeek : fmtDayMonth;
    while (d.getTime() <= xmax) {
      ticks.push({ t: d.getTime(), label: fmt.format(d) });
      d.setDate(d.getDate() + step);
    }
  }
  return ticks;
}

/** Résumé textuel du graphe (aria-label). */
function buildSummary(st) {
  const kind = KINDS[st.opts.kind] || KINDS.hr;
  const range = RANGE_MS[st.range] ? st.range : '24h';
  const xmax = Number.isFinite(st.opts.now) ? st.opts.now : Date.now();
  const xmin = xmax - RANGE_MS[range];
  const pts = cleanPoints(st.series, xmin, xmax);
  const where = RANGE_TEXT[range];
  if (!pts.length) return `${kind.label} sur ${where} : pas encore de données.`;
  let mn = Infinity;
  let mx = -Infinity;
  let sum = 0;
  for (const p of pts) {
    if (p.v < mn) mn = p.v;
    if (p.v > mx) mx = p.v;
    sum += p.v;
  }
  const u = kind.unit;
  let text = `${kind.label} sur ${where} : minimum ${Math.round(mn)} ${u}, `
    + `maximum ${Math.round(mx)} ${u}, moyenne ${Math.round(sum / pts.length)} ${u}.`;
  const alerts = cleanAlerts(st.opts.alerts, xmin, xmax);
  if (alerts.length) {
    const urgent = alerts.filter((a) => a.level === 'urgence').length;
    text += ` ${alerts.length} alerte${alerts.length > 1 ? 's' : ''} dont ${urgent} d'urgence.`;
  } else {
    text += ' Aucune alerte sur la période.';
  }
  return text;
}

/**
 * Rendu d'un graphe d'historique (appelé par le moteur à chaque redraw).
 * Remplit aussi st.markers (positions des alertes) pour la détection de clic.
 */
function renderHistory(ctx, w, h, st) {
  const th = readTheme();
  const kind = KINDS[st.opts.kind] || KINDS.hr;
  const range = RANGE_MS[st.range] ? st.range : '24h';
  const spanMs = RANGE_MS[range];
  const xmax = Number.isFinite(st.opts.now) ? st.opts.now : Date.now();
  const xmin = xmax - spanMs;

  // Marges : axe Y à gauche, axe X en bas, bande des marqueurs d'alertes en haut.
  const ml = 40;
  const mr = 10;
  const mt = 20;
  const mb = 24;
  const pw = w - ml - mr;
  const ph = h - mt - mb;
  st.markers = [];
  if (pw < 40 || ph < 30) return;

  const X = (t) => ml + ((t - xmin) / spanMs) * pw;
  const pts = cleanPoints(st.series, xmin, xmax);
  const nb = clamp(Math.floor(pw / 3), 20, 300);
  const buckets = bucketize(pts, kind, xmin, spanMs, nb);
  const nr = st.opts.normalRange;

  // --- Échelle verticale ---
  let y0;
  let y1;
  let yTicks;
  if (kind.ticks) {
    yTicks = kind.ticks;
    y0 = 0;
    y1 = 100;
  } else {
    let mn = Infinity;
    let mx = -Infinity;
    for (const b of buckets) {
      if (b.v < mn) mn = b.v;
      if (b.v > mx) mx = b.v;
    }
    if (nr) {
      mn = Math.min(mn, nr.min);
      mx = Math.max(mx, nr.max);
    }
    if (!Number.isFinite(mn)) {
      mn = 0;
      mx = 100;
    }
    const step = niceStep((mx - mn || 10) / 4);
    y0 = Math.floor(mn / step) * step;
    y1 = Math.ceil(mx / step) * step;
    if (y1 <= y0) y1 = y0 + step;
    yTicks = [];
    for (let v = y0; v <= y1 + 1e-9; v += step) yTicks.push(v);
  }
  const Y = (v) => mt + ph - ((v - y0) / (y1 - y0)) * ph;

  ctx.font = `11px ${th.fontBody}`;

  // --- Zone de tracé (clippée) : bandes, teintes de niveau, grille ---
  ctx.save();
  ctx.beginPath();
  ctx.rect(ml, mt, pw, ph);
  ctx.clip();

  // Bandes horizontales colorées normal / vigilance / urgence
  const bands = kind.ticks
    ? [[0, 35, th.ok], [35, 65, th.warn], [65, 100, th.danger]]
    : nr ? [[nr.min, nr.max, th.ok]] : [];
  ctx.globalAlpha = 0.12;
  for (const [a, b, color] of bands) {
    const ya = Y(clamp(b, y0, y1));
    const yb = Y(clamp(a, y0, y1));
    ctx.fillStyle = color;
    ctx.fillRect(ml, ya, pw, yb - ya);
  }

  // Teinte verticale des périodes en vigilance / urgence
  const bw = pw / nb;
  ctx.globalAlpha = 0.16;
  for (const b of buckets) {
    const color = rankColor(b.rank, th);
    if (!color) continue;
    ctx.fillStyle = color;
    ctx.fillRect(X(b.t) - bw / 2, mt, bw, ph);
  }

  ctx.globalAlpha = 1;

  // --- Courbe (coupée là où il manque des données) ---
  if (buckets.length) {
    const bucketMs = spanMs / nb;
    const gapMs = Math.max(bucketMs * 2.5, 5 * 60e3);
    ctx.strokeStyle = st.opts.kind === 'risk' ? th.text : th.primaryStrong;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let prev = null;
    for (const b of buckets) {
      const x = X(b.t);
      const y = Y(b.v);
      if (!prev || b.t - prev.t > gapMs) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      prev = b;
    }
    ctx.stroke();
    if (buckets.length <= 40) { // peu de points : on les rend visibles
      ctx.fillStyle = ctx.strokeStyle;
      for (const b of buckets) {
        ctx.beginPath();
        ctx.arc(X(b.t), Y(b.v), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  ctx.restore();

  // --- Axe vertical : petits traits + graduations (le CSS fournit déjà le quadrillé) ---
  ctx.strokeStyle = th.muted;
  ctx.globalAlpha = 0.5;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const v of yTicks) {
    const y = Math.round(Y(v)) + 0.5;
    ctx.moveTo(ml - 4, y);
    ctx.lineTo(ml, y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = th.muted;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const v of yTicks) ctx.fillText(String(Math.round(v)), ml - 6, Y(v));

  // --- Axe horizontal : heures / jours (sans chevauchement) ---
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let lastRight = -Infinity;
  for (const tk of buildTicks(range, xmin, xmax)) {
    const x = X(tk.t);
    const half = ctx.measureText(tk.label).width / 2;
    if (x - half < lastRight + 6 || x + half > w) continue;
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = th.muted;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, mt + ph);
    ctx.lineTo(Math.round(x) + 0.5, mt + ph + 4);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(tk.label, x, mt + ph + 6);
    lastRight = x + half;
  }

  // --- Pas de données ---
  if (!pts.length) drawCenterText(ctx, w, h, 'Pas encore de données', th);

  // --- Marqueurs d'alertes (cliquables) ---
  const alerts = cleanAlerts(st.opts.alerts, xmin, xmax);
  for (const alert of alerts) {
    const x = X(alert.t);
    const y = mt - 9;
    st.markers.push({ x, y, alert });
    const urgent = alert.level === 'urgence';
    ctx.beginPath();
    ctx.arc(x, y, urgent ? 5.5 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = urgent ? th.danger : th.warn;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = th.surface;
    ctx.stroke();
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = urgent ? th.danger : th.warn;
    ctx.beginPath();
    ctx.moveTo(Math.round(x) + 0.5, y + 6);
    ctx.lineTo(Math.round(x) + 0.5, mt + ph);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // --- Infobulle de l'alerte sélectionnée (raison en français) ---
  const sel = st.selected && st.markers.find((m) => m.alert === st.selected);
  if (sel) {
    const a = sel.alert;
    const maxW = Math.min(240, w - 16);
    ctx.font = `12px ${th.fontBody}`;
    const head = `${fmtFull.format(new Date(a.t))} — ${LEVEL_LABEL[a.level] || a.level}`;
    const reasons = Array.isArray(a.reasons) && a.reasons.length ? a.reasons.slice(0, 3) : ['Raison non précisée'];
    const lines = [head];
    for (const r of reasons) lines.push(...wrapText(ctx, `• ${r}`, maxW - 16));
    const lh = 16;
    const boxW = maxW;
    const boxH = lines.length * lh + 12;
    const bx = clamp(sel.x - boxW / 2, 4, w - boxW - 4);
    const by = mt + 6;
    roundedRect(ctx, bx, by, boxW, boxH, 8);
    ctx.fillStyle = th.surface;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = th.muted;
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    lines.forEach((line, i) => {
      ctx.font = `${i === 0 ? '600 ' : ''}12px ${th.fontBody}`;
      ctx.fillStyle = th.text;
      ctx.fillText(line, bx + 8, by + 6 + i * lh);
    });
  }
}

/**
 * Dessine (ou met à jour) un graphe d'historique sur le canvas.
 *
 * Un appel par canvas : #chart-history-hr (kind "hr"), #chart-history-rr
 * (kind "rr") et #chart-history-risk (kind "risk"). Rappeler drawHistory sur
 * le même canvas remplace le graphe précédent ; on peut aussi utiliser
 * `controller.update(...)` pour changer de plage sans recréer d'observateurs.
 * Le graphe se redessine seul au redimensionnement et à l'affichage de l'écran.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {HistoryPoint[]} series  Points {t, v, level?} (une mesure agrégée / minute).
 * @param {"24h"|"7j"|"30j"} range
 * @param {HistoryOptions} [options]
 * @returns {{update:(series:HistoryPoint[], range:string, options?:HistoryOptions) => void,
 *            redraw:() => void, destroy:() => void}}
 */
export function drawHistory(canvas, series, range, options = {}) {
  destroyChart(canvas);

  const st = {
    series: Array.isArray(series) ? series : [],
    range,
    opts: options || {},
    selected: null, // alerte dont l'infobulle est ouverte
    markers: [],
  };

  canvas.setAttribute('role', 'img');
  const renderer = createRenderer(canvas, (ctx, w, h) => renderHistory(ctx, w, h, st), false);

  /** Met à jour le résumé accessible puis redessine. */
  function refresh() {
    canvas.setAttribute('aria-label', buildSummary(st));
    renderer.kick();
  }

  /** Marqueur d'alerte le plus proche du pointeur (rayon 14 px), ou null. */
  function hitTest(evt) {
    const rect = canvas.getBoundingClientRect();
    const x = evt.clientX - rect.left - canvas.clientLeft;
    const y = evt.clientY - rect.top - canvas.clientTop;
    let best = null;
    let bestD = 14;
    for (const m of st.markers) {
      const d = Math.hypot(m.x - x, m.y - y);
      if (d <= bestD) {
        best = m;
        bestD = d;
      }
    }
    return best;
  }

  const onClick = (evt) => {
    const hit = hitTest(evt);
    st.selected = hit && hit.alert !== st.selected ? hit.alert : null;
    if (hit && typeof st.opts.onMarkerSelect === 'function') st.opts.onMarkerSelect(hit.alert);
    renderer.kick();
  };
  const onMove = (evt) => {
    canvas.style.cursor = hitTest(evt) ? 'pointer' : 'default';
  };
  canvas.addEventListener('click', onClick);
  canvas.addEventListener('pointermove', onMove);

  const ctrl = {
    update(newSeries, newRange, newOptions) {
      st.series = Array.isArray(newSeries) ? newSeries : [];
      st.range = newRange;
      if (newOptions) st.opts = newOptions;
      st.selected = null;
      refresh();
    },
    redraw: () => renderer.kick(),
    destroy() {
      canvas.removeEventListener('click', onClick);
      canvas.removeEventListener('pointermove', onMove);
      renderer.destroy();
      registry.delete(canvas);
    },
  };
  registry.set(canvas, ctrl);
  refresh();
  return ctrl;
}