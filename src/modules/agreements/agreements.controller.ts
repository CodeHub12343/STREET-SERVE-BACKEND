import type { Request, Response } from 'express';
import type { z } from 'zod';

import { body, params } from '../../middleware/validate';
import { created, ok } from '../../shared/respond';
import { UnauthenticatedError } from '../../shared/errors/AppError';
import type { Principal } from '../../shared/types/principal';
import type { AcceptAgreementBody, AgreementTypeParam } from './agreements.schema';
import { agreementsService } from './agreements.service';

function principal(req: Request): Principal {
  if (!req.principal) throw UnauthenticatedError();
  return req.principal;
}

export const agreementsController = {
  /** Public: the current agreement body for the clickwrap to display + attest against. */
  // eslint-disable-next-line @typescript-eslint/require-await -- asyncHandler requires a Promise-returning handler
  get: async (req: Request, res: Response): Promise<void> => {
    const { type } = params<z.infer<typeof AgreementTypeParam>>(req);
    ok(res, agreementsService.get(type));
  },

  accept: async (req: Request, res: Response): Promise<void> => {
    const { type } = params<z.infer<typeof AgreementTypeParam>>(req);
    const input = body<z.infer<typeof AcceptAgreementBody>>(req);
    created(res, await agreementsService.accept(principal(req), type, input));
  },
};
