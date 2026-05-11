import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

if (!existsSync('.git')) {
  process.exit(0);
}

try {
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { stdio: 'inherit' });
  console.log('Configured git hooks path: .githooks');
} catch (error) {
  console.warn('Could not configure git hooks path. Run: git config core.hooksPath .githooks');
  process.exitCode = 0;
}
