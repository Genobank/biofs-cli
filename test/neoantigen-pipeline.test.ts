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

import { buildHlaBody, parseDepthCurve, parseExecutor, anchorLine, buildFusionBody, buildIndelBody, parseGene, parseGenes, hlaFieldsOf } from '../src/commands/neoantigen-pipeline';
describe('neoantigen-hla verb', () => {
  const own = '0xFD1f085f8d10375df8A1c7C9ffA4FD0eB80B0b1d';
  test('germline BAM as a biocid, optional RNA, custodial owner, no raw paths', () => {
    const b: any = buildHlaBody('C1', { normal: bc('bam', 'n.bam'), rna: bc('bam', 'r.bam'), owner: own }, W, 's');
    expect(b.wallet).toBe(own); expect(b.normal_biocid).toMatch(/^biocid:\/\//); expect(b.rna_biocid).toMatch(/^biocid:\/\//);
    expect((buildHlaBody('C1', { normal: bc('bam', 'n.bam') }, W, 's') as any).rna_biocid).toBe('');
    expect(() => buildHlaBody('C1', { normal: 'gs://b/n.bam' }, W, 's')).toThrow(/biocid/);
    expect(() => buildHlaBody('Jane Doe', { normal: bc('bam', 'n.bam') }, W, 's')).toThrow(/case identifier/);
  });
});

describe('neoantigen-hla verb: depth curve and unmapped reads', () => {
  test('depth curve is parsed, bounded, de-duplicated and sorted', () => {
    expect(parseDepthCurve('0.1, 0.5,0.25,0.5')).toEqual([0.5, 0.25, 0.1]);
    for (const bad of ['', '0', '1', '1.5', '-0.2', 'x', '0.1,0.2,0.3,0.4,0.5,0.6']) expect(() => parseDepthCurve(bad)).toThrow(/depth-curve/);
  });
  test('the body carries the curve and the flag only as asked', () => {
    const plain: any = buildHlaBody('C1', { normal: bc('bam', 'n.bam') }, W, 's');
    expect(plain.depth_curve).toBeUndefined(); expect(plain.include_unmapped).toBe(false);
    const full: any = buildHlaBody('C1', { normal: bc('bam', 'n.bam'), depthCurve: '0.5,0.1', includeUnmapped: true }, W, 's');
    expect(full.depth_curve).toEqual([0.5, 0.1]); expect(full.include_unmapped).toBe(true);
    expect(() => buildHlaBody('C1', { normal: bc('bam', 'n.bam'), depthCurve: '2' }, W, 's')).toThrow(/depth-curve/);
  });
});

describe('neoantigen-design verb: alleles from a registered HLA report', () => {
  const evidence = bc('neoantigen_evidence', 'e.json', 'genobank');
  const report = bc('hla-typing-report', 'neo-1.hla_typing_report.json', 'genobank');
  test('explicit alleles still work and send no report biocid', () => {
    const b: any = buildDesignBody('C1', { evidence, hla: 'HLA-A*02:01,HLA-B*38:01' }, W, 's');
    expect(b.hla).toEqual(['HLA-A*02:01', 'HLA-B*38:01']); expect(b.hla_biocid).toBeUndefined(); expect(b.accept_low_confidence).toBeUndefined();
  });
  test('--hla-from sends the report biocid and no alleles; accepting low confidence is explicit', () => {
    const b: any = buildDesignBody('C1', { evidence, hlaFrom: report }, W, 's');
    expect(b.hla_biocid).toBe(report); expect(b.hla).toEqual([]); expect(b.accept_low_confidence).toBe(false);
    expect((buildDesignBody('C1', { evidence, hlaFrom: report, acceptLowConfidence: true }, W, 's') as any).accept_low_confidence).toBe(true);
  });
  test('refusals: both sources, neither source, a raw path, accepting without a report', () => {
    expect(() => buildDesignBody('C1', { evidence, hla: 'HLA-A*02:01', hlaFrom: report }, W, 's')).toThrow(/not both/);
    expect(() => buildDesignBody('C1', { evidence }, W, 's')).toThrow(/--hla .* or --hla-from/);
    expect(() => buildDesignBody('C1', { evidence, hlaFrom: 'gs://b/r.json' }, W, 's')).toThrow(/biocid/);
    expect(() => buildDesignBody('C1', { evidence, hla: 'HLA-A*02:01', acceptLowConfidence: true }, W, 's')).toThrow(/only with --hla-from/);
  });
});

describe('neoantigen verbs: executor', () => {
  const ev = { somaticSqlite: bc('sqlite', 's.sqlite'), filteredVcf: bc('vcf', 'f.vcf.gz'), tumor: bc('bam', 't.bam'), normal: bc('bam', 'n.bam') };
  const evidence = bc('neoantigen_evidence', 'e.json', 'genobank');
  test('auto by default; worker and local accepted; anything else refused', () => {
    expect(parseExecutor(undefined)).toBe('auto'); expect(parseExecutor('')).toBe('auto');
    expect(parseExecutor('worker')).toBe('worker'); expect(parseExecutor('local')).toBe('local');
    for (const bad of ['gpu', 'Worker', 'worker:x']) expect(() => parseExecutor(bad)).toThrow(/auto, worker or local/);
  });
  test('every verb sends it', () => {
    expect((buildEvidenceBody('C1', ev, W, 's') as any).executor).toBe('auto');
    expect((buildEvidenceBody('C1', { ...ev, executor: 'worker' }, W, 's') as any).executor).toBe('worker');
    expect((buildHlaBody('C1', { normal: bc('bam', 'n.bam'), executor: 'local' }, W, 's') as any).executor).toBe('local');
    expect((buildHlaBody('C1', { normal: bc('bam', 'n.bam') }, W, 's') as any).executor).toBe('auto');
    expect((buildDesignBody('C1', { evidence, hla: 'HLA-A*02:01', executor: 'worker' }, W, 's') as any).executor).toBe('worker');
    expect((buildDesignBody('C1', { evidence, hla: 'HLA-A*02:01' }, W, 's') as any).executor).toBe('auto');
    expect(() => buildDesignBody('C1', { evidence, hla: 'HLA-A*02:01', executor: 'gpu' }, W, 's')).toThrow(/--executor/);
  });
});


describe('anchorLine: the on-chain proof of a finished job is always stated', () => {
  const done = { status: 'done', manifest_biocid: 'biocid://genobank/0xa/neoantigen-hla-file/neo-1.job_manifest.json' };
  it('says nothing for a job that is not finished', () => {
    expect(anchorLine({ status: 'running' })).toBeNull();
    expect(anchorLine({ status: 'failed' })).toBeNull();
    expect(anchorLine(null)).toBeNull();
  });
  it('states the token, chain, transaction and manifest of an anchored job', () => {
    const line = anchorLine({ ...done, anchor_request: {}, anchor: { anchored: true, tokenId: '7', chain_id: '15132025', tx: '0xabc' } })!;
    expect(line).toContain('token 7');
    expect(line).toContain('15132025');
    expect(line).toContain('0xabc');
    expect(line).toContain('neo-1.job_manifest.json');
  });
  it('marks an idempotent anchor as already on chain', () => {
    expect(anchorLine({ ...done, anchor: { anchored: true, tokenId: '3', chain_id: '1', idempotent: true } })).toContain('already on chain');
  });
  it('says NOT anchored, with the reason, when the node could not or was not set up to', () => {
    expect(anchorLine({ ...done, anchor_request: {}, anchor: { anchored: false, reason: 'not configured: set NEO_JOB_ANCHOR_ADDRESS' } })).toBe('NOT anchored: not configured: set NEO_JOB_ANCHOR_ADDRESS');
    expect(anchorLine({ ...done, anchor: { anchored: false } })).toContain('no reason recorded');
  });
  it('says pending for a sealed job the node has not reached yet', () => {
    expect(anchorLine({ ...done, anchor_request: { manifest_object: 'x' } })).toMatch(/^pending/);
  });
  it('never leaves a finished job without a statement: an unsealed job is NOT anchored', () => {
    expect(anchorLine(done)).toBe('NOT anchored: no manifest was sealed for this job');
  });
});

describe('neoantigen-fusion verb', () => {
  const fe = bc('neoantigen_fusion_evidence', 'fe.json', 'genobank');
  const base = { fusionEvidence: fe, fiveGene: 'CDH1', threeGene: 'NRG1', hla: 'HLA-A*01:01,HLA-B*08:01' };
  test('body: biocid in, two gene symbols, alleles, defaults', () => {
    const b: any = buildFusionBody('TN25-112103', base, W, 's');
    expect([b.five_gene, b.three_gene, b.min_templates, b.executor, b.proteome_biocid]).toEqual(['CDH1', 'NRG1', 10, 'auto', '']);
    expect(b.hla).toEqual(['HLA-A*01:01', 'HLA-B*08:01']);
    expect(b.fusion_evidence_biocid).toBe(fe);
    expect(JSON.stringify(b)).not.toMatch(/gs:\/\//);
  });
  test('alleles from a registered HLA report, with the low confidence choice explicit', () => {
    const rep = bc('neoantigen_hla', 'hla_typing_report.json', 'genobank');
    const b: any = buildFusionBody('C1', { ...base, hla: undefined, hlaFrom: rep }, W, 's');
    expect([b.hla, b.hla_biocid, b.accept_low_confidence]).toEqual([[], rep, false]);
    expect((buildFusionBody('C1', { ...base, hla: undefined, hlaFrom: rep, acceptLowConfidence: true }, W, 's') as any).accept_low_confidence).toBe(true);
    expect(() => buildFusionBody('C1', { ...base, hlaFrom: rep }, W, 's')).toThrow(/not both/);
    expect(() => buildFusionBody('C1', { ...base, hla: undefined }, W, 's')).toThrow(/required/);
    expect(() => buildFusionBody('C1', { ...base, acceptLowConfidence: true }, W, 's')).toThrow(/only with --hla-from/);
  });
  test('refusals: raw paths, bad symbols, class II alleles, out of range counts, person-like case ids, custodial owner', () => {
    expect(() => buildFusionBody('C1', { ...base, fusionEvidence: 'gs://b/f.json' }, W, 's')).toThrow(/biocid/);
    expect(() => buildFusionBody('C1', { ...base, fiveGene: 'CDH1; ls' }, W, 's')).toThrow(/gene symbol/);
    expect(() => buildFusionBody('C1', { ...base, threeGene: '' }, W, 's')).toThrow(/gene symbol/);
    expect(() => buildFusionBody('C1', { ...base, hla: 'HLA-DRB1*03:01' }, W, 's')).toThrow(/class I/);
    expect(() => buildFusionBody('C1', { ...base, minTemplates: '0' }, W, 's')).toThrow(/--min-templates/);
    expect(() => buildFusionBody('C1', { ...base, minTemplates: '1001' }, W, 's')).toThrow(/--min-templates/);
    expect(() => buildFusionBody('C1', { ...base, proteome: '/mnt/x.fa' }, W, 's')).toThrow(/biocid/);
    expect(() => buildFusionBody('Jane Doe', base, W, 's')).toThrow(/case identifier/);
    const own = '0xFD1f085f8d10375df8A1c7C9ffA4FD0eB80B0b1d';
    expect((buildFusionBody('C1', { ...base, owner: own }, W, 's') as any).wallet).toBe(own);
    expect(() => buildFusionBody('C1', { ...base, owner: '0x123' }, W, 's')).toThrow(/biowallet/);
  });
});

describe('neoantigen-indel verb', () => {
  const sq = bc('sqlite', 'TN25-112103.mutect2.filtered.sqlite', 'genobank');
  const base = { somaticSqlite: sq, hla: 'HLA-A*01:01,HLA-C*07:02' };
  test('body: defaults, optional references and genes', () => {
    const b: any = buildIndelBody('TN25-112103', base, W, 's');
    expect([b.somatic_sqlite_biocid, b.min_alt, b.executor, b.gtf_biocid, b.transcripts_biocid, b.proteome_biocid, b.genes]).toEqual([sq, 8, 'auto', '', '', '', undefined]);
    const g: any = buildIndelBody('C1', { ...base, genes: 'TGFBR2, KMT2A,TGFBR2', minAlt: '12', gtf: bc('ref', 'g.gtf.gz', 'genobank'), transcripts: bc('ref', 't.fa.gz', 'genobank') }, W, 's');
    expect([g.genes, g.min_alt]).toEqual([['TGFBR2', 'KMT2A'], 12]);
    expect(g.gtf_biocid).toMatch(/^biocid:/);
    expect((buildIndelBody('C1', { ...base, tpm: bc('expression', 'x.tsv', 'public-r2') }, W, 's') as any).tpm_biocid).toMatch(/^biocid:/);
    expect((buildIndelBody('C1', base, W, 's') as any).tpm_biocid).toBe('');
  });
  test('refusals', () => {
    expect(() => buildIndelBody('C1', { ...base, somaticSqlite: '/Users/x/a.sqlite' }, W, 's')).toThrow(/biocid/);
    expect(() => buildIndelBody('C1', { ...base, gtf: 'https://x/g.gtf.gz' }, W, 's')).toThrow(/--gtf/);
    expect(() => buildIndelBody('C1', { ...base, transcripts: 'gs://b/t.fa.gz' }, W, 's')).toThrow(/--transcripts/);
    expect(() => buildIndelBody('C1', { ...base, tpm: 'https://x/e.tsv' }, W, 's')).toThrow(/--tpm/);
    expect(() => buildIndelBody('C1', { ...base, genes: 'TGFBR2,a b' }, W, 's')).toThrow(/gene symbol/);
    expect(() => buildIndelBody('C1', { ...base, genes: Array.from({ length: 51 }, (_, i) => `G${i}`).join(',') }, W, 's')).toThrow(/at most 50/);
    expect(() => buildIndelBody('C1', { ...base, minAlt: '0' }, W, 's')).toThrow(/--min-alt/);
    expect(() => buildIndelBody('C1', { ...base, minAlt: '201' }, W, 's')).toThrow(/--min-alt/);
    expect(() => buildIndelBody('C1', { ...base, hla: undefined }, W, 's')).toThrow(/required/);
    expect(() => buildIndelBody('C1', { ...base, executor: 'cloud' }, W, 's')).toThrow(/--executor/);
  });
  test('shared helpers', () => {
    expect(() => buildEvidenceBody('C1', { somaticSqlite: 'gs://x/s.sqlite', filteredVcf: bc('vcf', 'f.vcf.gz'), tumor: bc('bam', 't.bam'), normal: bc('bam', 'n.bam') }, W, 's')).toThrow(/--somatic-sqlite must be a biocid/);
    expect(parseGene('--x', 'HLA-A')).toBe('HLA-A');
    expect(() => parseGene('--x', undefined)).toThrow();
    expect(parseGenes(undefined)).toEqual([]);
    expect(hlaFieldsOf({ hla: 'HLA-A*01:01' })).toEqual({ hla: ['HLA-A*01:01'] });
  });
});
