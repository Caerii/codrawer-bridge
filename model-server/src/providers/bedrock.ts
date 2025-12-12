/**
 * Bedrock Provider Configuration
 *
 * Custom fetch wrapper for Bedrock that:
 * 1. Adds 'type: object' to tool inputSchema.json (required by Bedrock Converse API)
 * 2. Ensures messages have non-empty content (Bedrock rejects empty content)
 */

import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';

/**
 * Get Bedrock API key from environment.
 * Supports both explicit bearer token and reconstructed API key format.
 *
 * Format: ABSK + base64("BedrockAPIKey-xxxx-at-account:secret")
 */
export function getBedrockApiKey(): string | undefined {
  // Prefer explicit bearer token
  if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
    return process.env.AWS_BEARER_TOKEN_BEDROCK;
  }

  // Reconstruct from split credentials if they look like Bedrock API key components
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (accessKeyId?.startsWith('BedrockAPIKey') && secretAccessKey) {
    // Combine and base64 encode to create the ABSK... format
    const combined = `${accessKeyId}:${secretAccessKey}`;
    const encoded = Buffer.from(combined).toString('base64');
    return `ABSK${encoded}`;
  }

  return undefined;
}

/**
 * Check if Bedrock credentials are available.
 */
export function hasBedrockCredentials(): boolean {
  const apiKey = getBedrockApiKey();
  return (
    !!apiKey ||
    !!(
      process.env.AWS_ACCESS_KEY_ID &&
      process.env.AWS_SECRET_ACCESS_KEY &&
      !process.env.AWS_ACCESS_KEY_ID.startsWith('BedrockAPIKey')
    )
  );
}

/**
 * Custom fetch wrapper for Bedrock that fixes tool schemas and message content.
 */
async function bedrockFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (init?.body) {
    try {
      // Handle both string and object bodies
      let body: any;
      if (typeof init.body === 'string') {
        body = JSON.parse(init.body);
      } else if (typeof init.body === 'object') {
        body = init.body;
      } else {
        return fetch(url, init);
      }

      // Fix tool schemas for Bedrock Converse API format
      if (body.toolConfig && body.toolConfig.tools && Array.isArray(body.toolConfig.tools)) {
        body.toolConfig.tools = body.toolConfig.tools.map((tool: any) => {
          if (tool.toolSpec && tool.toolSpec.inputSchema && tool.toolSpec.inputSchema.json) {
            const jsonSchema = tool.toolSpec.inputSchema.json;
            // Add type: "object" if missing
            if (!jsonSchema.type) {
              tool.toolSpec.inputSchema.json = { type: 'object', ...jsonSchema };
            }
          }
          return tool;
        });
      }

      // Fix empty message content - Bedrock rejects messages with empty content
      // This happens when assistant responds with tool_calls but no text
      // Bedrock also requires non-whitespace text in content blocks
      if (body.messages && Array.isArray(body.messages)) {
        body.messages = body.messages.map((msg: any) => {
          // Ensure content array is not empty
          if (msg.content && Array.isArray(msg.content)) {
            // Check if content is empty or only has empty text blocks
            const hasContent = msg.content.some((block: any) => {
              if (block.text && typeof block.text === 'string') {
                return block.text.trim().length > 0;
              }
              // toolResult blocks are valid content
              if (block.toolResult || block.toolUse) {
                return true;
              }
              return false;
            });

            if (!hasContent) {
              // Add a placeholder text block for messages with empty content
              // Using a descriptive placeholder that won't confuse the model
              msg.content = [{ text: '...' }];
            }
          }
          // Handle messages where content is an empty array or undefined
          if (!msg.content || (Array.isArray(msg.content) && msg.content.length === 0)) {
            msg.content = [{ text: '...' }];
          }
          return msg;
        });
      }

      // Update the request body
      init = {
        ...init,
        body: JSON.stringify(body),
      };
    } catch (e) {
      // If parsing fails, just proceed with original request
      console.error('bedrockFetch: Failed to process body:', e);
    }
  }

  return fetch(url, init);
}

// Log Bedrock auth mode for debugging
const BEDROCK_API_KEY = getBedrockApiKey();
if (BEDROCK_API_KEY) {
  console.log('Bedrock: Using API key authentication (ABSK...)');
} else if (process.env.AWS_ACCESS_KEY_ID) {
  console.log('Bedrock: Using SigV4 authentication');
}

// Create Bedrock provider with API key if available and custom fetch for tool support
export const bedrock = createAmazonBedrock({
  region: process.env.AWS_REGION || 'us-east-1',
  ...(BEDROCK_API_KEY ? { apiKey: BEDROCK_API_KEY } : {}),
  fetch: bedrockFetch,
});
