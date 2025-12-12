/**
 * JSON Schema to Zod Conversion Utilities
 *
 * Converts JSON Schema to Zod schemas at runtime for AI SDK tool definitions.
 */

import { z, ZodTypeAny } from 'zod';

/**
 * Convert JSON Schema to Zod schema at runtime.
 * Handles basic types that LLM tools typically use.
 * CRITICAL: Preserves description fields - without them, the model won't know what parameters mean!
 */
export function jsonSchemaToZod(schema: any): ZodTypeAny {
  if (!schema) return z.object({});

  // Handle anyOf/oneOf by using first option (simplified)
  if (schema.anyOf) {
    return jsonSchemaToZod(schema.anyOf[0]);
  }
  if (schema.oneOf) {
    return jsonSchemaToZod(schema.oneOf[0]);
  }

  // Default to object type if no type specified but has properties
  if (!schema.type && schema.properties) {
    schema = { ...schema, type: 'object' };
  }

  // Default to object type if completely empty
  if (!schema.type) {
    return z.object({}).passthrough();
  }

  // Helper to add description if present
  const withDescription = (zodSchema: ZodTypeAny, description?: string): ZodTypeAny => {
    if (description) {
      return zodSchema.describe(description);
    }
    return zodSchema;
  };

  switch (schema.type) {
    case 'string':
      if (schema.enum) {
        const enumSchema = z.enum(schema.enum as [string, ...string[]]);
        return withDescription(enumSchema, schema.description);
      }
      return withDescription(z.string(), schema.description);

    case 'number':
    case 'integer':
      return withDescription(z.number(), schema.description);

    case 'boolean':
      return withDescription(z.boolean(), schema.description);

    case 'null':
      return z.null();

    case 'array':
      const itemSchema = schema.items ? jsonSchemaToZod(schema.items) : z.unknown();
      return withDescription(z.array(itemSchema), schema.description);

    case 'object':
      if (schema.properties) {
        const shape: Record<string, ZodTypeAny> = {};
        const required = new Set(schema.required || []);

        for (const [key, value] of Object.entries(schema.properties)) {
          const propValue = value as any;
          let propSchema = jsonSchemaToZod(propValue);
          // Make optional if not in required array
          if (!required.has(key)) {
            propSchema = propSchema.optional();
          }
          shape[key] = propSchema;
        }
        // Allow additional properties by default
        const objSchema = z.object(shape).passthrough();
        return withDescription(objSchema, schema.description);
      }
      return withDescription(z.record(z.unknown()), schema.description);

    default:
      // Fallback for unknown types
      return z.unknown();
  }
}
