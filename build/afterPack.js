/**
 * Ad-hoc sign the assembled macOS bundle.
 *
 * WHY: desktop.yml sets CSC_IDENTITY_AUTO_DISCOVERY=false because there is no
 * Developer ID certificate, and electron-builder then skips the signing step
 * ENTIRELY. The .app therefore ships carrying only the signature the linker put
 * on the stock Electron binary, which is invalid for a bundle that has since
 * been rewritten:
 *
 *     Identifier=Electron              (not com.pumpfun.sniperbot)
 *     Info.plist=not bound
 *     codesign --verify: "code has no resources but signature indicates they
 *                         must be present"
 *
 * Gatekeeper reports a BROKEN signature as "the application is damaged and
 * can't be opened. You should move it to the Trash" — which is what v2.0.6's
 * .dmg did on a clean Mac, and it reads to users as a corrupt download rather
 * than a signing problem. Removing the quarantine attribute alone does not fix
 * it, because the signature itself fails verification.
 *
 * An ad-hoc signature is not notarization and does not remove the
 * unidentified-developer prompt, but it makes the bundle VALID, which is the
 * difference between "damaged, move to trash" and an app the user can open.
 * arm64 also refuses to execute a completely unsigned binary at all.
 */
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  // Fail the BUILD rather than ship another "damaged" download: if this does
  // not verify, the artifact is not installable and publishing it wastes a
  // release plus everyone's download.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`[afterPack] ad-hoc signed and verified ${appName}`);
};
