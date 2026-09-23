// LLM Service — Gemini.
//
// The LLM is Google Gemini flash-lite (see gemini.service.js). Every public
// process* method funnels through chatCompletion(), which delegates to
// geminiService. Key: GEMINI_API_KEY (env / bashrc / .env), model override
// via GEMINI_MODEL.

const logger = require('../core/logger').createServiceLogger('LLM');
const config = require('../core/config');

class LLMService {
  constructor() {
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;
    this.geminiService = require('./gemini.service');
    this.initializeClient();
  }

  get activeProvider() {
    return 'gemini';
  }

  initializeClient() {
    this.geminiService.initializeClient();
    this.isInitialized = this.geminiService.isInitialized;
    this.model = this.geminiService.model;

    if (this.isInitialized) {
      logger.info('Gemini client initialized (llm.service)', {
        model: this.model,
        endpoint: this.geminiService.endpoint,
      });
    } else {
      logger.warn('Gemini API key not configured', {
        keyExists: !!this.geminiService.getApiKey(),
        hint: 'Set GEMINI_API_KEY in your environment (bashrc) or .env',
      });
    }
  }

  getApiKey() {
    return this.geminiService.getApiKey();
  }

  /**
   * Core chat completion. `messages` is an OpenAI-style array:
   *   [{role:'system'|'user'|'assistant', content: string | [{type:'text',text}|{type:'image_url',image_url:{url}}]}]
   * Returns the assistant message text. When `onDelta` is provided, streams.
   */
  async chatCompletion(messages, { temperature, maxTokens, onDelta } = {}) {
    return this.geminiService.chatCompletion(messages, { temperature, maxTokens, onDelta });
  }

  analyzeError(error) {
    const m = (error.message || '').toLowerCase();
    if (m.includes('fetch failed') || m.includes('network error') || m.includes('enotfound') ||
        m.includes('econnrefused') || m.includes('timeout') || m.includes('etimedout')) {
      return { type: 'NETWORK_ERROR', isNetworkError: true, suggestedAction: 'Check internet connection' };
    }
    if (m.includes('unauthorized') || m.includes('401') || m.includes('invalid api key') ||
        m.includes('forbidden') || m.includes('403')) {
      return { type: 'AUTH_ERROR', isNetworkError: false, suggestedAction: 'Verify GEMINI_API_KEY' };
    }
    if (m.includes('429') || m.includes('quota') || m.includes('rate limit') || m.includes('too many requests')) {
      return { type: 'RATE_LIMIT_ERROR', isNetworkError: false, suggestedAction: 'Wait before retrying' };
    }
    return { type: 'UNKNOWN_ERROR', isNetworkError: false, suggestedAction: 'Check logs' };
  }

  async checkNetworkConnectivity() {
    const tests = [
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

  // ── Public processing methods ───────────────────────────────────────────

  formatImageInstruction(activeSkill, programmingLanguage) {
    const langNote = programmingLanguage ? ` Use only ${programmingLanguage.toUpperCase()} for any code.` : '';
    return `Analyze this screenshot for a ${activeSkill.toUpperCase()} question. Extract the problem concisely and provide the best possible solution with explanation and final code.${langNote}`;
  }

  async processImageWithSkillStream(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Configure GEMINI_API_KEY.');
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

      logger.logPerformance('Gemini image streaming', startTime, {
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
      throw new Error('LLM service not initialized. Configure GEMINI_API_KEY.');
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
      logger.error('Gemini image processing failed', { error: error.message, activeSkill });
      if (config.get('llm.fallbackEnabled')) {
        return this.generateFallbackResponse('[image]', activeSkill);
      }
      throw error;
    }
  }

  async processTextWithSkill(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Configure GEMINI_API_KEY.');
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
      logger.error('Gemini text processing failed', { error: error.message, activeSkill });
      if (config.get('llm.fallbackEnabled')) {
        return this.generateFallbackResponse(text, activeSkill);
      }
      throw error;
    }
  }

  async processTextWithSkillStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Configure GEMINI_API_KEY.');
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
      throw new Error('LLM service not initialized. Configure GEMINI_API_KEY.');
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
      logger.error('Gemini transcription processing failed', { error: error.message, activeSkill });
      if (config.get('llm.fallbackEnabled')) {
        return this.generateIntelligentFallbackResponse(text, activeSkill);
      }
      throw error;
    }
  }

  async processTranscriptionWithIntelligentResponseStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta = null) {
    if (!this.isInitialized) {
      throw new Error('LLM service not initialized. Configure GEMINI_API_KEY.');
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
      default: 'I can help analyze this content. Please ensure your GEMINI_API_KEY is properly configured for detailed analysis.',
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
    return this.geminiService.testConnection();
  }

  _friendlyTestError(error, analysis) {
    const type = analysis?.type;
    const raw = (error?.message || '').toLowerCase();

    if (type === 'NETWORK_ERROR' || raw.includes('enotfound') || raw.includes('fetch failed')) {
      return 'Cannot reach the Gemini API (generativelanguage.googleapis.com). Check your internet connection, firewall, or VPN.';
    }
    if (type === 'AUTH_ERROR' || raw.includes('401') || raw.includes('403') || raw.includes('api key')) {
      return 'Invalid GEMINI_API_KEY. Generate one at aistudio.google.com and make sure it is exported in ~/.bashrc or .env.';
    }
    if (type === 'RATE_LIMIT_ERROR' || raw.includes('429') || raw.includes('quota')) {
      return 'Rate limit or quota exceeded on the Gemini API. Wait a moment and try again.';
    }
    if (type === 'TIMEOUT_ERROR') {
      return 'Request timed out. The Gemini API may be slow or unreachable right now.';
    }
    return (error?.message || 'Connection failed').substring(0, 300);
  }

  updateApiKey(newApiKey) {
    this.geminiService.updateApiKey(newApiKey);
    this.isInitialized = false;
    this.initializeClient();
    logger.info('API key updated and Gemini client reinitialized');
  }

  getStats() {
    const gs = this.geminiService.getStats();
    return {
      isInitialized: gs.isInitialized,
      requestCount: gs.requestCount,
      errorCount: gs.errorCount,
      successRate: gs.requestCount > 0 ? ((gs.requestCount - gs.errorCount) / gs.requestCount) * 100 : 0,
      model: this.model,
      provider: 'gemini',
      config: config.get('llm.gemini'),
    };
  }
}

module.exports = new LLMService();
