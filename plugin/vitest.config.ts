import { availableParallelism } from 'node:os'
import { configDefaults, defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests; exclude the POSIX-only fcntl service script suite on Windows.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    // Native Git fixtures compete for process and filesystem capacity on Windows runners.
    ...(process.platform === 'win32' ? { maxWorkers: Math.min(2, availableParallelism()), testTimeout: 45_000, hookTimeout: 30_000 } : {}),
    include: ['tests/**/*.spec.{ts,tsx}'],
    exclude: [
      ...configDefaults.exclude,
      ...(process.platform === 'win32' ? ['tests/service-script.spec.ts'] : []),
    ],
  },
})
