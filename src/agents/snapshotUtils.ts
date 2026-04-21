import { PageSnapshot } from '../types';

export function serializeSnapshots(snapshots: PageSnapshot[]): string {
  return snapshots.map((s) => `
### Page: ${s.url}
**ARIA Tree:**
${s.ariaTree || '(empty)'}

**Interactable Locators:**
${s.locators.length ? s.locators.map((l) => `- ${l}`).join('\n') : '(none found)'}

**data-testid attributes:**
${s.testIds.length ? s.testIds.map((id) => `- ${id}`).join('\n') : '(none found)'}
`).join('\n---\n');
}
