// QA regression tests — SessionLifecycleManager
// Found by /qa on 2026-09-23
// Report: .gstack/qa-reports/qa-report-nyx-2026-09-23.md
// Runs headless: no Electron required (manager is pure Node + EventEmitter).
// CJS (the project is CommonJS) so node --check in CI works pre-test-runner.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { SessionLifecycleManager } = require('../src/managers/session-lifecycle.manager.js');

function freshManager() {
  const m = new SessionLifecycleManager();
  // Isolated data dir per manager so disk-backed resume/getMeeting never
  // collide with the developer's real meeting notes.
  m.setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-qa-')));
  return m;
}

test('start creates an active session with defaults', () => {
  const m = freshManager();
  const status = m.start({ title: 'Kickoff', audio: true });
  assert.equal(status.active, true);
  assert.equal(status.title, 'Kickoff');
  assert.equal(status.audioEnabled, true);
  assert.equal(typeof status.elapsedMs, 'number');
  assert.equal(m.isActive(), true);
});

test('start is idempotent while active (no restart churn)', () => {
  const m = freshManager();
  const a = m.start({ title: 'One', audio: true });
  const b = m.start({ title: 'Two', audio: true });
  assert.equal(b.title, 'One', 'second start must not clobber the active session');
  assert.equal(a.startedAt, b.startedAt);
});

test('stop clears active state', () => {
  const m = freshManager();
  m.start({ title: 'X', audio: true });
  const status = m.stop();
  assert.ok(status, 'stop returns the stopping status');
  assert.equal(m.isActive(), false);
  assert.equal(m.isAutoAttending(), false);
});

test('setSmartMode coerces truthiness and emits event', () => {
  const m = freshManager();
  let seen = null;
  m.events.on('smart-mode-changed', (e) => { seen = e; });
  const on = m.setSmartMode('yes');
  assert.equal(on, true, 'non-boolean input coerces to boolean');
  assert.equal(seen && seen.smartMode, true);
  assert.equal(m.getStatus().smartMode, true);
});

test('resume loads a saved meeting from disk and continues its id', () => {
  const m = freshManager();
  // Persist a meeting the way generateAndSaveNotes does.
  const meeting = {
    id: 'mtg-42',
    title: 'Design Review',
    startedAt: new Date().toISOString(),
    endedAt: null,
    transcript: [
      { id: 't-1', timestamp: new Date().toISOString(), offsetMs: 100, source: 'speech', speaker: 'user', text: 'hello' },
      { id: 't-2', timestamp: new Date().toISOString(), offsetMs: 200, source: 'system', speaker: 'other', text: 'world' },
    ],
  };
  const dir = path.join(m.dataDir, 'meetings');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${meeting.id}.json`), JSON.stringify(meeting), 'utf8');

  const result = m.resume('mtg-42');
  assert.equal(result.ok, true);
  assert.equal(m.isActive(), true);
  assert.equal(m.sessionId, 'mtg-42', 'resume continues the saved meeting id');
  assert.equal(m.getTranscriptText().includes('hello'), true);
  assert.equal(m.getTranscriptText().includes('world'), true);
});

test('resume with unknown meeting id returns a soft error (no crash)', () => {
  const m = freshManager();
  const result = m.resume('no-such-meeting');
  assert.equal(result.ok, false);
  assert.match(result.error, /not found/i);
  assert.equal(m.isActive(), false);
});

test('addTranscriptEntry emits transcript-entry with source tag', () => {
  const m = freshManager();
  const seen = [];
  m.events.on('transcript-entry', (e) => seen.push(e));
  m.start({ title: 'T', audio: true });
  m.addTranscriptEntry('from mic', { source: 'speech' });
  m.addTranscriptEntry('from other side', { source: 'system', speaker: 'other' });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].speaker, 'other');
  assert.equal(seen[1].text, 'from other side');
});

test('autoAttendMeeting stores start/end and returns status; autoAttendEnd clears it', () => {
  const m = freshManager();
  const status = m.autoAttendMeeting({ summary: 'Standup', start: '2026-09-23T10:00:00Z', end: '2026-09-23T10:30:00Z' });
  assert.equal(status.active, true);
  assert.equal(m.isAutoAttending(), true);
  assert.equal(m.getAutoAttendStart(), '2026-09-23T10:00:00Z');
  const ended = m.autoAttendEnd();
  assert.ok(ended, 'autoAttendEnd returns end status');
  assert.equal(m.isAutoAttending(), false);
});

test('autoAttendMeeting ignored while a session is already active', () => {
  const m = freshManager();
  m.start({ title: 'Manual', audio: true });
  const status = m.autoAttendMeeting({ summary: 'Standup', start: '2026-09-23T10:00:00Z' });
  assert.equal(status, null, 'auto-attend must not steal an active manual session');
  assert.equal(m.getStatus().title, 'Manual');
});

test('getStatus exposes smartMode and autoAttending fields (regression: duplicate getStatus)', () => {
  // Regression: an older duplicate getStatus() overrode the enriched one and
  // dropped smartMode/autoAttending — found by functional test on 2026-09-23.
  const m = freshManager();
  const status = m.getStatus();
  assert.ok('smartMode' in status, 'status must expose smartMode');
  assert.ok('autoAttending' in status, 'status must expose autoAttending');
});
