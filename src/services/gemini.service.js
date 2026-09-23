// Gemini Service — Google Generative Language API backend.
//
// REST endpoint (no SDK):
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
//   Header: x-goog-api-key: $GEMINI_API_KEY
// Streaming variant uses streamGenerateContent?alt=sse (SSE framing).
//
// Model default: gemini-3.5-flash-lite (GA, multimodal — text + image + audio).
// NOTE: "gemini-2.5-flash-lite" is no longer available to new API keys; the
// API itself directs new users to 3.5. GEMINI_MODEL env var overrides the id.
//
// Rate limiting: the user's free tier allows ~15 RPM. We serialize requests
// with a min interval and apply server-advised backoff (RetryInfo) on 429.

const https = require('https');
const logger = require('../core/logger').createServiceLogger('GEMINI');
const config = require('../core/config');

const API_HOST = 'generativelanguage.googleapis.com';

class GeminiService {
  constructor() {
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;
    this._chain = Promise.resolve();
    this.initializeClient();
  }

  initializeClient() {
    const apiKey = config.getApiKey('GEMINI');

    if (!apiKey || apiKey === 'your_gemini_api_key_here' || apiKey === 'your-api-key-here') {
      logger.warn('Gemini API key not configured', {
        hint: 'Set GEMINI_API_KEY in your environment (bashrc) or .env',
      });
      this.isInitialized = false;
      return;
    }

    this.model = config.get('llm.gemini.model');
    this.isInitialized = true;

    logger.info('Gemini client initialized', {
      model: this.model,
      endpoint: `https://${API_HOST}/v1beta/models/${this.model}:generateContent`,
      keySource: process.env.GEMINI_API_KEY_FROM_BASHRC ? 'bashrc-env' : 'env-file',
    });
  }

  getApiKey() {
    return config.getApiKey('GEMINI');
  }

  getStats() {
    return {
      isInitialized: this.isInitialized,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      model: this.model,
      config: { ...config.get('llm.gemini'), apiKey: undefined },
    };
  }

  updateApiKey(newApiKey) {
    process.env.GEMINI_API_KEY = newApiKey;
    this.isInitialized = false;
    this.initializeClient();
    logger.info('Gemini API key updated and client reinitialized');
  }

  /**
   * Core completion. `messages` is OpenAI-style:
   *   [{role:'system'|'user'|'assistant', content: string | [{type:'text',text}|{type:'image_url',image_url:{url}}]}]
   * Returns the model text. With onDelta, streams via SSE.
   */
  async chatCompletion(messages, { temperature, maxTokens, onDelta } = {}) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('Gemini service not initialized. Check GEMINI_API_KEY configuration.');
    }

    const cfg = config.get('llm.gemini') || {};
    // Serialize all Gemini traffic: free tier is ~15 RPM and bursts trip it.
    const run = this._chain.then(() => this._doChat(messages, { temperature, maxTokens, onDelta }));
    // Keep the chain alive even if a request fails.
    this._chain = run.catch(() => {});
    return run;
  }

  async _doChat(messages, { temperature, maxTokens, onDelta } = {}) {
    const cfg = config.get('llm.gemini') || {};
    const minInterval = cfg.minRequestIntervalMs || 4500;
    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('Gemini service not initialized. Check GEMINI_API_KEY configuration.');
    }

    // Pace requests to stay under RPM even across concurrent callers.
    const now = Date.now();
    const since = now - (this._lastRequestAt || 0);
    if (since < minInterval) {
      await this.delay(minInterval - since);
    }

    const generation = cfg.generation || {};
    const { systemInstruction, contents } = this._toGeminiPayload(messages);

    const body = {
      systemInstruction: systemInstruction || undefined,
      contents,
      generationConfig: {
        temperature: temperature ?? generation.temperature ?? 0.7,
        topP: generation.topP ?? 0.95,
        maxOutputTokens: maxTokens ?? generation.maxOutputTokens ?? 8192,
      },
    };

    const maxRetries = cfg.maxRetries || 3;
    const timeout = cfg.timeout || 60000;

    try {
      let lastError = null;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        this._lastRequestAt = Date.now();
        try {
          const text = typeof onDelta === 'function'
            ? await this._streamRequest(body, apiKey, timeout, onDelta)
            : await this._blockingRequest(body, apiKey, timeout);

          if (!text || !text.trim()) {
            throw new Error('Empty response from Gemini');
          }
          this.requestCount++;
          return text.trim();
        } catch (error) {
          lastError = error;
          const info = this.analyzeError(error);
          logger.warn(`Gemini attempt ${attempt} failed`, {
            error: error.message,
            errorType: info.type,
            remainingAttempts: maxRetries - attempt,
          });

          if (info.type === 'AUTH_ERROR') throw error;
          if (info.type === 'RATE_LIMIT_ERROR') {
            // Free tier: back off hard on 429 (server may advise seconds).
            const advised = this._extractRetryMs(error.message);
            await this.delay(advised || 20000 * attempt);
            continue;
          }
          if (attempt < maxRetries) {
            await this.delay((info.isNetworkError ? 2000 : 1200) * attempt + Math.random() * 500);
          }
        }
      }
      throw lastError || new Error('Gemini request failed');
    } finally {
      this.errorCount = this.errorCount; // counters updated by callers
    }
  }

  _toGeminiPayload(messages) {
    let systemInstruction = null;
    const contents = [];

    for (const m of messages || []) {
      if (!m) continue;
      if (m.role === 'system') {
        const text = typeof m.content === 'string' ? m.content : this._partsToText(m.content);
        if (text) {
          systemInstruction = systemInstruction
            ? { parts: [{ text: systemInstruction.parts[0].text + '\n\n' + text }] }
            : { parts: [{ text }] };
        }
        continue;
      }

      const role = m.role === 'assistant' ? 'model' : 'user';
      if (typeof m.content === 'string') {
        contents.push({ role, parts: [{ text: m.content }] });
      } else if (Array.isArray(m.content)) {
        const parts = m.content.map(p => {
          if (p && p.type === 'text') return { text: String(p.text || '') };
          if (p && p.type === 'image_url') {
            const url = p.image_url && p.image_url.url;
            const mm = /^data:([^;]+);base64,(.*)$/.exec(url || '');
            if (mm) return { inline_data: { mime_type: mm[1], data: mm[2] } };
            return { text: '[unsupported image reference omitted]' };
          }
          return { text: '[unsupported part omitted]' };
        }).filter(Boolean);
        contents.push({ role, parts });
      }
    }

    // Gemini v1beta rejects role!='user' as the final content; normalize.
    if (contents.length && contents[contents.length - 1].role === 'model') {
      contents.push({ role: 'user', parts: [{ text: 'Continue.' }] });
    }
    return { systemInstruction, contents };
  }

  _partsToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(p => (p && p.type === 'text' ? p.text : '')).join('\n').trim();
    }
    return '';
  }

  _requestOptions(path, postData, apiKey, timeout, streaming) {
    return {
      host: API_HOST,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: streaming ? 'text/event-stream' : 'application/json',
        'x-goog-api-key': apiKey,
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': this.getUserAgent(),
      },
      timeout,
    };
  }

  _blockingRequest(body, apiKey, timeout) {
    const path = `/v1beta/models/${this.model}:generateContent`;
    const postData = JSON.stringify(body);
    const options = this._requestOptions(path, postData, apiKey, timeout, false);

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode !== 200) {
              reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 400)}`));
              return;
            }
            const json = JSON.parse(data);
            const cands = json.candidates || [];
            const parts = cands[0] && cands[0].content && cands[0].content.parts || [];
            const text = parts.map(p => p.text || '').join('');
            if (typeof text !== 'string' || !text) {
              const blocked = json.promptFeedback && json.promptFeedback.blockReason;
              reject(new Error(blocked ? `Blocked by safety filter: ${blocked}` : `Unexpected Gemini response shape: ${data.substring(0, 200)}`));
              return;
            }
            resolve(text);
          } catch (parseError) {
            reject(new Error(`Failed to parse Gemini response: ${parseError.message}`));
          }
        });
      });

      req.on('error', (error) => reject(new Error(`Gemini request failed: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Gemini request timeout'));
      });
      req.write(postData);
      req.end();
    });
  }

  _streamRequest(body, apiKey, timeout, onDelta) {
    const path = `/v1beta/models/${this.model}:streamGenerateContent?alt=sse`;
    const postData = JSON.stringify(body);
    const options = this._requestOptions(path, postData, apiKey, timeout, true);

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        if (res.statusCode !== 200) {
          let errBody = '';
          res.on('data', (c) => { errBody += c; });
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errBody.substring(0, 400)}`)));
          return;
        }

        let fullText = '';
        let buffer = '';

        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let idx;
          while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, idx).trim();
            buffer = buffer.slice(idx + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload) continue;
            try {
              const json = JSON.parse(payload);
              const parts = json.candidates?.[0]?.content?.parts || [];
              const piece = parts.map(p => p.text || '').join('');
              if (piece) {
                fullText += piece;
                if (typeof onDelta === 'function') onDelta(piece);
              }
            } catch (_) {
              // partial JSON across chunk boundaries; skip
            }
          }
        });

        res.on('end', () => resolve(fullText.trim()));
        res.on('error', (error) => reject(new Error(`Gemini streaming error: ${error.message}`)));
      });

      req.on('error', (error) => reject(new Error(`Gemini streaming request failed: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Gemini streaming request timeout'));
      });
      req.write(postData);
      req.end();
    });
  }

  _extractRetryMs(message) {
    // Server advises e.g. "retry in 17.3s" or "retryDelay": "19s"
    const m = /retry[^]*?(\d+(?:\.\d+)?)\s*s/i.exec(message || '');
    if (m) return Math.ceil(parseFloat(m[1]) * 1000) + 1500;
    return null;
  }

  analyzeError(error) {
    const m = (error.message || '').toLowerCase();
    if (m.includes('fetch failed') || m.includes('network error') || m.includes('enotfound') ||
        m.includes('econnrefused') || m.includes('timeout') || m.includes('etimedout')) {
      return { type: 'NETWORK_ERROR', isNetworkError: true, suggestedAction: 'Check internet connection' };
    }
    if (m.includes('400') || m.includes('api key not valid') || m.includes('api_key_invalid')) {
      return { type: 'AUTH_ERROR', isNetworkError: false, suggestedAction: 'Verify GEMINI_API_KEY' };
    }
    if (m.includes('403') || m.includes('permission')) {
      return { type: 'AUTH_ERROR', isNetworkError: false, suggestedAction: 'Check key restrictions' };
    }
    if (m.includes('429') || m.includes('quota') || m.includes('rate limit') || m.includes('resource_exhausted')) {
      return { type: 'RATE_LIMIT_ERROR', isNetworkError: false, suggestedAction: 'Wait before retrying' };
    }
    if (m.includes('404') || m.includes('not found')) {
      return { type: 'MODEL_ERROR', isNetworkError: false, suggestedAction: 'Check GEMINI_MODEL id' };
    }
    return { type: 'UNKNOWN_ERROR', isNetworkError: false, suggestedAction: 'Check logs' };
  }

  getUserAgent() {
    try {
      if (typeof navigator !== 'undefined' && navigator.userAgent) return navigator.userAgent;
      return `Node.js/${process.version} (${process.platform}; ${process.arch})`;
    } catch {
      return 'Unknown';
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async testConnection() {
    if (!this.isInitialized) {
      return { success: false, error: 'Service not initialized — set GEMINI_API_KEY' };
    }

    try {
      const startTime = Date.now();
      const text = await this.chatCompletion(
        [{ role: 'user', content: 'Test connection. Please respond with "OK".' }],
        { temperature: 0, maxTokens: 64 }
      );
      const latency = Date.now() - startTime;

      logger.info('Gemini connection test successful', { response: text, latency, model: this.model });
      return {
        success: true,
        response: text,
        latency,
        model: this.model,
        provider: 'gemini',
      };
    } catch (error) {
      const errorAnalysis = this.analyzeError(error);
      logger.error('Gemini connection test failed', { error: error.message, errorAnalysis });
      return {
        success: false,
        error: this._friendlyTestError(error, errorAnalysis),
        errorType: errorAnalysis?.type || 'UNKNOWN',
      };
    }
  }

  _friendlyTestError(error, analysis) {
    const type = analysis?.type;
    const raw = (error?.message || '').toLowerCase();

    if (type === 'NETWORK_ERROR') {
      return 'Cannot reach the Gemini API (generativelanguage.googleapis.com). Check your internet connection, firewall, or VPN.';
    }
    if (type === 'AUTH_ERROR' || raw.includes('api key')) {
      return 'Invalid GEMINI_API_KEY. Generate one at aistudio.google.com/apikey and export it in ~/.bashrc or .env.';
    }
    if (type === 'RATE_LIMIT_ERROR' || raw.includes('429') || raw.includes('quota')) {
      return 'Gemini rate limit hit (free tier is ~15 RPM). The app auto-retries with backoff; wait a moment and test again.';
    }
    if (type === 'MODEL_ERROR' || raw.includes('404')) {
      return `Model "${this.model}" not available for this key. Set GEMINI_MODEL to a valid id (e.g. gemini-3.5-flash-lite).`;
    }
    return (error?.message || 'Connection failed').substring(0, 300);
  }

  // ── Shared prompt builders (kept identical to llm.service for parity) ──

  _systemMessage(activeSkill, programmingLanguage) {
    const { promptLoader } = require('../../prompt-loader');
    const skillPrompt = promptLoader.getSkillPrompt(activeSkill, programmingLanguage);
    const { llmService } = require('./llm.service');
    const custom = llmService.getActiveCustomPrompt();
    const parts = [];
    if (custom) parts.push(custom);
    const outputLanguage = (process.env.OUTPUT_LANGUAGE || '').trim();
    if (outputLanguage && outputLanguage.toLowerCase() !== 'english') {
      parts.push(`IMPORTANT: Respond in ${outputLanguage} regardless of the language of the input, unless the user explicitly asks for code (code stays in its natural language).`);
    }
    if (skillPrompt) parts.push(skillPrompt);
    return parts.length ? { role: 'system', content: parts.join('\n\n') } : null;
  }

  _historyMessages(sessionMemory) {
    if (!Array.isArray(sessionMemory)) return [];
    return sessionMemory
      .filter(e => e && e.content && typeof e.content === 'string' && e.content.trim().length > 0 && e.role !== 'system')
      .slice(-10)
      .map(e => ({
        role: e.role === 'model' || e.role === 'assistant' ? 'assistant' : 'user',
        content: e.content.trim(),
      }));
  }

  getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) {
    // Same prompt text as llm.service — single source duplicated intentionally
    // to avoid a circular require; keep in sync.
    const { llmService } = require('./llm.service');
    return llmService.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage);
  }

  formatImageInstruction(activeSkill, programmingLanguage) {
    const { llmService } = require('./llm.service');
    return llmService.formatImageInstruction(activeSkill, programmingLanguage);
  }

  formatUserMessage(text, activeSkill) {
    const { llmService } = require('./llm.service');
    return llmService.formatUserMessage(text, activeSkill);
  }

  enforceProgrammingLanguage(text, programmingLanguage) {
    const { llmService } = require('./llm.service');
    return llmService.enforceProgrammingLanguage(text, programmingLanguage);
  }

  generateFallbackResponse(text, activeSkill) {
    const { llmService } = require('./llm.service');
    return llmService.generateFallbackResponse(text, activeSkill);
  }

  generateIntelligentFallbackResponse(text, activeSkill) {
    const { llmService } = require('./llm.service');
    return llmService.generateIntelligentFallbackResponse(text, activeSkill);
  }

  getActiveCustomPrompt() {
    const { llmService } = require('./llm.service');
    return llmService.getActiveCustomPrompt();
  }

  async checkNetworkConnectivity() {
    const tests = [
      { host: API_HOST, port: 443, name: 'Google Gemini API Endpoint' },
      { host: 'google.com', port: 443, name: 'Google (HTTPS)' },
    ];
    const results = await Promise.allSettled(tests.map(t => this.testNetworkConnection(t)));
    const connectivity = {
      timestamp: new Date().toISOString(),
      tests: results.map((result, index) => ({
        ...tests[index],
        success: result.status === 'fulfilled' && result.value,
        error: result.status === 'rejected' ? result.reason.message : null,
      })),
    };
    logger.info('Gemini network connectivity check completed', connectivity);
    return connectivity;
  }

  async testNetworkConnection({ host, port, name }) {
    return new Promise((resolve, reject) => {
      const net = require('net');
      const socket = new net.Socket();
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Connection timeout to ${host}:${port}`));
      }, 5000);
      socket.on('connect', () => { clearTimeout(timeout); socket.destroy(); resolve(true); });
      socket.on('error', (error) => { clearTimeout(timeout); reject(new Error(`Connection failed to ${host}:${port}: ${error.message}`)); });
      socket.connect(port, host);
    });
  }
}

module.exports = new GeminiService();
