import { GitHubIssue } from '../types';
import { log } from '../utils/logger';
import { ghRequest, ownerName, mainRepo } from './github';

export async function getIssue(issueNumber: number): Promise<GitHubIssue> {
  const res = await ghRequest(`/repos/${ownerName()}/${mainRepo()}/issues/${issueNumber}`);
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
  const res = await ghRequest(`/repos/${ownerName()}/${mainRepo()}/issues/${issueNumber}/comments`, 'POST', { body });
  if (!res.ok) throw new Error(`commentOnIssue ${issueNumber}: ${res.status} ${await res.text()}`);
  log('INFO', `Commented on issue #${issueNumber}`);
}

export async function addLabel(issueNumber: number, label: string): Promise<void> {
  const res = await ghRequest(`/repos/${ownerName()}/${mainRepo()}/issues/${issueNumber}/labels`, 'POST', { labels: [label] });
  if (!res.ok) throw new Error(`addLabel ${issueNumber} "${label}": ${res.status} ${await res.text()}`);
  log('INFO', `Added label "${label}" to issue #${issueNumber}`);
}

export async function removeLabel(issueNumber: number, label: string): Promise<void> {
  const encodedLabel = encodeURIComponent(label);
  const res = await ghRequest(`/repos/${ownerName()}/${mainRepo()}/issues/${issueNumber}/labels/${encodedLabel}`, 'DELETE');
  // 404 = label wasn't on the issue — not an error
  if (!res.ok && res.status !== 404) {
    throw new Error(`removeLabel ${issueNumber} "${label}": ${res.status} ${await res.text()}`);
  }
  log('INFO', `Removed label "${label}" from issue #${issueNumber}`);
}

export async function transitionToInQA(issueNumber: number): Promise<void> {
  await Promise.all([
    addLabel(issueNumber, 'status:in-qa'),
    removeLabel(issueNumber, 'status:ready-for-qa'),
  ]);
  log('INFO', `Issue #${issueNumber} transitioned to In QA`);
}
