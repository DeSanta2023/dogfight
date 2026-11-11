import { defineConfig } from 'vite';
import { devApi } from './tools/dev-api.js';

// In development the game server (npm run dev:server) listens on its own port. The browser only
// talks to Vite, so /api and /ws are proxied: same origin, no CORS, and the client code uses the
// same relative URLs in dev and in production (where the server serves client/dist itself).
const target = process.env.SERVER_URL ?? 'http://localhost:3000';

const proxy = {
  '/api': target,
  '/health': target,
  '/ws': { target, ws: true },
};

export default defineConfig({
  plugins: [devApi()],
  server: { proxy },
  preview: { proxy },
});
