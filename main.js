/**
 * NeoGuard — js/main.js
 * ---------------------------------------------------------------------------
 * Démarrage, navigation et orchestration du flux capteur → IA → alertes/UI.
 * Fonctionne sans backend : si db.js/IndexedDB est indisponible, les données
 * restent en mémoire et un message l'indique. Ce module n'envoie rien réseau.
 */

import { getState, setState, subscribe, computeAgeMonths } from './state.js';
import { SimulatedSensor } from './sensors.js';
import {
  assess, createHistory, recordResult, markConnected, markDisconnected,
  getBaselineInfo, getAgeThresholds,
} from './ai.js';
import { initAlerts, handleAssessment, checkPatchReminder, subscribeAlerts, requestNotificationPermission, stopAllAlerts } from './alerts.js';
import { drawLiveECG, drawLiveResp, drawHistory } from './charts.js';
import { enterDemo } from './demo.js';

const $ = (id) => document.getElementById(id);
const DAY = 24 * 60 * 60 * 1000;
const NAV_SCREENS = ['dashboard', 'history', 'ai', 'alerts', 'settings', 'demo'];

let db = null;
let sensor = null;
let history = createHistory();
let lastFrame = null;
let currentRange = '24h';
let currentAlertFilter = 'tous';
let alerts = [];
let samples = [];
let minuteAccumulator = null;
let liveChartsInitialized = false;
let disconnectedTimer = null;
let liveUnsubscribe = null;
let alertUnsubscribe = null;
let booted = false;
let reloadedForWorkerUpdate = false;

const memoryStore = { profile: null, settings: null, samples: [], alerts: [], baseline: null };

function showMessage(message, kind = 'info') {
  let node = $('app-message');
  if (!node) {
    node = document.createElement('p');
    node.id = 'app-message';
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    const main = $('app-main');
    if (main) main.prepend(node);
  }
  node.dataset.kind = kind;
  node.textContent = message;
}

async function openDatabase() {
  try {
    // db.js est ajouté après ce fichier dans l'ordre du prompt : import facultatif.
    const module = await import('./db.js');
    db = module;
    await db.open();
    return true;
  } catch (error) {
    db = null;
    showMessage('Stockage local indisponible : les données ne seront conservées que pendant cette session.', 'warning');
    console.warn('[NeoGuard/main] Base locale indisponible, fonctionnement en mémoire :', error);
    return false;
  }
}

async function dbCall(method, ...args) {
  if (db && typeof db[method] === 'function') {
    try { return await db[method](...args); }
    catch (error) {
      console.warn(`[NeoGuard/main] ${method} a échoué :`, error);
      showMessage('La base locale a rencontré une erreur. NeoGuard continue en mémoire.', 'warning');
    }
  }
  return undefined;
}

function setVisibleScreen(name, updateHash = true) {
  const target = NAV_SCREENS.includes(name) ? name : 'dashboard';
  const screenId = `screen-${target}`;
  const screen = $(screenId);
  if (!screen) return;

  document.querySelectorAll('main > section[id^="screen-"]').forEach((section) => {
    section.hidden = section.id !== screenId;
    section.classList.toggle('is-hidden', section.hidden);
  });
  const header = $('app-header');
  const nav = $('bottom-nav');
  if (header) header.hidden = false;
  if (nav) nav.hidden = false;

  document.querySelectorAll('#bottom-nav [data-target]').forEach((button) => {
    const active = button.dataset.target === target;
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });

  if (updateHash && location.hash !== `#${target}`) historyReplaceHash(target);
  if (target === 'history') refreshHistoryViews();
  if (target === 'ai') renderAiPanel();
  if (!screen.hidden) screen.querySelector('h2')?.focus({ preventScroll: true });
}

function historyReplaceHash(name) {
  try { window.history.replaceState(null, '', `#${name}`); } catch { /* mode fichier ou navigateur restreint */ }
}

function routeFromHash() {
  const name = location.hash.replace(/^#/, '');
  if (name === 'demo') {
    if (getState().mode !== 'demo') enterDemo();
    else setVisibleScreen('demo', false);
    return;
  }
  if (name === 'onboarding' || !getState().profile) return showOnboarding();
  setVisibleScreen(NAV_SCREENS.includes(name) ? name : 'dashboard', false);
}

function showOnboarding() {
  document.querySelectorAll('main > section[id^="screen-"]').forEach((section) => {
    section.hidden = section.id !== 'screen-onboarding';
    section.classList.toggle('is-hidden', section.hidden);
  });
  if ($('app-header')) $('app-header').hidden = true;
  if ($('bottom-nav')) $('bottom-nav').hidden = true;
  historyReplaceHash('onboarding');
}

function orientationLabel(value) {
  return ({ dos: 'Sur le dos', ventre: 'Sur le ventre', 'cote-gauche': 'Sur le côté gauche', 'cote-droit': 'Sur le côté droit' })[value] || 'Inconnue';
}

function renderPatchStatus(connected) {
  const status = $('patch-status');
  if (!status) return;
  status.dataset.state = connected ? 'connected' : 'disconnected';
  const label = $('patch-status-label');
  if (label) label.textContent = connected ? 'Patch connecté' : 'Patch déconnecté';
  const dot = status.querySelector('.status-dot');
  if (dot) {
    dot.classList.toggle('blink-green', connected);
    dot.classList.toggle('blink-red', !connected);
  }
}

function renderProfile(profile) {
  if (!profile) return;
  const firstName = profile.firstName || profile.firstname || 'Bébé';
  if ($('baby-name')) $('baby-name').textContent = firstName;
  const age = typeof profile.ageMonths === 'number'
    ? profile.ageMonths
    : profile.birthdate ? computeAgeMonths(profile.birthdate) : 0;
  if ($('baby-age')) $('baby-age').textContent = `${age} ${age === 1 ? 'mois' : 'mois'}`;
  if ($('baby-firstname')) $('baby-firstname').value = firstName;
  if ($('baby-birthdate')) $('baby-birthdate').value = profile.birthdate || '';
  if (profile.sex) document.querySelectorAll('input[name="sex"]').forEach((el) => { el.checked = el.value === profile.sex; });
  if ($('risk-pregnancy')) $('risk-pregnancy').checked = Boolean(profile.riskPregnancy ?? profile.pregnancyAtRisk);
  if ($('family-history')) $('family-history').value = profile.familyHistory || '';
}

function renderSettings(settings = {}) {
  const merged = { sound: true, vibration: true, notifications: false, emergencyNumber: '190', theme: 'day', ...settings };
  if ($('setting-sound')) $('setting-sound').checked = merged.sound !== false;
  if ($('setting-vibration')) $('setting-vibration').checked = merged.vibration !== false;
  if ($('setting-notifications')) $('setting-notifications').checked = Boolean(merged.notifications);
  if ($('quick-sound')) $('quick-sound').checked = merged.sound !== false;
  if ($('quick-vibration')) $('quick-vibration').checked = merged.vibration !== false;
  if ($('setting-emergency-number')) $('setting-emergency-number').value = merged.emergencyNumber || '190';
  document.body.dataset.theme = merged.theme === 'night' ? 'night' : 'day';
  setState({ settings: merged });
}

function renderAssessment(frame, result) {
  if (!frame) return;
  const level = result?.level || 'normal';
  const badge = $('risk-badge');
  if (badge) {
    badge.dataset.level = level;
    badge.textContent = ({ normal: 'Tout va bien', vigilance: 'Vigilance', 'pathologie-legere': 'Pathologie légère', urgence: 'Urgence' })[level] || level;
  }
  const reasons = Array.isArray(result?.reasons) && result.reasons.length ? result.reasons : ['Aucune anomalie détectée.'];
  for (const id of ['risk-reasons', 'ai-reasons']) {
    const list = $(id);
    if (!list) continue;
    list.replaceChildren(...reasons.map((text) => {
      const item = document.createElement('li');
      item.textContent = text;
      return item;
    }));
  }

  if ($('hr-value')) $('hr-value').textContent = Number.isFinite(frame.hr) ? String(Math.round(frame.hr)) : '--';
  if ($('rr-value')) $('rr-value').textContent = Number.isFinite(frame.rr) ? String(Math.round(frame.rr)) : '--';
  const orient = $('orientation-value');
  if (orient) orient.dataset.orientation = frame.orientation || 'dos';
  if ($('orientation-label')) $('orientation-label').textContent = orientationLabel(frame.orientation);
  const sleep = $('sleep-value');
  if (sleep) {
    sleep.dataset.sleep = result?.sleep || 'inconnu';
    sleep.textContent = result?.sleep === 'agite' ? 'Bébé agité — beaucoup de mouvements' : result?.sleep === 'calme' ? 'Sommeil calme' : 'Sommeil : en cours d’analyse';
  }
  const patchAge = $('patch-age');
  if (patchAge) {
    const applied = Number(frame.patchAppliedAt || getState().patchAppliedAt || Date.now());
    patchAge.textContent = Math.max(0, (Date.now() - applied) / 3600000).toFixed(1);
  }
  if (result) renderAiPanel(result);
}

function renderAiPanel(result = getState().latestAssessment) {
  const info = getBaselineInfo(history, getState().profile, result?.t);
  if ($('ai-baseline-hr')) $('ai-baseline-hr').textContent = info.hr.median == null ? '--' : Math.round(info.hr.median);
  if ($('ai-baseline-rr')) $('ai-baseline-rr').textContent = info.rr.median == null ? '--' : Math.round(info.rr.median);
  if ($('ai-samples')) $('ai-samples').textContent = String(info.count);
  if ($('ai-confidence')) $('ai-confidence').textContent = ({ faible: 'Faible (apprentissage en cours)', moyenne: 'Moyenne', bonne: 'Bonne' })[info.confidence] || 'Faible';
}

function chartSource() {
  return {
    getFrame: () => getState().latestFrame || lastFrame,
    getLevel: () => getState().latestAssessment?.level || 'normal',
    getPauseSeconds: () => getState().latestAssessment?.pauseSeconds ?? null,
  };
}

function renderLiveCharts(force = false) {
  if (liveChartsInitialized && !force) return;
  const source = chartSource();
  const ecg = $('chart-ecg');
  const resp = $('chart-resp');
  if (ecg) drawLiveECG(ecg, source);
  if (resp) drawLiveResp(resp, source);
  liveChartsInitialized = Boolean(ecg || resp);
}

function rangeMs(range) {
  return range === '7j' ? 7 * DAY : range === '30j' ? 30 * DAY : DAY;
}

function renderAlertList(listId, rows) {
  const list = $(listId);
  if (!list) return;
  const emptyText = listId === 'alert-list' ? 'Aucune alerte pour le moment. C’est une bonne nouvelle.' : 'Aucune alerte à afficher.';
  const visible = (rows || []).filter((a) => !a.source || a.source === 'live');
  list.replaceChildren();
  if (!visible.length) {
    const item = document.createElement('li');
    item.className = 'empty-message';
    item.textContent = emptyText;
    list.append(item);
    return;
  }
  visible.slice().sort((a, b) => b.t - a.t).forEach((alert) => {
    const item = document.createElement('li');
    item.dataset.level = alert.level || 'normal';
    const date = new Date(alert.t).toLocaleString('fr-FR');
    const title = document.createElement('strong');
    title.textContent = `${alert.level === 'urgence' ? 'Urgence' : 'Vigilance'} — ${date}`;
    const detail = document.createElement('span');
    detail.textContent = Array.isArray(alert.reasons) ? alert.reasons.join(' • ') : String(alert.action || '');
    item.append(title, detail);
    list.append(item);
  });
}

async function refreshHistoryViews() {
  const duration = rangeMs(currentRange);
  const from = Date.now() - duration;
  let rangeSamples = samples.filter((s) => s.t >= from);
  let rangeAlerts = alerts.filter((a) => a.t >= from && (!a.source || a.source === 'live'));
  const dbSamples = await dbCall('getSamples', duration);
  const dbAlerts = await dbCall('getAlerts', duration);
  if (Array.isArray(dbSamples)) rangeSamples = dbSamples;
  if (Array.isArray(dbAlerts)) rangeAlerts = dbAlerts.filter((a) => !a.source || a.source === 'live');

  const thresholds = getAgeThresholds(getState().profile?.ageMonths ?? 6);
  const seriesFor = (key) => rangeSamples.map((s) => ({ t: s.t, v: Number(s[key] || 0), level: s.level || 'normal' }));
  const options = (kind, bounds) => ({
    kind,
    alerts: rangeAlerts,
    normalRange: bounds,
    onMarkerSelect: (alert) => showMessage((alert.reasons || []).join(' • ') || 'Alerte', 'info'),
  });
  if ($('chart-history-hr')) drawHistory($('chart-history-hr'), seriesFor('hr'), currentRange, options('hr', { min: thresholds.hr[0], max: thresholds.hr[1] }));
  if ($('chart-history-rr')) drawHistory($('chart-history-rr'), seriesFor('rr'), currentRange, options('rr', { min: thresholds.rr[0], max: thresholds.rr[1] }));
  if ($('chart-history-risk')) drawHistory($('chart-history-risk'), rangeSamples.map((s) => ({ t: s.t, v: Number(s.score || 0), level: s.level || 'normal' })), currentRange, options('risk'));
  renderAlertList('alert-list', rangeAlerts);
  renderAlertList('alert-list-filtered', rangeAlerts.filter((a) => currentAlertFilter === 'tous' || a.level === currentAlertFilter));
}

function updateRangeSelection(button, selector, attrName, value) {
  document.querySelectorAll(selector).forEach((item) => item.setAttribute('aria-pressed', String(item === button || item.getAttribute(attrName) === value)));
}

function updateProfileAge() {
  const birthdate = $('baby-birthdate')?.value;
  const output = $('baby-age-months');
  const error = $('err-birthdate');
  if (!output || !error) return;
  if (!birthdate) { output.textContent = '—'; error.hidden = true; return; }
  const age = computeAgeMonths(birthdate);
  const parsed = new Date(`${birthdate}T12:00:00`);
  const future = Number.isNaN(parsed.getTime()) || age === null;
  const invalid = future || age > 24;
  output.textContent = invalid ? '—' : `${age} mois`;
  error.textContent = future ? 'La date de naissance ne peut pas être dans le futur.' : age > 24 ? 'NeoGuard accepte un âge jusqu’à 24 mois.' : '';
  error.hidden = !invalid;
}

function setFieldError(id, message) {
  const el = $(id);
  if (!el) return;
  el.textContent = message;
  el.hidden = !message;
}

async function saveProfileFromForm(event) {
  event.preventDefault();
  updateProfileAge();
  const firstName = $('baby-firstname')?.value.trim() || '';
  const birthdate = $('baby-birthdate')?.value || '';
  const sex = document.querySelector('input[name="sex"]:checked')?.value || '';
  const consent = Boolean($('consent-check')?.checked);
  setFieldError('err-firstname', firstName ? '' : 'Saisissez le prénom du bébé.');
  setFieldError('err-sex', sex ? '' : 'Choisissez une option.');
  setFieldError('err-consent', consent ? '' : 'Le consentement est nécessaire pour continuer.');
  const age = birthdate ? computeAgeMonths(birthdate) : null;
  const date = birthdate ? new Date(`${birthdate}T12:00:00`) : null;
  const validDate = Boolean(date && !Number.isNaN(date.getTime()) && age !== null && age <= 24);
  setFieldError('err-birthdate', validDate ? '' : !birthdate ? 'Saisissez la date de naissance.' : age === null ? 'Saisissez une date valide qui ne soit pas dans le futur.' : 'NeoGuard accepte un âge jusqu’à 24 mois.');
  if (!firstName || !sex || !consent || !validDate) return;

  const profile = {
    firstName, birthdate, sex, ageMonths: age,
    riskPregnancy: Boolean($('risk-pregnancy')?.checked),
    familyHistory: $('family-history')?.value.trim() || '',
    createdAt: Date.now(), patchAppliedAt: Date.now(),
  };
  setState({ profile, patchAppliedAt: profile.patchAppliedAt });
  memoryStore.profile = profile;
  await dbCall('saveProfile', profile);
  renderProfile(profile);
  await startLiveMonitoring();
  setVisibleScreen('dashboard');
}

function bindChips() {
  document.querySelectorAll('.chip[data-example]').forEach((chip) => chip.addEventListener('click', () => {
    const field = $('family-history');
    const example = chip.dataset.example || '';
    if (!field || !example) return;
    const lines = field.value.split(/\n/).map((line) => line.trim()).filter(Boolean);
    if (!lines.includes(example)) field.value = [...lines, example].join('\n');
  }));
}

function bindSettings() {
  const save = async () => {
    if (getState().mode === 'demo') return;
    const settings = {
      sound: Boolean($('setting-sound')?.checked),
      vibration: Boolean($('setting-vibration')?.checked),
      notifications: Boolean($('setting-notifications')?.checked),
      emergencyNumber: ($('setting-emergency-number')?.value || '190').trim(),
      theme: document.body.dataset.theme || 'day',
    };
    renderSettings(settings);
    memoryStore.settings = settings;
    await dbCall('saveSettings', settings);
  };
  ['setting-sound', 'setting-vibration', 'setting-notifications', 'setting-emergency-number', 'quick-sound', 'quick-vibration'].forEach((id) => {
    $(id)?.addEventListener('change', async (event) => {
      if (id === 'quick-sound' && $('setting-sound')) $('setting-sound').checked = event.target.checked;
      if (id === 'quick-vibration' && $('setting-vibration')) $('setting-vibration').checked = event.target.checked;
      if (id === 'setting-sound' && $('quick-sound')) $('quick-sound').checked = event.target.checked;
      if (id === 'setting-vibration' && $('quick-vibration')) $('quick-vibration').checked = event.target.checked;
      if (id === 'setting-notifications' && event.target.checked) {
        const permission = await requestNotificationPermission();
        if (permission !== 'granted') event.target.checked = false;
      }
      await save();
    });
  });
  $('btn-export')?.addEventListener('click', exportData);
  $('btn-reset-data')?.addEventListener('click', clearData);
}

async function exportData() {
  if (getState().mode === 'demo') return showMessage('L’export est désactivé en mode test.', 'warning');
  const exported = typeof db?.exportAll === 'function' ? await dbCall('exportAll') : null;
  const data = exported || { profile: getState().profile, settings: getState().settings, samples, alerts: alerts.filter((a) => a.source === 'live') };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `neoguard-export-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

async function clearData() {
  if (!window.confirm('Effacer toutes les données NeoGuard de cet appareil ?')) return;
  if (!window.confirm('Cette action est définitive. Confirmer une nouvelle fois ?')) return;
  stopLiveMonitoring();
  stopAllAlerts();
  if (typeof db?.clearAll === 'function') await dbCall('clearAll');
  alerts = [];
  samples = [];
  history = createHistory();
  setState({ profile: null, latestFrame: null, latestAssessment: null, patchAppliedAt: null, alertActive: false });
  renderAlertList('alert-list', []);
  showOnboarding();
}

async function startLiveMonitoring() {
  if (!getState().profile || sensor) return;
  history = createHistory();
  const savedBaseline = await dbCall('getBaseline');
  if (savedBaseline && Number(savedBaseline.n) >= 60) {
    history.baseline = {
      active: true,
      count: Number(savedBaseline.n),
      hr: { median: Number(savedBaseline.hrMedian), mad: Number(savedBaseline.hrMad) },
      rr: { median: Number(savedBaseline.rrMedian), mad: Number(savedBaseline.rrMad) },
    };
  }
  sensor = new SimulatedSensor({ baseHr: 120, baseRr: 34, patchAppliedAt: getState().patchAppliedAt || Date.now() });
  liveUnsubscribe = sensor.onFrame(onLiveFrame);
  sensor.on('disconnected', () => {
    markDisconnected(history, Date.now());
    renderPatchStatus(false);
    if (disconnectedTimer !== null) clearTimeout(disconnectedTimer);
    disconnectedTimer = setTimeout(() => evaluateDisconnected(), 60000);
  });
  sensor.on('connected', () => {
    markConnected(history);
    renderPatchStatus(true);
    if (disconnectedTimer !== null) clearTimeout(disconnectedTimer);
    disconnectedTimer = null;
  });
  sensor.start();
  renderPatchStatus(sensor.isConnected());
  renderLiveCharts();
}

function stopLiveMonitoring() {
  if (liveUnsubscribe) liveUnsubscribe();
  liveUnsubscribe = null;
  if (sensor) sensor.stop();
  sensor = null;
  if (disconnectedTimer !== null) clearTimeout(disconnectedTimer);
  disconnectedTimer = null;
}

function onLiveFrame(frame) {
  if (getState().mode !== 'live') return;
  lastFrame = frame;
  const result = assess(frame, getState().profile, history);
  recordResult(history, frame, result);
  setState({ latestFrame: frame, latestAssessment: result, patchAppliedAt: frame.patchAppliedAt });
  renderAssessment(frame, result);
  renderPatchStatus(frame.patchConnected !== false);
  handleAssessment(result);
  renderLiveCharts();
  void checkPatchReminder(frame.t);
  aggregateAndSave(frame, result);
}

function evaluateDisconnected() {
  if (!sensor || sensor.isConnected() || getState().mode !== 'live') return;
  const now = Date.now();
  const result = assess({ t: now, patchConnected: false }, getState().profile, history);
  setState({ latestAssessment: result, latestFrame: null });
  renderPatchStatus(false);
  renderAssessment(lastFrame || { patchAppliedAt: getState().patchAppliedAt }, result);
  handleAssessment(result);
}

async function aggregateAndSave(frame, result) {
  const bucket = Math.floor(frame.t / 60000);
  if (minuteAccumulator && minuteAccumulator.bucket !== bucket) await flushMinuteAggregate();
  if (!minuteAccumulator) {
    minuteAccumulator = { bucket, n: 0, hr: 0, rr: 0, motion: 0, score: 0, orientation: frame.orientation, level: result.level };
  }
  minuteAccumulator.n += 1;
  minuteAccumulator.hr += Number(frame.hr || 0);
  minuteAccumulator.rr += Number(frame.rr || 0);
  minuteAccumulator.motion += Number(frame.motion || 0);
  minuteAccumulator.score += Number(result.score || 0);
  minuteAccumulator.orientation = frame.orientation;
  minuteAccumulator.level = result.level;
}

async function flushMinuteAggregate() {
  if (!minuteAccumulator || !minuteAccumulator.n || getState().mode !== 'live') return;
  const { bucket, n, hr, rr, motion, score, orientation, level } = minuteAccumulator;
  const sample = { t: bucket * 60000, hr: hr / n, rr: rr / n, motion: motion / n, orientation, score: score / n, level };
  minuteAccumulator = null;
  samples.push(sample);
  if (samples.length > 2000) samples.splice(0, samples.length - 2000);
  await dbCall('addSample', sample);
  void refreshHistoryViews();
}

function bindNavigation() {
  $('bottom-nav')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-target]');
    if (!button) return;
    if (button.dataset.target === 'demo') {
      enterDemo();
      return;
    }
    setVisibleScreen(button.dataset.target);
  });
  window.addEventListener('hashchange', routeFromHash);
  document.querySelectorAll('.range-btn[data-range]').forEach((button) => button.addEventListener('click', () => {
    currentRange = button.dataset.range;
    document.querySelectorAll('.range-btn[data-range]').forEach((el) => el.setAttribute('aria-pressed', String(el === button)));
    void refreshHistoryViews();
  }));
  document.querySelectorAll('.alert-filter[data-filter]').forEach((button) => button.addEventListener('click', () => {
    currentAlertFilter = button.dataset.filter;
    document.querySelectorAll('.alert-filter[data-filter]').forEach((el) => el.setAttribute('aria-pressed', String(el === button)));
    void refreshHistoryViews();
  }));
}

function subscribeToAlerts() {
  if (alertUnsubscribe) alertUnsubscribe();
  alertUnsubscribe = subscribeAlerts((alert) => {
    if (!alert || alert.source !== 'live') return;
    alerts.unshift(alert);
    alerts = alerts.slice(0, 1000);
    void refreshHistoryViews();
  });
}

function bindModeIsolation() {
  subscribe((next, previous) => {
    if (next.mode === previous.mode) return;
    if (next.mode === 'demo') {
      // Le capteur LIVE est arrêté pendant le test : aucun rendu ni écriture
      // réelle en arrière-plan. Le mode demo.js utilise sa propre instance.
      stopLiveMonitoring();
      minuteAccumulator = null;
      renderLiveCharts(true);
      return;
    }
    if (next.mode === 'live' && next.profile) void startLiveMonitoring();
  });
}

async function loadPersistedState() {
  const profile = await dbCall('getProfile') || memoryStore.profile;
  const settings = await dbCall('getSettings') || memoryStore.settings;
  const loadedAlerts = await dbCall('getAlerts', 90 * DAY);
  const loadedSamples = await dbCall('getSamples', 90 * DAY);
  if (profile) setState({ profile, patchAppliedAt: profile.patchAppliedAt || null });
  if (settings) renderSettings(settings);
  if (Array.isArray(loadedAlerts)) alerts = loadedAlerts.filter((a) => !a.source || a.source === 'live');
  if (Array.isArray(loadedSamples)) samples = loadedSamples;
  if (profile) renderProfile(profile);
  return profile;
}

function wireAlerts() {
  initAlerts({
    persistAlert: async (alert) => {
      if (getState().mode !== 'live') return;
      const clean = { ...alert, source: 'live' };
      await dbCall('addAlert', clean);
    },
    persistPatchAppliedAt: (at) => dbCall('markPatchChanged', at),
    setSensorPatchAppliedAt: (at) => sensor?.setPatchAppliedAt(at),
  });
}

function bindProfileForm() {
  $('profile-form')?.addEventListener('submit', saveProfileFromForm);
  $('baby-birthdate')?.addEventListener('input', updateProfileAge);
  $('baby-birthdate')?.addEventListener('change', updateProfileAge);
  bindChips();
}

function bindDemoEntry() {
  $('btn-enter-demo')?.addEventListener('click', () => enterDemo());
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    const hadController = Boolean(navigator.serviceWorker.controller);
    const registration = await navigator.serviceWorker.register('./sw.js');
    const activateWaitingWorker = () => {
      if (registration.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' });
    };
    activateWaitingWorker();
    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      installing?.addEventListener('statechange', () => {
        if (installing.state === 'installed' && navigator.serviceWorker.controller) activateWaitingWorker();
      });
    });
    if (hadController) {
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloadedForWorkerUpdate) return;
        reloadedForWorkerUpdate = true;
        location.reload();
      }, { once: true });
    }
  }
  catch (error) { console.info('[NeoGuard/main] Service worker non enregistré :', error); }
}

async function bootstrap() {
  if (booted) return;
  booted = true;
  if ($('baby-birthdate')) $('baby-birthdate').max = new Date().toISOString().slice(0, 10);
  bindNavigation();
  bindProfileForm();
  bindDemoEntry();
  bindSettings();
  wireAlerts();
  subscribeToAlerts();
  bindModeIsolation();
  await openDatabase();
  const profile = await loadPersistedState();
  await registerServiceWorker();
  if (!profile) {
    showOnboarding();
    return;
  }
  await startLiveMonitoring();
  setVisibleScreen(location.hash ? location.hash.slice(1) : 'dashboard', false);
  void refreshHistoryViews();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootstrap, { once: true });
else void bootstrap();
