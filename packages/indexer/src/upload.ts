import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { Manifest } from '@totolo-search/core';

interface UploadParams {
  bucket: string;
  region: string;
  prefix: string;
  outDir: string;
  manifest: Manifest;
}

const ARTIFACTS = ['minisearch.json', 'corpus.json', 'embeddings.bin', 'embeddings-annotations.bin'] as const;
const CONTENT_TYPES: Record<string, string> = {
  'minisearch.json': 'application/json',
  'corpus.json': 'application/json',
  'embeddings.bin': 'application/octet-stream',
  'embeddings-annotations.bin': 'application/octet-stream',
  'latest.json': 'application/json',
};

export async function upload({ bucket, region, prefix, outDir, manifest }: UploadParams) {
  const s3 = new S3Client({ region });

  // Upload immutable artifacts to dated prefix
  for (const name of ARTIFACTS) {
    const body = await readFile(join(outDir, name));
    const key = `${prefix}/${name}`;
    console.log(`  Uploading s3://${bucket}/${key} (${(body.length / 1024).toFixed(0)} KB)`);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: CONTENT_TYPES[name],
      CacheControl: 'public, max-age=31536000, immutable',
    }));
  }

  // Update latest.json last (atomic flip)
  const manifestBody = Buffer.from(JSON.stringify({ ...manifest, index_prefix: `https://${bucket}.s3.${region}.amazonaws.com/${prefix}` }, null, 2), 'utf-8');
  console.log(`  Uploading s3://${bucket}/latest.json`);
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: 'latest.json',
    Body: manifestBody,
    ContentType: 'application/json',
    CacheControl: 'no-cache',
  }));
}
