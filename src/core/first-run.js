const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * First-run detection and onboarding helper.
 *
 * Responsibilities:
 *   - Decide whether this is the user's first launch of Nyx
 *   - Auto-create a default `.env` from `env.example` if one is missing
 *   - Report whether a Gemini API key is configured (the only required key)
 *   - Persist a "first-run completed" sentinel so we don't nag on every launch
 *
 * The settings UI is the source of truth for API-key entry. This module
 * only handles the bootstrap so the user has something to edit on first
 * launch.
 */
class FirstRunManager {
  constructor(options = {}) {
    this.cwd = options.cwd || process.cwd();
    this.envPath = options.envPath || path.join(this.cwd, '.env');
    this.sentinelPath = options.sentinelPath || path.join(this.cwd, '.nyx-firstrun-completed');
    this.logger = options.logger || console;
  }

  /**
   * Returns true if this looks like a fresh install — no .env, no
   * sentinel file, or .env exists but has no Gemini key.
   */
  needsOnboarding() {
    if (!fs.existsSync(this.envPath)) return true;
    const content = this._readEnv();
    // The LLM backend is Gemini (GEMINI_API_KEY, usually exported in
    // ~/.bashrc). A bashrc-provided key counts as configured even when the
    // .env has no key — the app reads process.env, which dotenv will not
    // override once the key exists there.
    const envGemini = (content.GEMINI_API_KEY || '').trim();
    const geminiConfigured =
      (!!envGemini && envGemini !== 'your_gemini_api_key_here') ||
      (!!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here');
    // A configured LLM key means the user is set up. Self-heal a missing
    // sentinel (installs that configured .env manually or predate the
    // wizard) instead of re-showing onboarding on every launch.
    if (geminiConfigured) {
      if (!fs.existsSync(this.sentinelPath)) this.markCompleted();
      return false;
    }
    return true;
  }

  /**
   * Ensures a .env file exists. If not, copies env.example (if available)
   * or writes a minimal template.
   */
  ensureEnv() {
    if (fs.existsSync(this.envPath)) {
      return { created: false, path: this.envPath };
    }

    const template = this._readTemplate();
    const dir = path.dirname(this.envPath);
    try {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.envPath, template, 'utf8');
      try {
        fs.chmodSync(this.envPath, 0o600);
      } catch (_) { /* best effort */ }
      return { created: true, path: this.envPath };
    } catch (e) {
      this.logger.error && this.logger.error('Failed to create .env', { error: e.message });
      return { created: false, path: this.envPath, error: e.message };
    }
  }

  /**
   * Mark the first-run as completed so we don't keep prompting.
   */
  markCompleted() {
    try {
      fs.writeFileSync(this.sentinelPath, new Date().toISOString(), 'utf8');
    } catch (e) {
      this.logger.warn && this.logger.warn('Could not write first-run sentinel', {
        error: e.message
      });
    }
  }

  /**
   * Get a snapshot of the current setup state for UI / logging.
   */
  getStatus() {
    const env = this._readEnv();
    const envGemini = (env.GEMINI_API_KEY || '').trim();
    const procGemini = (process.env.GEMINI_API_KEY || '').trim();
    const geminiConfigured =
      (!!envGemini && envGemini !== 'your_gemini_api_key_here') ||
      (!!procGemini && procGemini !== 'your_gemini_api_key_here');
    return {
      envExists: fs.existsSync(this.envPath),
      sentinelExists: fs.existsSync(this.sentinelPath),
      geminiConfigured,
      llmConfigured: geminiConfigured,
      needsOnboarding: this.needsOnboarding()
    };
  }

  _readEnv() {
    try {
      const content = fs.readFileSync(this.envPath, 'utf8');
      const result = {};
      for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();

        // If the value is quoted, find the matching closing quote and
        // take everything between. Anything after the closing quote is
        // treated as trailing whitespace/comment.
        if (value.startsWith('"') || value.startsWith("'")) {
          const quote = value[0];
          const closeIdx = value.indexOf(quote, 1);
          if (closeIdx !== -1) {
            value = value.slice(1, closeIdx);
          }
        } else {
          // Unquoted: strip trailing inline comment (a " #" sequence).
          const hashIdx = value.indexOf(' #');
          if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
        }

        result[key] = value;
      }
      return result;
    } catch (_) {
      return {};
    }
  }

  _readTemplate() {
    // Prefer env.example if it ships in the project; otherwise write a
    // minimal template that the user can extend.
    const candidates = [
      path.join(this.cwd, 'env.example'),
      path.join(__dirname, '..', '..', 'env.example'),
    ];
    for (const candidate of candidates) {
      try {
        return fs.readFileSync(candidate, 'utf8');
      } catch (_) { /* try next */ }
    }
    return [
      '# Nyx configuration',
      '# LLM backend: Google Gemini (generativelanguage.googleapis.com).',
      '# Export GEMINI_API_KEY in your ~/.bashrc (recommended) or set it below',
      '# — the app reads both.',
      '# Get a key from: https://aistudio.google.com (free tier available).',
      '',
      '# GEMINI_API_KEY=your_gemini_api_key_here',
      '',
      '# Output language for AI responses, notes and summaries.',
      'OUTPUT_LANGUAGE=English',
      '',
      '# Meeting audio language used for transcription accuracy.',
      'MEETING_AUDIO_LANGUAGE=auto',
      '',
      '# ── Nyx parity settings ──',
      '# Invisibility: hide the overlay from screen shares (on|off; no-op on Linux).',
      'INVISIBILITY_MODE=on',
      '# Auto launch at login (on|off).',
      'AUTO_LAUNCH=off',
      '# Auto-start a listening session when a calendar meeting begins (true|false).',
      'CALENDAR_AUTO_ATTEND=true',
      ''
    ].join(os.EOL);
  }
}

module.exports = FirstRunManager;
module.exports.FirstRunManager = FirstRunManager;
