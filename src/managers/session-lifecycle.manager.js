// Session lifecycle manager — the backbone of Live Insights / Meeting Notes.
//
// Implements Nyx's Listen-mode model:
//   • start → listening (transcript accumulates) → stop → summary generated
//   • transcript entries persisted to userData so notes survive restarts
//   • default actions (What should I say next / Follow up questions / Fact check /
//     Who am I talking to / Recap) run against the live transcript
//   • dynamic insights: questions/keywords detected from the transcript surface
//     as clickable chips
//   • ending a session auto-generates meeting notes: detailed notes, key
//     insights, next steps, and a draft follow-up email (Nyx "Instant Follow
//     Up Actions"), plus missed-opportunities coaching when enabled.
//   • custom live actions (Nyx parity with Cluely "Custom Live Actions"):
//     user-defined prompt buttons (run against the live transcript) and link
//     buttons (open a URL), rendered in Live Insights.
//   • custom notes template (Nyx parity with Cluely "custom meeting notes
//     templates"): the notes-generation prompt is user-editable; unknown
//     markdown sections land in notes.extraSections.
//   • call score + analytics (Nyx parity with Cluely "Call Coaching &
//     Analytics"): per-meeting 1-10 score with dimension breakdown, plus an
//     aggregate summary across all meetings.

const fs = require('fs');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('SESSION-LIFECYCLE');

const DEFAULT_ACTIONS = [
  { id: 'say-next', label: 'What should I say next', icon: 'fa-comment-dots' },
  { id: 'follow-ups', label: 'Follow up questions', icon: 'fa-question' },
  { id: 'fact-check', label: 'Fact check', icon: 'fa-circle-check' },
  { id: 'who-am-i-talking-to', label: 'Who am I talking to', icon: 'fa-user' },
  { id: 'recap', label: 'Recap', icon: 'fa-list-check' },
];

const ACTION_PROMPTS = {
  'say-next': 'You are helping someone during a live meeting. Based on the transcript, tell them exactly what to say next — a short, natural, confident spoken response (2-4 sentences). Output only the words to say.',
  'follow-ups': 'Based on the transcript, list 4-6 smart follow-up questions the user could ask next. Number them. Keep each under 20 words.',
  'fact-check': 'Identify any factual claims in the transcript that may be wrong, outdated, or need verification. For each: the claim, why it may be wrong, and the correction. If everything seems fine, say "No obvious factual issues detected."',
  'who-am-i-talking-to': 'Based on the transcript, infer who the user is talking to: their likely role, seniority, priorities, and what they care about. Be concise (max 6 bullets).',
  recap: 'Summarize the transcript so far in 5-8 concise bullets covering what was discussed, decisions made, and open items.',
  'missed-opportunities': 'You are a call coach. Review the transcript and identify missed opportunities: moments where the user could have answered better, asked a smarter question, or advanced the conversation. For each: what happened, what they missed, and exactly what to do better next time. End with 1-3 overall improvement tips.',
  'follow-up-email': 'Based on the meeting transcript, draft a concise professional follow-up email. Include: subject line, warm opener, 3-5 bullet recap of key points discussed, clearly numbered action items with owners, and a friendly close. Sign as "[Your name]".',
  'meeting-notes': 'Generate structured meeting notes from this transcript using EXACTLY these markdown sections:\n## Detailed Notes\n(bulleted summary of key discussion points)\n\n## Key Insights\n(3-6 important takeaways and decisions)\n\n## Next Steps\n(numbered actionable follow-up items)\n\n## Missed Opportunities\n(moments that could have gone better, with what to do instead; write "None detected" if the call went well)',
  // Smart Mode (Nyx lightning toggle): coding/interview assistance overrides
  'smart-say-next': 'You are an elite competitive programmer in a live technical interview. Based on the transcript and screen context, tell the user exactly what to do or say next — which approach/algorithm to pick, or the exact words to say. Be direct and technical (2-5 sentences).',
  'smart-follow-ups': 'Based on the transcript, list 4-6 technical follow-up questions likely to come next in this interview (complexity analysis, edge cases, optimizations). Number them. Keep each under 20 words.',
  'smart-recap': 'Summarize the technical session so far in 5-8 concise bullets: problems attempted, approaches discussed, complexity agreed, bugs found, open items.',
};

// Default meeting-notes template (Nyx custom notes templates). Users can
// replace every line of this prompt in Dashboard → Activity → Notes template.
const DEFAULT_NOTES_TEMPLATE = 'Generate structured meeting notes from this transcript using EXACTLY these markdown sections:\n## Detailed Notes\n(bulleted summary of key discussion points)\n\n## Key Insights\n(3-6 important takeaways and decisions)\n\n## Next Steps\n(numbered actionable follow-up items)\n\n## Missed Opportunities\n(moments that could have gone better, with what to do instead; write "None detected" if the call went well)';

// Call-score prompt (Nyx call coaching): strict JSON so results are
// machine-readable and aggregatable across meetings.
const CALL_SCORE_PROMPT = 'You are a strict call coach. Score this call from 1 to 10 based ONLY on the transcript. Return EXACTLY this JSON, no prose before or after:\n{"overall": <1-10 integer>, "breakdown": [{"dimension": "<name>", "score": <1-10>, "note": "<one sentence>"}]}\nUse 5-7 dimensions relevant to the call (e.g. clarity, substance, listening, outcome progression, rapport). Lower scores must reflect real problems.';

class SessionLifecycleManager {
  constructor() {
    this.active = false;
    this.smartMode = false; // Nyx Smart Mode: coding-assistance prompt overrides
    this.audioEnabled = false;
    this.startedAt = null;
    this.transcript = [];
    this.sessionId = null;
    this.title = null;
    this._lastInsightCount = 0;
    this._autoAttend = null; // { title, start, end } when auto-started from calendar
    this.customActions = []; // Nyx custom live actions (prompt + link buttons)
    this.dataDir = null;
    this.events = new (require('events').EventEmitter)();
  }

  setDataDir(dir) {
    this.dataDir = dir;
    try {
      fs.mkdirSync(path.join(dir, 'meetings'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'transcripts'), { recursive: true });
    } catch (e) {
      logger.warn('Could not create meetings data dirs', { error: e.message });
    }
    this._loadCustomActions();
  }

  // ── Custom live actions (Nyx: prompts + links as one-click chips) ─────

  _customActionsPath() { return path.join(this.dataDir, 'custom-actions.json'); }

  _loadCustomActions() {
    try {
      const stored = JSON.parse(fs.readFileSync(this._customActionsPath(), 'utf8'));
      this.customActions = Array.isArray(stored.actions) ? stored.actions : [];
    } catch (_) {
      this.customActions = [];
    }
  }

  _persistCustomActions() {
    if (!this.dataDir) return;
    try {
      fs.writeFileSync(this._customActionsPath(), JSON.stringify({ actions: this.customActions }, null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to persist custom actions', { error: e.message });
    }
  }

  listCustomActions() {
    return this.customActions.map(a => ({
      id: a.id,
      label: a.label,
      type: a.type,
      url: a.type === 'link' ? a.url : undefined,
      promptLength: a.type === 'prompt' ? (a.prompt || '').length : undefined,
      enabled: a.enabled !== false,
    }));
  }

  /** Full record (including the prompt body) for edit forms. */
  getCustomAction(id) {
    return this.customActions.find(a => a.id === id) || null;
  }

  addCustomAction({ label, type = 'prompt', prompt = '', url = '', enabled = true } = {}) {
    if (!label || typeof label !== 'string') throw new Error('Custom action needs a label');
    if (!['prompt', 'link'].includes(type)) throw new Error('Custom action type must be prompt or link');
    if (type === 'prompt' && !String(prompt).trim()) throw new Error('Prompt actions need a prompt');
    if (type === 'link') {
      if (!/^https?:\/\//i.test(String(url))) throw new Error('Link actions need an http(s) URL');
    }
    const action = {
      id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: String(label).slice(0, 60),
      type,
      prompt: type === 'prompt' ? String(prompt).slice(0, 8000) : undefined,
      url: type === 'link' ? String(url).trim() : undefined,
      enabled: enabled !== false,
    };
    this.customActions.push(action);
    this._persistCustomActions();
    logger.info('Custom action added', { id: action.id, label: action.label, type });
    return action;
  }

  updateCustomAction(id, patch = {}) {
    const action = this.customActions.find(a => a.id === id);
    if (!action) return null;
    if (typeof patch.label === 'string' && patch.label.trim()) action.label = patch.label.trim().slice(0, 60);
    if (typeof patch.prompt === 'string' && action.type === 'prompt') action.prompt = patch.prompt.slice(0, 8000);
    if (typeof patch.url === 'string' && action.type === 'link') {
      if (!/^https?:\/\//i.test(patch.url.trim())) throw new Error('Link actions need an http(s) URL');
      action.url = patch.url.trim();
    }
    if (typeof patch.enabled === 'boolean') action.enabled = patch.enabled;
    this._persistCustomActions();
    return action;
  }

  deleteCustomAction(id) {
    const before = this.customActions.length;
    this.customActions = this.customActions.filter(a => a.id !== id);
    this._persistCustomActions();
    return this.customActions.length < before;
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  start({ title = null, audio = true } = {}) {
    if (this.active) return this.getStatus();
    this.active = true;
    this.audioEnabled = !!audio;
    this.startedAt = Date.now();
    this.transcript = [];
    this.title = title;
    this.sessionId = `sess-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    logger.info('Session started', { sessionId: this.sessionId, audio: this.audioEnabled });
    this.events.emit('session-started', this.getStatus());
    return this.getStatus();
  }

  stop() {
    if (!this.active) return null;
    const status = this.getStatus();
    this.active = false;
    logger.info('Session stopping', { sessionId: this.sessionId, transcriptEntries: this.transcript.length });
    this.events.emit('session-stopping', status);
    return status;
  }

  /**
   * Nyx "Resume Session": continue a previously saved meeting — reloads its
   * transcript into the live session (keeping the same meeting id so notes and
   * context accumulate in one place) and marks the session active again.
   */
  resume(meetingId) {
    const meeting = this.getMeeting(meetingId);
    if (!meeting) return { ok: false, error: `Meeting not found: ${meetingId}` };
    this.active = true;
    this.audioEnabled = true;
    this.sessionId = meeting.id;
    this.title = meeting.title || this.title;
    this.startedAt = meeting.startedAt ? new Date(meeting.startedAt).getTime() : Date.now();
    this.transcript = Array.isArray(meeting.transcript) ? [...meeting.transcript] : [];
    this._lastInsightCount = 0;
    logger.info('Session resumed', { sessionId: this.sessionId, transcriptEntries: this.transcript.length });
    this.events.emit('session-started', this.getStatus());
    return { ok: true, status: this.getStatus() };
  }

  isActive() {
    return this.active;
  }

  // ── Smart Mode (Nyx lightning toggle) ─────────────────────────────────

  setSmartMode(enabled) {
    this.smartMode = !!enabled;
    logger.info('Smart mode changed', { smartMode: this.smartMode });
    this.events.emit('smart-mode-changed', { smartMode: this.smartMode });
    return this.smartMode;
  }

  getSmartMode() {
    return this.smartMode;
  }

  getStatus() {
    return {
      active: this.active,
      audioEnabled: this.audioEnabled,
      smartMode: this.smartMode,
      startedAt: this.startedAt,
      elapsedMs: this.active && this.startedAt ? Date.now() - this.startedAt : 0,
      transcriptCount: this.transcript.length,
      sessionId: this.sessionId,
      title: this.title,
      autoAttending: this._autoAttend ? this._autoAttend.title : null,
    };
  }

  // ── Meeting alerts / auto-attend (Nyx: auto start-end at meeting edges) ─

  /**
   * Called by the main-process scheduler when a calendar meeting is starting.
   * Starts a listening session titled after the meeting (never interrupts an
   * already-active session, and ignores back-to-back repeats of the same one).
   */
  autoAttendMeeting(meeting) {
    if (this.active || !meeting) return null;
    this._autoAttend = { title: meeting.summary, start: meeting.start, end: meeting.end };
    const status = this.start({ title: meeting.summary, audio: true });
    logger.info('Auto-attended meeting from calendar', { title: meeting.summary, start: meeting.start });
    return status;
  }

  /**
   * Called by the scheduler when the auto-attended meeting ends (per calendar).
   * Stops the session; note generation is the caller's job.
   */
  autoAttendEnd() {
    if (!this._autoAttend || !this.active) return null;
    this._autoAttend = null;
    const status = this.stop();
    logger.info('Auto-attend ended (calendar meeting over)');
    return status;
  }

  isAutoAttending() {
    return !!this._autoAttend;
  }

  /** Calendar start (ISO string) of the auto-attended meeting, or null. */
  getAutoAttendStart() {
    return this._autoAttend ? this._autoAttend.start : null;
  }

  toggleAudio(enabled = null) {
    this.audioEnabled = typeof enabled === 'boolean' ? enabled : !this.audioEnabled;
    logger.info('Session audio toggled', { audioEnabled: this.audioEnabled });
    this.events.emit('audio-toggled', { audioEnabled: this.audioEnabled });
    return this.audioEnabled;
  }

  // ── Transcript ───────────────────────────────────────────────────────────

  addTranscriptEntry(text, { source = 'speech', speaker = 'user' } = {}) {
    if (!this.active || !text || !text.trim()) return null;
    const entry = {
      id: `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      offsetMs: Date.now() - this.startedAt,
      source,
      speaker,
      text: text.trim(),
    };
    this.transcript.push(entry);
    this.events.emit('transcript-entry', entry);
    return entry;
  }

  getTranscriptText(maxChars = 24000) {
    const text = this.transcript
      .map(e => `[${new Date(e.timestamp).toLocaleTimeString()}] ${e.text}`)
      .join('\n');
    if (text.length <= maxChars) return text;
    // Keep the most recent context when the transcript grows huge
    return '...[earlier transcript truncated]...\n' + text.slice(-maxChars);
  }

  // ── Dynamic insights (Nyx Live Insights: detected questions/keywords) ──

  detectDynamicInsights() {
    if (!this.active) return [];
    const recent = this.transcript.slice(-12).map(e => e.text).join(' ');
    if (!recent) return [];

    const insights = [];
    // Spoken questions → strongest signal
    const questionMatches = recent.match(/[^.!?]*\?/g) || [];
    for (const q of questionMatches.slice(-3)) {
      const clean = q.trim().replace(/\s+/g, ' ');
      if (clean.length > 12 && clean.length < 140) {
        insights.push({ id: `q-${insights.length}`, type: 'question', label: clean });
      }
    }
    // Keyword triggers
    const triggers = [
      /\b(what|how|why|when|where|who)\b[^.?!]{6,120}\b(is|are|do|does|did|can|should|would)\b/i,
      /\b(explain|tell me about|walk me through|describe)\b[^.?!]{5,120}/i,
      /\b(salary|budget|timeline|deadline|pricing|cost|discount)\b/i,
      /\b(next steps?|follow[- ]up|action items?)\b/i,
      /\b(complexity|optimize|algorithm|data structure|big o|bug|error|debug)\b/i,
    ];
    for (const re of triggers) {
      const m = recent.match(re);
      if (m) {
        const label = m[0].trim().replace(/\s+/g, ' ').slice(0, 120);
        if (label.length > 10 && !insights.some(i => i.label.toLowerCase() === label.toLowerCase())) {
          insights.push({ id: `k-${insights.length}`, type: 'keyword', label });
        }
      }
    }

    // Emit when new insights appear so the UI can offer "Tab for first"
    if (insights.length !== this._lastInsightCount) {
      this._lastInsightCount = insights.length;
      this.events.emit('dynamic-insights', insights);
    }
    return insights;
  }

  // ── AI actions ───────────────────────────────────────────────────────────

  async runAction(actionId, llmService, { onDelta = null } = {}) {
    // Custom live actions (Nyx "Custom Live Actions"): user-defined prompts run
    // against the live transcript with the transcript as the primary context.
    if (actionId && actionId.startsWith('custom-')) {
      const custom = this.customActions.find(a => a.id === actionId.slice('custom-'.length));
      if (!custom) throw new Error(`Unknown custom action: ${actionId}`);
      if (custom.type !== 'prompt') return { response: 'Link actions open in your browser instead of the AI.', metadata: { isAction: true } };
      if (custom.enabled === false) return { response: 'This action is disabled.', metadata: { isAction: true } };
      const transcript = this.getTranscriptText();
      if (!transcript) return { response: 'Nothing has been said yet in this session.', metadata: { isAction: true } };
      const smartPrefix = this.smartMode ? 'Smart Mode is ON: keep guidance code-first and technical.\n\n' : '';
      return llmService.runAction(`${smartPrefix}${custom.prompt}`, { transcript, onDelta, activeSkill: 'meeting', maxTokens: 1024 });
    }
    // Smart Mode routes default actions through coding/interview prompts.
    const effectiveAction = this.smartMode && ACTION_PROMPTS[`smart-${actionId}`] ? `smart-${actionId}` : actionId;
    const prompt = ACTION_PROMPTS[effectiveAction];
    if (!prompt) throw new Error(`Unknown action: ${effectiveAction}`);
    const transcript = this.getTranscriptText();
    if (!transcript) {
      return { response: 'Nothing has been said yet in this session.', metadata: { isAction: true } };
    }
    return llmService.runAction(prompt, { transcript, onDelta, activeSkill: 'meeting', maxTokens: 1536 });
  }

  async askAboutTranscript(question, llmService, { onDelta = null } = {}) {
    const transcript = this.getTranscriptText();
    const smartPrefix = this.smartMode
      ? 'Smart Mode is ON: you are an elite technical-interview copilot. Give precise, code-first guidance (approach, algorithm, complexity), using fenced code blocks where helpful.\n\n'
      : '';
    const prompt = transcript
      ? `${smartPrefix}Answer the user's question based on the live meeting transcript. If the transcript does not contain the answer, say so briefly.\n\nQuestion: ${question}`
      : `${smartPrefix}The user asks: "${question}". No live transcript is available yet — answer from general knowledge, briefly.`;
    return llmService.runAction(prompt, { transcript: transcript || null, onDelta, activeSkill: this.smartMode ? 'dsa' : 'meeting', maxTokens: 2048 });
  }

  // ── Notes generation + persistence ───────────────────────────────────────

  async generateAndSaveNotes(llmService, { session = null } = {}) {
    const startedAt = this.startedAt || (session && session.startedAt);
    const endedAt = Date.now();
    const transcriptText = this.getTranscriptText();

    const notes = {
      id: this.sessionId || `sess-${endedAt}`,
      title: this.title || this._autoTitle(transcriptText),
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      endedAt: new Date(endedAt).toISOString(),
      durationMs: startedAt ? endedAt - startedAt : 0,
      transcriptEntryCount: this.transcript.length,
      detailedNotes: '',
      keyInsights: '',
      nextSteps: '',
      missedOpportunities: '',
      followUpEmail: '',
      transcript: [...this.transcript],
    };

    if (llmService && llmService.isInitialized && transcriptText) {
      try {
        // Custom notes template (Nyx "custom meeting notes templates"): the
        // prompt is user-editable; extra sections fall into extraSections.
        const notesPrompt = this.getNotesTemplate() + '\n\nAlso draft a professional follow-up email under a final heading:\n## Follow-up Email\n(subject + body).';
        const result = await llmService.runAction(notesPrompt, { transcript: transcriptText, activeSkill: 'meeting', maxTokens: 3072 });
        const md = result.response || '';
        notes.detailedNotes = this._extractSection(md, 'Detailed Notes')
          || this._extractFirstSection(md)
          || md;
        notes.keyInsights = this._extractSection(md, 'Key Insights');
        notes.nextSteps = this._extractSection(md, 'Next Steps');
        notes.missedOpportunities = this._extractSection(md, 'Missed Opportunities');
        notes.followUpEmail = this._extractSection(md, 'Follow-up Email');
        notes.extraSections = this._extractExtraSections(md, [
          'Detailed Notes', 'Key Insights', 'Next Steps', 'Missed Opportunities', 'Follow-up Email',
        ]);
      } catch (e) {
        logger.warn('AI note generation failed, saving transcript-only note', { error: e.message });
      }
    }

    this._persistNotes(notes);
    this._persistTranscript(notes.id);
    this.events.emit('notes-generated', notes);
    return notes;
  }

  _autoTitle(transcriptText) {
    const words = (transcriptText || '').replace(/\[[^\]]*\]/g, '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 'Untitled session';
    return words.slice(0, 7).join(' ').replace(/[?.,!]+$/, '') + (words.length > 7 ? '…' : '');
  }

  // ── Notes template (Nyx: custom meeting notes templates) ───────────────

  _templatePath() { return path.join(this.dataDir, 'notes-template.json'); }

  getNotesTemplate() {
    if (this.dataDir) {
      try {
        const stored = JSON.parse(fs.readFileSync(this._templatePath(), 'utf8'));
        if (stored && typeof stored.template === 'string' && stored.template.trim()) return stored.template;
      } catch (_) { /* default below */ }
    }
    return DEFAULT_NOTES_TEMPLATE;
  }

  setNotesTemplate(template) {
    const t = String(template || '').trim();
    if (!t) throw new Error('Notes template must be a non-empty string');
    if (this.dataDir) {
      try {
        fs.writeFileSync(this._templatePath(), JSON.stringify({ template: t }, null, 2), 'utf8');
      } catch (e) {
        logger.error('Failed to persist notes template', { error: e.message });
      }
    }
    return t;
  }

  resetNotesTemplate() {
    if (this.dataDir) {
      try { fs.rmSync(this._templatePath(), { force: true }); } catch (_) { /* ignore */ }
    }
    return DEFAULT_NOTES_TEMPLATE;
  }

  /** Body of the first `## section` — fallback when a custom template
   *  replaces "Detailed Notes" with its own headings. */
  _extractFirstSection(markdown) {
    const m = String(markdown || '').match(/^##\s+.+\s*$/m);
    if (!m) return '';
    const start = m.index + m[0].length;
    const next = markdown.indexOf('\n##', start);
    return (next === -1 ? markdown.slice(start) : markdown.slice(start, next)).trim();
  }

  /**
   * Sections in the generated markdown that the template defined but the
   * fixed notes fields do not cover land here (Nyx custom-template parity).
   */
  _extractExtraSections(markdown, knownTitles) {
    const known = new Set(knownTitles.map(t => t.toLowerCase()));
    const extras = {};
    const re = /^##\s+(.+?)\s*$/gm;
    let m;
    while ((m = re.exec(markdown)) !== null) {
      const title = m[1].trim();
      if (!title || known.has(title.toLowerCase())) continue;
      const start = m.index + m[0].length;
      const next = markdown.indexOf('\n##', start);
      const body = (next === -1 ? markdown.slice(start) : markdown.slice(start, next)).trim();
      if (body) extras[title] = body;
    }
    return Object.keys(extras).length ? extras : null;
  }

  _extractSection(markdown, title) {
    try {
      const re = new RegExp(`##\\s*${title}\\s*\\n([\\s\\S]*?)(?=\\n##\\s|$)`, 'i');
      const m = markdown.match(re);
      return m ? m[1].trim() : '';
    } catch (_) {
      return '';
    }
  }

  _notesPath(id) {
    return path.join(this.dataDir, 'meetings', `${id}.json`);
  }

  _persistNotes(notes) {
    if (!this.dataDir) return;
    try {
      fs.writeFileSync(this._notesPath(notes.id), JSON.stringify(notes, null, 2), 'utf8');
      logger.info('Meeting notes saved', { id: notes.id });
    } catch (e) {
      logger.error('Failed to save meeting notes', { error: e.message });
    }
  }

  _persistTranscript(sessionId) {
    if (!this.dataDir) return;
    try {
      fs.writeFileSync(
        path.join(this.dataDir, 'transcripts', `${sessionId}.txt`),
        this.transcript.map(e => `[${e.timestamp}] ${e.text}`).join('\n'),
        'utf8'
      );
    } catch (e) {
      logger.warn('Failed to save transcript file', { error: e.message });
    }
  }

  listMeetings() {
    if (!this.dataDir) return [];
    try {
      const dir = path.join(this.dataDir, 'meetings');
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
      const meetings = files
        .map(f => {
          try {
            const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
            return {
              id: j.id,
              title: j.title,
              startedAt: j.startedAt,
              endedAt: j.endedAt,
              durationMs: j.durationMs,
              transcriptEntryCount: j.transcriptEntryCount,
              hasSummary: !!(j.detailedNotes || j.keyInsights),
            };
          } catch (_) { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => (b.endedAt || '').localeCompare(a.endedAt || ''));
      return meetings;
    } catch (e) {
      logger.warn('Failed to list meetings', { error: e.message });
      return [];
    }
  }

  getMeeting(id) {
    try {
      return JSON.parse(fs.readFileSync(this._notesPath(id), 'utf8'));
    } catch (e) {
      logger.warn('Failed to read meeting', { id, error: e.message });
      return null;
    }
  }

  updateMeetingNotes(id, { detailedNotes = null, keyInsights = null, nextSteps = null, title = null } = {}) {
    const meeting = this.getMeeting(id);
    if (!meeting) return null;
    if (detailedNotes !== null) meeting.detailedNotes = detailedNotes;
    if (keyInsights !== null) meeting.keyInsights = keyInsights;
    if (nextSteps !== null) meeting.nextSteps = nextSteps;
    if (title !== null) meeting.title = title;
    this._persistNotes(meeting);
    return meeting;
  }

  deleteMeeting(id) {
    try {
      fs.rmSync(this._notesPath(id), { force: true });
      fs.rmSync(path.join(this.dataDir, 'transcripts', `${id}.txt`), { force: true });
      logger.info('Meeting deleted', { id });
      return true;
    } catch (e) {
      logger.warn('Failed to delete meeting', { id, error: e.message });
      return false;
    }
  }

  getTranscriptTextForMeeting(id) {
    const meeting = this.getMeeting(id);
    if (!meeting) return '';
    return (meeting.transcript || []).map(e => `[${e.timestamp}] ${e.text}`).join('\n');
  }

  async generateFollowUpEmailForMeeting(id, llmService) {
    const meeting = this.getMeeting(id);
    if (!meeting) return null;
    const transcriptText = (meeting.transcript || []).map(e => e.text).join('\n');
    const source = meeting.followUpEmail ||
      (await llmService.runAction(ACTION_PROMPTS['follow-up-email'], { transcript: transcriptText, maxTokens: 1536 })).response;
    meeting.followUpEmail = source;
    this._persistNotes(meeting);
    return source;
  }

  /** Post-call coaching: missed opportunities for a saved meeting. */
  async generateMissedOpportunitiesForMeeting(id, llmService) {
    const meeting = this.getMeeting(id);
    if (!meeting) return null;
    const transcriptText = (meeting.transcript || []).map(e => e.text).join('\n');
    if (!transcriptText) return 'No transcript available for this session.';
    const result = await llmService.runAction(ACTION_PROMPTS['missed-opportunities'], { transcript: transcriptText, maxTokens: 2048 });
    meeting.missedOpportunities = result.response;
    this._persistNotes(meeting);
    return result.response;
  }

  // ── Call score + analytics (Nyx: Call Coaching & Analytics) ──────────

  /**
   * Score a saved meeting 1-10 via the LLM (strict JSON), persisting
   * callScore + callScoreBreakdown on the meeting record. Idempotent per
   * explicit re-score: each call overwrites the previous score.
   */
  async generateCallScoreForMeeting(id, llmService) {
    const meeting = this.getMeeting(id);
    if (!meeting) return null;
    const transcriptText = (meeting.transcript || []).map(e => e.text).join('\n');
    if (!transcriptText) throw new Error('No transcript available to score.');
    const result = await llmService.runAction(CALL_SCORE_PROMPT, { transcript: transcriptText, maxTokens: 1024 });
    const parsed = this._parseCallScoreJson(result && result.response);
    if (!parsed) throw new Error('Could not parse a call score from the model output.');
    meeting.callScore = parsed.overall;
    meeting.callScoreBreakdown = parsed.breakdown;
    meeting.callScoredAt = new Date().toISOString();
    this._persistNotes(meeting);
    logger.info('Call score generated', { id, overall: parsed.overall });
    return { overall: parsed.overall, breakdown: parsed.breakdown };
  }

  /** Extract strict JSON from model output (tolerates code fences). */
  _parseCallScoreJson(raw) {
    if (!raw) return null;
    let text = String(raw).trim();
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    let obj;
    try { obj = JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
    const overall = Math.round(Number(obj.overall));
    if (!Number.isFinite(overall) || overall < 1 || overall > 10) return null;
    const breakdown = Array.isArray(obj.breakdown)
      ? obj.breakdown
          .map(d => ({
            dimension: String((d && d.dimension) || '').slice(0, 60),
            score: Math.max(1, Math.min(10, Math.round(Number(d && d.score)) || 0)),
            note: String((d && d.note) || '').slice(0, 400),
          }))
          .filter(d => d.dimension)
      : [];
    return { overall, breakdown };
  }

  /**
   * Aggregate analytics across all saved meetings (Nyx "grouped analytics").
   * Pure disk read; safe to call any time.
   */
  getMeetingAnalytics() {
    const meetings = this.listMeetings();
    const details = meetings
      .map(m => this.getMeeting(m.id))
      .filter(Boolean);
    const scored = details.filter(m => Number.isFinite(Number(m.callScore)));
    const scores = scored.map(m => Number(m.callScore));
    const totalMs = details.reduce((a, m) => a + (Number(m.durationMs) || 0), 0);
    const totalLines = details.reduce((a, m) => a + (Number(m.transcriptEntryCount) || 0), 0);

    const byDimension = {};
    for (const m of scored) {
      for (const d of m.callScoreBreakdown || []) {
        if (!d.dimension) continue;
        (byDimension[d.dimension] = byDimension[d.dimension] || []).push(Number(d.score));
      }
    }
    const dimensions = Object.entries(byDimension)
      .map(([dimension, arr]) => ({
        dimension,
        avg: arr.reduce((a, b) => a + b, 0) / arr.length,
        samples: arr.length,
      }))
      .sort((a, b) => b.samples - a.samples || a.dimension.localeCompare(b.dimension));

    const recent = scored
      .sort((a, b) => String(b.callScoredAt || '').localeCompare(String(a.callScoredAt || '')))
      .slice(0, 10)
      .map(m => ({ id: m.id, title: m.title, score: Number(m.callScore), scoredAt: m.callScoredAt, endedAt: m.endedAt }));

    return {
      meetingCount: details.length,
      scoredCount: scored.length,
      totalMs,
      totalTranscriptLines: totalLines,
      avgScore: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
      bestScore: scores.length ? Math.max(...scores) : null,
      worstScore: scores.length ? Math.min(...scores) : null,
      dimensions,
      recent,
    };
  }
}

module.exports = new SessionLifecycleManager();
// Class export for tests (a fresh instance per test needs its own state).
module.exports.SessionLifecycleManager = SessionLifecycleManager;
