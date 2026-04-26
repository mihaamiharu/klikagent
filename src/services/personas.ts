import { getFileOnBranch } from './github';
import { log } from '../utils/logger';

export interface Persona {
  email: string;
  password: string;
  [key: string]: string; // Support additional fields like displayName, role, etc.
}

export type PersonaMap = Record<string, Persona>;

// Per-repo cache keyed by repoName
const cache = new Map<string, Record<string, Record<string, string>>>();

async function fetchRawConfig(repoName: string): Promise<Record<string, Record<string, string>>> {
  const cached = cache.get(repoName);
  if (cached) return cached;

  const content = await getFileOnBranch(repoName, 'HEAD', 'config/personas.json');
  if (!content) {
    log('WARN', '[personas] config/personas.json not found in test repo — will retry next call');
    return {};
  }

  let parsed: Record<string, Record<string, string>>;
  try {
    parsed = JSON.parse(content) as Record<string, Record<string, string>>;
  } catch {
    log('WARN', '[personas] config/personas.json is invalid JSON — will retry next call');
    return {};
  }

  if (Object.keys(parsed).length === 0) {
    log('WARN', '[personas] config/personas.json is empty — will retry next call');
    return {};
  }

  cache.set(repoName, parsed);
  return parsed;
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
 * Fetches personas.json from the given repo and resolves ${VAR} placeholders.
 * If roles is empty, returns all personas from config.
 */
export async function getPersonas(repoName: string, roles: string[]): Promise<PersonaMap> {
  const rawConfig = await fetchRawConfig(repoName);
  const resolvedRoles = roles.length > 0 ? roles : Object.keys(rawConfig);

  const result: PersonaMap = {};

  const defaultEmail = process.env.QA_USER_EMAIL;
  const defaultPassword = process.env.QA_USER_PASSWORD;

  for (const role of resolvedRoles) {
    if (!(role in rawConfig)) {
      if (role === 'default' && defaultEmail && defaultPassword) {
        result[role] = { email: defaultEmail, password: defaultPassword };
      } else {
        log('WARN', `[personas] Role "${role}" not found in config/personas.json`);
      }
      continue;
    }
    try {
      result[role] = resolveEnvPlaceholders(rawConfig[role]);
    } catch (err) {
      if (defaultEmail && defaultPassword) {
        result[role] = { email: defaultEmail, password: defaultPassword };
      } else {
        throw err;
      }
    }
    const email = result[role]?.email;
    const password = result[role]?.password;
    if (!email || email.trim() === '' || !password || password.trim() === '') {
      if (defaultEmail && defaultPassword) {
        result[role] = { email: defaultEmail, password: defaultPassword };
      }
    }
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

/** Clears the personas cache for all repos. Useful for testing. */
export function clearPersonasCache(): void {
  cache.clear();
}
