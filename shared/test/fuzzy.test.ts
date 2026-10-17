import { describe, expect, it } from 'vitest';
import { CATALOG } from '../src/catalog';
import { fuzzyScore, fuzzySearch } from '../src/fuzzy';

const find = (q: string) => fuzzySearch(CATALOG, q, (m) => `${m.title} ${m.categories.join(' ')}`).map((m) => m.id);

describe('fuzzy search', () => {
  it('returns everything for an empty query', () => {
    expect(find('')).toHaveLength(CATALOG.length);
  });
  it('matches prefixes and substrings', () => {
    expect(find('sint')[0]).toBe('sintel');
    expect(find('bunny')[0]).toBe('big-buck-bunny');
  });
  it('tolerates typos', () => {
    expect(find('sintl')[0]).toBe('sintel');
    expect(find('elefant')[0]).toBe('elephants-dream');
    expect(find('tears of stel')[0]).toBe('tears-of-steel');
  });
  it('matches categories', () => {
    expect(find('sci-fi')).toEqual(expect.arrayContaining(['tears-of-steel', 'elephants-dream']));
  });
  it('rejects nonsense', () => {
    expect(find('zzqqxx')).toHaveLength(0);
  });
  it('scores an exact title above a partial one', () => {
    expect(fuzzyScore('sintel', 'Sintel')).toBeGreaterThan(fuzzyScore('sintel', 'Sin City'));
  });
  it('ignores accents and punctuation', () => {
    expect(fuzzyScore('elephants dream', "Elephant's Dream")).toBeGreaterThan(0.8);
  });
});
