// ESM — Neo4j connection and query runner

import neo4j, { type Driver, type Session } from "neo4j-driver";
import type { CypherQuery } from "./types.ts";

let driver: Driver | null = null;

function createDriver(): Driver {
  const uri = Deno.env.get("NEO4J_DB_CONNECTION_URI");
  const username = Deno.env.get("NEO4J_DB_USERNAME");
  const password = Deno.env.get("NEO4J_DB_PASSWORD");

  if (!uri || !username || !password) {
    throw new Error(
      "Missing Neo4j credentials. Set NEO4J_DB_CONNECTION_URI, NEO4J_DB_USERNAME, NEO4J_DB_PASSWORD."
    );
  }

  return neo4j.driver(uri, neo4j.auth.basic(username, password));
}

export function getDriver(): Driver {
  if (driver) return driver;
  driver = createDriver();
  return driver;
}

/** Ensure connection is live; recreate driver on stale connection. */
async function ensureConnected(): Promise<Driver> {
  const d = getDriver();
  try {
    await d.verifyConnectivity();
    return d;
  } catch {
    // Stale connection — tear down and recreate
    try { await d.close(); } catch { /* ignore close errors */ }
    driver = createDriver();
    await driver.verifyConnectivity();
    return driver;
  }
}

export async function runQuery<T = Record<string, unknown>>(
  query: CypherQuery
): Promise<T[]> {
  const d = await ensureConnected();
  const session: Session = d.session();
  try {
    const result = await session.run(query.cypher, query.params);
    return result.records.map((record) => {
      const obj: Record<string, unknown> = {};
      for (const key of record.keys) {
        obj[key as string] = toPlain(record.get(key as string));
      }
      return obj as T;
    });
  } finally {
    await session.close();
  }
}

export async function runQueryRaw(query: CypherQuery) {
  const d = await ensureConnected();
  const session: Session = d.session();
  try {
    return await session.run(query.cypher, query.params);
  } finally {
    await session.close();
  }
}

export async function closeDriver(): Promise<void> {
  if (driver) {
    await driver.close();
    driver = null;
  }
}

// Convert Neo4j types to plain JS objects
// deno-lint-ignore no-explicit-any
function toPlain(value: any): unknown {
  if (value === null || value === undefined) return value;

  // Neo4j Integer
  if (neo4j.isInt(value)) return value.toNumber();

  // Neo4j Node
  if (value.constructor?.name === "Node") {
    return {
      id: toPlain(value.properties.id),
      labels: value.labels,
      ...Object.fromEntries(
        Object.entries(value.properties).map(([k, v]) => [k, toPlain(v)])
      ),
    };
  }

  // Neo4j Relationship
  if (value.constructor?.name === "Relationship") {
    return {
      type: value.type,
      ...Object.fromEntries(
        Object.entries(value.properties).map(([k, v]) => [k, toPlain(v)])
      ),
    };
  }

  // Neo4j Path
  if (value.constructor?.name === "Path") {
    return {
      start: toPlain(value.start),
      end: toPlain(value.end),
      segments: value.segments.map(
        // deno-lint-ignore no-explicit-any
        (seg: any) => ({
          start: toPlain(seg.start),
          relationship: toPlain(seg.relationship),
          end: toPlain(seg.end),
        })
      ),
    };
  }

  // Arrays
  if (Array.isArray(value)) return value.map(toPlain);

  // Plain objects
  if (typeof value === "object" && value.constructor === Object) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, toPlain(v)])
    );
  }

  return value;
}
