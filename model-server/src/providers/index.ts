/**
 * Provider Configuration and Model Aliases
 *
 * Central configuration for all supported LLM providers and model aliases.
 */

import { LanguageModel } from 'ai';
import { togetherai } from '@ai-sdk/togetherai';
import { openai } from '@ai-sdk/openai';
import { anthropic } from '@ai-sdk/anthropic';
import { google } from '@ai-sdk/google';
import { bedrock, hasBedrockCredentials } from './bedrock';
import { cerebras, setCerebrasTools } from './cerebras';

// Re-export for use by other modules
export { setCerebrasTools } from './cerebras';

// Provider type
export type ProviderName = 'together' | 'openai' | 'anthropic' | 'google' | 'bedrock' | 'cerebras';

// Model configuration interface
export interface ModelConfig {
  provider: ProviderName;
  modelId: string;
}

// Check provider availability
export const HAS_BEDROCK = hasBedrockCredentials();
export const HAS_CEREBRAS = !!process.env.CEREBRAS_API_KEY;

// Opus 4.5 requires global inference profile
const OPUS_MODEL_ID = 'global.anthropic.claude-opus-4-5-20251101-v1:0';

/**
 * Model alias mapping - maps tier names to actual models.
 */
export const MODEL_ALIASES: Record<string, ModelConfig> = {
  // Tier aliases used by the swarm - Claude Opus 4.5 is the BEST
  // Falls back to Kimi K2 if Bedrock not configured
  powerful_and_smart: HAS_BEDROCK
    ? { provider: 'bedrock', modelId: OPUS_MODEL_ID }
    : { provider: 'together', modelId: 'moonshotai/Kimi-K2-Thinking' },
  fast_and_cheap: { provider: 'together', modelId: 'moonshotai/Kimi-K2-Instruct' },
  auto: { provider: 'together', modelId: 'moonshotai/Kimi-K2-Instruct' },

  // Claude Opus 4.5 via Bedrock (FREE CREDITS - EXPIRES DEC 26, 2025!)
  'claude-opus-4-5': { provider: 'bedrock', modelId: OPUS_MODEL_ID },
  'opus-4.5': { provider: 'bedrock', modelId: OPUS_MODEL_ID },
  opus: { provider: 'bedrock', modelId: OPUS_MODEL_ID },

  // Kimi K2 - Top open-source model (beats GPT-5 on reasoning benchmarks)
  'kimi-k2-thinking': { provider: 'together', modelId: 'moonshotai/Kimi-K2-Thinking' },
  'kimi-k2-instruct': { provider: 'together', modelId: 'moonshotai/Kimi-K2-Instruct' },
  'kimi-k2': { provider: 'together', modelId: 'moonshotai/Kimi-K2-Instruct-0905' },

  // Qwen3 - Excellent for coding and reasoning
  'qwen3-coder': { provider: 'together', modelId: 'Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8' },
  'qwen3-235b': { provider: 'together', modelId: 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput' },
  'qwen3-thinking': { provider: 'together', modelId: 'Qwen/Qwen3-235B-A22B-Thinking-2507' },
  'qwen3-next': { provider: 'together', modelId: 'Qwen/Qwen3-Next-80B-A3B-Instruct' },

  // Llama 4 - Latest Meta models
  'llama-4-maverick': {
    provider: 'together',
    modelId: 'meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8',
  },
  'llama-4-scout': { provider: 'together', modelId: 'meta-llama/Llama-4-Scout-17B-16E-Instruct' },
  'llama-3.3-70b': { provider: 'together', modelId: 'meta-llama/Meta-Llama-3.3-70B-Instruct-Turbo' },
  'llama-3.1-8b': { provider: 'together', modelId: 'meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo' },

  // Legacy/other Together models
  'mixtral-8x22b': { provider: 'together', modelId: 'mistralai/Mixtral-8x22B-Instruct-v0.1' },
  'qwen-2.5-72b': { provider: 'together', modelId: 'Qwen/Qwen2.5-72B-Instruct-Turbo' },

  // OpenAI
  'gpt-4o': { provider: 'openai', modelId: 'gpt-4o' },
  'gpt-4o-mini': { provider: 'openai', modelId: 'gpt-4o-mini' },
  'gpt-5-nano': { provider: 'openai', modelId: 'gpt-4o-mini' },

  // Anthropic Claude (direct API)
  'claude-sonnet-4-5': { provider: 'anthropic', modelId: 'claude-sonnet-4-5' },
  'claude-4-sonnet': { provider: 'anthropic', modelId: 'claude-sonnet-4-20250514' },
  'claude-3-7-sonnet': { provider: 'anthropic', modelId: 'claude-3-7-sonnet-latest' },
  'claude-3-5-haiku': { provider: 'anthropic', modelId: 'claude-3-5-haiku-latest' },

  // Google Gemini
  'gemini-2.0-flash': { provider: 'google', modelId: 'gemini-2.0-flash' },
  'gemini-2.5-pro': { provider: 'google', modelId: 'gemini-2.5-pro-preview-06-05' },
  'gemini-pro': { provider: 'google', modelId: 'gemini-2.5-pro-preview-06-05' },

  // Cerebras - BLAZING FAST inference (1000 req/min, 1M tokens/min!)
  // Perfect for quick, simple tasks that need extreme speed
  // Note: llama3.1-8b does NOT support tool calling, use qwen-3-32b or llama-3.3-70b for tools
  blazing_fast: { provider: 'cerebras', modelId: 'zai-glm-4.6' }, // Cerebras Code Pro model
  blazing_fast_no_tools: { provider: 'cerebras', modelId: 'llama3.1-8b' }, // Fastest, no tool calling
  'cerebras-zai-glm': { provider: 'cerebras', modelId: 'zai-glm-4.6' }, // Cerebras Code Pro model
  'cerebras-llama-8b': { provider: 'cerebras', modelId: 'llama3.1-8b' },
  'cerebras-llama-70b': { provider: 'cerebras', modelId: 'llama-3.3-70b' },
  'cerebras-qwen-32b': { provider: 'cerebras', modelId: 'qwen-3-32b' },
  'cerebras-qwen-235b': { provider: 'cerebras', modelId: 'qwen-3-235b-a22b-instruct-2507' },
  'cerebras-gpt-120b': { provider: 'cerebras', modelId: 'gpt-oss-120b' },
};

/**
 * Get the AI SDK model instance for a given model name.
 */
export function getModel(modelName: string): LanguageModel {
  const config = MODEL_ALIASES[modelName];

  if (config) {
    switch (config.provider) {
      case 'together':
        return togetherai(config.modelId);
      case 'openai':
        return openai(config.modelId);
      case 'anthropic':
        return anthropic(config.modelId);
      case 'google':
        return google(config.modelId);
      case 'bedrock':
        return bedrock(config.modelId);
      case 'cerebras':
        return cerebras(config.modelId);
    }
  }

  // Try to infer provider from model name
  if (modelName.startsWith('gpt-')) {
    return openai(modelName);
  }
  if (modelName.startsWith('claude-')) {
    return anthropic(modelName);
  }
  if (modelName.startsWith('gemini-')) {
    return google(modelName);
  }
  if (modelName.startsWith('us.anthropic.') || modelName.startsWith('anthropic.')) {
    return bedrock(modelName);
  }

  // Default to Together AI for open-source models
  return togetherai(modelName);
}

/**
 * Check if a model is Cerebras-based.
 */
export function isCerebrasModel(modelName: string): boolean {
  const config = MODEL_ALIASES[modelName];
  if (config?.provider === 'cerebras') return true;
  // Also check explicit cerebras model names
  return (
    modelName.startsWith('cerebras-') ||
    modelName === 'blazing_fast' ||
    modelName === 'blazing_fast_no_tools'
  );
}
