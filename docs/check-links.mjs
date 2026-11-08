// Checks the documentation: every relative link in a Markdown file points at an existing file (and
// heading, for #anchors), and docs/en and docs/ru contain the same guides.
//
//   node docs/check-links.mjs
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', 'generated']);

function markdownFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...markdownFiles(path));
    else if (name.endsWith('.md')) out.push(path);
  }
  return out;
}

// GitHub's heading anchors: lower case, punctuation dropped (letters of any script stay), spaces -> "-".
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

function anchors(file) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  return new Set([...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])));
}

const problems = [];
for (const file of markdownFiles(root)) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|mailto:)/.test(target)) continue;
    const [path, anchor] = target.split('#');
    const dest = path ? resolve(dirname(file), path) : file;
    const where = relative(root, file);
    if (!existsSync(dest)) {
      problems.push(`${where}: missing ${target}`);
      continue;
    }
    if (anchor && dest.endsWith('.md') && !anchors(dest).has(anchor)) problems.push(`${where}: no heading #${anchor} in ${relative(root, dest)}`);
  }
}

const en = readdirSync(join(root, 'docs/en')).sort();
const ru = readdirSync(join(root, 'docs/ru')).sort();
if (en.join() !== ru.join()) problems.push(`docs/en and docs/ru differ: en=[${en.join(', ')}] ru=[${ru.join(', ')}]`);

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`Links OK (${markdownFiles(root).length} Markdown files); docs/en and docs/ru both have ${en.length} guides.`);
