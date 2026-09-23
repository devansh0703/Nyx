/* eslint-disable no-undef */
/**
 * Onboarding wizard controller.
 *
 * Drives the 3-step flow rendered in onboarding.html and persists
 * everything via the electronAPI bridge exposed by preload.js:
 *
 *   1. Welcome
 *   2. Gemini API key entry + live connection test (the AI backend:
 *      chat, vision, and voice transcription)
 *   3. Star-the-repo prompt + summary
 */

(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────────
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const screens = $$('.screen');
  const stepperDots = $$('.step-dot');
  const stepBadge = $('#stepBadge');
  const backBtn = $('#backBtn');
  const nextBtn = $('#nextBtn');
  const skipBtn = $('#skipBtn');

  // ── State ─────────────────────────────────────────────────────────
  const state = {
    step: 0,
    geminiKey: '',
    geminiConfigured: false,
    finished: false,
  };

  // Screens are: welcome → gemini key → finish
  const stepScreens = ['welcome', 'geminiskey', 'finish'];

  // ── Step rendering ────────────────────────────────────────────────
  function totalSteps() {
    return stepScreens.length;
  }

  function refreshStepper() {
    const total = totalSteps();
    const current = state.step + 1;
    stepBadge.textContent = `Step ${current} of ${total}`;
    stepperDots.forEach((dot, i) => {
      dot.classList.remove('active', 'done');
      if (i < state.step) dot.classList.add('done');
      else if (i === state.step) dot.classList.add('active');
    });
  }

  function showScreen(name) {
    screens.forEach((s) => {
      s.classList.toggle('active', s.dataset.screen === name);
    });
    // Welcome screen uses an inline hero CTA — hide the regular nav row.
    const wizardEl = document.getElementById('wizard');
    if (wizardEl) {
      wizardEl.classList.toggle('welcome-active', name === 'welcome');
    }
    refreshStepper();
    backBtn.style.visibility = state.step === 0 ? 'hidden' : 'visible';
    skipBtn.style.visibility = 'hidden';
    nextBtn.disabled = false;
    nextBtn.classList.remove('success');
    nextBtn.classList.add('primary');
    // The primary action label changes by step
    if (name === 'welcome') nextBtn.innerHTML = 'Get started <i class="fas fa-arrow-right"></i>';
    else if (name === 'finish') nextBtn.innerHTML = 'Finish <i class="fas fa-check"></i>';
    else nextBtn.innerHTML = 'Continue <i class="fas fa-arrow-right"></i>';
  }

  function currentScreenName() {
    const active = Array.from(screens).find((s) => s.classList.contains('active'));
    return active ? active.dataset.screen : 'welcome';
  }

  function navigate(direction) {
    const idx = stepScreens.indexOf(currentScreenName());
    const next = direction === 'next' ? idx + 1 : idx - 1;
    if (next < 0 || next >= stepScreens.length) return;
    state.step = next;
    showScreen(stepScreens[next]);
    if (stepScreens[next] === 'finish') populateSummary();
  }

  // ── Validation gates before "Continue" ───────────────────────────
  function canAdvance() {
    const name = currentScreenName();
    switch (name) {
      case 'welcome':
        return true;
      case 'geminiskey':
        // Gemini is required: it powers chat, vision, AND voice
        // transcription. A key already in .env/bashrc counts.
        return !!state.geminiKey.trim() || state.geminiConfigured;
      case 'finish':
        return true;
      default:
        return true;
    }
  }

  // ── Wire up: Gemini API key ───────────────────────────────────────
  const geminiKeyInput = $('#geminiKey');
  const geminiToggleVis = $('#geminiToggleVis');
  const geminiStatus = $('#geminiStatus');

  function makeStatusSetter(pillEl) {
    return function set(state_, text) {
      pillEl.className = `status-pill ${state_}`;
      pillEl.style.display = 'inline-flex';
      const icon = pillEl.querySelector('i');
      const txt = pillEl.querySelector('.text');
      if (state_ === 'testing') {
        icon.className = 'fas fa-circle-notch fa-spin';
      } else if (state_ === 'success') {
        icon.className = 'fas fa-check-circle';
      } else if (state_ === 'error') {
        icon.className = 'fas fa-circle-xmark';
      } else {
        icon.className = 'fas fa-circle-info';
      }
      txt.textContent = text;
    };
  }

  const setGeminiStatus = makeStatusSetter(geminiStatus);

  geminiKeyInput.addEventListener('input', () => {
    state.geminiKey = geminiKeyInput.value.trim();
    if (!state.geminiKey) {
      geminiStatus.style.display = 'none';
    } else if (geminiStatus.classList.contains('success')) {
      // Keep success state
    } else {
      setGeminiStatus('idle', 'Key entered');
    }
  });

  geminiToggleVis.addEventListener('click', () => {
    const showing = geminiKeyInput.type === 'text';
    geminiKeyInput.type = showing ? 'password' : 'text';
    geminiToggleVis.innerHTML = showing
      ? '<i class="fas fa-eye"></i>'
      : '<i class="fas fa-eye-slash"></i>';
  });

  // ── Wire up: Finish screen ────────────────────────────────────────
  function populateSummary() {
    const rows = [];
    const geminiOk = !!(state.geminiKey || state.geminiConfigured);
    rows.push({
      label: '<i class="fas fa-key"></i> Google Gemini API',
      value: geminiOk ? 'Configured' : 'Missing',
      cls: geminiOk ? 'ok' : 'skip',
    });
    rows.push({
      label: '<i class="fas fa-file-lines"></i> Config saved to',
      value: '.env',
      cls: 'ok',
    });
    $('#summaryList').innerHTML = rows
      .map((r) => `
        <div class="summary-row">
          <div class="label">${r.label}</div>
          <div class="value ${r.cls}">${r.value}</div>
        </div>
      `)
      .join('');
  }

  $('#starBtn').addEventListener('click', () => {
    if (window.electronAPI && window.electronAPI.openExternal) {
      window.electronAPI.openExternal('https://github.com/devansh0703/Nyx');
    } else {
      window.open('https://github.com/devansh0703/Nyx', '_blank');
    }
  });
  $('#skipStarBtn').addEventListener('click', () => {
    // No-op — just visual closure
  });

  // ── Wire up: Hero CTA (welcome screen) ────────────────────────────
  // The big inline "Get Started" button on the welcome screen reuses
  // the existing nav-button handler so all validation, persistence,
  // and navigation logic stays in one place.
  const heroCtaBtn = $('#heroCtaBtn');
  if (heroCtaBtn) {
    heroCtaBtn.addEventListener('click', () => nextBtn.click());
  }

  // ── Wire up: nav buttons ──────────────────────────────────────────
  nextBtn.addEventListener('click', async () => {
    const name = currentScreenName();
    if (!canAdvance()) {
      // Lightly nudge the user
      if (name === 'geminiskey') setGeminiStatus('error', 'Enter a Gemini API key');
      return;
    }

    // Persist keys as they're confirmed so nothing is lost if the
    // wizard is closed partway.
    if (name === 'geminiskey' && state.geminiKey && window.electronAPI) {
      try {
        await window.electronAPI.saveSettings({ geminiKey: state.geminiKey });
      } catch (_) { /* surfaced elsewhere */ }
    }

    // Finish: close onboarding
    if (name === 'finish') {
      try {
        await window.electronAPI.completeFirstRun();
      } catch (_) { /* ignore */ }
      try {
        await window.electronAPI.closeOnboarding();
      } catch (_) { /* ignore */ }
      state.finished = true;
      return;
    }

    // Move forward
    const idx = stepScreens.indexOf(name);
    const nextName = stepScreens[idx + 1];
    if (!nextName) return;

    state.step = idx + 1;
    showScreen(nextName);
    if (nextName === 'finish') populateSummary();

    refreshStepper();
  });

  backBtn.addEventListener('click', () => {
    navigate('back');
  });

  // Skip button is unused in this flow but kept wired so the markup
  // can re-enable it without JS changes.
  skipBtn.addEventListener('click', () => { /* no-op */ });

  // ── Boot ──────────────────────────────────────────────────────────
  showScreen('welcome');

  // Pre-populate key status from existing .env/bashrc so users with a
  // partial config don't have to retype.
  if (window.electronAPI && window.electronAPI.getFirstRunStatus) {
    window.electronAPI.getFirstRunStatus().then((s) => {
      if (!s) return;
      if (s.geminiConfigured) {
        state.geminiConfigured = true;
        setGeminiStatus('success', 'Already configured — click Continue');
        geminiKeyInput.placeholder = '•••••••••••••••• (already set)';
      }
    }).catch(() => {});
  }
})();
