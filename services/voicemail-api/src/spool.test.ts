import { readdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { lockFolder } from './lock.js';
import { Spool, parseCallerId, parseMessageInfo } from './spool.js';
import { addMessage, tempSpool } from './test-utils.js';

let root: string;
let spool: Spool;

beforeEach(async () => {
  root = await tempSpool();
  spool = new Spool({ root, lock: { timeoutMs: 1000, retryMs: 5 } });
});

const files = async (folder: string, mailbox = '1002') =>
  (await readdir(join(root, 'default', mailbox, folder)).catch(() => [])).filter((f) => !f.startsWith('.')).sort();

describe('parsers', () => {
  it('parses msgNNNN.txt', () => {
    const info = parseMessageInfo(';\n[message]\ncallerid="Agent 1001" <1001>\norigtime=1794207189\nmsg_id=1-2\nflag=\n');
    expect(info).toEqual({ callerid: '"Agent 1001" <1001>', origtime: '1794207189', msg_id: '1-2', flag: '' });
  });

  it('parses caller ids', () => {
    expect(parseCallerId('"Agent 1001" <1001>')).toEqual({ name: 'Agent 1001', number: '1001' });
    expect(parseCallerId('Bob <+15551234>')).toEqual({ name: 'Bob', number: '+15551234' });
    expect(parseCallerId('<1003>')).toEqual({ number: '1003' });
    expect(parseCallerId('1004')).toEqual({ number: '1004' });
    expect(parseCallerId('Unknown')).toEqual({});
    expect(parseCallerId('Anonymous')).toEqual({ name: 'Anonymous' });
  });
});

describe('Spool', () => {
  it('lists INBOX, Urgent and Old newest first with metadata', async () => {
    await addMessage(root, '1002', { index: 0, origtime: 100, callerid: '"Ann" <1001>', duration: 4 });
    await addMessage(root, '1002', { index: 1, origtime: 300 });
    await addMessage(root, '1002', { folder: 'Old', index: 0, origtime: 200, formats: ['gsm'] });
    await addMessage(root, '1002', { folder: 'Urgent', index: 0, origtime: 50, msgId: null });
    const list = await spool.list('default', '1002');
    expect(list.map((m) => [m.id, m.folder, m.urgent, m.hasAudio])).toEqual([
      ['300-0001', 'new', false, true],
      ['200-0000', 'old', false, false],
      ['100-0000', 'new', false, true],
      ['Urgent-0000', 'new', true, true],
    ]);
    expect(list[2]).toMatchObject({ callerName: 'Ann', callerNumber: '1001', duration: 4, timestamp: 100_000, date: new Date(100_000).toISOString() });
  });

  it('returns an empty list for a mailbox without a spool directory', async () => {
    expect(await spool.list('default', '1009')).toEqual([]);
  });

  it('skips messages that are still being recorded (no .txt yet)', async () => {
    await addMessage(root, '1002', { index: 0 });
    await unlink(join(root, 'default/1002/INBOX/msg0000.txt'));
    expect(await spool.list('default', '1002')).toEqual([]);
  });

  it('marks read: moves to the next free Old slot and closes the INBOX gap', async () => {
    for (const i of [0, 1, 2]) await addMessage(root, '1002', { index: i, origtime: 100 + i });
    await addMessage(root, '1002', { folder: 'Old', index: 0, origtime: 50 });
    const msg = await spool.markRead('default', '1002', '101-0001');
    expect(msg).toMatchObject({ id: '101-0001', folder: 'old' });
    expect(await files('INBOX')).toEqual(['msg0000.gsm', 'msg0000.txt', 'msg0000.wav', 'msg0001.gsm', 'msg0001.txt', 'msg0001.wav']);
    expect(await files('Old')).toEqual(['msg0000.gsm', 'msg0000.txt', 'msg0000.wav', 'msg0001.gsm', 'msg0001.txt', 'msg0001.wav']);
    const list = await spool.list('default', '1002');
    expect(list.filter((m) => m.folder === 'new').map((m) => m.id).sort()).toEqual(['100-0000', '102-0002']);
    // The renumbered message keeps its id and audio.
    expect((await spool.audio('default', '1002', '102-0002'))?.path).toMatch(/INBOX\/msg0001\.wav$/);
    // Idempotent for an old message.
    expect(await spool.markRead('default', '1002', '101-0001')).toMatchObject({ folder: 'old' });
  });

  it('creates Old when missing', async () => {
    await addMessage(root, '1002', { index: 0, origtime: 100 });
    await spool.markRead('default', '1002', '100-0000');
    expect(await files('Old')).toEqual(['msg0000.gsm', 'msg0000.txt', 'msg0000.wav']);
    expect(await files('INBOX')).toEqual([]);
  });

  it('deletes every file of a message and resequences', async () => {
    for (const i of [0, 1, 2]) await addMessage(root, '1002', { index: i, origtime: 100 + i });
    expect(await spool.remove('default', '1002', '100-0000')).toBe(true);
    expect(await files('INBOX')).toEqual(['msg0000.gsm', 'msg0000.txt', 'msg0000.wav', 'msg0001.gsm', 'msg0001.txt', 'msg0001.wav']);
    expect((await spool.list('default', '1002')).map((m) => m.id).sort()).toEqual(['101-0001', '102-0002']);
    expect(await spool.remove('default', '1002', '100-0000')).toBe(false);
  });

  it('serialises concurrent changes on one mailbox', async () => {
    for (const i of [0, 1, 2, 3]) await addMessage(root, '1002', { index: i, origtime: 100 + i });
    await Promise.all([
      spool.markRead('default', '1002', '100-0000'),
      spool.remove('default', '1002', '101-0001'),
      spool.markRead('default', '1002', '102-0002'),
    ]);
    const list = await spool.list('default', '1002');
    expect(list.map((m) => [m.id, m.folder]).sort()).toEqual([
      ['100-0000', 'old'],
      ['102-0002', 'old'],
      ['103-0003', 'new'],
    ]);
    expect(await files('INBOX')).toEqual(['msg0000.gsm', 'msg0000.txt', 'msg0000.wav']);
  });

  it('waits for an Asterisk-held .lock and breaks stale ones', async () => {
    await addMessage(root, '1002', { index: 0, origtime: 100 });
    const inbox = join(root, 'default/1002/INBOX');
    const release = await lockFolder(inbox);
    let done = false;
    const p = spool.remove('default', '1002', '100-0000').then((r) => (done = r));
    await new Promise((r) => setTimeout(r, 60));
    expect(done).toBe(false);
    await release();
    await p;
    expect(done).toBe(true);

    // A lock left by a crashed holder is broken after staleMs.
    await addMessage(root, '1002', { index: 0, origtime: 200 });
    await writeFile(join(inbox, '.lock'), '1\n');
    const quick = new Spool({ root, lock: { timeoutMs: 2000, staleMs: 50, retryMs: 5 } });
    expect(await quick.remove('default', '1002', '200-0000')).toBe(true);
  });

  it('rejects traversal and odd names', async () => {
    for (const [ctx, box] of [
      ['default', '..'],
      ['..', '1002'],
      ['default', '../../etc'],
      ['default', '1002/INBOX'],
      ['default', ''],
      ['default', '.hidden'],
      ['def\0ault', '1002'],
    ]) {
      expect(() => spool.mailboxDir(ctx!, box!)).toThrow(/Invalid mailbox/);
    }
    await expect(spool.get('default', '1002', '../x')).rejects.toThrow(/Invalid message id/);
    expect(spool.mailboxDir('default', '1002')).toBe(join(spool.root, 'default', '1002'));
  });
});
