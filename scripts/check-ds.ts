/**
 * The design-system token graph check (packages/ui/DESIGN.md §10, row 5):
 * - every `var(--x)` resolves to a token in tokens.css, a registered property, a component
 *   block in packages/ui, or a custom property an element sets inline;
 * - every `--{component}-*` token a packages/ui module defines maps to another token;
 * - tokens defined in tokens.css and used nowhere are listed;
 * - glyphs.ts holds exactly the F-icons list in DESIGN.md;
 * - every packages/ui CSS module is one `@layer components` block;
 * - `@container` queries in packages/ui use only the F-grid breakpoints (20, 25, 45rem).
 *
 * Usage: `bun scripts/check-ds.ts` (also run by `bun run lint:ds`). It prints a report and
 * exits 0, except when a file that is already built from the design system (CLEAN_PATHS)
 * breaks a rule. Phase 5 makes every finding an error.
 */
import { Glob } from 'bun';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { GLYPH_NAMES } from '../packages/ui/src/Icon/glyphs';
import { CONTAINER_BREAKPOINTS_REM, TOKEN_NAMES } from '../packages/ui/src/tokens';

const ROOT = join(import.meta.dir, '..');

/** Files already built from the design system: a finding here fails the check. */
export const CLEAN_PATHS = [
  /^packages\/ui\/src\/(layers|tokens|webkit-fallbacks|base|motion|utilities|fonts)\.css$/,
  /^packages\/ui\/src\/(tokens|theme)\.ts$/,
  /^packages\/ui\/src\/(Announcer|Cluster|Icon)\//,
  // Phase 1: the atoms.
  /^packages\/ui\/src\/(Artwork|Badge|BrandBlock|Button|Checkbox|Chip|Clacks|Divider|IconButton|Meter|NavItem|Radio|SectionHeader|SegmentedControl|Select|Slider|StatusDot|StepIndicator|Switch|TextInput|Tooltip|utils)\//,
  // Phase 2: the molecules and Card.
  /^packages\/ui\/src\/(AddressField|Card|ChoiceGroup|CopyField|DescriptionList|Disclosure|EmptyState|Field|Notice|NoticeLine|PageHeader|SettingsRow|Toast|WizardStep)\//,
  // Phase 1: every app file, except the layouts Phases 3 and 4 rebuild wholesale (the cast
  // card and its list, the app shells and the onboarding frames).
  /^apps\/(?!desktop\/src\/App\.(css|module\.css)$)(?!desktop\/src\/views\/Onboarding\.module\.css$)(?!extension\/src\/popup\/components\/(ActiveCastCard\.(tsx|module\.css)|ActiveCastsList\.module\.css|Onboarding\.module\.css)$)[^/]+\/src\/.*\.(tsx|css)$/,
];

/** One finding: the check it breaks, where, and what. */
export interface Finding {
  /** The check, e.g. "undefined-var". */
  rule: string;
  /** The file, relative to the repo root. */
  file: string;
  /** What is wrong. */
  message: string;
}

/**
 * Lists files matching a glob, relative to the repo root.
 * @param pattern - The glob
 * @returns The matching paths
 */
async function files(pattern: string): Promise<string[]> {
  const out: string[] = [];
  for await (const f of new Glob(pattern).scan({ cwd: ROOT })) {
    if (!/(^|\/)(node_modules|dist|test-results)\//.test(f)) out.push(f);
  }
  return out.sort();
}

const read = (f: string): Promise<string> => readFile(join(ROOT, f), 'utf8');
const stripComments = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Checks that a module's top level is exactly one `@layer components { … }` block.
 * @param css - The module's source
 * @returns True when it is
 */
function isOneComponentsLayer(css: string): boolean {
  const src = stripComments(css).trim();
  const open = /^@layer\s+components\s*\{/.exec(src);
  if (!open) return false;
  let depth = 0;
  for (let i = open[0].length - 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1);
      i = end < 0 ? src.length : end;
    } else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return i === src.length - 1;
  }
  return false;
}

/**
 * Runs every row-5 check.
 * @returns The findings
 */
export async function checkDesignSystem(): Promise<Finding[]> {
  const findings: Finding[] = [];
  const add = (rule: string, file: string, message: string): void => {
    findings.push({ rule, file, message });
  };

  const uiCss = await files('packages/ui/src/**/*.css');
  const uiModules = uiCss.filter((f) => f.endsWith('.module.css'));
  const appCss = await files('apps/*/src/**/*.css');
  const tsx = [
    ...(await files('apps/*/src/**/*.tsx')),
    ...(await files('packages/ui/src/**/*.tsx')),
  ];
  const tokens = new Set<string>(TOKEN_NAMES);

  // Every definition: tokens.css, @property, any `--x:` in packages/ui CSS (component blocks
  // and the legacy theme.css), app CSS, and custom properties set inline from TSX.
  const defined = new Set<string>(tokens);
  const legacy = new Set<string>();
  const defs = (css: string): string[] =>
    [...stripComments(css).matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)].map((m) => m[1]);
  for (const f of [...uiCss, ...appCss]) {
    const css = await read(f);
    for (const name of defs(css)) {
      defined.add(name);
      if (f === 'packages/ui/src/theme.css') legacy.add(name);
    }
    for (const m of css.matchAll(/@property\s+(--[\w-]+)/g)) defined.add(m[1]);
  }
  for (const f of tsx) {
    for (const m of (await read(f)).matchAll(/['"](--[\w-]+)['"]\s*:/g)) defined.add(m[1]);
  }

  // Every use.
  const used = new Map<string, Set<string>>();
  for (const f of [...uiCss, ...appCss, ...tsx]) {
    const src = await read(f);
    for (const m of src.matchAll(/var\(\s*(--[\w-]+)\s*(,)?/g)) {
      const [, name, hasFallback] = m;
      if (!used.has(name)) used.set(name, new Set());
      used.get(name)!.add(f);
      if (!defined.has(name) && !hasFallback)
        add('undefined-var', f, `var(${name}) is not defined`);
    }
  }
  for (const [name, where] of used) {
    if (legacy.has(name) && !tokens.has(name)) {
      for (const f of where) {
        if (f !== 'packages/ui/src/theme.css')
          add('legacy-token', f, `${name} is a theme.css token`);
      }
    }
  }

  // Component tokens must map to a token (a keyword such as flex-start is not a design value).
  for (const f of uiModules) {
    const css = stripComments(await read(f));
    for (const m of css.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:\s*([^;]+);/g)) {
      const [, name, value] = m;
      if (!/var\(--[\w-]+/.test(value) && !/^[a-z-]+$/.test(value.trim())) {
        add('component-token-raw', f, `${name}: ${value.trim()} does not map to a token`);
      }
    }
  }

  // Tokens nobody reads yet (the catalogue does not count).
  const unused = TOKEN_NAMES.filter(
    (t) => !used.has(t) && !t.match(/^--(purple|neutral|red|magenta)-/),
  );
  for (const t of unused) add('unused-token', 'packages/ui/src/tokens.css', `${t} is not used yet`);

  // The glyph inventory.
  const design = await read('packages/ui/DESIGN.md');
  const row = /\|\s*F-icons\s*\|[^|]*\|\s*33 glyphs plus the mark: ([^.]+)\./.exec(design);
  const listed = row ? row[1].split(',').map((s) => s.trim()) : [];
  const glyphs: string[] = GLYPH_NAMES;
  for (const g of listed.filter((n) => !glyphs.includes(n))) {
    add('glyphs', 'packages/ui/src/Icon/glyphs.ts', `${g} is in F-icons but not in glyphs.ts`);
  }
  for (const g of glyphs.filter((n) => !listed.includes(n))) {
    add('glyphs', 'packages/ui/src/Icon/glyphs.ts', `${g} is in glyphs.ts but not in F-icons`);
  }

  // Layers and container breakpoints.
  const allowed = CONTAINER_BREAKPOINTS_REM.map((n) => `${n}rem`);
  for (const f of uiModules) {
    const css = await read(f);
    if (!isOneComponentsLayer(css)) add('layer', f, 'is not one @layer components block');
    for (const m of stripComments(css).matchAll(/@container[^{]*\{/g)) {
      for (const len of m[0].matchAll(/[\d.]+[a-z]+/g)) {
        if (!allowed.includes(len[0]))
          add('container-literal', f, `${len[0]} is not 20, 25 or 45rem`);
      }
    }
  }
  return findings;
}

/**
 * Prints findings grouped by rule, with counts.
 * @param findings - The findings
 * @param verbose - Print every finding, not only the counts
 */
export function printFindings(findings: Finding[], verbose: boolean): void {
  const byRule = new Map<string, Finding[]>();
  for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  process.stdout.write('\ncheck-ds (row 5, the token graph)\n');
  if (!findings.length) process.stdout.write('  no findings\n');
  for (const [rule, list] of [...byRule].sort()) {
    process.stdout.write(`  ${rule}: ${list.length}\n`);
    if (verbose) for (const f of list) process.stdout.write(`    ${f.file}: ${f.message}\n`);
  }
}

/**
 * The findings in files that are already built from the design system.
 * @param findings - All findings
 * @returns Those in CLEAN_PATHS
 */
export function inCleanPaths(findings: Finding[]): Finding[] {
  return findings.filter(
    (f) => f.rule !== 'unused-token' && CLEAN_PATHS.some((re) => re.test(relative('.', f.file))),
  );
}

if (import.meta.main) {
  const findings = await checkDesignSystem();
  printFindings(findings, process.argv.includes('--verbose'));
  const clean = inCleanPaths(findings);
  if (clean.length) {
    process.stderr.write('\nDesign-system files break the rules:\n');
    for (const f of clean) process.stderr.write(`  ${f.file}: ${f.message}\n`);
    process.exit(1);
  }
}
