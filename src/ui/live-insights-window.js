// Live Insights overlay renderer — Nyx-style live assistance card.
// Streams AI answers, shows transcript, runs default actions and dynamic
// insights, hosts the mode dropdown and ask bar.

const el = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let showTranscript = false;
let smartMode = false;
let currentActionAbort = null;

// Minimal markdown → HTML (bold, code, fences, bullets) for streamed answers
function mdToHtml(md) {
  let html = esc(md);
  html = html.replace(/```([\s\S]*?)```/g, (_, code) => `<pre><code>${code.replace(/^\w*\n/, '')}</code></pre>`);
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  html = html.replace(/^(\s*)[-•] (.*)$/gm, '$1• $2');
  return html.replace(/\n/g, '<br>');
}

function setContent(html, { append = false, placeholder = null } = {}) {
  const box = el('#contentBox');
  if (placeholder) { box.innerHTML = `<div class="placeholder">${esc(placeholder)}</div>`; return; }
  if (!append) box.innerHTML = '';
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

async function refreshModeSelect() {
  try {
    const modes = await window.electronAPI.listModes();
    const active = await window.electronAPI.getActiveMode();
    el('#modeSelect').innerHTML = modes.map(m => `<option value="${esc(m.id)}" ${m.id === active ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
  } catch (_) { /* ignore */ }
}

el('#modeSelect').addEventListener('change', async (e) => {
  await window.electronAPI.setActiveMode(e.target.value);
});

// ── Session controls ──────────────────────────────────────────────────────
function paintSession(status) {
  const btnEnd = el('#btnEnd'), btnStartStop = el('#btnStartStop'), btnAudio = el('#btnAudio'), btnSmart = el('#btnSmart');
  if (status && status.active) {
    btnEnd.textContent = `⏹ End (${fmtElapsed(status.elapsedMs)})`;
    btnEnd.classList.remove('idle');
    btnStartStop.textContent = '⏹ End';
    btnAudio.classList.toggle('on', status.audioEnabled);
  } else {
    btnEnd.textContent = '▶ Start Session';
    btnEnd.classList.add('idle');
    btnStartStop.textContent = '● Start';
    btnAudio.classList.remove('on');
  }
  // Smart Mode lightning toggle (Nyx parity)
  smartMode = !!(status && status.smartMode);
  if (btnSmart) btnSmart.classList.toggle('on', smartMode);
}
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

async function toggleSession() {
  const st = await window.electronAPI.getSessionStatus();
  if (st.active) {
    el('#btnEnd').textContent = '⏹ Saving notes…';
    await window.electronAPI.stopSession();
    setContent(null, { placeholder: 'Session ended — notes saved to Dashboard → Activity.' });
  } else {
    await window.electronAPI.startSession({ audio: true });
    setContent(null, { placeholder: 'Listening… speak and the AI will surface insights. Ask anything below.' });
  }
}

el('#btnEnd').addEventListener('click', toggleSession);
el('#btnStartStop').addEventListener('click', toggleSession);
el('#btnAudio').addEventListener('click', async () => {
  await window.electronAPI.toggleSessionAudio();
});
el('#btnHide').addEventListener('click', () => window.electronAPI.closeWindow());

// ── System-audio parser (Nyx parity: hear the other party) ────────────
// Captures system/loopback audio via getDisplayMedia({audio:true}) and streams
// 16kHz mono PCM chunks to main, which runs a VAD pass and Gemini
// tags the transcript speaker='other'.
let systemStream = null;
let systemCtx = null;

async function stopSystemAudioCapture() {
  if (systemStream) {
    systemStream.getTracks().forEach(t => { try { t.stop(); } catch (_) {} });
    systemStream = null;
  }
  if (systemCtx) {
    try { await systemCtx.close(); } catch (_) { /* ignore */ }
    systemCtx = null;
  }
  el('#btnSystemAudio').classList.remove('on');
}

async function startSystemAudioCapture() {
  try {
    systemStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: { ideal: 16000 },
      },
    });
    // Video track is required by the picker; we drop it immediately.
    systemStream.getVideoTracks().forEach(t => { try { t.stop(); } catch (_) {} });

    const audioTracks = systemStream.getAudioTracks();
    if (!audioTracks.length) {
      setContent(null, { placeholder: 'No system audio available. On Linux/macOS share a tab with “Share tab audio”, or use a loopback device.' });
      await stopSystemAudioCapture();
      return;
    }

    systemCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const source = systemCtx.createMediaStreamSource(new MediaStream(audioTracks));
    const node = systemCtx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (event) => {
      if (!systemStream) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(input.length);
      for (let i = 0; i < input.length; i++) {
        const s = Math.max(-1, Math.min(1, input[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      window.electronAPI.sendSystemAudioChunk(pcm16.buffer);
    };
    source.connect(node);
    node.connect(systemCtx.destination);

    el('#btnSystemAudio').classList.add('on');
    setContent(null, { placeholder: '📢 Listening to the other party. Their words join the transcript.' });
  } catch (e) {
    setContent(null, { placeholder: 'System audio unavailable: ' + e.message });
    await stopSystemAudioCapture();
  }
}

el('#btnSystemAudio').addEventListener('click', async () => {
  if (systemStream) {
    await stopSystemAudioCapture();
  } else {
    const enabled = await window.electronAPI.toggleSystemAudio();
    if (enabled) {
      await startSystemAudioCapture();
    } else {
      await stopSystemAudioCapture();
    }
  }
});

// ── Smart Mode (Nyx lightning toggle) ──────────────────────────────────
el('#btnSmart').addEventListener('click', async () => {
  const status = await window.electronAPI.setSessionSmartMode(!smartMode);
  smartMode = !!status;
  el('#btnSmart').classList.toggle('on', smartMode);
  setContent(null, { placeholder: smartMode
    ? '⚡ Smart Mode ON — coding assistance enabled. Ask anything or run an action.'
    : 'Smart Mode OFF — meeting assistant mode.' });
});

// Timer refresh while live
setInterval(async () => {
  try {
    const st = await window.electronAPI.getSessionStatus();
    if (st.active) paintSession(st);
  } catch (_) { /* ignore */ }
}, 1000);

// ── Transcript toggle ─────────────────────────────────────────────────────
el('#transcriptToggle').addEventListener('click', async () => {
  showTranscript = !showTranscript;
  el('#transcriptSwitch').classList.toggle('on', showTranscript);
  if (showTranscript) {
    const t = await window.electronAPI.getLiveTranscript();
    setContent(t.split('\n').map(l => `<div class="transcript-line"><span class="ts">${esc(l.slice(1, 9))}</span>${esc(l.slice(11))}</div>`).join('') || '<div class="placeholder">Nothing said yet.</div>');
  } else {
    setContent(null, { placeholder: 'Live insights will appear here.' });
  }
});

window.electronAPI.onTranscriptEntry((entry) => {
  if (!showTranscript) return;
  const box = el('#contentBox');
  const ph = box.querySelector('.placeholder');
  if (ph) ph.remove();
  box.insertAdjacentHTML('beforeend', `<div class="transcript-line"><span class="ts">${esc(new Date(entry.timestamp).toLocaleTimeString().slice(0, 8))}</span>${esc(entry.text)}</div>`);
  box.scrollTop = box.scrollHeight;
});

// ── Default actions ───────────────────────────────────────────────────────
document.querySelectorAll('.action-chip').forEach(chip => {
  chip.addEventListener('click', () => runAction(chip));
});

async function runAction(chip) {
  const action = chip.dataset.action;
  chip.classList.add('busy');
  setContent('<span class="spinner"></span> <span style="color:var(--muted)">Thinking…</span>');
  try {
    let full = '';
    await window.electronAPI.runLiveAction(action, (delta) => {
      full += delta;
      setContent(mdToHtml(full));
    });
    if (!full) setContent(null, { placeholder: 'Nothing has been said yet in this session.' });
  } catch (e) {
    setContent(null, { placeholder: 'Action failed: ' + e.message });
  } finally {
    chip.classList.remove('busy');
  }
}

// ── Custom actions (Nyx: user-defined prompt + link chips) ────────────────
let customActions = [];

async function refreshCustomActions() {
  try { customActions = (await window.electronAPI.listCustomActions()) || []; } catch (_) { customActions = []; }
  renderCustomChips();
}

function renderCustomChips() {
  const row = el('#customActionsRow');
  if (!row) return;
  const enabled = customActions.filter(a => a.enabled !== false);
  row.innerHTML = enabled.map(a =>
    a.type === 'link'
      ? `<span class="action-chip" data-custom-id="${esc(a.id)}" title="${esc(a.url)}">🔗 ${esc(a.label)}</span>`
      : `<span class="action-chip" data-custom-id="${esc(a.id)}" title="Custom prompt action">✨ ${esc(a.label)}</span>`
  ).join('');
  row.querySelectorAll('.action-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      const action = customActions.find(a => a.id === chip.dataset.customId);
      if (!action) return;
      if (action.type === 'link') { window.electronAPI.openExternal(action.url); return; }
      runCustomAction(action);
    });
  });
}

async function runCustomAction(action) {
  setContent('<span class="spinner"></span> <span style="color:var(--muted)">Thinking…</span>');
  try {
    let full = '';
    await window.electronAPI.runLiveAction(`custom-${action.id}`, (delta) => {
      full += delta;
      setContent(mdToHtml(full));
    });
    if (!full) setContent(null, { placeholder: 'Nothing has been said yet in this session.' });
  } catch (e) {
    setContent(null, { placeholder: 'Action failed: ' + e.message });
  }
}

// ── Dynamic insights ──────────────────────────────────────────────────────
window.electronAPI.onDynamicInsights((insights) => {
  const row = el('#dynamicRow'), hint = el('#dynHint');
  if (!insights || !insights.length) { row.classList.add('hidden'); hint.classList.add('hidden'); return; }
  row.classList.remove('hidden'); hint.classList.remove('hidden');
  row.innerHTML = insights.map(i => `<span class="dyn-chip" title="${esc(i.label)}">${esc(i.label)}</span>`).join('');
  row.querySelectorAll('.dyn-chip').forEach((chip, idx) => {
    chip.addEventListener('click', () => answerDynamic(chip.textContent));
  });
});

async function answerDynamic(label) {
  setContent('<span class="spinner"></span> <span style="color:var(--muted)">Thinking…</span>');
  try {
    let full = '';
    await window.electronAPI.askLive(label, (delta) => { full += delta; setContent(mdToHtml(full)); });
  } catch (e) { setContent(null, { placeholder: 'Failed: ' + e.message }); }
}

// Tab answers the first dynamic insight
window.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    const first = document.querySelector('.dyn-chip');
    if (first) {
      e.preventDefault();
      answerDynamic(first.textContent);
    }
  }
});

// ── Ask bar (Ctrl+Enter handled globally in main) ─────────────────────────
async function ask(question) {
  if (!question.trim()) return;
  setContent('<span class="spinner"></span> <span style="color:var(--muted)">Thinking…</span>');
  try {
    let full = '';
    await window.electronAPI.askLive(question, (delta) => { full += delta; setContent(mdToHtml(full)); });
  } catch (e) { setContent(null, { placeholder: 'Failed: ' + e.message }); }
}

el('#btnAsk').addEventListener('click', () => { ask(el('#askInput').value); el('#askInput').value = ''; });
el('#askInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    ask(el('#askInput').value);
    el('#askInput').value = '';
  }
});

// Screen assist (Ctrl+Enter): analyze the screen with the active skill
window.electronAPI.onScreenAssist(() => {
  setContent('<span class="spinner"></span> <span style="color:var(--muted)">Reading your screen…</span>');
});

// Stealth answer (Ctrl+Shift+Enter) streams into the plain llm-response window
window.electronAPI.onLiveActionResult((result) => {
  if (result && result.error) setContent(null, { placeholder: result.error });
});

// ── Init ──────────────────────────────────────────────────────────────────
(async function init() {
  await refreshModeSelect();
  refreshCustomActions();
  window.electronAPI.onCustomActionsChanged(() => refreshCustomActions());
  try {
    const st = await window.electronAPI.getSessionStatus();
    paintSession(st);
    if (st.active) setContent(null, { placeholder: 'Listening… speak and the AI will surface insights.' });
  } catch (_) { /* ignore */ }
  window.electronAPI.onSessionStatusChanged((status) => paintSession(status || {}));
  window.electronAPI.onModeChanged(() => refreshModeSelect());
})();
