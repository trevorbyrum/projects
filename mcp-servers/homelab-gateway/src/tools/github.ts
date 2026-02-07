import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const GITHUB_API = "https://api.github.com";

async function githubRequest(method: string, path: string, body?: any): Promise<any> {
  if (!GITHUB_TOKEN) {
    throw new Error("GitHub not configured - check GITHUB_TOKEN env var");
  }
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      "Authorization": `Bearer ${GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`GitHub API error: ${response.status} ${error}`);
  }
  return response.json();
}

// Tool definitions with their handlers
const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
  list_repos: {
    description: "List repositories for authenticated user or specified owner",
    params: { owner: "string (optional) - repo owner", type: "all|owner|member (optional)", sort: "created|updated|pushed|full_name (optional)", per_page: "number (optional)" },
    handler: async ({ owner, type, sort, per_page }) => {
      const params = new URLSearchParams();
      if (type) params.append("type", type);
      if (sort) params.append("sort", sort);
      if (per_page) params.append("per_page", per_page.toString());
      const path = owner ? `/users/${owner}/repos?${params}` : `/user/repos?${params}`;
      const repos = await githubRequest("GET", path);
      return repos.map((r: any) => ({ name: r.name, full_name: r.full_name, description: r.description, private: r.private, default_branch: r.default_branch, updated_at: r.updated_at, html_url: r.html_url }));
    }
  },
  get_file: {
    description: "Get contents of a file from a repository",
    params: { owner: "string - repo owner", repo: "string - repo name", path: "string - file path", ref: "string (optional) - branch/tag/sha" },
    handler: async ({ owner, repo, path, ref }) => {
      const params = ref ? `?ref=${ref}` : "";
      const result = await githubRequest("GET", `/repos/${owner}/${repo}/contents/${path}${params}`);
      if (result.type !== "file") return { error: "Path is not a file", type: result.type };
      return Buffer.from(result.content, "base64").toString("utf-8");
    }
  },
  list_contents: {
    description: "List contents of a directory in a repository",
    params: { owner: "string - repo owner", repo: "string - repo name", path: "string (optional) - directory path", ref: "string (optional) - branch/tag/sha" },
    handler: async ({ owner, repo, path, ref }) => {
      const filePath = path || "";
      const params = ref ? `?ref=${ref}` : "";
      const result = await githubRequest("GET", `/repos/${owner}/${repo}/contents/${filePath}${params}`);
      if (!Array.isArray(result)) return { error: "Path is not a directory", type: result.type };
      return result.map((item: any) => ({ name: item.name, path: item.path, type: item.type, size: item.size }));
    }
  },
  put_file: {
    description: "Create or update a file in a repository",
    params: { owner: "string", repo: "string", path: "string", content: "string - file content", message: "string - commit message", branch: "string (optional)", sha: "string (optional) - required for updates" },
    handler: async ({ owner, repo, path, content, message, branch, sha }) => {
      const body: any = { message, content: Buffer.from(content).toString("base64") };
      if (branch) body.branch = branch;
      if (sha) body.sha = sha;
      const result = await githubRequest("PUT", `/repos/${owner}/${repo}/contents/${path}`, body);
      return { status: sha ? "updated" : "created", path: result.content.path, sha: result.content.sha, commit: result.commit.sha, html_url: result.content.html_url };
    }
  },
  delete_file: {
    description: "Delete a file from a repository",
    params: { owner: "string", repo: "string", path: "string", message: "string - commit message", sha: "string - file sha", branch: "string (optional)" },
    handler: async ({ owner, repo, path, message, sha, branch }) => {
      const body: any = { message, sha };
      if (branch) body.branch = branch;
      const result = await githubRequest("DELETE", `/repos/${owner}/${repo}/contents/${path}`, body);
      return { status: "deleted", commit: result.commit.sha };
    }
  },
  list_branches: {
    description: "List branches in a repository",
    params: { owner: "string", repo: "string", per_page: "number (optional)" },
    handler: async ({ owner, repo, per_page }) => {
      const params = per_page ? `?per_page=${per_page}` : "";
      const branches = await githubRequest("GET", `/repos/${owner}/${repo}/branches${params}`);
      return branches.map((b: any) => ({ name: b.name, sha: b.commit.sha, protected: b.protected }));
    }
  },
  create_branch: {
    description: "Create a new branch",
    params: { owner: "string", repo: "string", branch: "string - new branch name", from_sha: "string - sha to branch from" },
    handler: async ({ owner, repo, branch, from_sha }) => {
      const result = await githubRequest("POST", `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: from_sha });
      return { status: "created", branch, sha: result.object.sha };
    }
  },
  list_commits: {
    description: "List commits in a repository",
    params: { owner: "string", repo: "string", sha: "string (optional) - branch/sha", path: "string (optional) - filter by path", per_page: "number (optional)" },
    handler: async ({ owner, repo, sha, path, per_page }) => {
      const params = new URLSearchParams();
      if (sha) params.append("sha", sha);
      if (path) params.append("path", path);
      if (per_page) params.append("per_page", per_page.toString());
      const commits = await githubRequest("GET", `/repos/${owner}/${repo}/commits?${params}`);
      return commits.map((c: any) => ({ sha: c.sha.substring(0, 7), message: c.commit.message.split("\n")[0], author: c.commit.author.name, date: c.commit.author.date }));
    }
  },
  create_pr: {
    description: "Create a pull request",
    params: { owner: "string", repo: "string", title: "string", head: "string - branch with changes", base: "string - target branch", body: "string (optional)", draft: "boolean (optional)" },
    handler: async ({ owner, repo, title, head, base, body, draft }) => {
      const result = await githubRequest("POST", `/repos/${owner}/${repo}/pulls`, { title, head, base, body, draft });
      return { status: "created", number: result.number, title: result.title, html_url: result.html_url, state: result.state };
    }
  },
  list_prs: {
    description: "List pull requests",
    params: { owner: "string", repo: "string", state: "open|closed|all (optional)", per_page: "number (optional)" },
    handler: async ({ owner, repo, state, per_page }) => {
      const params = new URLSearchParams();
      if (state) params.append("state", state);
      if (per_page) params.append("per_page", per_page.toString());
      const prs = await githubRequest("GET", `/repos/${owner}/${repo}/pulls?${params}`);
      return prs.map((pr: any) => ({ number: pr.number, title: pr.title, state: pr.state, author: pr.user.login, head: pr.head.ref, base: pr.base.ref, html_url: pr.html_url, created_at: pr.created_at }));
    }
  },
  search_code: {
    description: "Search for code across repositories",
    params: { query: "string - search query (supports repo:, path:, language: qualifiers)", per_page: "number (optional)" },
    handler: async ({ query, per_page }) => {
      const params = new URLSearchParams({ q: query });
      if (per_page) params.append("per_page", per_page.toString());
      const result = await githubRequest("GET", `/search/code?${params}`);
      return { total_count: result.total_count, items: result.items.map((item: any) => ({ name: item.name, path: item.path, repository: item.repository.full_name, html_url: item.html_url })) };
    }
  },
  get_repo: {
    description: "Get detailed repository information",
    params: { owner: "string", repo: "string" },
    handler: async ({ owner, repo }) => {
      const result = await githubRequest("GET", `/repos/${owner}/${repo}`);
      return { name: result.name, full_name: result.full_name, description: result.description, private: result.private, default_branch: result.default_branch, language: result.language, topics: result.topics, html_url: result.html_url, clone_url: result.clone_url, created_at: result.created_at, updated_at: result.updated_at, size: result.size, open_issues_count: result.open_issues_count };
    }
  },
  create_issue: {
    description: "Create an issue",
    params: { owner: "string", repo: "string", title: "string", body: "string (optional)", labels: "string[] (optional)" },
    handler: async ({ owner, repo, title, body, labels }) => {
      const result = await githubRequest("POST", `/repos/${owner}/${repo}/issues`, { title, body, labels });
      return { status: "created", number: result.number, title: result.title, html_url: result.html_url };
    }
  },
  list_issues: {
    description: "List issues in a repository",
    params: { owner: "string", repo: "string", state: "open|closed|all (optional)", labels: "string (optional) - comma-separated", per_page: "number (optional)" },
    handler: async ({ owner, repo, state, labels, per_page }) => {
      const params = new URLSearchParams();
      if (state) params.append("state", state);
      if (labels) params.append("labels", labels);
      if (per_page) params.append("per_page", per_page.toString());
      const issues = await githubRequest("GET", `/repos/${owner}/${repo}/issues?${params}`);
      return issues.map((issue: any) => ({ number: issue.number, title: issue.title, state: issue.state, author: issue.user.login, labels: issue.labels.map((l: any) => l.name), html_url: issue.html_url, created_at: issue.created_at }));
    }
  },
};

export function registerGithubTools(server: McpServer) {
  // github_list - shows all available tools
  server.tool(
    "github_list",
    "List all available GitHub tools and their parameters",
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

  // github_call - execute any github tool
  server.tool(
    "github_call",
    "Execute a GitHub tool. Use github_list to see available tools and their parameters.",
    {
      tool: z.string().describe("Tool name from github_list"),
      params: z.record(z.any()).optional().describe("Tool parameters as object"),
    },
    async ({ tool, params }) => {
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
    }
  );
}
