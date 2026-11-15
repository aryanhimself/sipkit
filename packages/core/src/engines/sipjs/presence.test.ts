import { describe, expect, it, vi } from 'vitest';
import type { Notification } from 'sip.js';
import { createLogger } from '../../logger';
import { PresenceSubscriptions } from './presence';

function notification(body: string) {
  const accept = vi.fn(async () => undefined);
  const n = { request: { body, getHeader: () => undefined }, accept, reject: vi.fn() } as unknown as Notification;
  return { n, accept };
}

const logger = createLogger('test', { level: 'silent', console: false });
const host = { ua: () => undefined, domain: () => 'pbx' };

describe('sip.js presence subscriptions', () => {
  it('parses dialog-info and PIDF NOTIFYs and accepts them', () => {
    const onUpdate = vi.fn();
    const subs = new PresenceSubscriptions(host, logger, onUpdate);
    const dialog = notification(
      '<dialog-info xmlns="urn:ietf:params:xml:ns:dialog-info"><dialog id="1"><state>confirmed</state></dialog></dialog-info>',
    );
    subs.handleNotify('1002', 'dialog', dialog.n);
    expect(dialog.accept).toHaveBeenCalled();
    expect(onUpdate).toHaveBeenLastCalledWith({ target: '1002', event: 'dialog', report: { state: 'busy' } });
    subs.handleNotify('1002', 'presence', notification('<presence><tuple><status><basic>closed</basic></status></tuple></presence>').n);
    expect(onUpdate).toHaveBeenLastCalledWith({ target: '1002', event: 'presence', report: { state: 'unavailable' } });
    subs.handleNotify('1002', 'dialog', notification('').n);
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it('subscribe fails cleanly without a connected UserAgent', async () => {
    const subs = new PresenceSubscriptions(host, logger, vi.fn());
    await expect(subs.subscribe('1002', 'dialog', 600)).rejects.toThrow(/Not connected/);
    await expect(subs.unsubscribe('1002', 'dialog')).resolves.toBeUndefined();
    await expect(subs.unsubscribeAll()).resolves.toBeUndefined();
  });
});
