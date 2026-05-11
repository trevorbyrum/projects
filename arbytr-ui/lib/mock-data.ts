/**
 * Mock data for the demo. All exports are plain functions/arrays so the
 * surface stays close to what a real API client would expose.
 *
 * Backend swap plan:
 *   - Each `getX()` function returns a Promise — replace the inner body
 *     with a real `fetch()` call. UI components import these helpers,
 *     not the raw arrays.
 *   - Mutations (add/remove/toggle) just modify the in-memory arrays; for
 *     real backend, swap to POST/PATCH/DELETE.
 */

export type Service = {
  id: string;
  name: string;
  location: "local" | "homelab" | "cloud-vm" | "container";
  status: "online" | "offline" | "connecting";
  uptime: string;
  toolCount: number;
  lastActivity: string;
  source: string;
};

export type Connector = {
  id: string;
  name: string;
  source: "directory" | "custom" | "openapi";
  url?: string;
  status: "connected" | "disconnected";
  toolCount: number;
  lastActivity: string;
  auth: "oauth" | "api-key" | "none";
};

export type Tool = {
  id: string;
  name: string;
  description: string;
  source: string;
  sourceType: "service" | "connector";
  classification: "read-only" | "read-write";
  enabled: boolean;
  params: { name: string; type: string; required: boolean }[];
};

export type User = {
  id: string;
  name: string;
  email: string;
  initials: string;
  profileId: string;
  lastActive: string;
  status: "active" | "inactive" | "invited";
};

export type RoleProfile = {
  id: string;
  name: string;
  description: string;
  userCount: number;
  serviceIds: string[];
  connectorIds: string[];
  toolIds: string[];
  lastModified: string;
};

export type Credential = {
  id: string;
  name: string;
  type: "api-key" | "oauth-token" | "bearer-token" | "basic-auth";
  bindings: { userId?: string; toolId?: string; connectorId?: string }[];
  created: string;
  lastUsed: string;
  lastRotated: string;
  status: "active" | "expired" | "revoked";
};

export type AuditEvent = {
  id: string;
  timestamp: string;
  userId: string;
  userName: string;
  toolName: string;
  source: string;
  params: Record<string, string>;
  status: "success" | "failure";
  duration: number;
};

/* ── Services ── */

export const services: Service[] = [
  {
    id: "svc-postgres",
    name: "Production Postgres",
    location: "cloud-vm",
    status: "online",
    uptime: "14d 3h",
    toolCount: 6,
    lastActivity: "2 min ago",
    source: "AWS / us-east-1",
  },
  {
    id: "svc-stripe-internal",
    name: "Internal Billing API",
    location: "container",
    status: "online",
    uptime: "32d 1h",
    toolCount: 8,
    lastActivity: "12 min ago",
    source: "GKE / billing-prod",
  },
  {
    id: "svc-jira",
    name: "Self-hosted Jira",
    location: "homelab",
    status: "online",
    uptime: "6d 18h",
    toolCount: 5,
    lastActivity: "1 hour ago",
    source: "Homelab rack 02",
  },
];

/* ── Connectors ── */

export const connectors: Connector[] = [
  {
    id: "con-gh",
    name: "GitHub",
    source: "directory",
    status: "connected",
    toolCount: 11,
    lastActivity: "4 min ago",
    auth: "oauth",
  },
  {
    id: "con-linear",
    name: "Linear",
    source: "directory",
    status: "connected",
    toolCount: 7,
    lastActivity: "1 hour ago",
    auth: "oauth",
  },
  {
    id: "con-slack",
    name: "Slack",
    source: "directory",
    status: "connected",
    toolCount: 9,
    lastActivity: "8 min ago",
    auth: "oauth",
  },
  {
    id: "con-notion",
    name: "Notion",
    source: "directory",
    status: "disconnected",
    toolCount: 4,
    lastActivity: "3 days ago",
    auth: "oauth",
  },
  {
    id: "con-acme-crm",
    name: "Acme CRM (OpenAPI)",
    source: "openapi",
    url: "https://crm.acme.internal/openapi.json",
    status: "connected",
    toolCount: 14,
    lastActivity: "27 min ago",
    auth: "api-key",
  },
];

/* ── Tools ── */

export const tools: Tool[] = [
  // Postgres
  { id: "tool-pg-1", name: "query_users", description: "Run a SELECT query against the users table. Use to look up account state.", source: "Production Postgres", sourceType: "service", classification: "read-only", enabled: true, params: [{ name: "where", type: "string", required: false }, { name: "limit", type: "number", required: false }] },
  { id: "tool-pg-2", name: "query_orders", description: "Read order history. Filter by status, date, or user_id.", source: "Production Postgres", sourceType: "service", classification: "read-only", enabled: true, params: [{ name: "filters", type: "object", required: false }] },
  { id: "tool-pg-3", name: "update_user_status", description: "Update a user's account status (active, suspended, deleted).", source: "Production Postgres", sourceType: "service", classification: "read-write", enabled: true, params: [{ name: "user_id", type: "string", required: true }, { name: "status", type: "string", required: true }] },
  { id: "tool-pg-4", name: "list_tables", description: "List all tables in the public schema with row counts.", source: "Production Postgres", sourceType: "service", classification: "read-only", enabled: true, params: [] },
  { id: "tool-pg-5", name: "describe_table", description: "Show the schema for a specific table.", source: "Production Postgres", sourceType: "service", classification: "read-only", enabled: true, params: [{ name: "table_name", type: "string", required: true }] },
  { id: "tool-pg-6", name: "execute_migration", description: "Run a SQL migration script. DESTRUCTIVE — use with care.", source: "Production Postgres", sourceType: "service", classification: "read-write", enabled: false, params: [{ name: "sql", type: "string", required: true }] },

  // Billing
  { id: "tool-bill-1", name: "get_invoice", description: "Fetch a single invoice by ID with line items.", source: "Internal Billing API", sourceType: "service", classification: "read-only", enabled: true, params: [{ name: "invoice_id", type: "string", required: true }] },
  { id: "tool-bill-2", name: "list_invoices", description: "List invoices for a customer over a date range.", source: "Internal Billing API", sourceType: "service", classification: "read-only", enabled: true, params: [{ name: "customer_id", type: "string", required: true }, { name: "from", type: "date", required: false }] },
  { id: "tool-bill-3", name: "create_refund", description: "Issue a refund against an invoice. Requires reason code.", source: "Internal Billing API", sourceType: "service", classification: "read-write", enabled: true, params: [{ name: "invoice_id", type: "string", required: true }, { name: "amount_cents", type: "number", required: true }, { name: "reason", type: "string", required: true }] },
  { id: "tool-bill-4", name: "void_invoice", description: "Void an outstanding invoice. Cannot be undone.", source: "Internal Billing API", sourceType: "service", classification: "read-write", enabled: false, params: [{ name: "invoice_id", type: "string", required: true }] },
  { id: "tool-bill-5", name: "get_customer", description: "Look up a customer record including subscription state.", source: "Internal Billing API", sourceType: "service", classification: "read-only", enabled: true, params: [{ name: "customer_id", type: "string", required: true }] },
  { id: "tool-bill-6", name: "update_subscription", description: "Change a customer's plan or seat count.", source: "Internal Billing API", sourceType: "service", classification: "read-write", enabled: true, params: [{ name: "customer_id", type: "string", required: true }, { name: "plan", type: "string", required: true }] },
  { id: "tool-bill-7", name: "list_payment_methods", description: "List a customer's saved payment methods.", source: "Internal Billing API", sourceType: "service", classification: "read-only", enabled: true, params: [{ name: "customer_id", type: "string", required: true }] },
  { id: "tool-bill-8", name: "send_dunning_email", description: "Trigger a dunning email for a past-due invoice.", source: "Internal Billing API", sourceType: "service", classification: "read-write", enabled: true, params: [{ name: "invoice_id", type: "string", required: true }] },

  // Jira
  { id: "tool-jira-1", name: "search_issues", description: "JQL search across the Jira instance.", source: "Self-hosted Jira", sourceType: "service", classification: "read-only", enabled: true, params: [{ name: "jql", type: "string", required: true }] },
  { id: "tool-jira-2", name: "get_issue", description: "Get a single issue with comments and attachments.", source: "Self-hosted Jira", sourceType: "service", classification: "read-only", enabled: true, params: [{ name: "key", type: "string", required: true }] },
  { id: "tool-jira-3", name: "create_issue", description: "Create a new issue in a project.", source: "Self-hosted Jira", sourceType: "service", classification: "read-write", enabled: true, params: [{ name: "project", type: "string", required: true }, { name: "summary", type: "string", required: true }] },
  { id: "tool-jira-4", name: "transition_issue", description: "Move an issue to a new status.", source: "Self-hosted Jira", sourceType: "service", classification: "read-write", enabled: true, params: [{ name: "key", type: "string", required: true }, { name: "transition", type: "string", required: true }] },
  { id: "tool-jira-5", name: "add_comment", description: "Add a comment to an issue.", source: "Self-hosted Jira", sourceType: "service", classification: "read-write", enabled: true, params: [{ name: "key", type: "string", required: true }, { name: "body", type: "string", required: true }] },

  // GitHub
  { id: "tool-gh-1", name: "search_code", description: "Search code across repositories.", source: "GitHub", sourceType: "connector", classification: "read-only", enabled: true, params: [{ name: "query", type: "string", required: true }] },
  { id: "tool-gh-2", name: "get_pull_request", description: "Get a PR with files changed and review comments.", source: "GitHub", sourceType: "connector", classification: "read-only", enabled: true, params: [{ name: "owner", type: "string", required: true }, { name: "repo", type: "string", required: true }, { name: "number", type: "number", required: true }] },
  { id: "tool-gh-3", name: "create_pull_request", description: "Open a new pull request from a branch.", source: "GitHub", sourceType: "connector", classification: "read-write", enabled: true, params: [{ name: "title", type: "string", required: true }, { name: "head", type: "string", required: true }, { name: "base", type: "string", required: true }] },
  { id: "tool-gh-4", name: "merge_pull_request", description: "Merge a pull request. Requires write permission.", source: "GitHub", sourceType: "connector", classification: "read-write", enabled: true, params: [{ name: "number", type: "number", required: true }] },

  // Linear
  { id: "tool-linear-1", name: "list_issues", description: "List issues assigned to the calling user.", source: "Linear", sourceType: "connector", classification: "read-only", enabled: true, params: [] },
  { id: "tool-linear-2", name: "create_issue", description: "Create a new Linear issue.", source: "Linear", sourceType: "connector", classification: "read-write", enabled: true, params: [{ name: "title", type: "string", required: true }] },
  { id: "tool-linear-3", name: "update_issue", description: "Update a Linear issue's state, assignee, or priority.", source: "Linear", sourceType: "connector", classification: "read-write", enabled: true, params: [{ name: "id", type: "string", required: true }] },

  // Slack
  { id: "tool-slack-1", name: "send_message", description: "Send a message to a Slack channel or DM.", source: "Slack", sourceType: "connector", classification: "read-write", enabled: true, params: [{ name: "channel", type: "string", required: true }, { name: "text", type: "string", required: true }] },
  { id: "tool-slack-2", name: "search_messages", description: "Search past Slack messages.", source: "Slack", sourceType: "connector", classification: "read-only", enabled: true, params: [{ name: "query", type: "string", required: true }] },

  // Acme CRM
  { id: "tool-crm-1", name: "find_account", description: "Look up a customer account by domain or email.", source: "Acme CRM (OpenAPI)", sourceType: "connector", classification: "read-only", enabled: true, params: [{ name: "domain", type: "string", required: false }] },
  { id: "tool-crm-2", name: "create_opportunity", description: "Create a new sales opportunity tied to an account.", source: "Acme CRM (OpenAPI)", sourceType: "connector", classification: "read-write", enabled: true, params: [{ name: "account_id", type: "string", required: true }, { name: "amount", type: "number", required: true }] },
  { id: "tool-crm-3", name: "update_opportunity_stage", description: "Move an opportunity through pipeline stages.", source: "Acme CRM (OpenAPI)", sourceType: "connector", classification: "read-write", enabled: true, params: [{ name: "id", type: "string", required: true }, { name: "stage", type: "string", required: true }] },
];

/* ── Users ── */

export const users: User[] = [
  { id: "u-1", name: "Trevor Byrum", email: "trevor@arbytr.com", initials: "TB", profileId: "prof-admin", lastActive: "Just now", status: "active" },
  { id: "u-2", name: "Maya Chen", email: "maya@acme.com", initials: "MC", profileId: "prof-eng", lastActive: "12 min ago", status: "active" },
  { id: "u-3", name: "Devon Park", email: "devon@acme.com", initials: "DP", profileId: "prof-eng", lastActive: "1 hour ago", status: "active" },
  { id: "u-4", name: "Sara Okonjo", email: "sara@acme.com", initials: "SO", profileId: "prof-finance", lastActive: "Yesterday", status: "active" },
  { id: "u-5", name: "Luca Romano", email: "luca@acme.com", initials: "LR", profileId: "prof-sales", lastActive: "3 days ago", status: "active" },
  { id: "u-6", name: "Priya Shah", email: "priya@acme.com", initials: "PS", profileId: "prof-support", lastActive: "2 hours ago", status: "active" },
  { id: "u-7", name: "Jordan Reed", email: "jordan@acme.com", initials: "JR", profileId: "prof-sales", lastActive: "Pending", status: "invited" },
];

/* ── Role Profiles ── */

export const roleProfiles: RoleProfile[] = [
  {
    id: "prof-admin",
    name: "Admin",
    description: "Full access to every service, connector, and tool.",
    userCount: 1,
    serviceIds: ["svc-postgres", "svc-stripe-internal", "svc-jira"],
    connectorIds: ["con-gh", "con-linear", "con-slack", "con-notion", "con-acme-crm"],
    toolIds: tools.map((t) => t.id),
    lastModified: "3 days ago",
  },
  {
    id: "prof-eng",
    name: "Engineering",
    description: "Read across infrastructure, write to GitHub and Jira.",
    userCount: 2,
    serviceIds: ["svc-postgres", "svc-jira"],
    connectorIds: ["con-gh", "con-linear", "con-slack"],
    toolIds: [
      "tool-pg-1", "tool-pg-2", "tool-pg-4", "tool-pg-5",
      "tool-jira-1", "tool-jira-2", "tool-jira-3", "tool-jira-4", "tool-jira-5",
      "tool-gh-1", "tool-gh-2", "tool-gh-3", "tool-gh-4",
      "tool-linear-1", "tool-linear-2", "tool-linear-3",
      "tool-slack-1", "tool-slack-2",
    ],
    lastModified: "1 day ago",
  },
  {
    id: "prof-finance",
    name: "Finance",
    description: "Read & refund authority over billing. No infra access.",
    userCount: 1,
    serviceIds: ["svc-stripe-internal"],
    connectorIds: ["con-slack"],
    toolIds: [
      "tool-bill-1", "tool-bill-2", "tool-bill-3", "tool-bill-5",
      "tool-bill-7", "tool-bill-8",
      "tool-slack-1",
    ],
    lastModified: "5 days ago",
  },
  {
    id: "prof-sales",
    name: "Sales",
    description: "CRM read/write, Slack, and customer lookups in billing.",
    userCount: 2,
    serviceIds: ["svc-stripe-internal"],
    connectorIds: ["con-acme-crm", "con-slack", "con-linear"],
    toolIds: [
      "tool-bill-5", "tool-bill-7",
      "tool-crm-1", "tool-crm-2", "tool-crm-3",
      "tool-slack-1", "tool-slack-2",
      "tool-linear-2",
    ],
    lastModified: "2 days ago",
  },
  {
    id: "prof-support",
    name: "Support",
    description: "Read-only across customer-facing systems.",
    userCount: 1,
    serviceIds: ["svc-stripe-internal", "svc-jira"],
    connectorIds: ["con-slack", "con-linear", "con-acme-crm"],
    toolIds: [
      "tool-bill-1", "tool-bill-2", "tool-bill-5", "tool-bill-7",
      "tool-jira-1", "tool-jira-2", "tool-jira-5",
      "tool-slack-1", "tool-slack-2",
      "tool-linear-1",
      "tool-crm-1",
    ],
    lastModified: "1 week ago",
  },
];

/* ── Credentials ── */

export const credentials: Credential[] = [
  {
    id: "cred-1",
    name: "Stripe Production Key",
    type: "api-key",
    bindings: [
      { toolId: "tool-bill-1", connectorId: undefined },
      { toolId: "tool-bill-3" },
      { toolId: "tool-bill-6" },
    ],
    created: "Mar 12, 2026",
    lastUsed: "8 min ago",
    lastRotated: "Apr 28, 2026",
    status: "active",
  },
  {
    id: "cred-2",
    name: "Postgres Read-Only Role",
    type: "basic-auth",
    bindings: [{ toolId: "tool-pg-1" }, { toolId: "tool-pg-2" }, { toolId: "tool-pg-4" }, { toolId: "tool-pg-5" }],
    created: "Feb 02, 2026",
    lastUsed: "2 min ago",
    lastRotated: "May 01, 2026",
    status: "active",
  },
  {
    id: "cred-3",
    name: "Postgres Write Role",
    type: "basic-auth",
    bindings: [{ toolId: "tool-pg-3", userId: "u-1" }, { toolId: "tool-pg-3", userId: "u-2" }],
    created: "Feb 02, 2026",
    lastUsed: "1 hour ago",
    lastRotated: "May 01, 2026",
    status: "active",
  },
  {
    id: "cred-4",
    name: "GitHub App Token",
    type: "oauth-token",
    bindings: [{ connectorId: "con-gh" }],
    created: "Jan 15, 2026",
    lastUsed: "4 min ago",
    lastRotated: "Apr 15, 2026",
    status: "active",
  },
  {
    id: "cred-5",
    name: "Slack Bot Token",
    type: "oauth-token",
    bindings: [{ connectorId: "con-slack" }],
    created: "Jan 18, 2026",
    lastUsed: "8 min ago",
    lastRotated: "Apr 18, 2026",
    status: "active",
  },
  {
    id: "cred-6",
    name: "Linear API Key",
    type: "api-key",
    bindings: [{ connectorId: "con-linear" }],
    created: "Feb 10, 2026",
    lastUsed: "1 hour ago",
    lastRotated: "Apr 10, 2026",
    status: "active",
  },
  {
    id: "cred-7",
    name: "Acme CRM Service Key",
    type: "api-key",
    bindings: [{ connectorId: "con-acme-crm" }],
    created: "Mar 22, 2026",
    lastUsed: "27 min ago",
    lastRotated: "Apr 22, 2026",
    status: "active",
  },
  {
    id: "cred-8",
    name: "Old Notion Token",
    type: "oauth-token",
    bindings: [{ connectorId: "con-notion" }],
    created: "Dec 01, 2025",
    lastUsed: "3 days ago",
    lastRotated: "Jan 12, 2026",
    status: "expired",
  },
];

/* ── Audit Events ── */

function minsAgo(n: number): string {
  const d = new Date(Date.now() - n * 60 * 1000);
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const auditEvents: AuditEvent[] = [
  { id: "ev-1", timestamp: minsAgo(2), userId: "u-2", userName: "Maya Chen", toolName: "query_users", source: "Production Postgres", params: { where: "email='alice@x.com'", limit: "1" }, status: "success", duration: 142 },
  { id: "ev-2", timestamp: minsAgo(4), userId: "u-3", userName: "Devon Park", toolName: "create_pull_request", source: "GitHub", params: { title: "Fix dunning email template", head: "fix/dunning", base: "main" }, status: "success", duration: 380 },
  { id: "ev-3", timestamp: minsAgo(8), userId: "u-4", userName: "Sara Okonjo", toolName: "get_invoice", source: "Internal Billing API", params: { invoice_id: "in_2nxAbq" }, status: "success", duration: 96 },
  { id: "ev-4", timestamp: minsAgo(12), userId: "u-2", userName: "Maya Chen", toolName: "search_messages", source: "Slack", params: { query: "incident in:#oncall" }, status: "success", duration: 211 },
  { id: "ev-5", timestamp: minsAgo(14), userId: "u-5", userName: "Luca Romano", toolName: "create_opportunity", source: "Acme CRM (OpenAPI)", params: { account_id: "acct_1f9", amount: "48000" }, status: "success", duration: 312 },
  { id: "ev-6", timestamp: minsAgo(18), userId: "u-4", userName: "Sara Okonjo", toolName: "create_refund", source: "Internal Billing API", params: { invoice_id: "in_2nxAbq", amount_cents: "4900", reason: "duplicate_charge" }, status: "success", duration: 244 },
  { id: "ev-7", timestamp: minsAgo(22), userId: "u-6", userName: "Priya Shah", toolName: "search_issues", source: "Self-hosted Jira", params: { jql: "project = SUP AND status = Open" }, status: "success", duration: 178 },
  { id: "ev-8", timestamp: minsAgo(25), userId: "u-3", userName: "Devon Park", toolName: "update_user_status", source: "Production Postgres", params: { user_id: "usr_92ax", status: "suspended" }, status: "failure", duration: 84 },
  { id: "ev-9", timestamp: minsAgo(31), userId: "u-2", userName: "Maya Chen", toolName: "get_pull_request", source: "GitHub", params: { owner: "acme", repo: "platform", number: "1284" }, status: "success", duration: 152 },
  { id: "ev-10", timestamp: minsAgo(38), userId: "u-5", userName: "Luca Romano", toolName: "find_account", source: "Acme CRM (OpenAPI)", params: { domain: "globex.com" }, status: "success", duration: 121 },
  { id: "ev-11", timestamp: minsAgo(48), userId: "u-6", userName: "Priya Shah", toolName: "send_message", source: "Slack", params: { channel: "#support-escalations", text: "Customer ticket #4823..." }, status: "success", duration: 88 },
  { id: "ev-12", timestamp: minsAgo(62), userId: "u-4", userName: "Sara Okonjo", toolName: "list_invoices", source: "Internal Billing API", params: { customer_id: "cus_8kP" }, status: "success", duration: 197 },
  { id: "ev-13", timestamp: minsAgo(75), userId: "u-2", userName: "Maya Chen", toolName: "transition_issue", source: "Self-hosted Jira", params: { key: "ENG-1492", transition: "In Review" }, status: "success", duration: 124 },
  { id: "ev-14", timestamp: minsAgo(95), userId: "u-1", userName: "Trevor Byrum", toolName: "list_tables", source: "Production Postgres", params: {}, status: "success", duration: 64 },
  { id: "ev-15", timestamp: minsAgo(120), userId: "u-3", userName: "Devon Park", toolName: "merge_pull_request", source: "GitHub", params: { number: "1284" }, status: "success", duration: 461 },
  { id: "ev-16", timestamp: minsAgo(140), userId: "u-2", userName: "Maya Chen", toolName: "describe_table", source: "Production Postgres", params: { table_name: "subscription_events" }, status: "success", duration: 56 },
  { id: "ev-17", timestamp: minsAgo(180), userId: "u-5", userName: "Luca Romano", toolName: "update_opportunity_stage", source: "Acme CRM (OpenAPI)", params: { id: "opp_77c", stage: "negotiation" }, status: "success", duration: 205 },
];

/* ── Dashboard stats ── */

export const dashboardStats = {
  uptime: "14d 3h 42m",
  servicesActive: 3,
  servicesTotal: 3,
  connectorsActive: 4,
  connectorsTotal: 5,
  usersActive: 6,
  toolsEnabled: tools.filter((t) => t.enabled).length,
  toolsTotal: tools.length,
  callsToday: 1247,
  callsWeek: 8392,
  callsMonth: 31847,
  connectionStatus: "connected" as const,
  connectionType: "WSS + mTLS" as const,
};

/* ── Async-style accessors (drop-in replace with fetch) ── */

export async function getServices() { return services; }
export async function getConnectors() { return connectors; }
export async function getTools() { return tools; }
export async function getUsers() { return users; }
export async function getRoleProfiles() { return roleProfiles; }
export async function getCredentials() { return credentials; }
export async function getAuditEvents() { return auditEvents; }
