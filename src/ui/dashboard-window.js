// Dashboard window renderer: Activity (meeting notes), Pre-call Briefs, Modes,
// Knowledge Base. Talks to the main process exclusively through window.electronAPI.

const el = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let currentMeetingId = null;
let editingModeId = null;
let editingActionId = null;
let sessionTimerInterval = null;

function toast(msg) {
  const t = el('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

function fmtDuration(ms) {
  if (!ms && ms !== 0) return '—';
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}m ${sec.toString().padStart(2, '0')}s`;
}

function fmtWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' +
    d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ── Navigation ────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
    item.classList.add('active');
    ['activity', 'precall', 'modes', 'knowledge', 'actions', 'analytics'].forEach(v => {
      el(`#view-${v}`).classList.toggle('hidden', v !== item.dataset.view);
    });
    if (item.dataset.view === 'precall') renderPrecall();
    if (item.dataset.view === 'modes') renderModes();
    if (item.dataset.view === 'knowledge') renderKnowledge();
    if (item.dataset.view === 'actions') renderActions();
    if (item.dataset.view === 'analytics') renderAnalytics();
    if (item.dataset.view === 'activity') renderActivity();
  });
});

// ── Activity view ─────────────────────────────────────────────────────────
async function renderActivity() {
  try {
    const meetings = await window.electronAPI.listMeetings();
    const list = el('#meetingsList');
    if (!meetings.length) {
      list.innerHTML = `<div class="card muted">No sessions yet. Hit <b>Start session</b>, talk for a bit, then <b>End session</b> — notes will appear here.</div>`;
      return;
    }
    list.innerHTML = meetings.map(m => `
      <div class="meeting-item" data-id="${esc(m.id)}">
        <div class="title">${esc(m.title || 'Untitled session')}</div>
        <div class="muted">${fmtWhen(m.endedAt)} · ${fmtDuration(m.durationMs)} · ${m.transcriptEntryCount} transcript lines ${m.hasSummary ? '· <span class="badge ok">SUMMARIZED</span>' : '<span class="badge none">TRANSCRIPT ONLY</span>'}</div>
      </div>`).join('');
    list.querySelectorAll('.meeting-item').forEach(item => {
      item.addEventListener('click', () => openMeeting(item.dataset.id));
    });
  } catch (e) {
    toast('Failed to load meetings: ' + e.message);
  }
}

async function openMeeting(id) {
  try {
    const m = await window.electronAPI.getMeeting(id);
    if (!m) { toast('Meeting not found'); return; }
    currentMeetingId = id;
    const main = el('#main');
    main.innerHTML = `
      <div class="row" style="margin-bottom:14px">
        <button class="btn" id="btnBack">← Back</button>
        <div class="row" style="gap:6px">
          <button class="btn" id="btnResume">▶ Resume session</button>
          <button class="btn" id="btnCopyTranscript">⧉ Copy transcript</button>
          <button class="btn" id="btnCopyNotes">⧉ Copy notes</button>
          <button class="btn" id="btnFollowUp">✉ Follow-up email</button>
          <button class="btn" id="btnShare">🔗 Share link</button>
          <button class="btn danger" id="btnDelete">🗑 Delete</button>
        </div>
      </div>
      <h1 id="mTitle" contenteditable="true" spellcheck="false" style="outline:none">${esc(m.title || 'Untitled session')}</h1>
      <div class="subtitle">${fmtWhen(m.startedAt)} → ${fmtWhen(m.endedAt)} · ${fmtDuration(m.durationMs)}</div>
      <div class="card notes-view">
        <h3>Detailed Notes <button class="btn" id="btnEditNotes" style="float:right">✏ Edit</button></h3>
        <pre id="mNotes">${esc(m.detailedNotes || '—')}</pre>
        <textarea id="mNotesEdit" class="hidden" style="min-height:180px">${esc(m.detailedNotes || '')}</textarea>
      </div>
      <div class="card notes-view">
        <h3>Key Insights</h3>
        <pre>${esc(m.keyInsights || '—')}</pre>
      </div>
      <div class="card notes-view">
        <h3>Next Steps</h3>
        <pre>${esc(m.nextSteps || '—')}</pre>
      </div>
      <div class="card notes-view">
        <h3>Missed Opportunities <span class="badge ${m.missedOpportunities ? 'ok' : 'none'}">${m.missedOpportunities ? 'REVIEWED' : 'NOT ANALYZED'}</span></h3>
        <pre>${esc(m.missedOpportunities || 'Run coaching analysis to see what could have gone better.')}</pre>
        ${m.missedOpportunities ? '' : '<button class="btn" id="btnCoaching">🎓 Analyze missed opportunities</button>'}
      </div>
      <div class="card notes-view">
        <h3>Call Score ${typeof m.callScore === 'number' ? `<span class="badge ok">${esc(String(m.callScore))}/10</span>` : '<span class="badge none">NOT SCORED</span>'}</h3>
        ${(m.callScoreBreakdown || []).length ? `<pre>${esc(m.callScoreBreakdown.map(d => `${d.score}/10 — ${d.dimension}: ${d.note}`).join('\n'))}</pre>` : `<pre>${typeof m.callScore === 'number' ? 'Overall score (no dimension breakdown saved).' : 'AI coaching score across clarity, substance, listening and outcome. Runs on the transcript.'}</pre>`}
        <button class="btn" id="btnScoreCall">🎯 Score this call</button>
      </div>
      ${m.extraSections && Object.keys(m.extraSections).length ? Object.entries(m.extraSections).map(([t, body]) => `
      <div class="card notes-view"><h3>${esc(t)}</h3><pre>${esc(body)}</pre></div>`).join('') : ''}
      ${m.followUpEmail ? `<div class="card notes-view"><h3>Follow-up Email</h3><pre>${esc(m.followUpEmail)}</pre></div>` : ''}
      <div class="card notes-view">
        <h3>Transcript (${(m.transcript || []).length} lines)</h3>
        <pre style="max-height:260px;overflow:auto">${esc((m.transcript || []).map(t => `[${new Date(t.timestamp).toLocaleTimeString()}] ${t.text}`).join('\n') || '—')}</pre>
      </div>`;

    el('#btnBack').addEventListener('click', () => { currentMeetingId = null; restoreActivityShell(); renderActivity(); });
    // Nyx "Resume Session": reload this meeting's transcript and continue listening.
    el('#btnResume').addEventListener('click', async () => {
      try {
        const result = await window.electronAPI.resumeSession(id);
        if (result && result.ok) {
          toast('Session resumed — Live Insights is listening again');
        } else {
          toast('Resume failed: ' + ((result && result.error) || 'unknown error'));
        }
      } catch (e) {
        toast('Resume failed: ' + e.message);
      }
    });
    el('#btnCopyTranscript').addEventListener('click', () => {
      window.electronAPI.copyToClipboard((m.transcript || []).map(t => `[${t.timestamp}] ${t.text}`).join('\n'));
      toast('Transcript copied');
    });
    el('#btnCopyNotes').addEventListener('click', () => {
      window.electronAPI.copyToClipboard(`${m.title}\n\n${m.detailedNotes || ''}\n\nKey Insights:\n${m.keyInsights || ''}\n\nNext Steps:\n${m.nextSteps || ''}`);
      toast('Notes copied');
    });
    el('#btnShare').addEventListener('click', async () => {
      try {
        const result = await window.electronAPI.shareMeeting(id);
        if (result && result.url) {
          window.electronAPI.copyToClipboard(result.url);
          toast('Share link copied to clipboard');
        } else {
          toast('Share failed: ' + ((result && result.error) || 'unknown error'));
        }
      } catch (e) {
        toast('Share failed: ' + e.message);
      }
    });
    el('#btnFollowUp').addEventListener('click', async (e) => {
      e.target.disabled = true; e.target.textContent = '✉ Drafting…';
      try {
        const email = await window.electronAPI.generateFollowUpEmail(id);
        toast('Follow-up email drafted — copied to clipboard');
        window.electronAPI.copyToClipboard(email || '');
        openMeeting(id);
      } catch (err) { toast('Failed: ' + err.message); }
    });
    const coachingBtn = el('#btnCoaching');
    if (coachingBtn) coachingBtn.addEventListener('click', async () => {
      coachingBtn.disabled = true; coachingBtn.textContent = '🎓 Analyzing…';
      try { await window.electronAPI.generateMissedOpportunities(id); openMeeting(id); }
      catch (err) { toast('Failed: ' + err.message); }
    });
    const scoreBtn = el('#btnScoreCall');
    if (scoreBtn) scoreBtn.addEventListener('click', async () => {
      scoreBtn.disabled = true; scoreBtn.textContent = '🎯 Scoring…';
      try { await window.electronAPI.scoreMeeting(id); openMeeting(id); toast('Call scored'); }
      catch (err) { toast('Failed: ' + err.message); }
    });
    el('#btnDelete').addEventListener('click', async () => {
      await window.electronAPI.deleteMeeting(id);
      toast('Meeting deleted');
      currentMeetingId = null;
      restoreActivityShell();
      renderActivity();
    });
    el('#btnEditNotes').addEventListener('click', () => {
      el('#mNotes').classList.toggle('hidden');
      el('#mNotesEdit').classList.toggle('hidden');
      const btn = el('#btnEditNotes');
      if (!el('#mNotesEdit').classList.contains('hidden')) {
        btn.textContent = '💾 Save';
        el('#mNotesEdit').focus();
      } else {
        btn.textContent = '✏ Edit';
        window.electronAPI.updateMeetingNotes(id, { detailedNotes: el('#mNotesEdit').value });
        toast('Notes saved');
      }
    });
    el('#mTitle').addEventListener('blur', () => {
      window.electronAPI.updateMeetingNotes(id, { title: el('#mTitle').textContent.trim() });
    });
  } catch (e) {
    toast('Failed to open meeting: ' + e.message);
  }
}

function restoreActivityShell() {
  el('#main').innerHTML = `
    <div id="view-activity">
      <h1>Activity</h1>
      <div class="subtitle">Sessions you started and stopped become meeting notes automatically.</div>
      <div class="card">
        <div class="row">
          <div class="session-cta">
            <button class="btn primary" id="btnStart">▶ Start session</button>
            <button class="btn" id="btnStop" disabled>⏹ End session</button>
            <span id="sessionPill" class="session-pill live hidden"><span class="pulse"></span> <span id="sessionTimer">00:00</span></span>
          </div>
          <button class="btn" id="btnOpenSettings">⚙ Settings</button>
        </div>
      </div>
      <div id="meetingsList"></div>
    </div>`;
  wireSessionControls();
  renderActivity();
}

// ── Session controls ──────────────────────────────────────────────────────
function wireSessionControls() {
  const start = el('#btnStart'), stop = el('#btnStop'), pill = el('#sessionPill');
  if (!start) return;
  start.addEventListener('click', async () => {
    const st = await window.electronAPI.startSession({ audio: true });
    updateSessionUI(st);
    toast('Session started — Live Insights is listening');
  });
  stop.addEventListener('click', async () => {
    stop.disabled = true; stop.textContent = '⏹ Generating notes…';
    const notes = await window.electronAPI.stopSession();
    updateSessionUI(null);
    toast(notes ? 'Meeting notes generated ✓' : 'No active session');
    if (notes) renderActivity();
  });
}
function updateSessionUI(status) {
  const start = el('#btnStart'), stop = el('#btnStop'), pill = el('#sessionPill'), timer = el('#sessionTimer');
  if (!start) return;
  if (sessionTimerInterval) { clearInterval(sessionTimerInterval); sessionTimerInterval = null; }
  if (status && status.active) {
    start.disabled = true; stop.disabled = false;
    pill.classList.remove('hidden');
    const tick = () => {
      const s = Math.floor((Date.now() - new Date(status.startedAt).getTime()) / 1000);
      timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    tick();
    sessionTimerInterval = setInterval(tick, 1000);
  } else {
    start.disabled = false; stop.disabled = true;
    pill.classList.add('hidden');
  }
}

el('#btnOpenSettings').addEventListener('click', () => window.electronAPI.showSettings());

// ── Pre-call Briefs ───────────────────────────────────────────────────────
async function renderPrecall() {
  try {
    const sources = await window.electronAPI.listCalendarSources();
    el('#calList').innerHTML = sources.length
      ? sources.map(s => `<div class="row" style="padding:6px 0;border-bottom:1px solid var(--border)">
          <span class="muted">${esc(s.name)} <span class="badge none">${s.type}</span></span>
          <button class="btn danger" data-cal="${esc(s.id)}">Remove</button></div>`).join('')
      : '<div class="muted">No calendar sources connected.</div>';
    el('#calList').querySelectorAll('[data-cal]').forEach(b =>
      b.addEventListener('click', async () => { await window.electronAPI.removeCalendarSource(b.dataset.cal); renderPrecall(); }));

    const upcoming = await window.electronAPI.getUpcomingMeetings();
    const box = el('#meetingsUpcoming');
    if (!upcoming.length) {
      box.innerHTML = '<div class="card muted">No upcoming meetings found in the next 48h.</div>';
      return;
    }
    box.innerHTML = '';
    for (const m of upcoming) {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <div class="row">
          <div><b>${esc(m.summary)}</b><div class="muted">${fmtWhen(m.start)}${m.durationMin ? ` · ~${m.durationMin} min` : ''}${m.attendees.length ? ` · ${m.attendees.length} attendees` : ''}</div></div>
          <button class="btn primary">✨ Generate brief</button>
        </div>
        <div class="brief-out hidden" style="margin-top:10px"></div>`;
      card.querySelector('button').addEventListener('click', async (e) => {
        e.target.disabled = true; e.target.textContent = '✨ Researching…';
        const out = card.querySelector('.brief-out');
        out.classList.remove('hidden');
        try {
          const brief = await window.electronAPI.generatePreCallBrief(m);
          out.innerHTML = `<pre style="white-space:pre-wrap;font-family:inherit;margin:0;font-size:13px;line-height:1.55">${esc(brief)}</pre>`;
        } catch (err) { out.innerHTML = `<span class="muted">Failed: ${esc(err.message)}</span>`; }
      });
      box.appendChild(card);
    }
  } catch (e) {
    toast('Failed to load calendar: ' + e.message);
  }
}
el('#btnAddCal').addEventListener('click', async () => {
  try {
    await window.electronAPI.addCalendarSource({ name: el('#calName').value.trim() || 'Calendar', type: el('#calType').value, path: el('#calPath').value.trim() });
    el('#calName').value = ''; el('#calPath').value = '';
    toast('Calendar source added');
    renderPrecall();
  } catch (e) { toast('Failed: ' + e.message); }
});
el('#btnRefreshCal').addEventListener('click', async () => {
  const n = await window.electronAPI.refreshCalendars();
  toast(`Refreshed — ${n} events loaded`);
  renderPrecall();
});

// ── Modes ─────────────────────────────────────────────────────────────────
async function renderModes() {
  try {
    const modes = await window.electronAPI.listModes();
    const active = await window.electronAPI.getActiveMode();
    const box = el('#modesList');
    box.innerHTML = modes.map(m => `
      <div class="card row">
        <div>
          <b>${esc(m.name)}</b> ${m.id === active ? '<span class="badge ok">ACTIVE</span>' : ''} ${m.builtin ? '<span class="badge none">BUILT-IN</span>' : ''}
          <div class="muted">${m.promptLength} chars</div>
        </div>
        <div class="row" style="gap:6px">
          ${m.id === active ? '' : `<button class="btn" data-activate="${esc(m.id)}">Activate</button>`}
          ${m.builtin ? '' : `<button class="btn" data-edit="${esc(m.id)}">Edit</button><button class="btn danger" data-del="${esc(m.id)}">Delete</button>`}
        </div>
      </div>`).join('');

    box.querySelectorAll('[data-activate]').forEach(b => b.addEventListener('click', async () => {
      await window.electronAPI.setActiveMode(b.dataset.activate);
      toast('Mode activated — Live Insights will use it');
      renderModes();
    }));
    box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      await window.electronAPI.deleteMode(b.dataset.del); renderModes();
    }));
    box.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', async () => {
      const mode = await window.electronAPI.getMode(b.dataset.edit);
      editingModeId = mode.id;
      el('#modeFormTitle').textContent = 'Edit mode';
      el('#modeName').value = mode.name;
      el('#modePrompt').value = mode.prompt;
      el('#btnCancelModeEdit').classList.remove('hidden');
    }));
  } catch (e) { toast('Failed to load modes: ' + e.message); }
}

el('#btnSaveMode').addEventListener('click', async () => {
  try {
    await window.electronAPI.upsertMode({ id: editingModeId, name: el('#modeName').value.trim(), prompt: el('#modePrompt').value });
    editingModeId = null;
    el('#modeFormTitle').textContent = 'New mode';
    el('#modeName').value = ''; el('#modePrompt').value = '';
    el('#btnCancelModeEdit').classList.add('hidden');
    toast('Mode saved');
    renderModes();
  } catch (e) { toast('Failed: ' + e.message); }
});
el('#btnCancelModeEdit').addEventListener('click', () => {
  editingModeId = null;
  el('#modeFormTitle').textContent = 'New mode';
  el('#modeName').value = ''; el('#modePrompt').value = '';
  el('#btnCancelModeEdit').classList.add('hidden');
});

// ── Knowledge Base ────────────────────────────────────────────────────────
async function renderKnowledge() {
  try {
    const entries = await window.electronAPI.listKnowledge();
    el('#kbList').innerHTML = entries.length
      ? entries.map(k => `<div class="card row">
          <div><b>${esc(k.title)}</b><div class="muted">${k.contentLength} chars · added ${fmtWhen(k.createdAt)}</div></div>
          <button class="btn danger" data-kb="${esc(k.id)}">Delete</button></div>`).join('')
      : '<div class="card muted">Nothing here yet. Add company info, product docs, pricing rules — the assistant pulls them in when relevant.</div>';
    el('#kbList').querySelectorAll('[data-kb]').forEach(b => b.addEventListener('click', async () => {
      await window.electronAPI.deleteKnowledge(b.dataset.kb); renderKnowledge();
    }));
  } catch (e) { toast('Failed to load knowledge: ' + e.message); }
}
el('#btnAddKb').addEventListener('click', async () => {
  try {
    await window.electronAPI.addKnowledge(el('#kbTitle').value.trim(), el('#kbContent').value);
    el('#kbTitle').value = ''; el('#kbContent').value = '';
    toast('Knowledge added');
    renderKnowledge();
  } catch (e) { toast('Failed: ' + e.message); }
});
el('#btnFetchKb').addEventListener('click', async () => {
  const btn = el('#btnFetchKb');
  const url = el('#kbUrl').value.trim();
  if (!url) { toast('Paste a URL first'); return; }
  btn.disabled = true; btn.textContent = '🌐 Fetching…';
  try {
    const result = await window.electronAPI.addKnowledgeFromUrl(el('#kbTitle').value.trim(), url);
    if (result && result.error) { toast('Fetch failed: ' + result.error); }
    else { toast('Knowledge added from URL'); el('#kbTitle').value = ''; el('#kbUrl').value = ''; renderKnowledge(); }
  } catch (e) { toast('Fetch failed: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '🌐 Fetch from URL'; }
});

// ── Custom actions (Nyx: prompt + link buttons in Live Insights) ──────────
async function renderActions() {
  try {
    const actions = await window.electronAPI.listCustomActions();
    const box = el('#actionsList');
    box.innerHTML = actions.length
      ? actions.map(a => `<div class="card row">
          <div>
            <b>${esc(a.label)}</b> <span class="badge none">${esc(a.type)}</span> ${a.enabled ? '' : '<span class="badge none">DISABLED</span>'}
            <div class="muted">${a.type === 'prompt' ? `${a.promptLength} chars` : esc(a.url)}</div>
          </div>
          <div class="row" style="gap:6px">
            <button class="btn" data-toggle="${esc(a.id)}" data-enabled="${a.enabled ? '1' : '0'}">${a.enabled ? 'Disable' : 'Enable'}</button>
            ${a.type === 'prompt' ? `<button class="btn" data-edit="${esc(a.id)}">Edit</button>` : ''}
            <button class="btn danger" data-del="${esc(a.id)}">Delete</button>
          </div>
        </div>`).join('')
      : '<div class="card muted">No custom actions yet. Create prompt buttons (e.g. "Check against pricing policy") or link buttons (e.g. open your CRM).</div>';
    box.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
      await window.electronAPI.updateCustomAction(b.dataset.toggle, { enabled: b.dataset.enabled !== '1' });
      renderActions();
    }));
    box.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', async () => {
      await window.electronAPI.deleteCustomAction(b.dataset.del); renderActions();
    }));
    box.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', async () => {
      const a = await window.electronAPI.getCustomAction(b.dataset.edit);
      if (!a) return;
      editingActionId = a.id;
      el('#actionFormTitle').textContent = 'Edit action';
      el('#actionLabel').value = a.label;
      el('#actionType').value = a.type;
      el('#actionPrompt').value = a.prompt || '';
      el('#actionUrl').value = a.url || '';
      el('#actionPromptWrap').classList.toggle('hidden', a.type !== 'prompt');
      el('#actionUrlWrap').classList.toggle('hidden', a.type !== 'link');
      el('#btnCancelActionEdit').classList.remove('hidden');
    }));
  } catch (e) { toast('Failed to load actions: ' + e.message); }
}

el('#actionType').addEventListener('change', () => {
  const isPrompt = el('#actionType').value === 'prompt';
  el('#actionPromptWrap').classList.toggle('hidden', !isPrompt);
  el('#actionUrlWrap').classList.toggle('hidden', isPrompt);
});

el('#btnSaveAction').addEventListener('click', async () => {
  const label = el('#actionLabel').value.trim();
  const type = el('#actionType').value;
  try {
    if (editingActionId) {
      await window.electronAPI.updateCustomAction(editingActionId, { label, prompt: el('#actionPrompt').value, url: el('#actionUrl').value.trim() });
    } else {
      await window.electronAPI.addCustomAction({ label, type, prompt: el('#actionPrompt').value, url: el('#actionUrl').value.trim() });
    }
    editingActionId = null;
    el('#actionFormTitle').textContent = 'New action';
    el('#actionLabel').value = ''; el('#actionPrompt').value = ''; el('#actionUrl').value = '';
    el('#btnCancelActionEdit').classList.add('hidden');
    toast('Action saved — it now appears in Live Insights');
    renderActions();
  } catch (e) { toast('Failed: ' + e.message); }
});
el('#btnCancelActionEdit').addEventListener('click', () => {
  editingActionId = null;
  el('#actionFormTitle').textContent = 'New action';
  el('#actionLabel').value = ''; el('#actionPrompt').value = ''; el('#actionUrl').value = '';
  el('#btnCancelActionEdit').classList.add('hidden');
});

// ── Analytics (Nyx: call coaching scores + grouped analytics) ─────────────
async function renderAnalytics() {
  try {
    const a = await window.electronAPI.getAnalyticsSummary();
    const cards = el('#analyticsCards');
    cards.innerHTML = `
      <div class="card" style="flex:1;margin:0"><div class="muted">Sessions</div><div style="font-size:26px;font-weight:700">${a.meetingCount}</div></div>
      <div class="card" style="flex:1;margin:0"><div class="muted">Avg score</div><div style="font-size:26px;font-weight:700">${a.avgScore != null ? a.avgScore.toFixed(1) : '—'}<span class="muted" style="font-size:13px">/10</span></div></div>
      <div class="card" style="flex:1;margin:0"><div class="muted">Best</div><div style="font-size:26px;font-weight:700">${a.bestScore != null ? a.bestScore : '—'}</div></div>
      <div class="card" style="flex:1;margin:0"><div class="muted">Talk time</div><div style="font-size:26px;font-weight:700">${fmtDuration(a.totalMs)}</div></div>
      <div class="card" style="flex:1;margin:0"><div class="muted">Transcript lines</div><div style="font-size:26px;font-weight:700">${a.totalTranscriptLines}</div></div>`;
    el('#dimensionBars').innerHTML = (a.dimensions || []).length
      ? a.dimensions.map(d => `
          <div style="margin-bottom:10px">
            <div class="row" style="margin-bottom:4px"><span style="font-size:12px">${esc(d.dimension)}</span><span class="muted">${d.avg.toFixed(1)}/10 · ${d.samples} call${d.samples === 1 ? '' : 's'}</span></div>
            <div style="height:8px;background:var(--panel2);border-radius:4px;overflow:hidden">
              <div style="height:100%;width:${(d.avg * 10).toFixed(0)}%;background:linear-gradient(90deg,var(--accent),var(--accent2))"></div>
            </div>
          </div>`).join('')
      : '<div class="muted">No scored calls yet. Open a session in Activity and hit 🎯 Score this call.</div>';
    el('#recentScores').innerHTML = (a.recent || []).length
      ? a.recent.map(r => `<div class="row" style="padding:8px 0;border-bottom:1px solid var(--border)">
          <div><b style="font-size:13px">${esc(r.title || 'Untitled')}</b><div class="muted">scored ${fmtWhen(r.scoredAt)}</div></div>
          <div style="font-weight:700;color:${r.score >= 7 ? 'var(--good)' : r.score >= 5 ? 'var(--warn)' : 'var(--bad)'}">${r.score}/10</div>
        </div>`).join('')
      : '<div class="muted">Nothing scored yet.</div>';
  } catch (e) { toast('Failed to load analytics: ' + e.message); }
}

// ── Notes template editor (Nyx: custom meeting notes templates) ──────────
async function loadNotesTemplate() {
  try { el('#notesTemplate').value = await window.electronAPI.getNotesTemplate(); } catch (_) { /* ignore */ }
}
el('#btnSaveTemplate').addEventListener('click', async () => {
  try {
    const result = await window.electronAPI.setNotesTemplate(el('#notesTemplate').value);
    if (result && result.success === false) { toast('Failed: ' + (result.error || 'template rejected')); return; }
    toast('Notes template saved');
  } catch (e) { toast('Failed: ' + e.message); }
});
el('#btnResetTemplate').addEventListener('click', async () => {
  await window.electronAPI.resetNotesTemplate();
  await loadNotesTemplate();
  toast('Template reset to default');
});

// ── Meeting alert banner (Nyx parity) ─────────────────────────────────
window.electronAPI.onMeetingStarting((meeting) => {
  try {
    el('#meetingAlertTitle').textContent = meeting && meeting.summary
      ? `${meeting.summary} — ${new Date(meeting.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : 'Your meeting is starting.';
    el('#meetingAlert').style.display = 'block';
    setTimeout(() => { el('#meetingAlert').style.display = 'none'; }, 120000); // auto-hide after 2 min
  } catch (_) { /* ignore */ }
});
el('#btnAlertJoin').addEventListener('click', async () => {
  el('#meetingAlert').style.display = 'none';
  try { await window.electronAPI.joinMeetingAlert(); } catch (_) { /* ignore */ }
});
el('#btnAlertDismiss').addEventListener('click', async () => {
  el('#meetingAlert').style.display = 'none';
  try { await window.electronAPI.dismissMeetingAlert(); } catch (_) { /* ignore */ }
});

// ── Init ──────────────────────────────────────────────────────────────────
(async function init() {
  wireSessionControls();
  loadNotesTemplate();
  try {
    const st = await window.electronAPI.getSessionStatus();
    updateSessionUI(st.active ? st : null);
  } catch (_) { /* ignore */ }
  renderActivity();
  window.electronAPI.onSessionStatusChanged((status) => updateSessionUI(status && status.active ? status : null));
})();
