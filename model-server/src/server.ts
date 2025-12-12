/**
 * AI SDK v6 Model Server
 *
 * Unified model serving gateway for the Superintelligent Swarm.
 * Provides OpenAI-compatible endpoints for text generation across multiple providers.
 *
 * Supported providers:
 * - Together AI (open-source models: Llama, Mixtral, DeepSeek, etc.)
 * - OpenAI (GPT-4, GPT-4o, etc.)
 * - Anthropic (Claude 3.5/4, etc.)
 * - Google AI (Gemini)
 * - Amazon Bedrock (Claude Opus 4.5)
 * - Cerebras (blazing fast inference)
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import 'dotenv/config';

import { MODEL_ALIASES, HAS_BEDROCK, HAS_CEREBRAS } from './providers';
import { completionsRouter, objectsRouter, batchRouter } from './routes';

const app = new Hono();

// Enable CORS for Python swarm to call this server
app.use('*', cors());

// Health check endpoint
app.get('/', (c) => {
  return c.json({
    status: 'ok',
    service: 'AI SDK Model Server',
    version: '1.1.0',
    providers: ['together', 'openai', 'anthropic', 'google', 'bedrock', 'cerebras'],
    endpoints: [
      'POST /v1/chat/completions - OpenAI-compatible chat completions',
      'POST /v1/generate/object - Structured object generation',
      'POST /v1/batch/completions - Batch requests',
      'GET /v1/models - List available models',
    ],
  });
});

// List available models
app.get('/v1/models', (c) => {
  const models = Object.entries(MODEL_ALIASES).map(([alias, config]) => ({
    id: alias,
    provider: config.provider,
    model_id: config.modelId,
  }));

  return c.json({ data: models });
});

// Mount route handlers
app.route('/v1/chat/completions', completionsRouter);
app.route('/v1/generate/object', objectsRouter);
app.route('/v1/batch/completions', batchRouter);

// Start server
const PORT = parseInt(process.env.PORT || '3100', 10);
const HOST = process.env.HOST || 'localhost';

const bedrockStatus = HAS_BEDROCK ? '✓ Bedrock (Opus 4.5)' : '✗ Bedrock';
const cerebrasStatus = HAS_CEREBRAS ? '✓ Cerebras (blazing fast)' : '✗ Cerebras';

console.log(`
╔══════════════════════════════════════════════════════════════╗
║           AI SDK 6 Model Server v1.1.0                       ║
╠══════════════════════════════════════════════════════════════╣
║  Server: http://${HOST}:${PORT}                                  ║
║  ${bedrockStatus.padEnd(25)} ${cerebrasStatus.padEnd(27)}║
║                                                              ║
║  Endpoints:                                                  ║
║  • POST /v1/chat/completions  - Chat completions             ║
║  • POST /v1/generate/object   - Structured generation        ║
║  • POST /v1/batch/completions - Batch requests               ║
║  • GET  /v1/models            - List models                  ║
║                                                              ║
║  Providers: Together, Bedrock, Cerebras, OpenAI, Google      ║
╚══════════════════════════════════════════════════════════════╝
`);

serve({
  fetch: app.fetch,
  port: PORT,
  hostname: HOST,
});
