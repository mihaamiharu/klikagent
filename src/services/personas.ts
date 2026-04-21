import { getFileOnBranch, ownerName, testRepoName } from './github';
import { log } from '../utils/logger';

export interface Persona {
  email: string;
  password: string;
}

export type PersonaMap = Record<string, Persona>;

// Process-lifetime cache for the raw personas config
let cachedRawConfig: Record<string, Record<string, string>> | null = null;

async function fetchRawConfig(): Promise<Record<string, Record<string, string>>> {
  if (cachedRawConfig) return cachedRawConfig;

  const content = await getFileOnBranch(testRepoName(), 'HEAD', 'config/personas.json');
  if (!content) {
    log('WARN', '[personas] config/personas.json not found in test repo — returning empty config');
    cachedRawConfig = {};
    return cachedRawConfig;
  }

  try {
    cachedRawConfig = JSON.parse(content) as Record<string, Record<string, string>>;
    return cachedRawConfig;
  } catch {
    log('WARN', '[personas] config/personas.json is invalid JSON — returning empty config');
    cachedRawConfig = {};
    return cachedRawConfig;
  }
}

function resolveEnvPlaceholders(raw: Record<string, string>): Persona {
  const resolved: Record<string, string> = {};

  for (const [key, value] of Object.entries(raw)) {
    resolved[key] = value.replace(/\$\{([^}]+)\}/g, (_, varName: string) => {
      const envValue = process.env[varName];
      if (envValue === undefined) {
        throw new Error(`[personas] Missing required env var: ${varName}`);
      }
      return envValue;
    });
  }

  return resolved as unknown as Persona;
}

/**
 * Fetches personas.json from klikagent-tests repo and resolves ${VAR} placeholders.
 * If roles is empty, returns all personas from config.
 */
export async function getPersonas(roles: string[]): Promise<PersonaMap> {
  const rawConfig = await fetchRawConfig();
  const resolvedRoles = roles.length > 0 ? roles : Object.keys(rawConfig);

  const result: PersonaMap = {};

  for (const role of resolvedRoles) {
    if (!(role in rawConfig)) {
      log('WARN', `[personas] Role "${role}" not found in config/personas.json`);
      continue;
    }
    result[role] = resolveEnvPlaceholders(rawConfig[role]);
  }

  return result;
}

/**
 * Parses the ## Personas section from a GitHub issue body.
 * Returns array of role names e.g. ['patient', 'doctor'].
 * If the ## Personas section is missing, returns [] (caller should fall back to all personas).
 */
export function parsePersonasFromIssue(issueBody: string): string[] {
  // Match the ## Personas section up to the next ## heading or end of string
  const sectionMatch = issueBody.match(/^##\s+Personas\s*\n([\s\S]*?)(?=^##\s|\s*$)/m);
  if (!sectionMatch) return [];

  const sectionContent = sectionMatch[1];
  const roles: string[] = [];

  for (const line of sectionContent.split('\n')) {
    const bulletMatch = line.match(/^[-*]\s+(.+)/);
    if (bulletMatch) {
      const role = bulletMatch[1].trim();
      if (role) roles.push(role);
    }
  }

  return roles;
}

/** Clears the process-lifetime personas cache. Useful for testing. */
export function clearPersonasCache(): void {
  cachedRawConfig = null;
}
