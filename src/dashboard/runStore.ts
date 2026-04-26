import * as fs from 'fs';
import * as path from 'path';
import { DashboardEvent, dashboardBus } from './eventBus';
import { TokenUsage } from '../services/ai';
import { log } from '../utils/logger';

export interface Run {
  id: string;
  taskId: string;
  type: 'qa-spec' | 'review' | 'result' | 'provision';
  status: 'running' | 'success' | 'failed' | 'warned';
  title: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  tokenUsage?: TokenUsage;
  metadata?: Record<string, unknown>;
  events: DashboardEvent[];
}

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'runs.json');

class RunStore {
  private runs: Map<string, Run> = new Map();

  constructor() {
    this.loadFromDisk();
    
    // Listen to all events and attach them to the appropriate run
    dashboardBus.on('event', (event: DashboardEvent) => {
      this.addEvent(event);
    });
  }

  private loadFromDisk() {
    try {
      if (fs.existsSync(DATA_FILE)) {
        const data = fs.readFileSync(DATA_FILE, 'utf-8');
        const parsed = JSON.parse(data) as Run[];
        
        // Reset any left-over 'running' statuses from a crash to 'failed'
        for (const run of parsed) {
          if (run.status === 'running') {
            run.status = 'failed';
            run.events.push({
              id: Math.random().toString(36).substring(2, 11),
              runId: run.id,
              timestamp: new Date().toISOString(),
              category: 'system',
              level: 'error',
              message: 'Run aborted unexpectedly (server restart)',
            });
          }
          this.runs.set(run.id, run);
        }
        log('INFO', `[RunStore] Loaded ${this.runs.size} runs from disk.`);
      }
    } catch (err) {
      log('WARN', `[RunStore] Failed to load runs.json: ${(err as Error).message}`);
    }
  }

  private saveToDisk() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const data = Array.from(this.runs.values());
      // Only keep the latest 50 runs to avoid file bloat
      const toKeep = data.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()).slice(0, 50);
      fs.writeFileSync(DATA_FILE, JSON.stringify(toKeep, null, 2), 'utf-8');
    } catch (err) {
      log('WARN', `[RunStore] Failed to save runs.json: ${(err as Error).message}`);
    }
  }

  public startRun(id: string, taskId: string, title: string, type: Run['type'] = 'qa-spec', metadata?: Record<string, unknown>) {
    const run: Run = {
      id,
      taskId,
      type,
      status: 'running',
      title,
      startedAt: new Date().toISOString(),
      metadata,
      events: []
    };
    this.runs.set(id, run);
    this.saveToDisk();
  }

  public endRun(id: string, status: Run['status'], tokenUsage?: TokenUsage) {
    const run = this.runs.get(id);
    if (run) {
      run.status = status;
      run.completedAt = new Date().toISOString();
      run.durationMs = new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime();
      if (tokenUsage) {
        // Aggregate token usage if already exists (for loops)
        if (run.tokenUsage) {
          run.tokenUsage.promptTokens += tokenUsage.promptTokens;
          run.tokenUsage.completionTokens += tokenUsage.completionTokens;
          run.tokenUsage.totalTokens += tokenUsage.totalTokens;
          run.tokenUsage.costUSD += tokenUsage.costUSD;
        } else {
          run.tokenUsage = { ...tokenUsage };
        }
      }
      this.saveToDisk();
    }
  }

  public addEvent(event: DashboardEvent) {
    const run = this.runs.get(event.runId);
    if (run) {
      run.events.push(event);
      if (event.category === 'agent' && event.data?.tokenUsage) {
        const usage = event.data.tokenUsage as TokenUsage;
        if (!run.tokenUsage) {
          run.tokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUSD: 0 };
        }
        run.tokenUsage.promptTokens += usage.promptTokens || 0;
        run.tokenUsage.completionTokens += usage.completionTokens || 0;
        run.tokenUsage.totalTokens += usage.totalTokens || 0;
        run.tokenUsage.costUSD += usage.costUSD || 0;
        this.saveToDisk();
      }
    }
  }

  public isRunActive(id: string): boolean {
    const run = this.runs.get(id);
    return run?.status === 'running';
  }

  public getRun(id: string): Run | undefined {
    return this.runs.get(id);
  }

  public listRuns(): Run[] {
    return Array.from(this.runs.values())
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }

  public getStats() {
    const runs = this.listRuns();
    let totalCost = 0;
    let successful = 0;
    let totalDurationMs = 0;
    let completedRuns = 0;

    for (const run of runs) {
      if (run.tokenUsage?.costUSD) totalCost += run.tokenUsage.costUSD;
      if (run.status === 'success' || run.status === 'warned') successful++;
      if (run.durationMs) {
        totalDurationMs += run.durationMs;
        completedRuns++;
      }
    }

    return {
      totalRuns: runs.length,
      successRate: runs.length > 0 ? (successful / runs.length) * 100 : 0,
      totalCostUSD: totalCost,
      avgDurationMs: completedRuns > 0 ? totalDurationMs / completedRuns : 0,
    };
  }
}

export const runStore = new RunStore();
