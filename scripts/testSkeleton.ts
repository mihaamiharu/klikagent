/**
 * Smoke test for runSkeletonAgent.
 * Usage: npx ts-node scripts/testSkeleton.ts
 */
import 'dotenv/config';
import { runSkeletonAgent } from '../src/agents/skeletonAgent';
import { GitHubIssue } from '../src/types';

const issue: GitHubIssue = {
  number: 50,
  title: 'feat(reviews): patient reviews after completed appointments',
  body: `## Summary

Patient can submit star rating + comment after a completed appointment. Doctor profile shows average rating and paginated reviews.

## Acceptance Criteria

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

async function main() {
  console.log(`\n=== Skeleton Agent smoke test ===`);
  console.log(`Issue: #${issue.number} — ${issue.title}`);
  console.log(`Feature: ${feature}`);
  console.log(`Branch: ${branch}`);
  console.log(`\nRunning agent...\n`);

  const skeleton = await runSkeletonAgent(issue, feature, branch);

  console.log('\n=== RESULT: Skeleton Spec ===\n');
  console.log(skeleton);
}

main().catch((err) => {
  console.error('Agent failed:', err.message);
  process.exit(1);
});
