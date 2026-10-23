import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export type { components, paths, operations, webhooks } from './generated/openapi';

/**
 * The channel API contract (OpenAPI 3.1), as text and parsed. A separate entry point
 * (`@vs/contracts/openapi`) so bundled apps that only need error codes never load the file.
 */
export function openApiText(): string {
  return readFileSync(fileURLToPath(new URL('../openapi.yaml', import.meta.url)), 'utf8');
}

export function openApiDocument(): Record<string, unknown> {
  return parse(openApiText()) as Record<string, unknown>;
}
