/**
 * GoHighLevel MCP Server v2.0
 * 
 * Modern MCP server using SDK 1.26+ with:
 * - McpServer high-level API with registerTool()
 * - Streamable HTTP transport (stateless) + legacy SSE
 * - Tool annotations (readOnlyHint, destructiveHint, etc.)
 * - Enhanced GHL API client with caching, retry, connection pooling
 * - Structured logging
 * - Auto-discovery tool registry
 */

import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

import { EnhancedGHLClient } from './enhanced-ghl-client.js';
import { ToolRegistry } from './tool-registry.js';
import { MCPAppsManager } from './apps/index.js';
import { GHLConfig } from './types/ghl-types.js';
import { registerExecuteRoutes } from './execute-route.js';
import { registerPAERoutes } from './pae-handler.js';
import { registerCommsRoutes } from './comms-open-status.js';
import { registerLegalRoutes } from './legal-pages.js';
import { BUILD_INFO } from './build-info.js';

import { randomUUID } from 'node:crypto';
import {
  isInitializeRequest,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';

dotenv.config();

// ─── Structured Logger ──────────────────────────────────────

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;
const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info';

function log(level: LogLevel, msg: string, data?: Record<string, unknown>) {
  if (LOG_LEVELS[level] < LOG_LEVELS[MIN_LEVEL]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(data || {}),
  };
  const out = level === 'error' ? process.stderr : process.stderr;
  out.write(JSON.stringify(entry) + '\n');
}

// ─── Server Bootstrap ───────────────────────────────────────

async function main() {
  const port = parseInt(process.env.PORT || process.env.MCP_SERVER_PORT || '8000');

  // ── 1. Initialize GHL Client ─────────────────────────────
  const config: GHLConfig = {
    accessToken: process.env.GHL_API_KEY || '',
    baseUrl: process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com',
    version: '2021-07-28',
    locationId: process.env.GHL_LOCATION_ID || '',
  };

  if (!config.accessToken) throw new Error('GHL_API_KEY is required');
  if (!config.locationId) throw new Error('GHL_LOCATION_ID is required');

  log('info', 'Initializing GHL API client', {
    baseUrl: config.baseUrl,
    locationId: config.locationId,
  });

  const ghlClient = new EnhancedGHLClient(config);

  // Test connection (non-fatal — a 401 here can be a Private Integration token
  // that is valid for read/write operations but not the specific probe endpoint)
  try {
    await ghlClient.testConnection();
    log('info', 'GHL API connection verified');
  } catch (err: any) {
    log('warn', 'GHL API connection probe failed — continuing startup (token may still be valid)', { error: err.message });
  }

  // ── 2. Create McpServer ──────────────────────────────────
  const mcpServer = new McpServer(
    { name: 'ghl-mcp-server', version: '2.0.0' },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // ── 3. Register All Tools ────────────────────────────────
  const registry = new ToolRegistry(ghlClient);
  const toolCount = registry.registerAll(mcpServer);
  log('info', `Registered ${toolCount} GHL tools`);

  // Register MCP Apps tools (skip duplicates already registered by GHL tools)
  const appsManager = new MCPAppsManager(ghlClient);
  const appTools = appsManager.getToolDefinitions();
  const registeredToolNames = new Set(registry.getAllToolNames());
  let appToolCount = 0;
  for (const tool of appTools) {
    // Skip if already registered by GHL tool modules (e.g. update_opportunity)
    if (registeredToolNames.has(tool.name)) {
      log('info', `Skipping app tool ${tool.name} (already registered by GHL module)`);
      continue;
    }
    const meta = (tool as any)._meta;
    mcpServer.registerTool(
      tool.name,
      {
        title: tool.name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        description: tool.description || '',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        inputSchema: tool.inputSchema as any,
        annotations: {
          readOnlyHint: tool.name.startsWith('view_'),
          destructiveHint: false,
          idempotentHint: tool.name.startsWith('view_'),
          openWorldHint: true,
        },
        _meta: meta,
      },
      async (args: any) => {
        try {
          const result = await appsManager.executeTool(tool.name, args || {});
          return {
            content: result.content || [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result.structuredContent,
          };
        } catch (err: any) {
          return {
            content: [{ type: 'text' as const, text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      }
    );
    appToolCount++;
  }
  log('info', `Registered ${appToolCount} MCP App tools`);

  const totalTools = toolCount + appToolCount;
  log('info', `Total tools registered: ${totalTools}`);

  // ── 4. Express App ───────────────────────────────────────
  const app = express();

  app.use(cors({
  origin: "*", // or restrict to Claude's origins
  methods: ["GET", "POST", "OPTIONS", "DELETE"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Mcp-Session-Id",
    "mcp-protocol-version",
    "x-ghl-access-token",
    "x-ghl-location-id",
    "Accept"
  ],
  exposedHeaders: ["Mcp-Session-Id", "mcp-protocol-version"],
  credentials: false,
}));

  app.use(express.json());

  // ── PAE Webhook Endpoint (registered before bearer-token guard) ──────────
  // GHL Custom Webhook action calls POST /pae/analyze with deal data JSON.
  // Uses its own x-pae-secret header auth (PAE_WEBHOOK_SECRET env var).
  registerPAERoutes(app, log);

  // ── COMMS-W1 Open-Status Endpoint (also before the bearer-token guard) ────
  // The "COMMS-W1 — Verified Send" workflow calls POST /comms/open-status from
  // a custom_webhook node 48 hours after sending, and routes on the returned
  // `opened` string. Same x-pae-secret auth (COMMS_WEBHOOK_SECRET, falling back
  // to PAE_WEBHOOK_SECRET).
  registerCommsRoutes(app, log);

  // ── Public legal pages (also before the bearer-token guard) ────────────
  // Google fetches /home, /privacy and /terms anonymously while verifying the
  // "REAL Solutions Lead Gen Monitor" OAuth app, so they must stay above the
  // guard below.
  registerLegalRoutes(app);

  // Bearer token auth
const BEARER_TOKEN = process.env.MCP_BEARER_TOKEN;
app.use((req, res, next) => {
  if (!BEARER_TOKEN) return next();
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${BEARER_TOKEN}`) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

  // Request logging middleware
  app.use((req, _res, next) => {
    log('debug', `${req.method} ${req.path}`, { ip: req.ip });
    next();
  });

  // ── 5. Streamable HTTP Endpoint ──────────────────────────
  // Stateless mode: create a fresh transport per request so each
  // client can do its own initialize → tools/list → tools/call lifecycle.
  // The McpServer + tools are registered once above and reused via
  // a helper that wires a new transport to a fresh McpServer clone per req.

  // Helper: register all tools on a fresh McpServer
  // Pass a clientOverride to use per-request GHL credentials instead of the
  // global env-level credentials (needed for multi-tenant deployments).
  function createFreshServer(clientOverride?: EnhancedGHLClient): Server {
    const srv = new Server(
      { name: 'ghl-mcp-server', version: '2.0.0' },
      { capabilities: { tools: {} } }
    );
    const reg = new ToolRegistry(clientOverride ?? ghlClient);
    const regNames = new Set(reg.getAllToolNames());
    const filteredAppTools = appTools.filter((t: any) => !regNames.has(t.name));
    const allToolDefs = reg.getAllToolDefinitions(filteredAppTools);

    srv.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: allToolDefs }));
    srv.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        const result = await reg.callTool(name, args || {});
        if (result !== undefined) {
          const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
          return { content: [{ type: 'text' as const, text }] };
        }
        if (appsManager.isAppTool(name)) {
          const appResult = await appsManager.executeTool(name, args || {});
          return {
            content: appResult.content || [{ type: 'text' as const, text: JSON.stringify(appResult) }],
            structuredContent: appResult.structuredContent,
          };
        }
        throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} not found`);
      } catch (err: any) {
        if (err instanceof McpError) throw err;
        return {
          content: [{ type: 'text' as const, text: `Error executing ${name}: ${err.message}` }],
          isError: true,
        };
      }
    });
    return srv;
  }

  app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json({
    resource: "https://ghlmcp.real-solutions-llc.com/mcp",
    authorization_servers: [],
    bearer_methods_supported: ["header"],
    scopes_supported: []
  });
});

// Some clients also probe with the path appended
app.get("/.well-known/oauth-protected-resource/mcp", (req, res) => {
  res.json({
    resource: "https://ghlmcp.real-solutions-llc.com/mcp",
    authorization_servers: [],
    bearer_methods_supported: ["header"],
    scopes_supported: []
  });
});

// Map of sessionId -> { transport, server }
const sessions: Record<string, { transport: StreamableHTTPServerTransport; server: Server }> = {};

app.post('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let entry = sessionId ? sessions[sessionId] : undefined;

    if (!entry && isInitializeRequest(req.body)) {
      // New session — create transport + server
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions[sid] = { transport, server };
          log('info', 'MCP session initialized', { sessionId: sid });
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete sessions[transport.sessionId];
          log('info', 'MCP session closed', { sessionId: transport.sessionId });
        }
      };

      // Per-request GHL credentials (your existing logic)
      const reqAccessToken = req.headers['x-ghl-access-token'] as string | undefined;
      const reqLocationId  = req.headers['x-ghl-location-id']  as string | undefined;
      let perRequestClient: EnhancedGHLClient | undefined;
      if (reqAccessToken && reqLocationId) {
        perRequestClient = new EnhancedGHLClient({
          accessToken: reqAccessToken,
          baseUrl: process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com',
          version: '2021-07-28',
          locationId: reqLocationId,
        });
      }

      const server = createFreshServer(perRequestClient);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (!entry) {
      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'No valid session — send initialize first' },
        id: null,
      });
      return;
    }

    await entry.transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    log('error', 'Streamable HTTP error', { error: err.message });
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /mcp — server-to-client notifications stream
app.get('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const entry = sessionId ? sessions[sessionId] : undefined;
  if (!entry) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await entry.transport.handleRequest(req, res);
});

// DELETE /mcp — client-initiated session termination
app.delete('/mcp', async (req, res) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  const entry = sessionId ? sessions[sessionId] : undefined;
  if (!entry) {
    res.status(400).send('Invalid or missing session ID');
    return;
  }
  await entry.transport.handleRequest(req, res);
});

  // ── 6. Legacy SSE Endpoint ───────────────────────────────
  // Keep SSE for backward compatibility with older clients
  const handleSSE = async (req: express.Request, res: express.Response) => {
    const sessionId = req.query.sessionId || 'unknown';
    log('info', 'SSE connection', { sessionId: String(sessionId) });

    try {
      // Create a fresh Server + SSE transport per connection
      // because SSE transport is stateful (one connection = one transport)
      const sseServer = new Server(
        { name: 'ghl-mcp-server', version: '2.0.0' },
        { capabilities: { tools: {} } }
      );

      const sseRegistry = new ToolRegistry(ghlClient);
      const sseRegNames = new Set(sseRegistry.getAllToolNames());
      const sseFilteredAppTools = appTools.filter((t: any) => !sseRegNames.has(t.name));
      const sseAllToolDefs = sseRegistry.getAllToolDefinitions(sseFilteredAppTools);

      sseServer.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: sseAllToolDefs }));
      sseServer.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        try {
          const result = await sseRegistry.callTool(name, args || {});
          if (result !== undefined) {
            const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            return { content: [{ type: 'text' as const, text }] };
          }
          if (appsManager.isAppTool(name)) {
            const appResult = await appsManager.executeTool(name, args || {});
            return {
              content: appResult.content || [{ type: 'text' as const, text: JSON.stringify(appResult) }],
              structuredContent: appResult.structuredContent,
            };
          }
          throw new McpError(ErrorCode.MethodNotFound, `Tool ${name} not found`);
        } catch (err: any) {
          if (err instanceof McpError) throw err;
          return {
            content: [{ type: 'text' as const, text: `Error executing ${name}: ${err.message}` }],
            isError: true,
          };
        }
      });

      const transport = new SSEServerTransport('/sse', res);
      await sseServer.connect(transport);

      req.on('close', () => {
        log('info', 'SSE connection closed', { sessionId: String(sessionId) });
      });
    } catch (err: any) {
      log('error', 'SSE error', { error: err.message, sessionId: String(sessionId) });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to establish SSE connection' });
      } else {
        res.end();
      }
    }
  };

  app.get('/sse', handleSSE);
  app.post('/sse', handleSSE);

  // ── 7. REST Endpoints ────────────────────────────────────

  const startTime = Date.now();

  app.get('/', (_req, res) => {
    const cacheStats = ghlClient.getCacheStats();
    res.json({
      name: 'GoHighLevel MCP Server',
      version: '2.0.0',
      status: 'running',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      endpoints: {
        health: '/health',
        capabilities: '/capabilities',
        tools: '/tools',
        mcp: '/mcp (Streamable HTTP)',
        sse: '/sse (Legacy SSE)',
      },
      tools: registry.getToolCounts(appToolCount),
      cache: cacheStats,
    });
  });

  app.get('/health', (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
      status: 'healthy',
      server: 'ghl-mcp-server',
      version: '2.0.0',
      // Which commit this build came from. A deployed build was once found to be
      // older than source with no way to tell; this is how a deploy gets verified
      // rather than assumed. `commit_source` names where the SHA came from —
      // RAILWAY_GIT_COMMIT_SHA in production, 'unavailable' if nothing set it.
      commit: BUILD_INFO.commit,
      commit_short: BUILD_INFO.commitShort,
      commit_source: BUILD_INFO.commitSource,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      tools: totalTools,
      memory: {
        rss: `${Math.round(mem.rss / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
      },
      cache: ghlClient.getCacheStats(),
    });
  });

  app.get('/capabilities', (_req, res) => {
    res.json({
      capabilities: { tools: {} },
      server: { name: 'ghl-mcp-server', version: '2.0.0' },
      transport: ['streamable-http', 'sse'],
    });
  });

  // Bridge routes: GET /tools (Anthropic format) + POST /execute
  // These are consumed by CRESyncFlow-v2's mcp-tools-bridge.ts.
  registerExecuteRoutes(app, registry, appsManager, appTools, config);

  app.post('/tools/call', async (req, res) => {
    const { name, arguments: args } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Missing tool name' });
      return;
    }

    log('info', `REST tool call: ${name}`);

    try {
      const result = await registry.callTool(name, args || {});
      if (result === undefined) {
        // Try MCP Apps
        if (appsManager.isAppTool(name)) {
          const appResult = await appsManager.executeTool(name, args || {});
          res.json({ result: appResult });
          return;
        }
        res.status(404).json({ error: `Unknown tool: ${name}` });
        return;
      }
      res.json({ result });
    } catch (err: any) {
      log('error', `REST tool error: ${name}`, { error: err.message });
      res.status(500).json({ error: `Tool execution failed: ${err.message}` });
    }
  });

  // ── 8. App Views — serve view_* tools as rendered HTML ──

  // Serve static UI assets
  const path = await import('path');
  const fs = await import('fs');
  const appUiDir = path.resolve(process.cwd(), 'dist', 'app-ui');

  // Static file serving for the HTML + assets
  app.use('/app-ui', express.static(appUiDir));

  // GET /apps — list all available views
  app.get('/apps', (_req, res) => {
    const viewTools = appTools.filter(t => t.name.startsWith('view_'));
    const views = viewTools.map(t => ({
      name: t.name,
      title: t.name.replace('view_', '').replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
      url: `/apps/${t.name.replace('view_', '')}`,
      description: t.description || '',
    }));
    res.json({ views, count: views.length });
  });

  // GET /apps/:viewName — render a view by calling the tool and injecting the UITree
  app.get('/apps/:viewName', async (req, res) => {
    const viewName = req.params.viewName;
    const toolName = `view_${viewName}`;

    try {
      // Pass query params to the view tool for drill-down navigation
      // e.g., /apps/contact_timeline?contactId=xxx → view_contact_timeline({ contactId: 'xxx' })
      const toolArgs: Record<string, string> = {};
      for (const [key, val] of Object.entries(req.query)) {
        if (key !== '_data' && typeof val === 'string') toolArgs[key] = val;
      }

      // Call the view tool to get the UITree
      let uiTree: any = null;

      // Try the apps manager first
      if (appsManager.isAppTool(toolName)) {
        const result = await appsManager.executeTool(toolName, toolArgs);
        if (result.structuredContent?.uiTree) {
          uiTree = result.structuredContent.uiTree;
        } else if (result.content) {
          for (const c of result.content) {
            if (c.type === 'text') {
              try {
                const parsed = JSON.parse(c.text);
                if (parsed.root && parsed.elements) uiTree = parsed;
                else if (parsed.uiTree?.root) uiTree = parsed.uiTree;
              } catch {}
            }
          }
        }
      } else {
        // Try the registry
        const result = await registry.callTool(toolName, toolArgs);
        if (result) {
          for (const c of (result as any).content || []) {
            if (c.type === 'text') {
              try {
                const parsed = JSON.parse(c.text);
                if (parsed.root && parsed.elements) uiTree = parsed;
                else if (parsed.uiTree?.root) uiTree = parsed.uiTree;
              } catch {}
            }
          }
        }
      }

      if (!uiTree) {
        res.status(404).json({ error: `View "${viewName}" not found or returned no UI tree` });
        return;
      }

      // Read the host-wrapper.html template (fakes MCP host handshake so React UI kit renders fully)
      const htmlPath = path.join(appUiDir, 'host-wrapper.html');
      let html = '';
      try {
        html = fs.readFileSync(htmlPath, 'utf-8');
      } catch {
        res.status(500).json({ error: 'host-wrapper.html not found in dist/app-ui/' });
        return;
      }

      // Inject the UITree data via window.__MCP_APP_DATA__
      const dataScript = `<script>window.__MCP_APP_DATA__ = ${JSON.stringify(uiTree)};</script>`;
      html = html.replace('<head>', `<head>${dataScript}`);

      // Update the title
      const title = viewName.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase());
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${title} — GHL CRM</title>`);

      res.type('html').send(html);
    } catch (err: any) {
      log('error', `App view error: ${viewName}`, { error: err.message });
      res.status(500).json({ error: `Failed to render view: ${err.message}` });
    }
  });

  // ── 9. Start Server ──────────────────────────────────────
  app.listen(port, '0.0.0.0', () => {
    console.log('🚀 GoHighLevel MCP Server v2.0');
    console.log('═══════════════════════════════════════════');
    console.log(`🌐 Server: http://0.0.0.0:${port}`);
    console.log(`📡 Streamable HTTP: http://0.0.0.0:${port}/mcp`);
    console.log(`🔗 Legacy SSE: http://0.0.0.0:${port}/sse`);
    console.log(`🛠️  Tools: ${totalTools}`);
    console.log(`📦 SDK: @modelcontextprotocol/sdk 1.27.1`);
    console.log('═══════════════════════════════════════════');
  });
}

// ─── Graceful Shutdown ──────────────────────────────────────

process.on('SIGINT', () => { log('info', 'Shutting down (SIGINT)'); process.exit(0); });
process.on('SIGTERM', () => { log('info', 'Shutting down (SIGTERM)'); process.exit(0); });

main().catch((err) => {
  log('error', 'Fatal error', { error: err.message, stack: err.stack });
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
