/**
 * Tool Conversion Utilities
 *
 * Converts OpenAI-format tools to AI SDK CoreTool format.
 */

import { CoreTool } from 'ai';
import { z } from 'zod';
import { jsonSchemaToZod } from './schema';

// OpenAI-compatible tool type
export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: any;
    strict?: boolean;
  };
}

// OpenAI-compatible function schema (for validation)
export const FunctionSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.unknown()).optional(),
});

export const ToolSchema = z.object({
  type: z.literal('function'),
  function: FunctionSchema,
});

/**
 * Convert OpenAI-format tools to AI SDK CoreTool format.
 * The AI SDK expects tools as a record of {name: {description, parameters}}.
 */
export function convertOpenAIToolsToAISDK(tools: OpenAITool[]): Record<string, CoreTool<any, any>> {
  const result: Record<string, CoreTool<any, any>> = {};

  for (const tool of tools) {
    if (tool.type === 'function') {
      const func = tool.function;
      result[func.name] = {
        description: func.description || '',
        parameters: jsonSchemaToZod(func.parameters || { type: 'object', properties: {} }),
        // No execute callback - model generates tool calls, we return them without execution
      };
    }
  }

  return result;
}

/**
 * Add 'strict: true' to tool definitions for Cerebras compatibility.
 * Cerebras requires strict: true inside function objects for tool calling.
 */
export function addStrictToTools(
  tools: OpenAITool[]
): Array<OpenAITool & { function: { strict: boolean } }> {
  return tools.map((tool) => ({
    ...tool,
    function: {
      ...tool.function,
      strict: true, // Required by Cerebras
    },
  }));
}

/**
 * Convert tool_choice from OpenAI format to AI SDK format.
 */
export function convertToolChoice(
  toolChoice:
    | 'auto'
    | 'none'
    | 'required'
    | { type: 'function'; function: { name: string } }
    | undefined
): 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string } | undefined {
  if (!toolChoice) return undefined;
  if (typeof toolChoice === 'string') return toolChoice;
  // Convert specific function choice
  if (toolChoice.type === 'function') {
    return { type: 'tool', toolName: toolChoice.function.name };
  }
  return undefined;
}
