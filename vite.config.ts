import react from '@vitejs/plugin-react';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';

/** Dev-only: serve /api/* from handleApi + FsRunStore (./.data), so no netlify-cli is needed. */
function devApi(): Plugin {
  return {
    name: 'dev-api',
    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url?.startsWith('/api')) return next();
        try {
          // Loaded per request through Vite so edits to the server or engine apply without a restart.
          // The engine is loaded only when an analysis runs, so history and uploads keep working while it is mid-edit.
          const [{ handleApi }, { FsRunStore }] = await Promise.all([
            server.ssrLoadModule('/src/server/api.ts'),
            server.ssrLoadModule('/src/server/store.ts'),
          ]);
          const analyse = async (...args: unknown[]) => (await server.ssrLoadModule('/src/core/agent.ts')).analyse(...args);
          const body: Buffer[] = [];
          for await (const part of req) body.push(part as Buffer);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
          const request = new Request(new URL(req.url, 'http://localhost'), {
            method: req.method,
            headers,
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(body),
          });
          const response: Response = await handleApi(request, { store: new FsRunStore(), analyse });
          res.statusCode = response.status;
          response.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await response.arrayBuffer()));
        } catch (e) {
          server.ssrFixStacktrace(e as Error);
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: String((e as Error).message ?? e) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devApi()],
  // The four sample policies are served from the site root, so "Try sample" on the home screen runs the real upload flow.
  publicDir: 'sample-policies',
});
