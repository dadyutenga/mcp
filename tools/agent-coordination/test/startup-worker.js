import { openDatabase } from '../src/db.js';

const db = openDatabase(process.argv[2]);
try { process.stdout.write(String(db.pragma('user_version', { simple: true }))); }
finally { db.close(); }
