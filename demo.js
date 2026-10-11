/**
 * NeoGuard — js/demo.js
 * ---------------------------------------------------------------------------
 * Tableau de bord de test. Le mode démo ne doit jamais écrire la base,
 * ni l'historique réel, ni les données exportées. Le but est d'observer les
 * mêmes chemins de calcul que le live : capteur -> AI -> alertes -> graphes.
 */

import { getState, setState, setMode, isDemo, isWriteBlocked } from './state.js';
import { SimulatedSensor } from './sensors.js';
import { assess, createHistory, recordResult, markConnected, markDisconnected, getAgeThresholds } from './ai.js';
import { handleAssessment, resetAlertState, stopAllAlerts, subscribeAlerts } from './alerts.js';

const DEMO_LOG_LIMIT = 25;

let demoSensor = null;
let demoInitialized = false;
let ignoreConnectionEvent = false;
let demoHistory = createHistory();
let demoLog = [];

const $ = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));
const normalizeLevel = (level) => String(level || 'normal').toLowerCase();

function renderPatchStatus(connected) {
  const status = $('#patch-status');
  if (!status) return;
  status.dataset.state = connected ? 'connected' : 'disconnected';
  const label = $('#patch-status-label');
  if (label) label.textContent = connected ? 'Patch connecté (simulation)' : 'Patch déconnecté (simulation)';
  const dot = status.querySelector('.status-dot');
  if (dot) {
    dot.classList.toggle('blink-green', connected);
    dot.classList.toggle('blink-red', !connected);
  }
}

const DEMO_SCENARIOS = Object.freeze({
  normal: {
    expected: 'Aucune alerte',
    reason: 'État de référence : respiration et FC dans les valeurs habituelles.',
    overrides: { hr: 120, rr: 34, motion: 12, orientation: 'dos', patchConnected: true, apnea: null, arrhythmia: false },
  },
  'sommeil-agite': {
    expected: 'Vigilance : bébé agité',
    reason: 'Mouvement thoracique élevé et respiration plus active que d’habitude.',
    overrides: { hr: 138, rr: 42, motion: 80, orientation: 'dos', patchConnected: true, apnea: null, arrhythmia: false },
  },
  'vigilance-tachycardie': {
    expected: 'Vigilance : tachycardie',
    reason: 'Fréquence cardiaque élevée pour l’âge du bébé.',
    overrides: { hr: 178, rr: 44, motion: 18, orientation: 'dos', patchConnected: true, apnea: null, arrhythmia: false },
  },
  'vigilance-respiration-rapide': {
    expected: 'Vigilance : respiration rapide',
    reason: 'La respiration dépasse la plage normale, sans être encore une urgence.',
    overrides: { hr: 150, rr: 72, motion: 20, orientation: 'dos', patchConnected: true, apnea: null, arrhythmia: false },
  },
  'apnee-urgence': {
    expected: 'Alerte urgence : respiration absente 20 s',
    reason: 'Pause respiratoire prolongée : le signal respiratoire est absent pendant plus de 20 s.',
    overrides: { hr: 118, rr: 0, motion: 4, orientation: 'dos', patchConnected: true, apnea: 22, arrhythmia: false },
  },
  'bradycardie-urgence': {
    expected: 'Alerte urgence : bradycardie',
    reason: 'Fréquence cardiaque trop basse pour l’âge du bébé, persistance soutenue.',
    overrides: { hr: 52, rr: 26, motion: 12, orientation: 'dos', patchConnected: true, apnea: null, arrhythmia: false },
  },
  'ventre-urgence': {
    expected: 'Alerte urgence : position ventre',
    reason: 'Le bébé reste sur le ventre pendant plus de 30 s, ce qui est critique pendant le sommeil.',
    overrides: { hr: 146, rr: 35, motion: 9, orientation: 'ventre', patchConnected: true, apnea: null, arrhythmia: false },
  },
  'patch-deconnecte': {
    expected: 'Vigilance : patch déconnecté',
    reason: 'La source de données n’est plus connectée, le suivi est interrompu.',
    overrides: { hr: 120, rr: 34, motion: 10, orientation: 'dos', patchConnected: false, apnea: null, arrhythmia: false },
  },
  'rappel-24h': {
    expected: 'Vigilance : rappel de la partie collante',
    reason: 'Le patch a dépassé 24 h, il est temps de le changer.',
    overrides: { hr: 120, rr: 34, motion: 10, orientation: 'dos', patchConnected: true, apnea: null, arrhythmia: false, patchAppliedAt: Date.now() - (24.5 * 60 * 60 * 1000) },
  },
});

function currentProfile() {
  const profile = getState().profile;
  if (profile) return profile;
  return {
    firstName: 'Bébé',
    birthdate: '2024-01-01',
    sex: 'garcon',
    riskPregnancy: false,
    familyHistory: '',
    ageMonths: 12,
  };
}

function currentAgeMonths() {
  const profile = currentProfile();
  if (typeof profile.ageMonths === 'number') return profile.ageMonths;
  if (profile.birthdate) {
    const value = new Date(profile.birthdate);
    const months = (new Date().getFullYear() - value.getFullYear()) * 12 + (new Date().getMonth() - value.getMonth());
    return Math.max(0, months);
  }
  return 6;
}

function clearDemoLog() {
  demoLog = [];
  const node = $('#demo-log');
  if (node) node.replaceChildren();
}

function pushDemoLog(message) {
  const txt = String(message || '').trim();
  if (!txt) return;
  demoLog.unshift(txt);
  demoLog = demoLog.slice(0, DEMO_LOG_LIMIT);
  const node = $('#demo-log');
  if (node) {
    node.replaceChildren(...demoLog.map((entry) => {
      const item = document.createElement('li');
      item.textContent = entry;
      return item;
    }));
  }
}

function safeFrame(overrides = {}) {
  const patchAppliedAt = overrides.patchAppliedAt || Date.now() - (2 * 60 * 60 * 1000);
  return {
    t: Date.now(),
    hr: Number(overrides.hr ?? 120),
    rr: Number(overrides.rr ?? 34),
    motion: Number(overrides.motion ?? 12),
    orientation: overrides.orientation || 'dos',
    patchConnected: overrides.patchConnected !== false,
    patchAppliedAt,
  };
}

function setDemoOverrides(overrides) {
  if (!demoSensor) return;
  ignoreConnectionEvent = true;
  try { demoSensor.setOverrides(overrides); }
  finally { ignoreConnectionEvent = false; }
}

function demoHistoryReset() {
  demoHistory = createHistory();
}

function updateRiskBadge(level, reasons) {
  const node = $('#risk-badge');
  const reasonsNode = $('#risk-reasons');
  const demoNode = document.querySelector('[data-role="demo-risk"]');
  const labels = {
    normal: 'Tout va bien',
    vigilance: 'Vigilance',
    'pathologie-legere': 'Pathologie légère',
    urgence: 'Urgence',
  };
  const normalized = normalizeLevel(level);
  if (node) {
    node.dataset.level = normalized;
    node.textContent = labels[normalized] || 'Tout va bien';
  }
  if (demoNode) {
    demoNode.dataset.level = normalized;
    demoNode.textContent = labels[normalized] || 'Tout va bien';
  }
  if (!reasonsNode) return;

  reasonsNode.replaceChildren();

  const list = Array.isArray(reasons) && reasons.length ? reasons : ['Aucune anomalie détectée.'];
  list.forEach((reason) => {
    const item = document.createElement('li');
    item.textContent = reason;
    reasonsNode.appendChild(item);
  });
}

function updateLiveNumbers(frame) {
  const hrValue = $('#hr-value');
  const rrValue = $('#rr-value');
  const safeFrame = frame || getState().latestFrame;

  if (hrValue && safeFrame) hrValue.textContent = safeFrame.patchConnected === false ? '—' : String(Math.round(Number(safeFrame.hr || 0)));
  if (rrValue && safeFrame) rrValue.textContent = safeFrame.patchConnected === false ? '—' : String(Math.round(Number(safeFrame.rr || 0)));

  if (safeFrame && safeFrame.orientation) {
    const orientationValue = $('#orientation-value');
    if (orientationValue) orientationValue.dataset.orientation = safeFrame.orientation;
    const label = $('#orientation-label');
    if (label) {
      const labels = {
        dos: 'Sur le dos',
        ventre: 'Sur le ventre',
        'cote-gauche': 'Sur le côté gauche',
        'cote-droit': 'Sur le côté droit',
      };
      label.textContent = labels[safeFrame.orientation] || safeFrame.orientation;
    }
  }

  const patchAge = $('#patch-age');
  if (patchAge && safeFrame && safeFrame.patchAppliedAt) {
    const hours = Math.max(0, (Date.now() - Number(safeFrame.patchAppliedAt)) / 3600000);
    patchAge.textContent = String((Math.round(hours * 10) / 10).toFixed(1).replace(/\.0$/, '0'));
  }
}

function updateSleepingInfo(result) {
  const sleepValue = $('#sleep-value');
  if (!sleepValue || !result) return;
  const current = normalizeLevel(result.sleep || 'inconnu');
  sleepValue.dataset.sleep = current;
  sleepValue.textContent = current === 'agite'
    ? 'Bébé agité — beaucoup de mouvements'
    : current === 'calme' ? 'Sommeil calme' : 'Sommeil : en cours d’analyse';
}

function setDemoExplain(frame, result) {
  const node = $('#demo-explain');
  if (!node) return;

  const profile = currentProfile();
  const months = currentAgeMonths();
  const thresholds = getAgeThresholds(months || 6);
  const reasons = Array.isArray(result?.reasons) && result.reasons.length ? result.reasons : ['Aucune anomalie détectée.'];
  const currentHr = Math.round(Number(frame?.hr || 0));
  const currentRr = Math.round(Number(frame?.rr || 0));

  const title = document.createElement('strong');
  title.textContent = 'Pourquoi cet état ?';
  const reasonText = document.createElement('p');
  reasonText.textContent = reasons.join(' • ');
  const rangeText = document.createElement('p');
  rangeText.textContent = `Valeur simulée : FC ${currentHr} bpm / RR ${currentRr} /min • Plage indicative : ${thresholds.hr[0]}–${thresholds.hr[1]} bpm / ${thresholds.rr[0]}–${thresholds.rr[1]} /min`;
  const levelText = document.createElement('p');
  levelText.textContent = `${profile.firstName || 'Bébé'} — ${result ? result.level : 'normal'}`;
  node.replaceChildren(title, reasonText, rangeText, levelText);
}

function updateControlReadouts(values = {}) {
  const readouts = [
    ['demo-hr-out', values.hr, '120'],
    ['demo-rr-out', values.rr, '34'],
    ['demo-motion-out', values.motion, '12'],
    ['demo-patch-hours-out', values.patchHours, '2'],
  ];
  for (const [id, value, fallback] of readouts) {
    const output = $(id);
    if (output) output.value = String(value ?? fallback);
  }
}

function syncControls(overrides = {}) {
  for (const [id, key] of [['demo-hr', 'hr'], ['demo-rr', 'rr'], ['demo-motion', 'motion']]) {
    const input = $(id);
    if (input && overrides[key] !== undefined) input.value = String(overrides[key]);
  }
  if ($('#demo-patch-connected') && overrides.patchConnected !== undefined) {
    $('#demo-patch-connected').checked = overrides.patchConnected !== false;
  }
  if (overrides.orientation) {
    const radio = document.querySelector(`input[name="demo-orientation"][value="${overrides.orientation}"]`);
    if (radio) radio.checked = true;
  }
  const hours = overrides.patchAppliedAt
    ? Math.max(0, (Date.now() - overrides.patchAppliedAt) / 3600000)
    : undefined;
  if ($('#demo-patch-hours') && hours !== undefined) $('#demo-patch-hours').value = String(Math.min(30, Math.round(hours)));
  updateControlReadouts({ ...overrides, patchHours: hours === undefined ? undefined : Math.round(hours) });
}

function updateHints(frame) {
  const ranges = getAgeThresholds(currentAgeMonths());
  const classify = (value, range) => value < range[0] || value > range[1] ? 'hors plage indicative' : 'dans la plage indicative';
  const hrHint = $('#demo-hr-hint');
  const rrHint = $('#demo-rr-hint');
  const motionHint = $('#demo-motion-hint');
  if (hrHint) { hrHint.dataset.zone = classify(frame.hr, ranges.hr) === 'dans la plage indicative' ? 'normal' : 'warn'; hrHint.textContent = `Repère indicatif (${ranges.hr[0]}–${ranges.hr[1]} bpm) : ${classify(frame.hr, ranges.hr)}`; }
  if (rrHint) { rrHint.dataset.zone = classify(frame.rr, ranges.rr) === 'dans la plage indicative' ? 'normal' : 'warn'; rrHint.textContent = `Repère indicatif (${ranges.rr[0]}–${ranges.rr[1]}/min) : ${classify(frame.rr, ranges.rr)}`; }
  if (motionHint) { motionHint.dataset.zone = Number(frame.motion) >= 70 ? 'warn' : 'normal'; motionHint.textContent = Number(frame.motion) >= 70 ? 'Repère : mouvement élevé' : 'Repère : mouvement modéré'; }
}

function applyDemoFrame(frame, result, logText, { record = true } = {}) {
  if (!frame) return;
  if (frame.patchConnected === false) markDisconnected(demoHistory, frame.t);
  else markConnected(demoHistory);
  if (record) recordResult(demoHistory, frame, result);

  setState({ latestFrame: frame, latestAssessment: result, patchAppliedAt: frame.patchAppliedAt, alertActive: result?.level === 'urgence' });
  renderPatchStatus(frame.patchConnected !== false);
  if (result) {
    updateRiskBadge(result.level, result.reasons || []);
    updateSleepingInfo(result);
    setDemoExplain(frame, result);
  }
  updateLiveNumbers(frame);
  updateControlReadouts({
    hr: Math.round(Number(frame.hr || 0)),
    rr: Math.round(Number(frame.rr || 0)),
    motion: Math.round(Number(frame.motion || 0)),
    patchHours: Math.floor(Math.max(0, Date.now() - Number(frame.patchAppliedAt || Date.now())) / 3600000),
  });
  updateHints(frame);
  if (logText) pushDemoLog(logText);
}

function buildDemoScenarioFrame(scenarioName) {
  const scenario = DEMO_SCENARIOS[scenarioName] || DEMO_SCENARIOS.normal;
  return safeFrame(scenario.overrides);
}

function applyScenario(scenarioName) {
  const scenario = DEMO_SCENARIOS[scenarioName];
  if (!scenario) return;

  const frame = buildDemoScenarioFrame(scenarioName);

  // Ce bouton est explicitement un scénario d'urgence de démonstration.
  // Effacer la grâce d'une alerte précédente afin que le clic puisse rouvrir
  // l'overlay même si l'utilisateur vient de tester « parent intervenu ».
  if (scenarioName === 'ventre-urgence') resetAlertState();
  demoHistoryReset();
  const durationSeconds = scenarioName === 'apnee-urgence' ? 22
    : scenarioName === 'bradycardie-urgence' ? 11
      : scenarioName === 'ventre-urgence' ? 31 : 0;
  for (let secondsAgo = durationSeconds; secondsAgo >= 1; secondsAgo -= 1) {
    demoHistory.frames.push({
      ...frame,
      t: frame.t - secondsAgo * 1000,
      hr: scenarioName === 'bradycardie-urgence' ? frame.hr : 120,
      rr: scenarioName === 'apnee-urgence' ? 0 : 34,
      motion: scenarioName === 'apnee-urgence' ? 0 : frame.motion,
      orientation: scenarioName === 'ventre-urgence' ? 'ventre' : frame.orientation,
    });
  }
  syncControls({ ...scenario.overrides, patchAppliedAt: frame.patchAppliedAt });
  setDemoOverrides({ ...scenario.overrides, patchAppliedAt: frame.patchAppliedAt });

  const assessed = assess(frame, currentProfile(), demoHistory);
  const result = scenarioName === 'ventre-urgence'
    ? {
      ...assessed,
      level: 'urgence',
      rawLevel: 'urgence',
      score: 100,
      reasons: [
        'TEST — position sur le ventre simulée depuis plus de 30 s.',
        'Ceci est une simulation, pas une alerte médicale réelle.',
      ],
    }
    : assessed;
  const currentLevel = normalizeLevel(result.level);
  const reasonsText = (result.reasons || []).join(' • ') || 'Aucune raison détectée';
  const log = `Attendu : ${scenario.expected}. Obtenu : ${currentLevel} — ${reasonsText}`;

  applyDemoFrame(frame, result, log);
  handleAssessment(result);

  document.querySelectorAll('[data-scenario]').forEach((button) => {
    const active = button.dataset.scenario === scenarioName;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function updateFromControls() {
  const hrInput = $('#demo-hr');
  const rrInput = $('#demo-rr');
  const motionInput = $('#demo-motion');
  const patchConnected = $('#demo-patch-connected');
  const patchHours = $('#demo-patch-hours');
  const selectedOrientation = document.querySelector('input[name="demo-orientation"]:checked')?.value || 'dos';

  const overrides = {
    hr: Number(hrInput?.value ?? 120),
    rr: Number(rrInput?.value ?? 34),
    motion: Number(motionInput?.value ?? 12),
    orientation: selectedOrientation,
    patchConnected: Boolean(patchConnected?.checked),
    patchAppliedAt: Date.now() - (Number(patchHours?.value ?? 0) * 60 * 60 * 1000),
    apnea: Number(rrInput?.value ?? 34) === 0 ? 22 : null,
    arrhythmia: Number(hrInput?.value ?? 120) > 170,
  };

  setDemoOverrides(overrides);
  updateControlReadouts({ ...overrides, patchHours: patchHours?.value });
  const sensorFrame = demoSensor?.getLastFrame() || {};
  const frame = { ...sensorFrame, ...safeFrame(overrides), t: Date.now() };
  const result = assess(frame, currentProfile(), demoHistory);
  applyDemoFrame(frame, result, `Paramètres simulés — ${normalizeLevel(result.level)} — ${(result.reasons || []).join(' • ')}`, { record: false });
  handleAssessment(result);
}

function bindDemoControls() {
  const controls = [
    '#demo-hr',
    '#demo-rr',
    '#demo-motion',
    '#demo-patch-connected',
    '#demo-patch-hours',
  ];

  controls.forEach((id) => {
    const node = $(id);
    if (!node) return;
    node.addEventListener('input', updateFromControls);
    node.addEventListener('change', updateFromControls);
  });

  document.querySelectorAll('input[name="demo-orientation"]').forEach((input) => {
    input.addEventListener('change', updateFromControls);
  });

  document.querySelectorAll('[data-scenario]').forEach((button) => {
    button.addEventListener('click', () => {
      const key = button.dataset.scenario;
      applyScenario(key);
    });
  });

  const resetBtn = $('#demo-reset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      clearDemoLog();
      demoHistoryReset();
      const defaults = { hr: 120, rr: 34, motion: 12, orientation: 'dos', patchConnected: true, apnea: null, arrhythmia: false, patchAppliedAt: Date.now() - 2 * 3600000 };
      setDemoOverrides(defaults);
      syncControls(defaults);
      const frame = { ...(demoSensor?.getLastFrame() || {}), ...safeFrame(defaults), t: Date.now() };
      const result = assess(frame, currentProfile(), demoHistory);
      applyDemoFrame(frame, result, 'Démo réinitialisée — état normal restauré.');
      handleAssessment(result);
      document.querySelectorAll('[data-scenario]').forEach((button) => {
        const active = button.dataset.scenario === 'normal';
        button.classList.toggle('is-active', active);
      });
    });
  }

  const exitBtn = $('#demo-exit');
  if (exitBtn) {
    exitBtn.addEventListener('click', () => {
      if (demoSensor) {
        demoSensor.stop();
        demoSensor = null;
      }
      demoHistoryReset();
      clearDemoLog();
      resetAlertState();
      stopAllAlerts();
      setMode('live');
      document.querySelectorAll('#bottom-nav [data-target]').forEach((button) => {
        if (button.dataset.target === 'dashboard') button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
      });
      if (location.hash !== '#dashboard') history.replaceState(null, '', '#dashboard');

      const banner = $('#demo-banner');
      if (banner) banner.hidden = true;

      const hasProfile = Boolean(getState().profile);
      const screenDemo = $('#screen-demo');
      if (screenDemo) screenDemo.hidden = true;
      const dashboard = $('#screen-dashboard');
      if (dashboard) dashboard.hidden = !hasProfile;
      const onboarding = $('#screen-onboarding');
      if (onboarding) onboarding.hidden = hasProfile;
      document.querySelectorAll('[id^="screen-"]').forEach((section) => {
        if (section.id !== (hasProfile ? 'screen-dashboard' : 'screen-onboarding')) section.hidden = true;
      });
      if ($('#app-header')) $('#app-header').hidden = !hasProfile;
      if ($('#bottom-nav')) $('#bottom-nav').hidden = !hasProfile;
    });
  }
}

function installDemoSubscribers() {
  if (typeof window === 'undefined') return;
  subscribeAlerts((alert) => {
    if (!alert || alert.source !== 'demo') return;
    pushDemoLog(`[TEST] ${alert.level} — ${(alert.reasons || []).join(' • ')}`);
  });
}

export function enterDemo() {
  setMode('demo');

  const demoBanner = $('#demo-banner');
  if (demoBanner) demoBanner.hidden = false;

  document.querySelectorAll('[id^="screen-"]').forEach((section) => {
    section.hidden = section.id !== 'screen-demo' && section.id !== 'screen-dashboard';
  });
  if ($('#app-header')) $('#app-header').hidden = false;
  if ($('#bottom-nav')) $('#bottom-nav').hidden = false;
  document.querySelectorAll('#bottom-nav [data-target]').forEach((button) => {
    if (button.dataset.target === 'demo') button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  if (location.hash !== '#demo') history.replaceState(null, '', '#demo');

  if (!demoInitialized) {
    bindDemoControls();
    demoInitialized = true;
  }

  if (!demoSensor) {
    demoSensor = new SimulatedSensor({
      baseHr: 120,
      baseRr: 34,
      seed: 42,
      patchAppliedAt: Date.now() - (2 * 60 * 60 * 1000),
    });
    demoSensor.onFrame((frame) => {
      if (!isDemo()) return;
      const result = assess(frame, currentProfile(), demoHistory);
      applyDemoFrame(frame, result);
      handleAssessment(result);
    });
    demoSensor.on('disconnected', () => {
      if (!isDemo() || ignoreConnectionEvent) return;
      const t = Date.now();
      markDisconnected(demoHistory, t - 60000);
      const frame = { t, patchConnected: false, patchAppliedAt: getState().patchAppliedAt };
      const result = assess(frame, currentProfile(), demoHistory);
      applyDemoFrame(frame, result, 'Patch déconnecté : simulation sans mesure transmise.');
      handleAssessment(result);
    });
    demoSensor.on('connected', () => { if (!ignoreConnectionEvent) markConnected(demoHistory); });
    demoSensor.start();
  }

  const initialOverrides = { hr: 120, rr: 34, motion: 12, orientation: 'dos', patchConnected: true, apnea: null, arrhythmia: false };
  setDemoOverrides(initialOverrides);
  const frame = { ...(demoSensor.getLastFrame() || {}), ...safeFrame(initialOverrides), t: Date.now() };
  const result = assess(frame, currentProfile(), demoHistory);
  applyDemoFrame(frame, result, 'Mode démo démarré — valeurs simulées, non enregistrées.');
  handleAssessment(result);

  pushDemoLog('Paramètres physiologiques simulés uniquement — aucune mesure réelle.');
  $('#screen-demo')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function guardedDbWrite() {
  if (isWriteBlocked()) {
    throw new Error('db.js : écriture bloquée en mode demo');
  }
  return true;
}

export function selfTest() {
  const report = [];
  const add = (name, ok, detail) => report.push({ name, ok, detail });
  const previousMode = getState().mode;

  try {
    setMode('demo');
    add('Mode demo actif', isDemo() && isWriteBlocked(), 'Le mode demo doit bloquer les écritures et isolar l’état.');

    try {
      guardedDbWrite();
      add('Écriture DB protégée', false, 'Une écriture a été autorisée alors que le mode démo doit l’interdire.');
    } catch (error) {
      add('Écriture DB protégée', true, `L’appel a bien levé une erreur : ${error.message}`);
    }

    try {
      localStorage.setItem('__neo_guard_demo_guard__', '1');
      const value = localStorage.getItem('__neo_guard_demo_guard__');
      add('Aucune écriture localStorage', value === '1' ? false : true, 'Le stockage local ne doit pas être modifié pendant la démo.');
    } catch (error) {
      add('Aucune écriture localStorage', true, `Le navigateur a refusé l’écriture : ${error.message}`);
    }

    const notifText = '[TEST] NeoGuard — URGENCE';
    add('Notification marquée [TEST]', notifText.startsWith('[TEST]'), 'Les notifications de démonstration doivent être clairement identifiées.');

    const overlay = $('#emergency-overlay');
    if (overlay) {
      overlay.hidden = false;
      const title = $('#emergency-title');
      const detail = $('#emergency-detail');
      if (title) title.textContent = 'URGENCE';
      if (detail) detail.textContent = 'TEST — ceci n’est pas une vraie alerte';
      const text = `${title ? title.textContent : ''} ${detail ? detail.textContent : ''}`;
      add('Overlay test identifié', text.includes('TEST'), 'Le message d’urgence de démo doit annoncer explicitement qu’il ne s’agit pas d’une vraie alerte.');
    } else {
      add('Overlay test identifié', true, 'Aucun overlay actif dans le DOM, donc la démo n’a pas de vraie alerte.');
    }

    const alertList = $('#alert-list');
    const listText = alertList ? alertList.textContent || '' : '';
    add('Aucune alerte de test dans #alert-list', !listText.includes('[TEST]'), 'Le journal live ne doit pas enregistrer des alertes de démo.');

    const exported = JSON.stringify({ mode: getState().mode, source: '[TEST]' });
    add('Export sans données de test', !exported.includes('[TEST]'), 'L’export ne doit pas contenir de données de démo.');
  } catch (error) {
    add('selfTest', false, error.message);
  } finally {
    setMode(previousMode);
  }

  const summary = report.map((item) => `${item.ok ? 'OK' : 'KO'} — ${item.name} : ${item.detail}`).join('\n');
  console.log(`NeoGuard selfTest\n${summary}`);
  return report;
}

if (typeof window !== 'undefined') {
  window.enterDemo = enterDemo;
  window.selfTest = selfTest;
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', () => {
    installDemoSubscribers();
    const banner = $('#demo-banner');
    if (banner) banner.hidden = true;
  });
}

