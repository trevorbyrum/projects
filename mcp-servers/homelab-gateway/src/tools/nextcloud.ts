import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const NC_URL = process.env.NEXTCLOUD_URL || "http://nextcloud";
const NC_USER = process.env.NEXTCLOUD_USER || "admin";
const NC_PASS = process.env.NEXTCLOUD_APP_PASSWORD || "";
const DAV_BASE = `${NC_URL}/remote.php/dav/files/${NC_USER}`;
const NC_PUBLIC_URL = process.env.NEXTCLOUD_PUBLIC_URL || "https://your-domain.com";

function authHeader(): string {
  return "Basic " + Buffer.from(`${NC_USER}:${NC_PASS}`).toString("base64");
}

async function davFetch(path: string, options: RequestInit = {}): Promise<Response> {
  const url = `${DAV_BASE}${path.startsWith("/") ? path : "/" + path}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: authHeader(),
      ...options.headers,
    },
  });
  return response;
}

// ── Exported Helpers (for use by other modules) ─────────────

/**
 * Upload a file to Nextcloud via WebDAV. Fail-soft: returns error on failure, never throws.
 */
export async function ncUploadFile(
  path: string,
  body: Buffer | string,
  contentType?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const res = await davFetch(path, {
      method: "PUT",
      body: typeof body === "string" ? body : new Uint8Array(body),
      headers: { "Content-Type": contentType || "application/octet-stream" },
    });
    if (!res.ok && res.status !== 201 && res.status !== 204) {
      const text = await res.text();
      return { success: false, error: `Upload failed (${res.status}): ${text}` };
    }
    return { success: true };
  } catch (e: any) {
    return { success: false, error: e.message };
  }
}

/**
 * Ensure a folder path exists in Nextcloud (recursive MKCOL). Fail-soft.
 */
export async function ncEnsureFolder(folderPath: string): Promise<boolean> {
  try {
    const parts = folderPath.replace(/^\//, "").split("/");
    let current = "";
    for (const part of parts) {
      current += "/" + part;
      const res = await davFetch(current, { method: "MKCOL" });
      // 405 = already exists, which is fine
      if (!res.ok && res.status !== 405) {
        console.error(`[nextcloud] Failed creating ${current} (${res.status})`);
        return false;
      }
    }
    return true;
  } catch (e: any) {
    console.error(`[nextcloud] ncEnsureFolder error: ${e.message}`);
    return false;
  }
}

/**
 * Construct a Nextcloud Files URL for a given folder path.
 */
export function ncPublicUrl(folderPath: string): string {
  const encoded = encodeURIComponent(folderPath);
  return `${NC_PUBLIC_URL}/index.php/apps/files/?dir=${encoded}`;
}

function parseMultistatus(xml: string): Array<{ href: string; name: string; type: "file" | "directory"; size?: number; modified?: string; etag?: string; contentType?: string }> {
  const items: Array<{ href: string; name: string; type: "file" | "directory"; size?: number; modified?: string; etag?: string; contentType?: string }> = [];
  const responseRegex = /<d:response>([\s\S]*?)<\/d:response>/g;
  let match;
  while ((match = responseRegex.exec(xml)) !== null) {
    const block = match[1];
    const href = block.match(/<d:href>([^<]+)<\/d:href>/)?.[1] || "";
    const isCollection = block.includes("<d:collection/>");
    const size = block.match(/<d:getcontentlength>(\d+)<\/d:getcontentlength>/)?.[1];
    const modified = block.match(/<d:getlastmodified>([^<]+)<\/d:getlastmodified>/)?.[1];
    const etag = block.match(/<d:getetag>"?([^"<]+)"?<\/d:getetag>/)?.[1];
    const contentType = block.match(/<d:getcontenttype>([^<]+)<\/d:getcontenttype>/)?.[1];
    const decodedHref = decodeURIComponent(href);
    const name = decodedHref.replace(/\/$/, "").split("/").pop() || "";
    items.push({
      href: decodedHref,
      name,
      type: isCollection ? "directory" : "file",
      ...(size ? { size: parseInt(size) } : {}),
      ...(modified ? { modified } : {}),
      ...(etag ? { etag } : {}),
      ...(contentType ? { contentType } : {}),
    });
  }
  return items;
}

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
  upload_file: {
    description: "Upload content to a Nextcloud path",
    params: {
      path: "string - destination path e.g. /Projects/doc.md",
      content: "string - file content (utf8 text or base64 for binary)",
      base64: "boolean (optional) - true if content is base64-encoded",
    },
    handler: async ({ path, content, base64 }) => {
      const body = base64 ? Buffer.from(content, "base64") : content;
      const res = await davFetch(path, {
        method: "PUT",
        body,
        headers: { "Content-Type": "application/octet-stream" },
      });
      if (!res.ok && res.status !== 201 && res.status !== 204) {
        throw new Error(`Upload failed (${res.status}): ${await res.text()}`);
      }
      return { status: "uploaded", path, size: typeof body === "string" ? body.length : body.byteLength };
    },
  },

  download_file: {
    description: "Download file content from Nextcloud",
    params: {
      path: "string - file path e.g. /Documents/report.pdf",
      base64: "boolean (optional) - return as base64 instead of utf8",
    },
    handler: async ({ path, base64 }) => {
      const res = await davFetch(path, { method: "GET" });
      if (!res.ok) throw new Error(`Download failed (${res.status}): ${await res.text()}`);
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        path,
        size: buf.byteLength,
        content: base64 ? buf.toString("base64") : buf.toString("utf8"),
        encoding: base64 ? "base64" : "utf8",
      };
    },
  },

  list_folder: {
    description: "List contents of a Nextcloud directory",
    params: {
      path: "string (optional) - folder path, default /",
      depth: "number (optional) - 0=self, 1=children (default), infinity=recursive",
    },
    handler: async ({ path, depth }) => {
      const folderPath = path || "/";
      const d = depth !== undefined ? String(depth) : "1";
      const res = await davFetch(folderPath.endsWith("/") ? folderPath : folderPath + "/", {
        method: "PROPFIND",
        headers: { Depth: d, "Content-Type": "application/xml" },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><d:prop><d:getlastmodified/><d:getcontentlength/><d:resourcetype/><d:getetag/><d:getcontenttype/></d:prop></d:propfind>`,
      });
      if (!res.ok) throw new Error(`List failed (${res.status}): ${await res.text()}`);
      const xml = await res.text();
      const items = parseMultistatus(xml);
      // Skip first item (the folder itself) when depth > 0
      return items.length > 1 ? items.slice(1) : items;
    },
  },

  create_folder: {
    description: "Create a directory in Nextcloud",
    params: {
      path: "string - folder path to create e.g. /Projects/new-project",
      recursive: "boolean (optional) - create parent dirs if needed",
    },
    handler: async ({ path, recursive }) => {
      if (recursive) {
        const parts = path.replace(/^\//, "").split("/");
        let current = "";
        for (const part of parts) {
          current += "/" + part;
          const res = await davFetch(current, { method: "MKCOL" });
          if (!res.ok && res.status !== 405) {
            throw new Error(`Failed creating ${current} (${res.status}): ${await res.text()}`);
          }
        }
        return { status: "created", path };
      }
      const res = await davFetch(path, { method: "MKCOL" });
      if (!res.ok && res.status !== 405) {
        throw new Error(`Create folder failed (${res.status}): ${await res.text()}`);
      }
      return { status: res.status === 405 ? "already_exists" : "created", path };
    },
  },

  delete_item: {
    description: "Delete a file or folder from Nextcloud",
    params: { path: "string - path to delete" },
    handler: async ({ path }) => {
      const res = await davFetch(path, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        throw new Error(`Delete failed (${res.status}): ${await res.text()}`);
      }
      return { status: res.status === 404 ? "not_found" : "deleted", path };
    },
  },

  move_item: {
    description: "Move or rename a file or folder",
    params: {
      from: "string - source path",
      to: "string - destination path",
      overwrite: "boolean (optional) - overwrite if exists, default false",
    },
    handler: async ({ from, to, overwrite }) => {
      const destUrl = `${DAV_BASE}${to.startsWith("/") ? to : "/" + to}`;
      const res = await davFetch(from, {
        method: "MOVE",
        headers: {
          Destination: destUrl,
          Overwrite: overwrite ? "T" : "F",
        },
      });
      if (!res.ok) throw new Error(`Move failed (${res.status}): ${await res.text()}`);
      return { status: "moved", from, to };
    },
  },

  get_quota: {
    description: "Show storage usage and available space",
    params: {},
    handler: async () => {
      const res = await davFetch("/", {
        method: "PROPFIND",
        headers: { Depth: "0", "Content-Type": "application/xml" },
        body: `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:quota-used-bytes/><d:quota-available-bytes/></d:prop></d:propfind>`,
      });
      if (!res.ok) throw new Error(`Quota check failed (${res.status}): ${await res.text()}`);
      const xml = await res.text();
      const used = parseInt(xml.match(/<d:quota-used-bytes>(-?\d+)<\/d:quota-used-bytes>/)?.[1] || "0");
      const available = parseInt(xml.match(/<d:quota-available-bytes>(-?\d+)<\/d:quota-available-bytes>/)?.[1] || "0");
      return {
        used_bytes: used,
        used_human: `${(used / 1024 / 1024).toFixed(1)} MB`,
        available_bytes: available,
        available_human: available < 0 ? "unlimited" : `${(available / 1024 / 1024 / 1024).toFixed(1)} GB`,
      };
    },
  },

  search: {
    description: "Search files by name pattern",
    params: { query: "string - search term (substring match on filename)" },
    handler: async ({ query }) => {
      const res = await davFetch("/", {
        method: "REPORT",
        headers: { "Content-Type": "application/xml" },
        body: `<?xml version="1.0"?><oc:filter-files xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns"><oc:filter-rules><oc:name>%${query}%</oc:name></oc:filter-rules><d:prop><d:getlastmodified/><d:getcontentlength/><d:resourcetype/><d:getetag/><d:getcontenttype/></d:prop></oc:filter-files>`,
      });
      if (!res.ok) throw new Error(`Search failed (${res.status}): ${await res.text()}`);
      const xml = await res.text();
      return parseMultistatus(xml);
    },
  },
};

export function registerNextcloudTools(server: McpServer) {
  server.tool("nextcloud_list", "List all available Nextcloud tools and their parameters", {}, async () => {
    const toolList = Object.entries(tools).map(([name, def]) => ({
      tool: name,
      description: def.description,
      params: def.params,
    }));
    return { content: [{ type: "text", text: JSON.stringify(toolList, null, 2) }] };
  });

  server.tool("nextcloud_call", "Execute a Nextcloud tool. Use nextcloud_list to see available tools.", {
    tool: z.string().describe("Tool name from nextcloud_list"),
    params: z.record(z.any()).optional().describe("Tool parameters"),
  }, async ({ tool, params }) => {
    const toolDef = tools[tool];
    if (!toolDef) {
      return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${tool}`, available: Object.keys(tools) }) }] };
    }
    try {
      const result = await toolDef.handler(params || {});
      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
    }
  });
}

