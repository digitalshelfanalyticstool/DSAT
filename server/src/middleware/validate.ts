/**
 * Request-validation middleware.
 *
 * `validate({ body, query, params })` parses the named request parts with the
 * given Zod schemas. On failure it responds `400` with a structured
 * `validation_error` listing the offending fields and stops the chain. On
 * success it **replaces** the request part with the parsed (and coerced /
 * defaulted) value, so downstream handlers consume typed, sanitised input —
 * `req.query.page` is a `number`, not `string | string[] | undefined`.
 *
 * Validate at the boundary only: schemas describe what clients may send, not
 * internal invariants. Where the current handler is lenient about unknown body
 * keys, the schema should be too (`.passthrough()`); query-string numbers come
 * in as strings, so use `z.coerce.number()`.
 *
 * Usage:
 *   router.post('/things', validate({ body: createThingSchema }), handler);
 *   router.get('/things/:id', validate({ params: idParamSchema, query: listQuerySchema }), handler);
 *
 * To get the parsed types in a handler, type the request as
 * `ValidatedRequest<typeof schemas>` (extending whatever request type the
 * handler already uses, e.g. `AuthenticatedRequest`).
 */

import { z } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import { errorResponse } from '../utils/error-response';

/** `:id` route params as a positive integer. */
export const idParams = z.object({ id: z.coerce.number().int().positive() });

export interface ValidationSchemas {
  body?: z.ZodTypeAny;
  query?: z.ZodTypeAny;
  params?: z.ZodTypeAny;
}

type Part = keyof ValidationSchemas;
const PARTS: readonly Part[] = ['body', 'query', 'params'] as const;

/**
 * Build an Express middleware that validates `req.body` / `req.query` /
 * `req.params` against the supplied Zod schemas.
 */
export function validate(schemas: ValidationSchemas) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const fieldErrors: string[] = [];

    for (const part of PARTS) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) {
        // Express 5 defines `req.query` as a GETTER-ONLY property on the request
        // prototype (it lazily parses the query string). Plain assignment to it
        // therefore throws under "use strict" — which is what compiled TypeScript
        // runs as:
        //
        //   TypeError: Cannot set property query of #<IncomingMessage>
        //              which has only a getter
        //
        // Worse, in sloppy mode the same assignment fails SILENTLY, leaving
        // handlers with raw un-coerced input (`page` as a string) instead of the
        // parsed value — a quiet correctness bug rather than a loud one.
        //
        // defineProperty installs an OWN property on this request instance that
        // shadows the prototype getter, which works on both Express 4 and 5.
        // Applied uniformly to body/params/query: `body` and `params` are still
        // plain assignable properties in Express 5, but treating all three the
        // same removes the need to remember which is which.
        Object.defineProperty(req, part, {
          value: result.data,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        for (const issue of result.error.issues) {
          const path = issue.path.length > 0 ? issue.path.join('.') : part;
          fieldErrors.push(`${part}.${path}: ${issue.message}`);
        }
      }
    }

    if (fieldErrors.length > 0) {
      res.status(400).json(errorResponse(
        `Invalid request: ${fieldErrors.join('; ')}`,
        'validation_error',
      ));
      return;
    }

    next();
  };
}

/**
 * Narrows `req.body` / `req.query` / `req.params` to the output types of the
 * schemas passed to `validate()`. Use as the handler's request type:
 *
 *   const schemas = { query: listSchema, params: idSchema };
 *   router.get('/x/:id', validate(schemas),
 *     (req: ValidatedRequest<typeof schemas, AuthenticatedRequest>, res) => { … });
 */
export type ValidatedRequest<
  S extends ValidationSchemas,
  R extends Request = Request,
> = R & {
  body: S['body'] extends z.ZodTypeAny ? z.infer<S['body']> : R['body'];
  query: S['query'] extends z.ZodTypeAny ? z.infer<S['query']> : R['query'];
  params: S['params'] extends z.ZodTypeAny ? z.infer<S['params']> : R['params'];
};
