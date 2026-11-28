import {defineConfig} from 'vitest/config';

export default defineConfig({
  // Keep Rust compiler output visible in the terminal.
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: 5173, // must match devUrl in src-tauri/tauri.conf.json
    strictPort: true,
    // Don't watch the Rust side: Cargo's build output there is locked while being written, which crashes the watcher
    // on Windows, and changes there are Tauri's job to pick up anyway.
    watch: {ignored: ['**/src-tauri/**']},
  },
  // Unit tests (`pnpm test:unit`): plain Node, no browser. Acceptance tests run separately through Playwright.
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // Test code, and the parts that need a real browser (covered by the acceptance tests instead).
      exclude: ['src/**/*.test.ts', 'src/**/*.d.ts', 'src/testing/**', 'src/main.ts', 'src/app.ts', 'src/backend.ts', 'src/ui/**', 'src/editor/view.ts', 'src/editor/scene-editor.ts', 'src/checking/checker.ts'],
      reporter: ['text', 'html'],
    },
  },
});
