# Changelog

## 1.1.0 (2026-09-24)

Nyx v1.1.0 — NVIDIA + Gemini dual-AI, meeting-assistant suite, devansh0703 takeover.

Built on the original cluely-parity base; this release consolidates all work
since into one commit and restarts versioning at 1.1.0.

### Added

- Gemini as a full selectable LLM provider (gemini-3.5-flash-lite: text + vision
  + audio) alongside NVIDIA NIM — switch in Settings, default stays NVIDIA
- Gemini-powered voice transcription: mic/system audio runs through Gemini audio
  (NVIDIA has no audio input); no local install needed, 15-RPM safe pacing with
  429 backoff
- Gemini API key screen in the onboarding wizard (NVIDIA key + Gemini key)
- Meeting-assistant suite: custom live actions, custom notes templates, call
  coaching scores + analytics, URL knowledge fetching, 15 transcription
  languages
- CI workflow (syntax, tests, Linux build gate) and scripts/qa-ipc-audit.js
- Test suite (node:test) covering session lifecycle and app logic
- webapp/DEMO-VIDEO.md — guide for recording the site demo video

### Removed

- Local Whisper speech: worker service, installer, Python worker, setup.sh venv
  bootstrap, model download step
- Azure Speech: SDK dependency and key/region fields
- All OpenCluely/TechyCSR identity: product is Nyx, maintained by devansh0703;
  TechyCSR credited as the original codebase author; Apache License 2.0
  retained from the original project

### Fixed

- gemini.service: apiKey referenced before definition in _doChat (transcription
  threw "apiKey is not defined")
- Default shortcuts CommandOrControl+\ and CommandOrControl+Shift+\ were
  over-escaped — shortcut registration failed on every launch
- gemini-2.5-flash-lite → gemini-3.5-flash-lite (2.5 is no longer served to new
  API keys); Gemini 3.5 stock-echo phrases added to the hallucination filter
- release.yml: escaped markdown backticks executed as a command in the changelog
  step (exit 127)
- Onboarding loop for pre-configured installs; session-id collisions; dead
  preload IPC channels
- All repo references point at github.com/devansh0703/Nyx
