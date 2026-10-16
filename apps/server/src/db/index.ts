import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { DDL, schema } from './schema.js';

export type Database = ReturnType<typeof drizzle<typeof schema>>;

export interface OpenedDatabase {
  db: Database;
  client: PGlite;
  close: () => Promise<void>;
}

/**
 * Opens the embedded PostgreSQL (PGlite) under `dataDir/pg` and applies the idempotent DDL.
 * The same drizzle schema works against a real PostgreSQL by swapping the driver.
 */
export async function openDatabase(dataDir: string): Promise<OpenedDatabase> {
  const dir = path.join(dataDir, 'pg');
  await fs.mkdir(dir, { recursive: true });
  const client = await PGlite.create({ dataDir: dir });
  await client.exec(DDL);
  const db = drizzle({ client, schema });
  return { db, client, close: () => client.close() };
}

/** In-memory database for tests. */
export async function openMemoryDatabase(): Promise<OpenedDatabase> {
  const client = await PGlite.create();
  await client.exec(DDL);
  const db = drizzle({ client, schema });
  return { db, client, close: () => client.close() };
}
