import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import SwaggerParser from '@apidevtools/swagger-parser';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../src/index';

const file = fileURLToPath(new URL('../openapi.yaml', import.meta.url));

describe('openapi.yaml', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const api = await SwaggerParser.validate(file);
    expect((api as { openapi: string }).openapi).toBe('3.1.0');
  });

  it('lists exactly the error codes of the catalogue', () => {
    const doc = parse(readFileSync(file, 'utf8'));
    const codes: string[] = doc.components.schemas.Error.properties.error.properties.code.enum;
    expect([...codes].sort()).toEqual([...ERROR_CODES].sort());
  });

  it('requires Idempotency-Key on every write', () => {
    const doc = parse(readFileSync(file, 'utf8'));
    for (const [path, item] of Object.entries<Record<string, { parameters?: { $ref?: string }[] }>>(
      doc.paths,
    )) {
      for (const method of ['post', 'patch', 'delete'] as const) {
        const op = item[method];
        if (!op || path === '/oauth/token') continue;
        const refs = (op.parameters ?? []).map((p) => p.$ref);
        expect(refs, `${method.toUpperCase()} ${path}`).toContain(
          '#/components/parameters/IdempotencyKey',
        );
      }
    }
  });

  it('never returns passport numbers or dates of birth', () => {
    const doc = parse(readFileSync(file, 'utf8'));
    const schemas = doc.components.schemas;
    const responseSchemas = [
      'Booking',
      'Event',
      'Quote',
      'Hold',
      'Availability',
      'Vessel',
      'Sailing',
    ];
    const propertyNames = (node: unknown): string[] => {
      if (!node || typeof node !== 'object') return [];
      const record = node as Record<string, unknown>;
      const own = record.properties ? Object.keys(record.properties as object) : [];
      return [...own, ...Object.values(record).flatMap(propertyNames)];
    };
    for (const name of responseSchemas) {
      const names = propertyNames(schemas[name]);
      expect(
        names.filter((n) => /passport|birth/.test(n)),
        name,
      ).toEqual([]);
    }
    expect(schemas.GuestInput.properties.passport_number.writeOnly).toBe(true);
  });
});
