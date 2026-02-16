/**
 * Shared Neo4j driver and query utility.
 * Used by graph.ts (general knowledge graph) and knowledge-builder.ts (KB graph overlay).
 */
import neo4j, { Driver, Session } from "neo4j-driver";

const NEO4J_URL = process.env.NEO4J_URL || "bolt://Neo4j:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "";

let driver: Driver | null = null;

export function getNeo4jDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(NEO4J_URL, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  }
  return driver;
}

export async function neo4jQuery(cypher: string, params: Record<string, any> = {}): Promise<any[]> {
  const session: Session = getNeo4jDriver().session();
  try {
    const result = await session.run(cypher, params);
    return result.records.map((record) => {
      const obj: any = {};
      record.keys.forEach((key) => {
        const value = record.get(key);
        if (neo4j.isInt(value)) {
          obj[key] = value.toNumber();
        } else if (value && typeof value === "object" && value.properties) {
          obj[key] = { ...value.properties, _labels: value.labels };
        } else {
          obj[key] = value;
        }
      });
      return obj;
    });
  } finally {
    await session.close();
  }
}

