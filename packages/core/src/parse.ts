import type { ParsedQuery } from './types.js';

const OPERATOR_RE = /^([+-])("(?:[^"]+)"|[a-z0-9]\S*)/i;
const QUOTED_RE = /^"([^"]+)"/;
const WORD_RE = /^\S+/;

export function parseOperators(text: string): ParsedQuery {
  const result: ParsedQuery = { free_text: '', phrases: [], required: [], excluded: [] };
  const freeWords: string[] = [];
  let s = text.trim();

  while (s.length > 0) {
    s = s.trimStart();
    if (s.length === 0) break;

    const opMatch = OPERATOR_RE.exec(s);
    if (opMatch) {
      const op = opMatch[1] as '+' | '-';
      const rest = opMatch[2];
      s = s.slice(opMatch[0].length);

      const quotedMatch = QUOTED_RE.exec(rest);
      const term = quotedMatch ? quotedMatch[1] : rest;
      const isPhrase = !!quotedMatch;

      if (op === '+') {
        result.required.push(term);
        if (isPhrase) result.phrases.push(term);
        else freeWords.push(term);
      } else {
        result.excluded.push(term);
      }
      continue;
    }

    const quotedMatch = QUOTED_RE.exec(s);
    if (quotedMatch) {
      result.phrases.push(quotedMatch[1]);
      freeWords.push(quotedMatch[1]);
      s = s.slice(quotedMatch[0].length);
      continue;
    }

    const wordMatch = WORD_RE.exec(s);
    if (wordMatch) {
      freeWords.push(wordMatch[0]);
      s = s.slice(wordMatch[0].length);
      continue;
    }

    break;
  }

  result.free_text = freeWords.join(' ');
  if (!result.free_text && result.required.length > 0) {
    result.free_text = result.required.join(' ');
  }

  return result;
}
