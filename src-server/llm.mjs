import { getEffectiveSettings } from './env.mjs';

export function stripThinkTags(text) {
  if (!text) return '';
  // Remove complete <think>...</think> blocks, and any unclosed trailing <think>...
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .trimStart();
}

export class ThinkStreamFilter {
  constructor() {
    this.inThink = false;
    this.pending = '';
    this.visible = '';
  }

  push(chunk) {
    if (!chunk) return '';
    this.pending += chunk;
    let emitted = '';

    while (this.pending.length > 0) {
      if (!this.inThink) {
        const idx = this.pending.toLowerCase().indexOf('<think>');
        if (idx !== -1) {
          const before = this.pending.slice(0, idx);
          emitted += before;
          this.visible += before;
          this.pending = this.pending.slice(idx + 7);
          this.inThink = true;
          continue;
        }
        // Hold back trailing partial '<think>' prefix
        const partialIdx = this._findTrailingPartial(this.pending, '<think>');
        if (partialIdx !== -1) {
          const safe = this.pending.slice(0, partialIdx);
          emitted += safe;
          this.visible += safe;
          this.pending = this.pending.slice(partialIdx);
          break;
        }
        emitted += this.pending;
        this.visible += this.pending;
        this.pending = '';
      } else {
        const endIdx = this.pending.toLowerCase().indexOf('</think>');
        if (endIdx !== -1) {
          this.pending = this.pending.slice(endIdx + 8);
          this.inThink = false;
          // Trim leading newlines immediately after </think>
          this.pending = this.pending.replace(/^\s*\n/, '');
          continue;
        }
        // Discard safely while keeping trailing partial '</think>'
        const partialIdx = this._findTrailingPartial(this.pending, '</think>');
        if (partialIdx !== -1) {
          this.pending = this.pending.slice(partialIdx);
        } else {
          this.pending = '';
        }
        break;
      }
    }

    return emitted;
  }

  flush() {
    if (!this.inThink && this.pending) {
      const rest = this.pending;
      this.visible += rest;
      this.pending = '';
      return rest;
    }
    this.pending = '';
    return '';
  }

  _findTrailingPartial(str, tag) {
    const lower = str.toLowerCase();
    for (let len = Math.min(tag.length - 1, str.length); len >= 1; len--) {
      if (lower.endsWith(tag.slice(0, len))) {
        return str.length - len;
      }
    }
    return -1;
  }
}

export async function streamChatCompletion({
  messages,
  temperature = 0.7,
  maxTokens = 2048,
  onDelta,
  signal
}) {
  const settings = getEffectiveSettings();
  const url = `${settings.llmBaseUrl}/chat/completions`;
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'text/event-stream'
  };
  if (settings.llmApiKey) {
    headers['Authorization'] = `Bearer ${settings.llmApiKey}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: JSON.stringify({
      model: settings.llmModel || 'auto',
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: true
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LLM request failed (${res.status}): ${errText.slice(0, 300)}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream') && res.body) {
    // Non-streaming JSON fallback if provider ignored stream:true
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content || '';
    const clean = stripThinkTags(raw);
    if (onDelta && clean) onDelta(clean, clean);
    return clean;
  }

  const filter = new ThinkStreamFilter();
  const decoder = new TextDecoder();
  let sseBuffer = '';

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuffer += decoder.decode(value, { stream: true });

    let lineEnd;
    while ((lineEnd = sseBuffer.indexOf('\n')) !== -1) {
      const line = sseBuffer.slice(0, lineEnd).trim();
      sseBuffer = sseBuffer.slice(lineEnd + 1);
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const json = JSON.parse(payload);
        const delta = json?.choices?.[0]?.delta?.content ?? json?.choices?.[0]?.message?.content ?? '';
        if (delta) {
          const cleanDelta = filter.push(delta);
          if (cleanDelta && onDelta) {
            onDelta(cleanDelta, filter.visible);
          }
        }
      } catch {
        // Ignore malformed SSE keepalive frames
      }
    }
  }

  const tail = filter.flush();
  if (tail && onDelta) {
    onDelta(tail, filter.visible);
  }
  return filter.visible.trim();
}
