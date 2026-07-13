// Single source of truth for the CLI version: package.json.
// Fixes the drift where index.ts hardcoded '3.14.0', errorReporter '3.0.1' and
// score-protein '3.7.0' while package.json said 3.15.0 — so `biofs --version`,
// crash reports and result metadata now always agree with the published package.
// require() (not import) so tsc's rootDir:./src is not violated by a JSON file
// that lives outside src; it resolves ../package.json relative to dist/ at runtime
// (both in dev and in the published node_modules layout).
// eslint-disable-next-line @typescript-eslint/no-var-requires
export const BIOFS_VERSION: string = ((): string => {
  try {
    return String(require('../package.json').version || '0.0.0');
  } catch {
    return '0.0.0';
  }
})();
