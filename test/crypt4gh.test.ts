import {
  generateKeyPair,
  encrypt,
  decrypt,
  isCrypt4gh,
  inspect,
  serializePublicKeyPem,
  serializePrivateKeyPem,
  loadPublicKey,
  loadPrivateKey,
  MAGIC,
  PLAIN_SEGMENT,
} from '../src/lib/crypt4gh';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('GA4GH crypt4gh v1', () => {
  it('round-trips synthetic bytes', () => {
    const rec = generateKeyPair();
    const plain = Buffer.from('BioFS crypt4gh synthetic payload\n');
    const c4gh = encrypt(plain, [rec.publicKey]);
    expect(isCrypt4gh(c4gh)).toBe(true);
    expect(c4gh.subarray(0, 8).equals(MAGIC)).toBe(true);
    expect(inspect(c4gh).version).toBe(1);
    expect(decrypt(c4gh, rec.secretKey).equals(plain)).toBe(true);
  });

  it('refuses a different reader secret', () => {
    const rec = generateKeyPair();
    const other = generateKeyPair();
    const c4gh = encrypt(Buffer.from('x'), [rec.publicKey]);
    expect(() => decrypt(c4gh, other.secretKey)).toThrow(/No crypt4gh header packet decrypted/);
  });

  it('encrypts past a 64 KiB segment', () => {
    const rec = generateKeyPair();
    const plain = Buffer.alloc(PLAIN_SEGMENT + 9, 7);
    expect(decrypt(encrypt(plain, [rec.publicKey]), rec.secretKey).equals(plain)).toBe(true);
  });

  it('loads PEM keys it wrote', () => {
    const rec = generateKeyPair();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4gh-cli-'));
    const pk = path.join(dir, 'r.pub');
    const sk = path.join(dir, 'r.sk');
    fs.writeFileSync(pk, serializePublicKeyPem(rec.publicKey));
    fs.writeFileSync(sk, serializePrivateKeyPem(rec.secretKey), { mode: 0o600 });
    expect(loadPublicKey(pk).equals(rec.publicKey)).toBe(true);
    expect(loadPrivateKey(sk).equals(rec.secretKey)).toBe(true);
  });
});
