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

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any, extra?: any) => Promise<any> }> = {
  create_node: {
    description: "Create a new node in the knowledge graph",
    params: { label: "Node label (e.g., Concept, Person, Project)", name: "Unique name for the node", properties: "JSON object of additional properties (optional)" },
    handler: async ({ label, name, properties }) => {
      const now = new Date().toISOString();
      const props = { name, ...(properties ? (typeof properties === "string" ? JSON.parse(properties) : properties) : {}), created_at: now, recorded_at: now, observations: [] };
      const result = await runQuery(`CREATE (n:${label} $props) RETURN n`, { props });
      return { status: "created", node: result[0]?.n };
    },
  },
  create_relationship: {
    description: "Create a relationship between two nodes",
    params: { from_name: "Source node name", to_name: "Target node name", type: "Relationship type (e.g., KNOWS, CONTAINS)", properties: "JSON object of relationship properties (optional)" },
    handler: async ({ from_name, to_name, type, properties }) => {
      const now = new Date().toISOString();
      const props = { ...(properties ? (typeof properties === "string" ? JSON.parse(properties) : properties) : {}), created_at: now, recorded_at: now };
      const cypher = `MATCH (a {name: $from_name}), (b {name: $to_name}) CREATE (a)-[r:${type} $props]->(b) RETURN a.name as from, type(r) as relationship, b.name as to`;
      const result = await runQuery(cypher, { from_name, to_name, props });
      if (result.length === 0) return { status: "error", message: "One or both nodes not found" };
      return { status: "created", ...result[0] };
    },
  },
  query: {
    description: "Execute a raw Cypher query against Neo4j",
    params: { cypher: "The Cypher query to execute", params: "JSON object of query parameters (optional)" },
    handler: async ({ cypher, params }) => {
      const parsedParams = params ? (typeof params === "string" ? JSON.parse(params) : params) : {};
      const result = await runQuery(cypher, parsedParams);
      return { results: result, count: result.length };
    },
  },
  find_node: {
    description: "Find nodes by label and/or properties",
    params: { label: "Filter by label (optional)", name: "Filter by name (optional)", properties: "JSON object to filter by (optional)" },
    handler: async ({ label, name, properties }) => {
      let cypher = "MATCH (n";
      if (label) cypher += `:${label}`;
      cypher += ")";

      const conditions: string[] = [];
      const params: any = {};
      if (name) { conditions.push("n.name = $name"); params.name = name; }
      if (properties) {
        const props = typeof properties === "string" ? JSON.parse(properties) : properties;
        Object.entries(props).forEach(([key, value], i) => {
          conditions.push(`n.${key} = $prop_${i}`);
          params[`prop_${i}`] = value;
        });
      }
      if (conditions.length > 0) cypher += ` WHERE ${conditions.join(" AND ")}`;
      cypher += " RETURN n LIMIT 50";

      const result = await runQuery(cypher, params);
      return { nodes: result.map((r) => r.n), count: result.length };
    },
  },
  get_neighbors: {
    description: "Get nodes connected to a specific node",
    params: { name: "Node name", relationship_type: "Filter by relationship type (optional)", direction: "Relationship direction: in, out, or both (default: both)" },
    handler: async ({ name, relationship_type, direction = "both" }) => {
      let cypher: string;
      const relType = relationship_type ? `:${relationship_type}` : "";
      if (direction === "out") {
        cypher = `MATCH (n {name: $name})-[r${relType}]->(m) RETURN m, type(r) as rel_type`;
      } else if (direction === "in") {
        cypher = `MATCH (n {name: $name})<-[r${relType}]-(m) RETURN m, type(r) as rel_type`;
      } else {
        cypher = `MATCH (n {name: $name})-[r${relType}]-(m) RETURN m, type(r) as rel_type`;
      }
      const result = await runQuery(cypher, { name });
      return { source: name, neighbors: result, count: result.length };
    },
  },
  find_path: {
    description: "Find the shortest path between two nodes",
    params: { from_name: "Starting node name", to_name: "Ending node name", max_hops: "Maximum path length (default: 5)" },
    handler: async ({ from_name, to_name, max_hops = 5 }) => {
      const cypher = `MATCH path = shortestPath((a {name: $from_name})-[*1..${max_hops}]-(b {name: $to_name}))
        RETURN [n IN nodes(path) | n.name] as nodes, [r IN relationships(path) | type(r)] as relationships, length(path) as hops`;
      const result = await runQuery(cypher, { from_name, to_name });
      if (result.length === 0) return { status: "no_path", from: from_name, to: to_name, max_hops };
      return { path: result[0] };
    },
  },
  delete_node: {
    description: "Delete a node and all its relationships",
    params: { name: "Name of the node to delete" },
    handler: async ({ name }) => {
      const result = await runQuery("MATCH (n {name: $name}) DETACH DELETE n RETURN count(n) as deleted", { name });
      return { status: result[0]?.deleted > 0 ? "deleted" : "not_found", name };
    },
  },
  update_node: {
    description: "Update properties of an existing node",
    params: { name: "Name of the node to update", properties: "JSON object of properties to set/update" },
    handler: async ({ name, properties }) => {
      const now = new Date().toISOString();
      const props = { ...(typeof properties === "string" ? JSON.parse(properties) : properties), updated_at: now, recorded_at: now };
      const result = await runQuery("MATCH (n {name: $name}) SET n += $props RETURN n", { name, props });
      if (result.length === 0) return { status: "not_found", name };
      return { status: "updated", node: result[0].n };
    },
  },
  add_observation: {
    description: "Append a timestamped observation to a node's observations array",
    params: { name: "Node name to add observation to", observation: "The observation text to record" },
    handler: async ({ name, observation }) => {
      const now = new Date().toISOString();
      const date = now.split("T")[0]; // YYYY-MM-DD
      const formatted = `${date}: ${observation}`;
      const result = await runQuery(
        "MATCH (n {name: $name}) SET n.observations = COALESCE(n.observations, []) + $observation, n.updated_at = $updated_at RETURN n",
        { name, observation: formatted, updated_at: now }
      );
      if (result.length === 0) return { status: "not_found", name };
      return { status: "observation_added", node: result[0].n, observation: formatted };
    },
  },
};

const GRAPH_CALL_DESCRIPTION = `Knowledge graph for structural relationships between projects, infrastructure, people, and events. Neo4j captures what connects to what — dependencies, overlap, progression, and causation. Qdrant stores the rich narrative; Neo4j stores the structure. They cross-reference via entity name tags in Qdrant payloads — search Qdrant by entity name to find the narrative for any Neo4j node.

When to write: When conversation reveals relationships between entities. When writing to both stores, store Qdrant first (for the narrative), then create/update Neo4j nodes and relationships.

Always search first. If an entity exists, append to its observations rather than creating a duplicate. Match by name (case-insensitive).

Read-side routing: Search Neo4j for structural queries — "what depends on X", "what's connected to Y", "what's blocking Z", "what overlaps between A and B". If the query is fuzzy or narrative ("what did we discuss about...", "why did we decide..."), search Qdrant instead. If you need the full picture, search Qdrant first, then traverse Neo4j from the entity names found.

Naming convention: Use consistent casing per label.
- Projects: PascalCase (PhysicianUX, FenceQuote)
- Technologies/libraries: as commonly written (n8n, Neo4j, pgvector, SwiftUI)
- People: full name (Jane Doe)
- Events: short descriptive phrase (gpu-failure-jan-2025, chose-qdrant-over-weaviate)

Node labels (lowercase): project, component, technology, person, event, library

Node properties:
- name — required, unique per label
- type — subtype within label:
    event: decision | milestone | blocker | discovery
    component: workflow | module | feature | endpoint
    technology: container | service | hardware | api | platform
    library: sdk | framework | package
- status — discussion | planned | in_progress | built | abandoned (update in place)
- observations — array of string facts, append only via add_observation sub-tool. Gateway auto-timestamps each as: "YYYY-MM-DD: fact here"
- created_at — auto-injected by gateway
- occurred_at — when it happened in real world (set manually if different from created_at)

Event node vs observation — the reification test:
- If a fact describes ONE entity and doesn't connect to anything else → append as an observation. Examples: "GPU has 48GB VRAM", "n8n is on version 1.72"
- If a fact connects MULTIPLE entities or causes downstream effects → create an event node with relationships. Examples: "GPU failure" (BLOCKED_BY→Ollama, TRIGGERED→workaround), "Chose Qdrant over Weaviate" (DECIDED_FOR→Qdrant, DECIDED_AGAINST→Weaviate)
- Test: "Does this fact need relationships to other nodes to be meaningful?" Yes → event. No → observation.

Relationship types (UPPER_SNAKE_CASE):
- USES — project→technology, project→library (actively using it)
- REQUIRES — project→technology (needs but may not have yet, or resource contention)
- DEPENDS_ON — component→technology, library→library (would break without)
- PART_OF — component→project, component→component
- DECIDED_FOR / DECIDED_AGAINST — event(decision)→technology, component, or library
- INFORMED_BY — event(decision)→event or component (what influenced the decision)
- BLOCKED_BY — project or component→event(blocker)
- TRIGGERED — event→event (causation)
- PRECEDED — event→event (temporal sequence without causation)
- COLLABORATES_WITH — person→project (role property: lead | manager | contributor)
- REPLACED — event(decision)→event(decision), technology→technology

Relationship properties: since, until, role, reason, recorded_at where meaningful. Gateway auto-injects recorded_at on relationship creates.

Pattern: Search → Create/Update → Connect. Every new entity needs at least one relationship. Use depth 2+ when searching to discover context through the graph.

When Neo4j only: Structural changes with no significant narrative context (simple new relationship between existing nodes, status update).

Note: The gateway auto-injects recorded_at on every write. You do not need to include timestamps in your tool calls.`;

export function registerGraphTools(server: McpServer) {
  server.tool(
    "graph_list",
    "List all available Neo4j knowledge graph tools",
    {},
    async () => {
      const toolList = Object.entries(tools).map(([name, def]) => ({
        tool: name,
        description: def.description,
        params: def.params,
      }));
      return { content: [{ type: "text", text: JSON.stringify(toolList, null, 2) }] };
    }
  );

  server.tool(
    "graph_call",
    GRAPH_CALL_DESCRIPTION,
    {
      tool: z.string().describe("Tool name from graph_list"),
      params: z.record(z.any()).optional().describe("Tool parameters as object"),
    },
    async ({ tool, params }, extra) => {
      const toolDef = tools[tool];
      if (!toolDef) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${tool}`, available: Object.keys(tools) }) }] };
      }
      try {
        const result = await toolDef.handler(params || {}, extra);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
      }
    }
  );
}
