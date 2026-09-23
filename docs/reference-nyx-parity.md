# Reference: Meeting Assistant (Nyx parity)

This is the technical reference for Nyx's meeting-assistant surface — the Live Insights
panel, session lifecycle, notes, calendar automation, and every setting that controls them.
All claims are traceable to code paths listed inline.

## Architecture at a glance

```
Renderer (Live Insights / Dashboard / Settings)
      │  window.electronAPI.* (preload.js)
      ▼
ipcMain handlers (main.js)
      │
      ├── SessionLifecycleManager  (src/managers/session-lifecycle.manager.js)
      │     session state, transcript, smart mode, auto-attend, notes on disk
      ├── SpeechService            (src/services/speech.service.js)
      │     mic capture + system-audio parser, VAD, Gemini audio transcription
      ├── PreCallManager           (src/managers/precall.manager.js)
      │     .ics parsing, upcoming meetings, pre-call briefs
      └── LLMService               (src/services/llm.service.js)
            Google Gemini (gemini-3.5-flash-lite) chat + actions
```

## Session lifecycle

Managed by `SessionLifecycleManager` (CJS singleton; the class is also exported for tests).

| Method | What it does |
|---|---|
| `start({title, audio})` | Opens a listening session. Idempotent while active. |
| `stop()` | Ends the session and emits `session-stopping`. |
| `resume(meetingId)` | Reloads a saved meeting's transcript from disk and continues under the same id (Cluely "Resume Session"). |
| `setSmartMode(bool)` | Toggles Smart Mode; emits `smart-mode-changed`. |
| `addTranscriptEntry(text, {source, speaker})` | Appends an entry and emits `transcript-entry`. `source` is `speech` (mic) or `system`; `speaker` is `user` or `other`. |
| `autoAttendMeeting(meeting)` / `autoAttendEnd()` | Calendar-driven start/end; stores `{title, start, end}` in `_autoAttend`. |
| `generateAndSaveNotes(llm)` | Calls the LLM with the meeting-notes prompt, persists JSON to `userData/meetings/<id>.json`, emits `notes-generated`. |
| `getStatus()` | `{active, title, elapsedMs, audioEnabled, smartMode, autoAttending, ...}`. |

Events (on `sessionLifecycle.events`): `session-started`, `session-stopping`, `transcript-entry`,
`smart-mode-changed`, `audio-toggled`, `notes-generated`.

## System-audio parser

`SpeechService` runs a second, independent VAD state machine fed by renderer loopback capture:

1. Renderer (Live Insights 📢 button) calls `navigator.mediaDevices.getDisplayMedia({audio: true})`.
2. PCM16 @16kHz mono chunks are sent over the `audio-chunk-system` IPC channel.
3. `handleSystemAudioChunk()` accumulates voiced utterances (pre-roll included, noise-floor
   adaptive thresholds) and flushes them through the same Gemini path as the mic.
4. Transcripts emit as `{source: 'system', speaker: 'other'}` and never block the mic path
   (fire-and-forget, hallucination-filtered).

Toggle: `session-toggle-system-audio` / state via `session-get-system-audio`.

## Meeting notes & sharing

- Notes JSON: `userData/meetings/<id>.json` with `detailedNotes`, `keyInsights`, `nextSteps`,
  `missedOpportunities`, `followUpEmail`, and the full `transcript` (entries shaped
  `{id, timestamp, offsetMs, source, speaker, text}`).
- Share (`meeting-share` IPC): writes a sanitized, entity-escaped standalone HTML file to
  `userData/shared-notes/<id>.html` (dir `0o700`, file `0o600`) and returns its `file://` URL
  on the clipboard.

## Calendar automation

`startMeetingAlertScheduler()` in main.js polls calendar events every 30s:

- Fires `meeting-starting` to all windows within 2 minutes of a meeting's start (Join banner
  in the Dashboard).
- With `CALENDAR_AUTO_ATTEND=true`, auto-starts a session titled with the meeting summary
  (never steals an active manual session), then auto-ends at slot end and generates notes.
  End-matching compares title **and** start time so same-named recurring meetings cannot
  end each other's sessions.

## IPC channel map (new in the parity work)

| Channel | Direction | Purpose |
|---|---|---|
| `session-smart-mode` / `session-get-smart-mode` | R→M | Toggle / read Smart Mode |
| `session-resume` | R→M | Resume a saved meeting |
| `session-toggle-system-audio` / `session-get-system-audio` | R→M | System-audio parser toggle/state |
| `audio-chunk-system` | R→M (send) | PCM16 chunks from loopback capture |
| `meeting-share` | R→M | Generate shareable HTML link |
| `meeting-starting` | M→R (broadcast) | Join banner alert |
| `set-shortcut` / `reset-shortcuts` / `get-shortcuts` | R→M | Editable keyboard shortcuts |
| `set-output-language` / `get-output-language` | R→M | AI output language |
| `set-meeting-audio-language` | R→M | Transcription language |
| `set-invisibility-mode` | R→M | Screen-share invisibility |
| `move-to-display` | R→M | Move overlay to a chosen display |
| `set-auto-launch` | R→M | OS login auto-launch |
| `set-calendar-auto-attend` | R→M | Calendar auto-attend toggle |

## Environment variables

| Variable | Default | Effect |
|---|---|---|
| `OUTPUT_LANGUAGE` | `English` | Language for all AI outputs (actions, notes, briefs, emails) — injected into `runAction` and chat system messages. |
| `MEETING_AUDIO_LANGUAGE` | `auto` | Language hint passed to Gemini audio transcription. |
| `CALENDAR_AUTO_ATTEND` | `true` | Auto start/end sessions from the calendar scheduler. |
| `INVISIBILITY_MODE` | `on` | `setContentProtection` on overlay windows (no-op on Linux). |
| `AUTO_LAUNCH` | `off` | `app.setLoginItemSettings` on startup. |
| `SHORTCUT_<ID>` | built-ins | Electron accelerator or `disabled`. Ids: SCREENSHOT, TOGGLEVISIBILITY, FORCEONTOP, SCREENASSIST, STEALTHANSWER, CLEARCONTEXT, TOGGLELIVEINSIGHTS, MOVELEFT, MOVERIGHT, TOGGLEINTERACTION, OPENCHAT, OPENSETTINGS, TOGGLEMIC, MOVEUP, MOVEDOWN. |

## Smart Mode prompts

When Smart Mode is on, `SessionLifecycleManager` swaps the default action prompts for
`smart-say-next`, `smart-follow-ups`, and `smart-recap` — competitive-programming-flavored
instructions (approach choice, complexity analysis, edge cases) defined in `ACTION_PROMPTS`.

## Tests

`npm test` runs the `node:test` suite in `tests/`. `tests/qa-session-lifecycle.test.js`
covers start idempotency, stop, smart-mode coercion, resume-from-disk (with the real persisted
entry shape), auto-attend guards, and a regression for the duplicate-`getStatus()` bug.
