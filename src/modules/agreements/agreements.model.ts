import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';
import { immutablePlugin } from '../../shared/mongoImmutable';
import { AGREEMENT_TYPES } from './agreements.registry';

/**
 * Generalized agreement acceptances (R28 / DEBT7) — one immutable, server-timestamped row per
 * (user, agreement_type, version). The `content_hash` records the exact body accepted, so an
 * acceptance is tamper-evident (S5): the reviewed text can change under a new version, but what a
 * user agreed to is frozen. Append-only — corrections are new rows, never edits.
 */
const AgreementAcceptanceSchema = new Schema(
  {
    user_id: { type: String, required: true },
    agreement_type: { type: String, enum: AGREEMENT_TYPES, required: true },
    version: { type: String, required: true },
    content_hash: { type: String, required: true },
    accepted_at: { type: Date, default: () => new Date() },
  },
  { collection: 'agreement_acceptances' },
);
AgreementAcceptanceSchema.index({ user_id: 1, agreement_type: 1, version: 1 }, { unique: true });
AgreementAcceptanceSchema.plugin(immutablePlugin);

export type AgreementAcceptanceDoc = InferSchemaType<typeof AgreementAcceptanceSchema>;
export const AgreementAcceptanceModel = defineModel(
  'AgreementAcceptance',
  AgreementAcceptanceSchema,
);
