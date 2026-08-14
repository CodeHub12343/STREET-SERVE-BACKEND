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
