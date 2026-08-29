/**
 * AUTO-UPDATE GATE PROOFS.
 *
 * The background updater replaces the running binary and relaunches it, so the
 * gate deciding whether this process is allowed to do that at all is worth a
 * transcript: the Electron build must never run it (electron-updater owns that
 * path, and two updaters racing to replace one app is how you get a half-written
 * exe), and the opt-out must actually opt out.
 *
 * Run: ts-node src/tests/autoUpdateProofs.ts
 *
 * Pure in-memory. No network, no wallet, no RPC.
 */

import assert from 'assert';
import { autoUpdateEnabled, releaseAssetName } from '../services/updaterService';

let passed = 0;
let failed = 0;

function proof(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FAIL  ${name}\n        ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log('\nAUTO-UPDATE GATE\n');

proof('a standalone binary self-updates', () => {
  assert.strictEqual(autoUpdateEnabled({}), true);
});

proof('the Electron build does not — electron-updater owns it', () => {
  assert.strictEqual(autoUpdateEnabled({ SNIPER_PACKAGED: '1' }), false);
});

proof('SNIPER_NO_AUTO_UPDATE opts out', () => {
  for (const v of ['1', 'true', 'TRUE', 'on', 'yes']) {
    assert.strictEqual(autoUpdateEnabled({ SNIPER_NO_AUTO_UPDATE: v }), false, `expected ${v} to opt out`);
  }
});

proof('an unset or falsy opt-out leaves it on', () => {
  for (const v of ['0', 'false', 'off', 'no', '']) {
    assert.strictEqual(autoUpdateEnabled({ SNIPER_NO_AUTO_UPDATE: v }), true, `expected ${v} to stay enabled`);
  }
});

proof('the opt-out wins even inside the Electron build', () => {
  assert.strictEqual(autoUpdateEnabled({ SNIPER_PACKAGED: '1', SNIPER_NO_AUTO_UPDATE: '1' }), false);
});

console.log('\nPLATFORM ASSET — what a self-update would download\n');

proof('each platform claims its own asset, never another', () => {
  assert.strictEqual(releaseAssetName('win32', 'x64'), 'pumpfun-sniper-bot.exe');
  assert.strictEqual(releaseAssetName('darwin', 'arm64'), 'pumpfun-sniper-bot-macos-arm64');
  assert.strictEqual(releaseAssetName('darwin', 'x64'), 'pumpfun-sniper-bot-macos-x64');
  assert.notStrictEqual(releaseAssetName('darwin', 'arm64'), releaseAssetName('win32', 'x64'));
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
