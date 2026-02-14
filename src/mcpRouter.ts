import { getToolByName, listTools } from "./toolRegistry.js";

export async function handleMcpMessage(msg: any) {
  // initialize
  if (msg?.method === "initialize") {
    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2025-06-18",
        capabilities: {
          tools: { listChanged: false }
        },
        serverInfo: {
          name: "mcp-protheus-expert",
          version: "1.0.0"
        }
      }
    };
  }

  // ? tools/list  (é isso que o Claude está chamando)
  if (msg?.method === "tools/list") {
    const tools = listTools().map(t => ({
      name: t.name,
      title: t.name, // opcional
      description: t.description ?? "",
      inputSchema: t.inputSchema ?? {
        type: "object",
        properties: {},
        additionalProperties: true
      }
    }));

    return {
      jsonrpc: "2.0",
      id: msg.id,
      result: { tools }
    };
  }

  // ? tools/call
  if (msg?.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};

    const tool = getToolByName(name);
    if (!tool) {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Unknown tool: ${name}` }
      };
    }

    try {
      const result = await tool.run(args);

      // Spec: tool result precisa retornar "content": [...]
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [
            { type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }
          ],
          isError: false
        }
      };
    } catch (e: any) {
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          content: [{ type: "text", text: e?.message ?? String(e) }],
          isError: true
        }
      };
    }
  }

  return null;
}
