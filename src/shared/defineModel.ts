import mongoose, { type InferSchemaType, type Model, type Schema } from 'mongoose';

/**
 * Idempotent model registration. Returns the already-compiled model if present, otherwise
 * compiles it. Prevents Mongoose's "Cannot overwrite model once compiled" error when the module
 * graph is re-evaluated (e.g. across test files sharing one Mongoose instance).
 */
export function defineModel<TSchema extends Schema>(
  name: string,
  schema: TSchema,
): Model<InferSchemaType<TSchema>> {
  const existing = mongoose.models[name] as Model<InferSchemaType<TSchema>> | undefined;
  return existing ?? mongoose.model<InferSchemaType<TSchema>>(name, schema);
}
