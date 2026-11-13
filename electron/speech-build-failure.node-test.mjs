import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

// speech.mjs in development (not packaged), its helper build replaced by one that fails.
const source = `
  import { registerHooks } from 'node:module';
  const moduleURL = text => 'data:text/javascript,' + encodeURIComponent(text);
  registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/speech.mjs')) {
      if (specifier === 'electron') return { shortCircuit: true, url: moduleURL(
        'export const app = { isPackaged: false, getPath: () => process.cwd() };') };
      if (specifier === './build-speech-helper.mjs') return { shortCircuit: true, url: moduleURL(\`
        export const speechHelperBundle = '/nonexistent/OpenMausBot Speech.app';
        export const speechHelperBinary = '/nonexistent/OpenMausBot Speech.app/Contents/MacOS/speech-helper';
        export const speechHelperBuildInputs = [];
        export function buildSpeechHelper() { throw new Error('swiftc exited with status 1'); }
      \`) };
    }
    return next(specifier, context);
  } });
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  const { startSpeech, speechBusy } = await import(${JSON.stringify(new URL("./speech.mjs", import.meta.url).href)});
  const ends = [];
  startSpeech({ transcript() {}, end: info => ends.push(info), replaced() {} });
  process.stdout.write(JSON.stringify({ ends, busy: speechBusy() }));
`;

test("a helper that cannot be built says why in the log and ends the session as a build failure", () => {
  const run = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8", timeout: 20_000 });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { ends: [{ code: 1, reason: "helper-build-failed" }], busy: false });
  assert.match(run.stderr, /\[speech\] helper build failed: swiftc exited with status 1/);
});
