import { StructuredTool as Tool } from "@langchain/core/tools";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { loadMcpTools } from "@langchain/mcp-adapters";
import { AsyncParser } from "@json2csv/node";

export class MCPClient {
  private mcp: Client;

  private transport: StdioClientTransport | null = null;
  private tools: Tool[] = [];
  private getObjectsTool: Tool | null = null;
  private queryDeptListTool: Tool | null = null;

  constructor() {
    this.mcp = new Client({ name: "mcp-client-cli", version: "1.0.0" });
  }

  // methods will go here
  async connectToServer() {
    try {
      this.transport = new StdioClientTransport({
        command: process.execPath,
        args: ["../../../hecom-opensdk-mcp/dist/index.js"],
        env: { ...process.env },
        stderr: "inherit",
      });
      await this.mcp.connect(this.transport);

      this.tools = await loadMcpTools("hecom", this.mcp, {
        // Whether to throw errors if a tool fails to load (optional, default: true)
        throwOnLoadError: true,
        // Whether to prefix tool names with the server name (optional, default: false)
        prefixToolNameWithServerName: false,
        // Optional additional prefix for tool names (optional, default: "")
        additionalToolNamePrefix: "",
      });

      console.log(
        "Connected to server with tools:",
        this.tools.map(({ name }) => name)
      );

      this.getObjectsTool =
        this.tools.find((tool) => tool.name === "get-objects") || null;
      this.queryDeptListTool =
        this.tools.find((tool) => tool.name === "query-dept-list") || null;
      this.tools = this.tools.filter(
        (tool) => tool.name !== "get-objects" && tool.name !== "query-dept-list"
      );
    } catch (e) {
      console.log("Failed to connect to MCP server: ", e);
      throw e;
    }
  }

  public async queryDeptList() {
    if (!this.queryDeptListTool) {
      throw new Error(
        "query-dept-list tool not found. Please connect to the server first."
      );
    }
    const data = await this.queryDeptListTool.invoke({
      sql: "SELECT code, name FROM Org",
    });

    return JSON.parse(data);
  }

  public async getObjects() {
    if (!this.getObjectsTool) {
      throw new Error(
        "get-objects tool not found. Please connect to the server first."
      );
    }
    const data = await this.getObjectsTool.invoke({});
    const parser = new AsyncParser();

    const csv = await parser.parse(data).promise();
    return csv;
  }

  public getTools(): Tool[] {
    if (!this.tools.length) {
      throw new Error(
        "No tools available. Please connect to the server first."
      );
    }
    return this.tools;
  }
}
