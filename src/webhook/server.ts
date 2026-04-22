import 'dotenv/config';
import express, { Request, Response } from 'express';
import { QATask, TaskResult } from '../types';
import { orchestrate } from '../orchestrator';
import { log } from '../utils/logger';

const app = express();
app.use(express.json());

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

  orchestrate(task).catch((err: Error) => {
    log('ERROR', `[tasks] Unhandled error for task ${task.taskId}: ${err.message}`);
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
