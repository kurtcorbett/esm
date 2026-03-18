# Contributing to ESM

## Setup

1. Install [Deno 2+](https://deno.land/)
2. Start Neo4j (local via Docker or cloud):
   ```bash
   docker compose up -d
   ```
3. Copy `.env.example` to `.env` and fill in your credentials
4. Initialize the schema:
   ```bash
   deno task setup
   ```

## Development

Run the MCP server:
```bash
deno task start
```

Run tests:
```bash
deno task test
```

## Code Style

- TypeScript with Deno conventions
- No external linter — keep it clean and readable
- Tests live alongside source files as `*_test.ts`

## Pull Requests

- Keep PRs focused on a single change
- Include tests for new functionality
- Run `deno task test` before submitting
