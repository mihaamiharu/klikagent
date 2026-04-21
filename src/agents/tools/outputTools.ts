/**
 * outputTools.ts — Utility functions for extracting structured output from agent-generated content.
 */

/**
 * Derives the expected POM file path from the exported class name in the POM content.
 * Falls back to a sensible default if no exported class is found.
 *
 * Example: if pomContent contains `export class DoctorProfilePage`, returns
 * `pages/doctors/DoctorProfilePage.ts`
 */
export function pomPathFromContent(pomContent: string, feature: string): string {
  const match = pomContent.match(/export\s+class\s+(\w+)/);
  const className = match?.[1] ?? `${feature.charAt(0).toUpperCase()}${feature.slice(1)}Page`;
  return `pages/${feature}/${className}.ts`;
}
