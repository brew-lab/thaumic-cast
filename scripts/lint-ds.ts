/**
 * `bun run lint:ds`: the design-system rules (packages/ui/DESIGN.md §10, rows 1 to 5) as a
 * report.
 *
 * Rows 1 to 3 are stylelint (stylelint.ds.config.js), row 4 is eslint (eslint.ds.config.js),
 * and row 5 is scripts/check-ds.ts. Today's apps break these rules in many places that the
 * later phases rebuild, so this prints the counts per rule and exits 0; `bun run lint` stays
 * clean, as the project's "fix warnings before committing" rule requires. It exits 1 only
 * when a file that is already built from the design system breaks a rule. Phase 5 moves every
 * rule into `bun run lint` as an error. Pass --verbose to list every finding.
 */
import { ESLint } from 'eslint';
import stylelint from 'stylelint';
import { join, relative } from 'node:path';
import { CLEAN_PATHS, checkDesignSystem, inCleanPaths, printFindings } from './check-ds';

const ROOT = join(import.meta.dir, '..');
const verbose = process.argv.includes('--verbose');

interface Hit {
  rule: string;
  file: string;
  line: number;
  text: string;
}

const isClean = (file: string): boolean => CLEAN_PATHS.some((re) => re.test(file));

const report = (title: string, hits: Hit[]): void => {
  const byRule = new Map<string, Hit[]>();
  for (const h of hits) byRule.set(h.rule, [...(byRule.get(h.rule) ?? []), h]);
  process.stdout.write(`\n${title}\n`);
  if (!hits.length) process.stdout.write('  no findings\n');
  for (const [rule, list] of [...byRule].sort()) {
    process.stdout.write(`  ${rule}: ${list.length}\n`);
    if (verbose) for (const h of list) process.stdout.write(`    ${h.file}:${h.line} ${h.text}\n`);
  }
};

// Rows 1 to 3: stylelint with the design-system overrides.
const styl = await stylelint.lint({
  files: ['**/*.css'],
  cwd: ROOT,
  configFile: join(ROOT, 'stylelint.ds.config.js'),
});
const cssHits: Hit[] = styl.results.flatMap((r) =>
  r.warnings.map((w) => ({
    rule: w.rule,
    file: relative(ROOT, r.source ?? ''),
    line: w.line,
    text: w.text,
  })),
);

// Row 4: eslint with the design-system rules, over the apps' components.
const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: join(ROOT, 'eslint.ds.config.js') });
const esResults = await eslint.lintFiles(['apps/*/src/**/*.tsx']);
const DS_ESLINT = new Set(['no-restricted-imports', 'no-restricted-syntax']);
const tsxHits: Hit[] = esResults.flatMap((r) =>
  r.messages
    .filter((m) => m.ruleId && DS_ESLINT.has(m.ruleId))
    .map((m) => ({
      rule: m.ruleId === 'no-restricted-imports' ? 'no-restricted-imports' : m.message,
      file: relative(ROOT, r.filePath),
      line: m.line,
      text: m.message,
    })),
);

// Row 5: the token graph.
const findings = await checkDesignSystem();

process.stdout.write('Design-system lint report (DESIGN.md §10). Phase 5 makes these errors.\n');
report('stylelint (rows 1 to 3)', cssHits);
report('eslint (row 4)', tsxHits);
printFindings(findings, verbose);

const regressions = [
  ...[...cssHits, ...tsxHits]
    .filter((h) => isClean(h.file))
    .map((h) => `${h.file}:${h.line} ${h.text}`),
  ...inCleanPaths(findings).map((f) => `${f.file}: ${f.message}`),
];
if (regressions.length) {
  process.stderr.write('\nFiles already built from the design system break its rules:\n');
  for (const r of regressions) process.stderr.write(`  ${r}\n`);
  process.exit(1);
}
process.stdout.write(
  '\nReport only: exit 0. Files already built from the design system are clean.\n',
);
