const KEYWORD_MAP: Record<string, string[]> = {
  auth:      ['login', 'logout', 'password', 'sign in', 'sign up', 'register', 'auth', 'authentication'],
  checkout:  ['cart', 'checkout', 'payment', 'order', 'purchase', 'buy', 'billing'],
  search:    ['search', 'filter', 'find', 'query', 'results', 'sort'],
  profile:   ['profile', 'account', 'settings', 'avatar', 'email', 'username', 'preferences'],
  dashboard: ['dashboard', 'home', 'overview', 'summary', 'landing', 'feed'],
};

// feature:* label takes priority; falls back to keyword scoring against AC text
export function detectFeature(acText: string, labels: string[]): string {
  const featureLabel = labels.find((l) => l.startsWith('feature:'));
  if (featureLabel) {
    const name = featureLabel.split(':')[1];
    if (name) return name;
  }

  const lower = acText.toLowerCase();
  let bestFeature = 'general';
  let bestScore = 0;

  for (const [feature, keywords] of Object.entries(KEYWORD_MAP)) {
    const score = keywords.filter((kw) => lower.includes(kw)).length;
    if (score > bestScore) {
      bestScore = score;
      bestFeature = feature;
    }
  }

  return bestFeature;
}
