import { buildDesignBody, buildRankV5Body, v5aDesignFields } from '../src/commands/neoantigen-pipeline';

const W = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed';
const O = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';
const H = 'a'.repeat(64);
const B = (t: string) => `biocid://genobank/${O.toLowerCase()}/${t}`;
const design = (x: any = {}) => ({ evidence: B('tsv/f.tsv'), hla: 'HLA-A*02:01,HLA-B*51:08', ...x });
const v5a = (x: any = {}) => design({ engine: 'v5a', codeSha256: H, protocolSha256: 'b'.repeat(64), ledgerRecord: '40', ...x });
const rank = (x: any = {}) => ({ design: B('json/d.json'), evidence: B('tsv/f.tsv'), indel: B('json/i.json'), fusion: B('json/fu.json'), codeSha256: H, protocolSha256: 'b'.repeat(64), ledgerRecord: '40', ...x });

describe('design body with engine v5a', () => {
  it('a v2 design body is unchanged: no engine or pin fields are sent', () => {
    const b: any = buildDesignBody('TN25', design(), W, '0xsig');
    for (const k of ['engine', 'code_sha256', 'protocol_sha256', 'ledger_record', 'proteome_sha256', 'models_sha256']) expect(b[k]).toBeUndefined();
    expect(buildDesignBody('TN25', design({ engine: 'v2' }), W, '0xsig')).toEqual(b);
  });
  it('engine v5a sends the three frozen pins and the optional environment pins', () => {
    const b: any = buildDesignBody('TN25', v5a({ proteomeSha256: 'c'.repeat(64), modelsSha256: 'd'.repeat(64) }), W, '0xsig');
    expect([b.engine, b.code_sha256, b.protocol_sha256, b.ledger_record]).toEqual(['v5a', H, 'b'.repeat(64), 40]);
    expect([b.proteome_sha256, b.models_sha256]).toEqual(['c'.repeat(64), 'd'.repeat(64)]);
    expect(buildDesignBody('TN25', v5a(), W, '0xsig')).not.toHaveProperty('models_sha256');
  });
  it('refuses engine v5a without a pin, a malformed pin, an unknown engine and pins without v5a', () => {
    expect(() => v5aDesignFields({ ...v5a(), codeSha256: undefined } as any)).toThrow(/SHA-256/);
    expect(() => v5aDesignFields({ ...v5a(), protocolSha256: 'zz' } as any)).toThrow(/SHA-256/);
    expect(() => v5aDesignFields({ ...v5a(), ledgerRecord: undefined } as any)).toThrow(/ledger/);
    expect(() => v5aDesignFields({ ...v5a(), modelsSha256: 'zz' } as any)).toThrow(/SHA-256/);
    expect(() => v5aDesignFields(design({ engine: 'v6' }) as any)).toThrow(/--engine must be/);
    expect(() => v5aDesignFields(design({ codeSha256: H }) as any)).toThrow(/apply only with --engine v5a/);
    expect(() => v5aDesignFields(design({ engine: 'v2', modelsSha256: H }) as any)).toThrow(/apply only with --engine v5a/);
  });
});

describe('rank-v5 body', () => {
  it('builds the body with biocids, the pins and defaults', () => {
    const b: any = buildRankV5Body('TN25', rank({ owner: O }), W, '0xsig');
    expect(b.wallet).toBe(O);
    expect([b.n, b.patient, b.executor, b.ledger_record, b.code_sha256]).toEqual([20, 'TN25', 'auto', 40, H]);
    expect([b.design_biocid, b.evidence_biocid, b.indel_biocid, b.fusion_biocid]).toEqual([B('json/d.json'), B('tsv/f.tsv'), B('json/i.json'), B('json/fu.json')]);
    expect(buildRankV5Body('TN25', rank({ fusion: undefined }), W, 's')).not.toHaveProperty('fusion_biocid');
  });
  it('refuses paths and urls, a bad case id, bad pins and a bad record', () => {
    for (const k of ['design', 'evidence', 'indel', 'fusion']) expect(() => buildRankV5Body('TN25', rank({ [k]: 'gs://b/x' }), W, 's')).toThrow(/must be a biocid/);
    expect(() => buildRankV5Body('a b', rank(), W, 's')).toThrow(/case identifier/);
    expect(() => buildRankV5Body('TN25', rank({ codeSha256: 'x' }), W, 's')).toThrow(/SHA-256/);
    expect(() => buildRankV5Body('TN25', rank({ protocolSha256: undefined }), W, 's')).toThrow(/SHA-256/);
    expect(() => buildRankV5Body('TN25', rank({ ledgerRecord: '0' }), W, 's')).toThrow(/ledger/);
    expect(() => buildRankV5Body('TN25', rank({ n: '99' }), W, 's')).toThrow(/--n/);
  });
});
