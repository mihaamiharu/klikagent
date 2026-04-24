import 'dotenv/config';
import express, { Request, Response } from 'express';
import { QATask, TaskResult, ReviewContext } from '../types';
import { orchestrate } from '../orchestrator';
import { runReviewAgent } from '../agents/reviewAgent';
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
// Trigger services call this endpoint when a CHANGES_REQUESTED review arrives.
// Responds immediately and processes asynchronously.

app.post('/reviews', (req: Request, res: Response) => {
  const ctx = req.body as ReviewContext;

  if (!ctx.prNumber || !ctx.branch || !ctx.ticketId || !ctx.reviewId || !ctx.reviewerLogin) {
    res.status(400).json({ error: 'Missing required fields: prNumber, branch, ticketId, reviewId, reviewerLogin' });
    return;
  }

  log('INFO', `POST /reviews — pr=#${ctx.prNumber} branch="${ctx.branch}" reviewer=${ctx.reviewerLogin}`);
  res.status(202).json({ received: true, prNumber: ctx.prNumber });

  // Derive feature from branch name: qa/<ticketId>-<feature>-* → second segment after ticketId
  // e.g. "qa/42-auth-login-form" → "auth"; undefined if branch format doesn't match
  const featureMatch = ctx.branch.match(/^qa\/\d+-([^-]+)/);
  const feature = featureMatch ? featureMatch[1] : undefined;

  const runId = `pr-${ctx.prNumber}`;
  runStore.startRun(runId, ctx.ticketId, `Review PR #${ctx.prNumber}`, 'review');
  dashboardBus.withRunId(runId, () => {
    runReviewAgent(ctx, feature).then(() => {
      runStore.endRun(runId, 'success');
    }).catch((err: Error) => {
      log('ERROR', `[reviews] Unhandled error for PR #${ctx.prNumber}: ${err.message}`);
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
