const path = require('path');
const os = require('os');

class ConfigManager {
  constructor() {
    this.env = process.env.NODE_ENV || 'development';
    this.appDataDir = path.join(os.homedir(), '.Nyx');
    this.loadConfiguration();
  }

  loadConfiguration() {
    this.config = {
      app: {
        name: 'Nyx',
        version: '1.0.0',
        processTitle: 'Nyx',
        dataDir: this.appDataDir,
        isDevelopment: this.env === 'development',
        isProduction: this.env === 'production'
      },
      
      window: {
        defaultWidth: 400,
        defaultHeight: 600,
        minWidth: 300,
        minHeight: 400,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          enableRemoteModule: false,
          preload: path.join(__dirname, '../../preload.js')
        }
      },

      ocr: {
        language: 'eng',
        tempDir: os.tmpdir(),
        cleanupDelay: 5000
      },

      llm: {
        // Active provider: 'nvidia' (default) or 'gemini'. Override with LLM_PROVIDER.
        // Both are multimodal (text + image) chat backends.
        provider: process.env.LLM_PROVIDER === 'gemini' ? 'gemini' : 'nvidia',

        // NVIDIA NIM (build.nvidia.com) — OpenAI-compatible chat completions.
        // Auth uses NVIDIA_API_KEY which the user exports in ~/.bashrc.
        nvidia: {
          model: 'meta/llama-3.2-11b-vision-instruct',
          fallbackModels: [],
          maxRetries: 3,
          timeout: 90000, // NIM models can stream slowly; give them room
          fallbackEnabled: true,
          generation: {
            temperature: 0.7,
            topP: 0.9,
            maxOutputTokens: 4096
          }
        },

        // Google Gemini (generativelanguage.googleapis.com v1beta).
        // Auth uses GEMINI_API_KEY (free tier ≈ 15 RPM on flash-lite).
        // 'gemini-2.5-flash-lite' is no longer served to new keys; the API
        // directs new users to 3.5 flash-lite. Override with GEMINI_MODEL.
        gemini: {
          model: process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite',
          maxRetries: 3,
          timeout: 60000,
          fallbackEnabled: true,
          // Free-tier safety: serialize requests and keep ≈13 RPM so we
          // never trip the 15 RPM ceiling even when the app fires bursts.
          minRequestIntervalMs: 4600,
          generation: {
            temperature: 0.7,
            topP: 0.95,
            maxOutputTokens: 8192
          }
        }
      },

      speech: {
        // Voice transcription runs entirely on Gemini audio — no local
        // Whisper, no Azure. The VAD/mic pipeline feeds WAV segments here.
        provider: 'gemini',
        gemini: {
          language: 'auto',
          minRequestIntervalMs: 4600
        }
      },

      session: {
        maxMemorySize: 1000,
        compressionThreshold: 500,
        clearOnRestart: false
      },

      stealth: {
        hideFromDock: true,
        noAttachConsole: true,
        disguiseProcess: true
      }
    };
  }

  get(keyPath) {
    return keyPath.split('.').reduce((obj, key) => obj?.[key], this.config);
  }

  set(keyPath, value) {
    const keys = keyPath.split('.');
    const lastKey = keys.pop();
    const target = keys.reduce((obj, key) => obj[key] = obj[key] || {}, this.config);
    target[lastKey] = value;
  }

  getApiKey(service) {
    const envKey = `${service.toUpperCase()}_API_KEY`;
    return process.env[envKey];
  }

  isFeatureEnabled(feature) {
    return this.get(`features.${feature}`) !== false;
  }
}

module.exports = new ConfigManager();
