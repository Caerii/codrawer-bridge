/**
 * Request/Response Schemas
 *
 * Zod schemas for validating API requests.
 */

import { z } from 'zod';
import { ToolSchema } from '../utils';

// Chat completion request schema
export const ChatCompletionRequest = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant', 'tool']),
      content: z.string().optional(),
      tool_calls: z
        .array(
          z.object({
            id: z.string(),
            type: z.literal('function'),
            function: z.object({
              name: z.string(),
              arguments: z.string(),
            }),
          })
        )
        .optional(),
      tool_call_id: z.string().optional(),
    })
  ),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
  stream: z.boolean().optional().default(false),
  response_format: z
    .object({
      type: z.enum(['text', 'json_object']).optional(),
    })
    .optional(),
  // Native function calling support
  tools: z.array(ToolSchema).optional(),
  tool_choice: z
    .union([
      z.literal('auto'),
      z.literal('none'),
      z.literal('required'),
      z.object({
        type: z.literal('function'),
        function: z.object({ name: z.string() }),
      }),
    ])
    .optional(),
});

export type ChatCompletionRequestType = z.infer<typeof ChatCompletionRequest>;

// Generate object request schema
export const GenerateObjectRequest = z.object({
  model: z.string(),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant']),
      content: z.string(),
    })
  ),
  schema: z.record(z.unknown()),
  temperature: z.number().optional(),
  max_tokens: z.number().optional(),
});

export type GenerateObjectRequestType = z.infer<typeof GenerateObjectRequest>;
