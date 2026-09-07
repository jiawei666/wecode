import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FALLBACK_VERSION = '0.0.0-dev';

/** Resolve the package version both from source (tsx) and from the npm bundle. */
export function readPackageVersionSync(): string {
  const modulePath = fileURLToPath(import.meta.url);
  const candidates = [
    path.resolve(path.dirname(modulePath), '..', 'package.json'),
    path.resolve(path.dirname(modulePath), '..', '..', 'package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const value = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof value.version === 'string' && value.version.trim()) return value.version.trim();
    } catch {
      // Try the next candidate; a broken optional candidate must not stop status.
    }
  }
  return FALLBACK_VERSION;
}

export const WECODE_VERSION = readPackageVersionSync();
