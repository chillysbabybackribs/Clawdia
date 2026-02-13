import { build } from 'esbuild';
import { resolve } from 'path';

const projectRoot = resolve(new URL('..', import.meta.url).pathname);

build({
  entryPoints: [resolve(projectRoot, 'src/main/preload.ts')],
  outfile: resolve(projectRoot, 'dist/main/preload.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron'],
  sourcemap: false,
  minify: false,
}).catch((err) => {
  console.error('[bundle-preload] Failed to bundle preload:', err);
  process.exitCode = 1;
});
