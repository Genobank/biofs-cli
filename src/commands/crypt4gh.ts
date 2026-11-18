/**
 * `biofs crypt4gh` — GA4GH crypt4gh v1 envelope paired with BioNFT rights.
 *
 * Bound (default for vault objects):
 *   biofs crypt4gh encrypt --serial 4122… -i local.bin -o local.bin.c4gh
 *   biofs crypt4gh decrypt --serial 4122… -i local.bin.c4gh -o local.bin
 *   biofs crypt4gh revoke  --serial 4122…
 *
 * Unbound EGA interop (explicit):
 *   biofs crypt4gh encrypt --allow-unbound --recipient-pk r.pub -i in -o out
 *   biofs crypt4gh decrypt --allow-unbound --sk r.sk -i in -o out
 */
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../lib/utils/logger';
import {
  generateKeyPair,
  serializePublicKeyPem,
  serializePrivateKeyPem,
  loadPublicKey,
  loadPrivateKey,
  encrypt,
  decrypt,
  inspect,
  isCrypt4gh,
} from '../lib/crypt4gh';
import {
  Crypt4ghBindError,
  requireBioNftAccess,
  encryptToRecipientKeys,
  decryptWithReleasedKey,
  ensureEnvelopeOnNode,
  releaseKeyFromNode,
  revokeEnvelopeOnNode,
} from '../lib/crypt4gh/bind';

function readInput(inputPath?: string): Buffer {
  if (!inputPath || inputPath === '-') return fs.readFileSync(0);
  return fs.readFileSync(inputPath);
}

function writeOutput(buf: Buffer, outputPath?: string): void {
  if (!outputPath || outputPath === '-') {
    fs.writeSync(1, buf);
    return;
  }
  fs.writeFileSync(outputPath, buf);
}

function failBind(e: unknown): never {
  const err = e as Crypt4ghBindError;
  Logger.error(err?.message || String(e));
  process.exit(err?.code === 'DENIED' || err?.code === 'UNAUTHENTICATED' ? 3 : 6);
}

export async function crypt4ghKeygenCommand(opts: { out?: string } = {}): Promise<void> {
  const dir = path.resolve(opts.out || path.join(process.env.HOME || '.', '.biofs', 'crypt4gh'));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const kp = generateKeyPair();
  const pkPath = path.join(dir, 'recipient.pub');
  const skPath = path.join(dir, 'recipient.sk');
  fs.writeFileSync(pkPath, serializePublicKeyPem(kp.publicKey), { mode: 0o644 });
  fs.writeFileSync(skPath, serializePrivateKeyPem(kp.secretKey), { mode: 0o600 });
  Logger.success(`crypt4gh X25519 keypair written (extra GA4GH recipient, not a BioNFT)`);
  console.log(`  public:  ${pkPath}`);
  console.log(`  secret:  ${skPath}`);
}

export async function crypt4ghEncryptCommand(opts: {
  recipientPk?: string;
  input?: string;
  output?: string;
  serial?: string;
  allowUnbound?: boolean;
}): Promise<void> {
  const plain = readInput(opts.input);
  if (opts.serial) {
    let session;
    try {
      session = await requireBioNftAccess(opts.serial);
    } catch (e) {
      failBind(e);
    }
    try {
      const env = await ensureEnvelopeOnNode({
        serial: opts.serial,
        wallet: session.wallet,
        signature: session.signature,
      });
      const objectPk = Buffer.from(String(env.public_key_hex), 'hex');
      const extra = opts.recipientPk ? [loadPublicKey(opts.recipientPk)] : [];
      const out = encryptToRecipientKeys(plain, [objectPk, ...extra]);
      writeOutput(out, opts.output);
      Logger.success(`crypt4gh envelope bound to BioNFT serial ${opts.serial} (${env.status})`);
    } catch (e) {
      failBind(e);
    }
    return;
  }
  if (!opts.allowUnbound) {
    Logger.error('Encrypting a vault object needs --serial <biosample> so BioNFT can gate the reader key. For EGA-only files use --allow-unbound --recipient-pk.');
    process.exit(2);
  }
  if (!opts.recipientPk) {
    Logger.error('--allow-unbound requires --recipient-pk');
    process.exit(2);
  }
  const out = encrypt(plain, [loadPublicKey(opts.recipientPk)]);
  writeOutput(out, opts.output);
  if (opts.output && opts.output !== '-') {
    Logger.success(`unbound crypt4gh v1 envelope written (${out.length} bytes)`);
  }
}

export async function crypt4ghDecryptCommand(opts: {
  sk?: string;
  input?: string;
  output?: string;
  serial?: string;
  allowUnbound?: boolean;
}): Promise<void> {
  const ct = readInput(opts.input);
  if (opts.serial) {
    let session;
    try {
      session = await requireBioNftAccess(opts.serial);
    } catch (e) {
      failBind(e);
    }
    try {
      const rel = await releaseKeyFromNode({
        serial: opts.serial,
        wallet: session.wallet,
        signature: session.signature,
      });
      const out = decryptWithReleasedKey(ct, Buffer.from(rel.secret_key_hex, 'hex'));
      writeOutput(out, opts.output);
      Logger.success(`decrypted under BioNFT serial ${opts.serial}`);
    } catch (e) {
      failBind(e);
    }
    return;
  }
  if (!opts.allowUnbound) {
    Logger.error('Decrypting a vault object needs --serial <biosample>. For EGA-only files use --allow-unbound --sk.');
    process.exit(2);
  }
  if (!opts.sk) {
    Logger.error('--allow-unbound requires --sk');
    process.exit(2);
  }
  const out = decrypt(ct, loadPrivateKey(opts.sk));
  writeOutput(out, opts.output);
  if (opts.output && opts.output !== '-') {
    Logger.success(`unbound crypt4gh plaintext written (${out.length} bytes)`);
  }
}

export async function crypt4ghRevokeCommand(opts: { serial?: string }): Promise<void> {
  if (!opts.serial) {
    Logger.error('crypt4gh revoke needs --serial <biosample>');
    process.exit(2);
  }
  let session;
  try {
    session = await requireBioNftAccess(opts.serial);
  } catch (e) {
    failBind(e);
  }
  try {
    const out = await revokeEnvelopeOnNode({
      serial: opts.serial,
      wallet: session.wallet,
      signature: session.signature,
    });
    Logger.success(`crypt4gh envelope for serial ${opts.serial} is ${out.status}`);
  } catch (e) {
    failBind(e);
  }
}

export async function crypt4ghInspectCommand(filePath: string): Promise<void> {
  const buf = readInput(filePath);
  if (!isCrypt4gh(buf)) {
    Logger.error('Not a crypt4gh v1 file (missing magic or version)');
    process.exit(2);
  }
  const info = inspect(buf);
  console.log(JSON.stringify(info, null, 2));
}

export function wrapLocalFileAsCrypt4gh(filePath: string, recipientPkPath: string): string {
  const pk = loadPublicKey(recipientPkPath);
  const plain = fs.readFileSync(filePath);
  const wrapped = encrypt(plain, [pk]);
  const outPath = filePath.endsWith('.c4gh') ? filePath : `${filePath}.c4gh`;
  fs.writeFileSync(outPath, wrapped);
  return outPath;
}

export async function wrapLocalFileBoundToSerial(
  filePath: string,
  serial: string,
  extraRecipientPkPath?: string,
): Promise<string> {
  const outPath = filePath.endsWith('.c4gh') ? filePath : `${filePath}.c4gh`;
  await crypt4ghEncryptCommand({
    serial,
    input: filePath,
    output: outPath,
    recipientPk: extraRecipientPkPath,
  });
  return outPath;
}
