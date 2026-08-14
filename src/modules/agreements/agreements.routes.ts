import { Router } from 'express';

import { authenticate } from '../../middleware/auth';
import { asyncHandler } from '../../middleware/asyncHandler';
import { rateLimit } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { agreementsController } from './agreements.controller';
import { AcceptAgreementBody, AgreementTypeParam } from './agreements.schema';

export const agreementsRouter = Router();

// Read the current body (public) so the clickwrap can render + attest the exact text.
agreementsRouter.get(
  '/:type',
  rateLimit('read'),
  validate({ params: AgreementTypeParam }),
  asyncHandler(agreementsController.get),
);

// Record acceptance (immutable, server-timestamped, version+hash captured).
agreementsRouter.post(
  '/:type/accept',
  rateLimit('write'),
  authenticate,
  validate({ params: AgreementTypeParam, body: AcceptAgreementBody }),
  asyncHandler(agreementsController.accept),
);
