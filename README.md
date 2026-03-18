# ESM — External Structured Memory

A graph-based MCP server that gives AI assistants persistent, structured memory via Neo4j.

ESM turns any AI client that supports [MCP](https://modelcontextprotocol.io/) into a system with long-term memory — structured as a typed knowledge graph with semantic search, relationship traversal, and automated diagnostics.

## How It Works

AI clients connect to ESM via MCP (stdio transport). Every piece of knowledge is stored as a typed node in a Neo4j graph with vector embeddings for semantic search. Nodes are connected by typed relationships that encode how things relate.

```
AI Client (Claude, etc.)
    ↕ MCP (stdio)
ESM Server (Deno + TypeScript)
    ↕
Neo4j (graph storage + vector search)
    ↕
LLM API (embeddings + metadata extraction)
```

## Data Model

### Node Types

| Type | Purpose |
|------|---------|
| **Agent** | A person, team, org, or AI that acts with intent |
| **Need** | A gap, requirement, or want — has a lifecycle |
| **Resource** | A capability or asset — skill, knowledge, tool, budget |
| **Constraint** | A governing force — priority, belief, approach, structure |
| **Output** | Something produced by an agent |
| **Role** | A named function or position |
| **Signal** | An observation — concrete data + interpretation |
| **Session** | A bounded interaction or working session |
| **Discrepancy** | A gap between intent and output |
| **Stock** | A measurable accumulation (trust, knowledge, capacity) |

### Relationship Types

21 typed relationships including `PURPOSE`, `CONTAINS`, `FILLS`, `GOVERNS`, `OWNS`, `SERVES`, `SIGNALS`, `SCOPED_TO`, `TRIGGERED_BY`, and more. See `src/types.ts` for the full list.

## Setup

### Prerequisites

- [Deno 2+](https://deno.land/)
- Neo4j (cloud or local)
- An OpenAI-compatible API for embeddings and completions

### Quick Start (Docker + OpenAI)

```bash
# Start local Neo4j
docker compose up -d

# Configure environment
cp .env.example .env
# Edit .env with your LLM API key

# Initialize schema
deno task setup

# Start the MCP server
deno task start
```

### Fully Local Setup (Docker + Ollama)

For a fully self-hosted setup with no external API calls:

1. Install [Ollama](https://ollama.com/) and pull models:
   ```bash
   ollama pull nomic-embed-text
   ollama pull llama3.2
   ```

2. Start Neo4j:
   ```bash
   docker compose up -d
   ```

3. Configure `.env`:
   ```env
   NEO4J_DB_CONNECTION_URI=bolt://localhost:7687
   NEO4J_DB_USERNAME=neo4j
   NEO4J_DB_PASSWORD=password
   LLM_BASE_URL=http://localhost:11434/v1
   LLM_API_KEY=ollama
   LLM_EMBEDDING_MODEL=nomic-embed-text
   LLM_EMBEDDING_DIMENSIONS=768
   LLM_COMPLETION_MODEL=llama3.2
   ```

4. Initialize and start:
   ```bash
   deno task setup
   deno task start
   ```

### Cloud Setup (Neo4j Aura + OpenAI/OpenRouter)

1. Create a free [Neo4j Aura](https://neo4j.com/cloud/aura/) instance
2. Configure `.env`:
   ```env
   NEO4J_DB_CONNECTION_URI=neo4j+s://xxxx.databases.neo4j.io
   NEO4J_DB_USERNAME=neo4j
   NEO4J_DB_PASSWORD=your-password
   LLM_BASE_URL=https://api.openai.com/v1
   LLM_API_KEY=sk-...
   ```

## Environment Variables

| Variable | Default | Required | Description |
|----------|---------|----------|-------------|
| `NEO4J_DB_CONNECTION_URI` | — | Yes | Neo4j connection string |
| `NEO4J_DB_USERNAME` | — | Yes | Neo4j username |
| `NEO4J_DB_PASSWORD` | — | Yes | Neo4j password |
| `LLM_API_KEY` | — | Yes | API key for your LLM provider |
| `LLM_BASE_URL` | `https://api.openai.com/v1` | No | Any OpenAI-compatible endpoint |
| `LLM_EMBEDDING_MODEL` | `text-embedding-3-small` | No | Embedding model name |
| `LLM_EMBEDDING_DIMENSIONS` | `1536` | No | Must match your embedding model's output |
| `LLM_COMPLETION_MODEL` | `gpt-4o-mini` | No | Model for classification and metadata extraction |

Environment variables are loaded from `.env` in the project root, or `~/.config/env/esm.env`.

## MCP Connection

### Claude Code

```bash
claude mcp add esm -- deno run --allow-net --allow-env --allow-read --allow-sys /path/to/esm/src/main.ts
```

### Claude Desktop

Add to your MCP config:

```json
{
  "mcpServers": {
    "esm": {
      "command": "deno",
      "args": ["run", "--allow-net", "--allow-env", "--allow-read", "--allow-sys", "/path/to/esm/src/main.ts"]
    }
  }
}
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `setup_schema` | Create vector indexes and constraints (idempotent) |
| `create_entity` | Create typed entity nodes with auto-embedding |
| `create_signal` | Capture observations with data + interpretation |
| `create_session` | Start sessions with participants and scope |
| `create_relationship` | Wire nodes together with typed edges |
| `capture` | Unified intake — auto-classifies and stores any content |
| `search` | Semantic search across vector indexes |
| `get_node` | Fetch a node with all its relationships |
| `traverse` | Multi-hop graph traversal with filters |
| `list` | Browse nodes by type, recency, status |
| `run_diagnostic` | Structural health checks on the graph |
| `stats` | Summary statistics and attention items |
| `get_context` | Reconstruct context around a topic or entity |
| `delete_node` | Remove a node and its relationships |

## Security & Privacy

**ESM is designed for local, single-user environments.** It runs as a stdio MCP server — the AI client and ESM communicate over standard input/output on your local machine. There is no network authentication layer.

Do not expose ESM over a network without adding your own authentication. Anyone with access to the MCP transport can read and write all data in the graph.

**Data flow awareness:**
- By default, node content is sent to your configured LLM API (OpenAI, OpenRouter, etc.) for embedding generation and metadata extraction.
- If you need zero external data sharing, use the fully local setup with Ollama — all processing stays on your machine.
- All graph data is stored in your Neo4j instance. You are responsible for securing it.

## Project Structure

```
src/
  main.ts        — Entry point
  server.ts      — MCP tool registrations
  db.ts          — Neo4j connection and query runner
  queries.ts     — Cypher query builders
  types.ts       — TypeScript types and constants
  llm.ts         — LLM integration (embeddings + metadata)
  classify.ts    — Content classification
  context.ts     — Context reconstruction
  env.ts         — Environment variable loading
  schema.ts      — Schema setup script
```

## License

Apache 2.0 — see [LICENSE](LICENSE).
