/**
 * Object Generation Route Handler
 *
 * Structured object generation endpoint using AI SDK's generateObject.
 */

import { Hono } from 'hono';
import { generateObject } from 'ai';
import { z } from 'zod';
import { getModel } from '../providers';
import { GenerateObjectRequest } from './schemas';

export const objectsRouter = new Hono();

// Structured object generation endpoint (uses AI SDK's generateObject)
objectsRouter.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const request = GenerateObjectRequest.parse(body);
    const model = getModel(request.model);

    // Convert JSON schema to Zod schema dynamically
    // For now, we'll use mode: 'json' which is more flexible
    const result = await generateObject({
      model,
      messages: request.messages,
      schema: z.object({}), // Placeholder - actual schema parsing would be more complex
      mode: 'json',
      temperature: request.temperature,
      maxTokens: request.max_tokens,
    });

    return c.json({
      object: result.object,
      usage: {
        prompt_tokens: result.usage?.promptTokens ?? 0,
        completion_tokens: result.usage?.completionTokens ?? 0,
        total_tokens: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
      },
    });
  } catch (error) {
    console.error('Error in object generation:', error);
    return c.json(
      {
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          type: 'server_error',
        },
      },
      500
    );
  }
});
