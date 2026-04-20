// feature:* label takes priority; falls back to keyword scoring against title + AC text.
// Title is scored with a 3x multiplier to prevent body noise from overriding it.
//
// keywordMap comes from klikagent-tests/config/keywords.json (loaded by the caller).
// If empty, falls back to treating each route map key as its own keyword.
export function detectFeature(
  acText: string,
  labels: string[],
  title = '',
  keywordMap: Record<string, string[]> = {},
): string {
  const featureLabel = labels.find((l) => l.startsWith('feature:'));
  if (featureLabel) {
    const name = featureLabel.split(':')[1];
    if (name) return name;
  }

  const lowerTitle = title.toLowerCase();
  const lowerBody = acText.toLowerCase();
  let bestFeature = 'general';
  let bestScore = 0;

  for (const [feature, keywords] of Object.entries(keywordMap)) {
    const titleScore = keywords.filter((kw) => lowerTitle.includes(kw)).length * 3;
    const bodyScore = keywords.filter((kw) => lowerBody.includes(kw)).length;
    const score = titleScore + bodyScore;
    if (score > bestScore) {
      bestScore = score;
      bestFeature = feature;
    }
  }

  return bestFeature;
}
