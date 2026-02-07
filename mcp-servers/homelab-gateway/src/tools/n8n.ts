import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const N8N_API_URL = process.env.N8N_API_URL || "https://n8n.8-bit-byrum.com";
const N8N_API_KEY = process.env.N8N_API_KEY || "";

async function n8nFetch(endpoint: string, options: RequestInit = {}) {
  const url = `${N8N_API_URL}/api/v1${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": N8N_API_KEY,
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`n8n API error (${response.status}): ${error}`);
  }
  return response.json();
}

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
  list_workflows: {
    description: "List all n8n workflows with optional filters",
    params: { active_only: "Only show active workflows (true/false)", limit: "Max number to return" },
    handler: async ({ active_only, limit }) => {
      const params = new URLSearchParams();
      if (limit) params.set("limit", String(limit));
      let data = await n8nFetch(`/workflows?${params}`);
      if (active_only === "true" && data.data) {
        data.data = data.data.filter((w: any) => w.active);
      }
      return data;
    },
  },
  get_workflow: {
    description: "Get a specific workflow by ID",
    params: { workflow_id: "The workflow ID" },
    handler: async ({ workflow_id }) => await n8nFetch(`/workflows/${workflow_id}`),
  },
  create_workflow: {
    description: "Create a new n8n workflow",
    params: { name: "Workflow name", nodes: "JSON array of node definitions", connections: "JSON object of connections", settings: "JSON object of settings" },
    handler: async ({ name, nodes, connections, settings }) => {
      const workflow = {
        name,
        nodes: typeof nodes === "string" ? JSON.parse(nodes) : nodes,
        connections: connections ? (typeof connections === "string" ? JSON.parse(connections) : connections) : {},
        settings: settings ? (typeof settings === "string" ? JSON.parse(settings) : settings) : {},
      };
      return await n8nFetch("/workflows", { method: "POST", body: JSON.stringify(workflow) });
    },
  },
  update_workflow: {
    description: "Update an existing n8n workflow",
    params: { workflow_id: "The workflow ID", name: "New name (optional)", nodes: "Updated nodes JSON (optional)" },
    handler: async ({ workflow_id, name, nodes }) => {
      const existing = await n8nFetch(`/workflows/${workflow_id}`);
      const updated = { ...existing, ...(name && { name }), ...(nodes && { nodes: typeof nodes === "string" ? JSON.parse(nodes) : nodes }) };
      return await n8nFetch(`/workflows/${workflow_id}`, { method: "PUT", body: JSON.stringify(updated) });
    },
  },
  delete_workflow: {
    description: "Delete an n8n workflow",
    params: { workflow_id: "The workflow ID to delete" },
    handler: async ({ workflow_id }) => {
      await n8nFetch(`/workflows/${workflow_id}`, { method: "DELETE" });
      return { status: "deleted", workflow_id };
    },
  },
  activate_workflow: {
    description: "Activate an n8n workflow",
    params: { workflow_id: "The workflow ID to activate" },
    handler: async ({ workflow_id }) => await n8nFetch(`/workflows/${workflow_id}/activate`, { method: "POST" }),
  },
  deactivate_workflow: {
    description: "Deactivate an n8n workflow",
    params: { workflow_id: "The workflow ID to deactivate" },
    handler: async ({ workflow_id }) => await n8nFetch(`/workflows/${workflow_id}/deactivate`, { method: "POST" }),
  },
  execute_workflow: {
    description: "Execute/trigger an n8n workflow with optional input data",
    params: { workflow_id: "The workflow ID to execute", payload: "JSON object of input data (optional)" },
    handler: async ({ workflow_id, payload }) => {
      const body = payload ? (typeof payload === "string" ? JSON.parse(payload) : payload) : {};
      return await n8nFetch(`/workflows/${workflow_id}/run`, { method: "POST", body: JSON.stringify(body) });
    },
  },
  get_execution: {
    description: "Get details of a specific workflow execution",
    params: { execution_id: "The execution ID" },
    handler: async ({ execution_id }) => await n8nFetch(`/executions/${execution_id}`),
  },
  list_executions: {
    description: "List workflow execution history",
    params: { workflow_id: "Filter by workflow ID (optional)", status: "Filter by status: success/error/waiting (optional)", limit: "Max number to return" },
    handler: async ({ workflow_id, status, limit }) => {
      const params = new URLSearchParams();
      if (workflow_id) params.set("workflowId", workflow_id);
      if (status) params.set("status", status);
      if (limit) params.set("limit", String(limit));
      return await n8nFetch(`/executions?${params}`);
    },
  },
};

export function registerN8nTools(server: McpServer) {
  server.tool(
    "n8n_list",
    "List all available n8n workflow automation tools and their parameters",
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
    "n8n_call",
    "Execute an n8n tool. Use n8n_list to see available tools.",
    {
      tool: z.string().describe("Tool name from n8n_list"),
      params: z.record(z.any()).optional().describe("Tool parameters as object"),
    },
    async ({ tool, params }) => {
      const toolDef = tools[tool];
      if (!toolDef) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${tool}`, available: Object.keys(tools) }) }] };
      }
      try {
        const result = await toolDef.handler(params || {});
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (error: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: error.message }) }], isError: true };
      }
    }
  );
}
