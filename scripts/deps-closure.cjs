// Runtime import closure of an entry file (type-only imports skipped): node scripts/deps-closure.cjs src/forex-main.ts
// Used by tests/deploy-split.test.ts to keep scripts/forex-paths.txt honest.
const fs = require('fs');
const path = require('path');
function closure(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(f, 'utf8');
    const re = /^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?['"](\.[^'"]+)['"]/gm;
    for (const m of src.matchAll(re)) {
      if (m[2]) continue; // `import type` / `export type` vanish at runtime
      const base = path.join(path.dirname(f), m[3]);
      for (const c of [base + '.ts', path.join(base, 'index.ts'), base]) {
        if (fs.existsSync(c) && fs.statSync(c).isFile()) {
          stack.push(c);
          break;
        }
      }
    }
  }
  return [...seen].map((f) => f.split(path.sep).join('/')).sort();
}
module.exports = { closure };
if (require.main === module) console.log(closure(process.argv[2]).join('\n'));
