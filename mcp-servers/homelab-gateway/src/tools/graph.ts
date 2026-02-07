import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import neo4j, { Driver, Session } from "neo4j-driver";

const NEO4J_URL = process.env.NEO4J_URL || "bolt://Neo4j:7687";
const NEO4J_USER = process.env.NEO4J_USER || "neo4j";
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || "";

let driver: Driver | null = null;

function getDriver(): Driver {
  if (!driver) {
    driver = neo4j.driver(NEO4J_URL, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  }
  return driver;
}

async function runQuery(cypher: string, params: Record<string, any> = {}): Promise<any[]> {
  const session: Session = getDriver().session();
  try {
    const result = await session.run(cypher, params);
    return result.records.map((record) => {
      const obj: any = {};
      record.keys.forEach((key) => {
        const value = record.get(key);
        // Convert Neo4j integers and nodes to plain objects
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

export function registerGraphTools(server: McpServer) {
  // Create node
  server.tool(
    "graph_create_node",
    "Create a new node in the knowledge graph",
    {
      label: z.string().describe("Node label (e.g., Concept, Person, Project)"),
      name: z.string().describe("Unique name for the node"),
      properties: z.record(z.any()).optional().describe("Additional properties"),
    },
    async ({ label, name, properties }) => {
      const props = { name, ...properties, created_at: new Date().toISOString() };
      const result = await runQuery(`CREATE (n:${label} $props) RETURN n`, { props });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "created", node: result[0]?.n }, null, 2),
          },
        ],
      };
    }
  );

  // Create relationship
  server.tool(
    "graph_create_relationship",
    "Create a relationship between two nodes",
    {
      from_name: z.string().describe("Name of the source node"),
      to_name: z.string().describe("Name of the target node"),
      type: z.string().describe("Relationship type (e.g., KNOWS, CONTAINS, RELATED_TO)"),
      properties: z.record(z.any()).optional().describe("Relationship properties"),
    },
    async ({ from_name, to_name, type, properties }) => {
      const props = { ...properties, created_at: new Date().toISOString() };
      const cypher = `
        MATCH (a {name: $from_name}), (b {name: $to_name})
        CREATE (a)-[r:${type} $props]->(b)
        RETURN a.name as from, type(r) as relationship, b.name as to
      `;
      const result = await runQuery(cypher, { from_name, to_name, props });

      if (result.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: "error", message: "One or both nodes not found" }, null, 2),
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ status: "created", ...result[0] }, null, 2) }],
      };
    }
  );

  // Raw Cypher query
  server.tool(
    "graph_query",
    "Execute a raw Cypher query against Neo4j",
    {
      cypher: z.string().describe("The Cypher query to execute"),
      params: z.record(z.any()).optional().describe("Query parameters"),
    },
    async ({ cypher, params }) => {
      const result = await runQuery(cypher, params || {});
      return {
        content: [{ type: "text", text: JSON.stringify({ results: result, count: result.length }, null, 2) }],
      };
    }
  );

  // Find node
  server.tool(
    "graph_find_node",
    "Find nodes by label and/or properties",
    {
      label: z.string().optional().describe("Filter by label"),
      name: z.string().optional().describe("Filter by name"),
      properties: z.record(z.any()).optional().describe("Filter by properties"),
    },
    async ({ label, name, properties }) => {
      let cypher = "MATCH (n";
      if (label) cypher += `:${label}`;
      cypher += ")";

      const conditions: string[] = [];
      const params: any = {};

      if (name) {
        conditions.push("n.name = $name");
        params.name = name;
      }
      if (properties) {
        Object.entries(properties).forEach(([key, value], i) => {
          conditions.push(`n.${key} = $prop_${i}`);
          params[`prop_${i}`] = value;
        });
      }

      if (conditions.length > 0) {
        cypher += ` WHERE ${conditions.join(" AND ")}`;
      }
      cypher += " RETURN n LIMIT 50";

      const result = await runQuery(cypher, params);
      return {
        content: [{ type: "text", text: JSON.stringify({ nodes: result.map((r) => r.n), count: result.length }, null, 2) }],
      };
    }
  );

  // Get neighbors
  server.tool(
    "graph_get_neighbors",
    "Get nodes connected to a specific node",
    {
      name: z.string().describe("Name of the node"),
      relationship_type: z.string().optional().describe("Filter by relationship type"),
      direction: z.enum(["in", "out", "both"]).optional().default("both").describe("Relationship direction"),
    },
    async ({ name, relationship_type, direction }) => {
      let cypher: string;
      if (direction === "out") {
        cypher = `MATCH (n {name: $name})-[r${relationship_type ? ":" + relationship_type : ""}]->(m) RETURN m, type(r) as rel_type`;
      } else if (direction === "in") {
        cypher = `MATCH (n {name: $name})<-[r${relationship_type ? ":" + relationship_type : ""}]-(m) RETURN m, type(r) as rel_type`;
      } else {
        cypher = `MATCH (n {name: $name})-[r${relationship_type ? ":" + relationship_type : ""}]-(m) RETURN m, type(r) as rel_type`;
      }

      const result = await runQuery(cypher, { name });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ source: name, neighbors: result, count: result.length }, null, 2),
          },
        ],
      };
    }
  );

  // Find path
  server.tool(
    "graph_find_path",
    "Find the shortest path between two nodes",
    {
      from_name: z.string().describe("Starting node name"),
      to_name: z.string().describe("Ending node name"),
      max_hops: z.number().optional().default(5).describe("Maximum path length"),
    },
    async ({ from_name, to_name, max_hops }) => {
      const cypher = `
        MATCH path = shortestPath((a {name: $from_name})-[*1..${max_hops}]-(b {name: $to_name}))
        RETURN [n IN nodes(path) | n.name] as nodes,
               [r IN relationships(path) | type(r)] as relationships,
               length(path) as hops
      `;

      const result = await runQuery(cypher, { from_name, to_name });

      if (result.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ status: "no_path", from: from_name, to: to_name, max_hops }, null, 2),
            },
          ],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ path: result[0] }, null, 2) }],
      };
    }
  );

  // Delete node
  server.tool(
    "graph_delete_node",
    "Delete a node and all its relationships",
    {
      name: z.string().describe("Name of the node to delete"),
    },
    async ({ name }) => {
      const result = await runQuery("MATCH (n {name: $name}) DETACH DELETE n RETURN count(n) as deleted", { name });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: result[0]?.deleted > 0 ? "deleted" : "not_found", name }, null, 2),
          },
        ],
      };
    }
  );

  // Update node
  server.tool(
    "graph_update_node",
    "Update properties of an existing node",
    {
      name: z.string().describe("Name of the node to update"),
      properties: z.record(z.any()).describe("Properties to set/update"),
    },
    async ({ name, properties }) => {
      const props = { ...properties, updated_at: new Date().toISOString() };
      const result = await runQuery("MATCH (n {name: $name}) SET n += $props RETURN n", { name, props });

      if (result.length === 0) {
        return {
          content: [{ type: "text", text: JSON.stringify({ status: "not_found", name }, null, 2) }],
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ status: "updated", node: result[0].n }, null, 2) }],
      };
    }
  );
}
