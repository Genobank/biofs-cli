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
  // ts-jest transforms the TS suites. Full project typing is enforced separately
  // by the CI `tsc --noEmit` step, so keep the transform config minimal here.
  transform: {
    '^.+\\.ts$': ['ts-jest', {}],
  },
  moduleFileExtensions: ['ts', 'js', 'json', 'node'],
  clearMocks: true,
};
