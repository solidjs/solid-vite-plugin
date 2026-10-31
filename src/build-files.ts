import { rmdirSync, rmSync } from 'fs';
import path from 'path';

/**
 * Removes a build-only file from the client output once a server build in
 * the same process has read it, and its `.vite/` directory when nothing else
 * is left there. Hosts may publish the whole client output (#511).
 */
export function removeClientBuildFile(file: string): void {
  rmSync(file, { force: true });
  try {
    rmdirSync(path.dirname(file));
  } catch {
    // Not empty, or already gone.
  }
}
