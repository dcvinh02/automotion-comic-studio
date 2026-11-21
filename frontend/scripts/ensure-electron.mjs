import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const electronDir = path.resolve(__dirname, '..', 'node_modules', 'electron');
const pathTxt = path.join(electronDir, 'path.txt');

if (fs.existsSync(electronDir) && !fs.existsSync(pathTxt)) {
  const candidates =
    process.platform === 'darwin'
      ? ['Electron.app/Contents/MacOS/Electron']
      : process.platform === 'win32'
        ? ['electron.exe']
        : ['electron'];

  for (const rel of candidates) {
    const abs = path.join(electronDir, 'dist', rel);
    if (fs.existsSync(abs)) {
      fs.writeFileSync(pathTxt, rel, 'utf-8');
      console.log(`[ensure-electron] Repaired missing path.txt -> ${rel}`);
      break;
    }
  }
}
