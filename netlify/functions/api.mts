// Netlify Functions v2 entry: every /api/* request goes through handleApi,
// backed by a site-scoped Netlify Blobs store (survives redeploys).
import { getStore } from '@netlify/blobs';
import type { Config } from '@netlify/functions';
import { analyse } from '../../src/core/agent';
import { handleApi } from '../../src/server/api';
import { BlobRunStore } from '../../src/server/store';

export default async (req: Request) =>
  handleApi(req, {
    store: new BlobRunStore(getStore({ name: 'rater-runs', consistency: 'strong' })),
    analyse,
  });

export const config: Config = { path: '/api/*' };
