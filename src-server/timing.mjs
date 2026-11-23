import fs from 'node:fs';
import { getEffectiveSettings } from './env.mjs';

export async function transcribeWithDeepgram({ audioPath, signal }) {
  const settings = getEffectiveSettings();
  const url = `${settings.deepgramBaseUrl}/v1/listen?model=nova-3&language=ar&punctuate=true`;
  const headers = {
    'Content-Type': 'audio/mpeg'
  };
  if (settings.deepgramApiKey) {
    headers['Authorization'] = `Token ${settings.deepgramApiKey}`;
  }

  const audioBytes = fs.readFileSync(audioPath);
  const res = await fetch(url, {
    method: 'POST',
    headers,
    signal,
    body: audioBytes
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Deepgram /v1/listen failed (${res.status}): ${errText.slice(0, 280)}`);
  }

  const data = await res.json();
  const alt = data?.results?.channels?.[0]?.alternatives?.[0];
  const words = Array.isArray(alt?.words) ? alt.words : [];

  return words.map((w) => ({
    word: w.punctuated_word || w.word || '',
    start: Number((w.start ?? 0).toFixed(3)),
    end: Number((w.end ?? (w.start ?? 0) + 0.1).toFixed(3)),
    confidence: typeof w.confidence === 'number' ? w.confidence : 0.85
  }));
}

export function normalizeForAlignment(str) {
  if (!str) return '';
  return str
    .normalize('NFKC')
    // Strip Arabic diacritics & tatweel
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    // Normalize alef forms, alef maqsura, taa marbuta
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    // Keep Arabic letters, Latin letters, digits; drop punctuation
    .replace(/[^\u0621-\u064Aa-zA-Z0-9]/g, '')
    .toLowerCase();
}

export function tokenizeScript(scriptText) {
  const lines = String(scriptText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const tokens = [];
  lines.forEach((line, lineIndex) => {
    const parts = line.split(/\s+/).filter(Boolean);
    parts.forEach((raw, posInLine) => {
      tokens.push({
        index: tokens.length,
        text: raw,
        norm: normalizeForAlignment(raw),
        lineIndex,
        isLineStart: posInLine === 0,
        isLineEnd: posInLine === parts.length - 1
      });
    });
  });
  return tokens;
}

/**
 * Character-level LCS alignment: maps timed ASR/TTS words onto the script's own tokens
 * so captions always keep the script's exact Arabic + English spelling.
 */
export function alignScriptWithLCS({ scriptText, timedWords, totalDuration = 0 }) {
  const tokens = tokenizeScript(scriptText);
  if (tokens.length === 0) return [];

  const cleanTimed = (timedWords || [])
    .map((w, idx) => ({
      idx,
      raw: w.word || w.text || '',
      norm: normalizeForAlignment(w.word || w.text || ''),
      start: typeof w.start === 'number' ? w.start : 0,
      end: typeof w.end === 'number' ? w.end : 0.1,
      confidence: typeof w.confidence === 'number' ? w.confidence : 0.9
    }))
    .filter((w) => w.norm.length > 0);

  if (cleanTimed.length === 0) {
    // Even fallback spacing if no timed words exist
    const dur = totalDuration > 0 ? totalDuration : tokens.length * 0.38;
    const step = dur / tokens.length;
    return tokens.map((t, i) => ({
      index: t.index,
      text: t.text,
      lineIndex: t.lineIndex,
      isLineStart: t.isLineStart,
      isLineEnd: t.isLineEnd,
      start: Number((i * step).toFixed(3)),
      end: Number(((i + 1) * step).toFixed(3)),
      matchRatio: 0,
      confidence: 0,
      weak: true,
      weakReason: 'no_timing_anchors'
    }));
  }

  // Flatten script normalized chars -> tokenIndex
  const sChars = [];
  const sTokenOfChar = [];
  for (let ti = 0; ti < tokens.length; ti++) {
    const norm = tokens[ti].norm;
    for (let ci = 0; ci < norm.length; ci++) {
      sChars.push(norm[ci]);
      sTokenOfChar.push(ti);
    }
  }

  // Flatten timed normalized chars -> timedWordIndex
  const tChars = [];
  const tWordOfChar = [];
  for (let wi = 0; wi < cleanTimed.length; wi++) {
    const norm = cleanTimed[wi].norm;
    for (let ci = 0; ci < norm.length; ci++) {
      tChars.push(norm[ci]);
      tWordOfChar.push(wi);
    }
  }

  const N = sChars.length;
  const M = tChars.length;

  // Classic character-level LCS DP using Int32Array for speed
  const cols = M + 1;
  const dp = new Int32Array((N + 1) * cols);

  for (let i = 1; i <= N; i++) {
    const chS = sChars[i - 1];
    const rowOff = i * cols;
    const prevOff = (i - 1) * cols;
    for (let j = 1; j <= M; j++) {
      if (chS === tChars[j - 1]) {
        dp[rowOff + j] = dp[prevOff + (j - 1)] + 1;
      } else {
        const up = dp[prevOff + j];
        const left = dp[rowOff + (j - 1)];
        dp[rowOff + j] = up >= left ? up : left;
      }
    }
  }

  // Backtrack matched pairs
  const matchedWordsPerToken = Array.from({ length: tokens.length }, () => []);
  let i = N;
  let j = M;
  while (i > 0 && j > 0) {
    if (sChars[i - 1] === tChars[j - 1]) {
      const tokIdx = sTokenOfChar[i - 1];
      const wordIdx = tWordOfChar[j - 1];
      matchedWordsPerToken[tokIdx].push({
        wordIdx,
        tCharIdx: j - 1
      });
      i--;
      j--;
    } else if (dp[(i - 1) * cols + j] >= dp[i * cols + (j - 1)]) {
      i--;
    } else {
      j--;
    }
  }

  // Compute raw anchor spans per token
  const rawAligned = tokens.map((tok, ti) => {
    const matches = matchedWordsPerToken[ti].reverse();
    const normLen = Math.max(1, tok.norm.length);
    const matchRatio = Math.min(1, matches.length / normLen);

    if (matches.length === 0) {
      return {
        ...tok,
        matched: false,
        matchRatio: 0,
        confidence: 0,
        start: null,
        end: null
      };
    }

    const firstWord = cleanTimed[matches[0].wordIdx];
    const lastWord = cleanTimed[matches[matches.length - 1].wordIdx];
    const avgConf = matches.reduce((sum, m) => sum + cleanTimed[m.wordIdx].confidence, 0) / matches.length;

    return {
      ...tok,
      matched: matchRatio >= 0.35,
      matchRatio: Number(matchRatio.toFixed(2)),
      confidence: Number(avgConf.toFixed(2)),
      start: firstWord.start,
      end: lastWord.end
    };
  });

  // Interpolate missing/unmatched tokens monotonically between anchored neighbors
  const lastTimedEnd = cleanTimed[cleanTimed.length - 1].end;
  const maxDur = Math.max(totalDuration || 0, lastTimedEnd);

  let idx = 0;
  while (idx < rawAligned.length) {
    if (rawAligned[idx].matched) {
      idx++;
      continue;
    }
    const gapStart = idx;
    while (idx < rawAligned.length && !rawAligned[idx].matched) {
      idx++;
    }
    const gapEnd = idx; // exclusive
    const prevAnchorEnd = gapStart > 0 ? rawAligned[gapStart - 1].end : cleanTimed[0].start;
    const nextAnchorStart = gapEnd < rawAligned.length ? rawAligned[gapEnd].start : maxDur;
    const count = gapEnd - gapStart;
    const span = Math.max(count * 0.12, nextAnchorStart - prevAnchorEnd);
    const step = span / count;

    for (let k = 0; k < count; k++) {
      rawAligned[gapStart + k].start = prevAnchorEnd + k * step;
      rawAligned[gapStart + k].end = prevAnchorEnd + (k + 1) * step;
    }
  }

  // Enforce strict monotonicity & flag weak words
  let cursor = 0;
  return rawAligned.map((item) => {
    let start = Math.max(cursor, item.start ?? cursor);
    let end = Math.max(start + 0.06, item.end ?? start + 0.12);
    start = Number(start.toFixed(3));
    end = Number(end.toFixed(3));
    cursor = start + 0.02;

    const dur = end - start;
    const reasons = [];
    if (!item.matched) reasons.push('interpolated');
    else if (item.matchRatio < 0.55) reasons.push('low_lcs_match');
    if (item.confidence > 0 && item.confidence < 0.65) reasons.push('low_asr_confidence');
    if (dur < 0.08) reasons.push('very_short');

    return {
      index: item.index,
      text: item.text,
      lineIndex: item.lineIndex,
      isLineStart: item.isLineStart,
      isLineEnd: item.isLineEnd,
      start,
      end,
      matchRatio: item.matchRatio,
      confidence: item.confidence,
      weak: reasons.length > 0,
      weakReason: reasons.join(', ')
    };
  });
}
