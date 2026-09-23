<div align="center">

# Nyx

**The invisible AI interview copilot.**

Real-time AI help on a stealth overlay that screen sharing cannot see. Ask by voice or screenshot, and get clear answers that stream in as you need them.

<p>
  <a href="https://github.com/devansh0703/Nyx/releases/latest"><img src="https://img.shields.io/github/v/release/devansh0703/Nyx?style=for-the-badge&label=Latest&color=111111&labelColor=000000" alt="Latest release" /></a>
  <a href="https://github.com/devansh0703/Nyx/releases"><img src="https://img.shields.io/github/downloads/devansh0703/Nyx/total?style=for-the-badge&color=111111&labelColor=000000" alt="Downloads" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache_2.0-111111?style=for-the-badge&labelColor=000000" alt="Apache 2.0 License" /></a>
  <img src="https://img.shields.io/badge/Platforms-Windows%20%7C%20macOS%20%7C%20Linux-111111?style=for-the-badge&labelColor=000000" alt="Platforms" />
</p>

<a href="https://github.com/devansh0703/Nyx"><b>GitHub</b></a> &nbsp;|&nbsp;
<a href="#download">Download</a> &nbsp;|&nbsp;
<a href="#quick-start">Quick start</a> &nbsp;|&nbsp;
<a href="#how-it-works">How it works</a>

</div>

## Demo

https://github.com/user-attachments/assets/896a7140-1e85-405d-bfbe-e05c9f3a816b

## What it is

Nyx is a desktop app for technical interviews and practice. It places a small overlay on your screen that recording and conferencing tools do not capture. You can speak a question or take a screenshot, and the AI answers in real time. The answer streams into a floating window and an optional chat panel, with clean code blocks and syntax highlighting.

It is free and open source. Processing stays on your machine, and the only thing that leaves your device is the request you send to the AI provider.

## Highlights

- **Invisible overlay.** Windows stay out of Zoom, Google Meet, Microsoft Teams, Discord, and OBS captures. You see the answer, the call does not.
- **Hidden during screen share.** When a share starts, the app can hide every window on its own.
- **Flexible local voice.** Choose manual start/stop capture or automatic voice-activity detection without fixed-timer sentence cuts.
- **Configurable streamed answers.** Route voice replies to chat, the floating overlay, or both.
- **Direct image analysis.** Screenshots go straight to the vision-language model (llama-3.2-11b-vision) for visual reasoning, with no slow OCR step in between.
- **Session memory.** The whole conversation is remembered, so follow-ups, edge cases, and optimizations keep their context.
- **Language aware.** Tailored answers for C++, C, Python, Java, and JavaScript.
- **Stealthy by design.** Runs under ordinary system names, ships with no telemetry, and keeps your session local.
- **Full meeting assistant.** Live Insights with mic + system audio, Smart Mode, AI meeting notes, resume, share links, calendar alerts and auto-attend (see [Meeting assistant features](#meeting-assistant-features-nyx-parity) and the [technical reference](docs/reference-nyx-parity.md)).
- **Cross platform.** Pre-built installers for Windows and Linux (.deb and AppImage). macOS runs from source in one command.

## Download

Pre-built installers are published with every release. These links always point at the newest version.

| Platform | File | Notes |
|---|---|---|
| Windows | [Setup .exe](https://github.com/devansh0703/Nyx/releases/latest) | NSIS installer. Adds a Start Menu shortcut. |
| Linux (Debian or Ubuntu) | [.deb](https://github.com/devansh0703/Nyx/releases/latest) | Pulls system deps automatically (Python, ffmpeg, GTK). |
| Linux (universal) | [.AppImage](https://github.com/devansh0703/Nyx/releases/latest) | No install. Run `chmod +x` then launch. |

> **macOS:** there is no pre-built download. The app is unsigned and un-notarized, so macOS Gatekeeper blocks it as "damaged and can't be opened." Run Nyx from source instead — see [Quick start](#quick-start). It is a one-line `./setup.sh` once Node.js is installed.

Every build is produced automatically on GitHub Actions and ships with SHA-256 checksums. Each release also lists the full set of commits it includes.

The [releases page](https://github.com/devansh0703/Nyx/releases/latest) has installers for Windows (`.exe`), Linux (`.deb` / `.AppImage`), and checksums.

## Quick start

If you would rather build from source, three steps are all it takes.

1. Clone the repository.

   ```bash
   git clone https://github.com/devansh0703/Nyx.git
   cd Nyx
   ```

2. Run the setup script.

   ```bash
   ./setup.sh
   ```

   The script installs Node dependencies, creates your `.env` from the example, and launches the app.

3. Add your API keys.

   On first launch the onboarding wizard asks for an **NVIDIA API key** ([build.nvidia.com](https://build.nvidia.com/), the primary AI backend) and a **Gemini API key** ([Google AI Studio](https://aistudio.google.com/), alternate backend + voice transcription). Both can also be exported in `~/.bashrc` or edited in `.env` directly.

### Platform notes

- On Windows, use Git Bash (included with Git for Windows) or WSL to run `setup.sh`.
- On macOS and Linux, your normal terminal works.
- **macOS users must build from source** (steps above) — there is no pre-built `.dmg`. Because the app is unsigned, a downloaded build would be blocked by Gatekeeper as "damaged"; running from source avoids that entirely.
- No manual `npm` commands are needed. The script handles everything.

### Setup script options

```bash
./setup.sh --build                # Build a distributable for your OS
./setup.sh --ci                   # Use npm ci instead of npm install
./setup.sh --no-run               # Set up only, do not launch
./setup.sh --install-system-deps  # Install sox for the microphone (optional)
```

## Configuration

The setup script writes sensible defaults. The only required value is an NVIDIA API key for the LLM backend.

```bash
# Required — NVIDIA NIM (meta/llama-3.2-11b-vision-instruct, text + vision)
# Get your key at https://build.nvidia.com and export NVIDIA_API_KEY in ~/.bashrc,
# or set it in .env below.
NVIDIA_API_KEY=your_nvidia_api_key_here

# Alternate AI backend + all voice transcription (gemini-3.5-flash-lite,
# text + vision + audio). Get your key at https://aistudio.google.com/apikey
# and export GEMINI_API_KEY in ~/.bashrc, or set it in .env below.
GEMINI_API_KEY=your_gemini_api_key_here

# Output language for AI responses, meeting notes, summaries and action items
OUTPUT_LANGUAGE=English
# Meeting audio language (drives Gemini transcription)
MEETING_AUDIO_LANGUAGE=auto

# Which backend answers chat/vision: nvidia (default) or gemini
LLM_PROVIDER=nvidia
```

Speech is optional. With GEMINI_API_KEY set, the microphone button appears; without it, the microphone button hides itself across the app.

## Meeting assistant features (Nyx parity)

Nyx ships a full meeting-assistant mode alongside the interview copilot:

- **Live Insights.** A draggable live panel with real-time transcript (mic **and** system/loopback audio, so it hears the other party), dynamic insights, and one-click actions: say next, follow-up questions, fact check, who am I talking to, and recap.
- **Smart Mode (⚡).** A lightning toggle that routes every action through elite competitive-programming prompts for coding interviews.
- **Sessions.** Start/End with a timer and a Listen (audio) toggle. End a session and detailed notes, key insights, next steps, and a follow-up email are generated automatically.
- **Resume Session.** Continue a saved meeting from Dashboard → Activity — the transcript reloads in place and context accumulates under the same meeting id.
- **Share notes.** Generate a standalone HTML link for any meeting; the URL is copied to your clipboard.
- **Meeting alerts & auto-attend.** Reads your `.ics` calendar, shows a Join banner when a meeting starts, and (with `CALENDAR_AUTO_ATTEND=true`) starts and ends the listening session for you, generating notes when the slot ends.
- **Modes & knowledge.** Customize the assistant per scenario and attach a knowledge base (paste text **or fetch a page by URL**) from the Dashboard.
- **Custom Live Actions.** Define one-click buttons in Dashboard → Actions: prompt actions run an AI query against the live transcript, link actions open any URL — they appear instantly in Live Insights.
- **Custom notes templates.** Edit the markdown template the AI uses for meeting notes (Dashboard → Activity); every `##` heading becomes a section on the saved notes page.
- **Call coaching & analytics.** Score any call 0–10 across five coaching dimensions from its notes page, then track sessions, average/best score, talk time, and dimension averages in Dashboard → Analytics.
- **Pre-call briefs.** Before a meeting starts, the app prepares a brief from the calendar entry.
- **Languages.** `OUTPUT_LANGUAGE` controls every AI output; `MEETING_AUDIO_LANGUAGE` drives transcription (15 languages selectable in Settings).
- **Settings.** Invisibility toggle, change display, auto-launch, editable keyboard shortcuts (see below), tutorial, and version info.

## Voice setup

Voice transcription runs on **Google Gemini** — it accepts audio natively, so there is nothing to install. Set `GEMINI_API_KEY` (bashrc or `.env`) and the mic features come alive. NVIDIA has no audio input, so Gemini handles all transcription regardless of which backend answers chat.

## How it works

1. **Ask.** Use automatic pause detection, choose manual start/stop capture in Settings, or use the screenshot shortcut.
2. **Reason.** The selected model (NVIDIA NIM vision-language or Gemini) reads the audio or image with full conversation context and works toward a precise answer.
3. **Answer.** Voice responses stream to chat, the overlay, or both, according to Settings.

## Keyboard shortcuts

| Action | Shortcut | Description |
|---|---|---|
| Screenshot capture | `Cmd/Ctrl + Shift + S` | Capture the screen and analyze it with the vision model |
| Toggle speech | `Alt + R` | Start or stop voice recognition, if configured |
| Toggle visibility | `Cmd/Ctrl + Shift + V` | Show or hide all windows |
| Toggle interaction | `Cmd/Ctrl + Shift + I` or `Alt + A` | Enable or disable click through |
| Open chat | `Cmd/Ctrl + Shift + C` | Open the interactive chat window |
| Live Insights | `Cmd/Ctrl + Shift + L` | Toggle the live insights panel |
| Settings | `Cmd/Ctrl + ,` | Open the settings panel |

Every shortcut is editable or disable-able in **Settings → Keyboard Shortcuts**, or via `SHORTCUT_<ID>` in `.env` (set to `disabled` to unbind). Changes apply live without a restart.

## Project status

Nyx is under active development. The core is stable and improvements ship regularly.

### Done

- Stealth overlay with a draggable command bar and a click through toggle
- Hidden during screen share, with automatic hiding when a share begins
- Screenshot capture with direct vision-model analysis, no OCR step
- Configurable manual or VAD-driven voice capture
- Voice transcription on Gemini audio, with an auto hiding mic button
- Configurable chat/overlay routing for streamed voice answers
- AI response window with markdown and syntax highlighting
- Global shortcuts for capture, visibility, interaction, chat, and settings (all editable/disable-able)
- Session memory and a full chat UI
- Language picker and a DSA skill prompt
- Multi-monitor and area capture support
- Window binding and positioning
- Settings management with disguise and stealth modes
- NVIDIA NIM LLM backend (llama-3.2-11b-vision-instruct: text + vision)
- Full meeting-assistant suite: Live Insights, Smart Mode, sessions with AI notes, resume, share links, calendar alerts/auto-attend, system-audio listening, pre-call briefs

### Planned

- Multiple model backends alongside Gemini (OpenAI, Anthropic, local)
- Auto typing of code snippets into editors and IDEs
- Export of conversation history to markdown or PDF
- Deeper stealth, including process name randomization

## Troubleshooting

<details>
<summary>Setup issues</summary>

- **setup.sh will not run.** Make sure you are in the project folder (`cd Nyx`) and that the script is executable (`chmod +x setup.sh`). On Windows, use Git Bash.
- **Setup stops with exit code 130.** That means Ctrl+C was pressed. Run `./setup.sh` again.
- **Node or npm not found.** Install Node.js 18 or newer from [nodejs.org](https://nodejs.org/), restart the terminal, and retry.

</details>

<details>
<summary>App issues</summary>

- **Electron will not start or shows a blank window on Linux.** Try `npm run dev`, and make sure X11 or XWayland is available in headless setups.
- **macOS screen capture does not work.** Grant Screen Recording permission under System Settings, Privacy and Security, then relaunch the app.
- **Windows SmartScreen blocks the app.** Click More info, then Run anyway, or use `npm start` during development.
- **Microphone or voice not working.** Voice needs a Gemini key: set `GEMINI_API_KEY` in `~/.bashrc` or `.env`. Also install `sox` (or run `./setup.sh --install-system-deps`) so the mic capture works.

</details>

<details>

<summary> Limitations </summary>

- **Screen-capture invisibility does not work on Linux.** The overlay stays hidden from screen shares and recordings only on **macOS** and **Windows**. This relies on Electron's `setContentProtection`, which maps to `NSWindowSharingNone` on macOS and `WDA_EXCLUDEFROMCAPTURE` on Windows. Electron provides **no equivalent on Linux** (neither X11 nor Wayland), so on Linux the call is a silent no-op and the overlay **will be visible** to anyone you screen-share with. This is a platform limitation, not a bug — there is no window flag on Linux that excludes a window from framebuffer capture. If you need capture-invisibility, run Nyx on macOS or Windows. As a partial workaround on Linux, share a single application window instead of your entire screen, or place the overlay on a monitor you are not sharing.

</details>



## Privacy and ethics

Nyx collects no data and sends no telemetry. Processing happens locally, and your session stays on your device. Requests to the AI provider are encrypted in transit.

The app is built for learning and practice. You are responsible for following the rules of any interview you take and the policies of the companies involved.

## License

Released under the Apache License 2.0. See [LICENSE](LICENSE) for details.

## Acknowledgments

- Google Gemini for voice transcription and the alternate AI backend
- NVIDIA NIM for the AI reasoning backend
- Electron for the cross platform desktop runtime
- [Vysper by varun-singhh](https://github.com/varun-singhh/Vysper) for UI and structure inspiration

<div align="center">

Built by [Devansh](https://github.com/devansh0703). If Nyx helped you, consider giving it a star ⭐

</div>
