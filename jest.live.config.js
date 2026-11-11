/** Live tests against the real OpenRouter API. Skipped automatically when OPENROUTER_API_KEY is not set. */
module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/test/live/**/*.live-spec.ts'],
  testTimeout: 300000,
};
