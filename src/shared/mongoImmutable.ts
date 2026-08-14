import type { Schema } from 'mongoose';

/**
 * Append-only guard for immutable financial/audit collections (settlements, completed
 * transactions, audit_logs). Corrections happen via new offsetting documents, never in-place
 * updates. See DATABASE_SCHEMA_PLAN.md §0(5) and SECURITY_GUIDELINES.md §2.
 */
export function immutablePlugin(schema: Schema): void {
  const blockUpdate = function block(this: unknown, next: (err?: Error) => void): void {
    next(new Error('immutable collection: in-place updates are forbidden (append a new document)'));
  };

  schema.pre('updateOne', blockUpdate);
  schema.pre('updateMany', blockUpdate);
  schema.pre('findOneAndUpdate', blockUpdate);
  schema.pre('replaceOne', blockUpdate);

  // Allow the initial insert; block re-saving a modified existing document.
  schema.pre('save', function guard(next) {
    if (!this.isNew) {
      next(new Error('immutable collection: documents cannot be modified after creation'));
      return;
    }
    next();
  });
}
