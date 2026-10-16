import { existsSync } from 'node:fs';
import path from 'node:path';
import { config as loadDotenv } from 'dotenv';

let loaded = false;

/**
 * Finds the repository root (the directory that contains `.env.example`) by walking up from
 * the current working directory and loads its `.env` into process.env once. Existing variables
 * are never overwritten, so real environment settings win over the file.
 */
export function loadRootEnv(startDir = process.cwd()): string {
  const root = findRepoRoot(startDir);
  if (!loaded) {
    const envPath = path.join(root, '.env');
    if (existsSync(envPath)) loadDotenv({ path: envPath, quiet: true });
    loaded = true;
  }
  return root;
}

export function findRepoRoot(startDir = process.cwd()): string {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 10; i++) {
    if (existsSync(path.join(dir, '.env.example')) || existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'tsconfig.base.json'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir);
}

/** Resolves DATA_DIR (default ./data) against the repository root. */
export function dataDir(): string {
  const root = loadRootEnv();
  return path.resolve(root, process.env.DATA_DIR ?? './data');
}
