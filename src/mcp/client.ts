/**
 * MCP client that connects to the Toast MCP Server's Streamable HTTP endpoint.
 * Handles session management, tool discovery, and tool invocation.
 *
 * This is used for the direct command mode (no LLM required).
 * For AI powered natural language, use McpClientPlugin from @microsoft/teams.mcpclient instead.
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

  async connect(): Promise<void> {
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

    if (initResponse.sessionId) {
      this.sessionId = initResponse.sessionId;
    }

    await this.sendRequest(
      { jsonrpc: "2.0", method: "notifications/initialized" },
      true
    );

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
          { type: "text", text: `MCP error: ${JSON.stringify(response.data.error)}` },
        ],
        isError: true,
      };
    }

    return {
      content: [{ type: "text", text: "No response from MCP server" }],
      isError: true,
    };
  }

  async callToolJson<T = unknown>(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<T | null> {
    const result = await this.callTool(name, args);
    const text = result.content[0]?.text ?? "";

    // Try to parse as JSON, return null if it's plain text
    try {
      return JSON.parse(text) as T;
    } catch {
      return null;
    }
  }

  /**
   * Call a tool and return the raw text response.
   */
  async callToolText(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<string> {
    const result = await this.callTool(name, args);
    return result.content[0]?.text ?? "";
  }

  getTools(): McpToolDefinition[] {
    return [...this.tools];
  }

  isConnected(): boolean {
    return this.initialized;
  }

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

    const newSessionId = response.headers.get("mcp-session-id");
    if (newSessionId) {
      this.sessionId = newSessionId;
    }

    if (isNotification || response.status === 202) {
      return { sessionId: this.sessionId, data: null };
    }

    const body = await response.text();

    // Parse SSE response
    const dataLines = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => line.slice(6));

    if (dataLines.length > 0) {
      try {
        return { sessionId: this.sessionId, data: JSON.parse(dataLines[dataLines.length - 1]) };
      } catch { /* fall through */ }
    }

    // Plain JSON
    try {
      return { sessionId: this.sessionId, data: JSON.parse(body) };
    } catch {
      return { sessionId: this.sessionId, data: null };
    }
  }
}
