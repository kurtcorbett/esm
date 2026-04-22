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

# Configure environment (recommended: system-wide config directory)
mkdir -p ~/.config/env
cp .env.example ~/.config/env/esm.env
# Edit ~/.config/env/esm.env — uncomment Docker lines, add your OpenAI key

# Initialize schema (creates vector indexes + constraints)
deno task setup

# Register with Claude Code (use absolute path to your clone)
claude mcp add esm -- deno run --allow-net --allow-env --allow-read --allow-sys \
  /absolute/path/to/esm/src/main.ts

# Verify
claude mcp list   # should show "esm"
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

3. Configure environment:
   ```bash
   mkdir -p ~/.config/env
   cp .env.example ~/.config/env/esm.env
   ```
   Edit `~/.config/env/esm.env` — uncomment the Docker and Ollama sections:
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

4. Initialize and register:
   ```bash
   deno task setup
   claude mcp add esm -- deno run --allow-net --allow-env --allow-read --allow-sys \
     /absolute/path/to/esm/src/main.ts
   ```

### Cloud Setup (Neo4j Aura + OpenAI/OpenRouter)

1. Create a free [Neo4j Aura](https://neo4j.com/cloud/aura/) instance
2. Configure environment:
   ```bash
   mkdir -p ~/.config/env
   cp .env.example ~/.config/env/esm.env
   ```
   Edit `~/.config/env/esm.env`:
   ```env
   NEO4J_DB_CONNECTION_URI=neo4j+s://xxxx.databases.neo4j.io
   NEO4J_DB_USERNAME=neo4j
   NEO4J_DB_PASSWORD=your-password
   LLM_BASE_URL=https://api.openai.com/v1
   LLM_API_KEY=sk-...
   ```
3. Initialize and register:
   ```bash
   deno task setup
   claude mcp add esm -- deno run --allow-net --allow-env --allow-read --allow-sys \
     /absolute/path/to/esm/src/main.ts
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

Environment is loaded in this order (first found wins):

1. `ESM_ENV_FILE` environment variable (explicit override — useful for multi-instance setups)
2. `~/.config/env/esm.env` (recommended — works regardless of working directory)
3. `.env` in repo root (fallback for development)

**Important:** `LLM_EMBEDDING_DIMENSIONS` must exactly match your embedding model's output. Common values: `text-embedding-3-small` = 1536, `nomic-embed-text` (Ollama) = 768. If you change models after setup, drop and recreate indexes (see Troubleshooting).

## MCP Connection

### Claude Code

```bash
claude mcp add esm -- deno run --allow-net --allow-env --allow-read --allow-sys /path/to/esm/src/main.ts
```

Verify: `claude mcp list` should show `esm` as available.

### Claude Desktop

Add to your MCP config (location varies by platform — see Claude Desktop docs):

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

Restart Claude Desktop after editing. ESM tools appear in the tools menu.

### Verifying the Connection

Once registered, test from Claude Code by asking it to run `stats`. You should get back node/edge counts (all zeros on a fresh install). If you get a connection error, see Troubleshooting below.

## MCP Tools

| Tool | Description |
|------|-------------|
| `setup_schema` | Create vector indexes and constraints (idempotent) |
| `capture` | Unified intake — auto-classifies and stores any content |
| `create_entity` | Create typed entity nodes with auto-embedding |
| `create_signal` | Capture observations with data + interpretation |
| `create_session` | Start sessions with participants and scope |
| `create_relationship` | Wire nodes together with typed edges |
| `search` | Semantic search across vector indexes |
| `get_node` | Fetch a node with all its relationships |
| `get_context` | Reconstruct context around a topic or entity |
| `traverse` | Multi-hop graph traversal with filters |
| `list` | Browse nodes by type, recency, status |
| `stats` | Summary statistics and attention items |
| `run_diagnostic` | Structural health checks on the graph |
| `update_node` | Update properties on an existing node |
| `delete_node` | Remove a node and its relationships |

## Tool Reference

### `setup_schema`

Create vector indexes and uniqueness constraints in Neo4j. Idempotent — safe to run multiple times.

**Parameters:** None

```json
{}
```

---

### `capture`

Unified intake — send any content and it gets classified, embedded, and stored as the appropriate node type. This is the simplest way to add data. The classifier determines the node type automatically, or you can provide hints to skip classification.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `content` | string | Yes | The content to capture — any text |
| `hints` | object | No | `{ node_type?: string, name?: string }` — guide or skip classification |

```json
// Minimal — let the classifier decide the type
{ "content": "We need to migrate the auth service to OAuth 2.1 before Q3" }

// With hints — skip classification
{ "content": "Kurt is the engineering manager for the platform team", "hints": { "node_type": "Agent", "name": "Kurt" } }
```

---

### `create_entity`

Create a typed entity node (Agent, Need, Resource, Constraint, Output, Role). Auto-generates embedding and extracts metadata via LLM. Explicit properties override LLM-extracted values.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `entity_type` | string | Yes | One of: `Agent`, `Need`, `Resource`, `Constraint`, `Output`, `Role` |
| `name` | string | Yes | Display name for the entity |
| `content` | string | No | Description/context — used for embedding generation |
| `properties` | object | No | Additional properties — explicit values override LLM-extracted metadata |

```json
{ "entity_type": "Agent", "name": "Kurt", "content": "Engineering manager focused on platform infrastructure" }

{ "entity_type": "Need", "name": "Auth Migration", "content": "Migrate auth service to OAuth 2.1", "properties": { "lifecycle_state": "open", "priority": "high" } }
```

---

### `create_signal`

Capture an observation with optional context. Auto-creates `OBSERVED_BY`, `SIGNALS`, and `PRODUCED_IN` edges when IDs are provided. Observer-authored fields (`observation`, `context`, `how_observed`, `confidence`, `perceived_impact`) are sacred — never overwritten by the system.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `observation` | string | Yes | What happened, from the observer's vantage point — factual, verifiable |
| `context` | string | No | Observer-authored situational context, circumstances, or hypotheses |
| `observed_by_agent_id` | string | No | ID of the agent who captured this signal |
| `signals_entity_id` | string | No | ID of the entity this signal is about |
| `produced_in_session_id` | string | No | ID of the session where this was captured |
| `properties` | object | No | Additional properties (how_observed, confidence, perceived_impact, disposition, disposition_note, etc.) |

```json
{
  "observation": "API latency p99 increased from 200ms to 850ms after deploy",
  "context": "The new auth middleware was deployed 2 hours ago, latency started climbing immediately",
  "signals_entity_id": "uuid-of-auth-service"
}
```

---

### `create_session`

Start a session with participants, scope, and triggers. Creates `PARTICIPATES_IN`, `SCOPED_TO`, and `TRIGGERED_BY` edges.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | Yes | Session name |
| `content` | string | No | Session description / summary |
| `participant_ids` | string[] | No | Agent IDs of participants |
| `scoped_to_id` | string | No | Entity ID this session is scoped to |
| `triggered_by_signal_ids` | string[] | No | Signal IDs that triggered this session |
| `properties` | object | No | Additional properties (session_type, trigger_type, etc.) |

```json
{
  "name": "Auth Migration Planning",
  "content": "Planning session for OAuth 2.1 migration",
  "participant_ids": ["agent-uuid-1", "agent-uuid-2"],
  "scoped_to_id": "need-uuid",
  "properties": { "session_type": "planning" }
}
```

---

### `create_relationship`

Create any of the 21 relationship types between two nodes with optional edge properties.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `from_id` | string | Yes | Source node ID |
| `to_id` | string | Yes | Target node ID |
| `relationship_type` | string | Yes | One of: `PURPOSE`, `CONTAINS`, `FILLS`, `GOVERNS`, `OWNS`, `SERVES`, `GENERATED_BY`, `REQUIRES`, `PRODUCES`, `EVALUATED_AGAINST`, `HAS_STOCK`, `SIGNALS`, `OBSERVED_BY`, `FLAGGED_AT`, `PRODUCED_IN`, `PARTICIPATES_IN`, `SCOPED_TO`, `TRIGGERED_BY`, `DEFINED_BY`, `ESCALATED_TO`, `RELATED_TO` |
| `properties` | object | No | Edge properties |

```json
{ "from_id": "agent-uuid", "to_id": "need-uuid", "relationship_type": "OWNS" }
```

---

### `search`

Semantic search across vector indexes. Returns results ranked by cosine similarity.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `query` | string | Yes | — | Natural language search query |
| `index` | string | No | `"all"` | Which index: `all`, `entity`, `signal`, `session`, `discrepancy` |
| `limit` | number | No | `10` | Max results per index |
| `threshold` | number | No | `0.5` | Minimum similarity score (0–1) |

```json
{ "query": "authentication and authorization" }

{ "query": "latency issues", "index": "signal", "limit": 5, "threshold": 0.7 }
```

---

### `get_node`

Fetch a node by ID with all its relationships and connected nodes.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | Yes | Node ID (UUID) |

```json
{ "id": "550e8400-e29b-41d4-a716-446655440000" }
```

---

### `get_context`

Reconstruct context around a topic or entity. Returns semantic anchors, active threads, structural neighbors, attention items, and optionally discovery suggestions.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `query` | string | Yes | — | Natural language query to find relevant context |
| `entity_id` | string | No | — | Anchor to a known entity ID instead of searching |
| `include_discoveries` | boolean | No | `true` | Include discovery suggestions |

```json
{ "query": "what's happening with the auth migration" }

{ "query": "platform team priorities", "entity_id": "agent-uuid", "include_discoveries": false }
```

---

### `traverse`

Multi-hop graph traversal from a starting node. Filter by relationship type(s), control depth, and direction.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `id` | string | Yes | — | Starting node ID |
| `relationship_types` | string[] | No | all | Filter to specific relationship types |
| `max_depth` | number | No | `3` | Maximum traversal depth (1–10) |
| `direction` | string | No | `"both"` | `both`, `outgoing`, or `incoming` |

```json
{ "id": "agent-uuid", "relationship_types": ["OWNS", "PRODUCES"], "max_depth": 2, "direction": "outgoing" }
```

---

### `list`

Browse captured nodes with optional filters.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `days` | number | No | — | Only nodes from the last N days |
| `type` | string | No | — | Filter by node label (e.g. `Signal`, `Agent`, `Need`) |
| `status` | string | No | — | Filter by status field |
| `limit` | number | No | `20` | Max results |

```json
{ "type": "Signal", "days": 7, "limit": 10 }

{ "type": "Need", "status": "open" }
```

---

### `stats`

Summary statistics: node counts by type, edge counts, 7-day activity, and attention items (unprocessed signals, open needs).

**Parameters:** None

```json
{}
```

---

### `run_diagnostic`

Structural health checks on the graph.

**Parameters:**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `checks` | string[] | No | `["all"]` | Diagnostics to run: `unattached_needs`, `missing_purpose`, `overloaded_agents`, `phantom_sessions`, `entities_without_purpose`, `unprocessed_signals`, `ego_drift_check`, `constraint_role_analysis`, `all` |

```json
{}

{ "checks": ["unprocessed_signals", "unattached_needs"] }
```

---

### `update_node`

Update properties on an existing node by ID. Merges with existing properties — only specified fields change, unmentioned fields are preserved. Re-generates embedding if `content` or `name` changes. Cannot overwrite `id` or `created_at`.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | Yes | Node ID (UUID) to update |
| `properties` | object | Yes | Properties to set or update — merged with existing |

```json
{ "id": "550e8400-e29b-41d4-a716-446655440000", "properties": { "status": "resolved_into_update" } }

{ "id": "550e8400-e29b-41d4-a716-446655440000", "properties": { "name": "Updated Name", "content": "New description triggers re-embedding" } }
```

---

### `delete_node`

Delete a node and all its relationships. Irreversible.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `id` | string | Yes | Node ID (UUID) to delete |

```json
{ "id": "550e8400-e29b-41d4-a716-446655440000" }
```

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

## Troubleshooting

**"Missing NEO4J_DB_CONNECTION_URI"** — Environment file not found. Check that `~/.config/env/esm.env` exists, or set `ESM_ENV_FILE` explicitly:
```bash
ESM_ENV_FILE=/path/to/your/.env deno task setup
```

**"Neo4j connection failed"** — Docker not running or wrong URI. Verify Neo4j is up:
```bash
docker compose ps          # should show neo4j running
docker compose up -d       # restart if needed
```

**"Embedding request failed (401)"** — Invalid `LLM_API_KEY` or wrong `LLM_BASE_URL`. Verify your API credentials with your provider.

**"Vector index created with wrong dimensions"** — `LLM_EMBEDDING_DIMENSIONS` doesn't match your model. Drop and recreate:
```bash
deno run --allow-net --allow-env --allow-read --allow-sys scripts/drop-indexes.ts
deno task setup
```

**Claude Code doesn't see ESM tools** — Re-register and verify:
```bash
claude mcp remove esm
claude mcp add esm -- deno run --allow-net --allow-env --allow-read --allow-sys /absolute/path/to/esm/src/main.ts
claude mcp list
```

## What's Next

ESM provides the storage layer. For SIA (Strategic Intent Alignment) operational behavior — signal processing pipelines, onboarding sessions, session protocol — see the [SIA Plugins](https://github.com/kurtcorbett/sia-plugins) repo. Its README covers deploying skill files and the session protocol to your projects.

## License

Apache 2.0 — see [LICENSE](LICENSE).
