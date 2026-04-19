const AC_KEYWORDS = ['given', 'when', 'then'];

// GitHub Issues use plain Markdown — no ADF to parse
export function extractText(body: unknown): string {
  if (typeof body === 'string') return body;
  if (body == null) return '';
  return String(body);
}

export function hasAcceptanceCriteria(text: string): boolean {
  const lower = text.toLowerCase();
  return AC_KEYWORDS.every((kw) => lower.includes(kw));
}

// Returns the AC block starting from the first Given/When/Then line
export function parseAC(text: string): string {
  const lines = text.split('\n');
  const startIndex = lines.findIndex((l) =>
    AC_KEYWORDS.some((kw) => l.trim().toLowerCase().startsWith(kw))
  );
  if (startIndex === -1) return '';
  return lines.slice(startIndex).join('\n').trim();
}
