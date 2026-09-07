import { chmod } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = path.join(projectRoot, 'dist', 'src', 'index.js');

// npm creates the global `wecode` launcher as a symlink to this file on Unix.
// TypeScript emits regular files with 0644, so restore the executable bit after
// every clean build. Windows ignores this mode while still accepting the file.
await chmod(entrypoint, 0o755);
