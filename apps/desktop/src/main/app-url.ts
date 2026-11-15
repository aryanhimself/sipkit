/** True for the app's own renderer: the built file:// page or the dev server. Pure, unit tested. */
export function isAppUrl(url: string, devServer: string | undefined): boolean {
  if (!url) return false;
  if (devServer) {
    try {
      if (new URL(url).origin === new URL(devServer).origin) return true;
    } catch {
      return false;
    }
  }
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'file:' && parsed.pathname.endsWith('/renderer/index.html');
  } catch {
    return false;
  }
}
