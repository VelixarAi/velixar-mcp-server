import { createRequire } from 'node:module';

/**
 * The server's version — derived, never typed by hand.
 *
 * It used to be typed by hand, in three places, and all three drifted:
 *
 *   package.json        1.2.0   <- what npm actually published
 *   src/server.ts       1.1.0   <- what serverInfo told every MCP host
 *   src/tools/system.ts 0.5.0   <- what velixar_capabilities/health reported
 *
 * So a host asking "what version am I talking to?" got 1.1.0 from a package that
 * was 1.2.0, and the capabilities tool said 0.5.0. A version number that can
 * disagree with itself is worse than no version number: it is trusted, and wrong.
 *
 * package.json is the only one npm enforces, so it is the source of truth and
 * everything else reads from it. `tests/version.test.js` fails the build if any
 * hardcoded version ever creeps back in.
 *
 * createRequire (not a JSON import) on purpose: package.json sits OUTSIDE rootDir,
 * and importing it would make tsc emit dist/src/** and break the bin path.
 * At runtime dist/version.js resolves ../package.json to the package root, which
 * npm always ships in the tarball.
 */
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string; name: string };

export const VERSION: string = pkg.version;
export const SERVER_NAME: string = pkg.name;
