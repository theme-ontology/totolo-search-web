const SENTENCE_RE = /[^.!?]+[.!?]+\s*/g;

function splitSentences(text: string): string[] {
  const matches = text.match(SENTENCE_RE) ?? [];
  const sentences = matches.map(s => s.trim()).filter(s => s.length > 0);
  if (sentences.length === 0 && text.trim().length > 0) return [text.trim()];
  return sentences;
}

export function makePassages(
  header: string,
  body: string,
  window = 3,
  overlap = 1,
): string[] {
  const sentences = splitSentences(body);
  const step = window - overlap;

  if (sentences.length <= window) {
    return [`${header}. ${body.trim()}`];
  }

  const passages: string[] = [];
  for (let i = 0; i <= sentences.length - window; i += step) {
    const chunk = sentences.slice(i, i + window).join(' ');
    passages.push(`${header}. ${chunk}`);
  }
  return passages;
}
