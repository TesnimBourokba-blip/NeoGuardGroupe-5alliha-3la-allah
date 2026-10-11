/**
 * NeoGuard — js/db.js
 * ---------------------------------------------------------------------------
 * Accès local IndexedDB, sans dépendance ni serveur. Les données du profil,
 * de santé et les préférences restent sur cet appareil et ne sont jamais
 * envoyées sur le réseau. Si IndexedDB est indisponible, repli en mémoire.
 *
 * Magasins v1 : profile, samples, alerts, baseline, settings.
 * Migration : incrémenter DB_VERSION et ajouter les transformations dans
 * onupgradeneeded (par exemple création/normalisation d'index pour v2) ; ne
 * jamais supprimer un magasin existant sans migration explicite.
 */

import { getState, isWriteBlocked } from './state.js';

const DB_NAME = 'neoguard-db';
const DB_VERSION = 1;
const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_BASELINE_SAMPLES = 2000;
const STORES = ['profile', 'samples', 'alerts', 'baseline', 'settings'];

/** Erreur explicite émise avant toute écriture pendant le mode démo. */
export class DemoWriteBlockedError extends Error {
  constructor() {
    super('Écriture interdite : le mode démo NeoGuard est actif.');
    this.name = 'DemoWriteBlockedError';
  }
}

let database = null;
let opened = null;
let memoryMode = false;
let warningShown = false;
let baselineSamples = [];

const memory = {
  profile: null,
  samples: [],
  alerts: [],
  baseline: null,
  settings: null,
  nextSampleId: 1,
  nextAlertId: 1,
};

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** Garde unique : appelée avant toute écriture, y compris en mémoire. */
function assertWritable() {
  if (isWriteBlocked() || getState().mode === 'demo') throw new DemoWriteBlockedError();
}

function clone(value) {
  if (value == null || typeof value !== 'object') return value;
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function showFallbackWarning() {
  if (warningShown || typeof document === 'undefined') return;
  warningShown = true;
  const message = 'Stockage local indisponible : les données NeoGuard ne seront conservées que pendant cette session.';
  let node = document.getElementById('app-message');
  if (!node) {
    node = document.createElement('p');
    node.id = 'app-message';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    document.getElementById('app-main')?.prepend(node);
  }
  node.dataset.kind = 'warning';
  node.textContent = message;
  console.warn(`[NeoGuard/db] ${message}`);
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Échec IndexedDB.'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('Transaction IndexedDB interrompue.'));
  });
}

function storeNamesFor(...names) {
  return names.filter((name) => database?.objectStoreNames.contains(name));
}

/** Lit tous les objets d'un magasin, avec fallback compatible navigateurs. */
async function readAllFrom(storeName) {
  const tx = database.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const rows = typeof store.getAll === 'function'
    ? await requestResult(store.getAll())
    : await new Promise((resolve, reject) => {
      const out = [];
      const req = store.openCursor();
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return resolve(out);
        out.push(cursor.value);
        cursor.continue();
      };
    });
  await transactionDone(tx);
  return rows;
}

/** Ouvre IndexedDB. En cas d'échec, l'API continue en mémoire sans planter. */
export function open() {
  if (opened) return opened;
  opened = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      memoryMode = true;
      showFallbackWarning();
      resolve({ mode: 'memory', name: DB_NAME });
      return;
    }

    let request;
    try { request = indexedDB.open(DB_NAME, DB_VERSION); }
    catch (error) {
      memoryMode = true;
      showFallbackWarning();
      console.warn('[NeoGuard/db] Ouverture IndexedDB refusée :', error);
      resolve({ mode: 'memory', name: DB_NAME });
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = request.result;
      // Schéma v1. Pour la v2, ajouter ici un bloc conditionnel basé sur
      // event.oldVersion/event.newVersion et effectuer une migration additive.
      if (!db.objectStoreNames.contains('profile')) db.createObjectStore('profile');
      if (!db.objectStoreNames.contains('samples')) {
        const samples = db.createObjectStore('samples', { keyPath: 'id', autoIncrement: true });
        samples.createIndex('t', 't', { unique: false });
      } else if (!db.transaction.objectStore('samples').indexNames.contains('t')) {
        db.transaction.objectStore('samples').createIndex('t', 't', { unique: false });
      }
      if (!db.objectStoreNames.contains('alerts')) {
        const alerts = db.createObjectStore('alerts', { keyPath: 'key', autoIncrement: true });
        alerts.createIndex('t', 't', { unique: false });
      } else if (!db.transaction.objectStore('alerts').indexNames.contains('t')) {
        db.transaction.objectStore('alerts').createIndex('t', 't', { unique: false });
      }
      if (!db.objectStoreNames.contains('baseline')) db.createObjectStore('baseline');
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings');
      // event est conservé pour rendre explicite le point de départ des migrations.
      void event;
    };

    request.onsuccess = () => {
      database = request.result;
      database.onversionchange = () => {
        database.close();
        database = null;
        opened = null;
      };
      memoryMode = false;
      void pruneOldSamples().catch((error) => console.warn('[NeoGuard/db] Rétention différée :', error));
      resolve({ mode: 'indexeddb', name: DB_NAME, version: DB_VERSION });
    };
    request.onerror = () => {
      memoryMode = true;
      showFallbackWarning();
      console.warn('[NeoGuard/db] IndexedDB indisponible, repli mémoire :', request.error);
      resolve({ mode: 'memory', name: DB_NAME });
    };
    request.onblocked = () => {
      memoryMode = true;
      showFallbackWarning();
      resolve({ mode: 'memory', name: DB_NAME });
    };
  });
  return opened;
}

async function ensureOpen() {
  if (!opened) await open();
  if (!memoryMode && !database) await open();
}

async function readOne(storeName, key) {
  await ensureOpen();
  if (memoryMode) return clone(memory[storeName]);
  const tx = database.transaction(storeName, 'readonly');
  const result = await requestResult(tx.objectStore(storeName).get(key));
  await transactionDone(tx);
  return result === undefined ? null : result;
}

async function putOne(storeName, value, key) {
  assertWritable();
  await ensureOpen();
  if (memoryMode) {
    memory[storeName] = clone(value);
    return clone(value);
  }
  const tx = database.transaction(storeName, 'readwrite');
  const done = transactionDone(tx);
  tx.objectStore(storeName).put(clone(value), key);
  await done;
  return clone(value);
}

/** Profil principal. */
export async function getProfile() {
  const row = await readOne('profile', 'main');
  return row ? clone(row) : null;
}

/** Enregistre uniquement le profil principal. */
export async function saveProfile(profile) {
  assertWritable();
  if (!profile || typeof profile !== 'object') throw new TypeError('Profil invalide.');
  const clean = {
    firstName: String(profile.firstName || '').trim(),
    birthdate: String(profile.birthdate || ''),
    sex: profile.sex || '',
    pregnancyAtRisk: Boolean(profile.pregnancyAtRisk ?? profile.riskPregnancy),
    riskPregnancy: Boolean(profile.riskPregnancy ?? profile.pregnancyAtRisk),
    familyHistory: String(profile.familyHistory || ''),
    createdAt: Number(profile.createdAt) || Date.now(),
    patchAppliedAt: Number(profile.patchAppliedAt) || Date.now(),
  };
  await putOne('profile', clean, 'main');
  return clone(clean);
}

/** Préférences principales. */
export async function getSettings() {
  const row = await readOne('settings', 'main');
  return row ? clone(row) : null;
}

/** Enregistre les préférences sur l'appareil. */
export async function saveSettings(settings) {
  assertWritable();
  if (!settings || typeof settings !== 'object') throw new TypeError('Réglages invalides.');
  const clean = {
    sound: settings.sound !== false,
    vibration: settings.vibration !== false,
    notifications: Boolean(settings.notifications),
    emergencyNumber: String(settings.emergencyNumber || '190').replace(/[^\d+*#]/g, '') || '190',
    theme: settings.theme === 'night' ? 'night' : 'day',
  };
  await putOne('settings', clean, 'main');
  return clone(clean);
}

/** Insère une mesure agrégée par minute ; les données demo sont refusées. */
export async function addSample(sample) {
  assertWritable();
  if (!sample || !isFiniteNumber(Number(sample.t))) throw new TypeError('Mesure invalide : t requis.');
  const clean = {
    t: Number(sample.t), hr: Number(sample.hr) || 0, rr: Number(sample.rr) || 0,
    motion: Number(sample.motion) || 0, orientation: String(sample.orientation || 'dos'),
    score: Number(sample.score) || 0, level: String(sample.level || 'normal'),
  };
  await ensureOpen();
  if (memoryMode) {
    memory.samples.push({ id: memory.nextSampleId++, ...clean });
    await pruneOldSamples();
    return clone(memory.samples[memory.samples.length - 1]);
  }
  const tx = database.transaction('samples', 'readwrite');
  const done = transactionDone(tx);
  const id = await requestResult(tx.objectStore('samples').add(clean));
  await done;
  await pruneOldSamples();
  return { id, ...clean };
}

function normalizeAction(action) {
  if (action === 'ok-intervenu' || action === 'parent-intervenu' || action === 'parent-intervened') return 'ok-intervenu';
  if (action === 'samu' || action === 'appel-samu') return 'samu';
  return 'aucune';
}

/** Enregistre une alerte réelle uniquement. Toute alerte demo est rejetée. */
export async function addAlert(alert) {
  assertWritable();
  if (!alert || typeof alert !== 'object') throw new TypeError('Alerte invalide.');
  if (alert.source === 'demo') throw new TypeError('Une alerte demo ne peut pas être enregistrée.');
  const clean = {
    id: String(alert.id || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`),
    t: Number(alert.t) || Date.now(),
    level: String(alert.level || 'normal'),
    reasons: Array.isArray(alert.reasons) ? alert.reasons.map(String) : [],
    action: normalizeAction(alert.action),
    source: 'live',
  };
  await ensureOpen();
  if (memoryMode) {
    const row = { key: memory.nextAlertId++, ...clean };
    memory.alerts.push(row);
    return clone(row);
  }
  const tx = database.transaction('alerts', 'readwrite');
  const done = transactionDone(tx);
  const key = await requestResult(tx.objectStore('alerts').add(clean));
  await done;
  return { key, ...clean };
}

async function readRange(storeName, rangeMs) {
  await ensureOpen();
  const cutoff = Date.now() - Math.max(0, Number(rangeMs) || 0);
  if (memoryMode) return clone(memory[storeName].filter((row) => Number(row.t) >= cutoff).sort((a, b) => a.t - b.t));
  const tx = database.transaction(storeName, 'readonly');
  const store = tx.objectStore(storeName);
  const source = store.indexNames.contains('t') ? store.index('t') : store;
  const range = IDBKeyRange.lowerBound(cutoff);
  const values = await new Promise((resolve, reject) => {
    const out = [];
    const request = source.openCursor(range);
    request.onerror = () => reject(request.error || new Error('Lecture IndexedDB impossible.'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(out);
      out.push(cursor.value);
      cursor.continue();
    };
  });
  await transactionDone(tx);
  return values.sort((a, b) => a.t - b.t);
}

/** Mesures depuis rangeMs (les plus anciennes d'abord). */
export async function getSamples(rangeMs = RETENTION_MS) {
  return readRange('samples', rangeMs);
}

/** Alertes depuis rangeMs, en filtrant toute source non live. */
export async function getAlerts(rangeMs = RETENTION_MS) {
  return (await readRange('alerts', rangeMs)).filter((alert) => alert.source === 'live');
}

/** Baseline pré-calculée. */
export async function getBaseline() {
  const baseline = await readOne('baseline', 'main');
  return baseline ? clone(baseline) : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function calculateBaseline(rows) {
  const valid = rows.filter((row) => isFiniteNumber(row.hr) && isFiniteNumber(row.rr)).slice(-MAX_BASELINE_SAMPLES);
  const hrMedian = median(valid.map((row) => row.hr));
  const rrMedian = median(valid.map((row) => row.rr));
  const hrMad = hrMedian == null ? null : median(valid.map((row) => Math.abs(row.hr - hrMedian)));
  const rrMad = rrMedian == null ? null : median(valid.map((row) => Math.abs(row.rr - rrMedian)));
  return { hrMedian, hrMad, rrMedian, rrMad, n: valid.length, updatedAt: Date.now() };
}

/** Met à jour la baseline avec une mesure uniquement si sommeil calme et normal. */
export async function updateBaseline(frame, isCalmSleep) {
  assertWritable();
  if (!isCalmSleep || !frame || !isFiniteNumber(Number(frame.hr)) || !isFiniteNumber(Number(frame.rr))) return await getBaseline();
  const previous = await getBaseline();
  if (!baselineSamples.length && previous?.n) {
    // Approximation en mémoire à partir de la baseline persistée ; aucune
    // série brute sensible n'est conservée ou stockée dans un autre magasin.
    baselineSamples = Array.from({ length: Math.min(previous.n, MAX_BASELINE_SAMPLES) }, () => ({ hr: previous.hrMedian, rr: previous.rrMedian }));
  }
  baselineSamples.push({ hr: Number(frame.hr), rr: Number(frame.rr) });
  if (baselineSamples.length > MAX_BASELINE_SAMPLES) baselineSamples.splice(0, baselineSamples.length - MAX_BASELINE_SAMPLES);
  const baseline = calculateBaseline(baselineSamples);
  await putOne('baseline', baseline, 'main');
  return baseline;
}

/** Met à jour la date de pose du patch dans le profil. */
export async function markPatchChanged(t = Date.now()) {
  assertWritable();
  const profile = await getProfile();
  if (!profile) return null;
  profile.patchAppliedAt = Number(t) || Date.now();
  await putOne('profile', profile, 'main');
  return profile.patchAppliedAt;
}

/** Supprime les mesures plus anciennes que 90 jours. */
async function pruneOldSamples(now = Date.now()) {
  assertWritable();
  const cutoff = now - RETENTION_MS;
  if (memoryMode) {
    memory.samples = memory.samples.filter((sample) => Number(sample.t) >= cutoff);
    return;
  }
  if (!database || !database.objectStoreNames.contains('samples')) return;
  const tx = database.transaction('samples', 'readwrite');
  const done = transactionDone(tx);
  const store = tx.objectStore('samples');
  const index = store.index('t');
  await new Promise((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.upperBound(cutoff, true));
    request.onerror = () => reject(request.error || new Error('Nettoyage des mesures impossible.'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve();
      cursor.delete();
      cursor.continue();
    };
  });
  await done;
}

/** Export local filtré : aucune alerte demo ne peut sortir. */
export async function exportAll() {
  const anomalies = await assertNoDemoData();
  if (anomalies.length) {
    throw new Error(`Export refusé : ${anomalies.length} anomalie(s) demo détectée(s) dans la base.`);
  }
  const [profile, settings, baseline, rows, alertRows] = await Promise.all([
    getProfile(), getSettings(), getBaseline(), getSamples(RETENTION_MS), getAlerts(RETENTION_MS),
  ]);
  const cleanAlerts = alertRows.filter((alert) => alert.source === 'live');
  if (cleanAlerts.some((alert) => alert.source === 'demo')) throw new Error('Export bloqué : anomalie source demo détectée.');
  return {
    exportedAt: Date.now(),
    profile,
    settings,
    baseline,
    samples: rows.filter((row) => row.source !== 'demo'),
    alerts: cleanAlerts,
  };
}

/** Parcourt tous les magasins et retourne les anomalies demo (tableau vide attendu). */
export async function assertNoDemoData() {
  await ensureOpen();
  const anomalies = [];
  if (memoryMode) {
    memory.samples.forEach((row) => { if (row.source === 'demo') anomalies.push({ store: 'samples', row: clone(row) }); });
    memory.alerts.forEach((row) => { if (row.source === 'demo') anomalies.push({ store: 'alerts', row: clone(row) }); });
    return anomalies;
  }
  for (const storeName of storeNamesFor(...STORES)) {
    const rows = await readAllFrom(storeName);
    rows.forEach((row) => {
      if (row?.source === 'demo') anomalies.push({ store: storeName, row: clone(row) });
    });
  }
  return anomalies;
}

/** Efface les données locales ; la double confirmation appartient à l'UI. */
export async function clearAll() {
  assertWritable();
  await ensureOpen();
  if (memoryMode) {
    memory.profile = null;
    memory.samples = [];
    memory.alerts = [];
    memory.baseline = null;
    memory.settings = null;
    memory.nextSampleId = 1;
    memory.nextAlertId = 1;
  } else {
    const names = storeNamesFor(...STORES);
    const tx = database.transaction(names, 'readwrite');
    const done = transactionDone(tx);
    names.forEach((name) => tx.objectStore(name).clear());
    await done;
  }
  baselineSamples = [];
  return true;
}

/** Indique si l'API a basculé en stockage mémoire (utile au diagnostic). */
export function isMemoryFallback() {
  return memoryMode;
}

/**
 * Six vérifications console sur des données temporaires : elles ne détruisent
 * ni ne modifient les données du profil courant.
 * @returns {Promise<Array<{name:string,ok:boolean,detail:string}>>}
 */
export async function runDbTests() {
  const tests = [];
  const check = (name, fn) => {
    try { const detail = fn(); tests.push({ name, ok: true, detail: detail || 'OK' }); }
    catch (error) { tests.push({ name, ok: false, detail: error.message }); }
  };
  const isolated = { profile: null, samples: [], alerts: [], baseline: null, settings: null };

  check('Écriture live OK', () => {
    const row = { t: Date.now(), hr: 120, rr: 34, source: 'live' };
    isolated.samples.push(row);
    if (isolated.samples[0] !== row) throw new Error('Écriture live non appliquée.');
    return 'Une mesure live temporaire est acceptée.';
  });
  check('Écriture démo bloquée', () => {
    try { assertWritableForMode('demo'); }
    catch (error) {
      if (error instanceof DemoWriteBlockedError) return 'DemoWriteBlockedError levée avant toute écriture.';
      throw error;
    }
    throw new Error('Une écriture demo a été autorisée.');
  });
  check('Export sans données demo', () => {
    isolated.alerts.push({ source: 'live' }, { source: 'demo' });
    const exported = isolated.alerts.filter((row) => row.source === 'live');
    if (exported.some((row) => row.source === 'demo')) throw new Error('Donnée demo dans export.');
    return 'Le filtre exclut toutes les alertes demo.';
  });
  check('Repli mémoire', () => {
    const fallback = { active: true, rows: [] };
    fallback.rows.push({ hr: 121 });
    if (!fallback.active || fallback.rows.length !== 1) throw new Error('Le stockage mémoire temporaire échoue.');
    return `Fallback mémoire disponible (IndexedDB actif : ${!memoryMode}).`;
  });
  check('Rétention 90 jours', () => {
    const cutoff = Date.now() - RETENTION_MS;
    const filtered = [{ t: cutoff - 1 }, { t: cutoff + 1 }].filter((row) => row.t >= cutoff);
    if (filtered.length !== 1) throw new Error('La règle de rétention ne supprime pas les anciennes mesures.');
    return 'Les mesures antérieures à 90 jours sont exclues.';
  });
  check('Calcul baseline', () => {
    const baseline = calculateBaseline([{ hr: 100, rr: 30 }, { hr: 120, rr: 34 }, { hr: 140, rr: 38 }]);
    if (baseline.hrMedian !== 120 || baseline.rrMedian !== 34 || baseline.n !== 3) throw new Error('Médianes baseline incorrectes.');
    return 'Médiane FC 120, RR 34, MAD calculée.';
  });

  console.table(tests);
  console.log(`NeoGuard db.js — ${tests.filter((test) => test.ok).length}/${tests.length} tests OK`);
  return tests;
}

/** Variante pure du garde utilisée par les tests sans modifier le mode courant. */
function assertWritableForMode(mode) {
  if (mode === 'demo') throw new DemoWriteBlockedError();
}

// Accès console facultatif pour les six tests, sans polluer l'espace global par défaut.
if (typeof window !== 'undefined') window.runNeoGuardDbTests = runDbTests;
