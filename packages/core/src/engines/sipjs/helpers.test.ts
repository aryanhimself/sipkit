import { describe, expect, it, vi } from 'vitest';
import { resolveConfig } from '../../config';
import {
  pickHeaders,
  abortableSleep,
  backoffDelayMs,
  buildTargetUri,
  dtmfRelayBody,
  hostOf,
  parseAutoAnswer,
  parseInfoDtmf,
  reasonFromCode,
  resolveSipDomain,
  sdpIndicatesHold,
  withTimeout,
} from './helpers';

describe('sip.js engine helpers', () => {
  it('extracts hosts', () => {
    expect(hostOf('pbx.local:5060')).toBe('pbx.local');
    expect(hostOf('sip:pbx.local:5080;transport=tcp')).toBe('pbx.local');
    expect(hostOf('[2001:db8::1]:5060')).toBe('[2001:db8::1]');
  });

  it('uses sipServer domain in sip-gateway mode only', () => {
    const base = { websocketUrls: ['wss://gw.example.com/ws'], sipServer: '10.0.0.5:5060' };
    expect(resolveSipDomain(resolveConfig(base))).toBe('gw.example.com');
    expect(resolveSipDomain(resolveConfig({ ...base, transportMode: 'sip-gateway' }))).toBe('10.0.0.5');
    expect(resolveSipDomain(resolveConfig({ ...base, sipServer: undefined, transportMode: 'sip-gateway' }))).toBe(
      'gw.example.com',
    );
  });

  it('builds target URIs', () => {
    expect(buildTargetUri('1002', 'pbx')).toBe('sip:1002@pbx');
    expect(buildTargetUri('*97#', 'pbx')).toBe('sip:*97%23@pbx');
    expect(buildTargetUri('bob@other', 'pbx')).toBe('sip:bob@other');
    expect(buildTargetUri('sips:bob@x', 'pbx')).toBe('sips:bob@x');
  });

  it('maps SIP codes to reasons', () => {
    expect(reasonFromCode(486)).toBe('busy');
    expect(reasonFromCode(600)).toBe('busy');
    expect(reasonFromCode(603)).toBe('rejected');
    expect(reasonFromCode(480)).toBe('no-answer');
    expect(reasonFromCode(487)).toBe('cancelled');
    expect(reasonFromCode(503)).toBe('failed');
    expect(reasonFromCode(undefined)).toBe('failed');
  });

  it('parses auto-answer headers', () => {
    const h = (headers: Record<string, string>) => (name: string) => headers[name];
    expect(parseAutoAnswer(h({}))).toBeUndefined();
    expect(parseAutoAnswer(h({ 'Call-Info': '<sip:pbx>;answer-after=3' }))).toBe(3);
    expect(parseAutoAnswer(h({ 'Alert-Info': '<http://x>;info=alert-autoanswer;delay=2' }))).toBe(2);
    expect(parseAutoAnswer(h({ 'Alert-Info': 'Auto Answer' }))).toBe(0);
    expect(parseAutoAnswer(h({ 'Alert-Info': '<http://x>;info=ring2' }))).toBeUndefined();
    expect(parseAutoAnswer(h({ 'Answer-Mode': 'Auto' }))).toBe(0);
    expect(parseAutoAnswer(h({ 'X-Answer-Mode': 'auto' }))).toBe(0);
    expect(parseAutoAnswer(h({ 'X-P-Auto-Answer': 'normal' }))).toBe(0);
    expect(parseAutoAnswer(h({ 'Auto-Answer': 'false' }))).toBeUndefined();
  });

  it('detects hold in SDP', () => {
    const sdp = (dir: string, c = '192.0.2.1') =>
      `v=0\r\no=- 1 1 IN IP4 ${c}\r\ns=-\r\nc=IN IP4 ${c}\r\nt=0 0\r\nm=audio 4000 RTP/AVP 0\r\na=${dir}\r\n`;
    expect(sdpIndicatesHold(sdp('sendonly'))).toBe(true);
    expect(sdpIndicatesHold(sdp('inactive'))).toBe(true);
    expect(sdpIndicatesHold(sdp('sendrecv'))).toBe(false);
    expect(sdpIndicatesHold(sdp('recvonly'))).toBe(false);
    expect(sdpIndicatesHold(sdp('sendrecv', '0.0.0.0'))).toBe(true);
    expect(sdpIndicatesHold('')).toBeUndefined();
  });

  it('parses INFO DTMF bodies', () => {
    expect(parseInfoDtmf('Signal=5\r\nDuration=160', 'application/dtmf-relay')).toBe('5');
    expect(parseInfoDtmf('Signal= #\r\n', 'application/dtmf-relay')).toBe('#');
    expect(parseInfoDtmf('a', 'application/dtmf')).toBe('A');
    expect(parseInfoDtmf('11', 'application/dtmf')).toBe('#');
    expect(parseInfoDtmf('hello', 'text/plain')).toBeUndefined();
    expect(parseInfoDtmf(undefined, undefined)).toBeUndefined();
    expect(dtmfRelayBody('7')).toBe('Signal=7\r\nDuration=160\r\n');
  });

  it('computes capped exponential backoff', () => {
    expect([1, 2, 3, 4, 10].map((a) => backoffDelayMs(a, 4))).toEqual([4000, 8000, 16000, 32000, 60000]);
  });

  it('withTimeout rejects late operations and clears its timer', async () => {
    vi.useFakeTimers();
    const slow = withTimeout<void>(() => undefined, 100, 'op');
    const assertion = expect(slow).rejects.toThrow(/op timed out/);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    await expect(withTimeout<number>((resolve) => resolve(1), 100, 'op')).resolves.toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it('abortableSleep rejects on abort', async () => {
    const ctrl = new AbortController();
    const p = abortableSleep(10_000, ctrl.signal);
    ctrl.abort();
    await expect(p).rejects.toThrow('aborted');
  });
});

describe('pickHeaders', () => {
  it('copies the asked-for INVITE headers by lower-cased name, trimmed and capped', () => {
    const headers: Record<string, string> = { 'X-Taskbirt-Call-Id': '  vc_123 ', 'X-Long': 'a'.repeat(300) };
    const get = (name: string) => headers[name];
    expect(pickHeaders(['X-Taskbirt-Call-Id', 'X-Missing', 'X-Long'], get)).toEqual({
      'x-taskbirt-call-id': 'vc_123',
      'x-long': 'a'.repeat(256),
    });
    expect(pickHeaders(['X-Missing'], get)).toBeUndefined();
    expect(pickHeaders([], get)).toBeUndefined();
  });
});
