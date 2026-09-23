// QA tests — v1.3.0 Cluely-parity features
// Covers: custom live actions CRUD + runAction routing, notes template,
// call-score JSON parsing, meeting analytics aggregation, htmlToText.
// Runs headless (managers are pure Node + EventEmitter). CJS per project convention.
//
// NOTE: multi-line strings are built with NL joins instead of "\n" escapes so
// the markdown the section parser sees is unambiguous regardless of how this
// file's escapes survive editors/transport.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { SessionLifecycleManager } = require('../src/managers/session-lifecycle.manager.js');
const customize = require('../src/managers/customize.manager.js');

const NL = String.fromCharCode(10); // newline, escape-free

function freshManager() {
  const m = new SessionLifecycleManager();
  m.setDataDir(fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-parity-')));
  return m;
}

function fakeLLM(responseText) {
  return {
    isInitialized: true,
    runAction: async () => ({ response: responseText }),
  };
}

const md = (...lines) => lines.join(NL); // build markdown escape-free

// ── Custom live actions ─────────────────────────────────────────────────────

test('custom actions: add persists to disk and lists with normalized shape', () => {
  const m = freshManager();
  const a = m.addCustomAction({ label: 'Check pricing', type: 'prompt', prompt: 'Flag pricing mismatches.' });
  assert.match(a.id, /^act-/);
  assert.equal(a.type, 'prompt');
  const listed = m.listCustomActions();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].label, 'Check pricing');
  assert.equal(listed[0].promptLength, 'Flag pricing mismatches.'.length);
  assert.equal(listed[0].prompt, undefined, 'list must not leak the prompt body');

  // Persistence: a fresh manager on the same dataDir sees it.
  const m2 = new SessionLifecycleManager();
  m2.setDataDir(m.dataDir);
  assert.equal(m2.listCustomActions().length, 1);
});

test('custom actions: link actions require http(s) URL; prompts require text', () => {
  const m = freshManager();
  assert.throws(() => m.addCustomAction({ label: 'Bad', type: 'link', url: 'javascript:alert(1)' }), /http/);
  assert.throws(() => m.addCustomAction({ label: 'Bad', type: 'prompt', prompt: '   ' }), /prompt/i);
  assert.throws(() => m.addCustomAction({ label: '', type: 'prompt', prompt: 'x' }), /label/i);
  const ok = m.addCustomAction({ label: 'CRM', type: 'link', url: 'https://crm.example.com' });
  assert.equal(ok.url, 'https://crm.example.com');
});

test('custom actions: update patches and delete removes', () => {
  const m = freshManager();
  const a = m.addCustomAction({ label: 'Old', type: 'prompt', prompt: 'P1' });
  const updated = m.updateCustomAction(a.id, { label: 'New', prompt: 'P2', enabled: false });
  assert.equal(updated.label, 'New');
  assert.equal(updated.prompt, 'P2');
  assert.equal(updated.enabled, false);
  assert.equal(m.deleteCustomAction(a.id), true);
  assert.equal(m.listCustomActions().length, 0);
  assert.equal(m.deleteCustomAction('nope'), false);
  assert.equal(m.updateCustomAction('nope', { label: 'x' }), null);
});

test('runAction routes custom-<id> actions through the custom prompt', async () => {
  const m = freshManager();
  const a = m.addCustomAction({ label: 'X', type: 'prompt', prompt: 'Summarize objections.' });
  m.start({ title: 'T', audio: true });
  m.addTranscriptEntry('They think it is too expensive');
  const seen = {};
  const llm = {
    isInitialized: true,
    runAction: async (prompt, opts) => {
      seen.prompt = prompt;
      seen.transcript = opts.transcript;
      return { response: 'ok' };
    },
  };
  const result = await m.runAction(`custom-${a.id}`, llm);
  assert.equal(result.response, 'ok');
  assert.ok(seen.prompt.includes('Summarize objections.'), 'custom prompt must reach the LLM');
  assert.ok(seen.transcript.includes('too expensive'), 'transcript must be included');
});

test('runAction returns soft message for custom action with empty transcript', async () => {
  const m = freshManager();
  const a = m.addCustomAction({ label: 'X', type: 'prompt', prompt: 'P' });
  const result = await m.runAction(`custom-${a.id}`, fakeLLM('should not be called'));
  assert.match(result.response, /Nothing has been said yet/);
});

test('getCustomAction returns the full record including prompt body', () => {
  const m = freshManager();
  const a = m.addCustomAction({ label: 'Full', type: 'prompt', prompt: 'The whole prompt body' });
  const full = m.getCustomAction(a.id);
  assert.equal(full.prompt, 'The whole prompt body');
  assert.equal(m.getCustomAction('nope'), null);
});

test('runAction on a link action never calls the LLM (regression: undefined prompt)', async () => {
  const m = freshManager();
  const a = m.addCustomAction({ label: 'CRM', type: 'link', url: 'https://crm.example.com' });
  let called = false;
  const llm = { isInitialized: true, runAction: async () => { called = true; return { response: 'x' }; } };
  const result = await m.runAction(`custom-${a.id}`, llm);
  assert.equal(called, false, 'link actions must not reach the LLM');
  assert.match(result.response, /browser/i);
});

// ── Notes template ──────────────────────────────────────────────────────────

test('notes template: default defines sections; custom persists; empty rejects; reset restores', () => {
  const m = freshManager();
  const def = m.getNotesTemplate();
  assert.ok(def.includes('## Detailed Notes'), 'default template defines the standard sections');
  const custom = md('Notes about the call', '## Decisions', '(list them)');
  m.setNotesTemplate(custom);
  assert.equal(m.getNotesTemplate(), custom);
  assert.throws(() => m.setNotesTemplate('   '), /non-empty/);
  m.resetNotesTemplate();
  assert.equal(m.getNotesTemplate(), def);
});

test('notes template: generateAndSaveNotes uses custom template sections', async () => {
  const m = freshManager();
  m.start({ title: 'Templated', audio: true });
  m.addTranscriptEntry('We agreed on the pricing');
  m.setNotesTemplate(md('Notes about the call', '## Decisions', '(list them)'));
  const llm = fakeLLM(md('## Decisions', 'Pricing agreed.', '', '## Notes', 'Something else'));
  const notes = await m.generateAndSaveNotes(llm);
  assert.equal(notes.detailedNotes, 'Pricing agreed.', 'first ## section body becomes detailedNotes when Detailed Notes is absent');
  assert.ok(notes.extraSections, 'unknown sections captured');
  assert.equal(notes.extraSections.Notes, 'Something else', 'unknown section lands in extraSections');
});

test('generateAndSaveNotes without transcript still persists a note shell', async () => {
  const m = freshManager();
  m.start({ title: 'Empty', audio: true });
  const notes = await m.generateAndSaveNotes(fakeLLM('unused'));
  assert.ok(notes.id);
  assert.equal(notes.detailedNotes, '');
  assert.ok(fs.existsSync(path.join(m.dataDir, 'meetings', `${notes.id}.json`)));
});

// ── Call score + analytics ─────────────────────────────────────────────────

test('call score: fenced strict JSON parses; invalid overall rejected', () => {
  const m = freshManager();
  const fenced = md('```json', '{"overall": 7, "breakdown": [{"dimension": "clarity", "score": 8, "note": "ok"}]}', '```');
  const good = m._parseCallScoreJson(fenced);
  assert.equal(good.overall, 7);
  assert.equal(good.breakdown[0].dimension, 'clarity');
  assert.equal(m._parseCallScoreJson('{"overall": 42}'), null, 'overall must be 1-10');
  assert.equal(m._parseCallScoreJson('no json here'), null);
  assert.equal(m._parseCallScoreJson(null), null);
});

test('call score: generates, persists on the meeting record, clamps scores', async () => {
  const m = freshManager();
  m.start({ title: 'Scored', audio: true });
  m.addTranscriptEntry('We aligned on next steps');
  const notes = await m.generateAndSaveNotes(fakeLLM(md('## Detailed Notes', 'T')));
  const llm = fakeLLM('{"overall": 6.4, "breakdown": [{"dimension": "clarity", "score": 12, "note": "x"}, {"score": 3, "note": "no name"}]}');
  const score = await m.generateCallScoreForMeeting(notes.id, llm);
  assert.equal(score.overall, 6, 'overall rounds to integer');
  assert.equal(score.breakdown[0].score, 10, 'scores clamp to 10');
  assert.equal(score.breakdown.length, 1, 'entries without a dimension are dropped');
  const stored = m.getMeeting(notes.id);
  assert.equal(stored.callScore, 6);
  assert.ok(Array.isArray(stored.callScoreBreakdown));
});

test('analytics aggregates scores, dimensions and talk time across meetings', async () => {
  const m = freshManager();
  for (const [title, score] of [['A', 8], ['B', 6]]) {
    m.start({ title, audio: true });
    m.addTranscriptEntry(`${title} transcript`);
    const notes = await m.generateAndSaveNotes(fakeLLM(md('## Detailed Notes', 'X')));
    await m.generateCallScoreForMeeting(notes.id, fakeLLM(`{"overall": ${score}, "breakdown": [{"dimension": "clarity", "score": ${score}, "note": "n"}]}`));
    m.stop(); // real flow: sessions end between meetings
  }
  const a = m.getMeetingAnalytics();
  assert.equal(a.meetingCount, 2);
  assert.equal(a.scoredCount, 2);
  assert.equal(a.avgScore, 7);
  assert.equal(a.bestScore, 8);
  assert.equal(a.worstScore, 6);
  assert.equal(a.dimensions.length, 1);
  assert.equal(a.dimensions[0].dimension, 'clarity');
  assert.equal(a.dimensions[0].avg, 7);
  assert.ok(a.recent.length >= 2);
});

test('analytics with no meetings returns zeroed summary', () => {
  const m = freshManager();
  const a = m.getMeetingAnalytics();
  assert.equal(a.meetingCount, 0);
  assert.equal(a.avgScore, null);
  assert.deepEqual(a.dimensions, []);
  assert.deepEqual(a.recent, []);
});

// ── htmlToText (web-link knowledge) ────────────────────────────────────────

test('htmlToText strips scripts, styles, tags and decodes entities', () => {
  const html = md(
    '<html><head><title>Acme &amp; Co</title><style>body{color:red}</style></head>',
    '<body><script>steal()</script><h1>Pricing</h1><p>Pro plan is &lt;b&gt;$20&lt;/b&gt; per seat &#8212; billed yearly.</p><div>Contact sales &#x40; acme.com</div></body></html>'
  );
  const text = customize.htmlToText(html);
  assert.ok(!text.includes('steal()'), 'script bodies removed');
  assert.ok(!text.includes('color:red'), 'style bodies removed');
  assert.ok(text.includes('Acme & Co'));
  assert.ok(text.includes('Pro plan is <b>$20</b> per seat — billed yearly.'));
  assert.ok(text.includes('Contact sales @ acme.com'));
  assert.ok(!text.includes('<p>'), 'tags stripped');
});

test('htmlToText yields empty output for script-only documents', () => {
  assert.equal(customize.htmlToText('<html><script>var x=1;</script></html>'), '');
});
