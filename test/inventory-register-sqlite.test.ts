/**
 * inventory-register-sqlite: gs:// hashing by stream (no local copy)
 */
import { EventEmitter } from 'events';
import * as crypto from 'crypto';

const spawnMock = jest.fn();
jest.mock('child_process', () => ({ spawn: (...args: any[]) => spawnMock(...args) }));

import { streamHashGcs } from '../src/commands/inventory-register-sqlite';

function fakeChild(chunks: Buffer[], exitCode: number, stderr = '') {
  const child: any = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    chunks.forEach((c) => child.stdout.emit('data', c));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode);
  });
  return child;
}

describe('streamHashGcs', () => {
  beforeEach(() => spawnMock.mockReset());

  it('hashes and counts the streamed bytes exactly', async () => {
    const parts = [Buffer.from('abc'), Buffer.from('defg'), Buffer.alloc(1000, 7)];
    spawnMock.mockReturnValue(fakeChild(parts, 0));
    const r = await streamHashGcs('gs://bucket/obj.sqlite');
    expect(r.size).toBe(3 + 4 + 1000);
    expect(r.sha256).toBe(crypto.createHash('sha256').update(Buffer.concat(parts)).digest('hex'));
    expect(spawnMock.mock.calls[0][0]).toBe('gcloud');
    expect(spawnMock.mock.calls[0][1]).toEqual(['storage', 'cat', 'gs://bucket/obj.sqlite']);
  });

  it('fails loud on a non-zero exit', async () => {
    spawnMock.mockReturnValue(fakeChild([], 1, 'not found'));
    await expect(streamHashGcs('gs://bucket/missing')).rejects.toThrow(/failed \(exit 1\)/);
  });

  it('fails loud on an empty object', async () => {
    spawnMock.mockReturnValue(fakeChild([], 0));
    await expect(streamHashGcs('gs://bucket/empty')).rejects.toThrow(/0 bytes/);
  });
});
