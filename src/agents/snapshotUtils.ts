import { PageSnapshot } from '../types';

export function serializeSnapshots(snapshots: PageSnapshot[]): string {
  return snapshots.map((s) => `
### Page: ${s.url}
**ARIA Tree:**
${s.ariaTree || '(empty)'}

**Interactable Elements:**
${s.interactables.length ? s.interactables.map((el) => `- [${el.role}] ${el.label} → ${el.selector}`).join('\n') : '(none found)'}
`).join('\n---\n');
}
