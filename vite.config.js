import { defineConfig } from 'vite';
import { devApi } from './tools/dev-api.js';

export default defineConfig({
  plugins: [devApi()],
});
