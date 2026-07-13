/**
 * Jest configuration (committed — previously this file was gitignored, so a fresh
 * checkout / CI had no ts-jest transform and `npm test` reported "0 tests" while
 * failing to parse the TypeScript suites under test/).
 *
 * @type {import('ts-jest').JestConfigWithTsJest}
 */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  // isolatedModules: transpile each test file (no full type-check) so the suites
  // run without needing @types/jest wired into tsconfig's `types`. Full project
  // typing is enforced separately by the CI `tsc --noEmit` step. (ts-jest 29 emits
  // a deprecation notice for this key; harmless, and it keeps `npm test` green
  // without touching the shared tsconfig.)
  transform: {
    '^.+\\.ts$': ['ts-jest', { isolatedModules: true }],
  },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  clearMocks: true,
};
