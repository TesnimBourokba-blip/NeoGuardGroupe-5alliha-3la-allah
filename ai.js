/**
 * NeoGuard — js/ai.js
 * ---------------------------------------------------------------------------
 * Assistant IA : fusion FC + respiration + mouvement + orientation, comparée
 * à la baseline personnelle du bébé, pour classer l'état :
 *   normal | vigilance | pathologie-legere | urgence
 *
 * NeoGuard est une AIDE À LA SURVEILLANCE : ce module ne pose jamais de
 * diagnostic. Les formulations restent prudentes ("plus rapide que d'habitude").
 *
 * Principes :
 *  - assess() est une fonction PURE : elle lit `frame`, `profile` et `history`
 *    sans rien modifier. L'appelant enregistre ensuite le résultat avec
 *    recordResult() (qui, lui, modifie `history`).
 *  - Les limites absolues de sécurité (seuils par âge) l'emportent TOUJOURS sur
 *    la baseline : la baseline ne peut que resserrer la plage "normale".
 *  - Les règles dures (pause >= 20 s, bradycardie soutenue > 10 s, ventre > 30 s)
 *    donnent « urgence » quel que soit le score.
 *
 * Boucle type (main.js / demo.js, 1 fois par seconde) :
 *   const result = assess(frame, profile, history);
 *   recordResult(history, frame, result);
 *
 * Champs ajoutés au résultat (en plus du contrat) : `rawLevel` (niveau avant
 * anti-clignotement) et `confidence` ("faible|moyenne|bonne"). Les ignorer est sans risque.
 *
 * Les seuils par âge sont des valeurs de départ À FAIRE VALIDER PAR UN PÉDIATRE.
 */

import { computeAgeMonths } from './state.js';

/* ------------------------------ Configuration ----------------------------- */

/** Seuils de départ par âge (mois) : FC en bpm, respiration en /min. */
export const AGE_TABLE = Object.freeze([
  { from: 0, to: 3, hr: [100, 160], rr: [30, 60] },
  { from: 3, to: 6, hr: [90, 150], rr: [25, 50] },
  { from: 6, to: 12, hr: [80, 140], rr: [25, 50] },
  { from: 12, to: 24, hr: [80, 130], rr: [20, 40] },
]);

/** Paramètres de l'IA (configurables). */
export const AI_CONFIG = Object.freeze({
  K_MAD: 3.5,                    // bornes personnelles = médiane ± K·MAD
  MAD_MIN: { hr: 3, rr: 1.5 },   // plancher de MAD (évite des bornes trop étroites)
  BASELINE_MIN: 60,              // mesures de sommeil calme minimum pour activer
  BASELINE_MAX: 2000,            // mesures conservées au maximum
  BASELINE_GOOD: 300,            // au-delà : confiance "bonne"
  VIGILANCE_SCORE: 35,
  VIGILANCE_SCORE_RISK: 30,      // profil à risque : seuil de vigilance abaissé
  URGENCE_SCORE: 65,             // (jamais abaissé)
  PAUSE_VIGILANCE_S: 15,
  PAUSE_VIGILANCE_RISK_S: 12,    // profil à risque : vigilance plus tôt
  PAUSE_URGENCE_S: 20,
  BRADY_URGENCE_S: 10,           // sous le minimum de l'âge depuis plus de 10 s
  VENTRE_URGENCE_S: 30,
  SMOOTH_WINDOW_MS: 10000,       // fenêtre glissante : on ignore ce qui a plus de 10 s…
  SMOOTH_COUNT: 5,               // … et on prend la médiane des 5 dernières mesures
  SLEEP_WINDOW_MS: 60000,        // fenêtre du calcul calme / agité
  PERSIST_MS: 10 * 60 * 1000,    // durée de "déviation persistante"
  PERSIST_COVERAGE: 0.8,         // couverture minimale de la fenêtre en frames
  PERSIST_RATIO: 0.85,           // part de frames déviantes requise
  HOLD_MS: 30000,                // désescalade seulement après 30 s stables
  DISCONNECT_VIGILANCE_S: 60,    // patch déconnecté > 60 s => vigilance
  AGITATED_EXT: { hr: 20, rr: 10 }, // tolérance en plus quand le bébé est agité
  MAX_GAP_MS: 5000,              // trou entre frames qui interrompt une "durée continue"
  MAX_FRAMES: 700,               // frames gardées (≈ 11,5 min)
  MAX_ASSESSMENTS: 60,
});

const LEVELS = ['normal', 'vigilance', 'pathologie-legere', 'urgence'];
const SEV = { normal: 0, vigilance: 1, 'pathologie-legere': 2, urgence: 3 };
const MIN_SCORE = { normal: 0, vigilance: 35, 'pathologie-legere': 35, urgence: 65 };

/* --------------------------------- Typedefs -------------------------------- */

/**
 * @typedef {Object} Profile
 * @property {string} [firstName]
 * @property {string} [birthdate]      "YYYY-MM-DD"
 * @property {number} [ageMonths]      prioritaire sur birthdate s'il est fourni
 * @property {"fille"|"garcon"} [sex]
 * @property {boolean} [riskPregnancy] grossesse à risques
 * @property {string} [familyHistory]  antécédents familiaux (texte libre)
 * @property {boolean} [premature]     prématurité (sinon détectée dans le texte)
 */

/**
 * @typedef {Object} AiHistory
 * @property {Object[]} frames        dernières frames (chronologiques)
 * @property {Object[]} assessments   derniers résultats (chronologiques)
 * @property {{hr:number, rr:number, t:number}[]} calmSamples mesures de sommeil calme
 * @property {Object|null} baseline   baseline calculée (null = inactive)
 * @property {number|null} disconnectedSince époque du début de déconnexion
 */

/* -------------------------------- Utilitaires ------------------------------ */

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Médiane d'un tableau de nombres (NaN si vide). */
function median(values) {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Écart absolu médian (MAD). */
function mad(values, med) {
  return median(values.map((v) => Math.abs(v - med)));
}

/**
 * Seuils absolus pour un âge en mois (null => tranche 3-6 mois par défaut ;
 * au-delà de 24 mois => dernière tranche).
 * @param {number|null} ageMonths
 * @returns {{from:number,to:number,hr:number[],rr:number[]}}
 */
export function getAgeThresholds(ageMonths) {
  if (!isNum(ageMonths)) return AGE_TABLE[1];
  if (ageMonths >= AGE_TABLE[AGE_TABLE.length - 1].to) return AGE_TABLE[AGE_TABLE.length - 1];
  return AGE_TABLE.find((r) => ageMonths >= r.from && ageMonths < r.to) || AGE_TABLE[0];
}

/** Âge en mois d'un profil à la date `t`. */
function profileAgeMonths(profile, t) {
  if (profile && isNum(profile.ageMonths)) return profile.ageMonths;
  if (profile && profile.birthdate) return computeAgeMonths(profile.birthdate, new Date(t));
  return null;
}

/** Le profil est-il "à risque" (grossesse à risques, antécédents, prématurité) ? */
function isRiskProfile(profile) {
  if (!profile) return false;
  if (profile.riskPregnancy || profile.premature) return true;
  const txt = String(profile.familyHistory || '').trim();
  if (!txt) return false;
  if (/pr[ée]matur/i.test(txt)) return true;
  return !/^(aucun|aucune|rien|non|ras|n\/a|néant|neant)\.?$/i.test(txt);
}

/** Durée (s) pendant laquelle `pred` est vraie sans interruption, jusqu'à la dernière frame. */
function runSeconds(frames, pred) {
  const last = frames[frames.length - 1];
  if (!last) return 0;
  let start = null;
  let prev = last.t;
  for (let i = frames.length - 1; i >= 0; i--) {
    const f = frames[i];
    if (!pred(f) || prev - f.t > AI_CONFIG.MAX_GAP_MS) break;
    start = f.t;
    prev = f.t;
  }
  return start === null ? 0 : (last.t - start) / 1000;
}

/* --------------------------------- Baseline -------------------------------- */

/**
 * Baseline personnelle : médiane + MAD de FC et RR sur les N dernières mesures
 * de sommeil calme (une "mesure" = moyenne d'une minute de sommeil calme).
 * Inactive en dessous de 60 mesures.
 * @param {{hr:number, rr:number}[]} samples
 * @returns {{active:boolean, count:number, hr?:{median:number,mad:number}, rr?:{median:number,mad:number}}}
 */
export function computeBaseline(samples) {
  const list = (samples || []).slice(-AI_CONFIG.BASELINE_MAX).filter((s) => isNum(s.hr) && isNum(s.rr));
  if (list.length < AI_CONFIG.BASELINE_MIN) return { active: false, count: list.length };
  const hrs = list.map((s) => s.hr);
  const rrs = list.map((s) => s.rr);
  const hrMed = median(hrs);
  const rrMed = median(rrs);
  return {
    active: true,
    count: list.length,
    hr: { median: hrMed, mad: Math.max(mad(hrs, hrMed), AI_CONFIG.MAD_MIN.hr) },
    rr: { median: rrMed, mad: Math.max(mad(rrs, rrMed), AI_CONFIG.MAD_MIN.rr) },
  };
}

/** Confiance associée à une baseline. */
function baselineConfidence(baseline) {
  if (!baseline.active) return 'faible';
  return baseline.count >= AI_CONFIG.BASELINE_GOOD ? 'bonne' : 'moyenne';
}

/**
 * Bornes pour FC et RR : limites absolues de l'âge, resserrées par la baseline
 * (jamais élargies), et rehaussées si le bébé est agité.
 */
function buildBands(thr, baseline, agitated) {
  const make = (abs, b, ext) => {
    let lo = abs[0];
    let hi = abs[1];
    if (baseline.active && b) {
      lo = Math.max(abs[0], b.median - AI_CONFIG.K_MAD * b.mad);
      hi = Math.min(abs[1], b.median + AI_CONFIG.K_MAD * b.mad);
      if (lo > hi) lo = hi = clamp(b.median, abs[0], abs[1]);
    }
    if (agitated) hi = Math.min(abs[1], hi + ext);
    return { abs, lo, hi };
  };
  return {
    hr: make(thr.hr, baseline.hr, AI_CONFIG.AGITATED_EXT.hr),
    rr: make(thr.rr, baseline.rr, AI_CONFIG.AGITATED_EXT.rr),
  };
}

/**
 * Infos de baseline pour l'écran IA (#screen-ai).
 * @param {AiHistory} history
 * @param {Profile} profile
 * @param {number} [t] époque (défaut : dernière frame connue)
 */
export function getBaselineInfo(history, profile, t) {
  const hist = history || createHistory();
  const baseline = hist.baseline || computeBaseline(hist.calmSamples);
  const when = isNum(t) ? t : hist.frames.length ? hist.frames[hist.frames.length - 1].t : 0;
  const ageMonths = profileAgeMonths(profile, when);
  const thr = getAgeThresholds(ageMonths);
  const bands = buildBands(thr, baseline, false);
  return {
    active: baseline.active,
    count: baseline.count,
    confidence: baselineConfidence(baseline),
    ageMonths,
    hr: { median: baseline.hr?.median ?? null, low: bands.hr.lo, high: bands.hr.hi, abs: thr.hr },
    rr: { median: baseline.rr?.median ?? null, low: bands.rr.lo, high: bands.rr.hi, abs: thr.rr },
  };
}

/* --------------------------------- Historique ------------------------------ */

/**
 * Crée un historique vide (ou pré-rempli depuis la base : mesures de sommeil
 * calme déjà enregistrées). En mode démo, créer un historique SÉPARÉ et ne
 * jamais le persister.
 * @param {{calmSamples?: {hr:number, rr:number, t?:number}[]}} [opts]
 * @returns {AiHistory}
 */
export function createHistory(opts = {}) {
  const calmSamples = (opts.calmSamples || []).slice(-AI_CONFIG.BASELINE_MAX);
  return {
    frames: [],
    assessments: [],
    calmSamples,
    baseline: calmSamples.length ? computeBaseline(calmSamples) : null,
    disconnectedSince: null,
    _acc: null, // accumulateur de la minute de sommeil calme en cours
  };
}

/** Signale une déconnexion du patch (début). */
export function markDisconnected(history, t) {
  if (history.disconnectedSince === null) history.disconnectedSince = t;
}

/** Signale le retour du patch. */
export function markConnected(history) {
  history.disconnectedSince = null;
}

/**
 * Enregistre une frame et son résultat dans l'historique (modifie `history`).
 * Alimente aussi la baseline : une mesure de sommeil calme est ajoutée chaque
 * minute, uniquement si l'état est resté normal (la baseline n'apprend donc
 * jamais des périodes anormales).
 * @param {AiHistory} history
 * @param {Object} frame
 * @param {Object} result sortie de assess()
 */
export function recordResult(history, frame, result) {
  if (result) {
    history.assessments.push(result);
    if (history.assessments.length > AI_CONFIG.MAX_ASSESSMENTS) {
      history.assessments.splice(0, history.assessments.length - AI_CONFIG.MAX_ASSESSMENTS);
    }
  }
  if (!frame || frame.patchConnected === false) return; // pas de frame réelle
  history.frames.push(frame);
  if (history.frames.length > AI_CONFIG.MAX_FRAMES) {
    history.frames.splice(0, history.frames.length - AI_CONFIG.MAX_FRAMES);
  }

  const calm =
    result && result.sleep === 'calme' && result.level === 'normal' &&
    (result.rawLevel || 'normal') === 'normal' && isNum(frame.hr) && frame.rr >= 1;
  if (!calm) return;

  if (!history._acc) history._acc = { start: frame.t, n: 0, hr: 0, rr: 0 };
  const acc = history._acc;
  acc.n += 1;
  acc.hr += frame.hr;
  acc.rr += frame.rr;
  if (frame.t - acc.start >= 60000) {
    if (acc.n >= 30) {
      history.calmSamples.push({ t: frame.t, hr: acc.hr / acc.n, rr: acc.rr / acc.n });
      if (history.calmSamples.length > AI_CONFIG.BASELINE_MAX) {
        history.calmSamples.splice(0, history.calmSamples.length - AI_CONFIG.BASELINE_MAX);
      }
      history.baseline = computeBaseline(history.calmSamples);
    }
    history._acc = null;
  }
}

/* ------------------------------- Calcul du score --------------------------- */

/**
 * Score d'écart d'une mesure par rapport à ses bornes.
 *  - dans la plage personnelle : 0
 *  - hors plage personnelle mais dans les limites absolues : 15..40
 *  - au-delà des limites absolues : 40..75 selon l'excès relatif
 */
function metricScore(v, band) {
  const none = { score: 0, side: null, beyondAbs: false };
  if (!isNum(v)) return none;
  const { abs, lo, hi } = band;
  if (v > hi) {
    if (v <= abs[1]) {
      const gap = abs[1] - hi;
      const r = gap > 0 ? clamp((v - hi) / gap, 0, 1) : 1;
      return { score: 15 + 25 * r, side: 'high', beyondAbs: false };
    }
    return { score: 40 + Math.min(35, ((v - abs[1]) / abs[1]) * 100), side: 'high', beyondAbs: true };
  }
  if (v < lo) {
    if (v >= abs[0]) {
      const gap = lo - abs[0];
      const r = gap > 0 ? clamp((lo - v) / gap, 0, 1) : 1;
      return { score: 15 + 25 * r, side: 'low', beyondAbs: false };
    }
    return { score: 40 + Math.min(35, ((abs[0] - v) / abs[0]) * 100), side: 'low', beyondAbs: true };
  }
  return none;
}

/** Score de pause respiratoire (pv = seuil de vigilance en secondes). */
function pauseScore(sec, pv) {
  if (sec < 8) return 0;
  if (sec < pv) return 10 + ((sec - 8) / (pv - 8)) * 24; // 10..34
  if (sec < AI_CONFIG.PAUSE_URGENCE_S) {
    return 55 + ((sec - pv) / (AI_CONFIG.PAUSE_URGENCE_S - pv)) * 9; // 55..64
  }
  return 100;
}

/** Sommeil : variance (écart-type) et moyenne du mouvement sur 60 s. */
function sleepState(frames, t) {
  const win = frames.filter((f) => isNum(f.motion) && t - f.t <= AI_CONFIG.SLEEP_WINDOW_MS);
  if (!win.length) return { sleep: 'calme', meanMotion: 0 };
  const vals = win.map((f) => f.motion);
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  if (vals.length < 5) return { sleep: vals[vals.length - 1] >= 30 ? 'agite' : 'calme', meanMotion: mean };
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return { sleep: sd >= 12 || mean >= 25 ? 'agite' : 'calme', meanMotion: mean };
}

/** Déviation persistante (> 10 min) de la FC ou de la respiration. */
function persistentDeviation(frames, t, thr, baseline) {
  const win = frames.filter((f) => t - f.t <= AI_CONFIG.PERSIST_MS);
  const need = (AI_CONFIG.PERSIST_MS / 1000) * AI_CONFIG.PERSIST_COVERAGE;
  if (win.length < need || t - win[0].t < AI_CONFIG.PERSIST_MS * 0.95) return null;

  const stat = { hr: { n: 0, high: 0, low: 0, vals: [] }, rr: { n: 0, high: 0, low: 0, vals: [] } };
  for (const f of win) {
    const bands = buildBands(thr, baseline, f.motion >= 30);
    for (const key of ['hr', 'rr']) {
      if (key === 'rr' && !(f.rr >= 1)) continue; // pause : géré ailleurs
      stat[key].n += 1;
      const r = metricScore(f[key], bands[key]);
      if (r.score >= 15) {
        stat[key][r.side] += 1;
        stat[key].vals.push(f[key]);
      }
    }
  }
  const out = {};
  for (const key of ['hr', 'rr']) {
    const s = stat[key];
    const flagged = s.high + s.low;
    if (s.n > 0 && flagged / s.n >= AI_CONFIG.PERSIST_RATIO) {
      out[key] = { side: s.high >= s.low ? 'high' : 'low', value: Math.round(median(s.vals)) };
    }
  }
  return out.hr || out.rr ? out : null;
}

/* ---------------------------------- assess --------------------------------- */

/**
 * Évalue l'état du bébé à partir de la frame courante et de l'historique.
 * Fonction pure : ne modifie ni `frame`, ni `profile`, ni `history`.
 *
 * @param {Object} frame     frame capteur (contrat de données) ; pour signaler
 *                           une déconnexion : { t, patchConnected: false }
 * @param {Profile} profile
 * @param {AiHistory} history
 * @returns {{level:string, score:number, reasons:string[], sleep:string, t:number,
 *            rawLevel:string, confidence:string}}
 */
export function assess(frame, profile, history) {
  const hist = history || createHistory();
  const t = isNum(frame && frame.t) ? frame.t : 0;
  const name = (profile && String(profile.firstName || '').trim()) || 'votre bébé';
  const baseline = hist.baseline || computeBaseline(hist.calmSamples);
  const confidence = baselineConfidence(baseline);
  const ageMonths = profileAgeMonths(profile, t);
  const thr = getAgeThresholds(ageMonths);
  const risk = isRiskProfile(profile);

  let raw;
  if (!frame || frame.patchConnected === false) {
    raw = assessDisconnected(t, hist, name);
  } else {
    raw = assessConnected(frame, hist, { name, baseline, thr, risk });
  }
  return finalize(raw, t, hist, name, confidence);
}

/** Patch déconnecté : pas de mesures, seulement la durée de déconnexion. */
function assessDisconnected(t, hist, name) {
  const since = isNum(hist.disconnectedSince) ? hist.disconnectedSince : null;
  const sec = since === null ? AI_CONFIG.DISCONNECT_VIGILANCE_S : Math.max(0, (t - since) / 1000);
  if (sec >= AI_CONFIG.DISCONNECT_VIGILANCE_S) {
    return {
      level: 'vigilance',
      score: 45,
      sleep: 'inconnu',
      reasons: [
        `Patch déconnecté : NeoGuard ne peut plus surveiller ${name}.`,
        'Vérifiez que le patch est bien collé et à portée du téléphone.',
      ],
    };
  }
  return {
    level: 'normal',
    score: 15,
    sleep: 'inconnu',
    reasons: [`Patch déconnecté depuis ${Math.round(sec)} s : reconnexion en cours.`],
  };
}

/** Évaluation à partir de mesures réelles. */
function assessConnected(frame, hist, ctx) {
  const { name, baseline, thr, risk } = ctx;
  const t = frame.t;
  const frames = hist.frames.concat([frame]);
  const { sleep, meanMotion } = sleepState(frames, t);
  const agitated = sleep === 'agite';
  const bands = buildBands(thr, baseline, agitated);

  // Mesures lissées : médiane des 5 dernières mesures des 10 dernières secondes.
  const recent = frames.filter((f) => t - f.t <= AI_CONFIG.SMOOTH_WINDOW_MS).slice(-AI_CONFIG.SMOOTH_COUNT);
  const hrS = median(recent.map((f) => f.hr).filter(isNum));
  const rrS = median(recent.filter((f) => f.rr >= 1).map((f) => f.rr));

  /** @type {{score:number, reasons:string[]}[]} */
  const comps = [];
  let hard = false;
  const fmt = (n) => Math.round(n);

  // --- Fréquence cardiaque ---
  const hrRes = metricScore(hrS, bands.hr);
  if (hrRes.score > 0) {
    const dir = hrRes.side === 'high' ? 'plus rapide' : 'plus lent';
    const range = hrRes.beyondAbs
      ? `plage attendue à son âge : ${bands.hr.abs[0]}-${bands.hr.abs[1]}`
      : `habituel pour ${name} : ${fmt(bands.hr.lo)}-${fmt(bands.hr.hi)}`;
    comps.push({
      score: hrRes.score,
      reasons: [`Rythme cardiaque ${dir} que d'habitude pour ${name} : ${fmt(hrS)} bpm (${range}).`],
    });
  }

  // --- Bradycardie soutenue (règle dure) ---
  const bradySec = runSeconds(frames, (f) => isNum(f.hr) && f.hr < thr.hr[0]);
  if (bradySec > AI_CONFIG.BRADY_URGENCE_S) {
    hard = true;
    comps.push({
      score: 90,
      reasons: [`Rythme cardiaque sous le minimum attendu à son âge (${thr.hr[0]} bpm) depuis ${fmt(bradySec)} s : ${fmt(frame.hr)} bpm.`],
    });
  }

  // --- Respiration ---
  const rrRes = metricScore(rrS, bands.rr);
  if (rrRes.score > 0) {
    const dir = rrRes.side === 'high' ? 'plus rapide' : 'plus lente';
    const range = rrRes.beyondAbs
      ? `plage attendue à son âge : ${bands.rr.abs[0]}-${bands.rr.abs[1]}/min`
      : `habituel pour ${name} : ${fmt(bands.rr.lo)}-${fmt(bands.rr.hi)}/min`;
    comps.push({
      score: rrRes.score,
      reasons: [`Respiration ${dir} que d'habitude pour ${name} : ${fmt(rrS)}/min (${range}).`],
    });
  }

  // --- Pause respiratoire (rr à 0) ---
  const pauseSec = runSeconds(frames, (f) => f.rr < 1);
  const pv = risk ? AI_CONFIG.PAUSE_VIGILANCE_RISK_S : AI_CONFIG.PAUSE_VIGILANCE_S;
  let pScore = pauseScore(pauseSec, pv);
  if (pauseSec >= 8 && frame.motion < 3) pScore = Math.min(100, pScore + 5); // aucun mouvement du tout
  if (pauseSec >= AI_CONFIG.PAUSE_URGENCE_S) hard = true;
  if (pScore > 0) {
    comps.push({ score: pScore, reasons: [`Aucun mouvement respiratoire depuis ${fmt(pauseSec)} s.`] });
  }

  // --- Orientation : ventre ---
  const ventreSec = runSeconds(frames, (f) => f.orientation === 'ventre');
  if (frame.orientation === 'ventre') {
    if (!agitated) {
      if (ventreSec > AI_CONFIG.VENTRE_URGENCE_S) {
        hard = true;
        comps.push({ score: 85, reasons: [`${name} est sur le ventre pendant son sommeil depuis ${fmt(ventreSec)} s.`] });
      } else {
        comps.push({
          score: 40 + Math.min(24, ventreSec * 0.8),
          reasons: [`${name} est sur le ventre pendant son sommeil${ventreSec >= 1 ? ` depuis ${fmt(ventreSec)} s` : ''}.`],
        });
      }
    } else {
      comps.push({ score: 10, reasons: [`${name} est sur le ventre : restez à proximité.`] });
    }
  }

  // --- Mouvement : agitation intense prolongée ---
  if (meanMotion >= 70) comps.push({ score: 12, reasons: [`${name} est très agité(e) depuis un moment (sommeil agité).`] });
  else if (meanMotion >= 50) comps.push({ score: 6, reasons: [] });

  // --- Score global : composante dominante + part des autres ---
  const scores = comps.map((c) => c.score).sort((a, b) => b - a);
  const top = scores[0] || 0;
  const rest = scores.slice(1).reduce((a, b) => a + b, 0);
  let score = Math.round(Math.min(100, top + 0.35 * rest));

  // --- Niveau instantané ---
  const vigThreshold = risk ? AI_CONFIG.VIGILANCE_SCORE_RISK : AI_CONFIG.VIGILANCE_SCORE;
  let level = 'normal';
  if (hard || score >= AI_CONFIG.URGENCE_SCORE) level = 'urgence';
  else if (score >= vigThreshold) level = 'vigilance';
  if (hard) score = Math.max(score, AI_CONFIG.URGENCE_SCORE);

  const reasons = comps.sort((a, b) => b.score - a.score).flatMap((c) => c.reasons);

  // --- Déviation modérée mais persistante (> 10 min) ---
  if (level === 'normal' || level === 'vigilance') {
    const persist = persistentDeviation(frames, t, thr, baseline);
    if (persist) {
      level = 'pathologie-legere';
      score = Math.max(score, 45);
      if (persist.rr) {
        const dir = persist.rr.side === 'high' ? 'plus rapide' : 'plus lente';
        reasons.unshift(`La respiration de ${name} reste ${dir} que d'habitude depuis plus de 10 minutes (environ ${persist.rr.value}/min).`);
      }
      if (persist.hr) {
        const dir = persist.hr.side === 'high' ? 'plus rapide' : 'plus lent';
        reasons.unshift(`Le rythme cardiaque de ${name} reste ${dir} que d'habitude depuis plus de 10 minutes (environ ${persist.hr.value} bpm).`);
      }
    }
  }

  // --- Phrases d'accompagnement (prudentes, jamais de diagnostic) ---
  if (level === 'normal') {
    reasons.push(baseline.active
      ? `Tout est dans la norme habituelle de ${name}.`
      : `Tout est dans la plage attendue pour l'âge de ${name}.`);
  } else {
    if ((level === 'vigilance' || level === 'pathologie-legere') && risk) {
      reasons.push('Profil à risque (grossesse à risques, antécédents ou prématurité) : seuils de vigilance légèrement abaissés.');
    }
    if (level === 'vigilance') reasons.push(`Jetez un œil à ${name} dès que possible.`);
    if (level === 'pathologie-legere') reasons.push('Cette situation dure : parlez-en à un professionnel de santé.');
    if (level === 'urgence') reasons.push(`Vérifiez ${name} immédiatement ; appelez les secours si nécessaire.`);
  }

  return { level, score, sleep, reasons };
}

/**
 * Anti-clignotement : l'escalade est immédiate ; la désescalade n'a lieu qu'après
 * 30 s pendant lesquelles aucun niveau supérieur n'a été mesuré.
 */
function finalize(raw, t, hist, name, confidence) {
  const rawSev = SEV[raw.level];
  let heldSev = rawSev;
  let src = null;
  for (const a of hist.assessments || []) {
    if (!a || !(a.t < t) || t - a.t > AI_CONFIG.HOLD_MS) continue;
    const s = SEV[a.rawLevel || a.level] ?? 0;
    if (s > heldSev) { heldSev = s; src = a; }
    else if (s === heldSev && src && a.t > src.t) src = a;
  }

  if (heldSev > rawSev && src) {
    const level = LEVELS[heldSev];
    const remaining = Math.max(1, Math.ceil((AI_CONFIG.HOLD_MS - (t - src.t)) / 1000));
    const kept = (src.reasons || []).filter((r) => !r.startsWith('Situation redevenue'));
    return {
      level,
      score: Math.max(raw.score, MIN_SCORE[level]),
      reasons: [
        ...kept,
        `Situation redevenue plus calme : l'état de ${name} reste surveillé encore ${remaining} s par prudence.`,
      ],
      sleep: raw.sleep,
      t,
      rawLevel: raw.level,
      confidence,
    };
  }
  return { level: raw.level, score: raw.score, reasons: raw.reasons, sleep: raw.sleep, t, rawLevel: raw.level, confidence };
}

/* ------------------------------ Cas de test --------------------------------
 * Profil de test : { firstName:'Léa', birthdate:'2026-06-10', sex:'fille' }
 * évalué le 2026-10-10 (4 mois => FC 90-150, RR 25-50). Frames à 1 Hz,
 * motion 5, orientation "dos" sauf mention. Boucle : assess() puis recordResult().
 *
 *  1) Normal : hr 118, rr 38 pendant 120 s
 *       -> level "normal", score < 35, raison "Tout est dans la plage attendue…".
 *  2) FC haute : après (1), hr 175 pendant 15 s
 *       -> "vigilance" (score ≈ 57), raison "Rythme cardiaque plus rapide… 175 bpm".
 *  3) RR haute : après (1), rr 60 pendant 15 s
 *       -> "vigilance" (score ≈ 60), raison "Respiration plus rapide que d'habitude
 *          pour Léa : 60/min".
 *  4) Pause respiratoire : après (1), rr 0 et motion 1
 *       -> à 17 s : "vigilance", "Aucun mouvement respiratoire depuis 17 s" ;
 *          à 20 s et plus : "urgence" (règle dure).
 *  5) Bradycardie soutenue : après (1), hr 70 pendant 12 s
 *       -> "vigilance" à 8 s (score ≈ 62) ; "urgence" dès que la durée sous
 *          90 bpm dépasse 10 s (règle dure).
 *  6) Ventre pendant le sommeil : orientation "ventre", motion 5
 *       -> "vigilance" dès le début ; "urgence" au-delà de 30 s.
 *  7) Profil à risque (riskPregnancy: true) : pause de 13 s
 *       -> "vigilance" avec raison "Profil à risque… seuils abaissés" ;
 *          le même cas sans profil à risque reste "normal".
 *  8) Anti-clignotement : urgence (pause 21 s) puis retour à des valeurs normales
 *       -> le niveau reste "urgence" 30 s ("Situation redevenue plus calme…"),
 *          puis redevient "normal" ; une seule frame aberrante ne change rien
 *          (médiane des 5 dernières mesures).
 *  Bonus : (a) rr 55 pendant 11 min -> "pathologie-legere" (tachypnée soutenue) ;
 *          (b) { t, patchConnected:false } avec disconnectedSince ancien de 70 s
 *              -> "vigilance", sleep "inconnu".
 * ------------------------------------------------------------------------- */