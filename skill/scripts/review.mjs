import { runAgentCLI } from '../app/scripts/review-agent.mjs';
runAgentCLI().catch(cause => { console.error(cause.message); process.exitCode = 1; });
