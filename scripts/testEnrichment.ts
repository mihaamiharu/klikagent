/**
 * End-to-end smoke test: Skeleton → commit → Crawl → Enrichment Agent
 *
 * Steps:
 *   1. Run skeleton agent for issue #50
 *   2. Create branch + commit skeleton to klikagent-tests
 *   3. Crawl the reviews pages on the local QA env
 *   4. Run enrichment agent (reads skeleton from branch, enriches with real locators)
 *
 * Usage: npx ts-node scripts/testEnrichment.ts
 * Requires: local dev server running at QA_BASE_URL (http://localhost:5173)
 */
import 'dotenv/config';
import { runSkeletonAgent } from '../src/agents/skeletonAgent';
import { runEnrichmentAgent } from '../src/agents/enrichmentAgent';
import { captureSnapshots } from '../src/services/crawler';
import {
  getDefaultBranchSha,
  createBranch,
  commitFile,
  testRepoName,
} from '../src/services/github';
import { GitHubIssue } from '../src/types';

const issue: GitHubIssue = {
  number: 50,
  title: 'feat(reviews): patient reviews after completed appointments',
  body: `## Acceptance Criteria

- Given I am a logged-in patient with a completed appointment
  When I navigate to my appointment history
  Then I should see a "Leave a Review" button for completed appointments

- Given I click "Leave a Review"
  When I submit a star rating (1-5) and a comment
  Then the review should be saved and I should see a confirmation message

- Given I have already reviewed an appointment
  When I view that appointment again
  Then the "Leave a Review" button should not be visible

- Given I visit a doctor's profile page
  When I scroll to the reviews section
  Then I should see the doctor's average rating and paginated reviews (5 per page)`,
  url: 'https://github.com/mihaamiharu/caresync/issues/50',
  labels: ['scope:web'],
};

const feature = 'reviews';
const branch = 'qa/50-patient-reviews';
const specPath = `tests/web/${feature}/50.spec.ts`;
const baseUrl = process.env.QA_BASE_URL ?? 'http://localhost:5173';

// Pages to crawl for the reviews feature
const urlsToCapture = [
  `${baseUrl}/appointments`,
  `${baseUrl}/doctors`,
];

async function main() {
  // ── Step 1: Skeleton ──────────────────────────────────────────────────────
  console.log('\n=== Step 1: Skeleton Agent ===\n');
  const skeleton = await runSkeletonAgent(issue, feature, branch);
  console.log(`Skeleton generated (${skeleton.length} chars)`);

  // ── Step 2: Commit skeleton to klikagent-tests ────────────────────────────
  console.log('\n=== Step 2: Commit skeleton to klikagent-tests ===\n');
  const baseSha = await getDefaultBranchSha(testRepoName());
  await createBranch(testRepoName(), branch, baseSha);
  await commitFile(
    testRepoName(),
    branch,
    specPath,
    skeleton,
    `chore(skeleton): #50 patient reviews [klikagent]`
  );
  console.log(`Committed to ${testRepoName()}/${branch}/${specPath}`);

  // ── Step 3: Crawl ─────────────────────────────────────────────────────────
  console.log('\n=== Step 3: Crawl QA pages ===\n');
  console.log(`Capturing: ${urlsToCapture.join(', ')}`);
  const snapshots = await captureSnapshots(urlsToCapture);
  console.log(`Captured ${snapshots.length} snapshots`);
  snapshots.forEach((s) => {
    console.log(`  ${s.url}: ${s.locators.length} locators, ${s.testIds.length} testIds`);
  });

  // ── Step 4: Enrichment Agent ──────────────────────────────────────────────
  console.log('\n=== Step 4: Enrichment Agent ===\n');
  const { enrichedSpec, pomContent, affectedPaths } = await runEnrichmentAgent(
    issue,
    feature,
    branch,
    snapshots,
    '' // no PR diff for this smoke test
  );

  console.log('\n=== RESULT: Enriched Spec ===\n');
  console.log(enrichedSpec);

  console.log('\n=== RESULT: POM ===\n');
  console.log(pomContent);

  console.log('\n=== RESULT: Affected Paths ===\n');
  console.log(affectedPaths);
}

main().catch((err) => {
  console.error('\nFailed:', err.message);
  process.exit(1);
});
