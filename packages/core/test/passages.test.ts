import { describe, it, expect } from 'vitest';
import { makePassages } from '../src/passages';

describe('makePassages', () => {
  it('returns a single passage for a short body', () => {
    const passages = makePassages('Header', 'One sentence. Two sentences.');
    expect(passages).toEqual(['Header. One sentence. Two sentences.']);
  });

  it('prefixes every passage with the header', () => {
    const body = 'S1. S2. S3. S4. S5. S6. S7.';
    const passages = makePassages('My Doc', body);
    expect(passages.length).toBeGreaterThan(1);
    for (const p of passages) expect(p.startsWith('My Doc. ')).toBe(true);
  });

  it('steps by window minus overlap', () => {
    // 7 sentences, window 3, overlap 1 → step 2 → starts at 0, 2, 4 → 3 passages
    const body = 'S1. S2. S3. S4. S5. S6. S7.';
    const passages = makePassages('H', body, 3, 1);
    expect(passages).toEqual([
      'H. S1. S2. S3.',
      'H. S3. S4. S5.',
      'H. S5. S6. S7.',
    ]);
  });

  it('falls back to whole text when there are no sentence delimiters', () => {
    const passages = makePassages('H', 'no punctuation here just words');
    expect(passages).toEqual(['H. no punctuation here just words']);
  });

  it('handles empty body', () => {
    expect(makePassages('H', '')).toEqual(['H. ']);
  });
});
