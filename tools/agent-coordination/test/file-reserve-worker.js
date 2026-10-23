import { Coordination } from '../src/core.js';
import { openDatabase } from '../src/db.js';
import { FileCoordination } from '../src/files.js';

const [database, root, agent, task, file] = process.argv.slice(2);
const core = new Coordination(openDatabase(database));
try {
  const result = new FileCoordination(core, { root }).reserve({ agent_id: agent, task_id: task, file_path: file });
  process.stdout.write(JSON.stringify({ acquired: result.acquired, conflicts: result.conflicts.map(x => x.type) }));
} catch (error) {
  process.stderr.write(error.stack || error.message);
  process.exitCode = 1;
} finally { core.close(); }
