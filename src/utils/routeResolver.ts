// Extracts page path references from AC text for e2e multi-page crawls
// Looks for patterns like "/login", "/cart", "the checkout page", etc.
const PATH_RE = /\/[a-z][a-z0-9/_-]*/gi;

export function resolveUrls(
  feature: string,
  acText: string,
  routeMap: Record<string, string>
): string[] {
  if (feature === 'e2e') {
    const matches = acText.match(PATH_RE) ?? [];
    const unique = [...new Set(matches)];
    return unique.length > 0 ? unique : Object.values(routeMap);
  }

  const path = routeMap[feature];
  return path ? [path] : [];
}
