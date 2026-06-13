import { describe, it, expect } from 'vitest';
import { slugify } from '../src/slug';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('movie: The Matrix (1999)')).toBe('movie-the-matrix-1999');
  });

  it('strips diacritics', () => {
    expect(slugify('Les Misérables')).toBe('les-miserables');
  });

  it('collapses runs of non-alphanumerics', () => {
    expect(slugify('a  --  b!!c')).toBe('a-b-c');
  });

  it('trims leading/trailing hyphens', () => {
    expect(slugify('"quoted"')).toBe('quoted');
  });

  it('falls back for symbol-only names', () => {
    expect(slugify('!!!')).toBe('doc');
  });

  it('caps length at 80', () => {
    expect(slugify('x'.repeat(200)).length).toBe(80);
  });
});
