/**
 * Chat Completions Route Handler
 *
 * OpenAI-compatible chat completions endpoint with streaming and tool calling support.
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { streamText, generateText } from 'ai';
import { getModel, isCerebrasModel, setCerebrasTools } from '../providers';
import { convertOpenAIToolsToAISDK, convertToolChoice } from '../utils';
import { ChatCompletionRequest } from './schemas';

export const completionsRouter = new Hono();

// OpenAI-compatible chat completions endpoint
completionsRouter.post('/', async (c) => {
  try {
    const body = await c.req.json();
    const request = ChatCompletionRequest.parse(body);
    const model = getModel(request.model);

    // For Cerebras models, store original tools before AI SDK conversion
    // This bypasses AI SDK's Zod conversion that loses properties
    if (isCerebrasModel(request.model) && request.tools) {
      setCerebrasTools(request.tools);
    }

    if (request.stream) {
      // Streaming response
      return streamSSE(c, async (stream) => {
        // Convert tools if provided
        const tools = request.tools ? convertOpenAIToolsToAISDK(request.tools) : undefined;
        const toolChoice = convertToolChoice(request.tool_choice);

        const result = streamText({
          model,
          messages: request.messages,
          temperature: request.temperature,
          maxTokens: request.max_tokens,
          ...(tools && { tools }),
          ...(toolChoice && { toolChoice }),
        });

        let id = `chatcmpl-${Date.now()}`;
        const collectedToolCalls: Array<{ toolCallId: string; toolName: string; args: any }> = [];
        let toolCallIndex = 0;

        // Use fullStream to get both text AND tool calls with their arguments!
        // (textStream only yields text content, not tool call data)
        for await (const part of result.fullStream) {
          if (part.type === 'text-delta') {
            // Stream text content
            const chunk = {
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: { content: part.textDelta },
                  finish_reason: null,
                },
              ],
            };

            await stream.writeSSE({
              data: JSON.stringify(chunk),
            });
          } else if (part.type === 'tool-call') {
            // Collect tool calls - they come with args populated!
            // Enable verbose debug with TOOL_CALL_DEBUG=1
            const debugToolCalls =
              process.env.TOOL_CALL_DEBUG === '1' || process.env.TOOL_CALL_DEBUG === 'true';
            if (debugToolCalls) {
              console.log('\n[TOOL_CALL_DEBUG] AI SDK tool-call part:');
              console.log('  raw_part:', JSON.stringify(part, null, 2));
              console.log('  part.args:', JSON.stringify(part.args));
              console.log('  part.input:', JSON.stringify((part as any).input));
              // Check for empty keys in args
              const args = part.args || {};
              const keys = Object.keys(args);
              const emptyKeys = keys.filter((k) => k === '' || k === null || k === undefined);
              if (emptyKeys.length > 0) {
                console.log('  [WARNING] Empty keys detected in args:', emptyKeys);
              }
            }

            // AI SDK uses 'args' for OpenAI, but 'input' for Bedrock!
            const toolArgs = part.args || (part as any).input || {};

            collectedToolCalls.push({
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              args: toolArgs,
            });

            // Stream tool call immediately (reuse toolArgs from above)
            const toolCallChunk = {
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: toolCallIndex++,
                        id: part.toolCallId,
                        type: 'function',
                        function: {
                          name: part.toolName,
                          arguments: JSON.stringify(toolArgs),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };

            await stream.writeSSE({
              data: JSON.stringify(toolCallChunk),
            });
          }
          // Ignore other part types for now (tool-call-streaming-start, tool-call-delta, etc.)
        }

        // Send final chunk with appropriate finish_reason
        const finishReason = collectedToolCalls.length > 0 ? 'tool_calls' : 'stop';
        const finalChunk = {
          id,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason,
            },
          ],
        };

        await stream.writeSSE({
          data: JSON.stringify(finalChunk),
        });

        await stream.writeSSE({ data: '[DONE]' });
      });
    } else {
      // Non-streaming response
      // Convert tools if provided
      const tools = request.tools ? convertOpenAIToolsToAISDK(request.tools) : undefined;
      const toolChoice = convertToolChoice(request.tool_choice);

      const result = await generateText({
        model,
        messages: request.messages,
        temperature: request.temperature,
        maxTokens: request.max_tokens,
        ...(tools && { tools }),
        ...(toolChoice && { toolChoice }),
      });

      // Build message with potential tool_calls
      const message: any = {
        role: 'assistant',
        content: result.text || null,
      };

      // Add tool_calls if present
      if (result.toolCalls && result.toolCalls.length > 0) {
        message.tool_calls = result.toolCalls.map((tc: any) => ({
          id: tc.toolCallId,
          type: 'function',
          function: {
            name: tc.toolName,
            // AI SDK uses 'args' for some providers, 'input' for others (e.g., Together)
            arguments: JSON.stringify(tc.args || tc.input || {}),
          },
        }));
      }

      // Determine finish_reason
      const finishReason = result.toolCalls && result.toolCalls.length > 0 ? 'tool_calls' : 'stop';

      return c.json({
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [
          {
            index: 0,
            message,
            finish_reason: finishReason,
          },
        ],
        usage: {
          prompt_tokens: result.usage?.promptTokens ?? 0,
          completion_tokens: result.usage?.completionTokens ?? 0,
          total_tokens: (result.usage?.promptTokens ?? 0) + (result.usage?.completionTokens ?? 0),
        },
      });
    }
  } catch (error) {
    console.error('Error in chat completions:', error);
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
