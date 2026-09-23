// Pre-call briefs manager — Nyx "Pre-call Briefs" equivalent.
//
// Reads calendar events from local .ics files (the local-first equivalent of
// Nyx's Google Calendar sync: point the app at an exported/subscription
// .ics and it generates an AI brief per upcoming meeting). Briefs include
// meeting details, participant extraction, agenda, and AI preparation tips.

const fs = require('fs');
const path = require('path');
const https = require('https');
const logger = require('../core/logger').createServiceLogger('PRECALL');

class PreCallManager {
  constructor() {
    this.dataDir = null;
    this.sources = []; // { id, name, type: 'file'|'url', path }
    this._watchers = new Map();
  }

  setDataDir(dir) {
    this.dataDir = dir;
    this._load();
  }

  _statePath() { return path.join(this.dataDir, 'precall.json'); }
  _briefsDir() { return path.join(this.dataDir, 'briefs'); }

  _load() {
    try {
      fs.mkdirSync(this._briefsDir(), { recursive: true });
    } catch (_) { /* ignore */ }
    try {
      const stored = JSON.parse(fs.readFileSync(this._statePath(), 'utf8'));
      this.sources = Array.isArray(stored.sources) ? stored.sources : [];
    } catch (_) {
      this.sources = [];
    }
  }

  _persist() {
    try {
      fs.writeFileSync(this._statePath(), JSON.stringify({ sources: this.sources }, null, 2), 'utf8');
    } catch (e) {
      logger.warn('Failed to persist precall sources', { error: e.message });
    }
  }

  // ── Calendar sources ─────────────────────────────────────────────────────

  listSources() {
    return this.sources.map(s => ({ id: s.id, name: s.name, type: s.type, path: s.path }));
  }

  addSource({ name, type, path: srcPath }) {
    if (!name || !srcPath || !['file', 'url'].includes(type)) {
      throw new Error('Source needs name, type (file|url) and path');
    }
    const source = { id: `cal-${Date.now()}`, name, type, path: srcPath };
    this.sources.push(source);
    this._persist();
    this._refreshSource(source).catch(() => { /* logged in _refreshSource */ });
    return source;
  }

  removeSource(id) {
    const before = this.sources.length;
    this.sources = this.sources.filter(s => s.id !== id);
    this._persist();
    return this.sources.length < before;
  }

  // ── ICS parsing (minimal RFC5545: VEVENT with DTSTART/DTEND/SUMMARY/
  //    DESCRIPTION/LOCATION/ATTENDEE/ORGANIZER, folds unfolded per spec) ────

  _unfoldIcs(text) {
    return text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  }

  _parseIcsDate(value) {
    // Forms: 20260101T103000Z | 20260101T103000 (floating) | 20260101 (date)
    const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (!m) return null;
    const [, y, mo, d, h = '00', mi = '00', s = '00', z] = m;
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}${z ? 'Z' : ''}`;
    const date = new Date(iso);
    return isNaN(date.getTime()) ? null : date;
  }

  _unescapeIcsText(text) {
    return String(text || '')
      .replace(/\\n/gi, '\n')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\');
  }

  _extractParam(line, param) {
    const m = line.match(new RegExp(`${param}[^:=]*=([^;:]+)`, 'i'));
    return m ? this._unescapeIcsText(m[1]) : null;
  }

  parseIcs(text) {
    const unfolded = this._unfoldIcs(text);
    const events = [];
    const blocks = unfolded.split(/BEGIN:VEVENT/).slice(1);

    for (const block of blocks) {
      const eventBlock = block.split('END:VEVENT')[0];
      const event = { summary: null, start: null, end: null, description: null, location: null, attendees: [], organizer: null };

      for (const rawLine of eventBlock.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('SUMMARY')) {
          event.summary = this._unescapeIcsText(line.split(':').slice(1).join(':'));
        } else if (line.startsWith('DTSTART')) {
          event.start = this._parseIcsDate(line.split(':').pop());
        } else if (line.startsWith('DTEND')) {
          event.end = this._parseIcsDate(line.split(':').pop());
        } else if (line.startsWith('DESCRIPTION')) {
          event.description = this._unescapeIcsText(line.split(':').slice(1).join(':'));
        } else if (line.startsWith('LOCATION')) {
          event.location = this._unescapeIcsText(line.split(':').slice(1).join(':'));
        } else if (line.startsWith('ATTENDEE')) {
          const cn = this._extractParam(line, 'CN');
          const email = (line.split(':').pop() || '').replace(/^mailto:/i, '');
          event.attendees.push({ name: cn || email.split('@')[0], email });
        } else if (line.startsWith('ORGANIZER')) {
          const cn = this._extractParam(line, 'CN');
          event.organizer = { name: cn || 'Organizer', email: (line.split(':').pop() || '').replace(/^mailto:/i, '') };
        }
      }

      if (event.start && (event.summary || event.attendees.length)) {
        events.push(event);
      }
    }

    return events;
  }

  async _fetchIcsText(source) {
    if (source.type === 'file') {
      return fs.readFileSync(source.path, 'utf8');
    }
    // URL (e.g. a Google Calendar secret-address ics link)
    return new Promise((resolve, reject) => {
      const req = https.get(source.path, { timeout: 15000 }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} fetching calendar`));
          return;
        }
        let data = '';
        res.on('data', c => { data += c; });
        res.on('end', () => resolve(data));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Calendar fetch timeout')); });
    });
  }

  async _refreshSource(source) {
    try {
      const text = await this._fetchIcsText(source);
      const events = this.parseIcs(text);
      fs.writeFileSync(path.join(this._briefsDir(), `cal-${source.id}.json`), JSON.stringify(events, null, 2), 'utf8');
      logger.info('Calendar source refreshed', { id: source.id, events: events.length });
      return events.length;
    } catch (e) {
      logger.warn('Calendar refresh failed', { id: source.id, error: e.message });
      return 0;
    }
  }

  async refreshAll() {
    const counts = await Promise.all(this.sources.map(s => this._refreshSource(s)));
    return counts.reduce((a, b) => a + b, 0);
  }

  getUpcomingMeetings(withinHours = 48, limit = 10) {
    try {
      const now = Date.now();
      const horizon = now + withinHours * 3600 * 1000;
      const all = [];
      for (const f of fs.readdirSync(this._briefsDir())) {
        if (!f.endsWith('.json')) continue;
        try {
          const events = JSON.parse(fs.readFileSync(path.join(this._briefsDir(), f), 'utf8'));
          all.push(...events);
        } catch (_) { /* skip */ }
      }
      return all
        .map(e => ({ ...e, start: new Date(e.start).getTime(), end: e.end ? new Date(e.end).getTime() : null }))
        .filter(e => e.start && !isNaN(e.start) && e.start > now - 30 * 60 * 1000 && e.start < horizon)
        .sort((a, b) => a.start - b.start)
        .slice(0, limit)
        .map(e => ({
          summary: e.summary || 'Untitled meeting',
          start: new Date(e.start).toISOString(),
          end: e.end ? new Date(e.end).toISOString() : null,
          durationMin: e.end ? Math.round((e.end - e.start) / 60000) : null,
          location: e.location,
          description: e.description ? e.description.slice(0, 2000) : null,
          organizer: e.organizer,
          attendees: (e.attendees || []).slice(0, 12),
        }));
    } catch (e) {
      logger.warn('Failed to compute upcoming meetings', { error: e.message });
      return [];
    }
  }

  /**
   * Build the AI brief prompt for a meeting — Nyx brief content:
   * meeting details, participants, context, preparation tips.
   */
  buildBriefPrompt(meeting) {
    const parts = [
      `Generate a pre-call brief for this upcoming meeting. Use EXACTLY these markdown sections:`,
      `## Meeting Details\n(date, time, duration, agenda)`,
      `## Participants\n(names, roles if inferable, professional background hypotheses)`,
      `## Meeting Context\n(topics from the invite, goals, relevant prior context)`,
      `## Preparation Tips\n(5-7 concrete talking points and smart questions to ask)`,
      ``,
      `Meeting title: ${meeting.summary}`,
      `Start: ${new Date(meeting.start).toLocaleString()}`,
      meeting.durationMin ? `Duration: ~${meeting.durationMin} minutes` : null,
      meeting.location ? `Location/link: ${meeting.location}` : null,
      meeting.organizer ? `Organizer: ${meeting.organizer.name} <${meeting.organizer.email}>` : null,
      meeting.attendees && meeting.attendees.length
        ? `Attendees:\n${meeting.attendees.map(a => `- ${a.name}${a.email ? ` (${a.email})` : ''}`).join('\n')}`
        : null,
      meeting.description ? `Invite description:\n${meeting.description}` : null,
    ].filter(Boolean);
    return parts.join('\n');
  }

  async generateBrief(meeting, llmService) {
    const result = await llmService.runAction(this.buildBriefPrompt(meeting), { maxTokens: 2048 });
    return result.response;
  }
}

module.exports = new PreCallManager();
