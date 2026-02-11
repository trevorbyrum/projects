import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const FIGMA_API_KEY = process.env.FIGMA_API_KEY || "";
const FIGMA_BASE = "https://api.figma.com";

async function figmaFetch(path: string, method = "GET", body?: any): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: {
      "X-Figma-Token": FIGMA_API_KEY,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${FIGMA_BASE}${path}`, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Figma ${method} ${path}: ${res.status} - ${text}`);
  }
  if (res.status === 204) return { success: true };
  return res.json();
}

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
  get_file: {
    description: "Get a Figma file by key. Use depth to limit response size (1=pages only, 2=top-level frames). Returns document structure, components, styles.",
    params: {
      file_key: "Figma file key (from URL: figma.com/file/{file_key}/...)",
      depth: "(optional) Tree depth to return. Start with 1-2 for large files to avoid huge responses",
      branch_data: "(optional) 'true' to include branch metadata",
    },
    handler: async ({ file_key, depth, branch_data }) => {
      const params = new URLSearchParams();
      if (depth) params.set("depth", depth);
      if (branch_data) params.set("branch_data", branch_data);
      const qs = params.toString() ? `?${params}` : "";
      return figmaFetch(`/v1/files/${file_key}${qs}`);
    },
  },

  get_file_nodes: {
    description: "Get specific nodes from a Figma file by node IDs. More efficient than fetching the full file when you know which frames/components you need.",
    params: {
      file_key: "Figma file key",
      ids: "Comma-separated node IDs (e.g., '1:2,3:4')",
      depth: "(optional) Tree depth within each node",
    },
    handler: async ({ file_key, ids, depth }) => {
      const params = new URLSearchParams({ ids });
      if (depth) params.set("depth", depth);
      return figmaFetch(`/v1/files/${file_key}/nodes?${params}`);
    },
  },

  get_images: {
    description: "Render specific nodes as images (PNG, SVG, JPG, PDF). Returns URLs to rendered images.",
    params: {
      file_key: "Figma file key",
      ids: "Comma-separated node IDs to render",
      format: "(optional) 'png' (default), 'svg', 'jpg', or 'pdf'",
      scale: "(optional) Image scale 0.01-4 (default 1)",
    },
    handler: async ({ file_key, ids, format, scale }) => {
      const params = new URLSearchParams({ ids });
      if (format) params.set("format", format);
      if (scale) params.set("scale", scale);
      return figmaFetch(`/v1/images/${file_key}?${params}`);
    },
  },

  get_image_fills: {
    description: "Get download URLs for all images used as fills in a file",
    params: { file_key: "Figma file key" },
    handler: async ({ file_key }) => figmaFetch(`/v1/files/${file_key}/images`),
  },

  get_comments: {
    description: "List all comments on a Figma file",
    params: {
      file_key: "Figma file key",
      as_md: "(optional) 'true' to return comments as markdown",
    },
    handler: async ({ file_key, as_md }) => {
      const params = new URLSearchParams();
      if (as_md) params.set("as_md", as_md);
      const qs = params.toString() ? `?${params}` : "";
      return figmaFetch(`/v1/files/${file_key}/comments${qs}`);
    },
  },

  post_comment: {
    description: "Add a comment to a Figma file. Can pin to a specific location or node.",
    params: {
      file_key: "Figma file key",
      message: "Comment text (supports basic markdown)",
      client_meta: "(optional) JSON object with position {node_id, node_offset: {x, y}} to pin comment to a specific frame/node",
      comment_id: "(optional) Parent comment ID to reply to",
    },
    handler: async ({ file_key, message, client_meta, comment_id }) => {
      const body: any = { message };
      if (client_meta) body.client_meta = typeof client_meta === "string" ? JSON.parse(client_meta) : client_meta;
      if (comment_id) body.comment_id = comment_id;
      return figmaFetch(`/v1/files/${file_key}/comments`, "POST", body);
    },
  },

  delete_comment: {
    description: "Delete a comment from a Figma file",
    params: {
      file_key: "Figma file key",
      comment_id: "Comment ID to delete",
    },
    handler: async ({ file_key, comment_id }) =>
      figmaFetch(`/v1/files/${file_key}/comments/${comment_id}`, "DELETE"),
  },

  get_file_versions: {
    description: "Get version history of a Figma file",
    params: { file_key: "Figma file key" },
    handler: async ({ file_key }) => figmaFetch(`/v1/files/${file_key}/versions`),
  },

  get_team_projects: {
    description: "List all projects in a Figma team",
    params: { team_id: "Team ID (from team URL or admin settings)" },
    handler: async ({ team_id }) => figmaFetch(`/v1/teams/${team_id}/projects`),
  },

  get_project_files: {
    description: "List all files in a Figma project",
    params: {
      project_id: "Project ID",
      branch_data: "(optional) 'true' to include branch metadata",
    },
    handler: async ({ project_id, branch_data }) => {
      const params = new URLSearchParams();
      if (branch_data) params.set("branch_data", branch_data);
      const qs = params.toString() ? `?${params}` : "";
      return figmaFetch(`/v1/projects/${project_id}/files${qs}`);
    },
  },

  get_file_components: {
    description: "Get all components published from a file (component library)",
    params: { file_key: "Figma file key" },
    handler: async ({ file_key }) => figmaFetch(`/v1/files/${file_key}/components`),
  },

  get_file_component_sets: {
    description: "Get all component sets (variant groups) published from a file",
    params: { file_key: "Figma file key" },
    handler: async ({ file_key }) => figmaFetch(`/v1/files/${file_key}/component_sets`),
  },

  get_file_styles: {
    description: "Get all styles published from a file (colors, text, effects, grids)",
    params: { file_key: "Figma file key" },
    handler: async ({ file_key }) => figmaFetch(`/v1/files/${file_key}/styles`),
  },

  get_team_components: {
    description: "Get all published components across a team's libraries. Paginated.",
    params: {
      team_id: "Team ID",
      page_size: "(optional) Results per page (default 30, max 50)",
      cursor: "(optional) Pagination cursor from previous response",
    },
    handler: async ({ team_id, page_size, cursor }) => {
      const params = new URLSearchParams();
      if (page_size) params.set("page_size", page_size);
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString() ? `?${params}` : "";
      return figmaFetch(`/v1/teams/${team_id}/components${qs}`);
    },
  },

  get_team_styles: {
    description: "Get all published styles across a team's libraries. Paginated.",
    params: {
      team_id: "Team ID",
      page_size: "(optional) Results per page (default 30, max 50)",
      cursor: "(optional) Pagination cursor from previous response",
    },
    handler: async ({ team_id, page_size, cursor }) => {
      const params = new URLSearchParams();
      if (page_size) params.set("page_size", page_size);
      if (cursor) params.set("cursor", cursor);
      const qs = params.toString() ? `?${params}` : "";
      return figmaFetch(`/v1/teams/${team_id}/styles${qs}`);
    },
  },
};

export function registerFigmaTools(server: McpServer) {
  server.tool(
    "figma_list",
    "List all available Figma design tools",
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
    "figma_call",
    "Interact with Figma designs — read files, extract components/styles, render images, manage comments. Use figma_list to see available tools.",
    {
      tool: z.string().describe("Tool name from figma_list"),
      params: z.record(z.any()).optional().describe("Tool parameters as object"),
    },
    async ({ tool: toolName, params }) => {
      const toolDef = tools[toolName];
      if (!toolDef) {
        const available = Object.keys(tools).join(", ");
        throw new Error(`Unknown figma tool: ${toolName}. Available: ${available}`);
      }
      const result = await toolDef.handler(params || {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }
  );
}
