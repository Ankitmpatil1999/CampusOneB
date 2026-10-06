import { createConnection, type Connection, type RowDataPacket } from 'mysql2/promise';
import type { MigrationExecutor } from './migrator';

/** A single migrator connection with multi-statement scripts enabled (migrations and seeds only). */
export async function openMigrationConnection(
  url: string,
): Promise<MigrationExecutor & { close(): Promise<void> }> {
  const conn: Connection = await createConnection({
    uri: url,
    multipleStatements: true,
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: true,
    charset: 'utf8mb4_0900_ai_ci',
  });
  return {
    async query<T>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      const [rows] = await conn.query<RowDataPacket[]>(sql, params as unknown[]);
      return (Array.isArray(rows) ? rows : []) as T[];
    },
    async script(sql: string): Promise<void> {
      await conn.query(sql);
    },
    async close() {
      await conn.end();
    },
  };
}
