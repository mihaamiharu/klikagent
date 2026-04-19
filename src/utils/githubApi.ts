import { WorkflowRunInputs } from '../types';
import { log } from './logger';

export async function fetchWorkflowRunInputs(runId: number): Promise<WorkflowRunInputs> {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_TEST_REPO;
  const token = process.env.GITHUB_TOKEN;

  if (!owner || !repo || !token) {
    throw new Error('Missing required env vars: GITHUB_OWNER, GITHUB_TEST_REPO, GITHUB_TOKEN');
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/runs/${runId}`;
  log('INFO', `Fetching inputs for run ${runId} via GitHub API...`);

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as {
    path?: string;
    display_title?: string;
  };

  // Workflow dispatch inputs are encoded in display_title or must be inferred.
  // The GitHub API returns inputs via the `inputs` field on workflow_run objects
  // fetched through the REST API. Check the path for runType, display_title for ticketId.
  const runData = data as Record<string, unknown>;
  const inputs = runData['inputs'] as Record<string, string> | undefined;

  if (!inputs || !inputs['ticketId'] || !inputs['runType']) {
    throw new Error(
      `Missing or malformed workflow run inputs for run ${runId}: ${JSON.stringify(inputs)}`
    );
  }

  const runType = inputs['runType'];
  if (runType !== 'new-tests' && runType !== 'affected' && runType !== 'smoke') {
    throw new Error(`Invalid runType value: ${runType}`);
  }

  return {
    ticketId: inputs['ticketId'],
    runType,
  };
}
