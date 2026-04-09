/**
 * GoHighLevel MCP HTTP Server (Legacy SSE)
 * 
 * HTTP version for ChatGPT web integration using SSE transport.
 * For the modern Streamable HTTP transport, use main.ts instead.
 * 
 * This file is kept for backward compatibility with older clients
 * that only support SSE.
 */

import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { 
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError 
} from '@modelcontextprotocol/sdk/types.js';
import * as dotenv from 'dotenv';

import { GHLApiClient } from './clients/ghl-api-client.js';
import { ToolRegistry } from './tool-registry.js';
import { MCPAppsManager } from './apps/index.js';
import { GHLConfig } from './types/ghl-types.js';

// Load environment variables
dotenv.config();

/**
 * HTTP MCP Server class for web deployment (Legacy SSE)
 */
class GHLMCPHttpServer {
  private app: express.Application;
  private ghlClient: GHLApiClient;
  private registry: ToolRegistry;
  private mcpAppsManager: MCPAppsManager;
  private port: number;

  constructor() {
    this.port = parseInt(process.env.PORT || process.env.MCP_SERVER_PORT || '8000');
    
    // Initialize Express app
    this.app = express();
    this.setupExpress();

    // Initialize GHL API client
    this.ghlClient = this.initializeGHLClient();
    
    // Initialize tool registry (auto-discovers all tools)
    this.registry = new ToolRegistry(this.ghlClient);

    // Initialize MCP Apps Manager
    this.mcpAppsManager = new MCPAppsManager(this.ghlClient);

    // Setup routes
    this.setupRoutes();
  }

  /**
   * Setup Express middleware
   */
  private setupExpress(): void {
    this.app.use(cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (/^https?:\/\/localhost(:\d+)?$/.test(origin) ||
            origin === 'https://chatgpt.com' ||
            origin === 'https://chat.openai.com') {
          return callback(null, true);
        }
        callback(new Error('CORS not allowed'));
      },
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
      credentials: true
    }));

    this.app.use(express.json());

    const BEARER_TOKEN = process.env.MCP_BEARER_TOKEN;

    this.app.use((req, res, next) => {
      if(!BEARER_TOKEN) return next();

      const auth = req.headers['authorization'];

      if(!auth || auth !== `Bearer ${BEARER_TOKEN}`){
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      next();
    });

    this.app.use((req, _res, next) => {
      console.log(`[HTTP] ${req.method} ${req.path} - ${new Date().toISOString()}`);
      next();
    });
  }

  /**
   * Initialize GoHighLevel API client with configuration
   */
  private initializeGHLClient(): GHLApiClient {
    const config: GHLConfig = {
      accessToken: process.env.GHL_API_KEY || '',
      baseUrl: process.env.GHL_BASE_URL || 'https://services.leadconnectorhq.com',
      version: '2021-07-28',
      locationId: process.env.GHL_LOCATION_ID || ''
    };

    if (!config.accessToken) {
      throw new Error('GHL_API_KEY environment variable is required');
    }

    if (!config.locationId) {
      throw new Error('GHL_LOCATION_ID environment variable is required');
    }

    console.log('[GHL MCP HTTP] Initializing GHL API client...');
    console.log(`[GHL MCP HTTP] Base URL: ${config.baseUrl}`);
    console.log(`[GHL MCP HTTP] Location ID: ${config.locationId}`);

    return new GHLApiClient(config);
  }

  /**
   * Create a fresh MCP Server + SSE transport for a connection.
   * Each SSE connection gets its own server instance because
   * SSE transport is stateful (one connection = one transport).
   */
  private createSSEServer(): Server {
    const server = new Server(
      { name: 'ghl-mcp-server', version: '2.0.0' },
      { capabilities: { tools: {} } }
    );

    const allTools = this.registry.getAllToolDefinitions(
      this.mcpAppsManager.getToolDefinitions()
    );

    // Handle list tools
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      return { tools: allTools };
    });

    // Handle tool execution
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      console.log(`[GHL MCP HTTP] Executing tool: ${name}`);

      try {
        // Check MCP App tools first
        if (this.mcpAppsManager.isAppTool(name)) {
          return await this.mcpAppsManager.executeTool(name, args || {});
        }

        // Route via registry
        const result = await this.registry.callTool(name, args || {});
        
        if (result === undefined) {
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
        
        return {
          content: [{
            type: 'text',
            text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        if (error instanceof McpError) throw error;
        
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[GHL MCP HTTP] Error executing tool ${name}:`, msg);
        throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${msg}`);
      }
    });

    return server;
  }

  /**
   * Setup HTTP routes
   */
  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (_req, res) => {
      res.json({ 
        status: 'healthy',
        server: 'ghl-mcp-server',
        version: '2.0.0',
        transport: 'sse',
        timestamp: new Date().toISOString(),
        tools: this.registry.getToolCount()
      });
    });

    // Capabilities
    this.app.get('/capabilities', (_req, res) => {
      res.json({
        capabilities: { tools: {} },
        server: { name: 'ghl-mcp-server', version: '2.0.0' }
      });
    });

    // Tools listing
    this.app.get('/tools', (_req, res) => {
      try {
        const allTools = this.registry.getAllToolDefinitions(
          this.mcpAppsManager.getToolDefinitions()
        );
        res.json({ tools: allTools, count: allTools.length });
      } catch {
        res.status(500).json({ error: 'Failed to list tools' });
      }
    });

    // REST tool call
    this.app.post('/tools/call', async (req, res) => {
      const { name, arguments: args } = req.body;
      if (!name) {
        res.status(400).json({ error: 'Missing tool name' });
        return;
      }

      console.log(`[GHL MCP HTTP] REST tool call: ${name}`);
      try {
        // Check MCP App tools
        if (this.mcpAppsManager.isAppTool(name)) {
          const result = await this.mcpAppsManager.executeTool(name, args || {});
          res.json({ result });
          return;
        }

        const result = await this.registry.callTool(name, args || {});
        if (result === undefined) {
          res.status(404).json({ error: `Unknown tool: ${name}` });
          return;
        }
        res.json({ result });
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`[GHL MCP HTTP] REST tool ${name} error:`, msg);
        res.status(500).json({ error: `Tool execution failed: ${msg}` });
      }
    });

    // SSE endpoint
    const handleSSE = async (req: express.Request, res: express.Response) => {
      const sessionId = req.query.sessionId || 'unknown';
      console.log(`[GHL MCP HTTP] New SSE connection, sessionId: ${sessionId}`);
      
      try {
        const server = this.createSSEServer();
        const transport = new SSEServerTransport('/sse', res);
        await server.connect(transport);
        
        console.log(`[GHL MCP HTTP] SSE connection established for session: ${sessionId}`);
        
        req.on('close', () => {
          console.log(`[GHL MCP HTTP] SSE connection closed for session: ${sessionId}`);
        });
      } catch (error) {
        console.error(`[GHL MCP HTTP] SSE connection error:`, error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to establish SSE connection' });
        } else {
          res.end();
        }
      }
    };

    this.app.get('/sse', handleSSE);
    this.app.post('/sse', handleSSE);

    // Root
    this.app.get('/', (_req, res) => {
      res.json({
        name: 'GoHighLevel MCP Server (Legacy SSE)',
        version: '2.0.0',
        status: 'running',
        endpoints: {
          health: '/health',
          capabilities: '/capabilities',
          tools: '/tools',
          sse: '/sse'
        },
        tools: this.registry.getToolCount(),
        note: 'For Streamable HTTP transport, use main.ts (start:http)'
      });
    });
  }

  /**
   * Test GHL API connection
   */
  private async testGHLConnection(): Promise<void> {
    try {
      console.log('[GHL MCP HTTP] Testing GHL API connection...');
      await this.ghlClient.testConnection();
      console.log('[GHL MCP HTTP] ✅ GHL API connection successful');
    } catch (error) {
      console.error('[GHL MCP HTTP] ❌ GHL API connection failed:', error);
      throw new Error(`Failed to connect to GHL API: ${error}`);
    }
  }

  /**
   * Start the HTTP server
   */
  async start(): Promise<void> {
    console.log('🚀 Starting GoHighLevel MCP HTTP Server (Legacy SSE)...');
    
    try {
      await this.testGHLConnection();
      
      this.app.listen(this.port, '0.0.0.0', () => {
        console.log('✅ GoHighLevel MCP HTTP Server started!');
        console.log(`🌐 Server: http://0.0.0.0:${this.port}`);
        console.log(`🔗 SSE: http://0.0.0.0:${this.port}/sse`);
        console.log(`📋 Tools: ${this.registry.getToolCount()}`);
      });
    } catch (error) {
      console.error('❌ Failed to start:', error);
      process.exit(1);
    }
  }
}

// Graceful shutdown
process.on('SIGINT', () => { console.log('\nShutting down...'); process.exit(0); });
process.on('SIGTERM', () => { console.log('\nShutting down...'); process.exit(0); });

// Main entry
async function main(): Promise<void> {
  try {
    const server = new GHLMCPHttpServer();
    await server.start();
  } catch (error) {
    console.error('💥 Fatal error:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
