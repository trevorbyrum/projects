# Tool Reference

Complete reference for all tool modules in the Homelab MCP Gateway.

Each module exposes two MCP tools: `{prefix}_list` and `{prefix}_call`. Use `_list` to discover available sub-tools and their parameters, then `_call` to execute them.

---

## gateway

**File**: `src/tools/gateway.ts`
**Env vars**: `N8N_API_URL`, `QDRANT_URL`, `NEO4J_URL`

Health checks and gateway status information.

| Sub-tool | Description |
|----------|-------------|
| `health` | Check gateway health and uptime |
| `status` | Get detailed status of all connected services |
| `sessions` | List active MCP sessions |
| `config` | Show current (non-secret) configuration |

---

## n8n

**File**: `src/tools/n8n.ts`
**Env vars**: `N8N_API_URL`, `N8N_API_KEY`

Workflow automation management via n8n API.

| Sub-tool | Description |
|----------|-------------|
| `list_workflows` | List all workflows |
| `get_workflow` | Get workflow details by ID |
| `activate_workflow` | Activate a workflow |
| `deactivate_workflow` | Deactivate a workflow |
| `execute_workflow` | Trigger a workflow execution |
| `get_executions` | List recent executions |
| `get_execution` | Get execution details |
| `create_workflow` | Create a new workflow |
| `update_workflow` | Update an existing workflow |
| `delete_workflow` | Delete a workflow |

---

## memory

**File**: `src/tools/memory.ts`
**Env vars**: `QDRANT_URL`

Vector memory storage and retrieval via Qdrant.

| Sub-tool | Description |
|----------|-------------|
| `store` | Store content with auto-generated embedding |
| `search` | Semantic similarity search |
| `list` | List stored memories (with optional filters) |
| `get` | Get a specific memory by ID |
| `delete` | Delete a memory by ID |
| `collections` | List all Qdrant collections |
| `count` | Count memories in a collection |

---

## graph

**File**: `src/tools/graph.ts`
**Env vars**: `NEO4J_URL`, `NEO4J_USER`, `NEO4J_PASSWORD`

Knowledge graph operations via Neo4j.

| Sub-tool | Description |
|----------|-------------|
| `query` | Run arbitrary Cypher queries |
| `create_node` | Create a node with labels and properties |
| `create_edge` | Create a relationship between nodes |
| `get_node` | Get a node by ID or properties |
| `search_nodes` | Search nodes by label/property patterns |
| `get_neighbors` | Get connected nodes |
| `add_observation` | Add an observation to a node's observation list |
| `delete_node` | Delete a node and its relationships |

---

## pg

**File**: `src/tools/postgres.ts`
**Env vars**: `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`

PostgreSQL database operations.

| Sub-tool | Description |
|----------|-------------|
| `query` | Execute SQL queries |
| `tables` | List all tables |
| `describe` | Describe table schema |
| `databases` | List databases |
| `stats` | Table statistics (row counts, sizes) |

---

## vector

**File**: `src/tools/pgvector.ts`
**Env vars**: `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`

Vector similarity search via pgvector extension.

| Sub-tool | Description |
|----------|-------------|
| `search` | Similarity search with text query |
| `store` | Store content with auto-generated embedding |
| `list_tables` | List tables with vector columns |
| `get` | Get a record by ID |
| `delete` | Delete a record by ID |
| `count` | Count records in a table |
| `stats` | Vector index statistics |

---

## docker

**File**: `src/tools/docker.ts`
**Env vars**: `DOCKER_HOST`

Docker container management via socket proxy.

| Sub-tool | Description |
|----------|-------------|
| `list_containers` | List all containers (running + stopped) |
| `get_container` | Get container details |
| `start` | Start a container |
| `stop` | Stop a container |
| `restart` | Restart a container |
| `remove` | Remove a container |
| `logs` | Get container logs |
| `stats` | Get container resource stats |
| `exec` | Execute a command in a container |
| `create` | Create a new container |
| `networks` | List Docker networks |
| `images` | List Docker images |
| `pull` | Pull a Docker image |
| `inspect` | Low-level container inspect |

---

## vault

**File**: `src/tools/vault.ts`
**Env vars**: `VAULT_ADDR`, `VAULT_TOKEN`, `VAULT_MOUNT`

HashiCorp Vault secret management.

| Sub-tool | Description |
|----------|-------------|
| `read` | Read a secret |
| `write` | Write/update a secret |
| `list` | List secrets at a path |
| `delete` | Delete a secret |

---

## ai

**File**: `src/tools/openrouter.ts`
**Env vars**: `OPENROUTER_API_KEY`

LLM access via OpenRouter API.

| Sub-tool | Description |
|----------|-------------|
| `chat` | Send a chat completion request |
| `models` | List available models |
| `model_info` | Get details about a specific model |
| `embeddings` | Generate text embeddings |
| `usage` | Check API usage/credits |

---

## github

**File**: `src/tools/github.ts`
**Env vars**: `GITHUB_TOKEN`

GitHub API operations.

| Sub-tool | Description |
|----------|-------------|
| `list_repos` | List repositories |
| `get_repo` | Get repository details |
| `list_issues` | List issues for a repo |
| `create_issue` | Create an issue |
| `list_prs` | List pull requests |
| `get_pr` | Get PR details |
| `list_commits` | List recent commits |
| `get_file` | Get file contents |
| `search_code` | Search code across repos |
| `search_repos` | Search repositories |
| `create_repo` | Create a new repository |
| `list_branches` | List branches |
| `get_user` | Get user profile |
| `list_notifications` | List notifications |

---

## browser

**File**: `src/tools/playwright.ts`
**Env vars**: none

Headless browser automation via Playwright Chromium.

| Sub-tool | Description |
|----------|-------------|
| `navigate` | Navigate to a URL |
| `screenshot` | Take a screenshot |
| `click` | Click an element |
| `type` | Type text into an element |
| `evaluate` | Run JavaScript in the page |
| `get_text` | Extract text content |
| `get_html` | Get page HTML |
| `wait` | Wait for a selector |
| `select` | Select from a dropdown |
| `fill_form` | Fill multiple form fields |
| `scroll` | Scroll the page |
| `back` | Navigate back |
| `close` | Close the browser |

---

## prometheus

**File**: `src/tools/prometheus.ts`
**Env vars**: `PROMETHEUS_URL` (defaults to `http://prometheus:9090`)

Prometheus metrics querying.

| Sub-tool | Description |
|----------|-------------|
| `query` | Execute a PromQL instant query |
| `targets` | List scrape targets and their status |
| `alerts` | List active alerts |

---

## uptime

**File**: `src/tools/uptimekuma.ts`
**Env vars**: `UPTIME_KUMA_API_URL`, `UPTIME_KUMA_API_USER`, `UPTIME_KUMA_API_PASS`

Uptime Kuma service monitoring via REST API wrapper.

| Sub-tool | Description |
|----------|-------------|
| `list_monitors` | List all monitors with status |
| `get_monitor` | Get monitor details |
| `pause_monitor` | Pause a monitor |
| `resume_monitor` | Resume a paused monitor |

---

## rabbitmq

**File**: `src/tools/rabbitmq.ts`
**Env vars**: `RABBITMQ_URL`, `RABBITMQ_USER`, `RABBITMQ_PASS`

RabbitMQ message queue management.

| Sub-tool | Description |
|----------|-------------|
| `list_queues` | List all queues with message counts |
| `list_exchanges` | List exchanges |
| `get_queue` | Get queue details |
| `publish` | Publish a message to an exchange |
| `purge` | Purge messages from a queue |
| `bindings` | List queue/exchange bindings |

---

## dify

**File**: `src/tools/dify.ts`
**Env vars**: `DIFY_API_URL`, `DIFY_EMAIL`, `DIFY_PASSWORD`

Dify AI platform management (apps, models, tools, knowledge bases, workflows).

This is one of the largest modules with 20+ sub-tools covering:
- App CRUD and configuration
- Model provider management
- Tool/plugin management
- Knowledge base operations
- Workflow management
- Conversation and message history

Use `dify_list` to see all available sub-tools.

---

## openhands

**File**: `src/tools/openhands.ts`
**Env vars**: `OPENHANDS_URL`, `OPENHANDS_API_KEY`

OpenHands AI coding agent management.

| Sub-tool | Description |
|----------|-------------|
| `list_conversations` | List coding conversations |
| `create_conversation` | Start a new conversation |
| `get_conversation` | Get conversation details |
| `send_message` | Send a message to the agent |
| `get_messages` | Get conversation messages |
| `stop` | Stop the agent |
| `get_status` | Get agent status |
| `list_files` | List files in workspace |
| `get_file` | Read a file from workspace |
| `manage_secrets` | Manage OpenHands secrets |

---

## traefik

**File**: `src/tools/traefik.ts`
**Env vars**: `TRAEFIK_API_URL`

Traefik reverse proxy inspection.

| Sub-tool | Description |
|----------|-------------|
| `list_routers` | List HTTP routers |
| `list_services` | List backend services |
| `list_middlewares` | List middlewares |
| `find_route` | Find which router handles a hostname |
| `diagnostics` | Traefik version and overview stats |

---

## redis

**File**: `src/tools/redis.ts`
**Env vars**: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`

Redis cache and message broker operations.

| Sub-tool | Description |
|----------|-------------|
| `get` | Get a key's value |
| `set` | Set a key with optional TTL |
| `delete` | Delete keys |
| `keys` | List keys matching a pattern |
| `info` | Redis server info |
| `keyspace` | Keyspace statistics |
| `publish` | Publish to a channel |
| `slowlog` | Recent slow queries |

---

## mongodb

**File**: `src/tools/mongodb.ts`
**Env vars**: `MONGODB_URL`

MongoDB document database operations.

| Sub-tool | Description |
|----------|-------------|
| `list_databases` | List all databases |
| `list_collections` | List collections in a database |
| `find` | Query documents |
| `insert` | Insert documents |
| `update` | Update documents |
| `delete` | Delete documents |
| `aggregate` | Run aggregation pipelines |
| `indexes` | List collection indexes |
| `create_index` | Create an index |
| `stats` | Collection statistics |

---

## recipe

**File**: `src/tools/recipes.ts`
**Env vars**: `VAULT_ADDR`, `VAULT_TOKEN`, `DOCKER_HOST`

Container recipe templates stored in Vault.

| Sub-tool | Description |
|----------|-------------|
| `list` | List all stored recipes |
| `get` | Get a recipe by name |
| `store` | Save a recipe template |
| `deploy` | Deploy a container from a recipe |
| `redeploy` | Redeploy (stop + remove + deploy) |
| `teardown` | Stop and remove a deployed recipe |

---

## blueprint

**File**: `src/tools/blueprints.ts`
**Env vars**: Various (uses n8n, Redis, Vault, Neo4j)

Blueprint automation system — modular agent framework for multi-step provisioning.

| Sub-tool | Description |
|----------|-------------|
| `list` | List available blueprints |
| `get` | Get blueprint definition |
| `deploy` | Deploy a blueprint (run all steps) |
| `teardown` | Tear down a deployed blueprint |
| `status` | Check deployment status |
| `validate` | Validate a blueprint before deploy |
| `store` | Store a new blueprint definition |
| `history` | View deployment history |

---

## external

**File**: `src/tools/external.ts`
**Config**: `external-mcp.json`

Proxies to external MCP servers. Each server defined in `external-mcp.json` gets its own `_list`/`_call` pair. Currently configured:

- **context7**: Library documentation lookup via `context7_list` / `context7_call`

---

## projects

**File**: `src/tools/projects.ts`
**Env vars**: `NTFY_URL`, `NTFY_TOPIC`, `NTFY_USER`, `NTFY_PASSWORD`, `N8N_WEBHOOK_BASE`, `DIFY_API_BASE`, `POSTGRES_*`

Project pipeline — 30+ sub-tools for full dev-team automation lifecycle.

| Sub-tool | Description |
|----------|-------------|
| `create_project` | Create a project idea (PG + GitLab sync via n8n) |
| `list_projects` | List projects with filters (stage, priority, tag) |
| `get_project` | Full project details + research + sprints + artifacts |
| `update_project` | Update project fields, sync to GitLab |
| `advance_stage` | Move to next stage with validation gates |
| `archive_project` | Soft-archive a project |
| `start_research` | Launch Dify research pipeline (13 sections, async) |
| `get_research` | Get all research sections |
| `update_research` | Update a research section with findings |
| `complete_research` | Mark research done, store SOW |
| `add_question` | Post async question (ntfy notification) |
| `answer_question` | Answer question, auto-resume if unblocked |
| `get_unanswered` | List unanswered questions (blocking first) |
| `get_questions` | All questions for a project |
| `add_sprint` | Add a sprint plan |
| `update_sprint` | Update sprint fields |
| `start_sprint` | Set sprint active |
| `complete_sprint` | Complete sprint, update actuals |
| `create_agent_task` | Queue agent work item for dev-team |
| `list_agent_tasks` | List agent tasks with filters |
| `update_agent_task` | Update agent task status/result |
| `run_devteam_workflow` | Run Dify dev-team workflow (sync or async) |
| `get_devteam_result` | Poll async workflow job status |
| `add_artifact` | Link file/container/service/repo to project |
| `list_artifacts` | List project artifacts |
| `log_event` | Log manual event |
| `get_metrics` | Build analytics and accuracy metrics |
| `get_timeline` | Event history for a project |

Stages: `queue` → `research` → `architecture` → `security_review` → `planning` → `active` → `completed`

---

## figma

**File**: `src/tools/figma.ts`
**Env vars**: `FIGMA_API_KEY`

Figma design file access via REST API.

| Sub-tool | Description |
|----------|-------------|
| `get_file` | Get Figma file structure (use depth to limit size) |
| `get_file_nodes` | Get specific nodes by ID |
| `get_images` | Render nodes as PNG/SVG/JPG/PDF |
| `get_image_fills` | Get image fill download URLs |
| `get_comments` | List file comments |
| `post_comment` | Add a comment to a file |
| `delete_comment` | Delete a comment |
| `get_file_versions` | Version history |
| `get_team_projects` | List team projects |
| `get_project_files` | List files in a project |
| `get_file_components` | Published components from a file |
| `get_file_component_sets` | Component sets (variant groups) |
| `get_file_styles` | Published styles from a file |
| `get_team_components` | All published components across team |
| `get_team_styles` | All published styles across team |

---

## workspace

**File**: `src/tools/workspaces.ts`
**Env vars**: `GITLAB_TOKEN`, `GITLAB_URL`, `OPENHANDS_API_KEY`, `FIGMA_API_KEY`, `NTFY_USER`, `NTFY_PASSWORD`

Workspace orchestration — GitLab repos, OpenHands coding sessions, Figma visual QA.

| Sub-tool | Description |
|----------|-------------|
| `create_workspace` | Create GitLab repo from recipe template |
| `get_workspace` | Get workspace details from PG |
| `create_coding_session` | Launch OpenHands agent for a sprint task |
| `get_session_status` | Check coding session status |
| `capture_screenshot` | Capture Figma frame as image |
| `compare_visuals` | Compare Figma design vs implementation screenshot |
| `merge_sprint` | Merge sprint branch to main |
| `generate_recipe` | Generate container recipe from workspace |

---

## preferences

**File**: `src/tools/preferences.ts`
**Env vars**: `QDRANT_URL`

Semantic dev preference storage — Qdrant-backed, used by research pipeline.

| Sub-tool | Description |
|----------|-------------|
| `pref_store` | Store a preference with semantic embedding |
| `pref_search` | Search preferences by similarity |
| `pref_list` | List all preferences with domain filter |
| `pref_update` | Update a preference (re-embeds if needed) |
| `pref_delete` | Delete a preference |
| `pref_export` | Export all preferences grouped by domain |
