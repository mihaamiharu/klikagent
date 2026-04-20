import 'dotenv/config';
import express, { Request, Response } from 'express';
import { validatePayload } from './validator';
import { parseGitHubPayload } from './github/parser';
import { routeGitHubEvent } from './github/router';
import { log } from '../utils/logger';

const app = express();

app.post('/webhook/github', express.raw({ type: '*/*' }), async (req: Request, res: Response) => {
  const eventType = req.headers['x-github-event'] as string | undefined;
  log('INFO', `POST /webhook/github (${eventType ?? 'unknown'})`);

  if (!validatePayload(req, 'github')) {
    log('WARN', `POST /webhook/github — invalid signature, rejecting`);
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse((req.body as Buffer).toString('utf8'));
  } catch {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  if (!eventType) {
    res.status(400).json({ error: 'Missing x-github-event header' });
    return;
  }

  let result: Awaited<ReturnType<typeof parseGitHubPayload>>;
  try {
    result = await parseGitHubPayload(eventType, payload);
  } catch (err) {
    log('ERROR', `Error parsing GitHub event "${eventType}": ${(err as Error).message}`);
    res.status(200).json({ skipped: true });
    return;
  }

  if (result === null) {
    res.status(200).json({ skipped: true });
    return;
  }

  // Respond immediately, process asynchronously
  res.status(200).json({ received: true });
  routeGitHubEvent(result).catch((err: Error) => {
    log('ERROR', `Unhandled error in routeGitHubEvent: ${err.message}`);
  });
});

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
app.listen(port, () => {
  log('INFO', `KlikAgent webhook listener running on port ${port}`);
});
