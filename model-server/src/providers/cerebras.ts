/**
 * Cerebras Provider Configuration
 *
 * Uses OpenAI-compatible provider instead of @ai-sdk/cerebras to have full control
 * over the request body. This bypasses AI SDK's Zod conversion issues.
 *
 * Custom fetch wrapper for Cerebras that:
 * 1. Restores original OpenAI-format tools (AI SDK conversion loses properties)
 * 2. Adds 'strict: true' and 'additionalProperties: false' to tool definitions
 * 3. Removes undefined/null values that Cerebras rejects (e.g., response_format)
 *
 * See: https://inference-docs.cerebras.ai/capabilities/tool-use
 */

import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

// Store original OpenAI-format tools to restore them before Cerebras API call
// AI SDK's Zod conversion loses properties, so we need to restore the originals
let _pendingCerebrasTools: Array<{
  type: 'function';
  function: { name: string; description?: string; parameters?: any };
}> | null = null;

/**
 * Set the pending tools for Cerebras API call.
 * Call this before making a Cerebras request to bypass AI SDK's Zod conversion.
 */
export function setCerebrasTools(tools: typeof _pendingCerebrasTools) {
  _pendingCerebrasTools = tools;
}

/**
 * Recursively fix object schemas for Cerebras strict mode.
 * Cerebras requires ALL type: object to have:
 * 1. Either 'properties' or 'anyOf' (not empty)
 * 2. 'additionalProperties: false'
 */
function fixObjectSchemas(schema: any): any {
  if (!schema || typeof schema !== 'object') {
    return schema;
  }

  // If this is an object type, ensure it meets Cerebras requirements
  if (schema.type === 'object') {
    // Must have properties or anyOf
    if (!schema.properties && !schema.anyOf) {
      schema.properties = {};
    }
    // Must have additionalProperties: false
    if (schema.additionalProperties === undefined) {
      schema.additionalProperties = false;
    }
  }

  // Recursively fix nested schemas
  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      schema.properties[key] = fixObjectSchemas(schema.properties[key]);
    }
  }

  if (schema.items) {
    schema.items = fixObjectSchemas(schema.items);
  }

  if (schema.anyOf) {
    schema.anyOf = schema.anyOf.map(fixObjectSchemas);
  }

  if (schema.oneOf) {
    schema.oneOf = schema.oneOf.map(fixObjectSchemas);
  }

  if (schema.allOf) {
    schema.allOf = schema.allOf.map(fixObjectSchemas);
  }

  return schema;
}

/**
 * Custom fetch wrapper for Cerebras that fixes tool schemas.
 */
async function cerebrasFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (init?.body) {
    try {
      // Handle both string and object bodies
      let body: any;

      if (typeof init.body === 'string') {
        body = JSON.parse(init.body);
      } else if (init.body instanceof ReadableStream) {
        // ReadableStream - we need to read it
        const reader = init.body.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
        }
        const bodyStr = new TextDecoder().decode(Buffer.concat(chunks.map(c => Buffer.from(c))));
        body = JSON.parse(bodyStr);
      } else if (typeof init.body === 'object') {
        body = init.body;
      } else {
        return fetch(url, init);
      }

      // Remove undefined/null values that Cerebras rejects
      const cleanBody: Record<string, any> = {};
      for (const [key, value] of Object.entries(body)) {
        if (value !== undefined && value !== null) {
          cleanBody[key] = value;
        }
      }

      // Remove response_format - Cerebras API rejects empty or malformed response_format objects
      delete cleanBody.response_format;

      // Restore original OpenAI-format tools if available
      // AI SDK's Zod conversion (jsonSchemaToZod -> zodToJsonSchema) loses properties
      // So we bypass that by using the original tools we stored
      if (_pendingCerebrasTools && _pendingCerebrasTools.length > 0) {
        // Use original tools and add Cerebras-required fields
        cleanBody.tools = _pendingCerebrasTools.map((tool: any) => {
          if (tool.type === 'function' && tool.function) {
            let parameters = tool.function.parameters || { type: 'object', properties: {} };
            // Ensure type: object is present
            if (!parameters.type) {
              parameters = { type: 'object', ...parameters };
            }
            // Fix all nested object schemas for Cerebras strict mode
            parameters = fixObjectSchemas(parameters);
            return {
              ...tool,
              function: {
                ...tool.function,
                parameters,
                strict: true,
              },
            };
          }
          return tool;
        });
        // DON'T clear after use - AI SDK may make multiple API calls (streaming, retries)
        // The endpoint handler will set new tools for each new request anyway
      } else if (cleanBody.tools && Array.isArray(cleanBody.tools)) {
        // Fallback: fix what AI SDK gives us (but properties may already be lost)
        cleanBody.tools = cleanBody.tools.map((tool: any) => {
          if (tool.type === 'function' && tool.function) {
            let parameters = tool.function.parameters || { type: 'object', properties: {} };
            if (parameters && !parameters.type) {
              parameters = { type: 'object', ...parameters };
            }
            // Fix all nested object schemas for Cerebras strict mode
            parameters = fixObjectSchemas(parameters);
            return {
              ...tool,
              function: {
                ...tool.function,
                parameters,
                strict: true,
              },
            };
          }
          return tool;
        });
      }

      // Serialize and send
      init = {
        ...init,
        body: JSON.stringify(cleanBody),
      };
    } catch (e) {
      // If parsing fails, just proceed with original request
      console.error('cerebrasFetch: Failed to process body:', e);
    }
  }

  return fetch(url, init);
}

// Create Cerebras provider using OpenAI-compatible with custom fetch
// This gives us full control over the request body, bypassing AI SDK quirks
export const cerebras = createOpenAICompatible({
  name: 'cerebras',
  baseURL: 'https://api.cerebras.ai/v1',
  headers: {
    Authorization: `Bearer ${process.env.CEREBRAS_API_KEY}`,
  },
  fetch: cerebrasFetch,
});
