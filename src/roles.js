import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The preset builders. A role is a charter plus a queue filter: an agent says
 * "I am the backend builder", gets told what that means, and claim_next() only
 * ever hands it backend work whose blockers are cleared.
 *
 * Two groups matter and they behave differently:
 *   refine stage — argue about the idea, do not write code
 *   build stage  — implement against a frozen spec, do not reopen the design
 * Keeping them apart is the point. It is what stops a builder from redesigning
 * mid-implementation and a refiner from shipping half a feature.
 */

/**
 * Applied to every role, appended to its own charter. These are the rules that
 * make the room converge instead of either deadlocking or rubber-stamping
 * whoever posted first.
 */
/**
 * The roles and the house rules live in roles/builtin.json, not here.
 *
 * Two runtimes read them now, and a charter spelled out in both is a charter
 * that drifts: one room's architect is told something the other's is not, and
 * nothing anywhere says which is right.
 */
const ROLES_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'roles', 'builtin.json');
const SHIPPED = JSON.parse(readFileSync(ROLES_FILE, 'utf8'));

export const HOUSE_RULES = SHIPPED.houseRules;
export const BUILTIN_ROLES = SHIPPED.roles;

/**
 * Project-local overrides. Drop an esprits.roles.json next to the database to
 * define your own builders, or to replace a charter without forking the repo.
 * Shallow-merged per role so you can override just the summary or just the
 * charter and keep the rest of the preset.
 */
export function loadRoles(file) {
  const path = resolve(file || process.env.ESPRITS_ROLES || './esprits.roles.json');
  const roles = structuredClone(BUILTIN_ROLES);
  if (!existsSync(path)) return roles;

  let custom;
  try {
    custom = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    // A broken override file must not take the connector down with it —
    // every agent would lose the room over a stray comma.
    process.emitWarning(`esprits: ignoring unreadable roles file ${path}: ${err.message}`);
    return roles;
  }

  for (const [name, def] of Object.entries(custom.roles ?? custom)) {
    if (!def || typeof def !== 'object') continue;
    const charter = Array.isArray(def.charter) ? def.charter.join('\n') : def.charter;
    roles[name] = { ...(roles[name] ?? { stage: 'any', summary: '' }), ...def, charter };
  }
  return roles;
}

export function describeRole(roles, name) {
  const role = roles[name] ?? { stage: 'any', summary: 'Undeclared role.', charter: '' };
  return {
    name,
    ...role,
    // The role charter says what this agent is for; the house rules say how
    // everyone is expected to work together. Agents get both or neither.
    houseRules: HOUSE_RULES,
  };
}
