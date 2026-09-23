const { contextBridge, ipcRenderer } = require('electron')

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Screenshot and OCR
  takeScreenshot: () => ipcRenderer.invoke('take-screenshot'),

  // Speech recognition
  startSpeechRecognition: () => ipcRenderer.invoke('start-speech-recognition'),
  stopSpeechRecognition: () => ipcRenderer.invoke('stop-speech-recognition'),
  sendAudioChunk: (buffer) => ipcRenderer.send('audio-chunk', { buffer }),
  sendSystemAudioChunk: (buffer) => ipcRenderer.send('audio-chunk-system', { buffer }),
  getSpeechAvailability: () => ipcRenderer.invoke('get-speech-availability'),

  // Window management
  showAllWindows: () => ipcRenderer.invoke('show-all-windows'),
  hideAllWindows: () => ipcRenderer.invoke('hide-all-windows'),
  enableWindowInteraction: () => ipcRenderer.invoke('enable-window-interaction'),
  disableWindowInteraction: () => ipcRenderer.invoke('disable-window-interaction'),
  switchToChat: () => ipcRenderer.invoke('switch-to-chat'),
  switchToSkills: () => ipcRenderer.invoke('switch-to-skills'),
  resizeWindow: (width, height) => ipcRenderer.invoke('resize-window', { width, height }),
  moveWindow: (deltaX, deltaY) => ipcRenderer.invoke('move-window', { deltaX, deltaY }),
  getWindowStats: () => ipcRenderer.invoke('get-window-stats'),

  // Session memory
  getSessionHistory: () => ipcRenderer.invoke('get-session-history'),
  clearSessionMemory: () => ipcRenderer.invoke('clear-session-memory'),
  sendChatMessage: (text) => ipcRenderer.invoke('send-chat-message', text),
  getSkillPrompt: (skillName) => ipcRenderer.invoke('get-skill-prompt', skillName),

  // LLM configuration (NVIDIA NIM)
  setLlmApiKey: (apiKey) => ipcRenderer.invoke('set-llm-api-key', apiKey),
  getLlmStatus: () => ipcRenderer.invoke('get-llm-status'),
  testLlmConnection: () => ipcRenderer.invoke('test-llm-connection'),
  setLlmProvider: (provider) => ipcRenderer.invoke('set-llm-provider', provider),
  // Legacy aliases (onboarding/settings still call these names)
  setGeminiApiKey: (apiKey) => ipcRenderer.invoke('set-llm-api-key', apiKey),
  getGeminiStatus: () => ipcRenderer.invoke('get-llm-status'),
  testGeminiConnection: () => ipcRenderer.invoke('test-llm-connection'),
  runLlmDiagnostics: () => ipcRenderer.invoke('run-llm-diagnostics'),

  // Settings
  showSettings: () => ipcRenderer.invoke('show-settings'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  // First-run onboarding
  getFirstRunStatus: () => ipcRenderer.invoke('get-first-run-status'),
  completeFirstRun: () => ipcRenderer.invoke('complete-first-run'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  closeOnboarding: () => ipcRenderer.invoke('close-onboarding'),
  // detectWhisper/installWhisper/downloadWhisperModel removed — no local Whisper.
  onInstallProgress: (callback) => {
    const wrapped = (_event, line) => {
      try { callback(line); } catch (e) { console.error('onInstallProgress error:', e); }
    };
    ipcRenderer.on('install-progress', wrapped);
    return () => ipcRenderer.removeListener('install-progress', wrapped);
  },
  updateAppIcon: (iconKey) => ipcRenderer.invoke('update-app-icon', iconKey),
  updateActiveSkill: (skill) => ipcRenderer.invoke('update-active-skill', skill),
  restartAppForStealth: () => ipcRenderer.invoke('restart-app-for-stealth'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
  notifyMainWindowReady: () => {
    try {
      ipcRenderer.send('main-window-ready');
    } catch (error) {
      console.error('Error notifying main window ready:', error);
    }
  },
  quit: () => {
    try {
      ipcRenderer.send('quit-app');
    } catch (error) {
      console.error('Error in quit:', error);
    }
  },

  // LLM window specific methods
  expandLlmWindow: (contentMetrics) => ipcRenderer.invoke('expand-llm-window', contentMetrics),
  resizeLlmWindowForContent: (contentMetrics) => ipcRenderer.invoke('resize-llm-window-for-content', contentMetrics),

  // Clipboard helper for reliable copy actions
  copyToClipboard: (text) => {
    try {
      return ipcRenderer.invoke('copy-to-clipboard', String(text ?? ''));
    } catch (e) {
      console.error('copyToClipboard failed:', e);
      return false;
    }
  },

  // Display management
  listDisplays: () => ipcRenderer.invoke('list-displays'),
  captureArea: (options) => ipcRenderer.invoke('capture-area', options),

  // ── Nyx feature IPC: sessions / meeting notes ─────────────────────
  toggleLiveInsightsWindow: () => ipcRenderer.invoke('toggle-live-insights'),
  showDashboardWindow: () => ipcRenderer.invoke('show-dashboard'),
  startSession: (opts) => ipcRenderer.invoke('session-start', opts),
  stopSession: () => ipcRenderer.invoke('session-stop'),
  resumeSession: (meetingId) => ipcRenderer.invoke('session-resume', meetingId),
  dismissMeetingAlert: () => ipcRenderer.invoke('meeting-alert-dismiss'),
  joinMeetingAlert: () => ipcRenderer.invoke('meeting-alert-join'),
  getSessionStatus: () => ipcRenderer.invoke('session-status'),
  setSessionSmartMode: (enabled) => ipcRenderer.invoke('session-smart-mode', enabled),
  toggleSessionAudio: () => ipcRenderer.invoke('session-toggle-audio'),
  toggleSystemAudio: () => ipcRenderer.invoke('session-toggle-system-audio'),
  getSystemAudio: () => ipcRenderer.invoke('session-get-system-audio'),
  getLiveTranscript: () => ipcRenderer.invoke('session-get-transcript'),
  listMeetings: () => ipcRenderer.invoke('meetings-list'),
  getMeeting: (id) => ipcRenderer.invoke('meeting-get', id),
  updateMeetingNotes: (id, patch) => ipcRenderer.invoke('meeting-update', { id, patch }),
  deleteMeeting: (id) => ipcRenderer.invoke('meeting-delete', id),
  shareMeeting: (id) => ipcRenderer.invoke('meeting-share', id),
  generateFollowUpEmail: (id) => ipcRenderer.invoke('meeting-followup-email', id),
  generateMissedOpportunities: (id) => ipcRenderer.invoke('meeting-coaching', id),
  scoreMeeting: (id) => ipcRenderer.invoke('meeting-score', id),
  getAnalyticsSummary: () => ipcRenderer.invoke('analytics-summary'),
  getNotesTemplate: () => ipcRenderer.invoke('notes-template-get'),
  setNotesTemplate: (template) => ipcRenderer.invoke('notes-template-set', template),
  resetNotesTemplate: () => ipcRenderer.invoke('notes-template-reset'),

  // ── Live insights ────────────────────────────────────────────────────────
  runLiveAction: (actionId, onDelta) => {
    const listener = (_event, delta) => { try { onDelta(delta); } catch (_) {} };
    ipcRenderer.on('live-action-delta', listener);
    return ipcRenderer.invoke('live-action-run', actionId).finally(() => {
      ipcRenderer.removeListener('live-action-delta', listener);
    });
  },
  askLive: (question, onDelta) => {
    const listener = (_event, delta) => { try { onDelta(delta); } catch (_) {} };
    ipcRenderer.on('live-action-delta', listener);
    return ipcRenderer.invoke('live-ask', question).finally(() => {
      ipcRenderer.removeListener('live-action-delta', listener);
    });
  },
  onLiveActionResult: (callback) => ipcRenderer.on('live-action-result', callback),

  // ── Custom live actions (Nyx: prompts + links as one-click chips) ────────
  listCustomActions: () => ipcRenderer.invoke('custom-actions-list'),
  getCustomAction: (id) => ipcRenderer.invoke('custom-action-get', id),
  addCustomAction: (action) => ipcRenderer.invoke('custom-action-add', action),
  updateCustomAction: (id, patch) => ipcRenderer.invoke('custom-action-update', { id, patch }),
  deleteCustomAction: (id) => ipcRenderer.invoke('custom-action-delete', id),
  onCustomActionsChanged: (callback) => ipcRenderer.on('custom-actions-changed', callback),

  // ── Customize: modes & knowledge base ────────────────────────────────────
  listModes: () => ipcRenderer.invoke('modes-list'),
  getMode: (id) => ipcRenderer.invoke('mode-get', id),
  upsertMode: (mode) => ipcRenderer.invoke('mode-upsert', mode),
  deleteMode: (id) => ipcRenderer.invoke('mode-delete', id),
  setActiveMode: (id) => ipcRenderer.invoke('mode-set-active', id),
  getActiveMode: () => ipcRenderer.invoke('mode-get-active'),
  listKnowledge: () => ipcRenderer.invoke('knowledge-list'),
  addKnowledge: (title, content) => ipcRenderer.invoke('knowledge-add', { title, content }),
  addKnowledgeFromUrl: (title, url) => ipcRenderer.invoke('knowledge-add-url', { title, url }),
  deleteKnowledge: (id) => ipcRenderer.invoke('knowledge-delete', id),

  // ── Pre-call briefs ──────────────────────────────────────────────────────
  listCalendarSources: () => ipcRenderer.invoke('calendar-sources-list'),
  addCalendarSource: (source) => ipcRenderer.invoke('calendar-source-add', source),
  removeCalendarSource: (id) => ipcRenderer.invoke('calendar-source-remove', id),
  refreshCalendars: () => ipcRenderer.invoke('calendar-refresh'),
  getUpcomingMeetings: () => ipcRenderer.invoke('calendar-upcoming'),
  generatePreCallBrief: (meeting) => ipcRenderer.invoke('precall-brief', meeting),

  // ── Settings additions (Nyx parity) ───────────────────────────────────
  getOutputLanguage: () => ipcRenderer.invoke('get-output-language'),
  setOutputLanguage: (lang) => ipcRenderer.invoke('set-output-language', lang),
  setInvisibilityMode: (mode) => ipcRenderer.invoke('set-invisibility-mode', mode),
  getInvisibilityMode: () => ipcRenderer.invoke('get-invisibility-mode'),
  setPreferredDisplay: (displayId) => ipcRenderer.invoke('set-preferred-display', displayId),
  listDisplaysForSettings: () => ipcRenderer.invoke('list-displays-for-settings'),
  setAutoLaunch: (enabled) => ipcRenderer.invoke('set-auto-launch', enabled),
  getAutoLaunch: () => ipcRenderer.invoke('get-auto-launch'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  setCalendarAutoAttend: (enabled) => ipcRenderer.invoke('set-calendar-auto-attend', enabled),
  getCalendarAutoAttend: () => ipcRenderer.invoke('get-calendar-auto-attend'),
  getShortcuts: () => ipcRenderer.invoke('get-shortcuts'),
  setShortcut: (id, accelerator) => ipcRenderer.invoke('set-shortcut', { id, accelerator }),
  resetShortcuts: () => ipcRenderer.invoke('reset-shortcuts'),

  // Event listeners
  onTranscriptionReceived: (callback) => ipcRenderer.on('transcription-received', callback),
  onInterimTranscription: (callback) => ipcRenderer.on('interim-transcription', callback),
  onSpeechStatus: (callback) => ipcRenderer.on('speech-status', callback),
  onSpeechError: (callback) => ipcRenderer.on('speech-error', callback),
  onSpeechAvailability: (callback) => ipcRenderer.on('speech-availability', callback),
  onSessionEvent: (callback) => ipcRenderer.on('session-event', callback),
  onSessionCleared: (callback) => ipcRenderer.on('session-cleared', callback),
  onOcrCompleted: (callback) => ipcRenderer.on('ocr-completed', callback),
  onOcrError: (callback) => ipcRenderer.on('ocr-error', callback),
  onLlmResponse: (callback) => ipcRenderer.on('llm-response', callback),
  onLlmError: (callback) => ipcRenderer.on('llm-error', callback),
  onTranscriptionLlmResponse: (callback) => ipcRenderer.on('transcription-llm-response', callback),
  onTranscriptionLlmResponseStart: (callback) => ipcRenderer.on('transcription-llm-response-start', callback),
  onTranscriptionLlmResponseChunk: (callback) => ipcRenderer.on('transcription-llm-response-chunk', callback),
  onOpenGeminiConfig: (callback) => ipcRenderer.on('open-gemini-config', callback),
  onDisplayLlmResponse: (callback) => ipcRenderer.on('display-llm-response', callback),
  onShowLoading: (callback) => ipcRenderer.on('show-loading', callback),
  onSkillChanged: (callback) => ipcRenderer.on('skill-changed', callback),
  onInteractionModeChanged: (callback) => ipcRenderer.on('interaction-mode-changed', callback),
  onRecordingStarted: (callback) => ipcRenderer.on('recording-started', callback),
  onRecordingStopped: (callback) => ipcRenderer.on('recording-stopped', callback),
  onCodingLanguageChanged: (callback) => ipcRenderer.on('coding-language-changed', callback),
  onMainWindowShown: (callback) => ipcRenderer.on('main-window-shown', callback),

  // Live insights / session listeners
  onTranscriptEntry: (callback) => ipcRenderer.on('live-transcript-entry', callback),
  onDynamicInsights: (callback) => ipcRenderer.on('live-dynamic-insights', callback),
  onSessionStatusChanged: (callback) => {
    const wrapped = (_e, status) => { try { callback(status); } catch (_) {} };
    ipcRenderer.on('session-status-changed', wrapped);
  },
  onModeChanged: (callback) => ipcRenderer.on('mode-changed', callback),
  onScreenAssist: (callback) => ipcRenderer.on('screen-assist-started', callback),
  onMeetingStarting: (callback) => ipcRenderer.on('meeting-starting', callback),

  // Generic receive method
  receive: (channel, callback) => ipcRenderer.on(channel, callback),

  // Remove listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel)
})

contextBridge.exposeInMainWorld('api', {
    send: (channel, data) => {
        let validChannels = [
            'close-settings',
            'quit-app',
            'save-settings',
            'toggle-recording',
            'toggle-interaction-mode',
            'update-skill',
            'window-loaded'
        ];
        if (validChannels.includes(channel)) {
            ipcRenderer.send(channel, data);
        } else {
            console.warn('Invalid IPC channel:', channel);
        }
    },
    receive: (channel, func) => {
        let validChannels = [
            'load-settings',
            'recording-state-changed',
            'interaction-mode-changed',
            'skill-updated',
            'update-skill',
            'recording-started',
            'recording-stopped'
        ];
        if (validChannels.includes(channel)) {
            ipcRenderer.on(channel, (event, ...args) => func(...args));
        }
    }
});
