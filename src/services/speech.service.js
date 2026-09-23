// Speech Service — audio capture + VAD + Gemini audio transcription.
//
// AI providers: NVIDIA NIM (text/vision) and Google Gemini (text/vision AND
// audio transcription). There is no Azure and no local Whisper: Gemini's
// generateContent accepts inline audio, so mic/system utterances captured as
// 16kHz mono PCM are wrapped in a WAV header and sent to
//   POST /v1beta/models/{model}:generateContent  (audio/wav inline_data)
//
// Capture paths:
//   - Linux: arecord/sox via node-record-lpcm16 (native, in-process)
//   - Windows/macOS: renderer getUserMedia chunks over IPC (no sox dependency)
// VAD segments audio on natural pauses so each Gemini request is one utterance.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { EventEmitter } = require('events');
const logger = require('../core/logger').createServiceLogger('SPEECH');
const config = require('../core/config');

let recorder = null;
try {
  recorder = require('node-record-lpcm16');
} catch (error) {
  logger.warn('Local audio recorder dependency unavailable', { error: error.message });
}

class SpeechService extends EventEmitter {
  constructor() {
    super();
    this.isRecording = false;
    this.sessionStartTime = null;
    this.recording = null;
    this.available = false;
    this.provider = 'disabled';
    this.runtimeSettings = {};
    this.segmentBuffers = [];
    this.segmentBytes = 0;
    this.segmentTimer = null;
    this.transcriptionInFlight = false;
    this.pendingFlush = false;
    this.pendingFinal = false;
    this.audioProgram = null;
    this.isProcessingAudio = false;
    this.manualStopRequested = false;
    this._resetVadState();
    // System-audio parser state (loopback/other-party voice)
    this.systemAudioEnabled = false;
    this._resetSystemVadState();

    this.initializeClient();
  }

  _geminiService() {
    return require('./gemini.service');
  }

  initializeClient() {
    this._cleanup();
    this.available = false;

    // Transcription requires a Gemini key (audio goes to the Gemini API).
    const gemini = this._geminiService();
    if (gemini.isInitialized) {
      this.provider = 'gemini';
      this.available = true;
      logger.info('Speech transcription initialized (Gemini audio)', {
        model: gemini.model,
      });
      this.emit('status', 'Gemini audio transcription ready');
      return;
    }

    this.provider = 'disabled';
    const reason = 'Speech transcription disabled. Set GEMINI_API_KEY (audio transcription runs on Gemini).';
    logger.warn(reason);
    this.emit('status', reason);
  }

  startRecording() {
    try {
      if (!this.available) {
        const errorMsg = `Speech provider "${this.provider}" is not available`;
        logger.error(errorMsg);
        this.emit('error', errorMsg);
        return;
      }

      if (this.isRecording) {
        logger.warn('Recording already in progress');
        return;
      }

      if (this.isProcessingAudio) {
        this.emit('status', 'Please wait for the current transcription to finish');
        return;
      }

      this.sessionStartTime = Date.now();
      this.isRecording = true;
      this.segmentBuffers = [];
      this.segmentBytes = 0;
      this.transcriptionInFlight = false;
      this.pendingFlush = false;
      this.pendingFinal = false;
      this.manualStopRequested = false;
      this._resetVadState();
      this.emit('recording-started');
      this.emit('status', 'Recording started (Gemini transcription)');

      // Capture microphone audio in the renderer via the Web Audio API on
      // Windows and macOS (no sox there; getUserMedia also triggers the macOS
      // mic permission prompt cleanly). Linux uses the native recorder path.
      this.useRendererCapture = process.platform === 'win32' || process.platform === 'darwin';
      if (this.useRendererCapture) {
        this.emit('status', 'Waiting for microphone audio…');
        if (!this._isManualCaptureMode()) {
          this._startSegmentWatchdog();
        }
        return;
      }

      this._startMicrophoneCapture();
      if (!this._isManualCaptureMode()) {
        this._startSegmentWatchdog();
      }
    } catch (error) {
      logger.error('Critical error in startRecording', { error: error.message, stack: error.stack });
      this.emit('error', `Speech recognition failed to start: ${error.message}`);
      this.isRecording = false;
    }
  }

  _resetVadState() {
    this.vadSpeaking = false;        // currently inside an utterance
    this.vadSpeechMs = 0;            // accumulated voiced audio in this segment
    this.vadSilenceMs = 0;           // trailing silence since last voiced chunk
    this.vadNoiseFloor = 0;          // adaptive EMA of background energy
    this.vadNoiseInit = false;       // has the noise floor been seeded
    this.vadPreRoll = [];            // ring of recent pre-speech chunks
    this.vadPreRollMs = 0;           // duration held in the pre-roll ring
    this.vadLastChunkAt = 0;         // timestamp of the last ingested chunk
  }

  /**
   * Lightweight watchdog. Flushes a stalled utterance and enforces the
   * max-utterance cap as a backstop.
   */
  _startSegmentWatchdog() {
    if (this.segmentTimer) {
      clearInterval(this.segmentTimer);
    }
    this.segmentTimer = setInterval(() => {
      if (!this.isRecording || this.provider !== 'gemini') {
        return;
      }

      const sinceLastChunk = this.vadLastChunkAt ? Date.now() - this.vadLastChunkAt : 0;
      const stalled = this.vadSpeaking && sinceLastChunk > 1500;
      const tooLong = this.vadSpeaking && this.vadSpeechMs >= this._getMaxUtteranceMs();
      if (stalled || tooLong) {
        this._endUtteranceFlush();
      }
    }, 500);
  }

  /**
   * Receive raw 16kHz mono 16-bit PCM audio from the renderer and add it to
   * the current utterance buffer.
   */
  handleAudioChunkFromRenderer(chunk) {
    if (!this.isRecording || this.provider !== 'gemini' || !this.useRendererCapture) {
      return;
    }
    if (!chunk || !chunk.length) {
      return;
    }
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this._ingestAudio(buffer);
  }

  /**
   * Compute the RMS energy (normalized to 0..1) of a 16-bit little-endian PCM
   * buffer. Used as the voice-activity signal.
   */
  _chunkRmsEnergy(buffer) {
    const sampleCount = Math.floor(buffer.length / 2);
    if (sampleCount === 0) {
      return 0;
    }
    let sumSquares = 0;
    for (let i = 0; i < sampleCount; i++) {
      const sample = buffer.readInt16LE(i * 2) / 32768;
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / sampleCount);
  }

  /**
   * Single ingest path for both capture backends. Runs the VAD state machine:
   * accumulate audio while the user speaks, and flush the segment to Gemini
   * once a natural pause (trailing silence) is detected.
   */
  _ingestAudio(buffer) {
    if (!buffer || !buffer.length) {
      return;
    }

    if (this._isManualCaptureMode()) {
      this.segmentBuffers.push(buffer);
      this.segmentBytes += buffer.length;
      this.vadLastChunkAt = Date.now();

      const capturedMs = this.segmentBytes / 32;
      if (!this.manualStopRequested && capturedMs >= this._getManualCaptureMaxMs()) {
        this.manualStopRequested = true;
        this.emit('status', 'Maximum recording duration reached; processing audio');
        setImmediate(() => this.stopRecording());
      }
      return;
    }

    this.vadLastChunkAt = Date.now();
    const chunkMs = this._chunkDurationMs(buffer);
    const energy = this._chunkRmsEnergy(buffer);

    const floor = this._getVadEnergyFloor();
    // Seed / adapt the background noise floor while not actively speaking so
    // the threshold tracks the room. Seed conservatively (see git history).
    if (!this.vadNoiseInit) {
      this.vadNoiseFloor = Math.min(energy, floor);
      this.vadNoiseInit = true;
    }
    // Hysteresis: it takes more energy to *start* an utterance than to keep
    // one going, so a brief dip mid-sentence doesn't end it prematurely.
    const enterThreshold = Math.max(floor, this.vadNoiseFloor * 2.5);
    const exitThreshold = Math.max(floor * 0.7, this.vadNoiseFloor * 1.6);
    const isVoiced = this.vadSpeaking ? energy >= exitThreshold : energy >= enterThreshold;

    if (!this.vadSpeaking) {
      if (isVoiced) {
        // Speech onset: prepend the pre-roll so the first syllable survives.
        this.vadSpeaking = true;
        this.vadSpeechMs = 0;
        this.vadSilenceMs = 0;
        for (const pre of this.vadPreRoll) {
          this.segmentBuffers.push(pre);
          this.segmentBytes += pre.length;
        }
        this.vadPreRoll = [];
        this.vadPreRollMs = 0;
        this.segmentBuffers.push(buffer);
        this.segmentBytes += buffer.length;
        this.vadSpeechMs += chunkMs;
      } else {
        // Background: adapt the noise floor and keep a short pre-roll ring.
        this.vadNoiseFloor = this.vadNoiseFloor * 0.95 + energy * 0.05;
        this.vadPreRoll.push(buffer);
        this.vadPreRollMs += chunkMs;
        const preRollLimit = this._getPreRollMs();
        while (this.vadPreRollMs > preRollLimit && this.vadPreRoll.length > 1) {
          const dropped = this.vadPreRoll.shift();
          this.vadPreRollMs -= this._chunkDurationMs(dropped);
        }
      }
      return;
    }

    // Already speaking: keep capturing (including trailing silence so word
    // endings aren't clipped) and watch for a pause that ends the utterance.
    this.segmentBuffers.push(buffer);
    this.segmentBytes += buffer.length;
    if (isVoiced) {
      this.vadSpeechMs += chunkMs;
      this.vadSilenceMs = 0;
    } else {
      this.vadSilenceMs += chunkMs;
    }

    const pausedLongEnough = this.vadSilenceMs >= this._getSilenceHangoverMs();
    const haveRealSpeech = this.vadSpeechMs >= this._getMinUtteranceMs();
    const tooLong = this.vadSpeechMs >= this._getMaxUtteranceMs();

    if ((pausedLongEnough && haveRealSpeech) || tooLong) {
      this._endUtteranceFlush();
    } else if (pausedLongEnough && !haveRealSpeech) {
      // Just noise (cough/click) with no real speech — discard, don't waste a
      // Gemini request or risk a hallucinated transcript.
      this.segmentBuffers = [];
      this.segmentBytes = 0;
      this.vadSpeaking = false;
      this.vadSpeechMs = 0;
      this.vadSilenceMs = 0;
    }
  }

  /** Flush the accumulated utterance and reset VAD for the next one. */
  _endUtteranceFlush() {
    this.vadSpeaking = false;
    this.vadSpeechMs = 0;
    this.vadSilenceMs = 0;
    this.vadPreRoll = [];
    this.vadPreRollMs = 0;
    this._flushSegment({ final: false }).catch((error) => {
      logger.error('Segment transcription failed', { error: error.message });
    });
  }

  _chunkDurationMs(buffer) {
    // 16kHz mono 16-bit => 2 bytes/sample => 32 bytes/ms.
    return buffer.length / 32;
  }

  // ── System-audio parser (Nyx listens to the other party too) ─────────
  // Parallel VAD pipeline for system/loopback capture (getDisplayMedia audio).
  // Utterances are transcribed with the same Gemini audio path and emitted as
  // transcription events tagged { source: 'system', speaker: 'other' } so the
  // meeting transcript distinguishes who said what.

  setSystemAudioEnabled(enabled) {
    this.systemAudioEnabled = !!enabled;
    if (!this.systemAudioEnabled) {
      this._resetSystemVadState();
    }
    logger.info('System-audio parser toggled', { enabled: this.systemAudioEnabled });
    return this.systemAudioEnabled;
  }

  isSystemAudioEnabled() {
    return !!this.systemAudioEnabled;
  }

  _resetSystemVadState() {
    this.sysBuffers = [];
    this.sysBytes = 0;
    this.sysSpeaking = false;
    this.sysSpeechMs = 0;
    this.sysSilenceMs = 0;
    this.sysPreRoll = [];
    this.sysPreRollMs = 0;
    this.sysNoiseFloor = 0.01;
    this.sysNoiseInit = false;
  }

  /**
   * Receive raw 16kHz mono 16-bit PCM from the system/loopback capture stream
   * and run it through a dedicated VAD state machine (independent of the mic's).
   */
  handleSystemAudioChunk(chunk) {
    if (!this.isRecording || this.provider !== 'gemini') return;
    if (!this.systemAudioEnabled) return;
    if (!chunk || !chunk.length) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    const chunkMs = this._chunkDurationMs(buffer);
    const energy = this._chunkRmsEnergy(buffer);
    const floor = this._getVadEnergyFloor();

    if (!this.sysNoiseInit) {
      this.sysNoiseFloor = Math.min(energy, floor);
      this.sysNoiseInit = true;
    }

    const enterThreshold = Math.max(floor, this.sysNoiseFloor * 2.5);
    const exitThreshold = Math.max(floor * 0.7, this.sysNoiseFloor * 1.6);
    const isVoiced = this.sysSpeaking ? energy >= exitThreshold : energy >= enterThreshold;

    if (!this.sysSpeaking) {
      if (isVoiced) {
        this.sysSpeaking = true;
        this.sysSpeechMs = 0;
        this.sysSilenceMs = 0;
        for (const pre of this.sysPreRoll) {
          this.sysBuffers.push(pre);
          this.sysBytes += pre.length;
        }
        this.sysPreRoll = [];
        this.sysPreRollMs = 0;
        this.sysBuffers.push(buffer);
        this.sysBytes += buffer.length;
        this.sysSpeechMs += chunkMs;
      } else {
        this.sysNoiseFloor = this.sysNoiseFloor * 0.95 + energy * 0.05;
        this.sysPreRoll.push(buffer);
        this.sysPreRollMs += chunkMs;
        const preRollLimit = this._getPreRollMs();
        while (this.sysPreRollMs > preRollLimit && this.sysPreRoll.length > 1) {
          const dropped = this.sysPreRoll.shift();
          this.sysPreRollMs -= this._chunkDurationMs(dropped);
        }
      }
      return;
    }

    // Speaking: accumulate and watch for the pause that ends the utterance.
    this.sysBuffers.push(buffer);
    this.sysBytes += buffer.length;
    if (isVoiced) {
      this.sysSpeechMs += chunkMs;
      this.sysSilenceMs = 0;
    } else {
      this.sysSilenceMs += chunkMs;
    }

    const pausedLongEnough = this.sysSilenceMs >= this._getSilenceHangoverMs();
    const haveRealSpeech = this.sysSpeechMs >= 500;
    const tooLong = this.sysSpeechMs >= this._getMaxUtteranceMs();

    if ((pausedLongEnough && haveRealSpeech) || tooLong) {
      this._endSystemUtteranceFlush();
    } else if (pausedLongEnough && !haveRealSpeech) {
      this._resetSystemVadState();
    }
  }

  _endSystemUtteranceFlush() {
    const buffers = this.sysBuffers;
    const bytes = this.sysBytes;
    this._resetSystemVadState();
    if (!bytes) return;
    const audioBuffer = Buffer.concat(buffers, bytes);
    // Fire-and-forget: system transcription must never block the mic path.
    this._transcribeAudioBuffer(audioBuffer)
      .then((transcript) => {
        const clean = transcript ? transcript.trim() : '';
        if (clean && !this._isHallucinatedTranscript(clean)) {
          this.emit('transcription', clean, { source: 'system', speaker: 'other' });
        }
      })
      .catch((error) => {
        logger.warn('System-audio transcription failed', { error: error.message });
      });
  }

  stopRecording() {
    if (!this.isRecording) {
      return;
    }

    this.isRecording = false;
    const sessionDuration = this.sessionStartTime ? Date.now() - this.sessionStartTime : 0;
    logger.info('Stopping speech recognition session', {
      provider: this.provider,
      sessionDuration: `${sessionDuration}ms`
    });

    if (this.recording) {
      try {
        this.recording.stop();
      } catch (error) {
        logger.error('Error stopping audio recording', { error: error.message });
      }
      this.recording = null;
    }

    this.isProcessingAudio = true;
    this.emit('recording-stopped');
    this.emit('status', 'Processing speech…');

    const finish = () => {
      this._cleanup();
      this.isProcessingAudio = false;
      this.emit('status', 'Recording stopped');
    };

    this._flushSegment({ final: true })
      .catch((error) => {
        logger.error('Final transcription failed', { error: error.message });
        this.emit('error', `Transcription failed: ${error.message}`);
      })
      .finally(finish);
  }

  _finalizeStop(statusMessage) {
    this._cleanup();
    this.emit('recording-stopped');
    this.emit('status', statusMessage);
  }

  _cleanup() {
    if (this.segmentTimer) {
      clearInterval(this.segmentTimer);
      this.segmentTimer = null;
    }

    if (this.recording) {
      try {
        this.recording.stop();
      } catch (error) {
        logger.error('Error stopping audio recording', { error: error.message });
      }
      this.recording = null;
    }

    this.segmentBuffers = [];
    this.segmentBytes = 0;
    this.transcriptionInFlight = false;
    this.pendingFlush = false;
    this.pendingFinal = false;
    this._resetVadState();
    this._audioDataLogged = false;
    this.useRendererCapture = false;
  }

  async recognizeFromFile(audioFilePath) {
    if (this.provider !== 'gemini') {
      throw new Error('Speech service not initialized (GEMINI_API_KEY required)');
    }

    if (!fs.existsSync(audioFilePath)) {
      throw new Error(`Audio file not found: ${audioFilePath}`);
    }

    return this._transcribeAudioFile(audioFilePath);
  }

  async testConnection() {
    if (this.provider !== 'gemini' || !this.available) {
      return { success: false, message: 'Speech transcription needs GEMINI_API_KEY (audio runs on Gemini)' };
    }
    return {
      success: true,
      message: `Gemini audio transcription ready (${this._geminiService().model})`,
    };
  }

  getStatus() {
    return {
      provider: this.provider,
      isRecording: this.isRecording,
      isProcessingAudio: this.isProcessingAudio,
      isInitialized: this.available,
      sessionDuration: this.sessionStartTime ? Date.now() - this.sessionStartTime : 0,
      retryCount: 0,
      effectiveSettings: {
        transcriptionProvider: 'gemini',
        geminiModel: this._geminiService().model,
        meetingAudioLanguage: this._getMeetingAudioLanguage(),
        captureMode: this._getCaptureMode(),
      },
      config: {
        selectedProvider: this.provider
      }
    };
  }

  isAvailable() {
    return this.provider === 'gemini' && !!this.available;
  }

  isManualCaptureMode() {
    return this._getCaptureMode() === 'manual';
  }

  shutdown() {
    this.isRecording = false;
    this.isProcessingAudio = false;
    this._cleanup();
  }

  updateSettings(settings = {}) {
    const speechKeys = ['meetingAudioLanguage', 'captureMode'];
    let changed = false;

    for (const key of speechKeys) {
      if (Object.prototype.hasOwnProperty.call(settings, key)) {
        this.runtimeSettings[key] = settings[key];
        changed = true;
      }
    }

    if (changed) {
      this.initializeClient();
    }

    return this.getStatus();
  }

  _getMeetingAudioLanguage() {
    const meeting = (process.env.MEETING_AUDIO_LANGUAGE || this._getSetting('meetingAudioLanguage') || 'auto').trim().toLowerCase();
    return meeting && meeting !== 'auto' ? meeting : 'auto';
  }

  _getManualCaptureMaxMs() {
    const parsed = Number(process.env.AUDIO_MANUAL_MAX_MS || 90000);
    return Number.isFinite(parsed) ? Math.max(5000, parsed) : 90000;
  }

  _vadNumber(settingKey, envKey, configPath, fallback, min) {
    const raw = this._getSetting(settingKey) || process.env[envKey] || config.get(configPath) || fallback;
    const parsed = Number(raw);
    const value = Number.isFinite(parsed) ? parsed : fallback;
    return typeof min === 'number' ? Math.max(min, value) : value;
  }

  _getSilenceHangoverMs() {
    return this._vadNumber('silenceHangoverMs', 'AUDIO_SILENCE_HANGOVER_MS', 'speech.silenceHangoverMs', 700, 200);
  }

  _getMinUtteranceMs() {
    return this._vadNumber('minUtteranceMs', 'AUDIO_MIN_UTTERANCE_MS', 'speech.minUtteranceMs', 350, 100);
  }

  _getMaxUtteranceMs() {
    return this._vadNumber('maxUtteranceMs', 'AUDIO_MAX_UTTERANCE_MS', 'speech.maxUtteranceMs', 15000, 2000);
  }

  _getPreRollMs() {
    return this._vadNumber('preRollMs', 'AUDIO_PRE_ROLL_MS', 'speech.preRollMs', 300, 0);
  }

  _getVadEnergyFloor() {
    return this._vadNumber('vadEnergyFloor', 'AUDIO_VAD_ENERGY_FLOOR', 'speech.vadEnergyFloor', 0.008, 0.0005);
  }

  _getSetting(key) {
    const value = this.runtimeSettings[key];
    return value === '' ? null : value;
  }

  _isManualCaptureMode() {
    return this._getCaptureMode() === 'manual';
  }

  _getCaptureMode() {
    const configured = String(
      this._getSetting('captureMode') || process.env.AUDIO_CAPTURE_MODE || ''
    ).trim().toLowerCase();
    return configured === 'manual' ? 'manual' : 'vad';
  }

  _startMicrophoneCapture() {
    if (!recorder || typeof recorder.record !== 'function') {
      this.emit('error', 'Local microphone capture dependency is missing. Run npm install to restore speech recording support.');
      return;
    }

    // node-record-lpcm16 only ships two recorder modules: `sox` and `arecord`.
    // Each entry maps the recorder module to the binary we must verify is on
    // PATH: Linux: arecord (ALSA, usually preinstalled) then sox.
    const candidates = [{ recorder: 'arecord', bin: 'arecord' }, { recorder: 'sox', bin: 'sox' }];
    this._startMicrophoneCaptureWithFallback(candidates);
  }

  /**
   * Whether an audio capture binary is on PATH. node-record-lpcm16 spawns
   * these directly and, when the binary is missing, emits an `error` on its
   * child process with no listener — which would otherwise crash the whole
   * app. We pre-filter to binaries that exist so the library never receives a
   * missing program.
   */
  _audioProgramExists(bin) {
    try {
      const r = spawnSync('which', [bin], { windowsHide: true, timeout: 4000 });
      return r.status === 0;
    } catch (_) {
      return false;
    }
  }

  _startMicrophoneCaptureWithFallback(candidates) {
    const available = candidates.filter((c) => this._audioProgramExists(c.bin));

    if (available.length === 0) {
      logger.warn('No audio capture program available', {
        tried: candidates.map((c) => c.bin),
        platform: process.platform,
      });
      this.isRecording = false;
      this.emit('error', 'Microphone capture needs arecord or sox, but none was found. Install one with `sudo apt install alsa-utils` (arecord) or `sudo apt install sox`.');
      return;
    }

    const queue = [...available];

    const tryNextProgram = () => {
      const candidate = queue.shift();
      if (!candidate) {
        this.isRecording = false;
        this.emit('error', 'Could not start microphone capture with any available audio program');
        return;
      }

      const program = candidate.bin;
      try {
        this.recording = recorder.record({
          sampleRate: 16000,
          sampleRateHertz: 16000,
          channels: 1,
          threshold: 0,
          verbose: false,
          recorder: candidate.recorder,
          silence: '10.0s'
        });

        const stream = this.recording.stream();
        this.audioProgram = program;

        // Guard the spawned child process directly. A spawn failure (e.g. the
        // binary disappeared between our probe and the spawn, or a permission
        // error) emits `error` on the child, which node-record-lpcm16 leaves
        // unhandled — fatal without this listener.
        const child = this.recording.process;
        if (child && typeof child.on === 'function') {
          child.on('error', (error) => {
            logger.error('Audio recording process error', { error: error.message, program });
            if (this.recording) {
              try { this.recording.stop(); } catch (_) { /* ignore */ }
              this.recording = null;
            }
            if (this.isRecording) tryNextProgram();
          });
        }

        stream.on('error', (error) => {
          logger.error('Audio recording stream error', { error: error.message, program });
          if (this.recording) {
            try {
              this.recording.stop();
            } catch (stopError) {
              logger.error('Error stopping failed recording program', { error: stopError.message });
            }
            this.recording = null;
          }

          if (this.isRecording) {
            tryNextProgram();
          }
        });

        stream.on('data', (chunk) => {
          this._handleAudioChunk(chunk);
        });
      } catch (error) {
        logger.error('Failed to start microphone capture program', { program, error: error.message });
        tryNextProgram();
      }
    };

    tryNextProgram();
  }

  _handleAudioChunk(chunk) {
    if (!chunk || !chunk.length || !this.isRecording) {
      return;
    }
    this._ingestAudio(Buffer.from(chunk));
  }

  async _flushSegment({ final }) {
    if (this.transcriptionInFlight) {
      // A flush was requested while a transcription is still running. Record
      // that we owe a follow-up flush for ANY request (not just a final one),
      // otherwise an utterance that ended mid-transcription stays stranded in
      // the buffer until the next utterance ends or the session stops. Track
      // final-ness separately so a queued stop still finalises correctly.
      this.pendingFlush = true;
      if (final) {
        this.pendingFinal = true;
      }
      return;
    }

    if (!this.segmentBytes) {
      return;
    }

    const audioBuffer = Buffer.concat(this.segmentBuffers, this.segmentBytes);
    this.segmentBuffers = [];
    this.segmentBytes = 0;

    this.transcriptionInFlight = true;

    try {
      const transcript = await this._transcribeAudioBuffer(audioBuffer);
      const clean = transcript ? transcript.trim() : '';
      if (clean && !this._isHallucinatedTranscript(clean)) {
        this.emit('transcription', clean);
      } else if (clean) {
        logger.debug('Dropped likely silence hallucination', { transcript: clean });
      }
    } finally {
      this.transcriptionInFlight = false;

      if (this.pendingFlush) {
        this.pendingFlush = false;
        const runFinal = this.pendingFinal;
        this.pendingFinal = false;
        await this._flushSegment({ final: runFinal });
      }
    }
  }

  /**
   * Transcription models echo stock phrases when fed near-silence or
   * non-speech audio. VAD already prevents most silent flushes; this is the
   * final guard so these phantom phrases never reach the chat or the LLM.
   */
  _isHallucinatedTranscript(text) {
    const normalized = text.toLowerCase().replace(/[\s.,!?¡¿"'`]+/g, ' ').trim();
    if (!normalized) {
      return true;
    }
    const HALLUCINATIONS = new Set([
      'thank you',
      'thank you for watching',
      'thanks for watching',
      'thank you so much for watching',
      'please subscribe',
      'like and subscribe',
      'you',
      'bye',
      'bye bye',
      'okay',
      'ok',
      'so',
      'the end',
      'subtitles by the amara org community',
      // Gemini 3.5 flash-lite stock echoes on tone/silence (observed in testing)
      'play some rock music',
      'call on number two',
      'number two',
      'music',
      'you'
    ]);
    return HALLUCINATIONS.has(normalized);
  }

  async _transcribeAudioBuffer(audioBuffer) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nyx-audio-'));
    const audioFilePath = path.join(tempDir, 'segment.wav');

    try {
      fs.writeFileSync(audioFilePath, this._createWavBuffer(audioBuffer));
      return await this._transcribeAudioFile(audioFilePath);
    } finally {
      this._removeTempDir(tempDir);
    }
  }

  /**
   * Transcribe a WAV file through the Gemini API (inline base64 audio).
   * The prompt pins the task to verbatim transcription so the model doesn't
   * answer or summarize the audio content.
   */
  async _transcribeAudioFile(audioFilePath) {
    const gemini = this._geminiService();
    if (!gemini.isInitialized) {
      throw new Error('Gemini transcription unavailable — GEMINI_API_KEY not configured');
    }

    const audioData = fs.readFileSync(audioFilePath).toString('base64');
    const language = this._getMeetingAudioLanguage();
    const langLine = language && language !== 'auto'
      ? ` The audio is in ${language}.`
      : '';

    const messages = [{
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Transcribe this audio recording verbatim. Output ONLY the transcript text with no preamble, no speaker labels, and no commentary. If the audio contains no speech, output nothing.${langLine}`,
        },
        { type: 'image_url', image_url: { url: `data:audio/wav;base64,${audioData}` } },
      ],
    }];

    const text = await gemini.chatCompletion(messages, { temperature: 0, maxTokens: 2048 });
    return text || '';
  }

  _createWavBuffer(rawPcmBuffer) {
    const header = Buffer.alloc(44);
    const sampleRate = 16000;
    const channels = 1;
    const bitsPerSample = 16;
    const byteRate = sampleRate * channels * (bitsPerSample / 8);
    const blockAlign = channels * (bitsPerSample / 8);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + rawPcmBuffer.length, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(rawPcmBuffer.length, 40);

    return Buffer.concat([header, rawPcmBuffer]);
  }

  _removeTempDir(tempDir) {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (error) {
      logger.error('Failed to remove audio temp directory', {
        tempDir,
        error: error.message
      });
    }
  }
}

module.exports = new SpeechService();
