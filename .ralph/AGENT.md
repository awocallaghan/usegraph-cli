# Ralph Agent Configuration

## Build Instructions

```bash
# Install dependencies
pnpm install

# Build the project (TypeScript -> dist/)
pnpm build
```

## Test Instructions

```bash
# Run tests
pnpm test
```

## Run Instructions

```bash
# After building:
node dist/index.js --help

# Or with dev (ts-node, if installed):
pnpm dev -- --help
```

## Project Structure

```
usegraph-cli/
├── src/
│   ├── index.ts       # Entry point (shebang + parse)
│   └── cli.ts         # Commander program definition
├── dist/              # Compiled output (gitignored)
├── package.json
└── tsconfig.json
```

## Notes
- TypeScript project using pnpm
- Uses Commander.js for CLI argument parsing
- Node.js >= 18 required
- Build output goes to `dist/`

## Dependencies by Phase

### Phase 3 (usegraph build)
```bash
pnpm add duckdb
# or: pnpm add @duckdb/node-api
```

### Phase 4 (usegraph mcp)
```bash
pnpm add @modelcontextprotocol/sdk
```
