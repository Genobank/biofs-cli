import {
  encryptBoundToObjectKey,
  encryptToRecipientKeys,
  decryptWithReleasedKey,
  Crypt4ghBindError,
} from '../src/lib/crypt4gh/bind';
import { generateKeyPair, decrypt } from '../src/lib/crypt4gh';

describe('crypt4gh BioNFT bind helpers', () => {
  it('encrypts to a node-style public key and decrypts with the released secret', () => {
    const objectKey = generateKeyPair();
    const plain = Buffer.from('cli-bound-payload');
    const ct = encryptToRecipientKeys(plain, [objectKey.publicKey]);
    expect(decryptWithReleasedKey(ct, objectKey.secretKey).equals(plain)).toBe(true);
  });

  it('refuses encrypt with no recipients', () => {
    expect(() => encryptToRecipientKeys(Buffer.from('x'), [])).toThrow(Crypt4ghBindError);
  });

  it('local object-key helper still round-trips for tests', () => {
    const extra = generateKeyPair();
    const bound = encryptBoundToObjectKey(Buffer.from('y'), [extra.publicKey]);
    expect(decrypt(bound.ciphertext, bound.secretKey).equals(Buffer.from('y'))).toBe(true);
    expect(decrypt(bound.ciphertext, extra.secretKey).equals(Buffer.from('y'))).toBe(true);
  });
});
