export type JsonSchema = {
  type: "object";
  properties?: Record<string, any>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface McpTool {
  name: string;
  description: string;
  run(input: any): Promise<any>;
  inputSchema?: any; // JSON Schema
}