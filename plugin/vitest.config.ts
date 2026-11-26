import { availableParallelism } from 'node:os'
import { configDefaults, defineConfig } from 'vitest/config'
import { parseCLI } from 'vitest/node'

// Share one React instance across DSH client packages and tests; exclude the POSIX-only fcntl service script suite on Windows.
export default defineConfig({
  plugins: [{
    name: 'require-filtered-tests',
    configureVitest({ vitest }) {
      if (vitest.config.watch) return
      const { filter, options } = parseCLI(['vitest', ...process.argv.slice(2)])
      if (!filter.length && options.testNamePattern === undefined) return
      // Append after Vitest resolves reporters so --reporter can't replace this check.
      vitest.config.reporters.push({
        onTestRunEnd(modules, _errors, reason) {
          if (reason !== 'passed' || process.exitCode || modules.some(module => !module.children.allTests('passed').next().done)) return
          console.error('[test] The explicit test filter ran no tests.')
          process.exitCode = 1
        },
      })
    },
  }],
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
