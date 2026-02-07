import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const N8N_API_URL = process.env.N8N_API_URL || "";
const N8N_API_KEY = process.env.N8N_API_KEY || "";

async function n8nFetch(endpoint: string, options: RequestInit = {}) {
  if (!N8N_API_URL) {
    throw new Error("N8N_API_URL not configured");
  }
  if (!N8N_API_KEY) {
    throw new Error("N8N_API_KEY not configured");
  }
  
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

export function registerN8nTools(server: McpServer) {
  // List workflows
  server.tool(
    "n8n_list_workflows",
    "List all n8n workflows with optional filters",
    {
      active_only: z.boolean().optional().describe("Only show active workflows"),
      limit: z.number().optional().describe("Maximum number of workflows to return"),
    },
    async ({ active_only, limit }) => {
      const params = new URLSearchParams();
      if (limit) params.set("limit", String(limit));

      let data = await n8nFetch(`/workflows?${params}`);

      if (active_only && data.data) {
        data.data = data.data.filter((w: any) => w.active);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // Get workflow by ID
  server.tool(
    "n8n_get_workflow",
    "Get a specific workflow by ID",
    {
      workflow_id: z.string().describe("The workflow ID"),
    },
    async ({ workflow_id }) => {
      const data = await n8nFetch(`/workflows/${workflow_id}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // Create workflow
  server.tool(
    "n8n_create_workflow",
    "Create a new n8n workflow",
    {
      name: z.string().describe("Workflow name"),
      nodes: z.array(z.any()).describe("Array of node definitions"),
      connections: z.record(z.any()).optional().describe("Node connections"),
      settings: z.record(z.any()).optional().describe("Workflow settings"),
    },
    async ({ name, nodes, connections, settings }) => {
      const workflow = {
        name,
        nodes,
        connections: connections || {},
        settings: settings || {},
      };

      const data = await n8nFetch("/workflows", {
        method: "POST",
        body: JSON.stringify(workflow),
      });

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // Update workflow
  server.tool(
    "n8n_update_workflow",
    "Update an existing n8n workflow",
    {
      workflow_id: z.string().describe("The workflow ID to update"),
      name: z.string().optional().describe("New workflow name"),
      nodes: z.array(z.any()).optional().describe("Updated node definitions"),
      connections: z.record(z.any()).optional().describe("Updated connections"),
      settings: z.record(z.any()).optional().describe("Updated settings"),
    },
    async ({ workflow_id, name, nodes, connections, settings }) => {
      // First get existing workflow
      const existing = await n8nFetch(`/workflows/${workflow_id}`);

      const updated = {
        ...existing,
        ...(name && { name }),
        ...(nodes && { nodes }),
        ...(connections && { connections }),
        ...(settings && { settings }),
      };

      const data = await n8nFetch(`/workflows/${workflow_id}`, {
        method: "PUT",
        body: JSON.stringify(updated),
      });

      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // Delete workflow
  server.tool(
    "n8n_delete_workflow",
    "Delete an n8n workflow",
    {
      workflow_id: z.string().describe("The workflow ID to delete"),
    },
    async ({ workflow_id }) => {
      await n8nFetch(`/workflows/${workflow_id}`, { method: "DELETE" });
      return {
        content: [{ type: "text", text: JSON.stringify({ status: "deleted", workflow_id }) }],
      };
    }
  );

  // Activate workflow
  server.tool(
    "n8n_activate_workflow",
    "Activate an n8n workflow",
    {
      workflow_id: z.string().describe("The workflow ID to activate"),
    },
    async ({ workflow_id }) => {
      const data = await n8nFetch(`/workflows/${workflow_id}/activate`, {
        method: "POST",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // Deactivate workflow
  server.tool(
    "n8n_deactivate_workflow",
    "Deactivate an n8n workflow",
    {
      workflow_id: z.string().describe("The workflow ID to deactivate"),
    },
    async ({ workflow_id }) => {
      const data = await n8nFetch(`/workflows/${workflow_id}/deactivate`, {
        method: "POST",
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // Execute workflow
  server.tool(
    "n8n_execute_workflow",
    "Execute/trigger an n8n workflow with optional input data",
    {
      workflow_id: z.string().describe("The workflow ID to execute"),
      payload: z.record(z.any()).optional().describe("Input data for the workflow"),
    },
    async ({ workflow_id, payload }) => {
      const data = await n8nFetch(`/workflows/${workflow_id}/run`, {
        method: "POST",
        body: JSON.stringify(payload || {}),
      });
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // Get execution
  server.tool(
    "n8n_get_execution",
    "Get details of a specific workflow execution",
    {
      execution_id: z.string().describe("The execution ID"),
    },
    async ({ execution_id }) => {
      const data = await n8nFetch(`/executions/${execution_id}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );

  // List executions
  server.tool(
    "n8n_list_executions",
    "List workflow execution history",
    {
      workflow_id: z.string().optional().describe("Filter by workflow ID"),
      status: z.enum(["success", "error", "waiting"]).optional().describe("Filter by status"),
      limit: z.number().optional().describe("Maximum number of executions to return"),
    },
    async ({ workflow_id, status, limit }) => {
      const params = new URLSearchParams();
      if (workflow_id) params.set("workflowId", workflow_id);
      if (status) params.set("status", status);
      if (limit) params.set("limit", String(limit));

      const data = await n8nFetch(`/executions?${params}`);
      return {
        content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
      };
    }
  );
}
