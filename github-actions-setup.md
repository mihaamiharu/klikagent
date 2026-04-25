# GitHub Actions Setup — klikagent-demo-tests

## What This Does

Runs Playwright tests automatically whenever KlikAgent pushes a `qa/**` branch to the test repo, then reports pass/fail back to the klikagent server.

---

## File to Create

**Path:** `.github/workflows/playwright.yml` in the `klikagent-demo-tests` repo

**Content:**

```yaml
name: Playwright Tests

on:
  push:
    branches:
      - 'qa/**'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'
          cache: 'npm'

      - run: npm ci

      - run: npx playwright install --with-deps

      - run: npx playwright test --reporter=html

      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 14

      - name: Report to KlikAgent
        if: always()
        run: |
          TASK_ID=$(echo "${{ github.ref_name }}" | sed 's|qa/||' | cut -d'-' -f1)
          PASSED=$([[ "${{ job.status }}" == "success" ]] && echo "true" || echo "false")
          curl -X POST "${{ secrets.KLIKAGENT_URL }}/tasks/${TASK_ID}/results" \
            -H "Content-Type: application/json" \
            -d "{
              \"taskId\": \"${TASK_ID}\",
              \"passed\": ${PASSED},
              \"summary\": \"Playwright run ${{ job.status }} on ${{ github.ref_name }}\",
              \"reportUrl\": \"https://github.com/${{ github.repository }}/actions/runs/${{ github.run_id }}\"
            }"
        env:
          KLIKAGENT_URL: ${{ secrets.KLIKAGENT_URL }}
```

---

## GitHub Secret to Add

Go to: `github.com/mihaamiharu/klikagent-demo-tests` → Settings → Secrets and variables → Actions → New repository secret

| Name | Value |
|---|---|
| `KLIKAGENT_URL` | `http://103.235.75.99:4000` |

---

## How It Works

1. KlikAgent generates a spec and pushes to branch `qa/{taskId}-{slug}` (e.g. `qa/42-login-flow`)
2. This workflow triggers on that push
3. Playwright runs all specs in `tests/web/`
4. HTML report is uploaded as a GitHub Actions artifact (kept 14 days)
5. The `Report to KlikAgent` step extracts `taskId` from the branch name (`qa/42-login-flow` → `42`) and POSTs to `POST /tasks/42/results`

---

## Callback Payload Shape

The workflow POSTs to `POST /tasks/:id/results` with this body (matches `TaskResult` in `src/types/index.ts`):

```json
{
  "taskId": "42",
  "passed": true,
  "summary": "Playwright run success on qa/42-login-flow",
  "reportUrl": "https://github.com/mihaamiharu/klikagent-demo-tests/actions/runs/12345678"
}
```

---

## Why `push` and not `pull_request`

`pull_request.branches` filters the **base/target** branch, not the head branch. KlikAgent opens PRs from `qa/**` targeting `main` — using `pull_request` with `branches: ['qa/**']` would never trigger. Using `push` on `qa/**` triggers on every commit KlikAgent pushes to that branch.
