import { randomUUID } from 'node:crypto';

import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { env } from '../../config/env';

/**
 * Object storage (Cloudflare R2 / S3-compatible). Uploads use PRESIGNED PUT URLs — the client
 * uploads bytes directly to R2, the server never proxies them (THIRD_PARTY_INTEGRATIONS.md §5).
 * Injectable so tests run without R2 credentials.
 */
export interface UploadTarget {
  key: string;
  uploadUrl: string;
  publicUrl: string;
}

export interface ObjectHead {
  sizeBytes: number;
  contentType: string | null;
}

export interface StorageGateway {
  createUploadUrl(input: { prefix: string; contentType: string }): Promise<UploadTarget>;
  /**
   * Reads the first `maxBytes` of an object.
   *
   * Needed because uploads go straight from the browser to R2 — the server never sees the bytes in
   * flight, so anything that must INSPECT a file (pre-press validation, format sniffing) has to
   * fetch it afterwards. Range-limited on purpose: header parsing needs a few hundred kilobytes,
   * and pulling a 60 MB print PDF into memory to read its first chunk would be a denial-of-service
   * a user could trigger by uploading.
   *
   * Returns null when the object does not exist — which is the normal "client never completed the
   * upload" case, not an error.
   */
  readObjectHead(key: string, maxBytes: number): Promise<{ head: ObjectHead; bytes: Buffer } | null>;
}

class R2StorageGateway implements StorageGateway {
  private client: S3Client;

  constructor() {
    if (!env.R2_ENDPOINT || !env.R2_ACCESS_KEY_ID || !env.R2_SECRET_ACCESS_KEY) {
      throw new Error('R2 storage is not configured');
    }
    this.client = new S3Client({
      region: env.R2_REGION,
      endpoint: env.R2_ENDPOINT,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
    });
  }

  async createUploadUrl(input: { prefix: string; contentType: string }): Promise<UploadTarget> {
    const key = `${input.prefix}/${randomUUID()}`;
    const command = new PutObjectCommand({
      Bucket: env.R2_BUCKET,
      Key: key,
      ContentType: input.contentType,
    });
    const uploadUrl = await getSignedUrl(this.client, command, { expiresIn: 600 });
    const base = env.R2_PUBLIC_BASE_URL ?? `${env.R2_ENDPOINT}/${env.R2_BUCKET}`;
    return { key, uploadUrl, publicUrl: `${base}/${key}` };
  }

  async readObjectHead(
    key: string,
    maxBytes: number,
  ): Promise<{ head: ObjectHead; bytes: Buffer } | null> {
    try {
      const res = await this.client.send(
        new GetObjectCommand({
          Bucket: env.R2_BUCKET,
          Key: key,
          // Inclusive byte range, so the last index is one less than the count.
          Range: `bytes=0-${maxBytes - 1}`,
        }),
      );
      const bytes = Buffer.from(await res.Body!.transformToByteArray());
      /**
       * `ContentRange` reports the FULL object size (`bytes 0-N/total`) even though the body is
       * truncated; `ContentLength` on a ranged response is only the slice. Using the wrong one
       * would let an oversized upload pass a size check by being read in part.
       */
      const total = Number(res.ContentRange?.split('/')[1] ?? res.ContentLength ?? bytes.length);
      return {
        head: {
          sizeBytes: Number.isFinite(total) ? total : bytes.length,
          contentType: res.ContentType ?? null,
        },
        bytes,
      };
    } catch (err) {
      const name = (err as { name?: string }).name;
      if (name === 'NoSuchKey' || name === 'NotFound') return null;
      throw err;
    }
  }
}

let gateway: StorageGateway | null = null;

export function setStorageGateway(next: StorageGateway): void {
  gateway = next;
}

export function storage(): StorageGateway {
  gateway ??= new R2StorageGateway();
  return gateway;
}

const ALLOWED_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
/**
 * Print artwork is a narrower list than a photo upload, and deliberately so.
 *
 * `image/webp` and `image/heic` are absent because the print vendor does not accept them — offering
 * a format that fails at submission moves the rejection to after the money. `application/pdf` is
 * present because it is the best thing a designer can send: vector, exactly sized, resolution-free.
 *
 * SVG is excluded on purpose. It is an executable document (scripts, external entities), and there
 * is nothing a buyer can express in SVG that a PDF cannot carry.
 */
const ALLOWED_ARTWORK_TYPES = new Set(['image/jpeg', 'image/png', 'application/pdf']);
export function isAllowedArtworkType(contentType: string): boolean {
  return ALLOWED_ARTWORK_TYPES.has(contentType);
}
export function isAllowedImageType(contentType: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(contentType);
}

/**
 * §52 asks for a walk-round VIDEO on a condition report, which a still frame cannot replace. Kept
 * to the purposes that genuinely need it rather than opened globally: a review photo or a profile
 * picture has no business being a 400 MB upload, and widening the type list everywhere to satisfy
 * one surface is how storage bills and moderation queues get away from you.
 */
const ALLOWED_VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const VIDEO_ENABLED_PURPOSES = new Set(['rto_condition', 'dispute_evidence']);

export function isAllowedUploadType(purpose: string, contentType: string): boolean {
  // Artwork has its own, narrower list — a webp that the print vendor rejects is worse than a 400.
  if (purpose === 'postcard_artwork') return isAllowedArtworkType(contentType);
  if (isAllowedImageType(contentType)) return true;
  return VIDEO_ENABLED_PURPOSES.has(purpose) && ALLOWED_VIDEO_TYPES.has(contentType);
}
