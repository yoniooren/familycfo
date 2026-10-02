import { realpathSync } from 'fs';
import { pathToFileURL } from 'url';

/**
 * True when this module is the script node was started with (`npm run pipeline`, `npm run migrate`, …).
 * Comparing against `file://${process.argv[1]}` fails on Windows (`file:///C:/…` with forward slashes),
 * so the path is turned into a proper file URL first.
 */
export function isMain(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return moduleUrl === pathToFileURL(entry).href;
  }
}
