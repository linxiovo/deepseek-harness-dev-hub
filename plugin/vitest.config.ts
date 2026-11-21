import { availableParallelism } from 'node:os'
import { configDefaults, defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests; exclude the POSIX-only fcntl service script suite on Windows.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    // Limit concurrent native Git fixtures on Windows without changing the deadlines.
    ...(process.platform === 'win32' ? { maxWorkers: Math.min(4, availableParallelism()), testTimeout: 20_000, hookTimeout: 30_000 } : {}),
    include: ['tests/**/*.spec.{ts,tsx}'],
    exclude: [
      ...configDefaults.exclude,
      ...(process.platform === 'win32' ? ['tests/service-script.spec.ts'] : []),
    ],
  },
})
