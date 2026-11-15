/* global module, process */
/**
 * electron-builder configuration for the SipKit desktop app.
 * See docs/desktop.md ("Packaging, signing and notarization").
 *
 * Nothing secret lives here. Signing and notarization are driven entirely by
 * environment variables (CI secrets); without them the build is unsigned:
 *
 *   macOS signing      CSC_LINK (base64 .p12 or path/URL) + CSC_KEY_PASSWORD,
 *                      or CSC_NAME (identity already in the keychain).
 *                      CSC_IDENTITY_AUTO_DISCOVERY=false forces an unsigned build.
 *   macOS notarization APPLE_API_KEY (path to .p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER,
 *                      or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID.
 *                      Runs only when the app is signed and credentials are present.
 *   Windows signing    WIN_CSC_LINK + WIN_CSC_KEY_PASSWORD (or CSC_LINK/CSC_KEY_PASSWORD
 *                      on a Windows runner). EV / cloud HSM: see docs/desktop.md.
 *   Auto-update feed   SIPKIT_UPDATE_URL (https base URL of the generic feed). Written
 *                      to app-update.yml; omitted = auto-update off in that build.
 */
const hasAppleApiKey = Boolean(process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER);
const hasAppleId = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
const notarize = hasAppleApiKey || hasAppleId;
const updateUrl = process.env.SIPKIT_UPDATE_URL?.trim();

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.sipkit.phone',
  productName: 'SipKit',
  copyright: 'Copyright © sipkit contributors',
  directories: { output: 'dist/release', buildResources: 'build' },
  // Main/preload/renderer are fully bundled (electron.vite.config.ts): no node_modules.
  files: ['dist/main/**', 'dist/preload/**', 'dist/renderer/**', 'package.json', '!**/*.map'],
  npmRebuild: false,
  asar: true,
  // tel:, sip:, callto: (dialling) and sipkit: (notification actions).
  // macOS: CFBundleURLTypes in Info.plist. Windows: registered by the NSIS installer.
  protocols: [
    { name: 'Telephone link', schemes: ['tel', 'callto'] },
    { name: 'SIP link', schemes: ['sip', 'sips'] },
    { name: 'SipKit', schemes: ['sipkit'] },
  ],
  ...(updateUrl ? { publish: [{ provider: 'generic', url: updateUrl }] } : { publish: null }),
  mac: {
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      // The zip is what electron-updater downloads on macOS.
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    category: 'public.app-category.business',
    icon: 'build/icon.png',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize,
    extendInfo: {
      NSMicrophoneUsageDescription: 'The softphone needs the microphone for calls.',
      NSCameraUsageDescription: 'The softphone needs the camera for video calls.',
    },
  },
  dmg: { sign: false },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'build/icon.png',
    // Signing info comes from WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD.
    signtoolOptions: { publisherName: process.env.WIN_PUBLISHER_NAME || undefined },
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    shortcutName: 'SipKit',
    artifactName: 'SipKit-Setup-${version}.${ext}',
  },
  linux: { target: ['AppImage'], category: 'Office', icon: 'build/icon.png' },
  afterSign: 'build/after-sign.cjs',
};
