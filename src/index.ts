#!/usr/bin/env node
import { createCli } from './cli';

const program = createCli();
program.parse(process.argv);
