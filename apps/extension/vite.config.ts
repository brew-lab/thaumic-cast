import { build, defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';
import { readdirSync } from 'fs';
import { resolve } from 'path';

/**
 * Scripts that run in web pages, built as self-contained classic files at the root of the
 * output: published file name to entry module.
 *
 * - The content scripts (media reader and bridge). CRXJS would emit each as a loader that
 *   imports its module from a web-accessible URL. That import is a fetch made by the page,
 *   so the page's rules apply to it: YouTube Music's Connection-Allowlist blocks it ("Unsafe
 *   attempt to load URL ... Domains, protocols and ports must match.") and the scripts never
 *   run. It also lands after the page's own scripts have started, so the reader could miss
 *   the first media session calls. A file named in content_scripts is injected by the
 *   browser itself, synchronously, with no fetch.
 * - The video sync hook and relay. The hook must patch the page's prototypes synchronously
 *   before any page script runs, and the page must not be able to fetch it. The background
 *   registers both with chrome.scripting only while video sync is on.
 */
const PAGE_SCRIPTS: Record<string, string> = {
  'media-reader.js': 'src/content/media-reader.ts',
  'media-bridge.js': 'src/content/media-bridge.ts',
  'video-sync-hook.js': 'src/video-sync-hook/main.ts',
  'video-sync-relay.js': 'src/video-sync-hook/relay.ts',
};

/** The manifest without its content scripts, which CRXJS must not process (see above). */
const { content_scripts: contentScripts, ...crxManifest } = manifest;

/**
 * The manifest's content scripts with each entry module replaced by its built file.
 * @returns The content_scripts the built manifest declares
 */
function builtContentScripts(): typeof contentScripts {
  const fileFor = new Map(Object.entries(PAGE_SCRIPTS).map(([file, entry]) => [entry, file]));
  return contentScripts.map((script) => ({
    ...script,
    js: script.js.map((entry) => {
      const file = fileFor.get(entry);
      if (!file) throw new Error(`content script ${entry} is not in PAGE_SCRIPTS`);
      return file;
    }),
  }));
}

/**
 * Builds PAGE_SCRIPTS as self-contained IIFE files, outside CRXJS's content-script pipeline,
 * and adds the content scripts to the manifest CRXJS wrote.
 * @returns The plugin
 */
function pageScripts(): Plugin {
  const dirs = new Set(Object.values(PAGE_SCRIPTS).map((entry) => resolve(__dirname, entry, '..')));
  return {
    name: 'thaumic-page-scripts',
    apply: 'build',
    // After CRXJS, whose manifest this adds to.
    enforce: 'post',
    buildStart() {
      for (const dir of dirs) {
        for (const f of readdirSync(dir)) if (f.endsWith('.ts')) this.addWatchFile(resolve(dir, f));
      }
    },
    generateBundle: {
      order: 'post',
      async handler(_options, bundle) {
        for (const [fileName, entry] of Object.entries(PAGE_SCRIPTS)) {
          const result = await build({
            configFile: false,
            root: __dirname,
            logLevel: 'warn',
            publicDir: false,
            build: {
              write: false,
              minify: true,
              sourcemap: false,
              copyPublicDir: false,
              modulePreload: false,
              rollupOptions: {
                input: resolve(__dirname, entry),
                output: { format: 'iife', entryFileNames: fileName },
              },
            },
          });
          const outputs = Array.isArray(result) ? result : [result];
          const chunks = outputs.flatMap((o) =>
            'output' in o ? o.output.filter((x) => x.type === 'chunk') : [],
          );
          if (chunks.length !== 1) {
            throw new Error(`${fileName}: expected one chunk, got ${chunks.length}`);
          }
          const code = chunks[0].code;
          // The file runs as a classic script: it must not pull in other chunks.
          if (/\bimport\s*[("'{*]|\bimport\s+[\w$]|\bexport\s*[{*\w]/.test(code)) {
            throw new Error(`${fileName}: the standalone page script contains import or export`);
          }
          this.emitFile({ type: 'asset', fileName, source: code });
        }

        const asset = bundle['manifest.json'];
        if (asset?.type !== 'asset') throw new Error('CRXJS emitted no manifest.json');
        const built = JSON.parse(String(asset.source));
        built.content_scripts = builtContentScripts();
        asset.source = JSON.stringify(built, null, 2) + '\n';
      },
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [preact(), crx({ manifest: crxManifest }), pageScripts()],
  define: {
    /**
     * Build-time flag for audio diagnostics (clipping detection, verbose tracing).
     * Enabled in development, completely eliminated in production builds.
     */
    __DEBUG_AUDIO__: JSON.stringify(mode === 'development'),
  },
  css: {
    modules: {
      localsConvention: 'camelCaseOnly',
    },
  },
  build: {
    // Chrome 125 is the floor (DESIGN.md §13, round 7). Without it the CSS minifier rewrites
    // light-dark() inside custom properties into a polyfill that resolves at :root, so a part
    // of a page drawn in the other scheme would keep the root's colours.
    cssTarget: 'chrome125',
    minify: 'esbuild',
    sourcemap: false,
    rollupOptions: {
      input: {
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
        options: resolve(__dirname, 'src/options/index.html'),
        'pcm-processor': resolve(__dirname, 'src/offscreen/pcm-processor.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'pcm-processor') {
            return 'pcm-processor.js';
          }
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
}));
