import { describe, it, expect } from 'vitest';
import { parseOperators } from '../src/parse';

describe('parseOperators', () => {
  it('treats plain words as free text', () => {
    expect(parseOperators('dark forest')).toEqual({
      free_text: 'dark forest',
      phrases: [],
      required: [],
      excluded: [],
    });
  });

  it('extracts quoted phrases into phrases and free text', () => {
    const r = parseOperators('"dark forest" wolf');
    expect(r.phrases).toEqual(['dark forest']);
    expect(r.free_text).toBe('dark forest wolf');
    expect(r.required).toEqual([]);
    expect(r.excluded).toEqual([]);
  });

  it('parses +word as required and keeps it in free text', () => {
    const r = parseOperators('+dragon fire');
    expect(r.required).toEqual(['dragon']);
    expect(r.free_text).toBe('dragon fire');
  });

  it('parses +"phrase" as required phrase', () => {
    const r = parseOperators('+"dark forest" wolf');
    expect(r.required).toEqual(['dark forest']);
    expect(r.phrases).toEqual(['dark forest']);
    expect(r.free_text).toBe('wolf');
  });

  it('parses -word as excluded and keeps it out of free text', () => {
    const r = parseOperators('forest -dark');
    expect(r.excluded).toEqual(['dark']);
    expect(r.free_text).toBe('forest');
  });

  it('parses -"phrase" as excluded', () => {
    const r = parseOperators('forest -"dark forest"');
    expect(r.excluded).toEqual(['dark forest']);
    expect(r.free_text).toBe('forest');
  });

  it('handles mixed operators', () => {
    const r = parseOperators('wolf +dragon -"dark forest" "winter night" -ice');
    expect(r.required).toEqual(['dragon']);
    expect(r.excluded).toEqual(['dark forest', 'ice']);
    expect(r.phrases).toEqual(['winter night']);
    expect(r.free_text).toBe('wolf dragon winter night');
  });

  it('returns empty result for empty input', () => {
    expect(parseOperators('')).toEqual({
      free_text: '',
      phrases: [],
      required: [],
      excluded: [],
    });
  });

  it('returns empty result for whitespace-only input', () => {
    expect(parseOperators('   ')).toEqual({
      free_text: '',
      phrases: [],
      required: [],
      excluded: [],
    });
  });

  it('falls back to required terms as free text when query is operators-only', () => {
    const r = parseOperators('+dragon +fire');
    expect(r.required).toEqual(['dragon', 'fire']);
    expect(r.free_text).toBe('dragon fire');
  });

  it('leaves free_text empty for an exclusion-only query', () => {
    const r = parseOperators('-dark');
    expect(r.excluded).toEqual(['dark']);
    expect(r.free_text).toBe('');
  });
});
