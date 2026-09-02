import { defineConfig } from 'vite';

// GitHub Pages serves a project site from /<repo>/, so every built asset
// path must be prefixed with the repo name. Locally this stays '/'.
const base = process.env.GITHUB_PAGES ? '/nullrun/' : '/';

export default defineConfig({
  base,
});
