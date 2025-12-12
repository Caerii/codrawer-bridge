/**
 * Batch Completions Route Handler
 *
 * Batch completions endpoint for parallel requests.
 */

import { Hono } from 'hono';
import { generateText } from 'ai';
import { z } from 'zod';
import { getModel } from '../providers';
import { ChatCompletionRequest } from './schemas';

export const batchRouter = new Hono();

// Batch completions endpoint (for parallel requests)
batchRouter.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const requests = z.array(ChatCompletionRequest).parse(body.requests);

    const results = await Promise.all(
      requests.map(async (request) => {
        const model = getModel(request.model);
        const result = await generateText({
          model,
          messages: request.messages,
          temperature: request.temperature,
          maxTokens: request.max_tokens,
        });

        return {
          id: `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: result.text,
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: result.usage?.promptTokens ?? 0,
            completion_tokens: result.usage?.completionTokens ?? 0,
            total_tokens: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
          },
        };
      })
    );

    return c.json({ results });
  } catch (error) {
    console.error('Error in batch completions:', error);
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
