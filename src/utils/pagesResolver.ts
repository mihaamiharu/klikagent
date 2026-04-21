// Dynamically resolves caresync page routes by fetching the pages directory
// from the caresync GitHub repo via the GitHub API.
// Replaces the static routeResolver.ts / config/routes.ts approach.

import { log } from './logger';

const CARESYNC_OWNER = 'mihaamiharu';
const CARESYNC_REPO = 'caresync';
const PAGES_PATH = 'apps/web/src/pages';
const GITHUB_API = 'https://api.github.com';

// Regex to extract inline path references from AC text (e.g. "/login", "/doctors/123")
const PATH_RE = /\/[a-z][a-z0-9/_-]*/gi;

// Extensions to strip from file names when deriving route segments
const STRIP_EXT_RE = /\.(tsx?|jsx?)$/;

// Files to ignore entirely
const IGNORE_RE = /\.test\.(tsx?|jsx?)$/;

interface GitHubTreeItem {
  path: string;
  type: 'blob' | 'tree';
  sha: string;
  url: string;
}

interface GitHubTreeResponse {
  tree: GitHubTreeItem[];
  truncated: boolean;
}

// ── In-memory cache (one fetch per process lifetime) ────────────────────────

let cachedRoutes: string[] | null = null;

async function fetchPagesTree(): Promise<GitHubTreeItem[]> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error('GITHUB_TOKEN env var is required for pagesResolver');
  }

  // First, resolve the SHA for the pages directory tree via the contents API
  const contentsUrl = `${GITHUB_API}/repos/${CARESYNC_OWNER}/${CARESYNC_REPO}/git/trees/HEAD?recursive=1`;
  log('INFO', `[pagesResolver] Fetching caresync repo tree from ${contentsUrl}`);

  const res = await fetch(contentsUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!res.ok) {
    throw new Error(`[pagesResolver] GitHub API error: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as GitHubTreeResponse;

  if (data.truncated) {
    log('WARN', '[pagesResolver] GitHub tree response was truncated — some routes may be missing');
  }

  // Filter to only items inside the pages directory
  return data.tree.filter((item) => item.path.startsWith(PAGES_PATH + '/'));
}

/**
 * Derive a URL route from a pages-relative file path.
 *
 * Rules:
 *  - blob (file): strip extension, ignore test files → /segment
 *  - tree (dir):  keep as-is → /segment (used as route prefix)
 *  - foo-bar.tsx → /foo-bar
 *  - nested/index.tsx → /nested (index files collapse to parent)
 */
function pathToRoute(pagesRelativePath: string, type: 'blob' | 'tree'): string | null {
  if (type === 'blob') {
    if (IGNORE_RE.test(pagesRelativePath)) return null;
    // Strip extension
    const withoutExt = pagesRelativePath.replace(STRIP_EXT_RE, '');
    // Collapse index → parent directory
    const segments = withoutExt.split('/');
    if (segments[segments.length - 1] === 'index') {
      segments.pop();
    }
    return '/' + segments.join('/');
  }

  // For directories just return the top-level prefix
  return '/' + pagesRelativePath.split('/')[0];
}

async function getAllRoutes(): Promise<string[]> {
  if (cachedRoutes !== null) {
    log('INFO', '[pagesResolver] Using cached routes');
    return cachedRoutes;
  }

  const tree = await fetchPagesTree();

  const routeSet = new Set<string>();

  for (const item of tree) {
    // Strip the pages prefix to get a pages-relative path
    const rel = item.path.slice(PAGES_PATH.length + 1); // e.g. "login.tsx" or "appointments/index.tsx"

    const route = pathToRoute(rel, item.type);
    if (route && route !== '/') {
      routeSet.add(route);
    }
  }

  cachedRoutes = [...routeSet].sort();
  log('INFO', `[pagesResolver] Resolved ${cachedRoutes.length} route(s): ${cachedRoutes.join(', ')}`);
  return cachedRoutes;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolves the set of starting URLs for a crawl based on the feature name and
 * acceptance criteria text. Drop-in replacement for routeResolver.resolveUrls
 * — same semantics but dynamic (reads caresync pages dir via GitHub API).
 *
 * @param feature  The detected feature name (e.g. "appointments", "login")
 * @param acText   The raw acceptance-criteria / issue body text
 * @returns        Array of URL path strings (e.g. ["/appointments", "/doctors"])
 */
export async function resolveStartingUrls(feature: string, acText: string): Promise<string[]> {
  const allRoutes = await getAllRoutes();

  if (feature === 'e2e') {
    // For e2e, extract explicit path mentions from AC text
    const matches = acText.match(PATH_RE) ?? [];
    const mentioned = [...new Set(matches)];
    return mentioned.length > 0 ? mentioned : allRoutes;
  }

  // Check if the feature name directly matches a route segment
  const directMatch = allRoutes.filter((r) => {
    const segments = r.split('/').filter(Boolean);
    return segments.some((s) => s === feature || s.replace(/-/g, '') === feature.replace(/-/g, ''));
  });

  if (directMatch.length > 0) {
    log('INFO', `[pagesResolver] Direct route match for "${feature}": ${directMatch.join(', ')}`);
    return directMatch;
  }

  // Check if any route segment is mentioned in the acText
  const acLower = acText.toLowerCase();
  const acMentioned = allRoutes.filter((r) => {
    const segment = r.split('/').filter(Boolean)[0] ?? '';
    return segment && acLower.includes(segment.replace(/-/g, ' '));
  });

  if (acMentioned.length > 0) {
    log('INFO', `[pagesResolver] AC-text route match for "${feature}": ${acMentioned.join(', ')}`);
    return acMentioned;
  }

  // Fallback: return all routes so the crawler has something to work with
  log('WARN', `[pagesResolver] No route match for feature "${feature}" — returning all routes`);
  return allRoutes;
}

/**
 * Clears the in-process route cache. Useful for testing.
 */
export function clearRouteCache(): void {
  cachedRoutes = null;
}
