import { configDefaults, defineConfig } from 'vitest/config'
// Share one React instance across DSH client packages and tests; exclude the POSIX-only fcntl service script suite on Windows.
export default defineConfig({
  resolve: { dedupe: ['react', 'react-dom'] },
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    exclude: [
      ...configDefaults.exclude,
      ...(process.platform === 'win32' ? ['tests/service-script.spec.ts'] : []),
    ],
  },
})
