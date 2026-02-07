import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const DOCKER_HOST = process.env.DOCKER_HOST || "http://docker-socket-proxy:2375";

async function dockerFetch(endpoint: string, options: RequestInit = {}): Promise<any> {
  const url = `${DOCKER_HOST}${endpoint}`;
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Docker API error (${response.status}): ${error}`);
  }
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("application/json")) return response.json();
  return response.text();
}

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
  list_containers: {
    description: "List Docker containers",
    params: { all: "boolean (optional) - show stopped containers too" },
    handler: async ({ all }) => {
      const containers = await dockerFetch(`/containers/json?all=${all || false}`);
      return containers.map((c: any) => ({
        id: c.Id.substring(0, 12),
        name: c.Names[0]?.replace(/^\//, ""),
        image: c.Image,
        state: c.State,
        status: c.Status,
        ports: c.Ports?.map((p: any) => `${p.PublicPort || ""}:${p.PrivatePort}/${p.Type}`).filter((p: string) => p),
      }));
    }
  },
  inspect: {
    description: "Get detailed container information",
    params: { container: "string - container name or ID" },
    handler: async ({ container }) => {
      const info = await dockerFetch(`/containers/${container}/json`);
      return { id: info.Id, name: info.Name, image: info.Config.Image, state: info.State, created: info.Created, env: info.Config.Env, ports: info.NetworkSettings.Ports, mounts: info.Mounts, networks: Object.keys(info.NetworkSettings.Networks) };
    }
  },
  logs: {
    description: "Get container logs",
    params: { container: "string - container name or ID", tail: "number (optional) - lines from end, default 100", since: "string (optional) - timestamp or duration" },
    handler: async ({ container, tail, since }) => {
      let endpoint = `/containers/${container}/logs?stdout=true&stderr=true&tail=${tail || 100}`;
      if (since) endpoint += `&since=${since}`;
      const logs = await dockerFetch(endpoint);
      return logs.replace(/[\x00-\x08]/g, "").replace(/\r/g, "");
    }
  },
  start: {
    description: "Start a stopped container",
    params: { container: "string - container name or ID" },
    handler: async ({ container }) => {
      await dockerFetch(`/containers/${container}/start`, { method: "POST" });
      return { status: "started", container };
    }
  },
  stop: {
    description: "Stop a running container",
    params: { container: "string - container name or ID", timeout: "number (optional) - seconds before kill, default 10" },
    handler: async ({ container, timeout }) => {
      await dockerFetch(`/containers/${container}/stop?t=${timeout || 10}`, { method: "POST" });
      return { status: "stopped", container };
    }
  },
  restart: {
    description: "Restart a container",
    params: { container: "string - container name or ID", timeout: "number (optional) - seconds before kill" },
    handler: async ({ container, timeout }) => {
      await dockerFetch(`/containers/${container}/restart?t=${timeout || 10}`, { method: "POST" });
      return { status: "restarted", container };
    }
  },
  exec: {
    description: "Execute command in a container",
    params: { container: "string - container name or ID", cmd: "string[] - command array e.g. ['ls', '-la']", workdir: "string (optional) - working directory" },
    handler: async ({ container, cmd, workdir }) => {
      const execCreate = await dockerFetch(`/containers/${container}/exec`, {
        method: "POST",
        body: JSON.stringify({ AttachStdout: true, AttachStderr: true, Cmd: cmd, WorkingDir: workdir }),
      });
      const response = await fetch(`${DOCKER_HOST}/exec/${execCreate.Id}/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ Detach: false, Tty: false }),
      });
      const output = await response.text();
      return output.replace(/[\x00-\x08]/g, "").replace(/\r/g, "") || "(no output)";
    }
  },
  list_images: {
    description: "List Docker images",
    params: {},
    handler: async () => {
      const images = await dockerFetch("/images/json");
      return images.map((i: any) => ({
        id: i.Id.replace("sha256:", "").substring(0, 12),
        tags: i.RepoTags,
        size: `${Math.round(i.Size / 1024 / 1024)}MB`,
        created: new Date(i.Created * 1000).toISOString(),
      }));
    }
  },
  pull_image: {
    description: "Pull a Docker image",
    params: { image: "string - image:tag e.g. nginx:latest" },
    handler: async ({ image }) => {
      const [name, tag = "latest"] = image.split(":");
      await dockerFetch(`/images/create?fromImage=${name}&tag=${tag}`, { method: "POST" });
      return { status: "pulled", image: `${name}:${tag}` };
    }
  },
  run: {
    description: "Create and start a new container",
    params: { name: "string - container name", image: "string - image to use", env: "string[] (optional) - ['VAR=value']", ports: "object (optional) - {'80/tcp': '8080'}", volumes: "string[] (optional) - ['host:container']", network: "string (optional)", restart: "no|always|unless-stopped|on-failure (optional)", labels: "object (optional)" },
    handler: async ({ name, image, env, ports, volumes, network, restart, labels }) => {
      const portBindings: any = {};
      const exposedPorts: any = {};
      if (ports) {
        for (const [containerPort, hostPort] of Object.entries(ports)) {
          exposedPorts[containerPort] = {};
          portBindings[containerPort] = [{ HostPort: hostPort }];
        }
      }
      const createBody = {
        Image: image, Env: env, ExposedPorts: exposedPorts, Labels: labels,
        HostConfig: { PortBindings: portBindings, Binds: volumes || [], NetworkMode: network, RestartPolicy: { Name: restart || "unless-stopped" } },
      };
      const created = await dockerFetch(`/containers/create?name=${name}`, { method: "POST", body: JSON.stringify(createBody) });
      await dockerFetch(`/containers/${created.Id}/start`, { method: "POST" });
      return { status: "running", id: created.Id.substring(0, 12), name };
    }
  },
  remove: {
    description: "Remove a container",
    params: { container: "string - container name or ID", force: "boolean (optional) - force remove running", volumes: "boolean (optional) - remove volumes too" },
    handler: async ({ container, force, volumes }) => {
      await dockerFetch(`/containers/${container}?force=${force || false}&v=${volumes || false}`, { method: "DELETE" });
      return { status: "removed", container };
    }
  },
  list_networks: {
    description: "List Docker networks",
    params: {},
    handler: async () => {
      const networks = await dockerFetch("/networks");
      return networks.map((n: any) => ({ id: n.Id.substring(0, 12), name: n.Name, driver: n.Driver, scope: n.Scope }));
    }
  },
  info: {
    description: "Get Docker system info",
    params: {},
    handler: async () => {
      const info = await dockerFetch("/info");
      return { containers: info.Containers, containersRunning: info.ContainersRunning, containersStopped: info.ContainersStopped, images: info.Images, serverVersion: info.ServerVersion, memoryTotal: `${Math.round(info.MemTotal / 1024 / 1024 / 1024)}GB`, cpus: info.NCPU, os: info.OperatingSystem, architecture: info.Architecture };
    }
  },
};

export function registerDockerTools(server: McpServer) {
  server.tool("docker_list", "List all available Docker tools and their parameters", {}, async () => {
    const toolList = Object.entries(tools).map(([name, def]) => ({ tool: name, description: def.description, params: def.params }));
    return { content: [{ type: "text", text: JSON.stringify(toolList, null, 2) }] };
  });

  server.tool("docker_call", "Execute a Docker tool. Use docker_list to see available tools.", {
    tool: z.string().describe("Tool name from docker_list"),
    params: z.record(z.any()).optional().describe("Tool parameters"),
  }, async ({ tool, params }) => {
    const toolDef = tools[tool];
    if (!toolDef) return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${tool}`, available: Object.keys(tools) }) }] };
    try {
      const result = await toolDef.handler(params || {});
      return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
    }
  });
}
