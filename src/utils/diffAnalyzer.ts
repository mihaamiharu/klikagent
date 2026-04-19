import { log } from './logger';

// Fetches the raw unified diff text for a GitHub PR.
// Returns empty string on any error — callers treat empty diff as no context available.
export async function fetchPRDiff(
  prNumber: number,
  owner: string,
  repo: string,
  token: string
): Promise<string> {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.diff',
      },
    });
    if (!res.ok) {
      log('WARN', `fetchPRDiff: ${owner}/${repo}#${prNumber} returned ${res.status}`);
      return '';
    }
    return await res.text();
  } catch (err) {
    log('WARN', `fetchPRDiff: ${owner}/${repo}#${prNumber} failed — ${(err as Error).message}`);
    return '';
  }
}
