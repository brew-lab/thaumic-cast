import { build, defineConfig, type Plugin } from 'vite';
import preact from '@preact/preset-vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';
import { readdirSync } from 'fs';
import { resolve } from 'path';

/** Page scripts for video sync: published file name to entry module. */
const VIDEO_SYNC_PAGE_SCRIPTS: Record<string, string> = {
  'video-sync-hook.js': 'src/video-sync-hook/main.ts',
  'video-sync-relay.js': 'src/video-sync-hook/relay.ts',
};

/**
 * Builds the video sync hook and relay as self-contained IIFE files at the
 * root of the output, outside CRXJS's content-script pipeline. CRXJS emits
 * content scripts as async loaders that import a module listed in
 * web_accessible_resources; the hook must instead patch the page's
 * prototypes synchronously before any page script runs, and the page must
 * not be able to fetch it. The background registers both files with
 * chrome.scripting only while video sync is on.
 * @returns The plugin
 */
function videoSyncPageScripts(): Plugin {
  const dir = resolve(__dirname, 'src/video-sync-hook');
  return {
    name: 'thaumic-video-sync-page-scripts',
    apply: 'build',
    buildStart() {
      for (const f of readdirSync(dir)) if (f.endsWith('.ts')) this.addWatchFile(resolve(dir, f));
    },
    async generateBundle() {
      for (const [fileName, entry] of Object.entries(VIDEO_SYNC_PAGE_SCRIPTS)) {
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
              output: { format: 'iife', entryFileNames: fileName, inlineDynamicImports: true },
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
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [preact(), crx({ manifest }), videoSyncPageScripts()],
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
