/**
 * MCP client that connects to the Toast MCP Server's Streamable HTTP endpoint.
 * Handles session management, tool discovery, and tool invocation.
 */

interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface McpToolResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export class ToastMcpClient {
  private sessionId: string | null = null;
  private tools: McpToolDefinition[] = [];
  private initialized = false;

  constructor(
    private readonly serverUrl: string,
    private readonly apiKey: string | undefined
  ) {}

  /**
   * Initialize the MCP session and discover available tools.
   */
  async connect(): Promise<void> {
    // Send initialize request
    const initResponse = await this.sendRequest({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "toast-teams-bot", version: "0.1.0" },
      },
    });

    // Extract session ID from the response
    if (initResponse.sessionId) {
      this.sessionId = initResponse.sessionId;
    }

    // Send initialized notification
    await this.sendRequest(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      true
    );

    // Discover tools
    const toolsResponse = await this.sendRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    const result = toolsResponse.data?.result as Record<string, unknown> | undefined;
    if (result?.tools) {
      this.tools = result.tools as McpToolDefinition[];
    }

    this.initialized = true;
    console.error(
      `[MCP] Connected. Session: ${this.sessionId}, Tools: ${this.tools.length}`
    );
  }

  /**
   * Call a tool on the Toast MCP server.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<McpToolResult> {
    if (!this.initialized) {
      await this.connect();
    }

    const response = await this.sendRequest({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name, arguments: args },
    });

    if (response.data?.result) {
      return response.data.result as McpToolResult;
    }

    if (response.data?.error) {
      return {
        content: [
          {
            type: "text",
            text: `MCP error: ${JSON.stringify(response.data.error)}`,
          },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: "No response from MCP server" }],
      isError: true,
    };
  }

  /**
   * Convenience: call a tool and parse the JSON text result.
   */
  async callToolJson<T = unknown>(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<T> {
    const result = await this.callTool(name, args);
    const text = result.content[0]?.text ?? "{}";
    return JSON.parse(text) as T;
  }

  /**
   * Get the list of available tools.
   */
  getTools(): McpToolDefinition[] {
    return [...this.tools];
  }

  /**
   * Check if connected.
   */
  isConnected(): boolean {
    return this.initialized;
  }

  /**
   * Send a JSON-RPC request to the MCP server and parse the SSE response.
   */
  private async sendRequest(
    payload: Record<string, unknown>,
    isNotification = false
  ): Promise<{ sessionId: string | null; data: Record<string, unknown> | null }> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
    }

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const response = await fetch(this.serverUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    // Extract session ID from response headers
    const newSessionId = response.headers.get("mcp-session-id");
    if (newSessionId) {
      this.sessionId = newSessionId;
    }

    if (isNotification || response.status === 202) {
      return { sessionId: this.sessionId, data: null };
    }

    // Parse SSE response
    const body = await response.text();
    const dataLines = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));

    if (dataLines.length > 0) {
      try {
        const parsed = JSON.parse(dataLines[dataLines.length - 1]);
        return { sessionId: this.sessionId, data: parsed };
      } catch {
        // Try parsing as plain JSON (non-SSE response)
        try {
          const parsed = JSON.parse(body);
          return { sessionId: this.sessionId, data: parsed };
        } catch {
          return { sessionId: this.sessionId, data: null };
        }
      }
    }

    // Try plain JSON
    try {
      const parsed = JSON.parse(body);
      return { sessionId: this.sessionId, data: parsed };
    } catch {
      return { sessionId: this.sessionId, data: null };
    }
  }
}
