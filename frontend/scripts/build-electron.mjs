import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  external: ['electron'],
  sourcemap: true,
};

await Promise.all([
  build({
    ...shared,
    entryPoints: [path.join(rootDir, 'electron', 'main.ts')],
    outfile: path.join(rootDir, 'dist-electron', 'main.cjs'),
  }),
  build({
    ...shared,
    entryPoints: [path.join(rootDir, 'electron', 'preload.ts')],
    outfile: path.join(rootDir, 'dist-electron', 'preload.cjs'),
  }),
]);

console.log('Built Electron main & preload bundles.');
