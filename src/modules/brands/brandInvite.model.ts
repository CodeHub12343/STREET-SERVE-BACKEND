import { Schema, type InferSchemaType } from 'mongoose';

import { defineModel } from '../../shared/defineModel';

/**
 * ═══ FRANCHISE / MULTI-VENDOR — Phase 3 BrandInvite. ═══
 *
 * One row per outstanding invitation. Status is a strict lifecycle: `pending` → `accepted` |
 * `revoked` | `expired`. Terminal states are never deleted — a historical record of "who was
 * invited and when" is what supports audits of brand access over time.
 *
 * `token` is cryptographically random and opaque. The accept URL is `/brand/accept/<token>` on
 * the frontend; the backend accept endpoint takes the token and resolves to this row. Tokens
 * are 32-byte base64url (≈43 chars), unguessable, scoped per invite.
 *
 * Why NOT reuse `BrandMembership` with `status: 'invited'`: BrandMembership is the authorisation
 * anchor read by `businessAccess` on every request, and keeping it in-sync with pending invites
 * would bloat its unique-index semantics (a pending invite isn't a privilege). An invite is a
 * promise that MAY become a membership; a membership is a current fact.
 */
const BrandInviteSchema = new Schema(
  {
    brand_id: { type: Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },

    /**
     * Lowercase, trimmed. Normalised at write time, matched case-insensitively at accept time.
     * An invite is tied to the EMAIL ADDRESS it was sent to — a different authenticated user
     * accepting the same token is refused, so a stolen invite link cannot be hijacked by
     * someone who happens to be signed in.
     */
    invitee_email: { type: String, required: true, lowercase: true, trim: true, index: true },

    role: {
      type: String,
      enum: ['manager', 'operator'],
      required: true,
    },

    /**
     * Business ids this operator may operate on; empty = all businesses the brand has. Mirrors
     * `BrandMembership.scoped_business_ids`. For `manager` role we typically leave empty — a
     * manager runs the brand, not a single truck.
     */
    scoped_business_ids: {
      type: [{ type: Schema.Types.ObjectId, ref: 'Business' }],
      default: [],
    },

    /** When this invite becomes a BrandOperator row too. Required for operator role, optional
     *  for manager. Set by the inviter when they intend to seat the invitee at a specific truck. */
    seat_operator: {
      business_id: { type: Schema.Types.ObjectId, ref: 'Business', default: null },
      display_name: { type: String, default: null },
    },

    token: { type: String, required: true, unique: true, index: true },

    /**
     * Lifecycle. `pending` is the only state the accept path acts on; a terminal state here
     * is a historical record, never a privilege. Expiry is checked at accept time, not by a
     * background job, so a reactivated invite would need a new row (safer).
     */
    status: {
      type: String,
      enum: ['pending', 'accepted', 'revoked', 'expired'],
      default: 'pending',
      index: true,
    },

    invited_by: { type: String, required: true },
    expires_at: { type: Date, required: true, index: true },
    accepted_at: { type: Date, default: null },
    accepted_by_user_id: { type: String, default: null },
    revoked_at: { type: Date, default: null },
    revoked_by: { type: String, default: null },
    revoked_reason: { type: String, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' }, collection: 'brand_invites' },
);

/**
 * Only ONE pending invite per (brand, email). A second invite to the same address while an
 * earlier one is still live is treated as a resend by the service — the duplicate index refuses
 * at the database layer, and the service converts the error into a "we've already invited this
 * person; here's the live invite" response.
 */
BrandInviteSchema.index(
  { brand_id: 1, invitee_email: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } },
);

export type BrandInviteDoc = InferSchemaType<typeof BrandInviteSchema>;
export const BrandInviteModel = defineModel('BrandInvite', BrandInviteSchema);
