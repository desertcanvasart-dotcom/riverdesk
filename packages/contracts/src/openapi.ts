import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export type { components, paths, operations, webhooks } from './generated/openapi';

/** The channel API contract (OpenAPI 3.1), as text and parsed. */
export const OPENAPI_PATH = fileURLToPath(new URL('../openapi.yaml', import.meta.url));

export function openApiText(): string {
  return readFileSync(OPENAPI_PATH, 'utf8');
}

export function openApiDocument(): Record<string, unknown> {
  return parse(openApiText()) as Record<string, unknown>;
}
