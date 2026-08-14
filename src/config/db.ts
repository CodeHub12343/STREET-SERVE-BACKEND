import mongoose from 'mongoose';

import { env } from './env';
import { logger } from './logger';

/**
 * MongoDB connection (Mongoose). The URI must point at a replica set — multi-document
 * transactions (settlement, oversell guard, money moves) require it. See
 * DATABASE_SCHEMA_PLAN.md §0 and BACKEND_ARCHITECTURE.md §3.1.
 */
mongoose.set('strictQuery', true);

let connected = false;

export async function connectMongo(uri: string = env.MONGODB_URI): Promise<typeof mongoose> {
  if (connected) return mongoose;

  mongoose.connection.on('error', (err) => logger.error({ err }, 'mongo connection error'));
  mongoose.connection.on('disconnected', () => logger.warn('mongo disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('mongo reconnected'));

  await mongoose.connect(uri, {
    // `majority` write concern on the shared connection: money collections must not lose writes.
    writeConcern: { w: 'majority' },
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
    /**
     * Indexes are migrations, not a boot side effect (DEPLOYMENT_STRATEGY.md §7: "never implicit
     * runtime ensureIndex in prod").
     *
     * Mongoose defaults `autoIndex` to true, so the first deployed boot built every schema index
     * under Mongoose's own default names — and then `migrate-mongo up` could not create the same
     * index under its intended name, failing with "Index already exists with a different name:
     * authProviderId_1". The app had raced its own migrations and won.
     *
     * Left on for test and development, where no migration runs and the suite depends on unique
     * constraints existing. Off everywhere deployed, so `migrate-mongo` is the single writer.
     */
    autoIndex: env.NODE_ENV === 'test' || env.NODE_ENV === 'development',
  });
  connected = true;
  logger.info('mongo connected');
  return mongoose;
}

export async function disconnectMongo(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}

export function mongoReady(): boolean {
  // 1 === connected
  return Number(mongoose.connection.readyState) === 1;
}

export { mongoose };
