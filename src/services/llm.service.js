// LLM Service — multi-provider router.
//
// Providers (config llm.provider / env LLM_PROVIDER):
//   'nvidia' (default) — NVIDIA NIM, meta/llama-3.2-11b-vision-instruct
//   'gemini'           — Google Gemini flash-lite (see gemini.service.js)
//
// NVIDIA path uses the OpenAI-compatible Chat Completions endpoint:
//   POST https://integrate.api.nvidia.com/v1/chat/completions
//   Authorization: Bearer $NVIDIA_API_KEY
// Model: meta/llama-3.2-11b-vision-instruct (a vision-language model that also
// handles text-only chat — see NVIDIA NIM VLM docs:
// https://docs.nvidia.com/nim/vision-language-models/1.2.0/examples/llama3-2/api.html)
//
// Images are passed inline as base64 `image_url` parts, exactly per the NIM docs.
// Streaming uses SSE ("stream": true) with `data:` line framing and [DONE] sentinel.

const https = require('https');
const logger = require('../core/logger').createServiceLogger('LLM');
const config = require('../core/config');

const NIM_BASE_HOST = 'integrate.api.nvidia.com';
const NIM_CHAT_PATH = '/v1/chat/completions';

class LLMService {
  constructor() {
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;
    this.geminiService = require('./gemini.service');
    this.initializeClient();
  }

  get activeProvider() {
    return config.get('llm.provider') === 'gemini' ? 'gemini' : 'nvidia';
  }

  /** Switch provider at runtime ('nvidia' | 'gemini'). Not persisted; LLM_PROVIDER persists. */
  setProvider(provider) {
    if (provider !== 'nvidia' && provider !== 'gemini') {
      throw new Error(`Unknown LLM provider: ${provider}`);
    }
    config.set('llm.provider', provider);
    this.initializeClient();
    logger.info(`LLM provider switched to ${provider}`);
    return this.getStats();
  }

  initializeClient() {
    if (this.activeProvider === 'gemini') {
      this.geminiService.initializeClient();
      this.isInitialized = this.geminiService.isInitialized;
      this.model = this.geminiService.model;
      return;
    }

    const apiKey = config.getApiKey('NVIDIA');

    if (!apiKey || apiKey === 'your-api-key-here' || apiKey === 'nvapi-xxx') {
      logger.warn('NVIDIA API key not configured', {
        keyExists: !!apiKey,
        hint: 'Set NVIDIA_API_KEY in your environment (bashrc) or .env — or set LLM_PROVIDER=gemini with GEMINI_API_KEY',
      });
      this.isInitialized = false;
      return;
    }

    this.model = config.get('llm.nvidia.model');
    this.isInitialized = true;

    logger.info('NVIDIA NIM client initialized', {
      model: this.model,
      endpoint: `https://${NIM_BASE_HOST}${NIM_CHAT_PATH}`,
      keySource: process.env.NVIDIA_API_KEY_FROM_BASHRC ? 'bashrc-env' : 'env-file',
    });
  }

  getApiKey() {
    return this.activeProvider === 'gemini'
      ? this.geminiService.getApiKey()
      : config.getApiKey('NVIDIA');
  }

  getModelsToTry() {
    const fallbackModels = config.get('llm.nvidia.fallbackModels') || [];
    return [this.model, ...fallbackModels].filter(Boolean);
  }

  /**
   * Core chat completion. `messages` is an OpenAI-style array:
   *   [{role:'system'|'user'|'assistant', content: string | [{type:'text',text}|{type:'image_url',image_url:{url}}]}]
   * Returns the assistant message text. When `onDelta` is provided, streams via SSE.
   */
  async chatCompletion(messages, { temperature, maxTokens, onDelta } = {}) {
    // Provider router — every public process* method funnels through here.
    if (this.activeProvider === 'gemini') {
      return this.geminiService.chatCompletion(messages, { temperature, maxTokens, onDelta });
    }

    const apiKey = this.getApiKey();
    if (!apiKey) {
      throw new Error('LLM service not initialized. Configure NVIDIA_API_KEY or GEMINI_API_KEY.');
    }

    const generation = config.get('llm.nvidia.generation') || {};
    const body = {
      model: this.model,
      messages,
      temperature: temperature ?? generation.temperature ?? 0.7,
      top_p: generation.topP ?? 0.9,
      max_tokens: maxTokens ?? generation.maxOutputTokens ?? 4096,
      stream: typeof onDelta === 'function',
    };

    const maxRetries = config.get('llm.nvidia.maxRetries') || 2;
    const timeout = config.get('llm.nvidia.timeout') || 60000;

    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const text = typeof onDelta === 'function'
          ? await this._streamRequest(body, apiKey, timeout, onDelta)
          : await this._blockingRequest(body, apiKey, timeout);

        if (!text || !text.trim()) {
          throw new Error('Empty response from NVIDIA NIM');
        }
        return text.trim();
      } catch (error) {
        lastError = error;
        const info = this.analyzeError(error);
        logger.warn(`NVIDIA NIM attempt ${attempt} failed`, {
          error: error.message,
          errorType: info.type,
          remainingAttempts: maxRetries - attempt,
        });

        // Auth errors are not retryable
        if (info.type === 'AUTH_ERROR') throw error;
        if (attempt < maxRetries) {
          await this.delay((info.isNetworkError ? 2000 : 1200) * attempt + Math.random() * 500);
        }
      }
    }

    throw lastError || new Error('NVIDIA NIM request failed');
  }

  _requestOptions(postData, apiKey, timeout) {
    return {
      host: NIM_BASE_HOST,
      path: NIM_CHAT_PATH,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: typeof arguments[3] !== 'undefined' ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': this.getUserAgent(),
      },
      timeout,
    };
  }

  _blockingRequest(body, apiKey, timeout) {
    const postData = JSON.stringify(body);
    const options = this._requestOptions(postData, apiKey, timeout);

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
            const choice = json.choices && json.choices[0];
            const text = choice && choice.message && choice.message.content;
            if (typeof text !== 'string') {
              reject(new Error(`Unexpected NIM response shape: ${data.substring(0, 200)}`));
              return;
            }
            resolve(text);
          } catch (parseError) {
            reject(new Error(`Failed to parse NIM response: ${parseError.message}`));
          }
        });
      });

      req.on('error', (error) => reject(new Error(`NIM request failed: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('NIM request timeout'));
      });
      req.write(postData);
      req.end();
    });
  }

  _streamRequest(body, apiKey, timeout, onDelta) {
    const postData = JSON.stringify(body);
    const options = this._requestOptions(postData, apiKey, timeout, 'stream');
    options.headers.Accept = 'text/event-stream';

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
            if (!payload || payload === '[DONE]') continue;
            try {
              const json = JSON.parse(payload);
              const piece = json.choices?.[0]?.delta?.content || '';
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
        res.on('error', (error) => reject(new Error(`Streaming response error: ${error.message}`)));
      });

      req.on('error', (error) => reject(new Error(`Streaming request failed: ${error.message}`)));
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Streaming request timeout'));
      });
      req.write(postData);
      req.end();
    });
  }

  getUserAgent() {
    try {
      if (typeof navigator !== 'undefined' && navigator.userAgent) return navigator.userAgent;
      return `Node.js/${process.version} (${process.platform}; ${process.arch})`;
    } catch {
      return 'Unknown';
    }
  }

  analyzeError(error) {
    const m = (error.message || '').toLowerCase();
    if (m.includes('fetch failed') || m.includes('network error') || m.includes('enotfound') ||
        m.includes('econnrefused') || m.includes('timeout') || m.includes('etimedout')) {
      return { type: 'NETWORK_ERROR', isNetworkError: true, suggestedAction: 'Check internet connection' };
    }
    if (m.includes('unauthorized') || m.includes('401') || m.includes('invalid api key') ||
        m.includes('forbidden') || m.includes('403')) {
      return { type: 'AUTH_ERROR', isNetworkError: false, suggestedAction: 'Verify NVIDIA_API_KEY' };
    }
    if (m.includes('429') || m.includes('quota') || m.includes('rate limit') || m.includes('too many requests')) {
      return { type: 'RATE_LIMIT_ERROR', isNetworkError: false, suggestedAction: 'Wait before retrying' };
    }
    return { type: 'UNKNOWN_ERROR', isNetworkError: false, suggestedAction: 'Check logs' };
  }

  async checkNetworkConnectivity() {
    const tests = [
      { host: NIM_BASE_HOST, port: 443, name: 'NVIDIA NIM API Endpoint' },
      { host: 'generativelanguage.googleapis.com', port: 443, name: 'Google Gemini API Endpoint' },
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
    logger.info('Network connectivity check completed', connectivity);
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

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ── Prompt/message builders ─────────────────────────────────────────────

  _systemMessage(activeSkill, programmingLanguage) {
    const { promptLoader } = require('../../prompt-loader');
    const skillPrompt = promptLoader.getSkillPrompt(activeSkill, programmingLanguage);
    const custom = this.getActiveCustomPrompt();
    const parts = [];
    if (custom) parts.push(custom);
    // Nyx "Output language" setting — responses, notes and summaries follow it.
    const outputLanguage = (process.env.OUTPUT_LANGUAGE || '').trim();
    if (outputLanguage && outputLanguage.toLowerCase() !== 'english') {
      parts.push(`IMPORTANT: Respond in ${outputLanguage} regardless of the language of the input, unless the user explicitly asks for code (code stays in its natural language).`);
    }
    if (skillPrompt) parts.push(skillPrompt);
    return parts.length ? { role: 'system', content: parts.join('\n\n') } : null;
  }

  /** Custom mode prompt (Nyx "Customize Nyx" equivalent), injected into system context. */
  getActiveCustomPrompt() {
    try {
      const customizeManager = require('../managers/customize.manager');
      return customizeManager.getActivePrompt() || null;
    } catch (_) {
      return null;
    }
  }

  _historyMessages(sessionMemory) {
    // sessionMemory is an array of {role, content} entries (recent events)
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
    let prompt = `# Intelligent Live Assistant

You are a real-time meeting/interview assistant in ${activeSkill.toUpperCase()} mode. The user speaks fragments of conversation; answer only what is useful.
Always respond to the point, do not repeat the question or unnecessary information which is not related to ${activeSkill}.`;

    if (programmingLanguage) {
      const lang = String(programmingLanguage).toLowerCase();
      const languageMap = { cpp: 'C++', c: 'C', python: 'Python', java: 'Java', javascript: 'JavaScript', js: 'JavaScript' };
      const fenceTagMap = { cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript' };
      const languageTitle = languageMap[lang] || (lang.charAt(0).toUpperCase() + lang.slice(1));
      const fenceTag = fenceTagMap[lang] || lang || 'text';
      prompt += `\n\nCODING CONTEXT: Respond ONLY in ${languageTitle}. All code blocks must use triple backticks with language tag \`\`\`${fenceTag}\`\`\`. Do not include other languages unless explicitly asked.`;
    }

    prompt += `

## Response Rules:

### If the transcription is casual conversation, greetings, or NOT related to ${activeSkill}:
- Respond with a brief acknowledgment like: "Yeah, I'm listening. Ask your question relevant to ${activeSkill}."

### If the transcription IS relevant to ${activeSkill} or is a follow-up question:
- Provide a comprehensive, detailed response
- Use bullet points, examples, and explanations
- Focus on actionable insights and complete answers

## Response Format:
- Keep responses detailed but scannable
- Use bullet points for structured answers
- Stay focused on ${activeSkill}

If the user's input is a coding or DSA problem statement and contains no code, produce a complete, runnable solution in the selected programming language without asking for more details. Always include the final implementation in a properly tagged code block.`;

    return prompt;
  }

  // ── Public processing methods (same interface as before) ────────────────

  formatImageInstruction(activeSkill, programmingLanguage) {
    const langNote = programmingLanguage ? ` Use only ${programmingLanguage.toUpperCase()} for any code.` : '';
    return `Analyze this screenshot for a ${activeSkill.toUpperCase()} question. Extract the problem concisely and provide the best possible solution with explanation and final code.${langNote}`;
  }

  async processImageWithSkillStream(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Configure NVIDIA_API_KEY or GEMINI_API_KEY.');
    }
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
      throw new Error('Invalid image buffer provided to processImageWithSkillStream');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const base64 = imageBuffer.toString('base64');
      const messages = [];
      const sys = this._systemMessage(activeSkill, programmingLanguage);
      if (sys) messages.push(sys);
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: this.formatImageInstruction(activeSkill, programmingLanguage) },
          { type: 'image_url', image_url: { url: `data:${mimeType || 'image/png'};base64,${base64}` } },
        ],
      });

      const fullText = await this.chatCompletion(messages, { onDelta });

      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      logger.logPerformance('NIM image streaming', startTime, {
        activeSkill,
        imageSize: imageBuffer.length,
        responseLength: finalResponse.length,
        requestId: this.requestCount,
      });

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true,
          isImageAnalysis: true,
          mimeType,
        },
      };
    } catch (error) {
      this.errorCount++;
      logger.warn('Streaming image analysis failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount,
      });
      return this.processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory, programmingLanguage);
    }
  }

  async processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Configure NVIDIA_API_KEY or GEMINI_API_KEY.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const base64 = imageBuffer.toString('base64');
      const messages = [];
      const sys = this._systemMessage(activeSkill, programmingLanguage);
      if (sys) messages.push(sys);
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: this.formatImageInstruction(activeSkill, programmingLanguage) },
          { type: 'image_url', image_url: { url: `data:${mimeType || 'image/png'};base64,${base64}` } },
        ],
      });

      const responseText = await this.chatCompletion(messages);
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(responseText, programmingLanguage)
        : responseText;

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          isImageAnalysis: true,
          mimeType,
        },
      };
    } catch (error) {
      this.errorCount++;
      logger.error('NIM image processing failed', { error: error.message, activeSkill });
      if (config.get('llm.nvidia.fallbackEnabled')) {
        return this.generateFallbackResponse('[image]', activeSkill);
      }
      throw error;
    }
  }

  async processTextWithSkill(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Configure NVIDIA_API_KEY or GEMINI_API_KEY.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const messages = [];
      const sys = this._systemMessage(activeSkill, programmingLanguage);
      if (sys) messages.push(sys);
      messages.push(...this._historyMessages(sessionMemory));
      messages.push({ role: 'user', content: this.formatUserMessage(text, activeSkill) });

      const response = await this.chatCompletion(messages);
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(response, programmingLanguage)
        : response;

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
        },
      };
    } catch (error) {
      this.errorCount++;
      logger.error('NIM text processing failed', { error: error.message, activeSkill });
      if (config.get('llm.nvidia.fallbackEnabled')) {
        return this.generateFallbackResponse(text, activeSkill);
      }
      throw error;
    }
  }

  async processTextWithSkillStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Configure NVIDIA_API_KEY or GEMINI_API_KEY.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const messages = [];
      const sys = this._systemMessage(activeSkill, programmingLanguage);
      if (sys) messages.push(sys);
      messages.push(...this._historyMessages(sessionMemory));
      messages.push({ role: 'user', content: this.formatUserMessage(text, activeSkill) });

      const fullText = await this.chatCompletion(messages, { onDelta });
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true,
        },
      };
    } catch (error) {
      logger.warn('Streaming text failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount,
      });
      return this.processTextWithSkill(text, activeSkill, sessionMemory, programmingLanguage);
    }
  }

  async processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Configure NVIDIA_API_KEY or GEMINI_API_KEY.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const cleanText = text && typeof text === 'string' ? text.trim() : '';
      if (!cleanText) throw new Error('Empty transcription text');

      const messages = [
        { role: 'system', content: this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) },
      ];
      const custom = this.getActiveCustomPrompt();
      if (custom) messages.unshift({ role: 'system', content: custom });
      messages.push(...this._historyMessages(sessionMemory));
      messages.push({ role: 'user', content: cleanText });

      const response = await this.chatCompletion(messages);
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(response, programmingLanguage)
        : response;

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          isTranscriptionResponse: true,
        },
      };
    } catch (error) {
      this.errorCount++;
      logger.error('NIM transcription processing failed', { error: error.message, activeSkill });
      if (config.get('llm.nvidia.fallbackEnabled')) {
        return this.generateIntelligentFallbackResponse(text, activeSkill);
      }
      throw error;
    }
  }

  async processTranscriptionWithIntelligentResponseStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Configure NVIDIA_API_KEY or GEMINI_API_KEY.');
    }

    const startTime = Date.now();
    this.requestCount++;

    try {
      const cleanText = text && typeof text === 'string' ? text.trim() : '';
      if (!cleanText) throw new Error('Empty transcription text');

      const messages = [
        { role: 'system', content: this.getIntelligentTranscriptionPrompt(activeSkill, programmingLanguage) },
      ];
      const custom = this.getActiveCustomPrompt();
      if (custom) messages.unshift({ role: 'system', content: custom });
      const outputLanguage = (process.env.OUTPUT_LANGUAGE || '').trim();
      if (outputLanguage && outputLanguage.toLowerCase() !== 'english') {
        messages.unshift({ role: 'system', content: `IMPORTANT: Respond in ${outputLanguage}.` });
      }
      messages.push(...this._historyMessages(sessionMemory));
      messages.push({ role: 'user', content: cleanText });

      const fullText = await this.chatCompletion(messages, { onDelta });
      const finalResponse = programmingLanguage
        ? this.enforceProgrammingLanguage(fullText, programmingLanguage)
        : fullText;

      return {
        response: finalResponse,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: this.requestCount,
          usedFallback: false,
          streamed: true,
          isTranscriptionResponse: true,
        },
      };
    } catch (error) {
      logger.warn('Streaming transcription failed, falling back to non-streaming', {
        error: error.message,
        requestId: this.requestCount,
      });
      return this.processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory, programmingLanguage);
    }
  }

  /**
   * Run a one-off action prompt (Nyx default actions, notes, follow-ups, briefs).
   * Optionally includes the live transcript as context.
   */
  async runAction(prompt, { transcript = null, programmingLanguage = null, activeSkill = 'general', onDelta = null, maxTokens = 2048 } = {}) {
    const startTime = Date.now();
    this.requestCount++;
    const messages = [];
    const custom = this.getActiveCustomPrompt();
    if (custom) messages.push({ role: 'system', content: custom });
    // Nyx "Output language" parity: actions (notes, briefs, emails, coaching)
    // must honor the configured output language too, not just chat responses.
    const outputLanguage = (process.env.OUTPUT_LANGUAGE || '').trim();
    if (outputLanguage && outputLanguage.toLowerCase() !== 'english') {
      messages.push({
        role: 'system',
        content: `IMPORTANT: Respond in ${outputLanguage} regardless of the language of the input or transcript.`,
      });
    }
    const fullPrompt = transcript
      ? `${prompt}\n\n--- CONVERSATION TRANSCRIPT ---\n${transcript}\n--- END TRANSCRIPT ---`
      : prompt;
    messages.push({ role: 'user', content: fullPrompt });

    const response = await this.chatCompletion(messages, { onDelta, maxTokens });
    return {
      response,
      metadata: {
        skill: activeSkill,
        processingTime: Date.now() - startTime,
        requestId: this.requestCount,
        usedFallback: false,
        isAction: true,
      },
    };
  }

  enforceProgrammingLanguage(text, programmingLanguage) {
    try {
      if (!text || !programmingLanguage) return text;
      const norm = String(programmingLanguage).toLowerCase();
      const fenceTagMap = { cpp: 'cpp', c: 'c', python: 'python', java: 'java', javascript: 'javascript', js: 'javascript' };
      const fenceTag = fenceTagMap[norm] || norm || 'text';

      const replacedBackticks = text.replace(/```([^\n]*)\n/g, (match, info) => {
        const current = (info || '').trim();
        if (current.split(/\s+/)[0].toLowerCase() === fenceTag) return match;
        return '```' + fenceTag + '\n';
      });

      const normalizedTildes = replacedBackticks.replace(/~~~([^\n]*)\n/g, () => '```' + fenceTag + '\n');
      return normalizedTildes;
    } catch (_) {
      return text;
    }
  }

  formatUserMessage(text, activeSkill) {
    return `Context: ${activeSkill.toUpperCase()} analysis request\n\nText to analyze:\n${text}`;
  }

  generateFallbackResponse(text, activeSkill) {
    const fallbackResponses = {
      dsa: 'This appears to be a data structures and algorithms problem. Consider breaking it down into smaller components and identifying the appropriate algorithm or data structure to use.',
      'system-design': 'For this system design question, consider scalability, reliability, and the trade-offs between different architectural approaches.',
      programming: 'This looks like a programming challenge. Focus on understanding the requirements, edge cases, and optimal time/space complexity.',
      default: 'I can help analyze this content. Please ensure your NVIDIA_API_KEY is properly configured for detailed analysis.',
    };
    const response = fallbackResponses[activeSkill] || fallbackResponses.default;
    return {
      response,
      metadata: { skill: activeSkill, processingTime: 0, requestId: this.requestCount, usedFallback: true },
    };
  }

  generateIntelligentFallbackResponse(text, activeSkill) {
    const textLower = (text || '').toLowerCase();
    const questionIndicators = ['how', 'what', 'why', 'when', 'where', 'can you', 'could you', 'should i', '?'];
    const seemsLikeQuestion = questionIndicators.some(indicator => textLower.includes(indicator));

    const response = seemsLikeQuestion
      ? `I'm having trouble processing that right now, but it sounds like a ${activeSkill} question. Could you rephrase or ask more specifically?`
      : `Yeah, I'm listening. Ask your question relevant to ${activeSkill}.`;

    return {
      response,
      metadata: { skill: activeSkill, processingTime: 0, requestId: this.requestCount, usedFallback: true, isTranscriptionResponse: true },
    };
  }

  async testConnection() {
    if (this.activeProvider === 'gemini') {
      return this.geminiService.testConnection();
    }
    if (!this.isInitialized) {
      return { success: false, error: 'Service not initialized — set NVIDIA_API_KEY (or GEMINI_API_KEY and LLM_PROVIDER=gemini)' };
    }

    try {
      const startTime = Date.now();
      const text = await this.chatCompletion(
        [{ role: 'user', content: 'Test connection. Please respond with "OK".' }],
        { temperature: 0, maxTokens: 64 }
      );
      const latency = Date.now() - startTime;

      logger.info('Connection test successful', { response: text, latency, model: this.model });
      return {
        success: true,
        response: text,
        latency,
        model: this.model,
      };
    } catch (error) {
      const errorAnalysis = this.analyzeError(error);
      logger.error('Connection test failed', { error: error.message, errorAnalysis });
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

    if (type === 'NETWORK_ERROR' || raw.includes('enotfound') || raw.includes('fetch failed')) {
      return 'Cannot reach NVIDIA NIM (integrate.api.nvidia.com). Check your internet connection, firewall, or VPN.';
    }
    if (type === 'AUTH_ERROR' || raw.includes('401') || raw.includes('403') || raw.includes('api key')) {
      return 'Invalid NVIDIA_API_KEY. Generate one at build.nvidia.com and make sure it is exported in ~/.bashrc or .env.';
    }
    if (type === 'RATE_LIMIT_ERROR' || raw.includes('429') || raw.includes('quota')) {
      return 'Rate limit or quota exceeded on NVIDIA NIM. Wait a moment and try again.';
    }
    if (type === 'TIMEOUT_ERROR') {
      return 'Request timed out. The NVIDIA NIM API may be slow or unreachable right now.';
    }
    return (error?.message || 'Connection failed').substring(0, 300);
  }

  updateApiKey(newApiKey) {
    if (this.activeProvider === 'gemini') {
      this.geminiService.updateApiKey(newApiKey);
    } else {
      process.env.NVIDIA_API_KEY = newApiKey;
    }
    this.isInitialized = false;
    this.initializeClient();
    logger.info(`API key updated for provider ${this.activeProvider} and client reinitialized`);
  }

  getStats() {
    const base = {
      isInitialized: this.isInitialized,
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      successRate: this.requestCount > 0 ? ((this.requestCount - this.errorCount) / this.requestCount) * 100 : 0,
      model: this.model,
      provider: this.activeProvider,
      config: this.activeProvider === 'gemini'
        ? config.get('llm.gemini')
        : config.get('llm.nvidia'),
    };
    if (this.activeProvider === 'gemini') {
      const gs = this.geminiService.getStats();
      base.requestCount = gs.requestCount;
      base.errorCount = gs.errorCount;
      base.isInitialized = gs.isInitialized;
    }
    return base;
  }
}

module.exports = new LLMService();
