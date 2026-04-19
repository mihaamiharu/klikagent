#!/usr/bin/env bash
# KlikAgent Phase 2 — local webhook test commands
# Run with: bash test.sh
# Requires the server to be running: npm run dev

set -e

BASE_URL="${WEBHOOK_URL:-http://localhost:3000}"

echo ""
echo "=== Test 1: Jira ticket moves to In Progress (Flow 1) ==="
curl -s -X POST "${BASE_URL}/webhook/jira" \
  -H "Content-Type: application/json" \
  -d '{
    "webhookEvent": "jira:issue_updated",
    "issue": {
      "key": "KA-1",
      "self": "https://yourworkspace.atlassian.net/rest/api/3/issue/KA-1",
      "fields": {
        "summary": "Login form validation",
        "status": { "name": "In Progress" },
        "project": { "key": "KA" },
        "labels": ["scope:web"],
        "issuetype": { "name": "Story" }
      }
    },
    "changelog": {
      "items": [{ "field": "status", "fromString": "Backlog", "toString": "In Progress" }]
    }
  }' | jq .

echo ""
echo "Expected logs:"
echo "  [INFO] POST /webhook/jira"
echo "  [ROUTE] KA-1 → Flow 1 (In Progress, scope:web, isRework: false)"
echo "  [INFO] [Flow 1] KA-1 triggered — TODO: Phase 3 will generate tests"

echo ""
echo "=== Test 2: GitHub PR review CHANGES_REQUESTED (Review Agent) ==="
curl -s -X POST "${BASE_URL}/webhook/github" \
  -H "Content-Type: application/json" \
  -H "x-github-event: pull_request_review" \
  -d '{
    "action": "submitted",
    "review": {
      "id": 999,
      "state": "CHANGES_REQUESTED",
      "user": { "login": "reviewer-jane" },
      "body": "Test coverage missing for error state"
    },
    "pull_request": {
      "number": 14,
      "draft": false,
      "head": { "ref": "qa/KA-1-login-form-validation" }
    },
    "repository": {
      "name": "klikagent-tests",
      "full_name": "yourorg/klikagent-tests"
    }
  }' | jq .

echo ""
echo "Expected logs:"
echo "  [INFO] POST /webhook/github (pull_request_review)"
echo "  [ROUTE] PR #14 → Review Agent (KA-1, CHANGES_REQUESTED)"
echo "  [REVIEW] KA-1 PR #14 triggered — TODO: Phase 3 will handle rework"

echo ""
echo "=== Test 3: GitHub workflow_run completed (Flow 3) ==="
echo "NOTE: This test will call the GitHub API for run inputs."
echo "      Set GITHUB_TOKEN, GITHUB_OWNER, GITHUB_TEST_REPO in .env first."
curl -s -X POST "${BASE_URL}/webhook/github" \
  -H "Content-Type: application/json" \
  -H "x-github-event: workflow_run" \
  -d '{
    "action": "completed",
    "workflow_run": {
      "id": 9876543,
      "name": "smoke.yml",
      "conclusion": "success",
      "workflow_id": 111
    },
    "repository": {
      "name": "klikagent-tests",
      "full_name": "yourorg/klikagent-tests"
    }
  }' | jq .

echo ""
echo "Expected logs:"
echo "  [INFO] POST /webhook/github (workflow_run)"
echo "  [INFO] Fetching inputs for run 9876543 via GitHub API..."
echo "  [ROUTE] workflow_run → Flow 3 (KA-1, runType: smoke, runId: 9876543)"
echo "  [INFO] [Flow 3] KA-1 triggered — TODO: Phase 3 will post results"
