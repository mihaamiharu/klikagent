import 'dotenv/config';
import express, { Request, Response } from 'express';
import { QATask, TaskResult, ReviewContext, ProvisionRequest } from '../types';
import { orchestrate } from '../orchestrator';
import { runReviewAgent } from '../agents/reviewAgent';
import { provisionRepo } from '../services/repoProvisioner';
import { commitFile, replyToReviewComment, getReviewComments } from '../services/github';
import { getSpecPath } from '../services/testRepo';
import { log } from '../utils/logger';
import { dashboardRoutes } from '../dashboard/routes';
import { runStore } from '../dashboard/runStore';

import { dashboardBus } from '../dashboard/eventBus';

const app = express();
app.use(express.json());
app.use('/', dashboardRoutes);

// ─── POST /tasks ──────────────────────────────────────────────────────────────
// Trigger services call this endpoint with a normalized QATask payload.
// Responds immediately and processes asynchronously.

app.post('/tasks', (req: Request, res: Response) => {
  const task = req.body as QATask;

  if (!task.taskId || !task.title || !task.description || !task.qaEnvUrl || !task.outputRepo) {
    res.status(400).json({ error: 'Missing required fields: taskId, title, description, qaEnvUrl, outputRepo' });
    return;
  }

  log('INFO', `POST /tasks — task=${task.taskId} title="${task.title}"`);
  res.status(202).json({ received: true, taskId: task.taskId });

  runStore.startRun(task.taskId, task.taskId, task.title, 'qa-spec');
  dashboardBus.withRunId(task.taskId, () => {
    orchestrate(task).then(() => {
      runStore.endRun(task.taskId, 'success');
    }).catch((err: Error) => {
      log('ERROR', `[tasks] Unhandled error for task ${task.taskId}: ${err.message}`);
      runStore.endRun(task.taskId, 'failed');
    });
  });
});

// ─── POST /reviews ────────────────────────────────────────────────────────────
// Trigger services call this endpoint when a review (CHANGES_REQUESTED or COMMENTED) arrives.
// Responds immediately and processes asynchronously.

app.post('/reviews', (req: Request, res: Response) => {
  const body = req.body as Partial<ReviewContext>;

  if (!body.prNumber || !body.branch || !body.ticketId || !body.reviewId || !body.reviewerLogin || !body.outputRepo) {
    res.status(400).json({ error: 'Missing required fields: prNumber, branch, ticketId, reviewId, reviewerLogin, outputRepo' });
    return;
  }

  const ctx: ReviewContext = {
    prNumber: body.prNumber,
    repo: body.outputRepo,
    outputRepo: body.outputRepo,
    branch: body.branch,
    ticketId: body.ticketId,
    reviewId: body.reviewId,
    reviewerLogin: body.reviewerLogin,
    comments: body.comments ?? [],
  };

  log('INFO', `POST /reviews — pr=#${ctx.prNumber} branch="${ctx.branch}" reviewer=${ctx.reviewerLogin}`);
  res.status(202).json({ received: true, prNumber: ctx.prNumber });

  // Derive feature from branch name: qa/<ticketId>-<feature>-* → second segment after ticketId
  // e.g. "qa/42-auth-login-form" → "auth"; undefined if branch format doesn't match
  const featureMatch = ctx.branch.match(/^qa\/\d+-([^-]+)/);
  const feature = featureMatch ? featureMatch[1] : undefined;

  // Strip owner prefix from outputRepo — testRepo functions expect just the repo name
  const repoName = ctx.outputRepo.includes('/') ? ctx.outputRepo.split('/').pop()! : ctx.outputRepo;

  const runId = `pr-${ctx.prNumber}`;
  runStore.startRun(runId, ctx.ticketId, `Review PR #${ctx.prNumber}`, 'review');
  dashboardBus.withRunId(runId, async () => {
    try {
      const result = await runReviewAgent(ctx, feature, repoName);

      // Commit fixed spec to branch
      const specPath = await getSpecPath(repoName, ctx.branch, ctx.ticketId, feature ?? '');
      if (specPath) {
        await commitFile(repoName, ctx.branch, specPath, result.fixedSpec, `fix(spec): address review on PR #${ctx.prNumber} [klikagent]`);
        log('INFO', `[reviews] Committed fixed spec to ${specPath}`);
        dashboardBus.emitEvent('github', 'info', `Committed fixed spec: ${specPath}`, { specPath });
      } else {
        log('WARN', `[reviews] Could not locate spec file for ticketId=${ctx.ticketId} feature=${feature} on branch ${ctx.branch}`);
      }

      // Commit updated POM to branch
      if (result.pomPath && result.pomContent) {
        await commitFile(repoName, ctx.branch, result.pomPath, result.pomContent, `fix(pom): update ${feature} POM for PR #${ctx.prNumber} [klikagent]`);
        log('INFO', `[reviews] Committed updated POM to ${result.pomPath}`);
        dashboardBus.emitEvent('github', 'info', `Committed updated POM: ${result.pomPath}`, { pomPath: result.pomPath });
      }

      // Post replies to each review comment
      for (const { commentId, body } of result.commentReplies) {
        await replyToReviewComment(ctx.prNumber, repoName, commentId, body);
        log('INFO', `[reviews] Posted reply to comment #${commentId}`);
      }

      runStore.endRun(runId, 'success');
    } catch (err) {
      log('ERROR', `[reviews] Unhandled error for PR #${ctx.prNumber}: ${(err as Error).message}`);
      runStore.endRun(runId, 'failed');
    }
  });
});

// ─── POST /webhook/github ─────────────────────────────────────────────────────
// Receives raw GitHub webhook events. Handles pull_request_review events with
// state "changes_requested" or "commented" that contain inline review comments.
// Set this as your GitHub App / repo webhook URL to skip the trigger service.

app.post('/webhook/github', (req: Request, res: Response) => {
  const event = req.headers['x-github-event'];
  if (event !== 'pull_request_review') {
    res.status(200).json({ ignored: true, event });
    return;
  }

  const payload = req.body as {
    action: string;
    review: { id: number; state: string; body: string; user: { login: string } };
    pull_request: { number: number; head: { ref: string } };
    repository: { name: string; full_name: string };
  };

  const reviewState = payload.review?.state?.toLowerCase();
  if (payload.action !== 'submitted' || !['changes_requested', 'commented'].includes(reviewState)) {
    res.status(200).json({ ignored: true, reason: `action=${payload.action} state=${reviewState}` });
    return;
  }

  const prNumber = payload.pull_request.number;
  const branch = payload.pull_request.head.ref;
  const repoName = payload.repository.name;
  const reviewId = payload.review.id;
  const reviewerLogin = payload.review.user.login;

  // Extract ticketId from branch: "qa/11-auth-flow-..." → "11"
  const ticketMatch = branch.match(/^qa\/(\d+)/);
  if (!ticketMatch) {
    log('WARN', `[webhook/github] Skipping PR #${prNumber} — branch "${branch}" is not a qa/ branch`);
    res.status(200).json({ ignored: true, reason: 'not a qa/ branch' });
    return;
  }
  const ticketId = ticketMatch[1];

  log('INFO', `[webhook/github] pull_request_review ${reviewState} — PR #${prNumber} branch="${branch}" reviewer=${reviewerLogin}`);
  res.status(202).json({ received: true, prNumber, reviewState });

  // Derive feature from branch name
  const featureMatch = branch.match(/^qa\/\d+-([^-]+)/);
  const feature = featureMatch ? featureMatch[1] : undefined;

  const runId = `pr-${prNumber}-r${reviewId}`;
  runStore.startRun(runId, ticketId, `Review PR #${prNumber} (${reviewState})`, 'review');

  dashboardBus.withRunId(runId, async () => {
    try {
      // Fetch inline comments for this review
      const comments = await getReviewComments(prNumber, reviewId, repoName);
      if (comments.length === 0) {
        log('INFO', `[webhook/github] PR #${prNumber} review #${reviewId} has no inline comments — skipping`);
        runStore.endRun(runId, 'success');
        return;
      }

      const ctx: ReviewContext = {
        prNumber,
        repo: repoName,
        outputRepo: repoName,
        branch,
        ticketId,
        reviewId,
        reviewerLogin,
        comments,
      };

      const result = await runReviewAgent(ctx, feature, repoName);

      // Commit fixed spec
      const specPath = await getSpecPath(repoName, branch, ticketId, feature ?? '');
      if (specPath) {
        await commitFile(repoName, branch, specPath, result.fixedSpec, `fix(spec): address review on PR #${prNumber} [klikagent]`);
        log('INFO', `[webhook/github] Committed fixed spec to ${specPath}`);
        dashboardBus.emitEvent('github', 'info', `Committed fixed spec: ${specPath}`, { specPath });
      } else {
        log('WARN', `[webhook/github] Could not locate spec for ticketId=${ticketId} feature=${feature} on branch ${branch}`);
      }

      // Commit updated POM
      if (result.pomPath && result.pomContent) {
        await commitFile(repoName, branch, result.pomPath, result.pomContent, `fix(pom): update ${feature} POM for PR #${prNumber} [klikagent]`);
        log('INFO', `[webhook/github] Committed updated POM to ${result.pomPath}`);
        dashboardBus.emitEvent('github', 'info', `Committed updated POM: ${result.pomPath}`, { pomPath: result.pomPath });
      }

      // Post replies
      for (const { commentId, body } of result.commentReplies) {
        await replyToReviewComment(prNumber, repoName, commentId, body);
        log('INFO', `[webhook/github] Posted reply to comment #${commentId}`);
      }

      runStore.endRun(runId, 'success');
    } catch (err) {
      log('ERROR', `[webhook/github] Error for PR #${prNumber}: ${(err as Error).message}`);
      runStore.endRun(runId, 'failed');
    }
  });
});

// ─── POST /repos/provision ────────────────────────────────────────────────────
// Creates a new convention-compliant test repo for a team.
// Responds immediately and provisions asynchronously.

app.post('/repos/provision', (req: Request, res: Response) => {
  const payload = req.body as ProvisionRequest;

  if (!payload.repoName || !payload.owner || !payload.qaEnvUrl || !payload.features || !payload.domainContext) {
    res.status(400).json({ error: 'Missing required fields: repoName, owner, qaEnvUrl, features, domainContext' });
    return;
  }

  log('INFO', `POST /repos/provision — repo=${payload.owner}/${payload.repoName}`);
  res.status(202).json({ received: true, repoName: payload.repoName });

  const runId = `provision-${payload.repoName}`;
  runStore.startRun(runId, payload.repoName, `Provision repo ${payload.repoName}`, 'provision');
  dashboardBus.withRunId(runId, () => {
    provisionRepo(payload).then(() => {
      runStore.endRun(runId, 'success');
    }).catch((err: Error) => {
      log('ERROR', `[provision] Unhandled error for ${payload.repoName}: ${err.message}`);
      runStore.endRun(runId, 'failed');
    });
  });
});

// ─── POST /tasks/:id/results ──────────────────────────────────────────────────
// CI calls this endpoint after running tests. KlikAgent reports results back
// to the originating ticket.

app.post('/tasks/:id/results', (req: Request, res: Response) => {
  const result = req.body as TaskResult;
  const taskId = req.params.id;

  log('INFO', `POST /tasks/${taskId}/results — passed=${result.passed} summary="${result.summary}"`);

  // TODO(Phase 3): forward result to trigger service / comment on ticket
  log('INFO', `[results] Task ${taskId}: ${result.passed ? '✅ passed' : '❌ failed'} — ${result.summary}`);

  res.status(200).json({ received: true });
});

// ─── GET /health ──────────────────────────────────────────────────────────────

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
app.listen(port, () => {
  log('INFO', `KlikAgent running on port ${port}`);
});
