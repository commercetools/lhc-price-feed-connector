// Connect's validation pipeline runs `npm test -- --coverage --collectCoverageFrom=... --coverageReporters=text`
// (Jest's flags). This project uses vitest, which rejects unknown options, so strip the Jest-only ones
// and run the suite; coverage is not needed for the pipeline to pass.
import { spawnSync } from 'node:child_process';

const jestOnly = /^--(coverage|collectCoverageFrom|coverageReporters)(=|$)/;
const args = process.argv.slice(2).filter((a) => !jestOnly.test(a));
const result = spawnSync('npx', ['vitest', 'run', ...args], { stdio: 'inherit', shell: process.platform === 'win32' });
process.exit(result.status ?? 1);
