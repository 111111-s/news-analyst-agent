/** Live tests against the real OpenRouter API. Skipped automatically when OPENROUTER_API_KEY is not set. */

// Load .env here, in the parent process: Jest gives each test file a sandboxed copy of process.env,
// so loading it from inside a test would not be visible to the test itself.
try {
  process.loadEnvFile();
} catch {
  /* no .env - live tests will be skipped */
}

module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }] },
  moduleFileExtensions: ['ts', 'js', 'json'],
  testMatch: ['<rootDir>/test/live/**/*.live-spec.ts'],
  testTimeout: 300000,
};
