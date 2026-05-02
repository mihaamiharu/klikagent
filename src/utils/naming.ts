const MAX_SLUG_LENGTH = 40;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/[\s-]+/g, '-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');
}

// qa/42-short-summary
export function toBranchSlug(ticketId: string, summary: string): string {
  const slug = slugify(summary);
  return `qa/${ticketId}-${slug}`;
}

// qa/42-rework-1
export function toReworkBranch(parentId: string, round: number): string {
  return `qa/${parentId}-rework-${round}`;
}

// [KlikAgent] 42: Short summary
export function toPRTitle(ticketId: string, summary: string): string {
  return `[KlikAgent] ${ticketId}: ${summary}`;
}

// book-appointment.spec.ts — named after the feature folder
export function toSpecFileName(feature: string): string {
  return `${slugify(feature)}.spec.ts`;
}
