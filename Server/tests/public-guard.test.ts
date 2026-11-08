import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The public edition must not carry anything of the installation it came from: its domains, its
 * people, its addresses, the integrations of that edition, or the Discord sound set. This walks the
 * whole repository (all three apps, the deploy kit, the voice node kit and the docs).
 */
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'generated', '.git', 'coverage', 'storage', 'release', 'backups', '.cache', 'win-unpacked']);
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|sh|css|html|conf|example|toml|sql|txt|py|env)$|^\.env\.example$|^Dockerfile$/;
const THIS_FILE = path.join('Server', 'tests', 'public-guard.test.ts');

// Built from pieces so that this file itself does not match.
const FORBIDDEN: { name: string; re: RegExp }[] = [
  { name: 'their domain', re: new RegExp(['frie', 'comp'].join(''), 'i') },
  { name: 'their app domain', re: new RegExp(['dis', 'cro'].join(''), 'i') },
  { name: 'their account', re: new RegExp(['vol', '4onok'].join(''), 'i') },
  { name: 'their server user', re: new RegExp(['vol', 'chonok'].join(''), 'i') },
  { name: 'their install path', re: new RegExp(['/srv', '/aidis'].join('')) },
  { name: 'their old app id', re: new RegExp(['ru', 'friecomp'.slice(0, 0), '.frie'].join('')) },
  { name: 'the Discord sound set', re: /sounds\/classic|soundPack\b/ },
];

/** Public addresses that tests use on purpose: example.com and the first address after 172.16.0.0/12. */
const ALLOWED_IPS = new Set(['93.184.216.34', '172.32.0.1']);

/** IPv4 literals that are not loopback, unspecified, private or reserved for documentation. */
function publicIps(text: string): string[] {
  const found = text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? [];
  return found.filter((ip) => {
    const p = ip.split('.').map(Number);
    if (p.some((n) => n > 255) || ALLOWED_IPS.has(ip)) return false;
    const [a = 0, b = 0, c = 0] = p;
    if (a === 127 || a === 0 || a === 10 || a === 255) return false;
    if (a === 192 && b === 168) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if ((a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false;
    // Other reserved ranges (SSRF filters list them): 192.0.0.0/24, 192.88.99.0/24, 198.18.0.0/15, multicast and above.
    if ((a === 192 && b === 0 && c === 0) || (a === 192 && b === 88 && c === 99) || (a === 198 && (b === 18 || b === 19)) || a >= 224) return false;
    // Version-like numbers such as 1.2.3.4 in lock files are not addresses we care about.
    if (a < 10) return false;
    return true;
  });
}

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(path.join(dir, entry.name), out);
    } else if (TEXT.test(entry.name) && entry.name !== 'package-lock.json') {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe('public edition: nothing of the original installation', () => {
  it('no domains, people, paths, integrations or Discord sounds anywhere in the repository', async () => {
    const problems: string[] = [];
    for (const file of await walk(ROOT)) {
      const rel = path.relative(ROOT, file);
      if (rel === THIS_FILE) continue;
      if ((await stat(file)).size > 2_000_000) continue;
      const text = await readFile(file, 'utf8');
      for (const { name, re } of FORBIDDEN) if (re.test(text)) problems.push(`${rel}: ${name}`);
      for (const ip of publicIps(text)) problems.push(`${rel}: public IP ${ip}`);
    }
    expect(problems).toEqual([]);
  });

  it('the Discord sound files are gone', async () => {
    const sounds = await readdir(path.join(ROOT, 'Client', 'src', 'assets', 'sounds'));
    expect(sounds).not.toContain('classic');
  });
});
