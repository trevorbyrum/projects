import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { chromium, Browser, Page } from "playwright";

let browser: Browser | null = null;
let page: Page | null = null;

async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
  }
  return browser;
}

async function getPage(): Promise<Page> {
  if (!page || page.isClosed()) {
    const b = await getBrowser();
    page = await b.newPage();
  }
  return page;
}

const tools: Record<string, { description: string; params: Record<string, string>; handler: (p: any) => Promise<any> }> = {
  navigate: {
    description: "Navigate to a URL",
    params: { url: "string - URL to navigate to" },
    handler: async ({ url }) => {
      const p = await getPage();
      await p.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return { status: "navigated", url, title: await p.title() };
    }
  },
  content: {
    description: "Get text content of the page or element",
    params: { selector: "string (optional) - CSS selector, defaults to body" },
    handler: async ({ selector }) => {
      const p = await getPage();
      const content = await p.locator(selector || "body").textContent({ timeout: 5000 });
      return content || "(no content)";
    }
  },
  html: {
    description: "Get HTML of the page or element",
    params: { selector: "string (optional) - CSS selector for specific element" },
    handler: async ({ selector }) => {
      const p = await getPage();
      let html = selector ? await p.locator(selector).innerHTML({ timeout: 5000 }) : await p.content();
      if (html.length > 50000) html = html.substring(0, 50000) + "\n... (truncated)";
      return html;
    }
  },
  click: {
    description: "Click an element",
    params: { selector: "string - CSS selector of element to click" },
    handler: async ({ selector }) => {
      const p = await getPage();
      await p.locator(selector).click({ timeout: 5000 });
      return { status: "clicked", selector };
    }
  },
  type: {
    description: "Type text into an input field",
    params: { selector: "string - CSS selector", text: "string - text to type", clear: "boolean (optional) - clear field first" },
    handler: async ({ selector, text, clear }) => {
      const p = await getPage();
      const loc = p.locator(selector);
      if (clear) await loc.clear({ timeout: 5000 });
      await loc.fill(text, { timeout: 5000 });
      return { status: "typed", selector, text };
    }
  },
  screenshot: {
    description: "Take a screenshot",
    params: { fullPage: "boolean (optional) - capture full page", selector: "string (optional) - screenshot specific element" },
    handler: async ({ fullPage, selector }) => {
      const p = await getPage();
      let buffer: Buffer;
      if (selector) {
        buffer = await p.locator(selector).screenshot({ timeout: 5000 });
      } else {
        buffer = await p.screenshot({ fullPage: fullPage || false });
      }
      return { type: "image", data: buffer.toString("base64"), mimeType: "image/png" };
    }
  },
  wait: {
    description: "Wait for an element to appear",
    params: { selector: "string - CSS selector to wait for", timeout: "number (optional) - timeout in ms, default 10000" },
    handler: async ({ selector, timeout }) => {
      const p = await getPage();
      await p.locator(selector).waitFor({ state: "visible", timeout: timeout || 10000 });
      return { status: "found", selector };
    }
  },
  evaluate: {
    description: "Execute JavaScript in the browser",
    params: { script: "string - JavaScript code to execute" },
    handler: async ({ script }) => {
      const p = await getPage();
      return await p.evaluate(script);
    }
  },
  url: {
    description: "Get current page URL and title",
    params: {},
    handler: async () => {
      const p = await getPage();
      return { url: p.url(), title: await p.title() };
    }
  },
  back: {
    description: "Go back to previous page",
    params: {},
    handler: async () => {
      const p = await getPage();
      await p.goBack({ waitUntil: "domcontentloaded" });
      return { status: "back", url: p.url() };
    }
  },
  close: {
    description: "Close the browser instance",
    params: {},
    handler: async () => {
      if (browser) {
        await browser.close();
        browser = null;
        page = null;
      }
      return { status: "closed" };
    }
  },
  links: {
    description: "Get all links on the page",
    params: { limit: "number (optional) - max links to return, default 50" },
    handler: async ({ limit }) => {
      const p = await getPage();
      return await p.evaluate((max) => {
        const anchors = Array.from(document.querySelectorAll("a[href]"));
        return anchors.slice(0, max).map(a => ({
          text: a.textContent?.trim().substring(0, 100) || "",
          href: (a as HTMLAnchorElement).href,
        }));
      }, limit || 50);
    }
  },
  select: {
    description: "Select an option from a dropdown",
    params: { selector: "string - CSS selector of select element", value: "string - value to select" },
    handler: async ({ selector, value }) => {
      const p = await getPage();
      await p.locator(selector).selectOption(value, { timeout: 5000 });
      return { status: "selected", selector, value };
    }
  },
};

export function registerPlaywrightTools(server: McpServer) {
  server.tool(
    "browser_list",
    "List all available browser automation tools and their parameters",
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
    "browser_call",
    "Execute a browser automation tool. Use browser_list to see available tools.",
    {
      tool: z.string().describe("Tool name from browser_list"),
      params: z.record(z.any()).optional().describe("Tool parameters as object"),
    },
    async ({ tool, params }) => {
      const toolDef = tools[tool];
      if (!toolDef) {
        return { content: [{ type: "text", text: JSON.stringify({ error: `Unknown tool: ${tool}`, available: Object.keys(tools) }) }] };
      }
      try {
        const result = await toolDef.handler(params || {});
        // Special handling for screenshot which returns image data
        if (result?.type === "image") {
          return { content: [{ type: "image", data: result.data, mimeType: result.mimeType }] };
        }
        return { content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] };
      } catch (err: any) {
        return { content: [{ type: "text", text: JSON.stringify({ error: err.message }) }] };
      }
    }
  );
}
