import { defineConfig } from 'vite';

// Project page is served from https://lamellama.github.io/grave-grain/
// so production assets need the repo-name base. Dev server stays at '/'.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/grave-grain/' : '/',
  build: {
    target: 'ES2020',
  },
}));
