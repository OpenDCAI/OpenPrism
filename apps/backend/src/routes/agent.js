import { callOpenAICompatible } from '../services/llmService.js';
import { runToolAgent } from '../services/agentService.js';
import { getLang, t } from '../i18n/index.js';

function stripCodeFence(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('```')) return raw;
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function tryParseReplyPayload(text) {
  const raw = stripCodeFence(text);
  if (!raw) return null;
  const candidates = [raw];
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) {
    candidates.push(raw.slice(first, last + 1));
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // ignore
    }
  }
  return null;
}

function decodeEscapedChar(ch) {
  switch (ch) {
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case 'b': return '\b';
    case 'f': return '\f';
    case '"': return '"';
    case '\'': return '\'';
    case '\\': return '\\';
    case '/': return '/';
    default: return ch;
  }
}

function parseQuotedString(text, quote, startIndex) {
  let i = startIndex;
  let out = '';
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const next = text[i + 1];
      if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
        out += String.fromCharCode(Number.parseInt(text.slice(i + 2, i + 6), 16));
        i += 6;
        continue;
      }
      if (next) {
        out += decodeEscapedChar(next);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === quote) {
      return { value: out, end: i };
    }
    out += ch;
    i += 1;
  }
  return { value: out, end: text.length - 1 };
}

function extractFieldFromJsonLike(text, field) {
  const raw = stripCodeFence(text);
  if (!raw) return '';
  const matcher = new RegExp(`["']?${field}["']?\\s*:\\s*`, 'i');
  const match = matcher.exec(raw);
  if (!match) return '';
  let i = match.index + match[0].length;
  while (i < raw.length && /\s/.test(raw[i])) i += 1;
  if (i >= raw.length) return '';
  const lead = raw[i];
  if (lead === '"' || lead === '\'') {
    const parsed = parseQuotedString(raw, lead, i + 1);
    return parsed.value.trim();
  }
  let j = i;
  while (j < raw.length && ![',', '\n', '\r', '}'].includes(raw[j])) j += 1;
  return raw.slice(i, j).trim();
}

function extractMessageContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && typeof item.text === 'string') return item.text;
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}

function extractCompletionText(parsed) {
  if (!parsed || typeof parsed !== 'object') return '';

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const choiceMessage = choices[0]?.message;
  const choiceContent = extractMessageContent(choiceMessage?.content);
  if (choiceContent) return choiceContent;
  if (typeof choices[0]?.text === 'string') return choices[0].text;

  if (typeof parsed.output_text === 'string') return parsed.output_text;

  const candidateParts = parsed?.candidates?.[0]?.content?.parts;
  if (Array.isArray(candidateParts)) {
    const geminiText = candidateParts.map((part) => String(part?.text || '')).join('').trim();
    if (geminiText) return geminiText;
  }

  return '';
}

function normalizeAgentReply(inputReply, inputSuggestion = '') {
  let replyCandidate =
    typeof inputReply === 'string'
      ? inputReply
      : JSON.stringify(inputReply || '');
  let suggestionCandidate =
    typeof inputSuggestion === 'string'
      ? inputSuggestion
      : JSON.stringify(inputSuggestion || '');

  for (let depth = 0; depth < 4; depth += 1) {
    const parsed = tryParseReplyPayload(replyCandidate);
    if (!parsed) {
      const fallbackReply = extractFieldFromJsonLike(replyCandidate, 'reply')
        || extractFieldFromJsonLike(replyCandidate, 'message');
      const fallbackSuggestion = extractFieldFromJsonLike(replyCandidate, 'suggestion');
      if (fallbackReply) replyCandidate = fallbackReply;
      if (fallbackSuggestion) suggestionCandidate = fallbackSuggestion;
      break;
    }

    const completionText = extractCompletionText(parsed);
    if (completionText && completionText !== replyCandidate) {
      replyCandidate = completionText;
      continue;
    }

    const nestedReply = typeof parsed.reply === 'string'
      ? parsed.reply
      : (typeof parsed.message === 'string' ? parsed.message : '');
    const nestedSuggestion = typeof parsed.suggestion === 'string' ? parsed.suggestion : '';
    if (nestedReply) replyCandidate = nestedReply;
    if (nestedSuggestion) suggestionCandidate = nestedSuggestion;
    if (!nestedReply) break;
  }

  if (!suggestionCandidate) {
    suggestionCandidate = extractFieldFromJsonLike(replyCandidate, 'suggestion') || '';
  }

  if (!replyCandidate) {
    return {
      reply: String(inputReply || ''),
      suggestion: String(inputSuggestion || '')
    };
  }

  return { reply: replyCandidate, suggestion: suggestionCandidate };
}

export function registerAgentRoutes(fastify) {
  fastify.post('/api/agent/run', async (req) => {
    const lang = getLang(req);
    const {
      task = 'polish',
      prompt = '',
      selection = '',
      content = '',
      mode = 'direct',
      projectId,
      activePath,
      compileLog,
      llmConfig,
      interaction = 'agent',
      history = []
    } = req.body || {};

    if (interaction === 'chat') {
      const safeHistory = Array.isArray(history)
        ? history.filter((item) => item && (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string')
        : [];
      const system = [
        'You are a helpful academic writing assistant.',
        'This is chat-only mode: do not propose edits, patches, or JSON.',
        'Respond concisely and helpfully.'
      ].join(' ');
      const user = [
        prompt ? `User Prompt: ${prompt}` : '',
        selection ? `Selection (read-only):\n${selection}` : '',
        selection ? '' : (content ? `Current File (read-only):\n${content}` : ''),
        compileLog ? `Compile Log (read-only):\n${compileLog}` : ''
      ].filter(Boolean).join('\n\n');

      const result = await callOpenAICompatible({
        messages: [{ role: 'system', content: system }, ...safeHistory, { role: 'user', content: user }],
        model: llmConfig?.model,
        endpoint: llmConfig?.endpoint,
        apiKey: llmConfig?.apiKey
      });

      if (!result.ok) {
        return {
          ok: false,
          reply: t(lang, 'llm_error', { error: result.error || 'unknown error' }),
          suggestion: ''
        };
      }

      return { ok: true, reply: result.content || '', suggestion: '' };
    }

    if (mode === 'tools') {
      const toolResult = await runToolAgent({ projectId, activePath, task, prompt, selection, compileLog, llmConfig, lang });
      const normalized = normalizeAgentReply(toolResult?.reply || '', toolResult?.suggestion || '');
      return { ...toolResult, reply: normalized.reply, suggestion: normalized.suggestion };
    }

    const system =
      task === 'autocomplete'
        ? [
            'You are an autocomplete engine for LaTeX.',
            'Only return JSON with keys: reply, suggestion.',
            'suggestion must be the continuation text after the cursor.',
            'Do not include explanations or code fences.'
          ].join(' ')
        : [
            'You are a LaTeX writing assistant for academic papers.',
            'Return a concise response and a suggested rewrite for the selection or full content.',
            'Output in JSON with keys: reply, suggestion.'
          ].join(' ');

    const user = [
      `Task: ${task}`,
      mode === 'tools' ? 'Mode: tools (use extra reasoning)' : 'Mode: direct',
      prompt ? `User Prompt: ${prompt}` : '',
      selection ? `Selection:\n${selection}` : '',
      selection ? '' : `Full Content:\n${content}`
    ].filter(Boolean).join('\n\n');

    const result = await callOpenAICompatible({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      model: llmConfig?.model,
      endpoint: llmConfig?.endpoint,
      apiKey: llmConfig?.apiKey
    });

    if (!result.ok) {
      return {
        ok: false,
        reply: t(lang, 'llm_error', { error: result.error || 'unknown error' }),
        suggestion: ''
      };
    }

    const normalized = normalizeAgentReply(result.content, '');
    const reply = normalized.reply;
    const suggestion = normalized.suggestion;

    return { ok: true, reply, suggestion };
  });
}
