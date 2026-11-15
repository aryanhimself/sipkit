/* global exports, process, console */
/**
 * electron-builder afterSign hook. Notarization itself is done by
 * electron-builder (`mac.notarize`, enabled in electron-builder.config.cjs when
 * Apple credentials are in the environment). This hook only reports what
 * happened, so an unsigned / un-notarized CI build is obvious in the logs, and
 * is the place for extra post-sign steps (e.g. stapling checks).
 */
exports.default = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;
  const signed = Boolean(process.env.CSC_LINK || process.env.CSC_NAME) && process.env.CSC_IDENTITY_AUTO_DISCOVERY !== 'false';
  const creds =
    Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER) ||
    Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
  if (!signed) console.log(`  • afterSign: ${appOutDir} is NOT signed (no CSC_LINK/CSC_NAME): not notarized`);
  else if (!creds) console.log('  • afterSign: signed, but no Apple notarization credentials: not notarized');
  else console.log('  • afterSign: signed; electron-builder notarizes with the Apple credentials from the environment');
};
