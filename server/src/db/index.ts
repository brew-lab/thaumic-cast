import { Database } from 'bun:sqlite';
import { initSchema } from './schema';

const DATABASE_PATH = Bun.env.DATABASE_PATH || './data/thaumic.db';

// Ensure data directory exists
const dataDir = DATABASE_PATH.substring(0, DATABASE_PATH.lastIndexOf('/'));
if (dataDir) {
  await Bun.write(`${dataDir}/.gitkeep`, '');
}

export const db = new Database(DATABASE_PATH, { create: true });

// Enable WAL mode for better concurrent access
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

// Initialize schema
initSchema(db);

export type { Database };
