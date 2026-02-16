# Tool Reference

> 32 modules — 393 sub-tools

Each module exposes a `{prefix}_list` tool (shows available sub-tools) and a `{prefix}_call` tool (executes them).

---

## n8n (`n8n_*`)

List all available n8n workflow automation tools and their parameters

| Sub-tool | Description |
|----------|-------------|
| `list_workflows` | List all n8n workflows with optional filters |
| `get_workflow` | Get a specific workflow by ID |
| `create_workflow` | Create a new n8n workflow |
| `update_workflow` | Update an existing n8n workflow |
| `delete_workflow` | Delete an n8n workflow |
| `activate_workflow` | Activate an n8n workflow |
| `deactivate_workflow` | Deactivate an n8n workflow |
| `execute_workflow` | Execute/trigger an n8n workflow with optional input data |
| `get_execution` | Get details of a specific workflow execution |
| `create_credential` | Create a new n8n credential. Use get_credential_schema first to see required fields for a credential type. |
| `delete_credential` | Delete an n8n credential by ID |
| `get_credential_schema` | Get the schema (required fields) for a credential type. Common types: httpHeaderAuth, httpBasicAuth, httpQueryAuth, cloudflareApi2, discordWebhookApi, postgresApi, mongoDb, redisApi, githubApi, slackApi |
| `list_executions` | List workflow execution history |

**Env vars**: `N8N_API_KEY`, `N8N_API_URL`

---

## memory (`memory_*`)

List all available memory/Qdrant tools and their parameters

| Sub-tool | Description |
|----------|-------------|
| `store` | Store a thought or note with automatic embedding generation |
| `search` | Search for memories using semantic similarity |
| `list` | List stored memories with pagination |
| `get` | Retrieve a specific memory by ID |
| `update` | Update an existing memory |
| `delete` | Delete a memory by ID |
| `stats` | Get statistics about stored memories |

---

## graph (`graph_*`)

List all available Neo4j knowledge graph tools

| Sub-tool | Description |
|----------|-------------|
| `create_node` | Create a new node in the knowledge graph |
| `create_relationship` | Create a relationship between two nodes |
| `query` | Execute a raw Cypher query against Neo4j |
| `find_node` | Find nodes by label and/or properties |
| `get_neighbors` | Get nodes connected to a specific node |
| `find_path` | Find the shortest path between two nodes |
| `delete_node` | Delete a node and all its relationships |
| `update_node` | Update properties of an existing node |
| `add_observation` | Append a timestamped observation to a node |

**Env vars**: `NEO4J_PASSWORD`, `NEO4J_URL`, `NEO4J_USER`

---

## gateway (`gateway_*`)

List all available gateway utility tools

| Sub-tool | Description |
|----------|-------------|
| `status` | Check the health status of the gateway and all connected services |
| `readme` | Get the project CLAUDE.md - architecture, rules, and file map. READ THIS FIRST before making any changes. |
| `read_file` | Read a file from the server filesystem |
| `write_file` | Write a file to the server filesystem |
| `config` | Get gateway configuration (service URLs, not secrets) |

**Env vars**: `N8N_API_KEY`, `N8N_API_URL`, `NEO4J_URL`, `NEO4J_USER`, `NODE_ENV`, `QDRANT_URL`

---

## postgres (`pg_*`)

List all available PostgreSQL database tools and their parameters

| Sub-tool | Description |
|----------|-------------|
| `query` | Execute a SELECT query against PostgreSQL |
| `execute` | Execute INSERT, UPDATE, or DELETE query |
| `list_tables` | List all tables in the database |
| `describe_table` | Get column information for a table |
| `list_indexes` | List indexes on a table |

---

## pgvector (`vector_*`)

List all available pgvector tools for vector/embedding operations

| Sub-tool | Description |
|----------|-------------|
| `create_table` | Create a table with a vector column for embeddings |
| `create_index` | Create an index on a vector column for faster similarity search |
| `insert` | Insert a vector embedding into a table |
| `search` | Search for similar vectors using cosine similarity |
| `get` | Get a vector and its data by ID |
| `delete` | Delete a vector by ID |
| `count` | Count vectors in a table |

---

## docker (`docker_*`)

List all available Docker tools and their parameters

| Sub-tool | Description |
|----------|-------------|
| `list_containers` | List Docker containers |
| `inspect` | Get detailed container information |
| `logs` | Get container logs |
| `start` | Start a stopped container |
| `stop` | Stop a running container |
| `restart` | Restart a container |
| `exec` | Execute command in a container |
| `list_images` | List Docker images |
| `pull_image` | Pull a Docker image |
| `run` | Create and start a new container |
| `remove` | Remove a container |
| `list_networks` | List Docker networks |
| `info` | Get Docker system info |

**Env vars**: `DOCKER_HOST`

---

## vault (`vault_*`)

List all available HashiCorp Vault secrets tools

| Sub-tool | Description |
|----------|-------------|
| `status` | Check if Vault is sealed or reachable |
| `unseal` | Unseal Vault using the stored unseal key from env |
| `store` | Store a secret in HashiCorp Vault (KV v2) |
| `get` | Retrieve a secret from HashiCorp Vault |
| `list` | List secret paths in Vault at a given prefix |
| `delete` | Delete a secret from Vault (soft delete, can be undeleted) |

**Env vars**: `VAULT_ADDR`, `VAULT_MOUNT`, `VAULT_TOKEN`, `VAULT_UNSEAL_KEY`

---

## openrouter (`ai_*`)

List all available OpenRouter AI tools for calling other LLMs

| Sub-tool | Description |
|----------|-------------|
| `list_models` | List available models on OpenRouter with pricing info |
| `chat` | Send a chat completion request to any model via OpenRouter |
| `second_opinion` | Get a second opinion on a question or code from a different AI model |
| `compare` | Compare responses from multiple models for the same prompt |
| `credits` | Check OpenRouter account credits and usage |

**Env vars**: `PUBLIC_DOMAIN`

---

## github (`github_*`)

List all available GitHub tools and their parameters

| Sub-tool | Description |
|----------|-------------|
| `list_repos` | List repositories for authenticated user or specified owner |
| `get_file` | Get contents of a file from a repository |
| `list_contents` | List contents of a directory in a repository |
| `put_file` | Create or update a file in a repository |
| `delete_file` | Delete a file from a repository |
| `list_branches` | List branches in a repository |
| `create_branch` | Create a new branch |
| `list_commits` | List commits in a repository |
| `create_pr` | Create a pull request |
| `list_prs` | List pull requests |
| `search_code` | Search for code across repositories |
| `get_repo` | Get detailed repository information |
| `create_issue` | Create an issue |
| `list_issues` | List issues in a repository |

**Env vars**: `GITHUB_TOKEN`

---

## playwright (`browser_*`)

List all available browser automation tools and their parameters

| Sub-tool | Description |
|----------|-------------|
| `navigate` | Navigate to a URL |
| `content` | Get text content of the page or element |
| `html` | Get HTML of the page or element |
| `click` | Click an element |
| `type` | Type text into an input field |
| `screenshot` | Take a screenshot |
| `wait` | Wait for an element to appear |
| `evaluate` | Execute JavaScript in the browser |
| `url` | Get current page URL and title |
| `back` | Go back to previous page |
| `close` | Close the browser instance |
| `links` | Get all links on the page |
| `select` | Select an option from a dropdown |

---

## monitoring (`prometheus_*`)

List all available Prometheus monitoring tools

*Dynamic — tools loaded at runtime from external configuration.*

**Env vars**: `PROMETHEUS_URL`, `UPTIME_KUMA_API_PASS`, `UPTIME_KUMA_API_URL`, `UPTIME_KUMA_API_USER`

---

## rabbitmq (`rabbitmq_*`)

List all available RabbitMQ message queue tools

| Sub-tool | Description |
|----------|-------------|
| `overview` | Get RabbitMQ cluster overview (version, message rates, queue totals, node info) |
| `queues` | List all queues with message counts and consumer info |
| `exchanges` | List all exchanges |
| `connections` | List active connections |
| `create_queue` | Declare a new queue |
| `publish` | Publish a message to an exchange |
| `get_messages` | Get messages from a queue (peek, does not consume by default) |
| `delete_queue` | Delete a queue |

**Env vars**: `RABBITMQ_PASS`, `RABBITMQ_URL`, `RABBITMQ_USER`

---

## external (`_*`)

*Dynamic — tools loaded at runtime from external configuration.*

**Env vars**: `EXTERNAL_MCP_CONFIG`

---

## dify (`dify_*`)

List all available Dify AI platform tools. Dify is a self-hosted AI app builder at your-domain.com. Tools cover: app management (create/edit/delete apps), model provider config, tool & MCP server management, knowledge base/RAG datasets, workflow editing, runtime execution (chat, workflow, completion), monitoring/logs, and file uploads. Console tools auto-authenticate via JWT. App runtime tools require per-app API keys.

| Sub-tool | Description |
|----------|-------------|
| `login` | Authenticate with Dify Console API and cache JWT token. Called automatically by other tools when needed. |
| `list_apps` | List all Dify apps with their type, status, and IDs |
| `create_app` | Create a new Dify app (chatbot, workflow, agent, or completion) |
| `get_app` | Get detailed information about a specific app |
| `delete_app` | Delete a Dify app permanently |
| `get_app_config` | Get full app configuration including model, prompt, tools, and settings |
| `update_app_config` | Update app configuration (model, prompt, tools, opening statement, etc.) |
| `publish_app` | Publish the current draft app configuration to make it live |
| `list_model_providers` | List all configured model providers and their status |
| `configure_model_provider` | Configure a model provider with API credentials (e.g. openai, anthropic, ollama) |
| `list_models` | List available models for a specific provider |
| `list_tools` | List all available tools (built-in, API-based, and MCP) that can be used in apps |
| `get_app_tools` | Get the tools currently enabled for a specific app/agent |
| `update_app_tools` | Enable or disable tools for an agent app. Pass the full tools array. |
| `list_mcp_servers` | List all configured MCP tool providers |
| `add_mcp_server` | Add an external MCP server as a tool provider |
| `remove_mcp_server` | Remove an MCP server tool provider |
| `list_api_tools` | List custom API-based tool providers (OpenAPI schema tools) |
| `create_api_tool` | Create a custom API tool provider from an OpenAPI schema |
| `list_datasets` | List all knowledge base datasets |
| `create_dataset` | Create a new knowledge base dataset |
| `delete_dataset` | Delete a knowledge base dataset |
| `list_documents` | List documents in a knowledge base dataset |
| `upload_document` | Upload a text document to a knowledge base dataset |
| `link_dataset` | Link a knowledge base dataset to an app for RAG context |
| `get_workflow` | Get the full workflow graph (nodes, edges, variables) for a workflow app |
| `update_workflow` | Update the workflow graph (nodes, edges) for a workflow app |
| `publish_workflow` | Publish a workflow draft to make it executable |
| `get_app_api_keys` | Get API keys for a specific app (used for /v1 endpoint access) |
| `create_app_api_key` | Create a new API key for a specific app |
| `chat` | Send a message to a chatbot or agent app via its per-app API key |
| `run_workflow` | Execute a workflow app via its per-app API key |
| `run_workflow_async` | Start a workflow asynchronously - returns task_id and workflow_run_id immediately without waiting. Use get_workflow_run to poll for results. |
| `get_workflow_run` | Get status and results of a workflow run. Returns status (running/succeeded/failed/stopped), outputs, elapsed_time, total_tokens. |
| `stop_workflow_task` | Stop a running workflow task |
| `completion` | Send a text completion request via an app |
| `list_conversations` | List conversations for an app |
| `get_app_logs` | Get conversation logs and messages for an app |
| `get_app_stats` | Get usage statistics for an app (token usage, request count, etc.) |
| `upload_file` | Upload a file for use as context in chat or workflow (returns file ID) |

**Env vars**: `DIFY_API_URL`, `DIFY_EMAIL`, `DIFY_PASSWORD`

---

## openhands (`openhands_*`)

List all available OpenHands AI coding agent tools. OpenHands is a self-hosted autonomous coding agent at Tower:3001. Tools cover: conversation/session management (create, list, start/stop agent), messaging (send tasks, view events), runtime info (VS Code URL, web hosts), settings (LLM config), secrets management, and git provider integration. Use create_conversation to start a new coding task, then start_conversation to run the agent.

| Sub-tool | Description |
|----------|-------------|
| `get_config` | Get OpenHands server configuration (app mode, feature flags) |
| `list_models` | List available LLM models |
| `list_agents` | List available AI agents |
| `list_security_analyzers` | List available security analyzers |
| `get_settings` | Get current user settings (LLM config, agent, etc.) |
| `update_settings` | Update user settings (LLM model, API key, agent, language, etc.) |
| `list_conversations` | List conversations with optional filters. Returns paginated results. |
| `create_conversation` | Create a new conversation/coding session. Optionally provide initial instructions and a repo to clone. |
| `get_conversation` | Get details of a specific conversation |
| `delete_conversation` | Delete a conversation and its data |
| `update_conversation` | Update a conversation |
| `start_conversation` | Start the AI agent loop for a conversation. The agent will begin working on the task. |
| `stop_conversation` | Stop the AI agent loop for a conversation |
| `get_events` | Get events from a conversation |
| `send_message` | Send a user message to a running conversation |
| `send_event` | Send a raw event to a conversation (advanced). Used for custom actions like CmdRunAction, FileWriteAction, etc. |
| `get_runtime_config` | Get runtime configuration for a conversation (runtime_id, session_id) |
| `get_vscode_url` | Get the VS Code URL for a conversation |
| `get_web_hosts` | Get web host URLs for a conversation |
| `get_microagents` | Get microagents loaded in a conversation |
| `list_secrets` | List stored secret names (values are not returned) |
| `create_secret` | Create a new secret (stored server-side, available to agent) |
| `update_secret` | Update an existing secret |
| `delete_secret` | Delete a stored secret |
| `add_git_providers` | Store git provider tokens (GitHub, GitLab, Bitbucket) for the agent to use |
| `clear_git_providers` | Clear all stored git provider tokens |

**Env vars**: `OPENHANDS_API_KEY`, `OPENHANDS_URL`

---

## traefik (`traefik_*`)

List all available Traefik reverse proxy tools. Traefik manages HTTP routing for all services. Tools cover: overview/version, router listing/inspection, service listing/inspection, middleware listing, entrypoints, TCP routers/services, and diagnostics (find_route, check_conflicts). All read-only — no mutations. Use find_route to debug which router handles a hostname, and check_conflicts to detect routing issues.

| Sub-tool | Description |
|----------|-------------|
| `get_overview` | Get Traefik dashboard overview: router/service/middleware counts, active providers, feature flags |
| `get_version` | Get Traefik version info |
| `list_routers` | List all HTTP routers with their rules, entrypoints, service bindings, and status |
| `get_router` | Get detailed info for a specific HTTP router |
| `list_services` | List all HTTP services with their load balancer URLs and health status |
| `get_service` | Get detailed info for a specific HTTP service |
| `list_middlewares` | List all HTTP middlewares (auth, rate limiting, headers, etc.) |
| `get_middleware` | Get detailed info for a specific middleware |
| `list_entrypoints` | List all entrypoints (ports Traefik listens on: http/80, https/443, etc.) |
| `list_tcp_routers` | List TCP routers (non-HTTP traffic routing) |
| `list_tcp_services` | List TCP services |
| `find_route` | Find which router handles a given hostname (searches all routers for a Host match) |
| `check_conflicts` | Check for routing conflicts: duplicate rules, overlapping paths, priority issues |

**Env vars**: `TRAEFIK_API_URL`

---

## redis (`redis_*`)

List all available Redis tools. Redis is the shared cache/message broker used by Dify, plugin daemon, and other services. Tools cover: server info (info, keyspace, memory, dbsize), key operations (scan, get, set, delete, type), pub/sub channel listing, and slow query log. Databases: db0 (general), db1 (Dify), db2 (Dify plugin daemon).

| Sub-tool | Description |
|----------|-------------|
| `info` | Get Redis server info. Sections: server, clients, memory, stats, replication, cpu, keyspace, or  |
| `keyspace` | Show which databases have keys and how many (quick overview of Redis usage) |
| `memory` | Get Redis memory usage stats (used_memory, peak, fragmentation ratio, etc.) |
| `dbsize` | Get total key count in a specific database |
| `scan_keys` | Scan keys matching a pattern (non-blocking, safe for production). Returns up to 100 keys. |
| `get_key` | Get the value of a key. Handles strings, lists, sets, hashes, and sorted sets automatically. |
| `set_key` | Set a string key value. Optionally set TTL in seconds. |
| `delete_key` | Delete one or more keys |
| `key_type` | Get the type and TTL of a key |
| `list_channels` | List active pub/sub channels matching a pattern |
| `slowlog` | Get recent slow queries (useful for debugging performance) |

**Env vars**: `REDIS_HOST`, `REDIS_PASSWORD`, `REDIS_PORT`

---

## mongodb (`mongodb_*`)

List all available MongoDB tools. MongoDB hosts data for LibreChat and Compose-Craft. Tools cover: database listing/status, collection management (list/create/drop), document CRUD (find/insert/update/delete), indexes, and aggregation pipelines.

| Sub-tool | Description |
|----------|-------------|
| `list_databases` | List all databases with their sizes |
| `server_status` | Get MongoDB server status (version, uptime, connections, memory, operations) |
| `list_collections` | List all collections in a database with document counts and sizes |
| `create_collection` | Create a new collection in a database |
| `drop_collection` | Drop (delete) a collection and all its documents. DESTRUCTIVE. |
| `find_documents` | Query documents in a collection. Returns up to 50 documents. |
| `count_documents` | Count documents matching a filter |
| `insert_document` | Insert a single document into a collection |
| `insert_many` | Insert multiple documents into a collection |
| `update_documents` | Update documents matching a filter |
| `delete_documents` | Delete documents matching a filter |
| `list_indexes` | List all indexes on a collection |
| `create_index` | Create an index on a collection |
| `aggregate` | Run an aggregation pipeline on a collection |

**Env vars**: `MONGODB_URL`

---

## recipes (`recipe_*`)

List all available container recipe tools. Recipes are reusable Docker container templates stored in Vault. Tools cover: recipe CRUD (list/get/store/delete), deployment (preview/deploy/redeploy/teardown), and importing running containers as recipes. Use import_running to capture existing containers, store_recipe to create new templates, preview_deploy to review before deploying, and deploy_recipe to launch.

| Sub-tool | Description |
|----------|-------------|
| `list_recipes` | List all stored container recipes |
| `get_recipe` | Get full details of a stored recipe including all env vars, volumes, labels |
| `store_recipe` | Store a new container recipe. Provide the full container configuration. |
| `delete_recipe` | Delete a stored recipe (does NOT affect running containers) |
| `preview_deploy` | Preview what deploying a recipe would do WITHOUT actually creating anything. Shows the Docker API request body and checks for conflicts. |
| `deploy_recipe` | Deploy a recipe: pull image, create container, start it. Requires confirm=true. Will NOT overwrite existing containers — use redeploy_recipe for that. |
| `redeploy_recipe` | Stop, remove, and recreate a container from its recipe. DESTRUCTIVE — the old container and its non-volume data will be lost. Requires confirm=true. |
| `teardown` | Stop and remove a container by name. DESTRUCTIVE. Requires confirm=true. Does NOT delete the recipe. |
| `import_running` | Import a currently running container as a recipe. Inspects the container and saves its config to Vault. |
| `export_to_git` | Export all recipes from Vault to the homelab-infrastructure GitLab repo as JSON files. Secrets are automatically redacted. |

**Env vars**: `DOCKER_HOST`, `GITLAB_TOKEN`, `GITLAB_URL`

---

## blueprints (`blueprint_*`)

List all available agent blueprint tools. Blueprints are modular automation specs that define Dify AI apps, n8n workflows, database tables, knowledge bases, and guardrails (action budgets, approval gates, auto-sunset). Tools cover: blueprint CRUD (save/list/get/status/delete), deployment (deploy/teardown), guardrails (check_action_budget/record_action/check_sunset/kill_agent), and templates (list/get/save). Use the automation-architect agent to generate blueprints from natural language, or create them manually.

| Sub-tool | Description |
|----------|-------------|
| `save_blueprint` | Validate and store an agent blueprint in Vault. The blueprint defines all components (Dify apps, n8n workflows, databases, knowledge bases) and guardrails (action budgets, approval gates, auto-sunset) for an automation agent. |
| `list_blueprints` | List all stored agent blueprints with their status and component summary |
| `get_blueprint` | Get full details of a blueprint including all component definitions and guardrails |
| `get_blueprint_status` | Check deployment status of each component in a blueprint |
| `deploy_blueprint` | Trigger the n8n Blueprint Deployer pipeline to provision all components. Requires confirm=true. The deployer creates Dify apps, n8n workflows, database tables, knowledge bases, and registers everything in the knowledge graph. |
| `teardown_blueprint` | Remove all deployed components for a blueprint. DESTRUCTIVE — deactivates n8n workflows, deletes Dify apps, drops tables. Requires confirm=true. Does NOT delete the blueprint spec from Vault. |
| `delete_blueprint` | Permanently delete a blueprint spec and all its state from Vault. Does NOT teardown deployed components — use teardown_blueprint first. Requires confirm=true. |
| `check_action_budget` | Check if an agent has remaining action budget for today. Returns whether the agent can proceed and how many actions remain. |
| `record_action` | Record an action for an agent. Increments the daily counter and updates last-activity timestamp. Call this after every agent action for guardrail tracking. |
| `check_sunset` | Check if an agent should be auto-disabled due to inactivity based on its auto_disable_after guardrail. |
| `kill_agent` | Emergency stop: immediately deactivate all n8n workflows and mark the agent as killed. Requires confirm=true. |
| `list_templates` | List available blueprint templates (starting-point blueprints for common automation patterns) |
| `get_template` | Get a blueprint template. Use as a starting point to customize for a specific use case. |
| `save_template` | Store a blueprint as a reusable template |

**Env vars**: `N8N_API_KEY`, `N8N_API_URL`, `REDIS_HOST`, `REDIS_PASSWORD`, `REDIS_PORT`

---

## projects (`project_*`)

List all available Project Pipeline tools. Manages the full dev-team automation lifecycle: idea capture, research (13 sections), architecture, security review, planning, building, and completion. Tools cover: project CRUD (create/list/get/update/advance/archive), research (start/get/update/complete), agent tasks (create/list/update/run_devteam_workflow), human-in-the-loop reviews (submit_for_review/check_review/list_pending_reviews), async questions (add/answer/get_unanswered/get), sprints (add/update/start/complete), artifacts (add/list), tracking (log_event/get_metrics/get_timeline), and Overwatch modules (classify_project/approve_classification/start_module/get_module_status).

| Sub-tool | Description |
|----------|-------------|
| `create_project` | Create a new project idea. Inserts into PG and triggers GitLab sync via n8n. |
| `list_projects` | List projects with optional filters. Returns summary with question counts. By default excludes abandoned/complete projects — pass status= |
| `get_project` | Get full project details by slug: project data + research sections + sprints + artifacts + question count. |
| `update_project` | Update project fields. Syncs changes to GitLab via n8n. |
| `advance_stage` | Move project to next stage with validation gates. queue→research→architecture→security_review→planning→active→completed. |
| `archive_project` | Soft-archive a project (sets stage to  |
| `start_research` | Set project stage to  |
| `get_research` | Get all research sections for a project. |
| `update_research` | Update a specific research section with findings. |
| `complete_research` | Mark research done and compile/store scope of work. |
| `add_question` | Post a question about a project. Sends Mattermost notification for async Q&A. |
| `answer_question` | Answer a question by ID. Checks if this unblocks research and triggers resume if so. |
| `get_unanswered` | Get all unanswered questions, optionally filtered by project. Sorted: blocking first. |
| `get_questions` | Get all questions for a project (answered and unanswered). |
| `add_sprint` | Add a sprint plan to a project. |
| `update_sprint` | Update sprint fields: status, actual hours, actual LOC, tasks. |
| `start_sprint` | Set a sprint to active and record start timestamp. |
| `complete_sprint` | Complete a sprint. Records timestamp and updates project actual_hours. |
| `create_agent_task` | Create an agent task for a project sprint. Used by the dev-team orchestrator to queue work items. |
| `list_agent_tasks` | List agent tasks for a project, optionally filtered by status or type. |
| `update_agent_task` | Update an agent task status, result, or iteration count. |
| `run_devteam_workflow` | Run a dev-team Dify workflow. Pass async=true to return immediately with a job_id (poll with get_devteam_result). Default: blocking. |
| `get_devteam_result` | Check status/result of an async dev-team workflow job. Returns status (running\|succeeded\|failed) and result when done. |
| `add_artifact` | Link a file, container, service, repo, or URL to a project. |
| `list_artifacts` | List all artifacts for a project. |
| `log_event` | Log a manual event for a project. |
| `run_sprint` | Execute a sprint by launching an OpenHands coding session with detailed prompts from Dify. Auto-creates workspace/repos if needed. Monitors completion and submits for review. |
| `populate_sprints_from_sow` | Parse the project |
| `get_metrics` | Build analytics: avg hours per complexity, estimate accuracy, cost per project, LOC velocity. |
| `get_timeline` | Get event history for a project. |
| `submit_for_review` | Submit a deliverable for human review in Mattermost. Posts to #human-review with approve/reject instructions. Creates a pending review agent_task. |
| `check_review` | Check the status of a review task (pending_review, completed/approved, or failed/rejected). |
| `list_pending_reviews` | List all pending review tasks awaiting human approval. |
| `classify_project` | Classify a project using Overwatch AI. Determines project_type, revenue_model, deliverable_type, and recommended modules. |
| `approve_classification` | Approve (or override) an Overwatch classification. Activates modules and starts the pipeline. |
| `start_module` | Manually start a module (for HitL-gated or re-invocable modules). |
| `get_module_status` | Get the full Overwatch module pipeline status for a project. |

**Env vars**: `DIFY_AGENT_DISCOVERY_KEY`, `DIFY_AGENT_LIGHTRAG_KEY`, `DIFY_AGENT_PROMPT_AUDIT_KEY`, `DIFY_AGENT_SCAFFOLDING_KEY`, `DIFY_API_BASE`, `DIFY_AUTO_GUARDRAILS_KEY`, `DIFY_AUTO_INTEGRATION_KEY`, `DIFY_AUTO_TOOLS_KEY`, `DIFY_AUTO_TRIGGERS_KEY`, `DIFY_AUTO_WORKFLOW_KEY`, `DIFY_KEY_ARCHITECTURE`, `DIFY_KEY_ARCHITECT_DESIGN`, `DIFY_KEY_ARCHITECT_REVISE`, `DIFY_KEY_BEST_PRACTICES`, `DIFY_KEY_CODE_REVIEWER`, `DIFY_KEY_CONTAINERS`, `DIFY_KEY_COSTS`, `DIFY_KEY_DEPENDENCIES`, `DIFY_KEY_FILE_STRUCTURE`, `DIFY_KEY_FOCUSED_RESEARCH`, `DIFY_KEY_INTEGRATION`, `DIFY_KEY_LIBRARIES`, `DIFY_KEY_OPEN_SOURCE_SCAN`, `DIFY_KEY_PM_GENERATE_SOW`, `DIFY_KEY_PM_GENERATE_TASKS`, `DIFY_KEY_PRIOR_ART`, `DIFY_KEY_SECURITY`, `DIFY_KEY_SECURITY_REVIEW`, `DIFY_KEY_TOOLS`, `DIFY_KEY_UI_UX_RESEARCH`, `DIFY_LAUNCH_DISTRIBUTION_KEY`, `DIFY_LAUNCH_LANDING_KEY`, `DIFY_LAUNCH_MARKETPLACE_KEY`, `DIFY_LAUNCH_PRICING_KEY`, `DIFY_MARKET_COMPETITORS_KEY`, `DIFY_MARKET_DEMAND_KEY`, `DIFY_MARKET_DIFFERENTIATION_KEY`, `DIFY_MARKET_PRICING_KEY`, `DIFY_MARKET_STRATEGY_REPORT_KEY`, `DIFY_MARKET_TAM_KEY`, `DIFY_MARKET_TIMING_KEY`, `DIFY_OVERWATCH_CLASSIFY_KEY`, `DIFY_STRATEGY_BRAND_KEY`, `DIFY_STRATEGY_CAMPAIGNS_KEY`, `DIFY_STRATEGY_CHANNELS_KEY`, `DIFY_STRATEGY_CONTENT_KEY`, `DIFY_STRATEGY_GTM_KEY`, `DIFY_STRATEGY_SOCIAL_KEY`, `GITLAB_PROJECTS_GROUP_ID`, `N8N_WEBHOOK_BASE`, `N8N_WH_DEVTEAM_ORCHESTRATOR`, `N8N_WH_GITLAB_SYNC`, `N8N_WH_RESEARCH_PIPELINE`, `N8N_WH_RESEARCH_RESUME`, `OPENHANDS_SANDBOX_REPO`

---

## figma (`figma_*`)

List all available Figma design tools

| Sub-tool | Description |
|----------|-------------|
| `get_file` | Get a Figma file by key. Use depth to limit response size (1=pages only, 2=top-level frames). Returns document structure, components, styles. |
| `get_file_nodes` | Get specific nodes from a Figma file by node IDs. More efficient than fetching the full file when you know which frames/components you need. |
| `get_images` | Render specific nodes as images (PNG, SVG, JPG, PDF). Returns URLs to rendered images. |
| `get_image_fills` | Get download URLs for all images used as fills in a file |
| `get_comments` | List all comments on a Figma file |
| `post_comment` | Add a comment to a Figma file. Can pin to a specific location or node. |
| `delete_comment` | Delete a comment from a Figma file |
| `get_file_versions` | Get version history of a Figma file |
| `get_team_projects` | List all projects in a Figma team |
| `get_project_files` | List all files in a Figma project |
| `get_file_components` | Get all components published from a file (component library) |
| `get_file_component_sets` | Get all component sets (variant groups) published from a file |
| `get_file_styles` | Get all styles published from a file (colors, text, effects, grids) |
| `get_team_components` | Get all published components across a team |
| `get_team_styles` | Get all published styles across a team |

**Env vars**: `FIGMA_API_KEY`

---

## workspaces (`workspace_*`)

List all available Workspace orchestration tools. Workspaces tie together a projectGitLab repo, OpenHands coding sessions, Figma designs, and filesystem artifacts into a unified development context. Tools cover: workspace creation (GitLab repo + DB record), coding sessions (OpenHands conversation management), visual QA (Playwright screenshots), git operations (merge sprint branches), and recipe generation for deployment.

| Sub-tool | Description |
|----------|-------------|
| `create_workspace` | Create a full project workspace: GitLab repo, filesystem path, optional Figma link, and DB record. Creates a PRIVATE repo under the specified GitLab group. |
| `get_workspace` | Get full workspace state for a project by slug. Joins project info from pipeline_projects. |
| `create_coding_session` | Spin up an OpenHands conversation for a sprint task. Creates the conversation via OpenHands API and stores the conversation_id in the workspace record. |
| `get_session_status` | Check OpenHands conversation progress. Returns conversation details and the last 10 events. |
| `capture_screenshot` | Take a Playwright screenshot of a running dev server URL. Saves to the workspace directory on the host filesystem. |
| `compare_visuals` | Compare two images for visual QA (Figma render vs screenshot). Currently reports file metadata — pixel diffing will be added later. |
| `merge_sprint` | Merge a sprint branch to main in GitLab. Creates a merge request and immediately merges it. |
| `generate_recipe` | Generate a container recipe spec from completed project artifacts. Reads workspace state, sprints, and tasks, then composes a recipe JSON suitable for the blueprint/recipe system. |

**Env vars**: `FIGMA_API_KEY`, `GITHUB_TOKEN`, `GITLAB_GROUP`, `GITLAB_REGISTRY_HOST`, `GITLAB_TOKEN`, `GITLAB_URL`, `OPENHANDS_API_KEY`, `OPENHANDS_SANDBOX_REPO`, `OPENHANDS_URL`, `PUBLIC_DOMAIN`

---

## preferences (`pref_*`)

List all available preference management tools and their parameters

| Sub-tool | Description |
|----------|-------------|
| `pref_store` | Store a development preference with semantic embedding. Embedding is generated from concatenation of domain + topic + context + preference. |
| `pref_search` | Search preferences by semantic similarity. Use this to find relevant design/dev preferences for a project context. |
| `pref_list` | List all stored preferences with optional domain filter. |
| `pref_update` | Update an existing preference by ID. Re-embeds if semantic fields change. |
| `pref_delete` | Delete a preference by ID. |
| `pref_export` | Export all preferences as a structured JSON document, grouped by domain. |

---

## persona (`persona_*`)

List all available persona/mini-me tools. Builds Trevorcaptures personality, opinions, communication style, and decision-making patterns. Tools: question flow (get_question/submit_answer/skip_question), batches (get_batch_status/generate_batch), analysis (get_coverage/get_profile_summary/search_profile/get_observations), training data (get_training_data/export_dataset/retry_digest), dashboard (get_stats).

| Sub-tool | Description |
|----------|-------------|
| `get_question` | Get the next unanswered question from the active batch. Optionally filter by mode (voice/text/media) and category. |
| `submit_answer` | Submit an answer to a question. Triggers background digestion into training pairs, observations, and profile entries. |
| `skip_question` | Skip a question that doesn |
| `get_batch_status` | Get current batch progress: questions answered, breakdown by category and mode. |
| `generate_batch` | Generate a new batch of 25 questions using Dify. Only works if current batch is complete or none exists. Use force=true to override. |
| `get_coverage` | Get gap analysis: coverage scores per category, weakest areas, depth distribution, dimensional coverage. |
| `get_profile_summary` | Get personality snapshot from Qdrant, grouped by category. Optionally filter by category. |
| `search_profile` | Semantic search across the persona profile in Qdrant. |
| `get_observations` | List personality observations from PostgreSQL. |
| `get_training_data` | Get training pairs in specified format, optionally filtered by category. |
| `export_dataset` | Full LoRA-ready export as JSON. Formats: alpaca (instruction/input/output) or sharegpt (conversations array). |
| `retry_digest` | Re-run digestion on a response that failed or needs updating. |
| `get_stats` | Overall statistics dashboard for the persona system. |

**Env vars**: `DIFY_API_BASE`, `DIFY_PERSONA_DIGEST_KEY`, `DIFY_PERSONA_GENERATE_KEY`

---

## agentforge (`agentforge_*`)

List all available AgentForge tools. AgentForge automates the end-to-end process of creating AI agents: researching domains via HuggingFace Hub, building knowledge graphs, optimizing prompts via A/B testing, and scaffolding complete Dify workflow apps. Tools cover: pipeline management (create/get/list experiments, run_pipeline), discovery (HF model/dataset search, add sources, fetch details), KG construction (extract triples, import to Neo4j, query), prompt optimization (create experiments, generate/evaluate variants, get results), scaffold & deploy (generate configs, deploy to Dify), and PM framework (evaluate resources, approve/skip).

| Sub-tool | Description |
|----------|-------------|
| `create_experiment` | Create a new AgentForge experiment. An experiment tracks the full pipeline: discovery → KG → optimization → scaffolding. |
| `get_experiment` | Get full experiment details including discovery/triple/prompt counts. |
| `list_experiments` | List all AgentForge experiments. |
| `discover_models` | Search HuggingFace Hub for models relevant to the experiment domain. Stores results as discoveries. |
| `discover_datasets` | Search HuggingFace Hub for datasets relevant to the experiment domain. Stores results as discoveries. |
| `add_source` | Manually add a discovery source (web page, paper, etc.) with its text content for KG extraction. |
| `list_discoveries` | List discovered sources for an experiment. |
| `fetch_model_details` | Fetch full details + README from a HuggingFace model and store as raw_text on the discovery for triple extraction. |
| `extract_triples` | Extract entity-relation-entity triples from a discovery |
| `list_triples` | List extracted triples for an experiment, with optional filtering. |
| `import_kg` | Import extracted triples into Neo4j knowledge graph. Creates nodes with domain-specific labels and relationships. Only imports triples above the confidence threshold. |
| `query_domain_kg` | Query the domain-specific knowledge graph built by an experiment. Returns entities, relationships, and paths. |
| `create_prompt_experiment` | Create a prompt optimization experiment. Define the base prompt, evaluation criteria, and test cases for A/B testing. |
| `generate_variants` | Generate prompt variants for a prompt experiment using LLM. Creates N alternative prompts optimized for the evaluation criteria. |
| `evaluate_variants` | Evaluate prompt variants against test cases using an LLM judge. Scores each variant and identifies the winner. |
| `get_optimization_results` | Get prompt optimization results for an experiment, including all variants with scores. |
| `scaffold_agent` | Generate a complete Dify workflow app configuration from the experiment |

**Env vars**: `DIFY_API_URL`, `DIFY_EMAIL`, `DIFY_PASSWORD`, `NEO4J_PASSWORD`, `NEO4J_URL`, `NEO4J_USER`

---

## war-room (`warroom_*`)

List available War Room tools. War rooms are AI agent debate sessions (PM, Architect, Security) that review research and draft SoW before finalization. Tools: start_war_room, get_war_room_status, resume_war_room, list_war_rooms.

| Sub-tool | Description |
|----------|-------------|
| `start_war_room` | Start a war room session for a project. Creates a Mattermost channel, generates agenda from research + SoW, and runs the debate flow. |
| `get_war_room_status` | Get the current state of a war room session: agenda, decisions, escalations. |
| `resume_war_room` | Resume a paused/escalated war room after human resolves escalations. Finalizes the session and generates revised SoW. |
| `list_war_rooms` | List all war room sessions, optionally filtered by state. |

**Env vars**: `DIFY_API_BASE`, `DIFY_ARCHITECT_WARROOM_KEY`, `DIFY_PM_WARROOM_KEY`, `DIFY_SECURITY_WARROOM_KEY`

---

## gitlab (`gitlab_*`)

List all available GitLab tools and their parameters

| Sub-tool | Description |
|----------|-------------|
| `list_projects` | List accessible GitLab projects |
| `get_project` | Get full details for a GitLab project |
| `create_project` | Create a new GitLab project (auto_devops disabled by default) |
| `search_projects` | Search GitLab projects by name or path |
| `delete_project` | Delete a GitLab project (DESTRUCTIVE - requires confirm: true) |
| `get_file` | Read file contents from a GitLab repository |
| `create_file` | Create a new file in a GitLab repository with a commit |
| `update_file` | Update an existing file in a GitLab repository with a commit |
| `delete_file` | Delete a file from a GitLab repository with a commit |
| `list_tree` | Browse repository directory tree |
| `list_branches` | List branches in a GitLab repository |
| `create_branch` | Create a new branch in a GitLab repository |
| `get_diff` | Compare two branches, tags, or commits |
| `list_merge_requests` | List merge requests in a GitLab project |
| `create_merge_request` | Create a merge request |
| `merge_merge_request` | Merge a merge request |
| `get_merge_request_changes` | View the diff/changes of a merge request |
| `list_issues` | List issues in a GitLab project |
| `create_issue` | Create an issue in a GitLab project |
| `update_issue` | Update an issue (title, state, labels, assignees) |
| `list_pipelines` | List recent CI/CD pipelines |
| `get_pipeline` | Get pipeline details including jobs |
| `get_job_log` | Read CI/CD job output log (truncated to last N chars) |
| `retry_pipeline` | Retry a failed pipeline |
| `list_registry_tags` | List container registry repositories and their tags |

---

## rag-generator (`rag_generator_*`)

List knowledge builder tools

| Sub-tool | Description |
|----------|-------------|
| `build_knowledge_base` | Full autonomous pipeline: research topic with Sonar Pro, scrape with Firecrawl, evaluate quality, chunk with context injection, embed with nomic-embed-text-v1.5, store in Qdrant. Optionally runs GitHub and Research API discovery in parallel. Fire and forget. |
| `discover_from_github` | Search GitHub repos for knowledge on any topic (markdown docs, guides, READMEs). Uses curated design seed repos only for design_knowledge collection. Auto-generates search queries for other topics. Fire and forget. |
| `discover_from_research` | Search academic databases (Semantic Scholar, OpenAlex, CORE) for research papers on any topic. Ingests abstracts, TLDRs, and full text where available. Auto-generates search queries from topic if not provided. Fire and forget. |
| `discover_from_wikipedia` | Mine Wikipedia articles for high-quality reference URLs, then ingest the good ones. Fire and forget. |
| `smart_ingest` | Scrape a single URL via Firecrawl, evaluate quality + auto-tag with AI, embed with nomic-embed-text-v1.5, ingest to Qdrant if high quality. |
| `batch_smart_ingest` | Scrape and ingest multiple URLs. Fire and forget. |
| `create_collection` | Create a new Qdrant collection (supports hybrid with dense + sparse vectors) |
| `query_knowledge` | Advanced RAG query: multi-query rewriting (original + technical + HyDE), AI reranking, MMR diversity. Fetches from 3 parallel search paths, deduplicates, reranks, then applies MMR for balanced results. |
| `validate_collection` | Get statistics, coverage analysis, and quality metrics |
| `queue_job` | Add a knowledge builder job to the persistent queue. Jobs execute in priority order with concurrency limits. |
| `list_queue` | List jobs in the knowledge builder queue. Shows pending, running, and recent completed/failed jobs. |
| `cancel_job` | Cancel a pending job in the queue. |
| `queue_stats` | Queue statistics: job counts, cost tracking, API usage across all jobs. |
| `curate_collection` | RAG curator agent. Analyzes a collection for gaps, generates targeted discovery queries, and dispatches to selected channels. Runs build_knowledge_base first if collection is empty. Uses a reasoning model for lateral thinking. Supports selective channels: web, github, research, or all. |
| `view_logs` | View persistent knowledge builder pipeline logs. Logs persist for 7 days across container restarts. |
| `generate_golden_set` | Generate a synthetic evaluation dataset from existing collection content. Samples chunks, generates natural-language queries via AI, validates retrieval. Used as ground truth for benchmarking. |
| `run_eval` | Execute retrieval quality benchmarks using golden sets. Computes Recall@K, MRR, NDCG@10, Precision@5. Compares against previous runs and alerts on regression. |
| `migrate_collection` | Migrate a dense-only collection to hybrid (dense + sparse vectors). Reads all points, generates sparse vectors, creates new hybrid collection, swaps. |
| `discover_from_source` | Generic connector-based discovery. Searches a specific source connector, evaluates, and ingests results. Supports 22 data sources. |
| `list_connectors` | List all available source connectors with their health status, categories, and rate limits. |
| `collection_health` | Comprehensive health report: lifecycle state, drift detection, freshness, query volume, eval trends. |
| `refresh_stale_sources` | Find and re-crawl sources that haven |
| `retry_jobs` | Re-enqueue failed jobs and suspicious completions (duration < 5s). Creates new pending jobs with original parameters. |
| `requeue_empty_collections` | Scan for collections tracked in PG/Neo4j but with 0 Qdrant points. Re-enqueues build_knowledge_base for each. |
| `backfill_idf` | Backfill the IDF terms table by scrolling all points in a collection and extracting tokens from their text. Use after migration or when IDF table is empty. |
| `delete_collection` | Delete a knowledge base collection |
| `ingest_content` | Ingest pre-scraped content directly (no Firecrawl, no AI eval) |

**Env vars**: `ALPHA_VANTAGE_API_KEY`, `CORE_API_KEY`, `FIRECRAWL_API_KEY`, `FRED_API_KEY`, `GITHUB_TOKEN`, `GOVINFO_API_KEY`, `GUARDIAN_API_KEY`, `KB_CURATOR_MODEL`, `KB_EMBEDDING_MODEL`, `KB_EMBED_BATCH_SIZE`, `KB_EVAL_MODEL`, `KB_INGEST_CONCURRENCY`, `KB_LOG_DIR`, `KB_QUEUE_MAX_CONCURRENT`, `KB_QUEUE_POLL_MS`, `KB_RESEARCH_MODEL`, `NEWSAPI_API_KEY`, `PUBMED_API_KEY`, `ROLE`, `SEMANTIC_SCHOLAR_API_KEY`

---

## mm-slash (`_*`)

*Dynamic — tools loaded at runtime from external configuration.*

---

## nextcloud (`nextcloud_*`)

List all available Nextcloud tools and their parameters

| Sub-tool | Description |
|----------|-------------|
| `upload_file` | Upload content to a Nextcloud path |
| `download_file` | Download file content from Nextcloud |
| `list_folder` | List contents of a Nextcloud directory |
| `create_folder` | Create a directory in Nextcloud |
| `delete_item` | Delete a file or folder from Nextcloud |
| `move_item` | Move or rename a file or folder |
| `get_quota` | Show storage usage and available space |
| `search` | Search files by name pattern |

**Env vars**: `NEXTCLOUD_APP_PASSWORD`, `NEXTCLOUD_PUBLIC_URL`, `NEXTCLOUD_URL`, `NEXTCLOUD_USER`

---

*Auto-generated by `scripts/generate-docs.ts` — do not edit manually.*
