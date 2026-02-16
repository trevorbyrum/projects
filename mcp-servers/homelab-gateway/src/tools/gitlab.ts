import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { gitlabFetch } from "./workspaces.js";

/** Encode project ID or URL-path for GitLab API */
function pid(input: string): string {
  return /^\d+$/.test(input) ? input : encodeURIComponent(input);
}

// ── Tool definitions ────────────────────────────────────────────

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {

  // ── Category 1: Repository Management ───────────────────────

  list_projects: {
    description: "List accessible GitLab projects",
    params: {
      membership: "boolean (optional, default true) - only projects you're a member of",
      search: "string (optional) - filter by name",
      per_page: "number (optional, default 20)",
      page: "number (optional, default 1)",
      order_by: "string (optional) - created_at|updated_at|name (default updated_at)",
    },
    handler: async ({ membership = true, search, per_page = 20, page = 1, order_by = "updated_at" }) => {
      const params = new URLSearchParams({ per_page: String(per_page), page: String(page), order_by });
      if (membership) params.append("membership", "true");
      if (search) params.append("search", search);
      const projects = await gitlabFetch(`/api/v4/projects?${params}`);
      return projects.map((p: any) => ({
        id: p.id,
        name: p.name,
        path_with_namespace: p.path_with_namespace,
        description: p.description,
        default_branch: p.default_branch,
        visibility: p.visibility,
        web_url: p.web_url,
        updated_at: p.last_activity_at,
      }));
    },
  },

  get_project: {
    description: "Get full details for a GitLab project",
    params: { project: "string - project ID or path (e.g. 'group/project-name')" },
    handler: async ({ project }) => {
      const p = await gitlabFetch(`/api/v4/projects/${pid(project)}`);
      return {
        id: p.id,
        name: p.name,
        path_with_namespace: p.path_with_namespace,
        description: p.description,
        default_branch: p.default_branch,
        visibility: p.visibility,
        web_url: p.web_url,
        http_url_to_repo: p.http_url_to_repo,
        ssh_url_to_repo: p.ssh_url_to_repo,
        created_at: p.created_at,
        last_activity_at: p.last_activity_at,
        namespace: p.namespace?.full_path,
        topics: p.topics,
        open_issues_count: p.open_issues_count,
        forks_count: p.forks_count,
        star_count: p.star_count,
      };
    },
  },

  create_project: {
    description: "Create a new GitLab project (auto_devops disabled by default)",
    params: {
      name: "string - project name",
      namespace_id: "number (optional) - group/namespace ID",
      description: "string (optional)",
      visibility: "string (optional) - private|internal|public (default private)",
      initialize_with_readme: "boolean (optional, default true)",
    },
    handler: async ({ name, namespace_id, description, visibility = "private", initialize_with_readme = true }) => {
      const body: any = { name, visibility, auto_devops_enabled: false, initialize_with_readme };
      if (namespace_id) body.namespace_id = namespace_id;
      if (description) body.description = description;
      const p = await gitlabFetch("/api/v4/projects", { method: "POST", body: JSON.stringify(body) });
      return {
        id: p.id,
        name: p.name,
        path_with_namespace: p.path_with_namespace,
        web_url: p.web_url,
        default_branch: p.default_branch,
        visibility: p.visibility,
      };
    },
  },

  search_projects: {
    description: "Search GitLab projects by name or path",
    params: { query: "string - search term", per_page: "number (optional, default 20)" },
    handler: async ({ query, per_page = 20 }) => {
      const params = new URLSearchParams({ search: query, per_page: String(per_page) });
      const projects = await gitlabFetch(`/api/v4/projects?${params}`);
      return projects.map((p: any) => ({
        id: p.id,
        name: p.name,
        path_with_namespace: p.path_with_namespace,
        description: p.description,
        web_url: p.web_url,
        updated_at: p.last_activity_at,
      }));
    },
  },

  delete_project: {
    description: "Delete a GitLab project (DESTRUCTIVE - requires confirm: true)",
    params: { project: "string - project ID or path", confirm: "boolean - must be true to proceed" },
    handler: async ({ project, confirm }) => {
      if (!confirm) return { error: "Set confirm: true to delete this project. This action is irreversible." };
      await gitlabFetch(`/api/v4/projects/${pid(project)}`, { method: "DELETE" });
      return { status: "deleted", project };
    },
  },

  // ── Category 2: File & Branch Operations ────────────────────

  get_file: {
    description: "Read file contents from a GitLab repository",
    params: {
      project: "string - project ID or path",
      path: "string - file path in repo",
      ref: "string (optional) - branch/tag/commit (default: project default branch)",
    },
    handler: async ({ project, path, ref }) => {
      const params = ref ? `?ref=${encodeURIComponent(ref)}` : "";
      return gitlabFetch(`/api/v4/projects/${pid(project)}/repository/files/${encodeURIComponent(path)}/raw${params}`);
    },
  },

  create_file: {
    description: "Create a new file in a GitLab repository with a commit",
    params: {
      project: "string - project ID or path",
      path: "string - file path to create",
      content: "string - file content",
      commit_message: "string - commit message",
      branch: "string - target branch",
    },
    handler: async ({ project, path, content, commit_message, branch }) => {
      const result = await gitlabFetch(
        `/api/v4/projects/${pid(project)}/repository/files/${encodeURIComponent(path)}`,
        { method: "POST", body: JSON.stringify({ branch, content, commit_message }) },
      );
      return { status: "created", path: result.file_path, branch: result.branch };
    },
  },

  update_file: {
    description: "Update an existing file in a GitLab repository with a commit",
    params: {
      project: "string - project ID or path",
      path: "string - file path to update",
      content: "string - new file content",
      commit_message: "string - commit message",
      branch: "string - target branch",
    },
    handler: async ({ project, path, content, commit_message, branch }) => {
      const result = await gitlabFetch(
        `/api/v4/projects/${pid(project)}/repository/files/${encodeURIComponent(path)}`,
        { method: "PUT", body: JSON.stringify({ branch, content, commit_message }) },
      );
      return { status: "updated", path: result.file_path, branch: result.branch };
    },
  },

  delete_file: {
    description: "Delete a file from a GitLab repository with a commit",
    params: {
      project: "string - project ID or path",
      path: "string - file path to delete",
      commit_message: "string - commit message",
      branch: "string - target branch",
    },
    handler: async ({ project, path, commit_message, branch }) => {
      await gitlabFetch(
        `/api/v4/projects/${pid(project)}/repository/files/${encodeURIComponent(path)}`,
        { method: "DELETE", body: JSON.stringify({ branch, commit_message }) },
      );
      return { status: "deleted", path, branch };
    },
  },

  list_tree: {
    description: "Browse repository directory tree",
    params: {
      project: "string - project ID or path",
      path: "string (optional) - subdirectory path",
      ref: "string (optional) - branch/tag/commit",
      recursive: "boolean (optional, default false)",
      per_page: "number (optional, default 100)",
    },
    handler: async ({ project, path, ref, recursive = false, per_page = 100 }) => {
      const params = new URLSearchParams({ per_page: String(per_page) });
      if (path) params.append("path", path);
      if (ref) params.append("ref", ref);
      if (recursive) params.append("recursive", "true");
      const tree = await gitlabFetch(`/api/v4/projects/${pid(project)}/repository/tree?${params}`);
      return tree.map((item: any) => ({ name: item.name, path: item.path, type: item.type, mode: item.mode }));
    },
  },

  list_branches: {
    description: "List branches in a GitLab repository",
    params: {
      project: "string - project ID or path",
      search: "string (optional) - filter branches by name",
      per_page: "number (optional, default 20)",
    },
    handler: async ({ project, search, per_page = 20 }) => {
      const params = new URLSearchParams({ per_page: String(per_page) });
      if (search) params.append("search", search);
      const branches = await gitlabFetch(`/api/v4/projects/${pid(project)}/repository/branches?${params}`);
      return branches.map((b: any) => ({
        name: b.name,
        merged: b.merged,
        protected: b.protected,
        default: b.default,
        commit_sha: b.commit?.short_id,
        commit_message: b.commit?.title,
        commit_date: b.commit?.committed_date,
      }));
    },
  },

  create_branch: {
    description: "Create a new branch in a GitLab repository",
    params: {
      project: "string - project ID or path",
      branch: "string - new branch name",
      ref: "string - source branch/tag/commit to branch from",
    },
    handler: async ({ project, branch, ref }) => {
      const result = await gitlabFetch(`/api/v4/projects/${pid(project)}/repository/branches`, {
        method: "POST",
        body: JSON.stringify({ branch, ref }),
      });
      return { status: "created", name: result.name, commit_sha: result.commit?.short_id };
    },
  },

  get_diff: {
    description: "Compare two branches, tags, or commits",
    params: {
      project: "string - project ID or path",
      from: "string - base branch/tag/commit",
      to: "string - head branch/tag/commit",
    },
    handler: async ({ project, from, to }) => {
      const params = new URLSearchParams({ from, to });
      const result = await gitlabFetch(`/api/v4/projects/${pid(project)}/repository/compare?${params}`);
      return {
        commits: result.commits?.length || 0,
        commit_list: result.commits?.map((c: any) => ({
          short_id: c.short_id,
          title: c.title,
          author: c.author_name,
          date: c.committed_date,
        })),
        diffs: result.diffs?.map((d: any) => ({
          old_path: d.old_path,
          new_path: d.new_path,
          new_file: d.new_file,
          deleted_file: d.deleted_file,
          renamed_file: d.renamed_file,
          diff: d.diff?.slice(0, 3000),
        })),
      };
    },
  },

  // ── Category 3: Merge Requests & Issues ─────────────────────

  list_merge_requests: {
    description: "List merge requests in a GitLab project",
    params: {
      project: "string - project ID or path",
      state: "string (optional) - opened|closed|merged|all (default opened)",
      per_page: "number (optional, default 20)",
      page: "number (optional, default 1)",
    },
    handler: async ({ project, state = "opened", per_page = 20, page = 1 }) => {
      const params = new URLSearchParams({ state, per_page: String(per_page), page: String(page) });
      const mrs = await gitlabFetch(`/api/v4/projects/${pid(project)}/merge_requests?${params}`);
      return mrs.map((mr: any) => ({
        iid: mr.iid,
        title: mr.title,
        state: mr.state,
        author: mr.author?.username,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        web_url: mr.web_url,
        created_at: mr.created_at,
        merged_at: mr.merged_at,
      }));
    },
  },

  create_merge_request: {
    description: "Create a merge request",
    params: {
      project: "string - project ID or path",
      title: "string - MR title",
      source_branch: "string - branch with changes",
      target_branch: "string - branch to merge into",
      description: "string (optional) - MR description",
      remove_source_branch: "boolean (optional, default false)",
    },
    handler: async ({ project, title, source_branch, target_branch, description, remove_source_branch = false }) => {
      const body: any = { title, source_branch, target_branch, remove_source_branch };
      if (description) body.description = description;
      const mr = await gitlabFetch(`/api/v4/projects/${pid(project)}/merge_requests`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return {
        iid: mr.iid,
        title: mr.title,
        state: mr.state,
        web_url: mr.web_url,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
      };
    },
  },

  merge_merge_request: {
    description: "Merge a merge request",
    params: {
      project: "string - project ID or path",
      merge_request_iid: "number - MR internal ID",
      should_remove_source_branch: "boolean (optional, default false)",
      squash: "boolean (optional, default false)",
    },
    handler: async ({ project, merge_request_iid, should_remove_source_branch = false, squash = false }) => {
      const mr = await gitlabFetch(
        `/api/v4/projects/${pid(project)}/merge_requests/${merge_request_iid}/merge`,
        { method: "PUT", body: JSON.stringify({ should_remove_source_branch, squash }) },
      );
      return {
        iid: mr.iid,
        title: mr.title,
        state: mr.state,
        merged_at: mr.merged_at,
        merge_commit_sha: mr.merge_commit_sha,
      };
    },
  },

  get_merge_request_changes: {
    description: "View the diff/changes of a merge request",
    params: {
      project: "string - project ID or path",
      merge_request_iid: "number - MR internal ID",
    },
    handler: async ({ project, merge_request_iid }) => {
      const mr = await gitlabFetch(
        `/api/v4/projects/${pid(project)}/merge_requests/${merge_request_iid}/changes`,
      );
      return {
        iid: mr.iid,
        title: mr.title,
        state: mr.state,
        changes_count: mr.changes_count,
        changes: mr.changes?.map((c: any) => ({
          old_path: c.old_path,
          new_path: c.new_path,
          new_file: c.new_file,
          deleted_file: c.deleted_file,
          diff: c.diff?.slice(0, 3000),
        })),
      };
    },
  },

  list_issues: {
    description: "List issues in a GitLab project",
    params: {
      project: "string - project ID or path",
      state: "string (optional) - opened|closed|all (default opened)",
      labels: "string (optional) - comma-separated label names",
      per_page: "number (optional, default 20)",
      page: "number (optional, default 1)",
    },
    handler: async ({ project, state = "opened", labels, per_page = 20, page = 1 }) => {
      const params = new URLSearchParams({ state, per_page: String(per_page), page: String(page) });
      if (labels) params.append("labels", labels);
      const issues = await gitlabFetch(`/api/v4/projects/${pid(project)}/issues?${params}`);
      return issues.map((i: any) => ({
        iid: i.iid,
        title: i.title,
        state: i.state,
        author: i.author?.username,
        labels: i.labels,
        web_url: i.web_url,
        created_at: i.created_at,
        closed_at: i.closed_at,
      }));
    },
  },

  create_issue: {
    description: "Create an issue in a GitLab project",
    params: {
      project: "string - project ID or path",
      title: "string - issue title",
      description: "string (optional) - issue description (markdown)",
      labels: "string (optional) - comma-separated label names",
      assignee_ids: "number[] (optional) - user IDs to assign",
    },
    handler: async ({ project, title, description, labels, assignee_ids }) => {
      const body: any = { title };
      if (description) body.description = description;
      if (labels) body.labels = labels;
      if (assignee_ids) body.assignee_ids = assignee_ids;
      const issue = await gitlabFetch(`/api/v4/projects/${pid(project)}/issues`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      return { iid: issue.iid, title: issue.title, state: issue.state, web_url: issue.web_url, labels: issue.labels };
    },
  },

  update_issue: {
    description: "Update an issue (title, state, labels, assignees)",
    params: {
      project: "string - project ID or path",
      issue_iid: "number - issue internal ID",
      title: "string (optional)",
      description: "string (optional)",
      state_event: "string (optional) - close|reopen",
      labels: "string (optional) - comma-separated",
      assignee_ids: "number[] (optional)",
    },
    handler: async ({ project, issue_iid, title, description, state_event, labels, assignee_ids }) => {
      const body: any = {};
      if (title !== undefined) body.title = title;
      if (description !== undefined) body.description = description;
      if (state_event) body.state_event = state_event;
      if (labels !== undefined) body.labels = labels;
      if (assignee_ids) body.assignee_ids = assignee_ids;
      const issue = await gitlabFetch(
        `/api/v4/projects/${pid(project)}/issues/${issue_iid}`,
        { method: "PUT", body: JSON.stringify(body) },
      );
      return { iid: issue.iid, title: issue.title, state: issue.state, labels: issue.labels, web_url: issue.web_url };
    },
  },

  // ── Category 4: CI/CD & Registry ────────────────────────────

  list_pipelines: {
    description: "List recent CI/CD pipelines",
    params: {
      project: "string - project ID or path",
      status: "string (optional) - running|pending|success|failed|canceled",
      ref: "string (optional) - filter by branch/tag",
      per_page: "number (optional, default 20)",
    },
    handler: async ({ project, status, ref, per_page = 20 }) => {
      const params = new URLSearchParams({ per_page: String(per_page) });
      if (status) params.append("status", status);
      if (ref) params.append("ref", ref);
      const pipelines = await gitlabFetch(`/api/v4/projects/${pid(project)}/pipelines?${params}`);
      return pipelines.map((p: any) => ({
        id: p.id,
        status: p.status,
        ref: p.ref,
        sha: p.sha?.slice(0, 7),
        source: p.source,
        created_at: p.created_at,
        updated_at: p.updated_at,
        web_url: p.web_url,
      }));
    },
  },

  get_pipeline: {
    description: "Get pipeline details including jobs",
    params: {
      project: "string - project ID or path",
      pipeline_id: "number - pipeline ID",
    },
    handler: async ({ project, pipeline_id }) => {
      const [pipeline, jobs] = await Promise.all([
        gitlabFetch(`/api/v4/projects/${pid(project)}/pipelines/${pipeline_id}`),
        gitlabFetch(`/api/v4/projects/${pid(project)}/pipelines/${pipeline_id}/jobs`),
      ]);
      return {
        id: pipeline.id,
        status: pipeline.status,
        ref: pipeline.ref,
        sha: pipeline.sha?.slice(0, 7),
        source: pipeline.source,
        created_at: pipeline.created_at,
        started_at: pipeline.started_at,
        finished_at: pipeline.finished_at,
        duration: pipeline.duration,
        web_url: pipeline.web_url,
        jobs: jobs.map((j: any) => ({
          id: j.id,
          name: j.name,
          stage: j.stage,
          status: j.status,
          duration: j.duration,
          started_at: j.started_at,
          finished_at: j.finished_at,
        })),
      };
    },
  },

  get_job_log: {
    description: "Read CI/CD job output log (truncated to last N chars)",
    params: {
      project: "string - project ID or path",
      job_id: "number - job ID",
      tail: "number (optional, default 5000) - max chars from end of log",
    },
    handler: async ({ project, job_id, tail = 5000 }) => {
      const log = await gitlabFetch(`/api/v4/projects/${pid(project)}/jobs/${job_id}/trace`);
      const text = typeof log === "string" ? log : JSON.stringify(log);
      if (text.length > tail) {
        return `...[truncated, showing last ${tail} chars]...\n${text.slice(-tail)}`;
      }
      return text;
    },
  },

  retry_pipeline: {
    description: "Retry a failed pipeline",
    params: {
      project: "string - project ID or path",
      pipeline_id: "number - pipeline ID to retry",
    },
    handler: async ({ project, pipeline_id }) => {
      const result = await gitlabFetch(
        `/api/v4/projects/${pid(project)}/pipelines/${pipeline_id}/retry`,
        { method: "POST" },
      );
      return { id: result.id, status: result.status, ref: result.ref, web_url: result.web_url };
    },
  },

  list_registry_tags: {
    description: "List container registry repositories and their tags",
    params: { project: "string - project ID or path" },
    handler: async ({ project }) => {
      const repos = await gitlabFetch(`/api/v4/projects/${pid(project)}/registry/repositories`);
      const results: any[] = [];
      for (const repo of repos) {
        const tags = await gitlabFetch(
          `/api/v4/projects/${pid(project)}/registry/repositories/${repo.id}/tags`,
        );
        for (const tag of tags) {
          results.push({
            repository: repo.path,
            tag: tag.name,
            location: tag.location,
            created_at: tag.created_at,
            total_size: tag.total_size,
          });
        }
      }
      return results;
    },
  },
};

// ── Registration ────────────────────────────────────────────────

export function registerGitlabTools(server: McpServer) {
  server.tool(
    "gitlab_list",
    "List all available GitLab tools and their parameters",
    {},
    async () => {
      const toolList = Object.entries(tools).map(([name, def]) => ({
        tool: name,
        description: def.description,
        params: def.params,
      }));
      return { content: [{ type: "text", text: JSON.stringify(toolList, null, 2) }] };
    },
  );

  server.tool(
    "gitlab_call",
    "Execute a GitLab tool. Use gitlab_list to see available tools and their parameters.",
    {
      tool: z.string().describe("Tool name from gitlab_list"),
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
    },
  );
}
