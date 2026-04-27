import { spawnSync } from 'child_process';
import { readdirSync } from 'fs';
import { join } from 'path';

const testDir = join(process.cwd(), 'test');
const files = readdirSync(testDir)
  .filter(f => f.endsWith('.ts') || f.endsWith('.test.ts'))
  .map(f => join('test', f));

console.log(`[Test Runner] Running tests: ${files.join(', ')}`);

const result = spawnSync('npx', ['hardhat', 'test', ...files], {
  stdio: 'inherit',
  shell: true
});

process.exit(result.status ?? 0);
