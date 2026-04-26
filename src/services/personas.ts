import { getFileOnBranch } from './github';
import { log } from '../utils/logger';

export interface Persona {
  email: string;
  password: string;
  [key: string]: string;
}

export type PersonaMap = Record<string, Persona>;

export async function getPersonas(repoName: string, roles: string[]): Promise<PersonaMap> {
  const content = await getFileOnBranch(repoName, 'HEAD', 'config/personas.ts');
  if (!content) {
    log('WARN', '[personas] config/personas.ts not found in test repo');
    return {};
  }

  const map = parsePersonasTs(content);
  if (Object.keys(map).length === 0) {
    log('WARN', '[personas] config/personas.ts is empty or invalid');
    return {};
  }

  if (roles.length === 0) return map;

  const result: PersonaMap = {};
  for (const role of roles) {
    if (role in map) {
      result[role] = map[role];
    } else {
      log('WARN', `[personas] Role "${role}" not found in config/personas.ts`);
    }
  }
  return result;
}

function parsePersonasTs(content: string): PersonaMap {
  const map: PersonaMap = {};
  const entryPattern = /(\w+):\s*\{([^}]+)\}/g;
  let match: RegExpExecArray | null;

  while ((match = entryPattern.exec(content)) !== null) {
    const [, key, block] = match;
    const persona: Record<string, string> = {};
    const fieldPattern = /(\w+):\s*'([^']*)'/g;
    let fieldMatch: RegExpExecArray | null;

    while ((fieldMatch = fieldPattern.exec(block)) !== null) {
      const [, field, value] = fieldMatch;
      persona[field] = value;
    }

    if (persona.email && persona.password) {
      map[key] = persona as Persona;
    }
  }

  return map;
}

export function parsePersonasFromIssue(issueBody: string): string[] {
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

export function clearPersonasCache(): void {
  // No-op: cache removed
}