import { type Db, openDb } from '../../src/db/client.js';
import { type Repos, createRepos } from '../../src/db/repos/index.js';

/**
 * Opens an in-memory DB with schema applied (D-33). Default helper for unit
 * tests: no filesystem, parallelizable, no cleanup needed.
 */
export function openTestDb(): Db {
  return openDb(':memory:');
}

/**
 * Opens an in-memory DB and wires repos in one step. Most repo-level unit
 * tests only need this shape: `const { repos } = openTestDbWithRepos();`.
 */
export function openTestDbWithRepos(): { db: Db; repos: Repos } {
  const db = openTestDb();
  return { db, repos: createRepos(db) };
}
