import { GitHubIssue } from '../types';
import { log } from '../utils/logger';

const GITHUB_API = 'https://api.github.com';

function token(): string {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error('GITHUB_TOKEN env var is not set');
  return t;
}

function owner(): string {
  const o = process.env.GITHUB_OWNER;
  if (!o) throw new Error('GITHUB_OWNER env var is not set');
  return o;
}

function repo(): string {
  const r = process.env.GITHUB_MAIN_REPO;
  if (!r) throw new Error('GITHUB_MAIN_REPO env var is not set');
  return r;
}

async function ghRequest(path: string, method = 'GET', body?: unknown): Promise<Response> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return res;
}

export async function getIssue(issueNumber: number): Promise<GitHubIssue> {
  const res = await ghRequest(`/repos/${owner()}/${repo()}/issues/${issueNumber}`);
  if (!res.ok) throw new Error(`getIssue ${issueNumber}: ${res.status} ${await res.text()}`);
  const data = await res.json() as { number: number; title: string; body: string | null; html_url: string; labels: { name: string }[] };
  return {
    number: data.number,
    title: data.title,
    body: data.body ?? '',
    url: data.html_url,
    labels: data.labels.map((l) => l.name),
  };
}

export async function commentOnIssue(issueNumber: number, body: string): Promise<void> {
  const res = await ghRequest(`/repos/${owner()}/${repo()}/issues/${issueNumber}/comments`, 'POST', { body });
  if (!res.ok) throw new Error(`commentOnIssue ${issueNumber}: ${res.status} ${await res.text()}`);
  log('INFO', `Commented on issue #${issueNumber}`);
}

export async function addLabel(issueNumber: number, label: string): Promise<void> {
  const res = await ghRequest(`/repos/${owner()}/${repo()}/issues/${issueNumber}/labels`, 'POST', { labels: [label] });
  if (!res.ok) throw new Error(`addLabel ${issueNumber} "${label}": ${res.status} ${await res.text()}`);
  log('INFO', `Added label "${label}" to issue #${issueNumber}`);
}

export async function removeLabel(issueNumber: number, label: string): Promise<void> {
  const encodedLabel = encodeURIComponent(label);
  const res = await ghRequest(`/repos/${owner()}/${repo()}/issues/${issueNumber}/labels/${encodedLabel}`, 'DELETE');
  // 404 means label wasn't on the issue — not an error
  if (!res.ok && res.status !== 404) {
    throw new Error(`removeLabel ${issueNumber} "${label}": ${res.status} ${await res.text()}`);
  }
  log('INFO', `Removed label "${label}" from issue #${issueNumber}`);
}

export async function transitionToInQA(issueNumber: number): Promise<void> {
  await addLabel(issueNumber, 'status:in-qa');
  await removeLabel(issueNumber, 'status:ready-for-qa');
  log('INFO', `Issue #${issueNumber} transitioned to In QA`);
}
