import 'dotenv/config';
import express, { Request, Response } from 'express';
import { QATask, TaskResult, ReviewContext, ProvisionRequest } from '../types';
import { orchestrate } from '../orchestrator';
import { runReviewAgent } from '../agents/reviewAgent';
import { provisionRepo } from '../services/repoProvisioner';
import { commitFile, replyToReviewComment } from '../services/github';
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

  runStore.startRun(task.taskId, task.taskId, task.title, 'qa-spec', { task });
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
