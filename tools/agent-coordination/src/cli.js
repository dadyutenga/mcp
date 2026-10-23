import { existsSync, rmSync } from 'node:fs';
import { databasePath, openDatabase } from './db.js';

const command = process.argv[2];
const file = databasePath();
if (command === 'check') {
  const db = openDatabase();
  try {
    const integrity = db.pragma('integrity_check', { simple: true });
    const foreignKeys = db.pragma('foreign_key_check');
    const counts = Object.fromEntries(['agents', 'tasks', 'messages', 'change_requests', 'audit_events',
      'file_reservations', 'file_conflicts', 'ownership_requests']
      .map(table => [table, db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count]));
    console.log(JSON.stringify({ database: file, schema_version: db.pragma('user_version', { simple: true }),
      journal_mode: db.pragma('journal_mode', { simple: true }), integrity, foreign_key_violations: foreignKeys.length, counts }, null, 2));
    if (integrity !== 'ok' || foreignKeys.length) process.exitCode = 1;
  } finally { db.close(); }
} else if (command === 'reset') {
  if (!process.argv.includes('--yes-i-understand-this-deletes-coordination-data')) {
    console.error('Reset refused. Add --yes-i-understand-this-deletes-coordination-data to delete the database.');
    process.exitCode = 1;
  } else {
    for (const suffix of ['', '-wal', '-shm']) {
      const target = file + suffix;
      if (existsSync(target)) rmSync(target);
    }
    console.log(`Deleted coordination database at ${file}`);
  }
} else {
  console.error('Usage: node src/cli.js check|reset [--yes-i-understand-this-deletes-coordination-data]');
  process.exitCode = 1;
}
