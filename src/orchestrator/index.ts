import { QATask } from '../types';
import { log } from '../utils/logger';
import { generateQaSpecFlow } from './generateQaSpecFlow';

export async function orchestrate(task: QATask): Promise<void> {
  log('ROUTE', `[orchestrator] task=${task.taskId} title="${task.title}"`);
  await generateQaSpecFlow(task);
}
