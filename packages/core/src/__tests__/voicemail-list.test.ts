import { describe, expect, it, vi } from 'vitest';
import { createMockVoicemailBackend, createTestSoftphone } from '../testing';
import { VoicemailApiError, VoicemailClient } from '../voicemail-list';
import type { VoicemailListState } from '../types';

const API = { baseUrl: 'https://pbx.test/vm/', token: 'tok' };

function client(backend = createMockVoicemailBackend([{ callerNumber: '1002' }, { callerNumber: '1003', callerName: 'Bob' }])) {
  return { backend, vm: new VoicemailClient({ ...API, mailbox: '1001', fetch: backend.fetch }) };
}

describe('VoicemailClient', () => {
  it('lists newest first and tracks status + counts', async () => {
    const { vm, backend } = client();
    const states: VoicemailListState['status'][] = [];
    vm.subscribe((s) => states.push(s.status));
    const list = await vm.list();
    expect(list.map((m) => m.callerNumber)).toEqual(['1003', '1002']);
    expect(vm.getSnapshot()).toMatchObject({ status: 'ready', counts: { new: 2, old: 0 } });
    expect(states).toEqual(['loading', 'ready']);
    expect(backend.requests).toEqual(['GET /vm/v1/mailboxes/1001/messages']);
  });

  it('marks read, deletes and fetches audio with the bearer token', async () => {
    const backend = createMockVoicemailBackend([{ callerNumber: '1002' }], { token: 'tok' });
    const { vm } = client(backend);
    const [msg] = await vm.list();
    await vm.markRead(msg!.id);
    expect(vm.getSnapshot().messages[0]).toMatchObject({ id: msg!.id, folder: 'old' });
    expect(vm.getSnapshot().counts).toEqual({ new: 0, old: 1 });
    const blob = await vm.fetchAudio(msg!.id);
    expect(blob.type).toBe('audio/wav');
    expect(new TextDecoder().decode((await blob.arrayBuffer()).slice(0, 4))).toBe('RIFF');
    await vm.delete(msg!.id);
    expect(vm.getSnapshot().messages).toEqual([]);
    expect(backend.counts()).toEqual({ new: 0, old: 0 });
    expect(vm.getSnapshot().pending).toEqual([]);
  });

  it('builds encoded URLs, optionally with an access token', async () => {
    const vm = new VoicemailClient({ baseUrl: 'https://x.test/', mailbox: '1001@sales', token: 't k' });
    expect(await vm.audioUrl('1-2')).toBe('https://x.test/v1/mailboxes/1001%40sales/messages/1-2/audio');
    expect(await vm.audioUrl('1-2', { withToken: true })).toBe(
      'https://x.test/v1/mailboxes/1001%40sales/messages/1-2/audio?access_token=t%20k',
    );
  });

  it('maps failures to error codes and keeps stale messages', async () => {
    const { vm, backend } = client();
    await vm.list();
    backend.failNext(500);
    await expect(vm.list()).rejects.toMatchObject({ code: 'http', status: 500 });
    expect(vm.getSnapshot()).toMatchObject({ status: 'error', error: 'http' });
    expect(vm.getSnapshot().messages).toHaveLength(2);
    backend.failNext(403);
    await expect(vm.markRead(vm.getSnapshot().messages[0]!.id)).rejects.toBeInstanceOf(VoicemailApiError);
    const net = new VoicemailClient({ ...API, mailbox: '1001', fetch: () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(net.list()).rejects.toMatchObject({ code: 'network' });
  });

  it('refreshes a rejected getToken() token once', async () => {
    const backend = createMockVoicemailBackend([{}], { token: 'fresh' });
    const getToken = vi.fn().mockResolvedValueOnce('stale').mockResolvedValue('fresh');
    const vm = new VoicemailClient({ baseUrl: 'https://x.test', mailbox: '1001', getToken, fetch: backend.fetch });
    await expect(vm.list()).resolves.toHaveLength(1);
    expect(getToken).toHaveBeenCalledTimes(2);
    await vm.list();
    expect(getToken).toHaveBeenCalledTimes(2); // cached
  });

  it('treats an already deleted message as deleted', async () => {
    const { vm, backend } = client();
    const [a] = await vm.list();
    await backend.fetch(`https://x/v1/mailboxes/1001/messages/${a!.id}`, { method: 'DELETE' });
    await vm.delete(a!.id);
    expect(vm.getSnapshot().messages.map((m) => m.id)).not.toContain(a!.id);
  });
});

describe('Softphone voicemail list', () => {
  it('is disabled without voicemail.api', async () => {
    const { softphone } = await createTestSoftphone({ config: { voicemail: { enabled: true } } });
    expect(softphone.getSnapshot().voicemailList?.status).toBe('disabled');
    await expect(softphone.refreshVoicemails()).rejects.toMatchObject({ code: 'NOT_SUPPORTED' });
  });

  it('loads after registering, reloads on MWI changes, and emits voicemail:list', async () => {
    const backend = createMockVoicemailBackend([{ callerNumber: '1002' }]);
    const { softphone, engine } = await createTestSoftphone({
      config: { voicemail: { enabled: true, api: API } },
      voicemailFetch: backend.fetch,
    });
    const events: string[] = [];
    softphone.on('voicemail:list', ({ list }) => events.push(list.status));
    await vi.waitFor(() => expect(softphone.getSnapshot().voicemailList?.status).toBe('ready'));
    expect(softphone.getSnapshot().voicemailList?.messages).toHaveLength(1);
    // Mailbox defaults to the SIP username.
    expect(backend.requests[0]).toBe('GET /vm/v1/mailboxes/1001/messages');

    backend.add({ callerNumber: '1003' });
    engine.simulateMessageSummary({ waiting: true, new: 2, old: 0 });
    await vi.waitFor(() => expect(softphone.getSnapshot().voicemailList?.messages).toHaveLength(2));
    expect(events).toContain('loading');

    const id = softphone.getSnapshot().voicemailList!.messages[0]!.id;
    await softphone.markVoicemailRead(id);
    expect(softphone.getSnapshot().voicemailList?.counts).toEqual({ new: 1, old: 1 });
    await softphone.deleteVoicemail(id);
    expect(softphone.getSnapshot().voicemailList?.messages).toHaveLength(1);
    expect((await softphone.getVoicemailAudio(softphone.getSnapshot().voicemailList!.messages[0]!.id)).size).toBeGreaterThan(44);
  });

  it('follows config changes (mailbox, disable)', async () => {
    const backend = createMockVoicemailBackend([{}]);
    const { softphone } = await createTestSoftphone({
      config: { voicemail: { enabled: true, api: API } },
      voicemailFetch: backend.fetch,
    });
    await vi.waitFor(() => expect(softphone.getSnapshot().voicemailList?.status).toBe('ready'));
    await softphone.updateConfig({ voicemail: { enabled: true, api: { ...API, mailbox: '2001@desk' } } });
    await softphone.refreshVoicemails();
    expect(backend.requests.at(-1)).toBe('GET /vm/v1/mailboxes/2001%40desk/messages');
    await softphone.updateConfig({ voicemail: { enabled: false } });
    expect(softphone.getSnapshot().voicemailList).toMatchObject({ status: 'disabled', messages: [] });
  });
});
