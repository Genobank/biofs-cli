import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { AddressInfo } from 'net';

jest.mock('../src/lib/auth/credentials', () => ({ getCredentials: jest.fn().mockResolvedValue({ wallet_address: '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a', user_signature: '0xsig' }) }));
import { uploadCommand, validateUploadArgs, chunkBytes, guessKind, hashFile } from '../src/commands/upload';

const MB = 1024 * 1024;
let server: http.Server; let base = ''; let received: Buffer; let sessionCalls: any[]; let completeCalls: any[]; let failOnce: boolean; let putRanges: string[];

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks); const url = req.url || '';
        const json = (code: number, o: object) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (req.method === 'POST' && url === '/node/upload_session') {
          const b = JSON.parse(body.toString()); sessionCalls.push({ body: b, headers: req.headers }); received = Buffer.alloc(0);
          return json(200, { status: 'open', upload_id: 'up-test', session_uri: `${base}/gcs/session1`, bucket: 'genobank-biorouter', object: `biorouter/0x5f5a/${b.kind}/abc/${b.filename}`, biocid: `biocid://${b.originlab}/0x5f5a/${b.kind}/${b.filename}`, chunk_multiple: 262144 });
        }
        if (req.method === 'POST' && url === '/node/upload_complete') {
          completeCalls.push(JSON.parse(body.toString()));
          return json(200, { status: 'complete', biocid: 'biocid://signios/0x5f5a/bam/x.bam', owner_wallet: '0x5f5a', originlab: 'signios', biosample: '2011694_Sample1', bucket: 'genobank-biorouter', object: 'o', size_bytes: received.length });
        }
        if (req.method === 'PUT' && url === '/gcs/session1') {
          const cr = String(req.headers['content-range'] || ''); putRanges.push(cr);
          const q = /^bytes \*\/(\d+)$/.exec(cr);
          if (q) { if (received.length === 0) { res.writeHead(308); return res.end(); } res.writeHead(308, { Range: `bytes=0-${received.length - 1}` }); return res.end(); }
          const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(cr)!; const start = Number(m[1]), total = Number(m[3]);
          if (failOnce && start > 0) { failOnce = false; req.socket.destroy(); return; }                        // network failure on the second chunk
          if (start !== received.length) { res.writeHead(400); return res.end('out of order'); }
          received = Buffer.concat([received, body]);
          if (received.length >= total) { res.writeHead(200); return res.end('{}'); }
          res.writeHead(308, { Range: `bytes=0-${received.length - 1}` }); return res.end();
        }
        res.writeHead(404); res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.BIOFS_NODE_URL = `${base}/node`; resolve(); });
  });
}
const mk = (n: number, name = 'x.bam') => { const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'up-')), name); fs.writeFileSync(f, crypto.randomBytes(n)); return f; };

beforeAll(startServer); afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { sessionCalls = []; completeCalls = []; failOnce = false; putRanges = []; received = Buffer.alloc(0); });

describe('argument rules', () => {
  it('requires a real biosample serial and lab of origin, never a placeholder', () => {
    expect(() => validateUploadArgs('a.bam', {})).toThrow(/--biosample/);
    expect(() => validateUploadArgs('a.bam', { biosample: 'UNKNOWN', originlab: 'signios' })).toThrow(/--biosample/);
    expect(() => validateUploadArgs('a.bam', { biosample: '2011694_Sample1' })).toThrow(/--originlab/);
    expect(() => validateUploadArgs('a.bam', { biosample: '2011694_Sample1', originlab: 'Unknown' })).toThrow(/--originlab/);
    expect(() => validateUploadArgs('a.txt', { biosample: '2011694_Sample1', originlab: 'signios' })).toThrow(/file type/);
    expect(() => validateUploadArgs('a.bam', { biosample: '2011694_Sample1', originlab: 'signios', tokenize: true })).toThrow(/not part of the upload/);
    expect(validateUploadArgs('a.bam', { biosample: '2011694_Sample1', originlab: 'SigniOS' })).toMatchObject({ kind: 'bam', originlab: 'signios', category: 'dna' });
  });
  it('guesses kind and sizes chunks as multiples of 256 KiB', () => {
    expect(guessKind('r.fastq.gz')).toBe('fastq'); expect(guessKind('a.g.vcf.gz')).toBe('gvcf'); expect(guessKind('a.cram')).toBe('cram'); expect(guessKind('a.pdf')).toBeNull();
    expect(chunkBytes(undefined)).toBe(64 * MB); expect(chunkBytes(1)).toBe(MB); expect(chunkBytes(1.3) % 262144).toBe(0);
    expect(() => chunkBytes(0)).toThrow(); expect(() => chunkBytes(600)).toThrow();
  });
});

describe('streamed upload against a fake node and a fake GCS session', () => {
  const opts = { biosample: '2011694_Sample1', originlab: 'signios', dataCategory: 'cdna', chunkMb: 1, quiet: true };
  it('uploads a 2.5 MiB file in 3 chunks, md5 and size match, and completes once', async () => {
    const f = mk(2.5 * MB | 0, 'lot.bam');
    await uploadCommand(f, opts);
    expect(crypto.createHash('md5').update(received).digest('hex')).toBe(crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex'));
    expect(received.length).toBe(fs.statSync(f).size);
    expect(sessionCalls).toHaveLength(1); expect(completeCalls).toEqual([{ upload_id: 'up-test' }]);
    const b = sessionCalls[0].body;
    expect(b).toMatchObject({ filename: 'lot.bam', kind: 'bam', biosample: '2011694_Sample1', originlab: 'signios', data_category: 'cdna', size_bytes: fs.statSync(f).size });
    expect(b.md5).toMatch(/^[0-9a-f]{32}$/); expect(b.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionCalls[0].headers['x-biofs-wallet']).toBe('0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a');
    expect(fs.existsSync(`${f}.biofs-upload.json`)).toBe(false);
  });
  it('resumes from what GCS persisted after a dropped connection', async () => {
    const f = mk(3 * MB, 'lot2.bam'); failOnce = true;
    process.env.BIOFS_UPLOAD_RETRY_MS = '1';
    try { await uploadCommand(f, opts); } finally { delete process.env.BIOFS_UPLOAD_RETRY_MS; }
    expect(crypto.createHash('md5').update(received).digest('hex')).toBe(crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex'));
    expect(putRanges.some((r) => r.startsWith('bytes */'))).toBe(true);
    expect(completeCalls).toHaveLength(1);
  });
  it('a dry run hashes and sends nothing', async () => {
    const f = mk(MB, 'dry.bam'); await uploadCommand(f, { ...opts, dryRun: true });
    expect(sessionCalls).toHaveLength(0); expect(completeCalls).toHaveLength(0); expect(putRanges).toHaveLength(0);
  });
  it('hashFile streams md5 and sha256 equal to a one-shot hash', async () => {
    const f = mk(3 * MB + 17, 'h.bam'); const buf = fs.readFileSync(f); const h = await hashFile(f);
    expect(h).toEqual({ md5: crypto.createHash('md5').update(buf).digest('hex'), sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length });
  });
});
