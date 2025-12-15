import openapiTS, { astToString } from 'openapi-typescript';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as yaml from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '../openapi.yaml');
// Support configurable output via OUTPUT_TS env var for CI drift checks
const OUTPUT_DIR = process.env.OUTPUT_TS || path.join(__dirname, '../generated/typescript');
const OUTPUT_PATH = path.join(OUTPUT_DIR, 'index.ts');

async function generate() {
  console.log('Generating TypeScript types from OpenAPI schema...');

  const ast = await openapiTS(new URL(`file://${SCHEMA_PATH}`), {
    exportType: true,
  });

  let output = astToString(ast);

  // Read the schema to get all type names
  const schemaContent = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  const openapi = yaml.parse(schemaContent);
  const schemaNames = Object.keys(openapi.components?.schemas || {});

  // Add type aliases for easier consumption
  const typeAliases = schemaNames
    .map((name) => `export type ${name} = components["schemas"]["${name}"];`)
    .join('\n');

  output += `\n// Type aliases for easier consumption\n${typeAliases}\n`;

  // Ensure output directory exists
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Write generated types (single .ts file - Bun imports .ts directly)
  fs.writeFileSync(OUTPUT_PATH, output);

  console.log(`Generated TypeScript types at ${OUTPUT_PATH}`);
}

generate().catch((err) => {
  console.error('Failed to generate TypeScript types:', err);
  process.exit(1);
});
