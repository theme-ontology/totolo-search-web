import { describe, it, expect } from 'vitest';
import { tokenize, stem } from '../src/schema';

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumerics', () => {
    expect(tokenize('The Dark-Forest, at night!')).toEqual(['the', 'dark', 'forest', 'at', 'night']);
  });

  it('keeps digits', () => {
    expect(tokenize('Catch-22 in 1961')).toEqual(['catch', '22', 'in', '1961']);
  });

  it('returns empty array for empty or symbol-only input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('!?—')).toEqual([]);
  });
});

describe('stem', () => {
  it('reduces inflected forms to a common stem', () => {
    expect(stem('running')).toBe(stem('runs'));
    expect(stem('forests')).toBe(stem('forest'));
  });

  it('lowercases before stemming', () => {
    expect(stem('Running')).toBe(stem('running'));
  });
});
