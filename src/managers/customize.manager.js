// Customize/Knowledge manager — Nyx "Customize Nyx" + Knowledge Base.
//
// Modes: named custom prompts (e.g. "Nyx for Sales") selectable from the
// Live Insights card; one is active at a time and is injected as a system
// message into every LLM call.
// Knowledge base: text entries (notes, scripts, docs, pasted files) retrieved
// by keyword scoring (lightweight RAG) and appended to the system context.

const fs = require('fs');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('CUSTOMIZE');

const DEFAULT_MODES = [
  {
    id: 'mode-general',
    name: 'General Assistant',
    prompt: 'You are a helpful real-time assistant. Give accurate, concise, well-structured answers.',
    builtin: true,
  },
  {
    id: 'mode-sales',
    name: 'Sales Calls',
    prompt: 'You are an elite sales call assistant. Help the user handle objections, ask discovery questions, advance the deal, and sound confident. Keep answers short and actionable.',
    builtin: true,
  },
  {
    id: 'mode-recruiting',
    name: 'Recruiting / Candidates',
    prompt: 'You are a technical recruiting assistant. Help evaluate candidate answers, suggest probing follow-ups, and flag red flags or strong signals in real time.',
    builtin: true,
  },
  {
    id: 'mode-student',
    name: 'Student / Learning',
    prompt: 'You are a learning assistant. Explain concepts clearly with examples, and help the user answer questions correctly during lectures and study sessions.',
    builtin: true,
  },
];

class CustomizeManager {
  constructor() {
    this.dataDir = null;
    this.modes = [];
    this.activeModeId = 'mode-general';
    this.knowledge = [];
  }

  setDataDir(dir) {
    this.dataDir = dir;
    this._load();
  }

  _modesPath() { return path.join(this.dataDir, 'modes.json'); }
  _kbPath() { return path.join(this.dataDir, 'knowledge.json'); }

  _load() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
    } catch (_) { /* ignore */ }

    try {
      const stored = JSON.parse(fs.readFileSync(this._modesPath(), 'utf8'));
      this.modes = Array.isArray(stored.modes) && stored.modes.length ? stored.modes : DEFAULT_MODES;
      this.activeModeId = stored.activeModeId || 'mode-general';
    } catch (_) {
      this.modes = [...DEFAULT_MODES];
      this.activeModeId = 'mode-general';
    }

    try {
      const kb = JSON.parse(fs.readFileSync(this._kbPath(), 'utf8'));
      this.knowledge = Array.isArray(kb.entries) ? kb.entries : [];
    } catch (_) {
      this.knowledge = [];
    }
  }

  _persistModes() {
    try {
      fs.writeFileSync(this._modesPath(), JSON.stringify({ modes: this.modes, activeModeId: this.activeModeId }, null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to persist modes', { error: e.message });
    }
  }

  _persistKnowledge() {
    try {
      fs.writeFileSync(this._kbPath(), JSON.stringify({ entries: this.knowledge }, null, 2), 'utf8');
    } catch (e) {
      logger.error('Failed to persist knowledge base', { error: e.message });
    }
  }

  // ── Modes ────────────────────────────────────────────────────────────────

  listModes() {
    return this.modes.map(m => ({ id: m.id, name: m.name, builtin: !!m.builtin, promptLength: (m.prompt || '').length }));
  }

  getMode(id) {
    return this.modes.find(m => m.id === id) || null;
  }

  setActiveMode(id) {
    if (this.getMode(id)) {
      this.activeModeId = id;
      this._persistModes();
      logger.info('Active mode changed', { id });
    }
    return this.activeModeId;
  }

  getActiveMode() {
    return this.getMode(this.activeModeId) || this.modes[0] || null;
  }

  getActivePrompt() {
    const mode = this.getActiveMode();
    if (!mode) return null;
    const prompt = mode.prompt || '';
    const kb = this.retrieveKnowledge('', 2);
    return kb.length ? `${prompt}\n\n# Relevant knowledge\n${kb.join('\n\n')}` : prompt;
  }

  upsertMode({ id = null, name, prompt }) {
    if (!name || typeof prompt !== 'string') throw new Error('Mode needs a name and prompt');
    if (id) {
      const mode = this.getMode(id);
      if (!mode) throw new Error(`Unknown mode: ${id}`);
      mode.name = name;
      mode.prompt = prompt;
      this._persistModes();
      return mode;
    }
    const mode = { id: `mode-${Date.now()}`, name, prompt, builtin: false };
    this.modes.push(mode);
    this._persistModes();
    return mode;
  }

  deleteMode(id) {
    const mode = this.getMode(id);
    if (!mode || mode.builtin) return false;
    this.modes = this.modes.filter(m => m.id !== id);
    if (this.activeModeId === id) this.activeModeId = this.modes[0] ? this.modes[0].id : null;
    this._persistModes();
    return true;
  }

  // ── Knowledge base ───────────────────────────────────────────────────────

  listKnowledge() {
    return this.knowledge.map(k => ({
      id: k.id,
      title: k.title,
      contentLength: (k.content || '').length,
      createdAt: k.createdAt,
    }));
  }

  addKnowledge(title, content) {
    if (!title || !content) throw new Error('Knowledge entry needs title and content');
    const entry = {
      id: `kb-${Date.now()}`,
      title: String(title).slice(0, 120),
      content: String(content).slice(0, 400000),
      createdAt: new Date().toISOString(),
    };
    this.knowledge.push(entry);
    this._persistKnowledge();
    logger.info('Knowledge entry added', { id: entry.id, title: entry.title });
    return entry;
  }

  deleteKnowledge(id) {
    const before = this.knowledge.length;
    this.knowledge = this.knowledge.filter(k => k.id !== id);
    this._persistKnowledge();
    return this.knowledge.length < before;
  }

  /**
   * Fetch a web page, strip it to readable text, and store it as a knowledge
   * entry (Nyx parity with Cluely's "live collection of help centers or web
   * links"). Same rules as addKnowledge (title/content caps) apply.
   */
  async addKnowledgeFromUrl(title, url) {
    if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('Knowledge URL must start with http(s)://');
    const html = await fetchUrlText(url);
    const content = htmlToText(html);
    if (!content || content.length < 40) throw new Error('Could not extract readable text from that URL');
    const finalTitle = (title && String(title).trim()) || deriveTitleFromHtml(html, url);
    return this.addKnowledge(finalTitle, content);
  }

  /**
   * Lightweight keyword-overlap retrieval (RAG-lite). Returns up to `limit`
   * entry contents ranked by term overlap with the query. Empty query returns
   * the first entries (capped) so base knowledge is always available.
   */
  retrieveKnowledge(query, limit = 3) {
    if (!this.knowledge.length) return [];
    if (!query || !query.trim()) {
      return this.knowledge.slice(0, limit).map(k => `## ${k.title}\n${k.content.slice(0, 4000)}`);
    }

    const stop = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'of', 'to', 'in', 'and', 'or', 'for', 'on', 'it', 'this', 'that', 'with', 'as', 'at', 'by', 'be', 'what', 'how', 'why', 'who', 'when']);
    const terms = query.toLowerCase().match(/[a-z0-9]{3,}/g)?.filter(t => !stop.has(t)) || [];

    const scored = this.knowledge.map(k => {
      const text = `${k.title} ${k.content}`.toLowerCase();
      let score = 0;
      for (const t of terms) {
        if (k.title.toLowerCase().includes(t)) score += 3;
        const occurrences = text.split(t).length - 1;
        score += Math.min(occurrences, 8);
      }
      return { entry: k, score };
    }).sort((a, b) => b.score - a.score);

    return scored
      .filter(s => s.score > 0)
      .slice(0, limit)
      .map(s => `## ${s.entry.title}\n${s.entry.content.slice(0, 4000)}`);
  }
}

module.exports = new CustomizeManager();
module.exports.CustomizeManager = CustomizeManager;
// Exposed for unit tests (pure functions; no instance state).
module.exports.htmlToText = htmlToText;

// ── HTML → text (pure helpers, defined below exports for hoisting) ─────────

function deriveTitleFromHtml(html, url) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m && m[1].trim()) return htmlToText(m[1]).slice(0, 120);
  try {
    const u = new URL(url);
    return u.hostname + (u.pathname && u.pathname !== '/' ? u.pathname : '');
  } catch (_) {
    return String(url).slice(0, 120);
  }
}

function fetchUrlText(url, { maxRedirects = 3, timeoutMs = 15000 } = {}) {
  const https = require('https');
  const http = require('http');
  return new Promise((resolve, reject) => {
    const request = (target, redirectsLeft) => {
      const mod = target.startsWith('https:') ? https : http;
      const req = mod.get(target, { timeout: timeoutMs, headers: { 'User-Agent': 'Nyx-Knowledge-Bot/1.0 (+local desktop app)' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const next = new URL(res.headers.location, target).toString();
          request(next, redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} fetching ${target}`));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', c => { data += c; if (data.length > 2 * 1024 * 1024) req.destroy(); });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Fetch timeout')); });
    };
    request(url, maxRedirects);
  });
}

/** Strip HTML to plain readable text (no external deps). */
function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<\s*(br|p|div|li|tr|h[1-6]|section|article)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ');
  s = s.replace(/&amp;/gi, '&');
  s = decodeHtmlEntities(s);
  s = s.replace(/[ \t]+/g, ' ');
  s = s.replace(/\n\s*\n\s*\n+/g, '\n\n');
  return s.split('\n').map(l => l.trim()).filter(Boolean).join('\n').slice(0, 400000);
}

// Local entity decoder (kept out of the exported name space).
function decodeHtmlEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return ' '; } })
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch (_) { return ' '; } })
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'");
}
