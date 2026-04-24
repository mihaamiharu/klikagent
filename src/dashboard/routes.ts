import express, { Request, Response, NextFunction } from 'express';
import * as path from 'path';
import { dashboardBus, DashboardEvent } from './eventBus';
import { runStore } from './runStore';

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
