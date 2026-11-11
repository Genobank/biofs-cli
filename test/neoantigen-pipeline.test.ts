import { BIOCID_RE, requireBiocid, parseHla, parseWeights, parseCount, buildEvidenceBody, buildDesignBody } from '../src/commands/neoantigen-pipeline';

const W = '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
const bc = (type: string, name: string, agent = 'natera') => `biocid://${agent}/${W}/${type}/${name}`;

describe('neoantigen verbs: biocid-only inputs', () => {
  test('accepts both registry spellings of a biocid', () => {
    expect(BIOCID_RE.test(bc('bam', 'a.bam'))).toBe(true);
    expect(BIOCID_RE.test(`Biocid:caris/${W}/bam/DNA_TN25-336147.bam`)).toBe(true);
  });
  test.each(['gs://bucket/a.bam', 'https://storage.googleapis.com/b/a.bam', '/Users/x/a.bam', 'a.bam', `biocid://natera/0x123/bam/a.bam`, ''])('rejects %p', (v) => {
    expect(() => requireBiocid('--tumor', v)).toThrow(/biocid/);
  });
});

describe('neoantigen verbs: argument validation', () => {
  test('HLA: class I only, 1 to 6, de-duplicated', () => {
    expect(parseHla('HLA-A*02:01, HLA-A*02:01,HLA-B*38:01')).toEqual(['HLA-A*02:01', 'HLA-B*38:01']);
    expect(() => parseHla('')).toThrow();
    expect(() => parseHla('HLA-DRB1*04:02')).toThrow(/class I/);
    expect(() => parseHla('A*02:01')).toThrow();
    expect(() => parseHla('HLA-A*02:01,HLA-A*29:02,HLA-B*38:01,HLA-B*51:08,HLA-C*12:03,HLA-C*16:02,HLA-A*01:01')).toThrow(/1 to 6/);
  });
  test('weights: 4 or 5 values summing to 1', () => {
    expect(parseWeights(undefined)).toEqual([0.45, 0.25, 0.2, 0.1]);
    expect(parseWeights('0.35,0.20,0.15,0.15,0.15')).toHaveLength(5);
    expect(() => parseWeights('0.5,0.5,0.5,0.5')).toThrow(/sum to 1/);
    expect(() => parseWeights('0.5,0.5,0')).toThrow();
    expect(() => parseWeights('a,b,c,d')).toThrow();
  });
  test('counts are bounded integers', () => {
    expect(parseCount(undefined, 20, 1, 50, '--n')).toBe(20);
    expect(parseCount('7', 20, 1, 50, '--n')).toBe(7);
    expect(() => parseCount('0', 20, 1, 50, '--n')).toThrow();
    expect(() => parseCount('51', 20, 1, 50, '--n')).toThrow();
    expect(() => parseCount('x', 20, 1, 50, '--n')).toThrow();
  });
});

describe('neoantigen verbs: request bodies', () => {
  const ev = { somaticSqlite: bc('sqlite', 's.sqlite'), filteredVcf: bc('vcf', 'f.vcf.gz'), tumor: bc('bam', 't.bam'), normal: bc('bam', 'n.bam') };
  test('evidence body carries only biocids and the signer', () => {
    const b: any = buildEvidenceBody('TN25-336147', { ...ev, secondDna: [bc('bam', 'd.bam', 'caris')], rna: bc('bam', 'r.bam', 'caris') }, W, '0xsig');
    expect(b.case_id).toBe('TN25-336147');
    expect(b.second_dna_biocid).toHaveLength(1);
    expect(b.min_mapq).toBe(20);
    expect(JSON.stringify(b)).not.toMatch(/gs:\/\//);
    expect(b.tpm_biocid).toBe('');
  });
  test('evidence refuses a raw path in any input and a person-like case id', () => {
    expect(() => buildEvidenceBody('TN25-336147', { ...ev, tumor: 'gs://b/t.bam' }, W, 's')).toThrow(/biocid/);
    expect(() => buildEvidenceBody('Jane Doe', ev, W, 's')).toThrow(/case identifier/);
  });
  test('design body', () => {
    const b: any = buildDesignBody('TN25-336147', { evidence: bc('neoantigen_evidence', 'e.json', 'genobank'), hla: 'HLA-A*02:01,HLA-B*38:01', n: '10', weights: '0.35,0.20,0.15,0.15,0.15' }, W, 's');
    expect(b.n).toBe(10); expect(b.hla).toHaveLength(2); expect(b.weights).toHaveLength(5); expect(b.patient).toBe('TN25-336147'); expect(b.expect_genes).toEqual([]);
    expect(() => buildDesignBody('c1', { evidence: 'e.json', hla: 'HLA-A*02:01' }, W, 's')).toThrow(/biocid/);
  });
});

import { validateObject, buildOnrampBody, loadObjects } from '../src/commands/onramp-https';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('onramp-https verb', () => {
  const sha = 'a'.repeat(64);
  const owner = '0xFD1f085f8d10375df8A1c7C9ffA4FD0eB80B0b1d';
  test('accepts only https with a published hash and size', () => {
    expect(validateObject({ url: 'https://example.org/a.bam', sha256: sha, bytes: 10 }).sha256).toBe(sha);
    expect(() => validateObject({ url: 'http://example.org/a.bam', sha256: sha, bytes: 10 })).toThrow(/https/);
    expect(() => validateObject({ url: 'https://u:p@example.org/a.bam', sha256: sha, bytes: 10 })).toThrow(/credentials/);
    expect(() => validateObject({ url: 'https://example.org/a.bam', sha256: 'abc', bytes: 10 })).toThrow(/sha256/);
    expect(() => validateObject({ url: 'https://example.org/a.bam', sha256: sha, bytes: 0 })).toThrow(/byte size/);
    expect(() => validateObject({ url: 'file:///etc/passwd', sha256: sha, bytes: 1 })).toThrow(/https/);
  });
  test('catalog keys become urls under the base and honor the prefix', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onr-')), 'm.json');
    fs.writeFileSync(f, JSON.stringify({ objects: [{ key: 'raw/C1/a.bam', sha256: sha, bytes: 5 }, { key: 'analysis/C1/x.tsv', sha256: sha, bytes: 5 }] }));
    const o = loadObjects(f, 'https://h.example/', 'raw/');
    expect(o).toHaveLength(1);
    expect(o[0].url).toBe('https://h.example/raw/C1/a.bam');
  });
  test('body refuses a placeholder serial, a bad owner and a person-like case id', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onr-')), 'm.json');
    fs.writeFileSync(f, JSON.stringify([{ url: 'https://h.example/a.bam', sha256: sha, bytes: 5 }]));
    const base = { owner, serial: 'TN25-112103', caseId: 'TN25-112103', originlab: 'public-r2', manifest: f };
    expect((buildOnrampBody(base, '0xw', 's') as any).objects).toHaveLength(1);
    expect(() => buildOnrampBody({ ...base, serial: 'UNKNOWN' }, 'w', 's')).toThrow(/UNKNOWN/);
    expect(() => buildOnrampBody({ ...base, owner: '0x123' }, 'w', 's')).toThrow(/biowallet/);
    expect(() => buildOnrampBody({ ...base, caseId: 'Jane Doe' }, 'w', 's')).toThrow(/case identifier/);
  });
});

describe('neoantigen verbs: custodial owner', () => {
  const sg = '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
  const own = '0xFD1f085f8d10375df8A1c7C9ffA4FD0eB80B0b1d';
  const ev = { somaticSqlite: bc('sqlite', 's.sqlite'), filteredVcf: bc('vcf', 'f.vcf.gz'), tumor: bc('bam', 't.bam'), normal: bc('bam', 'n.bam') };
  test('an operator can run for a custodial owner; default is the signer; a bad owner is refused', () => {
    expect((buildEvidenceBody('C1', { ...ev, owner: own }, sg, 's') as any).wallet).toBe(own);
    expect((buildEvidenceBody('C1', ev, sg, 's') as any).wallet).toBe(sg);
    expect(() => buildEvidenceBody('C1', { ...ev, owner: '0x12' }, sg, 's')).toThrow(/biowallet/);
    expect((buildDesignBody('C1', { evidence: bc('neoantigen_evidence', 'e.json', 'genobank'), hla: 'HLA-A*02:01', owner: own }, sg, 's') as any).wallet).toBe(own);
  });
});
