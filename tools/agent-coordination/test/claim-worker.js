import { Coordination } from '../src/core.js';
import { openDatabase } from '../src/db.js';

const core = new Coordination(openDatabase(process.argv[2]));
try {
  const task = core.claimTask({ task_id: process.argv[3], agent_id: process.argv[4] });
  process.stdout.write(JSON.stringify({ claimed: true, agent: task.claimed_by_agent_id }));
} catch (error) {
  process.stdout.write(JSON.stringify({ claimed: false, error: error.message }));
} finally { core.close(); }
