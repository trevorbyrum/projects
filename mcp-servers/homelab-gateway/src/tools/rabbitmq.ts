import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const RABBIT_URL = process.env.RABBITMQ_URL || "http://RabbitMQ:15672";
const RABBIT_USER = process.env.RABBITMQ_USER || "guest";
const RABBIT_PASS = process.env.RABBITMQ_PASS || "guest";

async function rabbitFetch(path: string, method = "GET", body?: any): Promise<any> {
  const auth = Buffer.from(`${RABBIT_USER}:${RABBIT_PASS}`).toString("base64");
  const res = await fetch(`${RABBIT_URL}/api${path}`, {
    method,
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`RabbitMQ ${method} ${path}: ${res.status} - ${await res.text()}`);
  return res.json();
}

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
  overview: {
    description: "Get RabbitMQ cluster overview (version, message rates, queue totals, node info)",
    params: {},
    handler: async () => {
      const data = await rabbitFetch("/overview");
      return {
        version: data.rabbitmq_version,
        erlang_version: data.erlang_version,
        cluster_name: data.cluster_name,
        message_stats: data.message_stats,
        queue_totals: data.queue_totals,
        object_totals: data.object_totals,
        node: data.node,
        listeners: data.listeners?.map((l: any) => `${l.protocol}:${l.port}`),
      };
    },
  },
  queues: {
    description: "List all queues with message counts and consumer info",
    params: { vhost: "(optional) Virtual host, default '/'" },
    handler: async ({ vhost }) => {
      const v = encodeURIComponent(vhost || "/");
      const queues = await rabbitFetch(`/queues/${v}`);
      return queues.map((q: any) => ({
        name: q.name,
        messages: q.messages,
        messages_ready: q.messages_ready,
        messages_unacked: q.messages_unacknowledged,
        consumers: q.consumers,
        state: q.state,
        durable: q.durable,
      }));
    },
  },
  exchanges: {
    description: "List all exchanges",
    params: { vhost: "(optional) Virtual host, default '/'" },
    handler: async ({ vhost }) => {
      const v = encodeURIComponent(vhost || "/");
      const exchanges = await rabbitFetch(`/exchanges/${v}`);
      return exchanges.map((e: any) => ({
        name: e.name || "(default)",
        type: e.type,
        durable: e.durable,
        auto_delete: e.auto_delete,
      }));
    },
  },
  connections: {
    description: "List active connections",
    params: {},
    handler: async () => {
      const conns = await rabbitFetch("/connections");
      return conns.map((c: any) => ({
        name: c.name,
        user: c.user,
        state: c.state,
        channels: c.channels,
        connected_at: c.connected_at,
        client_properties: c.client_properties?.product,
      }));
    },
  },
  create_queue: {
    description: "Declare a new queue",
    params: {
      name: "Queue name",
      vhost: "(optional) Virtual host, default '/'",
      durable: "(optional) Survive broker restart, default true",
    },
    handler: async ({ name, vhost, durable }) => {
      const v = encodeURIComponent(vhost || "/");
      await rabbitFetch(`/queues/${v}/${encodeURIComponent(name)}`, "PUT", {
        durable: durable !== false,
        auto_delete: false,
      });
      return { status: "created", queue: name, vhost: vhost || "/" };
    },
  },
  publish: {
    description: "Publish a message to an exchange",
    params: {
      exchange: "Exchange name (empty string for default)",
      routing_key: "Routing key (queue name for default exchange)",
      payload: "Message body (string)",
      vhost: "(optional) Virtual host, default '/'",
    },
    handler: async ({ exchange, routing_key, payload, vhost }) => {
      const v = encodeURIComponent(vhost || "/");
      const e = encodeURIComponent(exchange || "amq.default");
      const result = await rabbitFetch(`/exchanges/${v}/${e}/publish`, "POST", {
        routing_key,
        payload,
        payload_encoding: "string",
        properties: {},
      });
      return { routed: result.routed, exchange: exchange || "(default)", routing_key };
    },
  },
  get_messages: {
    description: "Get messages from a queue (peek, does not consume by default)",
    params: {
      queue: "Queue name",
      count: "(optional) Number of messages, default 1",
      ack_mode: "(optional) 'ack_requeue_true' (default, non-destructive) or 'ack_requeue_false' (consume)",
      vhost: "(optional) Virtual host, default '/'",
    },
    handler: async ({ queue, count, ack_mode, vhost }) => {
      const v = encodeURIComponent(vhost || "/");
      const result = await rabbitFetch(`/queues/${v}/${encodeURIComponent(queue)}/get`, "POST", {
        count: count || 1,
        ackmode: ack_mode || "ack_requeue_true",
        encoding: "auto",
      });
      return result.map((m: any) => ({
        payload: m.payload,
        routing_key: m.routing_key,
        exchange: m.exchange,
        message_count: m.message_count,
        redelivered: m.redelivered,
      }));
    },
  },
  delete_queue: {
    description: "Delete a queue",
    params: { name: "Queue name", vhost: "(optional) Virtual host, default '/'" },
    handler: async ({ name, vhost }) => {
      const v = encodeURIComponent(vhost || "/");
      await rabbitFetch(`/queues/${v}/${encodeURIComponent(name)}`, "DELETE");
      return { status: "deleted", queue: name };
    },
  },
};

export function registerRabbitmqTools(server: McpServer) {
  server.tool(
    "rabbitmq_list",
    "List all available RabbitMQ message queue tools",
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
    "rabbitmq_call",
    "Manage RabbitMQ message queues, exchanges, and connections. Use rabbitmq_list to see available tools.",
    {
      tool: z.string().describe("Tool name from rabbitmq_list"),
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
