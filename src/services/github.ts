import { createSign } from 'crypto';
import { CIResult, PR, PRComment } from '../types';
import { log } from '../utils/logger';

const GITHUB_API = 'https://api.github.com';

export function ownerName(): string {
  const o = process.env.GITHUB_OWNER;
  if (!o) throw new Error('GITHUB_OWNER env var is not set');
  return o;
}

export function mainRepo(): string {
  const r = process.env.GH_MAIN_REPO;
  if (!r) throw new Error('GH_MAIN_REPO env var is not set');
  return r;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function makeJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: now - 60, exp: now + 600, iss: appId }));
  const data = `${header}.${payload}`;
  const sign = createSign('RSA-SHA256');
  sign.update(data);
  const sig = base64url(sign.sign(privateKey));
  return `${data}.${sig}`;
}

export async function token(): Promise<string> {
  const appId = process.env.GH_APP_ID;
  const privateKey = process.env.GH_PRIVATE_KEY;
  const installationId = process.env.GH_INSTALLATION_ID;
  if (!appId || !privateKey || !installationId) {
    throw new Error('GH_APP_ID, GH_PRIVATE_KEY, and GH_INSTALLATION_ID env vars are required');
  }
  const jwt = makeJwt(appId, privateKey.replace(/\\n/g, '\n'));
  const res = await fetch(`${GITHUB_API}/app/installations/${installationId}/access_tokens`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(`GitHub App token fetch failed: ${res.status}`);
  const data = await res.json() as { token: string };
  return data.token;
}

export async function ghRequest(path: string, method = 'GET', body?: unknown): Promise<Response> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res;
}

// ─── PR lookup ────────────────────────────────────────────────────────────────

export async function findPRByTicketId(ticketId: string, repo: string): Promise<PR | null> {
  // Search open + closed PRs whose head branch contains the ticket ID
  const res = await ghRequest(`/repos/${ownerName()}/${repo}/pulls?state=all&per_page=50`);
  if (!res.ok) throw new Error(`findPRByTicketId: ${res.status}`);
  const prs = await res.json() as Array<{
    number: number; draft: boolean; html_url: string;
    head: { ref: string; sha: string };
  }>;
  const match = prs.find((pr) => pr.head.ref.includes(ticketId));
  if (!match) return null;
  return { number: match.number, branch: match.head.ref, headSha: match.head.sha, url: match.html_url, isDraft: match.draft };
}

export async function findBranchesByPattern(repo: string, pattern: string): Promise<string[]> {
  const res = await ghRequest(`/repos/${ownerName()}/${repo}/branches?per_page=100`);
  if (!res.ok) throw new Error(`findBranchesByPattern: ${res.status}`);
  const branches = await res.json() as Array<{ name: string }>;
  return branches.filter((b) => b.name.includes(pattern)).map((b) => b.name);
}

// ─── CI gate ──────────────────────────────────────────────────────────────────

export async function getCIStatus(ticketId: string): Promise<CIResult> {
  const pr = await findPRByTicketId(ticketId, mainRepo());
  if (!pr) throw new Error(`No PR found in ${mainRepo()} for ticket ${ticketId}`);

  const res = await ghRequest(`/repos/${ownerName()}/${mainRepo()}/commits/${pr.headSha}/check-runs`);
  if (!res.ok) throw new Error(`getCIStatus: ${res.status}`);
  const data = await res.json() as { check_runs: Array<{ conclusion: string | null; html_url: string }> };

  const runs = data.check_runs;
  const failed = runs.find((r) => r.conclusion === 'failure' || r.conclusion === 'timed_out');
  const pending = runs.find((r) => r.conclusion === null);
  const conclusion = failed ? 'failure' : pending ? 'pending' : 'success';

  return {
    passed: conclusion === 'success',
    conclusion,
    checkRunUrl: runs[0]?.html_url ?? pr.url,
    prUrl: pr.url,
  };
}

// ─── PR comments ──────────────────────────────────────────────────────────────

export async function getPRComments(prNumber: number, repo: string): Promise<PRComment[]> {
  const res = await ghRequest(`/repos/${ownerName()}/${repo}/issues/${prNumber}/comments`);
  if (!res.ok) throw new Error(`getPRComments: ${res.status}`);
  const data = await res.json() as Array<{ id: number; body: string; user: { login: string }; created_at: string }>;
  return data.map((c) => ({ id: c.id, body: c.body, userLogin: c.user.login, createdAt: c.created_at }));
}


export async function replyToReviewComment(prNumber: number, repo: string, commentId: number, body: string): Promise<void> {
  const res = await ghRequest(
    `/repos/${ownerName()}/${repo}/pulls/${prNumber}/comments/${commentId}/replies`,
    'POST',
    { body }
  );
  if (!res.ok) throw new Error(`replyToReviewComment ${commentId}: ${res.status}`);
}

export async function requestReview(prNumber: number, repo: string, reviewer: string): Promise<void> {
  const res = await ghRequest(
    `/repos/${ownerName()}/${repo}/pulls/${prNumber}/requested_reviewers`,
    'POST',
    { reviewers: [reviewer] }
  );
  if (!res.ok) throw new Error(`requestReview PR#${prNumber}: ${res.status}`);
}

export async function createIssueComment(repo: string, issueNumber: number, body: string): Promise<void> {
  const res = await ghRequest(`/repos/${ownerName()}/${repo}/issues/${issueNumber}/comments`, 'POST', { body });
  if (!res.ok) throw new Error(`createIssueComment #${issueNumber}: ${res.status}`);
}

// ─── Branch + file operations ─────────────────────────────────────────────────

export async function getDefaultBranchSha(repo: string): Promise<string> {
  const repoRes = await ghRequest(`/repos/${ownerName()}/${repo}`);
  if (!repoRes.ok) throw new Error(`getDefaultBranchSha: ${repoRes.status}`);
  const repoData = await repoRes.json() as { default_branch: string };

  const branchRes = await ghRequest(`/repos/${ownerName()}/${repo}/branches/${repoData.default_branch}`);
  if (!branchRes.ok) throw new Error(`getDefaultBranchSha branch: ${branchRes.status}`);
  const branchData = await branchRes.json() as { commit: { sha: string } };
  return branchData.commit.sha;
}

export async function createBranch(repo: string, branchName: string, baseSha: string): Promise<void> {
  const res = await ghRequest(`/repos/${ownerName()}/${repo}/git/refs`, 'POST', {
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });
  // 422 = branch already exists — treat as success
  if (!res.ok && res.status !== 422) {
    throw new Error(`createBranch "${branchName}": ${res.status} ${await res.text()}`);
  }
  log('INFO', `Branch ready: ${branchName}`);
}

export async function getFileOnBranch(repo: string, branch: string, path: string): Promise<string | null> {
  const res = await ghRequest(`/repos/${ownerName()}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getFileOnBranch ${path}@${branch}: ${res.status}`);
  const data = await res.json() as { content: string; encoding: string };
  return Buffer.from(data.content, 'base64').toString('utf8');
}

export async function commitFile(
  repo: string,
  branch: string,
  path: string,
  content: string,
  message: string
): Promise<void> {
  // Check if file exists to get its SHA (required for updates)
  const existingRes = await ghRequest(`/repos/${ownerName()}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`);
  let sha: string | undefined;
  if (existingRes.ok) {
    const existing = await existingRes.json() as { sha: string };
    sha = existing.sha;
  }

  const encodedContent = Buffer.from(content, 'utf8').toString('base64');
  const res = await ghRequest(`/repos/${ownerName()}/${repo}/contents/${path}`, 'PUT', {
    message,
    content: encodedContent,
    branch,
    ...(sha ? { sha } : {}),
  });
  if (!res.ok) throw new Error(`commitFile ${path}: ${res.status} ${await res.text()}`);
  log('INFO', `Committed ${path} to ${branch}`);
}

export async function openPR(
  repo: string,
  branch: string,
  title: string,
  body: string,
  draft = false,
  base = 'main'
): Promise<string> {
  const res = await ghRequest(`/repos/${ownerName()}/${repo}/pulls`, 'POST', {
    title,
    body,
    head: branch,
    base,
    draft,
  });
  if (!res.ok) {
    if (res.status === 422) {
      // PR already exists — fetch the existing one
      const existing = await ghRequest(`/repos/${ownerName()}/${repo}/pulls?head=${ownerName()}:${branch}&state=open`);
      if (existing.ok) {
        const prs = await existing.json() as Array<{ html_url: string }>;
        if (prs.length > 0) {
          log('INFO', `PR already exists: ${prs[0].html_url}`);
          return prs[0].html_url;
        }
      }
    }
    throw new Error(`openPR "${branch}": ${res.status} ${await res.text()}`);
  }
  const pr = await res.json() as { html_url: string };
  log('INFO', `PR opened: ${pr.html_url}`);
  return pr.html_url;
}

// ─── Workflow dispatch ────────────────────────────────────────────────────────

export async function triggerWorkflow(
  repo: string,
  workflow: string,
  ref: string,
  inputs: Record<string, string>
): Promise<void> {
  const res = await ghRequest(
    `/repos/${ownerName()}/${repo}/actions/workflows/${workflow}/dispatches`,
    'POST',
    { ref, inputs }
  );
  if (!res.ok) throw new Error(`triggerWorkflow ${workflow}: ${res.status} ${await res.text()}`);
  log('INFO', `Dispatched ${workflow} on ${ref} with inputs: ${JSON.stringify(inputs)}`);
}

// ─── Repo provisioning ────────────────────────────────────────────────────────

export async function createRepo(
  owner: string,
  repoName: string,
): Promise<{ htmlUrl: string; cloneUrl: string; defaultBranch: string }> {
  const res = await ghRequest(`/orgs/${owner}/repos`, 'POST', {
    name: repoName,
    private: true,
    auto_init: true,
  });
  if (!res.ok) throw new Error(`createRepo ${owner}/${repoName}: ${res.status} ${await res.text()}`);
  const data = await res.json() as { html_url: string; clone_url: string; default_branch: string };
  log('INFO', `Repo created: ${data.html_url}`);
  return { htmlUrl: data.html_url, cloneUrl: data.clone_url, defaultBranch: data.default_branch };
}

