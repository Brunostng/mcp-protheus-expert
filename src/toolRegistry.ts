import { McpTool } from "./types/McpTool.js";

import RelatorioRotinaTool from "./tools/RelatorioRotinaTool.js";
import CodeReviewTool from "./tools/CodeReviewTool.js";
import NormativaTool from "./tools/NormativaTool.js";
import bitbucketTool from "./tools/bitbucketTool.js";
import TotvsTdnTool from "./tools/TotvsTdnTool.js";

export const toolRegistry: McpTool[] = [
  RelatorioRotinaTool,
  CodeReviewTool,
  NormativaTool,
  bitbucketTool,
  TotvsTdnTool
];

export function getToolByName(name: string): McpTool | undefined {
  return toolRegistry.find(t => t.name === name);
}

export function listTools(): McpTool[] {
  return toolRegistry;
}
