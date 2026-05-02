import * as fs from 'fs';
import * as path from 'path';
import { commitFile, ownerName, mainRepo, createBranch, getDefaultBranchSha, ghRequest } from './github';
import { log } from '../utils/logger';
import { Run } from '../dashboard/runStore';

const DATA_FILE = path.join(__dirname, '..', '..', 'data', 'runs.json');
let exportMutex: Promise<void> | null = null;

function computeStats(runs: Run[]) {
  let totalCost = 0;
  let successful = 0;
  let totalDurationMs = 0;
  let completedRuns = 0;
  for (const run of runs) {
    if (run.tokenUsage?.costUSD) totalCost += run.tokenUsage.costUSD;
    if (run.status === 'success' || run.status === 'warned') successful++;
    if (run.durationMs) { totalDurationMs += run.durationMs; completedRuns++; }
  }
  return {
    totalRuns: runs.length,
    successRate: runs.length > 0 ? (successful / runs.length) * 100 : 0,
    totalCostUSD: totalCost,
    avgDurationMs: completedRuns > 0 ? totalDurationMs / completedRuns : 0,
  };
}

function buildHTML(runs: Run[], exportedAt: string): string {
  const stats = computeStats(runs);
  const runsJson = JSON.stringify(runs);
  const statsJson = JSON.stringify(stats);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KlikAgent Dashboard</title>
  <style>
    :root {
      --bg: #0f172a;
      --surface: #1e293b;
      --surface-hover: #334155;
      --border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #3b82f6;
      --success: #10b981;
      --error: #ef4444;
      --warn: #f59e0b;
      --agent: #8b5cf6;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background-color: var(--bg);
      color: var(--text);
      display: grid;
      grid-template-rows: 60px 1fr;
      grid-template-columns: 300px 1fr;
      height: 100vh;
      overflow: hidden;
    }
    header {
      grid-column: 1 / -1;
      background-color: var(--surface);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 20px;
    }
    .brand { font-size: 1.2rem; font-weight: bold; display: flex; align-items: center; gap: 8px; }
    .brand-dot { width: 10px; height: 10px; background-color: var(--text-muted); border-radius: 50%; }
    .snapshot-badge {
      font-size: 0.7rem;
      color: var(--text-muted);
      background: rgba(148,163,184,0.1);
      border: 1px solid var(--border);
      padding: 2px 8px;
      border-radius: 4px;
      font-family: var(--font-mono);
    }
    .stats { display: flex; gap: 20px; font-size: 0.9rem; }
    .stat-item { display: flex; flex-direction: column; align-items: flex-end; }
    .stat-label { color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
    .stat-val { font-family: var(--font-mono); font-weight: bold; }
    aside {
      border-right: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }
    .run-item {
      padding: 15px;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
      transition: background 0.2s;
    }
    .run-item:hover { background-color: var(--surface-hover); }
    .run-item.active { border-left: 4px solid var(--accent); background-color: var(--surface-hover); }
    .run-title { font-weight: 500; margin-bottom: 4px; font-size: 0.95rem; }
    .run-meta { display: flex; justify-content: space-between; font-size: 0.8rem; color: var(--text-muted); }
    .run-status { font-family: var(--font-mono); font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; font-weight: bold; }
    .status-running { background: rgba(59,130,246,0.2); color: var(--accent); }
    .status-success { background: rgba(16,185,129,0.2); color: var(--success); }
    .status-failed { background: rgba(239,68,68,0.2); color: var(--error); }
    .status-warned { background: rgba(245,158,11,0.2); color: var(--warn); }
    main { display: flex; flex-direction: column; overflow: hidden; background-color: var(--bg); }
    .run-header { padding: 20px; background-color: var(--surface); border-bottom: 1px solid var(--border); }
    .run-header h2 { font-size: 1.5rem; margin-bottom: 10px; }
    .run-stats-grid { display: flex; gap: 30px; }
    .logs-container {
      flex: 1;
      padding: 20px;
      overflow-y: auto;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      line-height: 1.5;
    }
    .log-entry { margin-bottom: 8px; display: flex; gap: 12px; border-left: 2px solid transparent; padding-left: 8px; }
    .log-time { color: var(--text-muted); min-width: 80px; }
    .log-cat { font-weight: bold; min-width: 90px; }
    .log-msg { flex: 1; word-wrap: break-word; }
    .cat-system { color: var(--text-muted); }
    .cat-agent { color: var(--agent); }
    .cat-browser { color: var(--accent); }
    .cat-flow { color: var(--success); }
    .cat-validation { color: var(--warn); }
    .cat-correction { color: var(--error); }
    .cat-github { color: var(--accent); }
    .level-warn .log-msg { color: var(--warn); }
    .level-error .log-msg { color: var(--error); }
    .log-data {
      margin-top: 4px;
      background: rgba(0,0,0,0.3);
      padding: 8px;
      border-radius: 4px;
      font-size: 0.8rem;
      color: var(--text-muted);
      white-space: pre-wrap;
    }
    .empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--text-muted);
      flex-direction: column;
      gap: 10px;
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-dot"></div>
      KlikAgent Orchestrator
      <span class="snapshot-badge">snapshot · ${new Date(exportedAt).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
    </div>
    <div class="stats" id="global-stats">
      <div class="stat-item"><span class="stat-label">Total Runs</span><span class="stat-val" id="stat-runs">-</span></div>
      <div class="stat-item"><span class="stat-label">Success Rate</span><span class="stat-val" id="stat-success">-</span></div>
      <div class="stat-item"><span class="stat-label">Total Cost</span><span class="stat-val" id="stat-cost">-</span></div>
    </div>
  </header>

  <aside id="runs-list"></aside>

  <main>
    <div id="run-view" style="display: none; height: 100%; flex-direction: column;">
      <div class="run-header">
        <h2 id="view-title"></h2>
        <div class="run-stats-grid">
          <div class="stat-item"><span class="stat-label">Status</span><span class="stat-val" id="view-status"></span></div>
          <div class="stat-item"><span class="stat-label">Duration</span><span class="stat-val" id="view-duration"></span></div>
          <div class="stat-item"><span class="stat-label">Tokens</span><span class="stat-val" id="view-tokens"></span></div>
          <div class="stat-item"><span class="stat-label">Cost</span><span class="stat-val" id="view-cost"></span></div>
        </div>
      </div>
      <div class="logs-container" id="logs"></div>
    </div>
    <div id="empty-view" class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
      <p>Select a run to view telemetry</p>
    </div>
  </main>

  <script>
    const RUNS = ${runsJson};
    const STATS = ${statsJson};

    const fTime = (iso) => new Date(iso).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const fDur = (ms) => ms ? (ms / 1000).toFixed(1) + 's' : '-';
    const fMoney = (n) => n ? '$' + n.toFixed(4) : '$0.0000';

    const elRuns = document.getElementById('runs-list');
    const elLogs = document.getElementById('logs');
    const elView = document.getElementById('run-view');
    const elEmpty = document.getElementById('empty-view');

    let activeRunId = null;

    document.getElementById('stat-runs').innerText = STATS.totalRuns;
    document.getElementById('stat-success').innerText = STATS.successRate.toFixed(1) + '%';
    document.getElementById('stat-cost').innerText = fMoney(STATS.totalCostUSD);

    function renderRunsList() {
      elRuns.innerHTML = RUNS.map(run => \`
        <div class="run-item \${run.id === activeRunId ? 'active' : ''}" onclick="selectRun('\${run.id}')">
          <div class="run-title">\${run.title}</div>
          <div class="run-meta">
            <span class="run-status status-\${run.status}">\${run.status.toUpperCase()}</span>
            <span>\${fTime(run.startedAt)}</span>
          </div>
        </div>
      \`).join('');
    }

    function selectRun(id) {
      activeRunId = id;
      renderRunsList();
      const run = RUNS.find(r => r.id === id);
      if (!run) return;

      document.getElementById('view-title').innerText = run.title;
      document.getElementById('view-status').innerHTML = \`<span class="run-status status-\${run.status}">\${run.status.toUpperCase()}</span>\`;
      document.getElementById('view-duration').innerText = fDur(run.durationMs);
      document.getElementById('view-tokens').innerText = run.tokenUsage ? run.tokenUsage.totalTokens.toLocaleString() : '-';
      document.getElementById('view-cost').innerText = run.tokenUsage ? fMoney(run.tokenUsage.costUSD) : '-';

      elLogs.innerHTML = '';
      (run.events || []).forEach(renderLog);

      elEmpty.style.display = 'none';
      elView.style.display = 'flex';
      elLogs.scrollTop = elLogs.scrollHeight;
    }

    function renderLog(event) {
      const div = document.createElement('div');
      div.className = \`log-entry level-\${event.level}\`;
      let dataHtml = '';
      if (event.data) {
        const clean = { ...event.data };
        if (clean.args?.code) clean.args.code = '[Code Content Omitted]';
        dataHtml = \`<div class="log-data">\${JSON.stringify(clean, null, 2)}</div>\`;
      }
      div.innerHTML = \`
        <div class="log-time">\${fTime(event.timestamp)}</div>
        <div class="log-cat cat-\${event.category}">[\${event.category}]</div>
        <div class="log-msg"><div>\${event.message}</div>\${dataHtml}</div>
      \`;
      elLogs.appendChild(div);
    }

    renderRunsList();
    if (RUNS.length > 0) selectRun(RUNS[0].id);
  </script>
</body>
</html>`;
}

export async function exportToGithubPages(): Promise<void> {
  if (exportMutex) {
    await exportMutex;
  }

  exportMutex = (async () => {
    let runs: Run[] = [];
    try {
      if (fs.existsSync(DATA_FILE)) {
        runs = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')) as Run[];
      }
    } catch (err) {
      log('WARN', `[staticExport] Failed to read runs.json: ${(err as Error).message}`);
    }

    const exportedAt = new Date().toISOString();
    const html = buildHTML(runs, exportedAt);

    const repo = mainRepo();
    const owner = ownerName();

    try {
      const branchExists = await checkBranchExists(repo, 'gh-pages');
      if (!branchExists) {
        await createOrphanBranch(repo, 'gh-pages');
      }
    } catch (err) {
      log('WARN', `[staticExport] Branch setup: ${(err as Error).message}`);
    }

    await commitFile(repo, 'gh-pages', 'index.html', html, `chore: update dashboard snapshot [${exportedAt}]`);
    log('INFO', `[staticExport] Dashboard published to gh-pages for ${owner}/${repo}`);
  })();

  await exportMutex;
  exportMutex = null;
}

async function checkBranchExists(repo: string, branch: string): Promise<boolean> {
  const res = await ghRequest(`/repos/${ownerName()}/${repo}/branches/${branch}`);
  return res.ok;
}

async function createOrphanBranch(repo: string, branch: string): Promise<void> {
  const owner = ownerName();

  const treeRes = await ghRequest(`/repos/${owner}/${repo}/git/trees`, 'POST', { tree: [] });
  if (!treeRes.ok) throw new Error(`createOrphanBranch tree: ${treeRes.status} ${await treeRes.text()}`);
  const treeData = await treeRes.json() as { sha: string };

  const commitRes = await ghRequest(`/repos/${owner}/${repo}/git/commits`, 'POST', {
    message: 'chore: initialize gh-pages',
    tree: treeData.sha,
    parents: [],
  });
  if (!commitRes.ok) throw new Error(`createOrphanBranch commit: ${commitRes.status} ${await commitRes.text()}`);
  const commitData = await commitRes.json() as { sha: string };

  await createBranch(repo, branch, commitData.sha);
  log('INFO', `[staticExport] Created orphan branch ${branch} for ${owner}/${repo}`);
}
