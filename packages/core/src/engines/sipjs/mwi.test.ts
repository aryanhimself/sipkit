import { describe, expect, it, vi } from 'vitest';
import type { Notification } from 'sip.js';
import { createLogger } from '../../logger';
import { MwiSubscription, isMessageSummaryNotify } from './mwi';

function notification(event: string, body: string) {
  const accept = vi.fn(async () => undefined);
  const n = {
    request: { body, getHeader: (name: string) => (name === 'Event' ? event : undefined) },
    accept,
    reject: vi.fn(async () => undefined),
  } as unknown as Notification;
  return { n, accept };
}

const logger = createLogger('test', { level: 'silent', console: false });
const host = {
  ua: () => undefined,
  domain: () => 'pbx',
  username: () => '1001',
  expires: () => 3600,
};

describe('sip.js MWI', () => {
  it('recognises the message-summary event package (with params, any case)', () => {
    expect(isMessageSummaryNotify(notification('message-summary', '').n)).toBe(true);
    expect(isMessageSummaryNotify(notification('Message-Summary;id=1', '').n)).toBe(true);
    expect(isMessageSummaryNotify(notification('presence', '').n)).toBe(false);
  });

  it('accepts unsolicited NOTIFYs and reports parsed summaries', () => {
    const onSummary = vi.fn();
    const mwi = new MwiSubscription(host, logger, onSummary);
    const { n, accept } = notification(
      'message-summary',
      'Messages-Waiting: yes\r\nVoice-Message: 1/0 (0/0)\r\n',
    );
    mwi.handleNotify(n);
    expect(accept).toHaveBeenCalled();
    expect(onSummary).toHaveBeenCalledWith({
      waiting: true,
      new: 1,
      old: 0,
      urgentNew: 0,
      urgentOld: 0,
    });
    mwi.handleNotify(notification('message-summary', '').n);
    expect(onSummary).toHaveBeenCalledTimes(1);
  });

  it('subscribe fails cleanly without a connected UserAgent', async () => {
    const mwi = new MwiSubscription(host, logger, vi.fn());
    await expect(mwi.subscribe()).rejects.toThrow(/Not connected/);
    await expect(mwi.unsubscribe()).resolves.toBeUndefined();
  });
});
