const path = require("path");
const fs = require("fs");
const { fileURLToPath } = require("url");
const { app, BrowserWindow, globalShortcut, session, ipcMain } = require("electron");

// ── Resolve a stable .env location ──
// In packaged builds process.cwd() is unstable and frequently read-only
// (NSIS install dir, AppImage mount, .app bundle), so the canonical config
// lives in Electron's userData directory. We still prefer an existing
// project-local .env in development (npm start) so the dev workflow is
// unchanged. Both onboarding (FirstRunManager) and persistEnvUpdates() write
// to this same path so settings survive restarts on every platform.
function resolveEnvPath() {
  try {
    const userDataEnv = path.join(app.getPath("userData"), ".env");
    const projectEnv = path.join(process.cwd(), ".env");
    // Prefer a project .env only when it already exists and userData has none
    // (i.e. a developer running from the repo). Otherwise use userData.
    if (!fs.existsSync(userDataEnv) && fs.existsSync(projectEnv)) {
      return projectEnv;
    }
    return userDataEnv;
  } catch (_) {
    // On packaged macOS builds, process.cwd() may be inside a read-only .app
    // bundle. Fall back to userData so .env writes never fail.
    try {
      return path.join(app.getPath("userData"), ".env");
    } catch (e2) {
      return path.join(process.cwd(), ".env");
    }
  }
}
const ENV_PATH = resolveEnvPath();
require("dotenv").config({ path: ENV_PATH });

// Format a value for a single .env line. Newlines are collapsed to spaces and
// backslashes are kept verbatim (doubling them corrupts Windows paths on the
// next load). Values containing whitespace, a double-quote, or a leading '#'
// are wrapped in single quotes so dotenv parses them as one token.
function formatEnvValue(raw) {
  const v = String(raw).replace(/[\r\n]+/g, " ").trim();
  if (!/[\s"#]/.test(v)) return v;
  if (!v.includes("'")) return `'${v}'`;
  // Rare: value already contains a single quote — fall back to double quotes.
  return `"${v.replace(/"/g, '\\"')}"`;
}

// ── Linux GPU process crash workaround ──
// On many Linux setups (Wayland, X11 without GPU drivers, Docker, headless,
// or systems with broken Mesa/NVIDIA stacks), Chromium's GPU process crashes
// on startup with:
//   FATAL:gpu_data_manager_impl_private.cc(448)] GPU process isn't usable.
// This kills the entire app and can leave orphan helper processes that
// exhaust the X11 client limit, producing "Maximum number of clients reached".
//
// Disabling hardware acceleration and the GPU subprocess forces Chromium to
// render via the CPU (SwiftShader). Nyx's UI is light enough that
// this is imperceptible, and it eliminates the GPU crash entirely.
if (process.platform === "linux") {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-software-rasterizer");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  // On X11 only; harmless on Wayland. Prevents Chromium from spawning a
  // compositor process that adds another X11 client.
  app.commandLine.appendSwitch("in-process-gpu");
}

// Keep Chromium network noise out of the terminal; app-level logs still go through Winston.
app.commandLine.appendSwitch("log-level", "3");
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("no-pings");

const logger = require("./src/core/logger").createServiceLogger("MAIN");
const config = require("./src/core/config");
const FirstRunManager = require("./src/core/first-run");

// ── Global crash guard ──
// The speech path spawns external recorder processes (arecord/sox via
// node-record-lpcm16). A missing recorder binary makes that library emit an
// 'error' on its child process with no listener, which would otherwise become
// an uncaughtException and quit the entire app the moment the user clicks the
// mic. We log and stay alive — the speech service surfaces a friendly status
// to the UI instead.
process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception (kept alive)", {
    error: err && err.message,
    stack: err && err.stack,
  });
});
process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection (kept alive)", {
    reason: String((reason && reason.message) || reason),
  });
});

// Services
// Screen capture (image-based)
const captureService = require("./src/services/capture.service");
const speechService = require("./src/services/speech.service");
const llmService = require("./src/services/llm.service");

// Managers
const windowManager = require("./src/managers/window.manager");
const sessionManager = require("./src/managers/session.manager");

// Nyx-parity managers: session lifecycle (Live Insights/notes), customize
// (modes + knowledge base), and pre-call briefs (ICS calendar).
const sessionLifecycle = require("./src/managers/session-lifecycle.manager");
const customizeManager = require("./src/managers/customize.manager");
const preCallManager = require("./src/managers/precall.manager");

class ApplicationController {
  constructor() {
    this.isReady = false;
    this.starting = false;
    this.activeSkill = "dsa";
  // Default to C++ so language is enforced from first run
  this.codingLanguage = "cpp";
    this.speechAvailable = false;

    // Utterance coalescing: VAD emits a transcript per natural pause, but a
    // single spoken question can still arrive as a few fragments (mid-thought
    // pauses). We buffer fragments and debounce so one question yields one LLM
    // call instead of several slow, half-answered ones.
    this._utteranceBuffer = "";
    this._utteranceTimer = null;
    this._utteranceDispatchInFlight = false;
    this._utteranceCoalesceMs = 800;

    // First-run onboarding: detects missing .env / API key and triggers
    // a settings-window prompt on first launch so users don't have to
    // dig through docs to figure out they need a Gemini API key.
    this.firstRunManager = new FirstRunManager({
      logger: logger,
      // .env and the sentinel both live in userData so they survive cwd
      // changes and read-only install dirs (the app may be launched from
      // any directory). ENV_PATH is the same file dotenv loaded at startup
      // and that persistEnvUpdates() writes to.
      envPath: ENV_PATH,
      sentinelPath: path.join(app.getPath("userData"), ".nyx-firstrun-completed"),
    });
    this.isFirstRun = false;

    // Window configurations for reference
    this.windowConfigs = {
      main: { title: "Nyx" },
      chat: { title: "Chat" },
      llmResponse: { title: "AI Response" },
      settings: { title: "Settings" },
    };

    this.setupStealth();
    this.setupEventHandlers();

    // Point the Nyx-parity managers at the persistent userData dir so
    // meeting notes, modes, knowledge base and calendar sources survive
    // restarts on every platform.
    const userDataDir = app.getPath("userData");
    sessionLifecycle.setDataDir(userDataDir);
    customizeManager.setDataDir(userDataDir);
    preCallManager.setDataDir(userDataDir);
  }

  setupStealth() {
    if (config.get("stealth.disguiseProcess")) {
      process.title = config.get("app.processTitle");
    }

    // Set default stealth app name early
    if (app && typeof app.setName === 'function') {
      app.setName("Terminal ");
    }
    process.title = "Terminal ";

    if (
      process.platform === "darwin" &&
      config.get("stealth.noAttachConsole")
    ) {
      process.env.ELECTRON_NO_ATTACH_CONSOLE = "1";
      process.env.ELECTRON_NO_ASAR = "1";
    }
  }

  setupEventHandlers() {
    app.whenReady().then(() => this.onAppReady());
    app.on("window-all-closed", () => this.onWindowAllClosed());
    app.on("activate", () => this.onActivate());
    app.on("will-quit", () => this.onWillQuit());

    this.setupIPCHandlers();
    this.setupServiceEventHandlers();
  }

  handleSecondInstance() {
    logger.info("Second instance launch detected; focusing existing windows");

    const focusExistingWindows = () => {
      try {
        const mainWindow = windowManager.getWindow("main");
        if (mainWindow) {
          if (mainWindow.isMinimized && mainWindow.isMinimized()) {
            mainWindow.restore();
          }
          windowManager.showAllWindows();
          windowManager.showOnCurrentDesktop(mainWindow);
          mainWindow.focus();
          return;
        }

        if (this.isReady) {
          windowManager.showAllWindows();
        }
      } catch (error) {
        logger.error("Failed to focus existing instance", {
          error: error.message,
        });
      }
    };

    if (app.isReady()) {
      focusExistingWindows();
    } else {
      app.whenReady().then(focusExistingWindows);
    }
  }

  async onAppReady() {
    if (this.starting || this.isReady) {
      logger.debug("onAppReady skipped: already starting or ready");
      return;
    }
    this.starting = true;

    // Force stealth mode IMMEDIATELY when app is ready
    app.setName("Terminal ");
    process.title = "Terminal ";

    logger.info("Application starting", {
      version: config.get("app.version"),
      environment: config.get("app.isDevelopment")
        ? "development"
        : "production",
      platform: process.platform,
    });

    try {
      this.setupPermissions();
      this.setupNetworkConfiguration();

      // Small delay to ensure desktop/space detection is accurate
      await new Promise((resolve) => setTimeout(resolve, 200));

      // First-run onboarding: ensure .env exists and read status once
      // so we can decide whether to defer showing the main overlay.
      let status;
      try {
        this.firstRunManager.ensureEnv();
        status = this.firstRunManager.getStatus();
        this.isFirstRun = status.needsOnboarding;
        logger.info("First-run status", status);
      } catch (e) {
        logger.warn("First-run check failed", { error: e.message });
        status = { needsOnboarding: false };
        this.isFirstRun = false;
      }
      const isFirstRun = status.needsOnboarding;

      await windowManager.initializeWindows({ showMainWindow: !isFirstRun });
      this.setupGlobalShortcuts();
      // Nyx parity: watch calendar sources for meeting starts/ends
      this.startMeetingAlertScheduler();

      // Initialize default stealth mode with terminal icon
      this.updateAppIcon("terminal");

      this.starting = false;
      this.isReady = true;

      // Launch the onboarding wizard if this is the first run.
      if (this.isFirstRun) {
        // Defer slightly so all windows finish loading before we pop
        // the wizard on top of them.
        setTimeout(() => {
          try {
            windowManager.showOnboarding();
            windowManager.broadcastToAllWindows("first-run", status);
            logger.info("First-run onboarding: wizard opened");
          } catch (e) {
            logger.warn("Could not open first-run onboarding window", {
              error: e.message
            });
            // Fallback to legacy settings prompt
            try { this.showSettings(); } catch (_) { /* ignore */ }
          }
        }, 800);
      } else {
        // Already configured — mark completed so we never nag again.
        this.firstRunManager.markCompleted();
      }

      logger.info("Application initialized successfully", {
        windowCount: Object.keys(windowManager.getWindowStats().windows).length,
        currentDesktop: "detected",
      });

      sessionManager.addEvent("Application started");
    } catch (error) {
      this.starting = false;
      logger.error("Application initialization failed", {
        error: error.message,
      });
      app.quit();
    }
  }

  setupNetworkConfiguration() {
    // Configure session to handle network requests better
    const ses = session.defaultSession;
    
    // Allow HTTPS requests to Google APIs
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (details.url.includes('generativelanguage.googleapis.com')) {
        const platformUA = process.platform === 'darwin'
          ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.156 Safari/537.36'
          : 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.156 Safari/537.36';
        details.requestHeaders['User-Agent'] = platformUA;
      }
      callback({ requestHeaders: details.requestHeaders });
    });
    
    // Handle certificate errors for Google APIs
    ses.setCertificateVerifyProc((request, callback) => {
      if (request.hostname === 'generativelanguage.googleapis.com') {
        callback(0); // Trust Google's certificates
      } else {
        callback(-2); // Use default verification
      }
    });
    
    logger.debug('Network configuration applied for Gemini API');
  }

  setupPermissions() {
    const appSession = session.defaultSession;
    const isTrustedAppContents = (webContents) => {
      if (!webContents || webContents.isDestroyed()) {
        return false;
      }
      try {
        const pagePath = path.resolve(fileURLToPath(webContents.getURL()));
        const appRoot = path.resolve(__dirname);
        const normalizeForComparison = (value) => process.platform === "win32"
          ? value.toLowerCase()
          : value;
        const page = normalizeForComparison(pagePath);
        const root = normalizeForComparison(appRoot + path.sep);
        return page.startsWith(root);
      } catch (_) {
        return false;
      }
    };

    // Electron exposes camera/microphone access as the single `media`
    // permission. The requested device type is provided separately in details.
    appSession.setPermissionCheckHandler(
      (webContents, permission, _requestingOrigin, details = {}) => {
        if (!isTrustedAppContents(webContents)) {
          return false;
        }
        if (permission === "media") {
          return !details.mediaType || details.mediaType === "audio";
        }
        return permission === "display-capture";
      }
    );

    appSession.setPermissionRequestHandler(
      (webContents, permission, callback, details = {}) => {
        let granted = false;
        if (isTrustedAppContents(webContents)) {
          if (permission === "media") {
            const mediaTypes = Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
            granted = mediaTypes.length === 0 || mediaTypes.includes("audio");
          } else {
            granted = permission === "display-capture";
          }
        }

        logger.debug("Permission request", {
          permission,
          mediaTypes: details.mediaTypes || [],
          granted
        });
        callback(granted);
      }
    );
  }

  // Default shortcut map: action id → default accelerator.
  // Users can override any accelerator (or set "disabled") via SHORTCUT_<ID>
  // in .env or Settings → Shortcuts.
  static DEFAULT_SHORTCUTS = {
    screenshot: "CommandOrControl+Shift+S",
    toggleVisibility: "CommandOrControl+Shift+V",
    forceOnTop: "CommandOrControl+Shift+T",
    screenAssist: "CommandOrControl+Return",
    stealthAnswer: "CommandOrControl+Shift+Return",
    clearContext: "CommandOrControl+R",
    toggleLiveInsights: "CommandOrControl+\\",
    moveLeft: "CommandOrControl+Left",
    moveRight: "CommandOrControl+Right",
    toggleInteraction: "CommandOrControl+Shift+I",
    openChat: "CommandOrControl+Shift+C",
    clearContext2: "CommandOrControl+Shift+\\",
    openSettings: "CommandOrControl+,",
    toggleMic: "Alt+R",
    moveUp: "CommandOrControl+Up",
    moveDown: "CommandOrControl+Down",
  };

  // Actions available for binding. Values are the handler functions; the keys
  // double as the SHORTCUT_<ID> env names (upper-cased).
  getShortcutActions() {
    return {
      screenshot: () => this.triggerScreenshotOCR(),
      toggleVisibility: () => windowManager.toggleVisibility(),
      forceOnTop: () => windowManager.forceAlwaysOnTopForAllWindows(),
      screenAssist: () => this.screenAssist(),
      stealthAnswer: () => this.stealthAnswer(),
      clearContext: () => this.clearSessionMemory(),
      toggleLiveInsights: () => windowManager.toggleLiveInsights(),
      // moveLeft/Right combine the legacy duplicate bindings: always nudge the
      // bound windows, and honor the context-sensitive arrow behaviour too.
      moveLeft: () => { windowManager.moveBoundWindows(-40, 0); this.handleLeftArrow(); },
      moveRight: () => { windowManager.moveBoundWindows(40, 0); this.handleRightArrow(); },
      toggleInteraction: () => windowManager.toggleInteraction(),
      openChat: () => windowManager.switchToWindow("chat"),
      clearContext2: () => this.clearSessionMemory(),
      openSettings: () => windowManager.showSettings(),
      toggleMic: () => this.toggleSpeechRecognition(),
      moveUp: () => this.handleUpArrow(),
      moveDown: () => this.handleDownArrow(),
    };
  }

  /** Resolve the effective accelerator for an action id: env override or default. */
  getShortcutAccelerator(actionId) {
    const envKey = `SHORTCUT_${actionId.toUpperCase()}`;
    const override = (process.env[envKey] || "").trim();
    if (!override) return ApplicationController.DEFAULT_SHORTCUTS[actionId] || null;
    if (override.toLowerCase() === "disabled" || override.toLowerCase() === "off") return null;
    return override;
  }

  setupGlobalShortcuts() {
    this.registerShortcutsFromSettings();
  }

  /**
   * Register all shortcuts from the current settings. Also used after the user
   * edits keybinds (Settings → Shortcuts) — unregisters everything first so
   * changes apply live without an app restart.
   */
  registerShortcutsFromSettings() {
    try { globalShortcut.unregisterAll(); } catch (_) { /* ignore */ }
    const actions = this.getShortcutActions();
    Object.entries(actions).forEach(([actionId, handler]) => {
      const accelerator = this.getShortcutAccelerator(actionId);
      if (!accelerator) {
        logger.debug("Shortcut disabled", { actionId });
        return;
      }
      let success = false;
      try {
        success = globalShortcut.register(accelerator, handler);
      } catch (e) {
        logger.warn("Shortcut registration threw", { actionId, accelerator, error: e.message });
      }
      if (!success) {
        logger.warn("Shortcut registration failed (conflict or invalid)", { actionId, accelerator });
      } else {
        logger.debug("Global shortcut registered", { actionId, accelerator });
      }
    });
    // Legacy bindings without configurable ids
    const legacy = {
      "Alt+A": () => windowManager.toggleInteraction(),
      "CommandOrControl+Shift+Alt+T": () => {
        const results = windowManager.testAlwaysOnTopForAllWindows();
        logger.info('Always-on-top test triggered via shortcut', results);
      },
    };
    Object.entries(legacy).forEach(([accelerator, handler]) => {
      const success = globalShortcut.register(accelerator, handler);
      logger.debug("Legacy shortcut registered", { accelerator, success });
    });
  }

  // ── Meeting alerts / auto-attend scheduler (Nyx parity) ──────────────
  // Polls the PreCallManager calendar sources every 30s. When a meeting hits
  // its start time it broadcasts a "meeting-starting" alert (the dashboard
  // shows a Join banner) and, if CALENDAR_AUTO_ATTEND is on, starts a Listen
  // session automatically. When the calendar slot ends, the auto-attended
  // session stops and notes are generated.
  startMeetingAlertScheduler() {
    if (this._meetingAlertTimer) return;
    this._alertedMeetingIds = new Set();
    this._meetingAlertTimer = setInterval(async () => {
      try {
        const autoAttend = String(process.env.CALENDAR_AUTO_ATTEND || "true").toLowerCase() !== "false";
        const meetings = preCallManager.getUpcomingMeetings(24, 10);
        const now = Date.now();
        for (const meeting of meetings) {
          const startMs = new Date(meeting.start).getTime();
          const endMs = meeting.end ? new Date(meeting.end).getTime() : null;
          const id = `${meeting.summary}@${meeting.start}`;
          // Fire the alert when the meeting has just started (within 2 min)
          if (startMs <= now && now - startMs < 120000 && !this._alertedMeetingIds.has(id)) {
            this._alertedMeetingIds.add(id);
            windowManager.broadcastToAllWindows("meeting-starting", meeting);
            if (autoAttend && !sessionLifecycle.isActive()) {
              const status = sessionLifecycle.autoAttendMeeting(meeting);
              if (status) {
                try {
                  if (speechService.isAvailable && speechService.isAvailable() && !speechService.getStatus().isRecording) {
                    speechService.startRecording();
                  }
                } catch (_) { /* ignore */ }
                windowManager.broadcastToAllWindows("session-status-changed", status);
                windowManager.showLiveInsights();
              }
            }
          }
          // End the auto-attended session when the calendar slot is over
          if (
            sessionLifecycle.isAutoAttending() &&
            sessionLifecycle.getStatus().title === meeting.summary &&
            // Match on start time too so two same-named meetings ("Standup")
            // can't end each other's sessions prematurely.
            (!sessionLifecycle.getAutoAttendStart() || sessionLifecycle.getAutoAttendStart() === meeting.start) &&
            ((endMs && endMs <= now) || (!endMs && startMs <= now - 60 * 60000))
          ) {
            const endedStatus = sessionLifecycle.autoAttendEnd();
            if (endedStatus) {
              windowManager.broadcastToAllWindows("session-status-changed", endedStatus);
              try {
                if (speechService.getStatus && speechService.getStatus().isRecording) {
                  speechService.stopRecording();
                }
              } catch (_) { /* ignore */ }
              const notes = await sessionLifecycle.generateAndSaveNotes(llmService);
              logger.info("Auto-attended session notes generated", { id: notes.id });
            }
          }
        }
        // Keep the alert set bounded
        if (this._alertedMeetingIds.size > 200) {
          this._alertedMeetingIds = new Set([...this._alertedMeetingIds].slice(-100));
        }
      } catch (e) {
        logger.debug("Meeting alert scheduler tick failed", { error: e.message });
      }
    }, 30000);
    logger.info("Meeting alert scheduler started (30s poll)");
  }

  setupServiceEventHandlers() {
    // Live-session transcript stream: push every transcript entry to all
    // windows (Live Insights shows it live via preload's onTranscriptEntry).
    sessionLifecycle.events.on("transcript-entry", (entry) => {
      windowManager.broadcastToAllWindows("live-transcript-entry", entry);
    });

    speechService.on("recording-started", () => {
      windowManager.handleRecordingStarted();
    });

    speechService.on("recording-stopped", () => {
      windowManager.handleRecordingStopped();
    });

    speechService.on("transcription", (text, meta = {}) => {
      this.handleTranscriptionFragment(text, meta);
    });

    speechService.on("interim-transcription", (text) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("interim-transcription", { text });
      });
    });

    speechService.on("status", (status) => {
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-status", { status, available: this.speechAvailable });
      });
      // Also broadcast availability specifically
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-availability", { available: this.speechAvailable });
      });
    });

    speechService.on("error", (error) => {
      // In error, still compute availability
      this.speechAvailable = speechService.isAvailable ? speechService.isAvailable() : false;
      BrowserWindow.getAllWindows().forEach((window) => {
        window.webContents.send("speech-error", { error, available: this.speechAvailable });
      });
    });
  }

  setupIPCHandlers() {
  ipcMain.handle("take-screenshot", () => this.triggerScreenshotOCR());
  ipcMain.handle("list-displays", () => captureService.listDisplays());
  ipcMain.handle("capture-area", (event, options) => captureService.captureAndProcess(options));
    
    // Provide reliable clipboard write via main process
    ipcMain.handle("copy-to-clipboard", (event, text) => {
      try {
        const { clipboard } = require("electron");
        clipboard.writeText(String(text ?? ""));
        return true;
      } catch (e) {
        logger.error("Failed to write to clipboard", { error: e.message });
        return false;
      }
    });
    
    ipcMain.handle("get-speech-availability", () => {
      return speechService.isAvailable ? speechService.isAvailable() : false;
    });

    ipcMain.handle("start-speech-recognition", () => {
      speechService.startRecording();
      return speechService.getStatus();
    });

    ipcMain.handle("stop-speech-recognition", () => {
      speechService.stopRecording();
      return speechService.getStatus();
    });

    // Raw PCM audio captured by the renderer's Web Audio API
    ipcMain.on("audio-chunk", (_event, data) => {
      if (data && data.buffer) {
        speechService.handleAudioChunkFromRenderer(Buffer.from(data.buffer));
      }
    });

    // Raw PCM from the system/loopback capture stream (the other party's voice).
    // Routed through the same VAD pipeline but tagged source=system so the
    // transcript distinguishes "you" from "them" (Nyx listens to both).
    ipcMain.on("audio-chunk-system", (_event, data) => {
      if (data && data.buffer) {
        speechService.handleSystemAudioChunk(Buffer.from(data.buffer));
      }
    });

    // Also handle direct send events for fallback
    ipcMain.on("start-speech-recognition", () => {
      speechService.startRecording();
    });

    ipcMain.on("stop-speech-recognition", () => {
      speechService.stopRecording();
    });

    ipcMain.on("chat-window-ready", () => {
      // Send a test message to confirm communication
      setTimeout(() => {
        windowManager.broadcastToAllWindows("transcription-received", {
          text: "Test message from main process - chat window communication is working!",
        });
      }, 1000);
    });

    ipcMain.on("main-window-ready", () => {
      // Re-check availability whenever the main overlay finishes loading;
      // this covers first-run where the window was hidden during onboarding.
      this.speechAvailable = speechService.isAvailable
        ? speechService.isAvailable()
        : false;
      const { BrowserWindow } = require("electron");
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) {
          win.webContents.send("speech-availability", { available: this.speechAvailable });
        }
      });
    });

    ipcMain.on("test-chat-window", () => {
      windowManager.broadcastToAllWindows("transcription-received", {
        text: "🧪 IMMEDIATE TEST: Chat window IPC communication test successful!",
      });
    });

    ipcMain.handle("show-all-windows", () => {
      windowManager.showAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("hide-all-windows", () => {
      windowManager.hideAllWindows();
      return windowManager.getWindowStats();
    });

    ipcMain.handle("enable-window-interaction", () => {
      windowManager.setInteractive(true);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("disable-window-interaction", () => {
      windowManager.setInteractive(false);
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-chat", () => {
      windowManager.switchToWindow("chat");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("switch-to-skills", () => {
      windowManager.switchToWindow("skills");
      return windowManager.getWindowStats();
    });

    ipcMain.handle("resize-window", (event, { width, height }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        // Enforce horizontal constraints: min ~one icon, max original width
        const minW = 60;
        const maxW = windowManager.windowConfigs?.main?.width || 520;
        const clampedWidth = Math.max(minW, Math.min(maxW, Math.round(width || minW)));
        try {
          // Match content size to the DOM so no extra transparent area remains
          mainWindow.setContentSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        } catch (e) {
          // Fallback in case setContentSize isn’t available on some platform
          mainWindow.setSize(Math.max(1, clampedWidth), Math.max(1, Math.round(height)));
        }
        logger.debug("Main window resized (content)", { width: clampedWidth, height });
      }
      return { success: true };
    });

    ipcMain.handle("move-window", (event, { deltaX, deltaY }) => {
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow) {
        const [currentX, currentY] = mainWindow.getPosition();
        const newX = currentX + deltaX;
        const newY = currentY + deltaY;
        mainWindow.setPosition(newX, newY);
        logger.debug("Main window moved", {
          deltaX,
          deltaY,
          from: { x: currentX, y: currentY },
          to: { x: newX, y: newY },
        });
      }
      return { success: true };
    });

    ipcMain.handle("get-session-history", () => {
      return sessionManager.getOptimizedHistory();
    });

    ipcMain.handle("clear-session-memory", () => {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      return { success: true };
    });

    ipcMain.handle("force-always-on-top", () => {
      windowManager.forceAlwaysOnTopForAllWindows();
      return { success: true };
    });

    ipcMain.handle("test-always-on-top", () => {
      const results = windowManager.testAlwaysOnTopForAllWindows();
      return { success: true, results };
    });

    ipcMain.handle("send-chat-message", async (event, text) => {
      // Add chat message to session memory
      sessionManager.addUserInput(text, 'chat');
      logger.debug('Chat message added to session memory', { textLength: text.length });

      // Typed messages need the full skill pipeline (with history context),
      // NOT the voice "intelligent filter" pipeline. Voice keeps its filter
      // behaviour; typed chat goes through processWithLLM so it gets real
      // answers using the active skill prompt and recent conversation history.
      (async () => {
        try {
          const sessionHistory = sessionManager.getOptimizedHistory();
          await this.processWithLLM(text, sessionHistory);
        } catch (error) {
          logger.error("Failed to process chat message with LLM", {
            error: error.message,
            text: text.substring(0, 100)
          });
        }
      })();

      return { success: true };
    });

    ipcMain.handle("get-skill-prompt", (event, skillName) => {
      try {
        const { promptLoader } = require('./prompt-loader');
        const skillPrompt = promptLoader.getSkillPrompt(skillName);
        return skillPrompt;
      } catch (error) {
        logger.error('Failed to get skill prompt', { skillName, error: error.message });
        return null;
      }
    });

    // Settings handlers
    ipcMain.handle("set-window-binding", (event, enabled) => {
      return windowManager.setWindowBinding(enabled);
    });

    ipcMain.handle("toggle-window-binding", () => {
      return windowManager.toggleWindowBinding();
    });

    ipcMain.handle("get-window-binding-status", () => {
      return windowManager.getWindowBindingStatus();
    });

    ipcMain.handle("get-window-stats", () => {
      return windowManager.getWindowStats();
    });

    ipcMain.handle("set-window-gap", (event, gap) => {
      return windowManager.setWindowGap(gap);
    });

    ipcMain.handle("move-bound-windows", (event, { deltaX, deltaY }) => {
      windowManager.moveBoundWindows(deltaX, deltaY);
      return windowManager.getWindowBindingStatus();
    });

    // Settings handlers
    // ── Nyx parity: window toggles for Live Insights + Dashboard ──────
    ipcMain.handle("toggle-live-insights", () => {
      windowManager.toggleLiveInsights();
      return { success: true };
    });
    ipcMain.handle("show-dashboard", () => {
      windowManager.showDashboard();
      return { success: true };
    });

    // ── Nyx parity: session lifecycle / Live Insights IPC ────────────
    ipcMain.handle("session-start", (_e, opts = {}) => {
      const status = sessionLifecycle.start({ audio: opts.audio !== false });
      // Listen-mode: while a session is live with audio on, make sure speech
      // recognition is running so the transcript fills up.
      if (status.active && status.audioEnabled) {
        try {
          if (speechService.isAvailable && speechService.isAvailable() && !speechService.getStatus().isRecording) {
            speechService.startRecording();
          }
        } catch (err) {
          logger.warn("Could not auto-start speech for session", { error: err.message });
        }
      }
      windowManager.broadcastToAllWindows("session-status-changed", status);
      return status;
    });

    // Meeting alert actions (dashboard "Join" banner)
    ipcMain.handle("meeting-alert-dismiss", () => {
      // Nothing to clean up in main — the renderer just hides the banner.
      return { success: true };
    });
    ipcMain.handle("meeting-alert-join", async () => {
      // Manual join: start a session if none is active (Live Insights opens).
      if (!sessionLifecycle.isActive()) {
        const status = sessionLifecycle.start({ audio: true });
        try {
          if (speechService.isAvailable && speechService.isAvailable() && !speechService.getStatus().isRecording) {
            speechService.startRecording();
          }
        } catch (_) { /* ignore */ }
        windowManager.broadcastToAllWindows("session-status-changed", status);
        windowManager.showLiveInsights();
      }
      return sessionLifecycle.getStatus();
    });

    ipcMain.handle("session-stop", async () => {
      const status = sessionLifecycle.getStatus();
      if (!status.active) return null;
      try {
        if (speechService.getStatus && speechService.getStatus().isRecording) {
          speechService.stopRecording();
        }
      } catch (_) { /* ignore */ }
      sessionLifecycle.stop();
      windowManager.broadcastToAllWindows("session-status-changed", sessionLifecycle.getStatus());
      try {
        const notes = await sessionLifecycle.generateAndSaveNotes(llmService);
        logger.info("Session ended; notes generated", { id: notes.id });
        return notes;
      } catch (e) {
        logger.error("Note generation failed on session stop", { error: e.message });
        return null;
      }
    });

    ipcMain.handle("session-status", () => sessionLifecycle.getStatus());

    // System-audio parser (Nyx listens to the other party): on/off toggle.
    ipcMain.handle("session-toggle-system-audio", () => {
      const enabled = !speechService.isSystemAudioEnabled();
      speechService.setSystemAudioEnabled(enabled);
      windowManager.broadcastToAllWindows("session-status-changed", sessionLifecycle.getStatus());
      return enabled;
    });
    ipcMain.handle("session-get-system-audio", () => speechService.isSystemAudioEnabled());

    ipcMain.handle("session-smart-mode", (_e, enabled) => {
      const on = sessionLifecycle.setSmartMode(enabled);
      windowManager.broadcastToAllWindows("session-status-changed", sessionLifecycle.getStatus());
      return on;
    });

    // Nyx "Resume Session": continue a saved meeting's listening session.
    ipcMain.handle("session-resume", (_e, meetingId) => {
      const result = sessionLifecycle.resume(meetingId);
      if (result.ok) {
        try {
          if (speechService.isAvailable && speechService.isAvailable() && !speechService.getStatus().isRecording) {
            speechService.startRecording();
          }
        } catch (err) {
          logger.warn("Could not auto-start speech for resumed session", { error: err.message });
        }
      }
      windowManager.broadcastToAllWindows("session-status-changed", sessionLifecycle.getStatus());
      return result;
    });

    ipcMain.handle("session-toggle-audio", () => {
      const enabled = sessionLifecycle.toggleAudio();
      // Pausing Listen pauses the mic too.
      try {
        if (!enabled && speechService.getStatus && speechService.getStatus().isRecording) {
          speechService.stopRecording();
        } else if (enabled && speechService.isAvailable && speechService.isAvailable() &&
                   sessionLifecycle.isActive() && !speechService.getStatus().isRecording) {
          speechService.startRecording();
        }
      } catch (_) { /* ignore */ }
      windowManager.broadcastToAllWindows("session-status-changed", sessionLifecycle.getStatus());
      return enabled;
    });

    ipcMain.handle("session-get-transcript", () => sessionLifecycle.getTranscriptText());

    ipcMain.handle("live-action-run", async (event, actionId) => {
      try {
        let full = "";
        const result = await sessionLifecycle.runAction(actionId, llmService, {
          onDelta: (d) => {
            full += d;
            try { event.sender.send("live-action-delta", d); } catch (_) {}
          },
        });
        sessionManager.addModelResponse(result.response, { skill: "meeting", action: actionId });
        return result;
      } catch (e) {
        logger.error("Live action failed", { actionId, error: e.message });
        return { response: "", metadata: { error: e.message } };
      }
    });

    ipcMain.handle("live-ask", async (event, question) => {
      try {
        const result = await sessionLifecycle.askAboutTranscript(question, llmService, {
          onDelta: (d) => {
            try { event.sender.send("live-action-delta", d); } catch (_) {}
          },
        });
        sessionManager.addModelResponse(result.response, { skill: "meeting", action: "ask" });
        return result;
      } catch (e) {
        logger.error("Live ask failed", { error: e.message });
        return { response: "", metadata: { error: e.message } };
      }
    });

    // ── Meeting notes (Dashboard Activity) ──────────────────────────────
    ipcMain.handle("meetings-list", () => sessionLifecycle.listMeetings());
    ipcMain.handle("meeting-get", (_e, id) => sessionLifecycle.getMeeting(id));
    ipcMain.handle("meeting-update", (_e, { id, patch }) =>
      sessionLifecycle.updateMeetingNotes(id, patch || {}));
    ipcMain.handle("meeting-delete", (_e, id) => sessionLifecycle.deleteMeeting(id));
    ipcMain.handle("meeting-share", (_e, id) => {
      const m = sessionLifecycle.getMeeting(id);
      if (!m) return null;
      // Local-first "share" (Nyx "Share notes — generate a public link"):
      // write a standalone HTML summary into userData/shared-notes and return
      // its file:// URL. No server, no upload — the link works offline and can
      // be attached to emails/chat, and the URL is copied to the clipboard.
      const esc2 = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
      const md = (t) => esc2(t).replace(/\n/g, "<br>");
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc2(m.title)}</title></head>
<body style="font-family:sans-serif;max-width:760px;margin:40px auto;color:#222">
<h1>${esc2(m.title)}</h1>
<p style="color:#777">${esc2(m.startedAt || "")} — ${esc2(m.endedAt || "")}</p>
<h2>Notes</h2><div>${md(m.detailedNotes)}</div>
<h2>Key Insights</h2><div>${md(m.keyInsights)}</div>
<h2>Next Steps</h2><div>${md(m.nextSteps)}</div>
</body></html>`;
      try {
        const fsMod = require("fs");
        const pathMod = require("path");
        const shareDir = pathMod.join(app.getPath("userData"), "shared-notes");
        // 0o700 dir / 0o600 file: meeting notes must not be readable by other
        // local accounts on shared Linux machines (umask 022 would expose them).
        fsMod.mkdirSync(shareDir, { recursive: true, mode: 0o700 });
        const safeName = String(id).replace(/[^a-zA-Z0-9_-]/g, "");
        const filePath = pathMod.join(shareDir, `${safeName || "meeting"}.html`);
        fsMod.writeFileSync(filePath, html, { encoding: "utf8", mode: 0o600 });
        const url = require("url").pathToFileURL(filePath).toString();
        try { require("electron").clipboard.writeText(url); } catch (_) { /* ignore */ }
        logger.info("Meeting share link created", { id, url });
        return { url };
      } catch (e) {
        logger.error("Failed to write share link", { id, error: e.message });
        return { url: null, error: e.message };
      }
    });
    ipcMain.handle("meeting-followup-email", async (_e, id) => {
      try {
        return await sessionLifecycle.generateFollowUpEmailForMeeting(id, llmService);
      } catch (e) {
        logger.error("Follow-up email generation failed", { id, error: e.message });
        return null;
      }
    });
    ipcMain.handle("meeting-coaching", async (_e, id) => {
      try {
        return await sessionLifecycle.generateMissedOpportunitiesForMeeting(id, llmService);
      } catch (e) {
        logger.error("Coaching generation failed", { id, error: e.message });
        return null;
      }
    });

    // ── Call score + analytics (Nyx: Call Coaching & Analytics) ────────
    ipcMain.handle("meeting-score", async (_e, id) => {
      try {
        return await sessionLifecycle.generateCallScoreForMeeting(id, llmService);
      } catch (e) {
        logger.error("Call scoring failed", { id, error: e.message });
        return { error: e.message };
      }
    });
    ipcMain.handle("analytics-summary", () => sessionLifecycle.getMeetingAnalytics());

    // ── Customize: modes + knowledge base ────────────────────────────────
    ipcMain.handle("modes-list", () => customizeManager.listModes());
    ipcMain.handle("mode-get", (_e, id) => customizeManager.getMode(id));
    ipcMain.handle("mode-upsert", (_e, mode) => customizeManager.upsertMode(mode));
    ipcMain.handle("mode-delete", (_e, id) => customizeManager.deleteMode(id));
    ipcMain.handle("mode-set-active", (_e, id) => {
      const active = customizeManager.setActiveMode(id);
      windowManager.broadcastToAllWindows("mode-changed", { id: active });
      return active;
    });
    ipcMain.handle("mode-get-active", () => {
      const mode = customizeManager.getActiveMode();
      return mode ? mode.id : null;
    });
    ipcMain.handle("knowledge-list", () => customizeManager.listKnowledge());
    ipcMain.handle("knowledge-add", (_e, { title, content }) => customizeManager.addKnowledge(title, content));
    ipcMain.handle("knowledge-delete", (_e, id) => customizeManager.deleteKnowledge(id));
    // Web-link knowledge source (Nyx: help centers / web pages → knowledge).
    ipcMain.handle("knowledge-add-url", async (_e, { title, url }) => {
      try {
        return await customizeManager.addKnowledgeFromUrl(title, url);
      } catch (e) {
        logger.error("Knowledge URL fetch failed", { url, error: e.message });
        return { error: e.message };
      }
    });

    // ── Custom live actions (Nyx: prompts + links as one-click chips) ──
    ipcMain.handle("custom-actions-list", () => sessionLifecycle.listCustomActions());
    ipcMain.handle("custom-action-get", (_e, id) => sessionLifecycle.getCustomAction(id));
    ipcMain.handle("custom-action-add", (_e, action) => {
      const created = sessionLifecycle.addCustomAction(action || {});
      windowManager.broadcastToAllWindows("custom-actions-changed", { id: created.id });
      return created;
    });
    ipcMain.handle("custom-action-update", (_e, { id, patch }) => {
      const updated = sessionLifecycle.updateCustomAction(id, patch || {});
      if (updated) windowManager.broadcastToAllWindows("custom-actions-changed", { id });
      return updated;
    });
    ipcMain.handle("custom-action-delete", (_e, id) => {
      const deleted = sessionLifecycle.deleteCustomAction(id);
      if (deleted) windowManager.broadcastToAllWindows("custom-actions-changed", { id });
      return deleted;
    });

    // ── Notes template (Nyx: custom meeting notes templates) ───────────
    ipcMain.handle("notes-template-get", () => sessionLifecycle.getNotesTemplate());
    ipcMain.handle("notes-template-set", (_e, template) => {
      try {
        sessionLifecycle.setNotesTemplate(template);
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });
    ipcMain.handle("notes-template-reset", () => {
      sessionLifecycle.resetNotesTemplate();
      return { success: true };
    });

    // ── Pre-call briefs ──────────────────────────────────────────────────
    ipcMain.handle("calendar-sources-list", () => preCallManager.listSources());
    ipcMain.handle("calendar-source-add", (_e, source) => preCallManager.addSource(source));
    ipcMain.handle("calendar-source-remove", (_e, id) => preCallManager.removeSource(id));
    ipcMain.handle("calendar-refresh", async () => await preCallManager.refreshAll());
    ipcMain.handle("calendar-upcoming", () => preCallManager.getUpcomingMeetings());
    ipcMain.handle("precall-brief", async (_e, meeting) => {
      try {
        return await preCallManager.generateBrief(meeting, llmService);
      } catch (e) {
        logger.error("Pre-call brief failed", { error: e.message });
        return `Brief generation failed: ${e.message}`;
      }
    });

    // ── Output language (Nyx setting) ─────────────────────────────────
    ipcMain.handle("get-output-language", () => process.env.OUTPUT_LANGUAGE || "English");
    ipcMain.handle("set-output-language", (_e, lang) => {
      const persisted = this.persistEnvUpdates({ OUTPUT_LANGUAGE: String(lang || "English") });
      return persisted.length > 0;
    });

    // ── Nyx settings parity: invisibility / display / auto-launch ────
    ipcMain.handle("set-invisibility-mode", (_e, mode) => {
      const enabled = String(mode) !== "off";
      const applied = windowManager.setContentProtectionEnabled(enabled);
      this.persistEnvUpdates({ INVISIBILITY_MODE: enabled ? "on" : "off" });
      return { success: true, enabled: applied };
    });
    ipcMain.handle("get-invisibility-mode", () =>
      (process.env.INVISIBILITY_MODE || "on").toLowerCase() !== "off");

    ipcMain.handle("set-preferred-display", (_e, displayId) => {
      const ok = windowManager.moveToDisplay(displayId);
      if (ok) this.persistEnvUpdates({ PREFERRED_DISPLAY_ID: String(displayId) });
      return { success: ok };
    });
    ipcMain.handle("list-displays-for-settings", () => {
      const { screen } = require("electron");
      const primaryId = screen.getPrimaryDisplay().id;
      return screen.getAllDisplays().map((d, i) => ({
        id: d.id,
        label: `Display ${i + 1} (${d.size.width}×${d.size.height})${d.id === primaryId ? " — primary" : ""}`,
      }));
    });

    ipcMain.handle("set-auto-launch", (_e, enabled) => {
      try {
        const willLaunch = !!enabled;
        app.setLoginItemSettings({ openAtLogin: willLaunch, args: ["--hidden"] });
        this.persistEnvUpdates({ AUTO_LAUNCH: willLaunch ? "on" : "off" });
        logger.info("Auto-launch updated", { openAtLogin: willLaunch });
        return { success: true, enabled: willLaunch };
      } catch (e) {
        logger.error("Failed to set auto-launch", { error: e.message });
        return { success: false, error: e.message };
      }
    });
    ipcMain.handle("get-auto-launch", () => {
      try {
        return app.getLoginItemSettings().openAtLogin;
      } catch (_) {
        return String(process.env.AUTO_LAUNCH || "off").toLowerCase() === "on";
      }
    });

    ipcMain.handle("get-app-version", () => ({
      version: app.getVersion(),
      electron: process.versions.electron,
    }));

    // Calendar auto-attend toggle (scheduler reads CALENDAR_AUTO_ATTEND each tick)
    ipcMain.handle("set-calendar-auto-attend", (_e, enabled) => {
      const on = !!enabled;
      this.persistEnvUpdates({ CALENDAR_AUTO_ATTEND: on ? "true" : "false" });
      return { success: true, enabled: on };
    });
    ipcMain.handle("get-calendar-auto-attend", () =>
      String(process.env.CALENDAR_AUTO_ATTEND || "true").toLowerCase() !== "false");

    // ── Editable keyboard shortcuts (Nyx Settings → Shortcuts) ────────
    ipcMain.handle("get-shortcuts", () => {
      const defaults = ApplicationController.DEFAULT_SHORTCUTS;
      return Object.entries(defaults).map(([id, def]) => ({
        id,
        default: def,
        accelerator: this.getShortcutAccelerator(id),
        disabled: this.getShortcutAccelerator(id) === null,
      }));
    });
    ipcMain.handle("set-shortcut", (_e, { id, accelerator }) => {
      const actions = this.getShortcutActions();
      if (!actions[id]) return { success: false, error: `Unknown shortcut: ${id}` };
      const value = !accelerator || String(accelerator).trim().toLowerCase() === "disabled"
        ? "disabled"
        : String(accelerator).trim();
      const persisted = this.persistEnvUpdates({ [`SHORTCUT_${id.toUpperCase()}`]: value });
      // Re-register everything so the change applies immediately.
      this.registerShortcutsFromSettings();
      return { success: persisted.length > 0, accelerator: this.getShortcutAccelerator(id) };
    });
    ipcMain.handle("reset-shortcuts", () => {
      const updates = {};
      for (const id of Object.keys(ApplicationController.DEFAULT_SHORTCUTS)) {
        updates[`SHORTCUT_${id.toUpperCase()}`] = "";
      }
      this.persistEnvUpdates(updates);
      this.registerShortcutsFromSettings();
      return { success: true };
    });

    // NVIDIA NIM key management (renamed from Gemini, legacy names preserved)
    ipcMain.handle("set-llm-api-key", (event, apiKey) => {
      llmService.updateApiKey(apiKey);
      return llmService.getStats();
    });

    ipcMain.handle("get-llm-status", () => {
      return llmService.getStats();
    });

    // Switch the active LLM backend at runtime ('nvidia' | 'gemini').
    ipcMain.handle("set-llm-provider", (event, provider) => {
      try {
        return { success: true, stats: llmService.setProvider(provider) };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle("test-llm-connection", async () => {
      return await llmService.testConnection();
    });

    ipcMain.handle("run-llm-diagnostics", async () => {
      try {
        const connectivity = await llmService.checkNetworkConnectivity();
        const apiTest = await llmService.testConnection();
        return {
          success: true,
          connectivity,
          apiTest,
          timestamp: new Date().toISOString()
        };
      } catch (error) {
        return {
          success: false,
          error: error.message,
          timestamp: new Date().toISOString()
        };
      }
    });

    ipcMain.handle("show-settings", () => {
      windowManager.showSettings();

      // Send current settings to the settings window
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        const currentSettings = this.getSettings();
        setTimeout(() => {
          settingsWindow.webContents.send("load-settings", currentSettings);
        }, 100);
      }

      return { success: true };
    });

    ipcMain.handle("get-settings", () => {
      return this.getSettings();
    });

    // First-run onboarding status — renderer can query to know whether
    // to show the welcome banner / prompt for API-key entry.
    ipcMain.handle("get-first-run-status", () => {
      try {
        return this.firstRunManager.getStatus();
      } catch (e) {
        logger.warn("Failed to get first-run status", { error: e.message });
        return { needsOnboarding: false, error: e.message };
      }
    });

    ipcMain.handle("complete-first-run", async () => {
      try {
        this.firstRunManager.markCompleted();
        this.isFirstRun = false;
        // Reinitialize speech service with the latest persisted settings
        // so the mic button reflects the provider/command set during onboarding.
        speechService.initializeClient();
        this.speechAvailable = speechService.isAvailable
          ? speechService.isAvailable()
          : false;
        // Show the main overlay window now that onboarding is done
        // and API keys are configured.
        await windowManager.showMainWindow();
        // Broadcast speech availability so the mic button appears
        const { BrowserWindow } = require("electron");
        BrowserWindow.getAllWindows().forEach((win) => {
          if (!win.isDestroyed()) {
            win.webContents.send("speech-availability", { available: this.speechAvailable });
          }
        });
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    // Open a URL in the system browser (used by the GitHub star button
    // in onboarding).
    ipcMain.handle("open-external", async (_event, url) => {
      try {
        if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
          return { ok: false, error: "Invalid URL" };
        }
        const { shell } = require("electron");
        await shell.openExternal(url);
        return { ok: true };
      } catch (e) {
        logger.warn("Failed to open external URL", { url, error: e.message });
        return { ok: false, error: e.message };
      }
    });

    // Close the onboarding wizard window.
    ipcMain.handle("close-onboarding", () => {
      try {
        windowManager.closeOnboarding();
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    });

    ipcMain.handle("save-settings", (event, settings) => {
      return this.saveSettings(settings);
    });

    ipcMain.handle("update-app-icon", (event, iconKey) => {
      return this.updateAppIcon(iconKey);
    });

    ipcMain.handle("update-active-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-changed", { skill });
      return { success: true };
    });

    ipcMain.handle("restart-app-for-stealth", () => {
      // Force restart the app to ensure stealth name changes take effect
      const { app } = require("electron");
      app.relaunch();
      app.exit();
    });

    ipcMain.handle("close-window", (event) => {
      const webContents = event.sender;
      const window = windowManager.windows.forEach((win, type) => {
        if (win.webContents === webContents) {
          win.hide();
          return true;
        }
      });
      return { success: true };
    });

    // LLM window specific handlers
    ipcMain.handle("expand-llm-window", (event, contentMetrics) => {
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("resize-llm-window-for-content", (event, contentMetrics) => {
      // Use the same expansion logic for now, can be enhanced later
      windowManager.expandLLMWindow(contentMetrics);
      return { success: true, contentMetrics };
    });

    ipcMain.handle("quit-app", () => {
      logger.info("Quit app requested via IPC");
      try {
        // Force quit the application
        const { app } = require("electron");

        // Close all windows first
        windowManager.destroyAllWindows();

        // Unregister shortcuts
        globalShortcut.unregisterAll();

        // Force quit
        app.quit();

        // If the above doesn't work, force exit
        setTimeout(() => {
          process.exit(0);
        }, 2000);
      } catch (error) {
        logger.error("Error during quit:", error);
        process.exit(1);
      }
    });

    // Handle close settings
    ipcMain.on("close-settings", () => {
      const settingsWindow = windowManager.getWindow("settings");
      if (settingsWindow) {
        settingsWindow.hide();
      }
    });

    // Handle save settings (synchronous)
    ipcMain.on("save-settings", (event, settings) => {
      this.saveSettings(settings);
    });

    // Handle update skill
    ipcMain.on("update-skill", (event, skill) => {
      this.activeSkill = skill;
      windowManager.broadcastToAllWindows("skill-updated", { skill });
    });

    // Handle quit app (alternative method)
    ipcMain.on("quit-app", () => {
      logger.info("Quit app requested via IPC (on method)");
      try {
        const { app } = require("electron");
        windowManager.destroyAllWindows();
        globalShortcut.unregisterAll();
        app.quit();
        setTimeout(() => process.exit(0), 1000);
      } catch (error) {
        logger.error("Error during quit (on method):", error);
        process.exit(1);
      }
    });
  }

  /**
   * Nyx Ctrl+Enter: "Ask AI anything about your screen, audio, or chat".
   * Captures the screen, sends it with the live transcript to the LLM, and
   * streams the answer into the Live Insights card.
   */
  async screenAssist() {
    try {
      logger.info("Screen assist triggered (Ctrl+Enter)");
      windowManager.broadcastToAllWindows("screen-assist-started", {});
      windowManager.showLiveInsights();

      const capture = await captureService.captureAndProcess();
      if (!capture.imageBuffer || !capture.imageBuffer.length) {
        windowManager.broadcastToAllWindows("live-action-result", { error: "Failed to capture screen" });
        return;
      }

      const transcript = sessionLifecycle.getTranscriptText(6000);
      const base64 = capture.imageBuffer.toString("base64");
      const messages = [];
      const custom = llmService.getActiveCustomPrompt();
      if (custom) messages.push({ role: "system", content: custom });
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: transcript
              ? `The user pressed Ctrl+Enter. Answer their on-screen problem. Recent conversation transcript for context:\n${transcript}\n\nAnalyze the attached screenshot and give a direct, complete answer.`
              : "The user pressed Ctrl+Enter. Analyze the attached screenshot and give a direct, complete answer.",
          },
          { type: "image_url", image_url: { url: `data:${capture.mimeType || "image/png"};base64,${base64}` } },
        ],
      });

      let full = "";
      const answer = await llmService.chatCompletion(messages, {
        onDelta: (d) => {
          full += d;
          windowManager.broadcastToAllWindows("live-action-delta", d);
        },
      });
      sessionManager.addModelResponse(answer, { skill: this.activeSkill, screenAssist: true });
      windowManager.broadcastToAllWindows("live-action-result", { ok: true });
    } catch (error) {
      logger.error("Screen assist failed", { error: error.message });
      windowManager.broadcastToAllWindows("live-action-result", { error: error.message });
    }
  }

  /**
   * Nyx Ctrl+Shift+Enter: stealth "Get Answer" — analyzes the screen and
   * streams the answer into the plain llm-response overlay (no insights card),
   * for undetectable answers during invisibility mode.
   */
  async stealthAnswer() {
    try {
      logger.info("Stealth answer triggered (Ctrl+Shift+Enter)");
      const capture = await captureService.captureAndProcess();
      if (!capture.imageBuffer || !capture.imageBuffer.length) return;

      windowManager.showLLMLoading();
      const captureMeta = capture;
      const base64 = captureMeta.imageBuffer.toString("base64");
      const messages = [
        {
          role: "user",
          content: [
            { type: "text", text: "Analyze this screenshot and give a direct, complete answer with code in fenced blocks if relevant." },
            { type: "image_url", image_url: { url: `data:${captureMeta.mimeType || "image/png"};base64,${base64}` } },
          ],
        },
      ];

      this._responseSeq = (this._responseSeq || 0) + 1;
      const messageId = `stealth-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", { messageId, skill: this.activeSkill });

      let full = "";
      const answer = await llmService.chatCompletion(messages, {
        onDelta: (d) => {
          full += d;
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", { messageId, delta: d });
        },
      });
      sessionManager.addModelResponse(answer, { skill: this.activeSkill, stealth: true });
      windowManager.showLLMResponse(answer, { skill: this.activeSkill, stealth: true });
    } catch (error) {
      logger.error("Stealth answer failed", { error: error.message });
      windowManager.hideLLMResponse();
    }
  }

  toggleSpeechRecognition() {
    const isAvailable = typeof speechService.isAvailable === 'function' ? speechService.isAvailable() : !!speechService.getStatus?.().isInitialized;
    if (!isAvailable) {
      logger.warn("Speech recognition unavailable; toggle ignored");
      try {
        windowManager.broadcastToAllWindows("speech-status", { status: 'Speech recognition unavailable', available: false });
        windowManager.broadcastToAllWindows("speech-availability", { available: false });
      } catch (e) {}
      return;
    }
    const currentStatus = speechService.getStatus();
    if (currentStatus.isRecording) {
      try {
        speechService.stopRecording();
        logger.info("Speech recognition stopped via global shortcut");
      } catch (error) {
        logger.error("Error stopping speech recognition:", error);
      }
    } else {
      try {
        speechService.startRecording();
        windowManager.showChatWindow();
        logger.info("Speech recognition started via global shortcut");
      } catch (error) {
        logger.error("Error starting speech recognition:", error);
      }
    }
  }

  clearSessionMemory() {
    try {
      sessionManager.clear();
      windowManager.broadcastToAllWindows("session-cleared");
      logger.info("Session memory cleared via global shortcut");
    } catch (error) {
      logger.error("Error clearing session memory:", error);
    }
  }

  handleUpArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to previous skill
      this.navigateSkill(-1);
    } else {
      // Non-interactive mode: Move window up
      windowManager.moveBoundWindows(0, -20);
    }
  }

  handleDownArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (isInteractive) {
      // Interactive mode: Navigate to next skill
      this.navigateSkill(1);
    } else {
      // Non-interactive mode: Move window down
      windowManager.moveBoundWindows(0, 20);
    }
  }

  handleLeftArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window left
      windowManager.moveBoundWindows(-20, 0);
    }
    // Interactive mode: Left arrow does nothing
  }

  handleRightArrow() {
    const isInteractive = windowManager.getWindowStats().isInteractive;

    if (!isInteractive) {
      // Non-interactive mode: Move window right
      windowManager.moveBoundWindows(20, 0);
    }
    // Interactive mode: Right arrow does nothing
  }

  navigateSkill(direction) {
    const availableSkills = [
      "dsa",
    ];

    const currentIndex = availableSkills.indexOf(this.activeSkill);
    if (currentIndex === -1) {
      logger.warn("Current skill not found in available skills", {
        currentSkill: this.activeSkill,
        availableSkills,
      });
      return;
    }

    // Calculate new index with wrapping
    let newIndex = currentIndex + direction;
    if (newIndex >= availableSkills.length) {
      newIndex = 0; // Wrap to beginning
    } else if (newIndex < 0) {
      newIndex = availableSkills.length - 1; // Wrap to end
    }

    const newSkill = availableSkills[newIndex];
    this.activeSkill = newSkill;

    // Update session manager with the new skill
    sessionManager.setActiveSkill(newSkill);

    logger.info("Skill navigated via global shortcut", {
      from: availableSkills[currentIndex],
      to: newSkill,
      direction: direction > 0 ? "down" : "up",
    });

    // Broadcast the skill change to all windows
    windowManager.broadcastToAllWindows("skill-updated", { skill: newSkill });
  }

  async triggerScreenshotOCR() {
    if (!this.isReady) {
      logger.warn("Screenshot requested before application ready");
      return;
    }

    const startTime = Date.now();

    try {
      windowManager.showLLMLoading();

  const capture = await captureService.captureAndProcess();

      if (!capture.imageBuffer || !capture.imageBuffer.length) {
        windowManager.hideLLMResponse();
        this.broadcastOCRError("Failed to capture screenshot image");
        return;
      }

      // Use image directly with LLM and active skill; do not send chat messages here
      const sessionHistory = sessionManager.getOptimizedHistory();

      const skillsRequiringProgrammingLanguage = ['dsa'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      this._responseSeq = (this._responseSeq || 0) + 1;
      const messageId = `img-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });

      const llmResult = await llmService.processImageWithSkillStream(
        capture.imageBuffer,
        capture.mimeType || 'image/png',
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true
      });

      this.broadcastTranscriptionLLMResponse(llmResult);

      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isImageAnalysis: true
      });
    } catch (error) {
      logger.error("Screenshot OCR process failed", {
        error: error.message,
        duration: Date.now() - startTime,
      });

      windowManager.hideLLMResponse();
      this.broadcastOCRError(error.message);
      
      sessionManager.addConversationEvent({
        role: 'system',
        content: `Screenshot OCR failed: ${error.message}`,
        action: 'ocr_error',
        metadata: {
          error: error.message
        }
      });
    }
  }

  async processWithLLM(text, sessionHistory) {
    try {
      // Add user input to session memory
      sessionManager.addUserInput(text, 'llm_input');

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['dsa'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      this._responseSeq = (this._responseSeq || 0) + 1;
      const messageId = `chat-${Date.now()}-${this._responseSeq}`;
      windowManager.broadcastToAllWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      windowManager.showLLMLoading();

      const llmResult = await llmService.processTextWithSkillStream(
        text,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          windowManager.broadcastToAllWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      logger.info("LLM processing completed, showing response", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime,
        responsePreview: llmResult.response.substring(0, 200) + "...",
      });

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });

      this.broadcastTranscriptionLLMResponse(llmResult);

      windowManager.showLLMResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
      });
    } catch (error) {
      logger.error("LLM processing failed", {
        error: error.message,
        skill: this.activeSkill,
      });

      windowManager.hideLLMResponse();
      sessionManager.addConversationEvent({
        role: 'system',
        content: `LLM processing failed: ${error.message}`,
        action: 'llm_error',
        metadata: {
          error: error.message,
          skill: this.activeSkill
        }
      });

      this.broadcastLLMError(error.message);
    }
  }

  /**
   * Buffer a transcribed fragment and (re)arm the coalesce debounce. Fragments
   * are shown in the UI immediately so speech feels live, but the LLM is only
   * asked once the speaker has actually paused — this is what stops one spoken
   * line from producing two separate, slow answers.
   */
  handleTranscriptionFragment(text, meta = {}) {
    const fragment = (text || "").trim();
    if (!fragment) {
      return;
    }

    // Route speech UI events according to the user's response-target setting.
    sessionManager.addUserInput(fragment, meta.source === 'system' ? 'system-speech' : 'speech');
    this.sendToVoiceResponseWindows("transcription-received", { text: fragment });

    // Live-session Listen mode: append to the meeting transcript and refresh
    // dynamic insights while a session is active. System-audio fragments are
    // tagged speaker='other' so notes distinguish who said what.
    if (sessionLifecycle.isActive()) {
      sessionLifecycle.addTranscriptEntry(fragment, {
        source: meta.source === 'system' ? 'system' : 'speech',
        speaker: meta.source === 'system' ? 'other' : 'user',
      });
      const insights = sessionLifecycle.detectDynamicInsights();
      windowManager.broadcastToAllWindows("live-dynamic-insights", insights);
    }

    this._utteranceBuffer = this._utteranceBuffer
      ? `${this._utteranceBuffer} ${fragment}`
      : fragment;

    if (this._utteranceTimer) {
      clearTimeout(this._utteranceTimer);
      this._utteranceTimer = null;
    }

    // Manual capture emits one complete transcript after the user presses stop,
    // so no debounce/coalescing delay is needed.
    if (speechService.isManualCaptureMode()) {
      this.dispatchCoalescedUtterance();
      return;
    }

    this._utteranceTimer = setTimeout(() => {
      this._utteranceTimer = null;
      this.dispatchCoalescedUtterance();
    }, this._utteranceCoalesceMs);
  }

  /**
   * Send the coalesced utterance to the LLM. If a previous dispatch is still
   * running, leave the buffer intact and let that dispatch's completion pick it
   * up — so we never pile up overlapping requests for the same person talking.
   */
  async dispatchCoalescedUtterance() {
    if (this._utteranceDispatchInFlight) {
      return;
    }
    const combined = this._utteranceBuffer.trim();
    if (!combined) {
      return;
    }
    this._utteranceBuffer = "";
    this._utteranceDispatchInFlight = true;

    try {
      const sessionHistory = sessionManager.getOptimizedHistory();
      await this.processTranscriptionWithLLM(combined, sessionHistory);
    } catch (error) {
      logger.error("Failed to process transcription with LLM", {
        error: error.message,
        text: combined.substring(0, 100)
      });
    } finally {
      this._utteranceDispatchInFlight = false;
      // Anything that arrived while we were busy gets answered now.
      if (this._utteranceBuffer.trim()) {
        this.dispatchCoalescedUtterance();
      }
    }
  }

  async processTranscriptionWithLLM(text, sessionHistory) {
    // Hoisted so the catch block can tie a fallback answer to the same UI
    // bubble the streaming start event created; otherwise a total failure
    // leaves an empty streamed bubble stranded next to the fallback message.
    let messageId = null;
    try {
      // Validate input text
      if (!text || typeof text !== 'string' || text.trim().length === 0) {
        logger.warn("Skipping LLM processing for empty or invalid transcription", {
          textType: typeof text,
          textLength: text ? text.length : 0
        });
        return;
      }

      const cleanText = text.trim();
      if (cleanText.length < 2) {
        logger.debug("Skipping LLM processing for very short transcription", {
          text: cleanText
        });
        return;
      }

      logger.info("Processing transcription with intelligent LLM response", {
        skill: this.activeSkill,
        textLength: cleanText.length,
        textPreview: cleanText.substring(0, 100) + "..."
      });

      // Check if current skill needs programming language context
      const skillsRequiringProgrammingLanguage = ['dsa'];
      const needsProgrammingLanguage = skillsRequiringProgrammingLanguage.includes(this.activeSkill);

      // Stream the answer progressively to the configured speech target.
      // A unique messageId ties the start/chunk/final events to one bubble so
      // the UI never duplicates or interleaves concurrent responses.
      this._responseSeq = (this._responseSeq || 0) + 1;
      messageId = `tr-${Date.now()}-${this._responseSeq}`;
      this.sendToVoiceResponseWindows("transcription-llm-response-start", {
        messageId,
        skill: this.activeSkill
      });
      if (this.shouldShowVoiceOverlay()) {
        windowManager.showLLMLoading();
      }
      const llmResult = await llmService.processTranscriptionWithIntelligentResponseStream(
        cleanText,
        this.activeSkill,
        sessionHistory.recent,
        needsProgrammingLanguage ? this.codingLanguage : null,
        (delta) => {
          this.sendToVoiceResponseWindows("transcription-llm-response-chunk", {
            messageId,
            delta
          });
        }
      );
      llmResult.metadata = { ...llmResult.metadata, messageId };

      // Add LLM response to session memory
      sessionManager.addModelResponse(llmResult.response, {
        skill: this.activeSkill,
        processingTime: llmResult.metadata.processingTime,
        usedFallback: llmResult.metadata.usedFallback,
        isTranscriptionResponse: true
      });

      this.sendTranscriptionLLMResponseToVoiceTargets(llmResult);
      if (this.shouldShowVoiceOverlay()) {
        windowManager.showLLMResponse(llmResult.response, {
          skill: this.activeSkill,
          processingTime: llmResult.metadata.processingTime,
          usedFallback: llmResult.metadata.usedFallback,
          isTranscriptionResponse: true
        });
      }

      logger.info("Transcription LLM response completed", {
        responseLength: llmResult.response.length,
        skill: this.activeSkill,
        programmingLanguage: needsProgrammingLanguage ? this.codingLanguage : 'not applicable',
        processingTime: llmResult.metadata.processingTime
      });

    } catch (error) {
      logger.error("Transcription LLM processing failed", {
        error: error.message,
        errorStack: error.stack,
        skill: this.activeSkill,
        text: text ? text.substring(0, 100) : 'undefined'
      });

      // Try to provide a fallback response
      try {
        const fallbackResult = llmService.generateIntelligentFallbackResponse(text, this.activeSkill);
        // Carry the streaming messageId so the target replaces the live
        // bubble instead of leaving it stuck and appending a duplicate.
        if (messageId) {
          fallbackResult.metadata = { ...fallbackResult.metadata, messageId };
        }

        sessionManager.addModelResponse(fallbackResult.response, {
          skill: this.activeSkill,
          processingTime: fallbackResult.metadata.processingTime,
          usedFallback: true,
          isTranscriptionResponse: true,
          fallbackReason: error.message
        });

        this.sendTranscriptionLLMResponseToVoiceTargets(fallbackResult);
        if (this.shouldShowVoiceOverlay()) {
          windowManager.showLLMResponse(fallbackResult.response, {
            skill: this.activeSkill,
            processingTime: fallbackResult.metadata.processingTime,
            usedFallback: true,
            isTranscriptionResponse: true
          });
        }
        logger.info("Used fallback response for transcription", {
          skill: this.activeSkill,
          fallbackResponse: fallbackResult.response
        });
        
      } catch (fallbackError) {
        logger.error("Fallback response also failed", {
          fallbackError: fallbackError.message
        });

        sessionManager.addConversationEvent({
          role: 'system',
          content: `Transcription LLM processing failed: ${error.message}`,
          action: 'transcription_llm_error',
          metadata: {
            error: error.message,
            skill: this.activeSkill
          }
        });
      }
    }
  }

  broadcastOCRSuccess(ocrResult) {
    windowManager.broadcastToAllWindows("ocr-completed", {
      text: ocrResult.text,
      metadata: ocrResult.metadata,
    });
  }

  broadcastOCRError(errorMessage) {
    windowManager.broadcastToAllWindows("ocr-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastLLMSuccess(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      skill: this.activeSkill, // Add the current active skill to the top level
    };

    logger.info("Broadcasting LLM success to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      dataKeys: Object.keys(broadcastData),
      responsePreview: llmResult.response.substring(0, 100) + "...",
    });

    windowManager.broadcastToAllWindows("llm-response", broadcastData);
  }

  broadcastLLMError(errorMessage) {
    windowManager.broadcastToAllWindows("llm-error", {
      error: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcastTranscriptionLLMResponse(llmResult) {
    const broadcastData = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };

    logger.info("Broadcasting transcription LLM response to all windows", {
      responseLength: llmResult.response.length,
      skill: this.activeSkill,
      responsePreview: llmResult.response.substring(0, 100) + "..."
    });

    windowManager.broadcastToAllWindows("transcription-llm-response", broadcastData);
  }

  sendToChatWindow(channel, data) {
    const chatWindow = windowManager.getWindow("chat");
    if (!chatWindow || chatWindow.isDestroyed()) {
      logger.warn("Chat window unavailable for speech event", { channel });
      return;
    }
    chatWindow.webContents.send(channel, data);
  }

  getVoiceResponseTarget() {
    const configured = String(process.env.VOICE_RESPONSE_TARGET || 'both').trim().toLowerCase();
    return ['chat', 'overlay', 'both'].includes(configured) ? configured : 'both';
  }

  shouldShowVoiceOverlay() {
    return ['overlay', 'both'].includes(this.getVoiceResponseTarget());
  }

  sendToVoiceResponseWindows(channel, data) {
    const target = this.getVoiceResponseTarget();
    if (target === 'chat' || target === 'both') {
      this.sendToChatWindow(channel, data);
    }
    if (target === 'overlay' || target === 'both') {
      const responseWindow = windowManager.getWindow("llmResponse");
      if (responseWindow && !responseWindow.isDestroyed()) {
        responseWindow.webContents.send(channel, data);
      }
    }
  }

  sendTranscriptionLLMResponseToVoiceTargets(llmResult) {
    const data = {
      response: llmResult.response,
      metadata: llmResult.metadata,
      messageId: llmResult.metadata && llmResult.metadata.messageId,
      skill: this.activeSkill,
      isTranscriptionResponse: true
    };
    this.sendToVoiceResponseWindows("transcription-llm-response", data);
  }

  onWindowAllClosed() {
    if (process.platform !== "darwin") {
      app.quit();
    }
  }

  onActivate() {
    if (!this.isReady && !this.starting) {
      this.onAppReady();
    } else if (this.isReady) {
      // When app is activated, ensure windows appear on current desktop
      const mainWindow = windowManager.getWindow("main");
      if (mainWindow && mainWindow.isVisible()) {
        windowManager.showOnCurrentDesktop(mainWindow);
      }

      // Also handle other visible windows
      windowManager.windows.forEach((window, type) => {
        if (window.isVisible()) {
          windowManager.showOnCurrentDesktop(window);
        }
      });

      logger.debug("App activated - ensured windows appear on current desktop");
    }
  }

  onWillQuit() {
    globalShortcut.unregisterAll();
    speechService.shutdown();
    windowManager.destroyAllWindows();

    const sessionStats = sessionManager.getMemoryUsage();
    logger.info("Application shutting down", {
      sessionEvents: sessionStats.eventCount,
      sessionSize: sessionStats.approximateSize,
    });
  }

  getSettings() {
    // Surface every value the settings UI can edit, reading the live source
    // of truth (process.env) so the UI shows exactly what the running app is
    // using. Empty strings are returned rather than skipped so the UI can
    // distinguish "unset" from "stale value from a previous load".
    return {
      codingLanguage: this.codingLanguage || "cpp",
      activeSkill: this.activeSkill || "dsa",
      appIcon: this.appIcon || "terminal",
      selectedIcon: this.appIcon || "terminal",
      windowGap: windowManager.windowGap,

      geminiKey: process.env.GEMINI_API_KEY || "",
      // Both AI providers ship; LLM_PROVIDER (env/.env) selects the active one.
      // Transcription always runs on Gemini audio (NVIDIA NIM has no audio input).
      nvidiaKey: process.env.NVIDIA_API_KEY || "",
      nvidiaConfigured: !!process.env.NVIDIA_API_KEY,
      geminiConfigured: !!process.env.GEMINI_API_KEY,
      llmProvider: config.get("llm.provider") || "nvidia",
      llmModel: config.get("llm.provider") === "gemini"
        ? config.get("llm.gemini.model")
        : config.get("llm.nvidia.model"),
      outputLanguage: process.env.OUTPUT_LANGUAGE || "English",
      meetingAudioLanguage: process.env.MEETING_AUDIO_LANGUAGE || "auto",

      speechAvailable: this.speechAvailable
    };
  }

  saveSettings(settings) {
    try {
      // ── In-memory updates + window broadcasts ──
      if (settings.codingLanguage) {
        this.codingLanguage = settings.codingLanguage;
        windowManager.broadcastToAllWindows("coding-language-changed", {
          language: settings.codingLanguage,
        });
      }
      if (settings.activeSkill) {
        this.activeSkill = settings.activeSkill;
        windowManager.broadcastToAllWindows("skill-updated", {
          skill: settings.activeSkill,
        });
      }
      if (settings.appIcon) {
        this.appIcon = settings.appIcon;
      }
      if (settings.selectedIcon) {
        this.appIcon = settings.selectedIcon;
        this.updateAppIcon(settings.selectedIcon);
      }
      if (settings.windowGap !== undefined) {
        const gap = Number(settings.windowGap);
        if (Number.isFinite(gap)) windowManager.setWindowGap(gap);
      }

      // ── Persist provider / API-key fields back to .env ──
      const envUpdates = {};
      if (settings.geminiKey !== undefined) {
        envUpdates.GEMINI_API_KEY = settings.geminiKey;
      }
      if (settings.nvidiaKey !== undefined && String(settings.nvidiaKey).trim() !== '') {
        envUpdates.NVIDIA_API_KEY = settings.nvidiaKey;
      }
      if (settings.llmProvider === "nvidia" || settings.llmProvider === "gemini") {
        envUpdates.LLM_PROVIDER = settings.llmProvider;
      }
      if (settings.outputLanguage !== undefined) {
        envUpdates.OUTPUT_LANGUAGE = String(settings.outputLanguage);
      }
      if (settings.meetingAudioLanguage !== undefined) {
        envUpdates.MEETING_AUDIO_LANGUAGE = String(settings.meetingAudioLanguage);
      }

      const persistedKeys = this.persistEnvUpdates(envUpdates);

      // Reinitialize the LLM service when a key OR provider changes so the
      // change takes effect immediately (onboarding + settings flows).
      const keyOrProviderChanged =
        (settings.geminiKey !== undefined && envUpdates.GEMINI_API_KEY !== undefined) ||
        (settings.nvidiaKey !== undefined && envUpdates.NVIDIA_API_KEY !== undefined) ||
        (settings.llmProvider !== undefined && envUpdates.LLM_PROVIDER !== undefined);
      if (keyOrProviderChanged) {
        try {
          llmService.initializeClient();
          logger.info("LLM service reinitialized after key/provider update");
        } catch (e) {
          logger.warn("Failed to reinitialize LLM service after key/provider update", {
            error: e.message
          });
        }
      }

      logger.info("Settings saved successfully", {
        ...settings,
        persistedEnvKeys: persistedKeys
      });
      return { success: true, persistedEnvKeys: persistedKeys };
    } catch (error) {
      logger.error("Failed to save settings", { error: error.message });
      return { success: false, error: error.message };
    }
  }

  persistSettings(settings) {
    // You can extend this to save to a file or database
    // For now, we'll just keep them in memory
    logger.debug("Settings persisted", settings);
  }

  /**
   * Write key=value pairs to the project's .env file. Existing keys are
   * replaced in-place; new keys are appended. Comments and unrelated lines
   * are preserved. Uses an atomic write (temp file + rename) so a crash
   * mid-write cannot corrupt .env.
   *
   * @param {Object<string, string>} updates - keys to upsert
   * @returns {string[]} keys that were actually persisted
   */
  persistEnvUpdates(updates) {
    if (!updates || typeof updates !== "object") return [];
    const keys = Object.keys(updates);
    if (keys.length === 0) return [];

    const fs = require("fs");
    // Single source of truth — the same file dotenv loaded at startup and that
    // FirstRunManager reads/writes (userData in packaged builds, project .env
    // in dev). Writing to process.cwd() here would silently diverge.
    const envPath = ENV_PATH;

    let existing = "";
    try {
      existing = fs.readFileSync(envPath, "utf8");
    } catch (_) {
      // .env doesn't exist yet — we'll create one from scratch
      existing = "";
    }

    const existingLines = existing.length > 0 ? existing.split(/\r?\n/) : [];
    const updated = new Set();
    const outLines = [];

    for (const line of existingLines) {
      // Match "KEY=" (with optional whitespace) but skip comment lines
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=/);
      if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
        const key = m[1];
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      } else {
        outLines.push(line);
      }
    }

    // Append any keys that weren't already present
    for (const key of keys) {
      if (!updated.has(key)) {
        outLines.push(`${key}=${formatEnvValue(updates[key])}`);
        updated.add(key);
      }
    }

    // Update process.env so the running app picks up the new values
    // immediately (and so the settings UI reads the same source of truth).
    for (const key of keys) {
      process.env[key] = String(updates[key]);
    }

    const newContent = outLines.join("\n");
    try {
      const tmpPath = envPath + ".tmp";
      fs.writeFileSync(tmpPath, newContent, "utf8");
      fs.renameSync(tmpPath, envPath);
    } catch (e) {
      logger.error("Failed to persist .env updates", {
        error: e.message,
        keys
      });
      return [];
    }

    logger.info("Persisted .env updates", { keys: Array.from(updated) });
    return Array.from(updated);
  }

  updateAppIcon(iconKey) {
    try {
      const { app } = require("electron");
      const path = require("path");
      const fs = require("fs");

      // Icon mapping for available icons in assests/icons folder
      const iconPaths = {
        terminal: "assests/icons/terminal.png",
        activity: "assests/icons/activity.png",
        settings: "assests/icons/settings.png",
      };

      // App name mapping for stealth mode
      const appNames = {
        terminal: "Terminal ",
        activity: "Activity Monitor ",
        settings: "System Settings ",
      };

      const iconPath = iconPaths[iconKey];
      const appName = appNames[iconKey];

      if (!iconPath) {
        logger.error("Invalid icon key", { iconKey });
        return { success: false, error: "Invalid icon key" };
      }

      const fullIconPath = path.resolve(__dirname, iconPath);

      if (!fs.existsSync(fullIconPath)) {
        logger.error("Icon file not found", {
          iconKey,
          iconPath: fullIconPath,
        });
        return { success: false, error: "Icon file not found" };
      }

      // Set app icon for dock/taskbar
      if (process.platform === "darwin") {
        // macOS - update dock icon (only if dock is available)
        if (app.dock) {
          app.dock.setIcon(fullIconPath);

          // Force dock refresh with multiple attempts
          const retryDockIcon = () => {
            try { app.dock.setIcon(fullIconPath); } catch (_) { /* dock may not exist */ }
          };
          setTimeout(retryDockIcon, 100);
          setTimeout(retryDockIcon, 500);
        }
      } else {
        // Windows/Linux - update window icons
        windowManager.windows.forEach((window, type) => {
          if (window && !window.isDestroyed()) {
            window.setIcon(fullIconPath);
          }
        });
      }

      // Update app name for stealth mode
      this.updateAppName(appName, iconKey);

      logger.info("App icon and name updated successfully", {
        iconKey,
        appName,
        iconPath: fullIconPath,
        platform: process.platform,
        fileExists: fs.existsSync(fullIconPath),
      });

      this.appIcon = iconKey;
      return { success: true };
    } catch (error) {
      logger.error("Failed to update app icon", {
        error: error.message,
        stack: error.stack,
      });
      return { success: false, error: error.message };
    }
  }

  updateAppName(appName, iconKey) {
    try {
      const { app } = require("electron");

      // Force update process title for Activity Monitor stealth - CRITICAL
      process.title = appName;

      // Set app name in dock (macOS) - this affects the dock and Activity Monitor
      if (process.platform === "darwin") {
        // Multiple attempts to ensure the name sticks
        app.setName(appName);

        // Clear dock badge and reset
        if (app.dock) {
          app.dock.setBadge("");
          // Force dock refresh
          setTimeout(() => {
            app.dock.setIcon(
              require("path").resolve(__dirname, `assests/icons/${iconKey}.png`)
            );
          }, 50);
        }
      }

      // Set app user model ID for Windows taskbar grouping (Windows only)
      if (process.platform === "win32") {
        app.setAppUserModelId(`${appName.trim()}-${iconKey}`);
      }

      // Update all window titles to match the new app name
      const windows = windowManager.windows;
      windows.forEach((window, type) => {
        if (window && !window.isDestroyed()) {
          // Use stealth name for all windows
          const stealthTitle = appName.trim();
          window.setTitle(stealthTitle);
        }
      });

      // Multiple force refreshes with increasing delays
      const refreshTimes = [50, 100, 200, 500];
      refreshTimes.forEach((delay) => {
        setTimeout(() => {
          process.title = appName;
          if (process.platform === "darwin") {
            app.setName(appName);
            // Force update bundle display name
            if (app.getName() !== appName) {
              app.setName(appName);
            }
          }
        }, delay);
      });

      logger.info("App name updated for stealth mode", {
        appName,
        processTitle: process.title,
        appGetName: app.getName(),
        iconKey,
        platform: process.platform,
      });
    } catch (error) {
      logger.error("Failed to update app name", { error: error.message });
    }
  }
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  const controller = new ApplicationController();
  app.on("second-instance", () => controller.handleSecondInstance());
}
