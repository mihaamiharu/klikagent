import express, { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import { dashboardBus, DashboardEvent } from './eventBus';
import { runStore } from './runStore';
import { orchestrate } from '../orchestrator';
import { QATask, CiTestFailure } from '../types';
import { runWithCiFailureFix } from '../services/selfCorrection';
import { commitFile } from '../services/github';

export const dashboardRoutes = express.Router();

// Basic Auth Middleware
const basicAuth = (req: Request, res: Response, next: NextFunction) => {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    return next(); // Auth disabled if no password set
  }

  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login, pwd] = Buffer.from(b64auth, 'base64').toString().split(':');

  if (login === 'admin' && pwd === password) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="KlikAgent Dashboard"');
  res.status(401).send('Authentication required.');
};

dashboardRoutes.use('/dashboard', basicAuth);
dashboardRoutes.use('/api', basicAuth);

// ─── Static Files ─────────────────────────────────────────────────────────────

dashboardRoutes.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── API Endpoints ────────────────────────────────────────────────────────────

dashboardRoutes.get('/api/stats', (req, res) => {
  res.json(runStore.getStats());
});

dashboardRoutes.get('/api/runs', (req, res) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const runs = runStore.listRuns().slice(0, limit);
  // Strip out full events array to keep the payload small
  const list = runs.map(r => ({ ...r, events: undefined }));
  res.json(list);
});

dashboardRoutes.get('/api/runs/:id', (req, res) => {
  const run = runStore.getRun(req.params.id);
  if (!run) {
    return res.status(404).json({ error: 'Run not found' });
  }
  res.json(run);
});

dashboardRoutes.post('/api/runs/:id/retry', (req: Request, res: Response) => {
  const run = runStore.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  if (run.type !== 'qa-spec') {
    res.status(400).json({ error: 'Only qa-spec runs can be retried' });
    return;
  }
  if (run.status !== 'failed') {
    res.status(400).json({ error: 'Only failed runs can be retried' });
    return;
  }
  const task = run.metadata?.task as QATask | undefined;
  if (!task) {
    res.status(400).json({ error: 'Run has no stored task payload (was created before retry support was added)' });
    return;
  }

  const retryId = `${task.taskId}-retry-${Date.now()}`;
  res.status(202).json({ received: true, retryId });

  runStore.startRun(retryId, task.taskId, task.title, 'qa-spec', { task });
  dashboardBus.withRunId(retryId, () => {
    orchestrate(task).then(() => {
      runStore.endRun(retryId, 'success');
    }).catch((err: Error) => {
      runStore.endRun(retryId, 'failed');
    });
  });
});

dashboardRoutes.post('/api/runs/:id/fix', (req: Request, res: Response) => {
  const run = runStore.getRun(req.params.id);
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const task = run.metadata?.task as QATask | undefined;
  if (!task) {
    res.status(400).json({ error: 'Run has no stored task payload (was created before fix support was added)' });
    return;
  }

  const { branch, feature, failures } = req.body as {
    branch?: string;
    feature?: string;
    failures?: CiTestFailure[];
  };
  if (!branch || !feature || !failures?.length) {
    res.status(400).json({ error: 'branch, feature, and failures[] are required' });
    return;
  }

  const fixId = `${task.taskId}-fix-${Date.now()}`;
  res.status(202).json({ received: true, fixId });

  runStore.startRun(fixId, task.taskId, task.title, 'qa-spec', { task });
  dashboardBus.withRunId(fixId, async () => {
    try {
      const result = await runWithCiFailureFix(task, branch, feature, failures);

      for (const file of result.files) {
        await commitFile(
          task.outputRepo, branch, file.path, file.content,
          `fix(${file.role}): address CI failures for #${task.taskId} [klikagent]`,
        );
      }

      runStore.endRun(fixId, 'success');
    } catch (err) {
      runStore.endRun(fixId, 'failed');
    }
  });
});

// ─── SSE Streaming ────────────────────────────────────────────────────────────

dashboardRoutes.get('/api/events/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const runIdFilter = req.query.runId as string | undefined;

  // Function to send event to client
  const sendEvent = (event: DashboardEvent) => {
    if (runIdFilter && event.runId !== runIdFilter && event.category !== 'system') {
      return; // Skip if filtering by runId and it doesn't match
    }
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // Subscribe to new events
  dashboardBus.on('event', sendEvent);

  // Keep connection alive
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 15000);

  // Cleanup on close
  req.on('close', () => {
    dashboardBus.off('event', sendEvent);
    clearInterval(keepAlive);
    res.end();
  });
});
