import { Command } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { registry, REGISTRY_SHA256, buildParabricksBody, registerParabricksCommands, PbrunRaw, buildTemplateBody } from '../src/commands/parabricks';

const W = '0x5f5a60EaEf242c0D51A21c703f520347b96Ed19a';
const bc = (type: string, name: string) => `biocid://genobank/${W}/${type}/${name}`;
const SIG = '0xsig';
const NODE_REGISTRY = path.join(__dirname, '..', '..', 'biofs-node-sync-20261107', 'repo', 'neoantigen', 'pbrun_registry.json');
const EXPECTED_SHA = 'dd4b796f3e12d121509a6e17d4458c33d4be50128ec963cc2485229c6f099fb2';     // 18 November 2026: frozen run templates germline_wes_v1 and germline_wgs_v1 operated by biofs-node

function program(): Command {
  const p = new Command();
  p.exitOverride();
  p.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerParabricksCommands(p);
  return p;
}
async function check(argv: string[]): Promise<any> {
  const lines: string[] = [];
  const spy = jest.spyOn(console, 'log').mockImplementation((m: string) => { lines.push(String(m)); });
  const exit = jest.spyOn(process, 'exit').mockImplementation(((c?: number) => { throw new Error('exit ' + c); }) as any);
  try {
    await program().parseAsync(['node', 'biofs', 'pbrun', ...argv, '--check']);
  } finally { spy.mockRestore(); exit.mockRestore(); }
  return lines.length ? JSON.parse(lines.join('\n')) : null;
}

describe('the registry the CLI carries', () => {
  test('is the committed file, byte for byte', () => {
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'parabricks', 'registry.json'));
    expect(REGISTRY_SHA256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));
    expect(REGISTRY_SHA256).toBe(EXPECTED_SHA);
  });
  const sibling = fs.existsSync(NODE_REGISTRY) ? test : test.skip;
  sibling('equals the node repo registry when both repos are side by side', () => {
    expect(crypto.createHash('sha256').update(fs.readFileSync(NODE_REGISTRY)).digest('hex')).toBe(REGISTRY_SHA256);
  });
  test('has 28 tools and mutectcaller is not one of them', () => {
    expect(Object.keys(registry.tools)).toHaveLength(28);
    expect(registry.tools.mutectcaller).toBeUndefined();
    expect(registry.already_a_verb.mutectcaller).toBe('biofs somatic-mutect');
  });
});

describe('commands', () => {
  test('one command per tool plus list, logs, status, templates and template', () => {
    const group = program().commands.find((c) => c.name() === 'pbrun')!;
    const names = group.commands.map((c) => c.name()).sort();
    expect(names).toEqual([...Object.keys(registry.tools), 'list', 'logs', 'status', 'templates', 'template'].sort());
  });
  test('no tool option collides with an option biofs adds', () => {
    expect(() => program()).not.toThrow();
  });
  test.each(Object.keys(registry.tools))('%s: every pbrun option of the page is an option of the command, in/out as the registry says', (tool) => {
    const group = program().commands.find((c) => c.name() === 'pbrun')!;
    const cmd = group.commands.find((c) => c.name() === tool)!;
    const longs = new Set(cmd.options.map((o) => o.long));
    for (const [flag, e] of Object.entries(registry.tools[tool].flags)) {
      if (e.class === 'in' && e.kind === 'ref') continue;
      if (e.class === 'pass' || e.class === 'in' || (e.class === 'out' && e.optional)) expect(longs.has(flag)).toBe(true);
      else expect(longs.has(flag)).toBe(false);          // required outputs, engine-owned and unsupported flags are never options
    }
  });
});

describe('job bodies', () => {
  const base = (over: Partial<PbrunRaw> = {}): PbrunRaw => ({ flags: {}, ...over });

  test('fq2bam: pairs, sample name, reference, switches and values', () => {
    const body: any = buildParabricksBody('fq2bam', 'T1', base({ ref: 'hg38', sampleName: 'T1_tumor', acknowledgeUntested: true,
      flags: { '--in-fq': [bc('fastq', 'r1'), bc('fastq', 'r2'), bc('fastq', 'r3'), bc('fastq', 'r4')], '--knownSites': ['hg38:mills_1000g'], '--out-recal-file': true, '--low-memory': true, '--bwa-options': '-K 10000000' } }), W, SIG);
    expect(body.inputs['--in-fq']).toEqual([[bc('fastq', 'r1'), bc('fastq', 'r2')], [bc('fastq', 'r3'), bc('fastq', 'r4')]]);
    expect(body).toMatchObject({ wallet: W, signature: SIG, case_id: 'T1', executor: 'worker', tool: 'fq2bam', out_name: 'T1_fq2bam', reference: 'hg38', outputs: ['--out-recal-file'],
      flags: { '--low-memory': true, '--bwa-options': '-K 10000000' }, read_group: { sample: 'T1_tumor' }, acknowledge_untested: true, registry_sha256: REGISTRY_SHA256 });
  });
  test('somatic from FASTQ: tumor and normal get their own sample names', () => {
    const body: any = buildParabricksBody('somatic', 'P1', base({ ref: 'hg38', tumorSample: 'P1_T', normalSample: 'P1_N', flags: { '--in-tumor-fq': [bc('fastq', 'a'), bc('fastq', 'b')], '--in-normal-fq': [bc('fastq', 'c'), bc('fastq', 'd')] } }), W, SIG);
    expect(body.read_groups).toEqual({ tumor: { sample: 'P1_T' }, normal: { sample: 'P1_N' } });
  });
  test('somatic refuses the same sample name or a missing one', () => {
    const flags = { '--in-tumor-fq': [bc('fastq', 'a'), bc('fastq', 'b')], '--in-normal-fq': [bc('fastq', 'c'), bc('fastq', 'd')] };
    expect(() => buildParabricksBody('somatic', 'P1', base({ ref: 'hg38', tumorSample: 'X', normalSample: 'X', flags }), W, SIG)).toThrow(/differ/);
    expect(() => buildParabricksBody('somatic', 'P1', base({ ref: 'hg38', tumorSample: 'X', flags }), W, SIG)).toThrow(/--tumor-sample and --normal-sample/);
  });
  test('FASTQ input needs a sample name: no default', () => {
    expect(() => buildParabricksBody('fq2bam', 'T1', base({ ref: 'hg38', flags: { '--in-fq': [bc('fastq', 'r1'), bc('fastq', 'r2')] } }), W, SIG)).toThrow(/--sample-name is required/);
  });
  test('an odd number of FASTQ values is refused', () => {
    expect(() => buildParabricksBody('fq2bam', 'T1', base({ sampleName: 'S', flags: { '--in-fq': [bc('fastq', 'r1')] } }), W, SIG)).toThrow(/two mates/);
  });
  test.each(['gs://bucket/a.bam', 'https://x/a.bam', '/Users/x/a.bam', 'a.bam', ''])('a BAM given as %p is refused', (v) => {
    expect(() => buildParabricksBody('deepvariant', 'S1', base({ ref: 'hg38', flags: { '--in-bam': v } }), W, SIG)).toThrow(/biocid/);
  });
  test('an output flag must be a switch, and a required output is not an option at all', () => {
    expect(() => buildParabricksBody('fq2bam', 'T1', base({ sampleName: 'S', flags: { '--out-recal-file': '/tmp/x' } }), W, SIG)).toThrow(/switch/);
    expect(() => buildParabricksBody('fq2bam', 'T1', base({ sampleName: 'S', flags: { '--out-bam': true } }), W, SIG)).not.toThrow();           // the node refuses it: required outputs are never optional
  });
  test('engine-owned and unsupported flags are refused with the reason', () => {
    expect(() => buildParabricksBody('fq2bam', 'T1', base({ sampleName: 'S', flags: { '--tmp-dir': 'x' } }), W, SIG)).toThrow(/engine sets the scratch/);
    expect(() => buildParabricksBody('fq2bam', 'T1', base({ sampleName: 'S', flags: { '--in-fq-list': 'x' } }), W, SIG)).toThrow(/host paths/);
  });
  test('an unknown tool, mutectcaller and a bad case id', () => {
    expect(() => buildParabricksBody('nope', 'T1', base(), W, SIG)).toThrow(/unknown/);
    expect(() => buildParabricksBody('mutectcaller', 'T1', base(), W, SIG)).toThrow(/somatic-mutect/);
    expect(() => buildParabricksBody('bqsr', 'John Smith', base(), W, SIG)).toThrow(/case identifier/);
  });
  test('sample names are letters, digits, _ and -', () => {
    for (const bad of ['a b', 'a/b', 'a;b', '-x', 'x'.repeat(65)]) expect(() => buildParabricksBody('fq2bam', 'T1', base({ sampleName: bad, flags: { '--in-fq': [bc('fastq', 'r1'), bc('fastq', 'r2')] } }), W, SIG)).toThrow();
  });
  test('sample options on a tool that reads no FASTQ are refused', () => {
    expect(() => buildParabricksBody('deepvariant', 'S1', base({ ref: 'hg38', sampleName: 'S', flags: { '--in-bam': bc('bam', 'a.bam') } }), W, SIG)).toThrow(/only to tools that read FASTQ/);
  });
  test('an operator may name the owner; anything else is refused', () => {
    expect((buildParabricksBody('bam2fq', 'S1', base({ owner: W, flags: { '--in-bam': bc('bam', 'a.bam') } }), '0x' + '1'.repeat(40), SIG) as any).wallet).toBe(W);
    expect(() => buildParabricksBody('bam2fq', 'S1', base({ owner: 'someone', flags: { '--in-bam': bc('bam', 'a.bam') } }), W, SIG)).toThrow(/biowallet/);
  });
  test('the loss allowance is bounded', () => {
    expect(() => buildParabricksBody('bam2fq', 'S1', base({ maxReadLossFraction: '0.5', flags: { '--in-bam': bc('bam', 'a.bam') } }), W, SIG)).toThrow(/0 and 0.05/);
    expect((buildParabricksBody('bam2fq', 'S1', base({ maxReadLossFraction: '0.01', flags: { '--in-bam': bc('bam', 'a.bam') } }), W, SIG) as any).max_read_loss_fraction).toBe(0.01);
  });
  test('the secret never travels in the spec fields, only in the signature field', () => {
    const body: any = buildParabricksBody('bam2fq', 'S1', base({ flags: { '--in-bam': bc('bam', 'a.bam') } }), W, SIG);
    expect(JSON.stringify({ ...body, signature: undefined })).not.toContain(SIG);
  });
});

describe('from the command line (--check prints the body and sends nothing)', () => {
  test('fq2bam end to end through commander', async () => {
    const body = await check(['fq2bam', 'T1', '--in-fq', bc('fastq', 'r1'), bc('fastq', 'r2'), '--ref', 'hg38', '--sample-name', 'T1_tumor', '--knownSites', 'hg38:mills_1000g', 'hg38:known_indels',
      '--out-recal-file', '--low-memory', '--bwa-options', '-K 10000000', '--acknowledge-untested']);
    expect(body.inputs['--in-fq']).toEqual([[bc('fastq', 'r1'), bc('fastq', 'r2')]]);
    expect(body.inputs['--knownSites']).toEqual(['hg38:mills_1000g', 'hg38:known_indels']);
    expect(body).toMatchObject({ tool: 'fq2bam', reference: 'hg38', outputs: ['--out-recal-file'], flags: { '--low-memory': true, '--bwa-options': '-K 10000000' }, read_group: { sample: 'T1_tumor' }, acknowledge_untested: true });
  });
  test('--library-per-pair reaches the body through commander (a silently dropped option would pool libraries under one tag)', async () => {
    const body = await check(['fq2bam', 'T1', '--in-fq', bc('fastq', 'r1'), bc('fastq', 'r2'), '--in-fq', bc('fastq', 'r3'), bc('fastq', 'r4'), '--in-fq', bc('fastq', 'r5'), bc('fastq', 'r6'),
      '--ref', 'hg38', '--sample-name', 'S', '--library-per-pair', 'LA,LA,LB']);
    expect(body.pair_libraries).toEqual(['LA', 'LA', 'LB']);
  });
  test('two lanes by repeating the option', async () => {
    const body = await check(['fq2bam', 'T1', '--in-fq', bc('fastq', 'r1'), bc('fastq', 'r2'), '--in-fq', bc('fastq', 'r3'), bc('fastq', 'r4'), '--ref', 'hg38', '--sample-name', 'S']);
    expect(body.inputs['--in-fq']).toHaveLength(2);
  });
  test('a negated pbrun option (--no-markdups) is sent as a switch, and absent when not typed', async () => {
    const on = await check(['fq2bam', 'T1', '--in-fq', bc('fastq', 'r1'), bc('fastq', 'r2'), '--ref', 'hg38', '--sample-name', 'S', '--no-markdups']);
    expect(on.flags['--no-markdups']).toBe(true);
    const off = await check(['fq2bam', 'T1', '--in-fq', bc('fastq', 'r1'), bc('fastq', 'r2'), '--ref', 'hg38', '--sample-name', 'S']);
    expect(off.flags).toBeUndefined();
  });
  test('deepvariant with a gvcf switch and a BAM biocid', async () => {
    const body = await check(['deepvariant', 'S1', '--in-bam', bc('bam', 'a.bam'), '--ref', 'hg38', '--gvcf']);
    expect(body.inputs['--in-bam']).toBe(bc('bam', 'a.bam'));
    expect(body.flags).toEqual({ '--gvcf': true });
  });
  test('a bad value is refused before anything is sent', async () => {
    await expect(check(['deepvariant', 'S1', '--in-bam', 'gs://b/a.bam', '--ref', 'hg38'])).rejects.toThrow(/exit 1/);
  });
  test('an unknown option is refused by commander', async () => {
    await expect(check(['bam2fq', 'S1', '--in-bam', bc('bam', 'a.bam'), '--nonsense'])).rejects.toThrow();
  });
  test('a tool that has no such option refuses it', async () => {
    await expect(check(['bam2fq', 'S1', '--in-bam', bc('bam', 'a.bam'), '--low-memory'])).rejects.toThrow();
  });
});


describe('fq2bam validation options', () => {
  const pair = { '--in-fq': [bc('fastq', 'r1'), bc('fastq', 'r2')] };
  const fq = (extra: Partial<PbrunRaw>) => buildParabricksBody('fq2bam', 'T1', { flags: { ...pair }, ref: 'hg38', sampleName: 'T1', acknowledgeUntested: true, ...extra } as PbrunRaw, W, SIG);

  test('no validation, no validation field', () => {
    expect((fq({}) as any).validation).toBeUndefined();
  });
  test('--validate-with-bwa asks for the independent bwa comparison inside the job', () => {
    expect((fq({ validateWithBwa: true }) as any).validation).toEqual({ bwa: true });
  });
  test('--validate-against-bam names an earlier BAM by biocid', () => {
    expect((fq({ validateAgainstBam: bc('bam', 'prev') }) as any).validation).toEqual({ against_bam: bc('bam', 'prev') });
  });
  test('both together', () => {
    expect((fq({ validateWithBwa: true, validateAgainstBam: bc('bam', 'prev') }) as any).validation).toEqual({ bwa: true, against_bam: bc('bam', 'prev') });
  });
  test('a path is not a biocid', () => {
    expect(() => fq({ validateAgainstBam: '/tmp/prev.bam' })).toThrow(/biocid/);
  });
  test('other tools do not take it', () => {
    expect(() => buildParabricksBody('bam2fq', 'T1', { flags: { '--in-bam': bc('bam', 'x') }, validateWithBwa: true } as PbrunRaw, W, SIG)).toThrow(/only to fq2bam/);
  });
  test('the options exist on fq2bam only, and --check prints the validation block', async () => {
    const body = await check(['fq2bam', 'T1', '--in-fq', bc('fastq', 'r1'), bc('fastq', 'r2'), '--ref', 'hg38', '--sample-name', 'T1', '--acknowledge-untested', '--validate-with-bwa']);
    expect(body.validation).toEqual({ bwa: true });
    const p = program();
    const group = p.commands.find((c) => c.name() === 'pbrun')!;
    const has = (tool: string, long: string) => !!group.commands.find((c) => c.name() === tool)!.options.find((o) => o.long === long);
    expect(has('fq2bam', '--validate-with-bwa')).toBe(true);
    expect(has('fq2bam', '--validate-against-bam')).toBe(true);
    expect(has('bam2fq', '--validate-with-bwa')).toBe(false);
  });
});

describe('fq2bam is validated (ledger record 21)', () => {
  const W0 = '0x01a2d260d2fe8cc13ae70b6868deb4f3ddcdb797';
  const pair = { '--in-fq': [`biocid://augenomics/${W0}/fastq/a/x_R1.fastq.gz`, `biocid://augenomics/${W0}/fastq/b/x_R2.fastq.gz`] } as any;
  it('is listed as passed in the registry with its record, and no other tool is', () => {
    const passed = Object.entries(registry.tools).filter(([, m]) => m.validation.status === 'passed').map(([t]) => t);
    expect(passed).toEqual(['fq2bam']);
    expect((registry.tools as any).fq2bam.validation.record.image).toBe('nvcr.io/nvidia/clara/clara-parabricks:4.8.0-1');
  });
  it('a job body for fq2bam needs no acknowledgement', () => {
    const body: any = buildParabricksBody('fq2bam', 'T1', { flags: pair, ref: 'hg38', sampleName: 'S1' } as any, W0, '0xsig');
    expect(body.acknowledge_untested).toBeUndefined();
    expect(body.registry_sha256).toBe(REGISTRY_SHA256);
  });
});

describe('fq2bam library per pair', () => {
  const base = (over: Partial<PbrunRaw> = {}): PbrunRaw => ({ flags: {}, ...over });
  const flags = { '--in-fq': [bc('fastq', 'a'), bc('fastq', 'b'), bc('fastq', 'c'), bc('fastq', 'd')] };
  it('carries one library name per pair into the body', () => {
    const body: any = buildParabricksBody('fq2bam', 'C1', base({ ref: 'hg38', sampleName: 'S', libraryPerPair: ['LA,LB'], flags }), W, SIG);
    expect(body.pair_libraries).toEqual(['LA', 'LB']);
    expect(body.read_group.sample).toBe('S');
    expect(buildParabricksBody('fq2bam', 'C1', base({ ref: 'hg38', sampleName: 'S', flags }), W, SIG).pair_libraries).toBeUndefined();
    expect(() => buildParabricksBody('fq2bam', 'C1', base({ ref: 'hg38', sampleName: 'S', libraryPerPair: ['L B'], flags }), W, SIG)).toThrow(/letters, digits/);
  });
});


describe('reference datasets by biocid (17 November 2026)', () => {
  const C = registry.reference_custodian as string;
  const ref = (type: string, name: string) => `biocid://genobank/${C}/${type}/${name}`;
  const G = ref('reference-genome', 'human_GRCh38_no_alt_analysis_set.fasta');
  const BED = ref('target-intervals', 'Agilent_SureSelect_V8_S33266436_Regions_hg38.bed');
  const KS = [ref('known-sites', 'Homo_sapiens_assembly38.dbsnp138.vcf'), ref('known-sites', 'Homo_sapiens_assembly38.known_indels.vcf.gz'), ref('known-sites', 'Mills_and_1000G_gold_standard.indels.hg38.vcf.gz')];
  test('the catalog carries the 5 datasets of the WES template under the custodian, each pinned', () => {
    const refs = registry.references as any;
    expect(C).toBe('0xf54d5ea2eb0e93d46e8bd925e0104162b8737722');
    expect(refs.hg38_noalt.biocid).toBe(G);
    expect(Object.keys(refs.hg38_noalt.md5)).toHaveLength(8);
    expect(refs.hg38.assets.agilent_v8_regions.biocid).toBe(BED);
    expect([refs.hg38.assets.dbsnp138.biocid, refs.hg38.assets.known_indels.biocid, refs.hg38.assets.mills_1000g.biocid]).toEqual(KS);
  });
  test('the WES template with every reference by biocid reaches the body unchanged', async () => {
    const body = await check(['deepvariant_germline', 'WES1', '--in-fq', bc('fastq', 'r1'), bc('fastq', 'r2'), '--ref', G, '--sample-name', 'S1', '--library', 'L1', '--library-per-pair', 'L1',
      '--platform', 'ILLUMINA', '--interval-file', BED, '--knownSites', ...KS, '--out-recal-file', '--use-wes-model', '--normalize-reads', '--min-mapping-quality', '10',
      '--min-base-quality', '10', '--gvcf', '--fix-mate', '--out-name', 'WES1_germline', '--acknowledge-untested']);
    expect(body).toMatchObject({ tool: 'deepvariant_germline', reference: G, outputs: ['--out-recal-file'], read_group: { sample: 'S1', library: 'L1', platform: 'ILLUMINA' }, pair_libraries: ['L1'] });
    expect(body.inputs['--knownSites']).toEqual(KS);
    expect(body.inputs['--interval-file']).toEqual([BED]);
    expect(body.flags).toEqual({ '--use-wes-model': true, '--normalize-reads': true, '--min-mapping-quality': '10', '--min-base-quality': '10', '--gvcf': true, '--fix-mate': true });
  });
});

describe('pbrun template: the node operates a frozen template; the CLI sends only the per-run fields', () => {
  const fq = (n: number, r: number) => `biocid://augenomics/0x${'a'.repeat(40)}/fastq/x${n}${r}/S${n}_R${r}.fastq.gz`;
  const raw = { inFq: [fq(1, 1), fq(1, 2)], sampleName: 'SAMPLE1', library: 'LIB1', kit: 'agilent_v8', outName: 'C1_LIB1_germline' };
  it('carries the template id, the FASTQ pairs, the names, the kit, the stem and the owner, and never a flag, a reference or an image', () => {
    const b = buildTemplateBody('germline_wes_v1', 'C1', raw, W, SIG);
    expect(b).toEqual({ wallet: W, signature: SIG, case_id: 'C1', executor: 'worker', registry_sha256: REGISTRY_SHA256, template: 'germline_wes_v1', in_fq: [[fq(1, 1), fq(1, 2)]],
      sample_name: 'SAMPLE1', library: 'LIB1', out_name: 'C1_LIB1_germline', kit: 'agilent_v8' });
    for (const k of ['flags', 'inputs', 'reference', 'tool', 'outputs', 'image']) expect(b).not.toHaveProperty(k);
    expect(buildTemplateBody('germline_wes_v1', 'C1', { ...raw, owner: '0x' + 'b'.repeat(40) }, W, SIG).wallet).toBe('0x' + 'b'.repeat(40));
  });
  it('pairs lanes, takes one library per pair, and refuses what the template refuses', () => {
    const b = buildTemplateBody('germline_wes_v1', 'C1', { ...raw, inFq: [fq(1, 1), fq(1, 2), fq(2, 1), fq(2, 2)], libraryPerPair: ['LIB1', 'LIB2'] }, W, SIG);
    expect(b.in_fq).toEqual([[fq(1, 1), fq(1, 2)], [fq(2, 1), fq(2, 2)]]);
    expect(b.pair_libraries).toEqual(['LIB1', 'LIB2']);
    expect(() => buildTemplateBody('germline_wes_v1', 'C1', { ...raw, kit: undefined }, W, SIG)).toThrow(/agilent_v8/);
    expect(() => buildTemplateBody('germline_wgs_v1', 'C1', raw, W, SIG)).toThrow(/no capture kit/);
    expect(buildTemplateBody('germline_wgs_v1', 'C1', { ...raw, kit: undefined }, W, SIG)).not.toHaveProperty('kit');
    expect(() => buildTemplateBody('germline_wes_v9', 'C1', raw, W, SIG)).toThrow(/unknown template/);
    expect(() => buildTemplateBody('germline_wes_v1', 'C1', { ...raw, inFq: [fq(1, 1)] }, W, SIG)).toThrow(/two mates/);
    expect(() => buildTemplateBody('germline_wes_v1', 'C1', { ...raw, inFq: ['gs://b/R1.fastq.gz', 'gs://b/R2.fastq.gz'] }, W, SIG)).toThrow(/not a biocid/);
    expect(() => buildTemplateBody('germline_wes_v1', 'Maria Lopez', raw, W, SIG)).toThrow(/case identifier/);
    expect(() => buildTemplateBody('germline_wes_v1', 'C1', { ...raw, libraryPerPair: ['A', 'B'] }, W, SIG)).toThrow(/library-per-pair/);
  });
  it('the catalog this CLI carries holds the two frozen templates with their pins', () => {
    expect(Object.keys(registry.templates || {}).sort()).toEqual(['germline_wes_v1', 'germline_wgs_v1']);
    const t = registry.templates!.germline_wes_v1;
    expect(t.image_digest).toBe('sha256:44206e2b522e87370c1107c774f52c5859af9b8f3408aa7232de4bbe3c24953c');
    expect(Object.keys(t.flags).sort()).toEqual(['--fix-mate', '--gvcf', '--min-base-quality', '--min-mapping-quality', '--normalize-reads', '--use-wes-model']);
    expect(t.inputs['--knownSites'].every((b) => b.includes('.noalt.'))).toBe(true);
  });
});
