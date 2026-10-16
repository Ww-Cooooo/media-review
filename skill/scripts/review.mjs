import { prepare } from './setup.mjs';
prepare(['--agent-cli', ...process.argv.slice(2)]).catch(cause => { console.error(cause.message); process.exitCode = 1; });
