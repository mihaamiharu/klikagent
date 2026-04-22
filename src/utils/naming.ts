const MAX_SLUG_LENGTH = 40;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')   // strip non-alphanumeric except spaces and hyphens
    .trim()
    .replace(/[\s-]+/g, '-')         // collapse spaces/hyphens to single hyphen
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '');             // strip trailing hyphens after slice
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

// login-form-validation.spec.ts
export function toSpecFileName(title: string): string {
  return `${slugify(title)}.spec.ts`;
}
