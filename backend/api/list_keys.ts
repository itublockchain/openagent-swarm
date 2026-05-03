import Database from 'better-sqlite3';
import { resolve } from 'path';

const dbPath = resolve('../../data/api.db');
const db = new Database(dbPath);

console.log('Listing all API keys:');
const keys = db.prepare("SELECT key_hash, scopes FROM api_keys").all();
console.log(JSON.stringify(keys, null, 2));

db.close();
