// Filename- and URL-safe slug for document page files. Lowercase ASCII letters,
// digits, and hyphens only — safe on Windows checkouts and needs no URL encoding.
export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip combining diacritics exposed by NFKD
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (s || 'doc').slice(0, 80);
}
