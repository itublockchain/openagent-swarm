import Database from 'better-sqlite3';
import { resolve } from 'path';

const dbPath = resolve('../../data/api.db');
const db = new Database(dbPath);

console.log('Listing all registered Sporeise agents:');
const agents = db.prepare("SELECT user_address, agent_label, agent_address FROM sporeise_agents").all();
console.log(JSON.stringify(agents, null, 2));

db.close();
