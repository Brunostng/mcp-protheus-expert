import "dotenv/config";
import { handleMcpMessage } from "./mcpRouter.js";



process.stdin.setEncoding("utf8");
process.stdin.resume();

let buffer = "";
process.stdin.on("data", async (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;

    try {
      const msg = JSON.parse(s);
      const resp = await handleMcpMessage(msg);
      if (resp) process.stdout.write(JSON.stringify(resp) + "\n");
    } catch (err) {
      console.error("Erro MCP:", err);
    }
  }
});
