/**
 * personaUtils.ts — Shared persona credential utilities.
 *
 * Exported from both browserTools.ts (old) and browserToolsCli.ts (new)
 * so both can use the same credential resolution without circular deps.
 */

export interface Persona {
  name: string;
  email: string;
  password: string;
}

/**
 * Returns available test personas from environment variables.
 * Persona env vars follow the pattern:
 *   PERSONA_<NAME>_EMAIL=<email>
 *   PERSONA_<NAME>_PASSWORD=<password>
 *
 * A default "default" persona is always included using QA_USER_EMAIL /
 * QA_USER_PASSWORD for backward compatibility.
 */
export function getPersonas(): Persona[] {
  const personas: Persona[] = [];

  const defaultEmail = process.env.QA_USER_EMAIL;
  const defaultPassword = process.env.QA_USER_PASSWORD;
  if (defaultEmail && defaultPassword) {
    personas.push({ name: 'default', email: defaultEmail, password: defaultPassword });
  }

  for (const [key, value] of Object.entries(process.env)) {
    const match = key.match(/^PERSONA_(.+)_EMAIL$/);
    if (!match || !value) continue;
    const name = match[1].toLowerCase();
    const password = process.env[`PERSONA_${match[1]}_PASSWORD`];
    if (!password) continue;
    if (name === 'default' && value === defaultEmail) continue;
    personas.push({ name, email: value, password });
  }

  return personas;
}
