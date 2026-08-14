import {
  OpenApiGeneratorV31,
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import { AddRoleBody, UpdateProfileBody } from './modules/identity/identity.schema';

extendZodWithOpenApi(z);

/**
 * OpenAPI 3.1 document generated from the Zod schemas (single source of truth for request
 * shapes). Served at /openapi.json in non-prod. Later phases register every route's schema; Phase
 * 0 documents the foundational endpoints and the shared error/success envelopes.
 */
const ErrorEnvelope = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
      requestId: z.string().optional(),
      retryable: z.boolean().optional(),
    }),
  })
  .openapi('ErrorEnvelope');

export function buildOpenApiDocument(): object {
  const registry = new OpenAPIRegistry();

  registry.register('UpdateProfileBody', UpdateProfileBody);
  registry.register('AddRoleBody', AddRoleBody);
  registry.register('ErrorEnvelope', ErrorEnvelope);

  const bearer = registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT',
  });

  registry.registerPath({
    method: 'get',
    path: '/api/v1/users/me',
    summary: 'Current profile + roles + verification tier',
    security: [{ [bearer.name]: [] }],
    responses: { 200: { description: 'Current user' }, 401: { description: 'Unauthenticated' } },
  });

  registry.registerPath({
    method: 'patch',
    path: '/api/v1/users/me',
    summary: 'Update own profile',
    security: [{ [bearer.name]: [] }],
    request: {
      body: { content: { 'application/json': { schema: UpdateProfileBody } } },
    },
    responses: { 200: { description: 'Updated user' }, 400: { description: 'Validation error' } },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/v1/auth/roles',
    summary: 'Add a self-grantable role to the current account',
    security: [{ [bearer.name]: [] }],
    request: { body: { content: { 'application/json': { schema: AddRoleBody } } } },
    responses: {
      200: { description: 'Updated user' },
      403: { description: 'Role not self-grantable' },
    },
  });

  const generator = new OpenApiGeneratorV31(registry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'StreetServe API',
      version: '0.1.0',
      description:
        'Phase 0 Foundations — see STREET-SERVE-APPLICATION-BACKEND/API_SPECIFICATION.md',
    },
    servers: [{ url: '/' }],
  });
}
