/** Default test run: unit + integration (offline, deterministic, no network, no API key). */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/test/unit/**/*.spec.ts', '<rootDir>/test/integration/**/*.e2e-spec.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts', '!src/cli.ts', '!src/scripts/**'],
  coverageReporters: ['text-summary', 'lcov'],
};
