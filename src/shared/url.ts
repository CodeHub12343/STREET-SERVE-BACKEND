import { z } from 'zod';

/**
 * A URL that is safe to hand back to a browser and render.
 *
 * `z.string().url()` is NOT that: it delegates to the URL constructor, which happily accepts
 * `javascript:alert(1)`, `data:text/html,...`, and `file:///...`. Any of those stored on a domain
 * record and later rendered in an href — or read by a client that trusts our data — is a stored
 * XSS. Media URLs on this platform are always http(s) (R2 public objects), so anything else is
 * either a mistake or an attack.
 */
export const HttpUrl = z
  .string()
  .max(2048)
  .refine(
    (v) => {
      try {
        const scheme = new URL(v).protocol;
        return scheme === 'https:' || scheme === 'http:';
      } catch {
        return false;
      }
    },
    { message: 'Must be an http(s) URL' },
  );
