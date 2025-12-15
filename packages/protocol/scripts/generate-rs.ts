/**
 * Custom Rust codegen from OpenAPI schema.
 *
 * This generates Rust types with proper serde attributes, including:
 * - String enums with correct rename_all based on casing
 * - Structs with camelCase field renaming
 * - Discriminated unions with #[serde(tag = "type")]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '../openapi.yaml');
// Support configurable output via OUTPUT_RS env var for CI drift checks
const OUTPUT_DIR = process.env.OUTPUT_RS || path.join(__dirname, '../generated/rust');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'mod.rs');
// Desktop crate destination (copy instead of symlink for Windows compatibility)
const DESKTOP_GENERATED_DIR = path.join(__dirname, '../../../desktop/src-tauri/src/generated');
const DESKTOP_GENERATED_PATH = path.join(DESKTOP_GENERATED_DIR, 'mod.rs');

interface OpenAPISchema {
  components?: {
    schemas?: Record<string, SchemaObject>;
  };
}

interface SchemaObject {
  type?: string | string[];
  enum?: string[];
  description?: string;
  required?: string[];
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  oneOf?: SchemaObject[];
  $ref?: string;
  const?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  additionalProperties?: boolean | SchemaObject;
  nullable?: boolean;
}

interface DiscriminatorMapping {
  propertyName: string;
  mapping: Record<string, string>;
}

// Convert string to Rust-idiomatic PascalCase
function toPascalCase(s: string): string {
  // Handle kebab-case
  if (s.includes('-')) {
    return s
      .split('-')
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join('');
  }
  // Handle SCREAMING_SNAKE_CASE (with or without underscores)
  if (s === s.toUpperCase() && /^[A-Z]/.test(s)) {
    return s
      .split('_')
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
      .join('');
  }
  // Handle camelCase
  if (/^[a-z]/.test(s)) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  return s;
}

// Convert camelCase to snake_case
function toSnakeCase(s: string): string {
  return s
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

// Resolve $ref to schema name
function resolveRef(ref: string): string {
  const match = ref.match(/#\/components\/schemas\/(.+)$/);
  return match ? match[1] : ref;
}

// Map OpenAPI type to Rust type
function mapType(
  schema: SchemaObject,
  required: boolean,
  schemas: Record<string, SchemaObject>,
  parentName?: string,
  fieldName?: string
): string {
  if (schema.$ref) {
    const typeName = resolveRef(schema.$ref);
    return required ? typeName : `Option<${typeName}>`;
  }

  // Handle oneOf with null (nullable union)
  if (schema.oneOf) {
    const nonNullSchemas = schema.oneOf.filter(
      (s) => !(s.type === 'null' || (Array.isArray(s.type) && s.type.includes('null')))
    );
    if (nonNullSchemas.length === 1) {
      const innerType = mapType(nonNullSchemas[0]!, true, schemas, parentName, fieldName);
      return `Option<${innerType}>`;
    }
    // Complex union - use Value for now
    return 'serde_json::Value';
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const isNullable = types.includes('null') || schema.nullable;
  const mainType = types.find((t) => t !== 'null') || 'string';

  let rustType: string;

  switch (mainType) {
    case 'string':
      rustType = 'String';
      break;
    case 'integer':
      if (schema.format === 'uint8' || (schema.minimum === 0 && schema.maximum === 100)) {
        rustType = 'u8';
      } else if (schema.format === 'uint16') {
        rustType = 'u16';
      } else if (schema.format === 'uint64' || schema.format === 'int64') {
        rustType = 'u64';
      } else {
        rustType = 'i64';
      }
      break;
    case 'number':
      rustType = 'f64';
      break;
    case 'boolean':
      rustType = 'bool';
      break;
    case 'array':
      if (schema.items) {
        const itemType = mapType(schema.items, true, schemas, parentName, fieldName);
        rustType = `Vec<${itemType}>`;
      } else {
        rustType = 'Vec<serde_json::Value>';
      }
      break;
    case 'object':
      if (schema.additionalProperties) {
        rustType = 'serde_json::Map<String, serde_json::Value>';
      } else if (schema.properties) {
        // Inline nested object - generate a named type
        if (parentName && fieldName) {
          rustType = `${parentName}${toPascalCase(fieldName)}`;
        } else {
          rustType = 'serde_json::Value';
        }
      } else {
        rustType = 'serde_json::Value';
      }
      break;
    default:
      rustType = 'serde_json::Value';
  }

  if (isNullable || !required) {
    return `Option<${rustType}>`;
  }
  return rustType;
}

// Generate Rust enum from OpenAPI string enum
function generateEnum(name: string, schema: SchemaObject): string {
  const values = schema.enum || [];
  const description = schema.description ? `/// ${schema.description}\n` : '';

  // Always use explicit renames for each variant to be precise
  const variants = values
    .map((v) => {
      const variantName = toPascalCase(v);
      // Always add explicit rename to ensure correctness
      return `    #[serde(rename = "${v}")]\n    ${variantName},`;
    })
    .join('\n');

  return `${description}#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum ${name} {
${variants}
}
`;
}

// Collect inline nested structs that need to be generated
const inlineStructs: Map<string, { schema: SchemaObject; parentName: string; fieldName: string }> =
  new Map();

// Generate Rust struct from OpenAPI object
function generateStruct(
  name: string,
  schema: SchemaObject,
  schemas: Record<string, SchemaObject>
): string {
  const description = schema.description ? `/// ${schema.description}\n` : '';
  const required = new Set(schema.required || []);
  const properties = schema.properties || {};

  // Check if all fields are camelCase
  const fieldNames = Object.keys(properties);
  const allCamelCase = fieldNames.every((f) => /^[a-z][a-zA-Z0-9]*$/.test(f));
  const allSnakeCase = fieldNames.every((f) => /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(f));

  let serdeAttr = '';
  if (allCamelCase && !allSnakeCase) {
    serdeAttr = '#[serde(rename_all = "camelCase")]\n';
  }

  const fields = Object.entries(properties)
    .map(([fieldName, fieldSchema]) => {
      const rustFieldName = toSnakeCase(fieldName);

      // Check for inline nested objects in oneOf
      if (fieldSchema.oneOf) {
        const nonNullSchemas = fieldSchema.oneOf.filter(
          (s) => !(s.type === 'null' || (Array.isArray(s.type) && s.type.includes('null')))
        );
        if (nonNullSchemas.length === 1 && nonNullSchemas[0]!.properties) {
          // Register inline struct for generation
          const inlineTypeName = `${name}${toPascalCase(fieldName)}`;
          inlineStructs.set(inlineTypeName, {
            schema: nonNullSchemas[0]!,
            parentName: name,
            fieldName,
          });
        }
      }

      const rustType = mapType(fieldSchema, required.has(fieldName), schemas, name, fieldName);
      const fieldDesc = fieldSchema.description ? `    /// ${fieldSchema.description}\n` : '';

      // Add explicit rename if needed and not using rename_all
      let renameAttr = '';
      if (!serdeAttr && rustFieldName !== fieldName) {
        renameAttr = `    #[serde(rename = "${fieldName}")]\n`;
      }

      return `${fieldDesc}${renameAttr}    pub ${rustFieldName}: ${rustType},`;
    })
    .join('\n');

  return `${description}#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
${serdeAttr}pub struct ${name} {
${fields}
}
`;
}

// Generate Rust enum from OpenAPI discriminated union (oneOf with discriminator)
function generateDiscriminatedUnion(
  name: string,
  schema: SchemaObject & { discriminator?: DiscriminatorMapping },
  schemas: Record<string, SchemaObject>
): string {
  const description = schema.description ? `/// ${schema.description}\n` : '';
  const discriminator = schema.discriminator;

  if (!discriminator || !schema.oneOf) {
    return `// TODO: ${name} - complex union without discriminator\n`;
  }

  const variants = Object.entries(discriminator.mapping)
    .map(([discriminatorValue, ref]) => {
      const schemaName = resolveRef(ref);
      const variantSchema = schemas[schemaName];
      if (!variantSchema) {
        return `    // TODO: Missing schema for ${schemaName}`;
      }

      const variantName = toPascalCase(discriminatorValue);
      const properties = variantSchema.properties || {};
      const required = new Set(variantSchema.required || []);

      // Get fields excluding the discriminator property
      const fields = Object.entries(properties)
        .filter(([fieldName]) => fieldName !== discriminator.propertyName)
        .map(([fieldName, fieldSchema]) => {
          const rustFieldName = toSnakeCase(fieldName);
          const rustType = mapType(fieldSchema, required.has(fieldName), schemas);
          // Add serde rename for camelCase fields
          if (rustFieldName !== fieldName) {
            return `        #[serde(rename = "${fieldName}")]\n        ${rustFieldName}: ${rustType},`;
          }
          return `        ${rustFieldName}: ${rustType},`;
        })
        .join('\n');

      return `    #[serde(rename = "${discriminatorValue}")]
    ${variantName} {
${fields}
    },`;
    })
    .join('\n');

  return `${description}#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "${discriminator.propertyName}")]
pub enum ${name} {
${variants}
}
`;
}

async function generate() {
  console.log('Generating Rust types from OpenAPI schema...');

  // Read and parse the OpenAPI YAML
  const openapiContent = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  const openapi = yaml.parse(openapiContent) as OpenAPISchema;

  const schemas = openapi.components?.schemas || {};

  // Categorize schemas
  const enums: string[] = [];
  const structs: string[] = [];
  const unions: string[] = [];

  for (const [name, schema] of Object.entries(schemas)) {
    if (schema.enum && schema.type === 'string') {
      enums.push(name);
    } else if (schema.oneOf && (schema as { discriminator?: unknown }).discriminator) {
      unions.push(name);
    } else if (schema.type === 'object' || schema.properties) {
      structs.push(name);
    }
  }

  // Generate code
  let output = `//! Generated Rust types from OpenAPI schema.
//!
//! DO NOT EDIT - regenerate with \`bun run codegen\`
//!
//! This file is auto-generated from packages/protocol/openapi.yaml

use serde::{Deserialize, Serialize};

`;

  // Generate enums first (they're referenced by other types)
  output += '// ============ Enums ============\n\n';
  for (const name of enums) {
    output += generateEnum(name, schemas[name]!) + '\n';
  }

  // Generate structs
  output += '// ============ Structs ============\n\n';
  for (const name of structs) {
    // Skip individual event types - they're inlined in the union
    if (name.endsWith('Event') && name !== 'SonosEvent') {
      continue;
    }
    output += generateStruct(name, schemas[name]!, schemas) + '\n';
  }

  // Generate inline nested structs
  for (const [inlineName, { schema }] of inlineStructs) {
    output += generateStruct(inlineName, schema, schemas) + '\n';
  }

  // Generate discriminated unions
  output += '// ============ Discriminated Unions ============\n\n';
  for (const name of unions) {
    output +=
      generateDiscriminatedUnion(
        name,
        schemas[name] as SchemaObject & { discriminator?: DiscriminatorMapping },
        schemas
      ) + '\n';
  }

  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Write generated types
  fs.writeFileSync(OUTPUT_PATH, output);

  console.log(`Generated Rust types at ${OUTPUT_PATH}`);

  // Copy to desktop crate (skip if OUTPUT_RS is set, i.e., CI drift check)
  if (!process.env.OUTPUT_RS) {
    fs.mkdirSync(DESKTOP_GENERATED_DIR, { recursive: true });
    fs.copyFileSync(OUTPUT_PATH, DESKTOP_GENERATED_PATH);
    console.log(`Copied Rust types to ${DESKTOP_GENERATED_PATH}`);
  }
}

generate().catch((err) => {
  console.error('Failed to generate Rust types:', err);
  process.exit(1);
});
