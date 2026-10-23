import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { projectRoot } from './db.js';

const defaultPolicyFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../ownership-policy.json');
const owner = z.string().trim().min(1).max(128);
const policySchema = z.object({
  defaultOwnership: owner,
  leaseSeconds: z.number().int().min(1).max(3600),
  maxLeaseSeconds: z.number().int().min(1).max(3600),
  approvalSeconds: z.number().int().min(1).max(86400),
  rules: z.array(z.object({ pattern: z.string().min(1), owner })).max(1000)
}).refine(x => x.leaseSeconds <= x.maxLeaseSeconds, 'leaseSeconds must not exceed maxLeaseSeconds');

const invalidComponent = /[<>:"|?*\x00-\x1f]/;
const windowsDevice = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

export function normalizeFilePath(filePath, root = projectRoot()) {
  if (typeof filePath !== 'string' || !filePath.length) throw new Error('File path must be nonempty');
  if (filePath.includes('\0') || path.win32.isAbsolute(filePath) || path.posix.isAbsolute(filePath) || /^[A-Za-z]:/.test(filePath)) {
    throw new Error('File path must be repository-relative');
  }
  const parts = filePath.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || invalidComponent.test(part) ||
    windowsDevice.test(part) || part.endsWith('.') || part.endsWith(' '))) {
    throw new Error('File path contains an invalid or parent-directory component');
  }
  const realRoot = realpathSync(root);
  let current = realRoot;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink()) throw new Error('File path crosses a symlink or junction');
  }
  const relative = parts.join('/');
  return { repository_path: relative, normalized_path: relative.toLowerCase() };
}

function globRegex(glob) {
  let regex = '^';
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === '*') {
      if (glob[i + 1] === '*' && glob[i + 2] === '/') { regex += '(?:.*/)?'; i += 2; }
      else if (glob[i + 1] === '*') { regex += '.*'; i++; }
      else regex += '[^/]*';
    } else regex += '\\^$+?.()|[]{}'.includes(char) ? `\\${char}` : char;
  }
  return new RegExp(`${regex}$`, 'i');
}

export function loadPolicy(file = defaultPolicyFile) {
  const policy = policySchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  for (const rule of policy.rules) {
    const segments = rule.pattern.replaceAll('\\', '/').split('/');
    if (segments.some(x => !x || x === '.' || x === '..' || /[<>:"|?\x00-\x1f]/.test(x) ||
      (x.includes('**') && x !== '**'))) {
      throw new Error(`Invalid ownership policy pattern: ${rule.pattern}`);
    }
  }
  return { ...policy, rules: policy.rules.map(rule => ({ ...rule, regex: globRegex(rule.pattern.replaceAll('\\', '/')) })) };
}

export function policyOwner(policy, normalizedPath) {
  let result = policy.defaultOwnership;
  for (const rule of policy.rules) if (rule.regex.test(normalizedPath)) result = rule.owner;
  return result;
}
