# Implementation Plan — Auth State Isolation + Convention Checker Fixes

## Problem Summary

Task 45 exposed two intertwined issues:

1. **Auth state isolation bug** — `browser_navigate(persona)` only loads auth state on the *first* navigation of a session. Subsequent persona switches are silently ignored, causing the agent to waste ~10 iterations logging in/out manually and burning 504K tokens.

2. **Convention checker false positive loop** — The forbidden-string check flags `asAdmin` fixture references and `/admin` URL paths as "hardcoded persona data", causing 15 correction rounds and producing unreadable test names like `` `BA-2: Redirect from /appointments/book to /${personas.admin.role.toLowerCase()}` ``.

---

## Change 1: Fix auth state isolation in browserTools.ts

### Problem
`handleNavigate` only checks `persona` when `!activeSessions.has(sessionId)`. After the first navigation, the persona parameter is completely ignored.

### Solution
Track the *current persona* per session and auto-switch state when a different persona is requested.

### File: `src/services/browserTools.ts`

**1a. Add a session→persona map** (after line 44):
```typescript
const activeSessions = new Set<string>();
const sessionPersona = new Map<string, string>();  // sessionId → currentPersona
```

**1b. Modify `handleNavigate`** (lines 113-135) to check persona on every call:
```typescript
try {
  if (!activeSessions.has(sessionId)) {
    await cli('install');
    log('INFO', `[BrowserTools] Opening new browser session: ${sessionId}`);
    const openResult = await cli('open');
    if (openResult.includes('Error:') || openResult.includes('is not found')) {
      return JSON.stringify({ error: 'BROWSER_ERROR', message: `Failed to open browser session: ${openResult}` });
    }
    activeSessions.add(sessionId);
  }

  // Persona switch: load state if different from current session persona
  if (persona) {
    const currentStateFile = authStatePath(persona, baseUrl);
    const currentPersona = sessionPersona.get(sessionId);
    if (persona !== currentPersona && fs.existsSync(currentStateFile)) {
      log('INFO', `[BrowserTools] Switching persona from "${currentPersona ?? 'none'}" to "${persona}" — loading auth state`);
      await cli('state-load', currentStateFile);
      sessionPersona.set(sessionId, persona);
    } else if (persona !== currentPersona && !fs.existsSync(currentStateFile)) {
      log('INFO', `[BrowserTools] No saved auth state for "${persona}" — agent will log in manually`);
      sessionPersona.set(sessionId, persona);
    }
  }

  log('INFO', `[BrowserTools] Navigating to ${url}`);
  const out = await cli('goto', url);
  return await buildResponse(out);
}
```

**1c. Reset persona on session close** (in `handleClose`, after line 244):
```typescript
activeSessions.delete(sessionId);
sessionPersona.delete(sessionId);
```

**1d. Update tool description** (line 257-278) to clarify persona switching works mid-session:
```
Pass "persona" (e.g. "patient", "doctor", "admin") to load saved auth state.
If a different persona is requested mid-session, the browser state will be switched automatically.
```

### Expected impact
- Agent no longer needs manual logout/login cycles when switching personas
- Exploration of multi-persona flows (patient → admin) takes ~2 navigations instead of ~10
- Estimated token savings: 60-70% on multi-persona tasks

---

## Change 2: Fix convention checker false positives

### Problem
The `checkSpecConventions` function in `selfCorrection.ts` strips test descriptions and route paths, but the forbidden-string check still fires on:
- Fixture parameter names (`asAdmin`, `asPatient`) — these are *convention-compliant* by design
- URL regex patterns (`/\/admin/`) — these are route paths, not persona data
- The `personas.` lookbehind `(?<!personas\.)` doesn't account for fixture names

### Solution
Expand the content-stripping logic to also remove fixture parameter names and URL regex patterns before checking for forbidden strings.

### File: `src/services/selfCorrection.ts`

**2a. Add `stripFixtureParameters` function** (after `stripRoutePaths`, ~line 60):
```typescript
/**
 * Strip fixture parameter names from spec content before convention checks.
 * Fixture names like `asPatient`, `asAdmin`, `asDoctor` are convention-compliant
 * and should not trigger persona-data violations.
 */
function stripFixtureParameters(content: string): string {
  return content
    // Strip { asPatient }, { asAdmin }, { asDoctor } from test destructuring
    .replace(/\b(?:asPatient|asDoctor|asAdmin|as\w+)\b/g, 'FIXTURE_PARAM')
    // Strip fixture names in goto calls: asPatient.goto(...)
    .replace(/\bFIXTURE_PARAM\.goto\b/g, 'fixture.goto');
}
```

**2b. Add `stripUrlRegexPatterns` function** (after the above):
```typescript
/**
 * Strip URL regex patterns from spec content before convention checks.
 * Patterns like /\/admin/, /\/dashboard/ contain role names as URL segments
 * and should not trigger persona-data violations.
 */
function stripUrlRegexPatterns(content: string): string {
  return content
    // Strip regex URL patterns: /\/admin/, /\/appointments\/book/, etc.
    .replace(/\/\\\/\w+[^/]*\//g, '/STRIPPED_URL_REGEX/')
    // Strip string URL paths in toHaveURL assertions
    .replace(/toHaveURL\s*\(\s*['"`][^'"`]*['"`]\s*\)/g, 'toHaveURL("STRIPPED")');
}
```

**2c. Update `checkSpecConventions`** (line 69) to apply all stripping:
```typescript
const checkableContent = stripUrlRegexPatterns(
  stripRoutePaths(
    stripTestDescriptions(
      stripFixtureParameters(specContent)
    )
  )
);
```

### Expected impact
- No more false positives on `asAdmin` fixture names or `/\/admin/` URL checks
- Convention checker stops the 15-round correction loop
- Agent produces clean, readable test names

---

## Change 3: Update SPEC_RULES prompt for clarity

### Problem
The spec rules say "NEVER hardcode persona display names" but don't clarify that test *names* (descriptions) are exempt — only assertions and locators need dynamic data.

### File: `src/agents/prompts/sections.ts`

**3a. Update SPEC_RULES** (line 181-183) to clarify scope:
```
- NEVER hardcode persona display names (e.g. "Jane Doe", "Jane") or roles in LOCATORS or ASSERTIONS.
  Test descriptions (the first argument to test()) should be static, human-readable strings.
  Use properties from the imported `personas` object for dynamic UI text matching:
  BAD:  this.userName = page.getByText('Jane Doe');
  GOOD: async expectUserProfile(name: string, role: string) { await expect(this.page.getByRole('complementary').getByText(name)).toBeVisible(); }
```

**3b. Add explicit guidance on `personas` usage** (after line 171):
```
- The `personas` object is for: login credentials, display names in assertions, role-based UI text
- The `personas` object is NOT for: test names, fixture parameters, URL paths
```

---

## Change 4: Add state-load error verification

### Problem
`handleNavigate` doesn't check if `state-load` succeeded. A failed state-load is silently ignored.

### File: `src/services/browserTools.ts`

**4a. Check state-load result** (in the persona-switch block):
```typescript
if (persona !== currentPersona && fs.existsSync(currentStateFile)) {
  log('INFO', `[BrowserTools] Switching persona from "${currentPersona ?? 'none'}" to "${persona}" — loading auth state`);
  const loadResult = await cli('state-load', currentStateFile);
  if (loadResult.includes('Error') || loadResult.includes('ENOENT')) {
    log('WARN', `[BrowserTools] Failed to load auth state for "${persona}": ${loadResult}`);
  }
  sessionPersona.set(sessionId, persona);
}
```

---

## Change 5: Update BROWSER_TOOLS prompt for persona switching

### Problem
The explorer prompt doesn't mention that persona switching works mid-session. The agent currently thinks it needs to manually log out/in.

### File: `src/agents/prompts/sections.ts`

**5a. Update BROWSER_TOOLS** (line 75-85) to document persona switching:
```
## Auth state reuse and persona switching
Pass the persona name to browser_navigate — saved auth state is loaded automatically:
  browser_navigate(url, persona="patient")   ← pre-authenticated if state file exists
  browser_navigate(url, persona="admin")     ← automatically switches to admin auth state

The browser automatically switches auth state when you change persona between navigate calls.
No manual logout/login is needed — just call browser_navigate with the new persona.

After a successful manual login, always save state so future tasks skip login:
  browser_command(["state-save", ".playwright-auth/{persona}.json"])
```

---

## Testing Plan

### Unit tests
1. Test `handleNavigate` with persona switching:
   - First call with `persona="patient"` → loads patient state
   - Second call with `persona="admin"` → switches to admin state
   - Third call with `persona="patient"` → switches back to patient state
   - Verify `sessionPersona` map is updated correctly

2. Test `stripFixtureParameters`:
   - Input: `async ({ asAdmin }) => { await asAdmin.goto('/admin'); }`
   - Output: `async ({ FIXTURE_PARAM }) => { await fixture.goto('/admin'); }`

3. Test `stripUrlRegexPatterns`:
   - Input: `await expect(page).toHaveURL(/\/admin/);`
   - Output: `await expect(page).toHaveURL("STRIPPED");`

4. Test `checkSpecConventions` with the new stripping:
   - Spec with `asAdmin` fixture + `/\/admin/` URL check → no violations
   - Spec with `getByText('Jane Doe')` → violation (correct)
   - Spec with `personas.admin.displayName` in assertion → no violation (correct)

### Integration tests
1. Run task 45 again (or similar multi-persona task) and verify:
   - Exploration completes in <5 iterations (was 30+)
   - Token usage <100K (was 504K)
   - No convention correction loops
   - Generated spec has readable test names

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `state-load` fails silently for corrupt state files | Medium | Medium | Change 4 adds error logging |
| New stripping functions over-strip legitimate content | Low | Low | Stripping targets specific patterns (fixture names, URL regexes) |
| Persona switching breaks existing single-persona tasks | None | None | Only activates when persona changes |
| `sessionPersona` map leaks memory | Low | Low | Cleaned up in `handleClose`; sessions are per-run |

---

## Files Changed

| File | Changes |
|---|---|
| `src/services/browserTools.ts` | Auth state isolation (Changes 1, 4) |
| `src/services/selfCorrection.ts` | Convention checker fixes (Change 2) |
| `src/agents/prompts/sections.ts` | Prompt updates (Changes 3, 5) |

Total: **3 files**, ~80 lines of changes.
