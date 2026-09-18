#!/usr/bin/env node
import { runCli } from '../src/cli.js';

process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});
process.exitCode = await runCli();
