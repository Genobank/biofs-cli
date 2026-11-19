/**
 * biofs pbrun <tool> <caseId> [options]       one verb for each NVIDIA Parabricks tool (fq2bam, bqsr, applybqsr, haplotypecaller, deepvariant, deepsomatic, somatic, ...)
 * biofs pbrun list                            every tool, its family and whether its real run has been validated
 * biofs pbrun status <job>                    a pbrun job (only the signer who submitted it can read it)
 *
 * CLIENT verbs. The options are the ones of NVIDIA's own tool pages (the registry in registry.json is built from them, not typed by hand), with three differences that keep the
 * protocol rules: (1) every input file is a biocid of yours, never a path; reference data is named by the biocid of its catalog entry (or by its catalog name: --ref hg38_noalt,
 * --knownSites hg38:mills_1000g), each biocid pinned to the MD5 of its objects; (2) output files are never named by
 * the caller: the job writes them under your biowallet and each becomes its own biocid with the input biocids as parents; the options that ask for an extra output are switches;
 * (3) FASTQ input needs an explicit sample name (--sample-name), because a default read group would give a tumor and its normal the same name.
 *
 * Dispatched through biofs-node to a GPU worker agent (POST /neoantigen_parabricks). The node and the worker validate the job again against their own copy of the registry. A tool whose
 * real run has not been validated against an independent result is refused unless you pass --acknowledge-untested, which is recorded in the run report. `mutectcaller` is not here: it is
 * `biofs somatic-mutect`. Decision support for a human review, never a clinical device.
 */
import { Command, Option } from 'commander';
import chalk from 'chalk';
import * as crypto from 'crypto';
import * as fs from 'fs';
import registryJson from './registry.json';
import { BIOCID_RE, neoantigenStatusCommand, ownerOr, parabricksSubmit } from '../neoantigen-pipeline';
import { Logger } from '../../lib/utils/logger';
import { jobLogCommand } from '../job-view';

export interface PbrunFlag { class: 'in' | 'out' | 'pass' | 'engine' | 'unsupported'; nargs: number | '*' | null; repeatable: boolean; required: boolean; group: string; metavar: string; aliases: string[]; desc: string; kind?: string; optional?: boolean; needs?: string[]; reason?: string; biodata_type?: string; shape?: string }
export interface PbrunTool { family: string; main: string | null; fastq: boolean; align: boolean; somatic_fastq: boolean; index_only: boolean; category: string; doc_sha256: string; validation: { status: string; record: string | null }; flags: Record<string, PbrunFlag> }
export interface PbrunTemplate { assay: string; tool: string; status: string; frozen: string; image: string; image_digest: string; reference: string; inputs: Record<string, string[]>; kit_flag: string | null; kits: Record<string, string>; flags: Record<string, unknown>; outputs: string[]; platform: string; rg_id: string }
export interface PbrunRegistry { schema: string; docs_version: string; image_version: string; references: Record<string, any>; refdirs: Record<string, any>; already_a_verb: Record<string, string>; tools: Record<string, PbrunTool>; templates?: Record<string, PbrunTemplate>; template_sha256?: Record<string, string>; template_validation?: Record<string, { status: string; date: string | null; evidence: string | null }> }

export const registry = registryJson as unknown as PbrunRegistry;
export const REGISTRY_SHA256: string = crypto.createHash('sha256').update(fs.readFileSync(require.resolve('./registry.json'))).digest('hex');

const EXTRA_FLAGS = ['--out-name', '--sample-name', '--library', '--library-per-pair', '--platform', '--tumor-sample', '--normal-sample', '--acknowledge-untested', '--max-read-loss-fraction', '--owner', '--wait', '--json', '--check', '--ref', '--validate-with-bwa', '--validate-against-bam'];
const VARIADIC = ['fq_pairs', 'fq_single', 'known_sites', 'intervals'];
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CASE_RE = /^[A-Za-z0-9_-]{1,64}$/;

export interface PbrunRaw {
  /** flag as written in NVIDIA's page (--in-fq) -> the value the user gave: a string, an array of strings, or true for a switch */
  flags: Record<string, string | string[] | boolean>;
  ref?: string; outName?: string; sampleName?: string; library?: string; libraryPerPair?: string[]; platform?: string; tumorSample?: string; normalSample?: string;
  acknowledgeUntested?: boolean; maxReadLossFraction?: string; owner?: string; wait?: boolean; json?: boolean; check?: boolean;
  validateWithBwa?: boolean; validateAgainstBam?: string;
}

function biocidOf(flag: string, v: unknown): string {
  if (typeof v !== 'string' || !BIOCID_RE.test(v)) throw new Error(`${flag} must be a biocid of yours (biocid://...), never a path or a bucket URL`);
  return v;
}

/** Build the job body (and, for --check, nothing more) from what was typed. Throws a plain message for anything the registry already shows to be wrong; the node checks the rest. */
export function buildParabricksBody(tool: string, caseId: string, raw: PbrunRaw, wallet: string, signature: string, reg: PbrunRegistry = registry, sha: string = REGISTRY_SHA256): Record<string, unknown> {
  if (reg.already_a_verb[tool]) throw new Error(`${tool} is already a verb: use ${reg.already_a_verb[tool]}`);
  const meta = reg.tools[tool];
  if (!meta) throw new Error(`unknown pbrun tool ${tool}`);
  if (!CASE_RE.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  const outName = raw.outName ?? `${caseId}_${tool}`;
  if (!NAME_RE.test(outName)) throw new Error('--out-name must be letters, digits, _ or - (at most 64)');
  const inputs: Record<string, unknown> = {};
  const passFlags: Record<string, unknown> = {};
  const outputs: string[] = [];
  for (const [flag, given] of Object.entries(raw.flags)) {
    const e = meta.flags[flag];
    if (!e) throw new Error(`${flag} is not an option of pbrun ${tool}`);
    if (e.class === 'engine' || e.class === 'unsupported') throw new Error(`${flag}: ${e.reason}`);
    if (e.class === 'in') {
      const k = e.kind as string;
      const list = Array.isArray(given) ? given : [given];
      if (k === 'fq_pairs') {
        if (list.length % 2 !== 0) throw new Error(`${flag} takes the two mates of each pair: R1 biocid then R2 biocid (an odd number of values was given)`);
        const pairs: string[][] = [];
        for (let i = 0; i < list.length; i += 2) pairs.push([biocidOf(flag, list[i]), biocidOf(flag, list[i + 1])]);
        inputs[flag] = pairs;
      } else if (k === 'fq_single') {
        inputs[flag] = list.map((x) => biocidOf(flag, x));
      } else if (k === 'known_sites') {
        inputs[flag] = list.map(String);
      } else if (k === 'intervals') {
        inputs[flag] = list.map(String);
      } else if (['bam', 'recal', 'vcf', 'gvcf'].includes(k)) {
        if (list.length !== 1) throw new Error(`${flag} takes one value`);
        inputs[flag] = biocidOf(flag, list[0]);
      } else {
        if (list.length !== 1) throw new Error(`${flag} takes one value`);
        inputs[flag] = String(list[0]);
      }
    } else if (e.class === 'out') {
      if (given !== true) throw new Error(`${flag} is a switch: output files are named by the job, not by you`);
      outputs.push(flag);
    } else {
      if (e.nargs === null) passFlags[flag] = true;
      else passFlags[flag] = Array.isArray(given) ? given.map(String) : String(given);
    }
  }
  const body: Record<string, unknown> = {
    wallet: ownerOr(raw.owner, wallet), signature, case_id: caseId, executor: 'worker', tool, out_name: outName, registry_sha256: sha, inputs,
  };
  if (raw.ref) body.reference = raw.ref;
  if (outputs.length) body.outputs = outputs;
  if (Object.keys(passFlags).length) body.flags = passFlags;
  if (raw.acknowledgeUntested) body.acknowledge_untested = true;
  if (raw.validateWithBwa || raw.validateAgainstBam) {
    // the comparison of the fq2bam BAM with an independent bwa (and/or an earlier run), run inside the same governed job and sealed with it
    if (tool !== 'fq2bam') throw new Error('--validate-with-bwa and --validate-against-bam apply only to fq2bam');
    const v: Record<string, unknown> = {};
    if (raw.validateWithBwa) v.bwa = true;
    if (raw.validateAgainstBam) v.against_bam = biocidOf('--validate-against-bam', raw.validateAgainstBam);
    body.validation = v;
  }
  if (raw.maxReadLossFraction !== undefined && raw.maxReadLossFraction !== '') {
    const x = Number(raw.maxReadLossFraction);
    if (!isFinite(x) || x < 0 || x > 0.05) throw new Error('--max-read-loss-fraction must be between 0 and 0.05');
    body.max_read_loss_fraction = x;
  }
  if (meta.fastq) {
    const lib = raw.library, plat = raw.platform;
    if (meta.somatic_fastq) {
      if (!raw.tumorSample || !raw.normalSample) throw new Error('give --tumor-sample and --normal-sample (a tumor and a normal must not share a sample name)');
      if (raw.tumorSample === raw.normalSample) throw new Error('--tumor-sample and --normal-sample must differ');
      body.read_groups = { tumor: rg(raw.tumorSample, lib, plat), normal: rg(raw.normalSample, lib, plat) };
    } else {
      if (!raw.sampleName) throw new Error('--sample-name is required for FASTQ input: it becomes the SM of every read group, and a default would give a tumor and its normal the same name');
      body.read_group = rg(raw.sampleName, lib, plat);
      if (raw.libraryPerPair && raw.libraryPerPair.length) {
        const names = ([] as string[]).concat(raw.libraryPerPair).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
        for (const n of names) if (!NAME_RE.test(n)) throw new Error(`--library-per-pair ${n}: letters, digits, _ or - only`);
        body.pair_libraries = names;
      }
    }
  } else if (raw.sampleName || raw.tumorSample || raw.normalSample) {
    throw new Error('--sample-name, --tumor-sample and --normal-sample apply only to tools that read FASTQ');
  }
  return body;
}

function rg(sample: string, library?: string, platform?: string): Record<string, string> {
  if (!NAME_RE.test(sample)) throw new Error('a sample name must be letters, digits, _ or - (at most 64)');
  const out: Record<string, string> = { sample };
  if (library) out.library = library;
  if (platform) out.platform = platform;
  return out;
}

function describeIn(flag: string, e: PbrunFlag): string {
  const base = e.desc || '';
  switch (e.kind) {
    case 'fq_pairs': return `${base} Give the biocids of each pair: R1 then R2 (repeat the option for more lanes)`;
    case 'fq_single': return `${base} Biocids of single-end FASTQ files`;
    case 'known_sites': return `${base} The biocid of a known-sites dataset of the reference catalog (biofs reference-register lists them), or its catalog name like hg38:mills_1000g; repeatable`;
    case 'intervals': return `${base} The biocid of a capture design of the reference catalog, or a biocid of a BED/interval file of yours; repeatable`;
    case 'bam': case 'recal': case 'vcf': case 'gvcf': return `${base} A biocid of yours`;
    case 'file': return `${base} A biocid of yours, or a reference object`;
    case 'asset': return `${base} A reference object (catalog name or an approved reference path)`;
    case 'refdir': return `${base} A reference library by name`;
    default: return base;
  }
}

export function addToolOptions(cmd: Command, tool: string, meta: PbrunTool): void {
  const longs = new Set<string>();
  for (const [flag, e] of Object.entries(meta.flags)) {
    if (EXTRA_FLAGS.includes(flag) && flag !== '--ref') throw new Error(`pbrun ${tool} has the option ${flag}, which biofs uses for something else`);
    if (e.class === 'in') {
      if (e.kind === 'ref') continue;                 // --ref is added once below
      const variadic = VARIADIC.includes(e.kind as string);
      cmd.addOption(new Option(`${flag} ${variadic ? '<values...>' : '<value>'}`, describeIn(flag, e)));
      longs.add(flag);
    } else if (e.class === 'out' && e.optional) {
      cmd.addOption(new Option(flag, `Also write this output (${e.biodata_type})${(e.needs || []).length ? `; needs ${(e.needs || []).join(', ')}` : ''}. ${e.desc}`));
      longs.add(flag);
    } else if (e.class === 'pass') {
      cmd.addOption(new Option(e.nargs === null ? flag : `${flag} <value>`, e.desc));
      longs.add(flag);
    }
  }
  const hasRef = Object.values(meta.flags).some((e) => e.class === 'in' && e.kind === 'ref');
  if (hasRef) cmd.addOption(new Option('--ref <genome>', `The reference genome, by the biocid of a reference genome of the catalog (biofs reference-register lists them) or by its catalog name: ${Object.keys(registry.references).join(', ')}${meta.align ? ` (alignment needs a build with a BWA index: ${Object.entries(registry.references).filter(([, r]: [string, any]) => r.bwa_index).map(([k]) => k).join(', ')})` : ''}`));
  cmd.option('--out-name <stem>', 'Stem of every output file name (default: <caseId>_<tool>)');
  if (meta.fastq && meta.somatic_fastq) {
    cmd.option('--tumor-sample <name>', 'Sample name (SM) of the tumor read groups');
    cmd.option('--normal-sample <name>', 'Sample name (SM) of the normal read groups, different from the tumor');
  } else if (meta.fastq) {
    cmd.option('--sample-name <name>', 'Sample name (SM) of the read groups (required: no default is ever used)');
  }
  if (meta.fastq) { cmd.option('--library <name>', 'Library name (LB), default the sample name'); if (!meta.somatic_fastq) cmd.option('--library-per-pair <names...>', 'One library name (LB) for each --in-fq pair, in order (lanes of one library share a name): duplicates are then marked within each library, never across independent libraries aligned in one run'); cmd.option('--platform <name>', 'ILLUMINA (default), ELEMENT, PACBIO or ONT'); }
  if (meta.align || meta.fastq) cmd.option('--max-read-loss-fraction <x>', 'Allow up to this share of FASTQ reads to be missing from the BAM (0 to 0.05; default 0: any loss fails the job)');
  if (tool === 'fq2bam') {
    cmd.option('--validate-with-bwa', 'Also run an independent CPU bwa mem 0.7.17 -K 10000000 on the same reads and compare every primary record; the comparison report is a sealed output (one read pair only)');
    cmd.option('--validate-against-bam <biocid>', 'Also compare the BAM record by record with the BAM of an earlier job of yours (run-to-run determinism)');
  }
  cmd.option('--acknowledge-untested', 'Run a tool whose real run has not been validated yet; recorded in the run report');
  cmd.option('--owner <biowallet>', 'Owner biowallet when an operator runs the job for a custodial biowallet (default: the signer)');
  cmd.option('--check', 'Validate and print the job body without sending it');
  cmd.option('--wait', 'Poll until the job finishes');
  cmd.option('--json', 'Emit JSON');
}

/** Read what the user typed back out of a parsed command, by the flag spelling of NVIDIA's page (never by commander's attribute guess). */
export function rawFromCommand(cmd: Command, meta: PbrunTool): PbrunRaw {
  const opts = cmd.opts();
  const flags: Record<string, string | string[] | boolean> = {};
  for (const o of cmd.options) {
    if (!o.long || EXTRA_FLAGS.includes(o.long)) continue;
    const key = o.attributeName();
    if (cmd.getOptionValueSource(key) !== 'cli') continue;
    const v = opts[key];
    if (!(o.long in meta.flags)) continue;
    flags[o.long] = v as any;
  }
  return {
    flags, ref: opts.ref, outName: opts.outName, sampleName: opts.sampleName, library: opts.library, libraryPerPair: opts.libraryPerPair, platform: opts.platform, tumorSample: opts.tumorSample, normalSample: opts.normalSample,
    acknowledgeUntested: opts.acknowledgeUntested, validateWithBwa: opts.validateWithBwa, validateAgainstBam: opts.validateAgainstBam, maxReadLossFraction: opts.maxReadLossFraction, owner: opts.owner, wait: opts.wait, json: opts.json, check: opts.check,
  };
}

// ---- frozen run templates (18 November 2026) ------------------------------------------------------------------------------------------------------------------------------
// biofs-node is the job operator: a template fixes the tool, the image digest, the reference genome, the known sites, the capture design, every flag, the outputs and the
// read-group form. This verb sends only the per-run fields; the node expands them from its catalog and the worker re-checks the expansion against its own copy.
export interface TemplateRaw { inFq: string[]; sampleName: string; library: string; libraryPerPair?: string[]; kit?: string; outName: string; owner?: string; wait?: boolean; json?: boolean; check?: boolean }

export function buildTemplateBody(templateId: string, caseId: string, raw: TemplateRaw, wallet: string, signature: string, reg: PbrunRegistry = registry, sha: string = REGISTRY_SHA256): Record<string, unknown> {
  const t = (reg.templates || {})[templateId];
  if (!t) throw new Error(`unknown template ${templateId} (${Object.keys(reg.templates || {}).sort().join(', ')}): see biofs pbrun templates`);
  if (!CASE_RE.test(caseId)) throw new Error('caseId must be a case identifier of letters, digits, _ or - (never a person name)');
  const flat = (raw.inFq || []).flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
  if (!flat.length || flat.length % 2 !== 0) throw new Error('--in-fq takes the two mates of each pair: R1 biocid then R2 biocid (an even number of biocids)');
  for (const b of flat) if (!BIOCID_RE.test(b)) throw new Error(`--in-fq: ${b} is not a biocid (a gs:// path, URL or file name is never accepted)`);
  const pairs: string[][] = [];
  for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
  for (const [v, what] of [[raw.sampleName, '--sample-name'], [raw.library, '--library'], [raw.outName, '--out-name']] as const) if (!(typeof v === 'string' && NAME_RE.test(v))) throw new Error(`${what} is required (letters, digits, _ or -, at most 64)`);
  const body: Record<string, unknown> = { wallet: ownerOr(raw.owner, wallet), signature, case_id: caseId, executor: 'worker', registry_sha256: sha, template: templateId, in_fq: pairs,
    sample_name: raw.sampleName, library: raw.library, out_name: raw.outName };
  if (raw.libraryPerPair && raw.libraryPerPair.length) {
    const pl = raw.libraryPerPair.flatMap((x) => String(x).split(',')).map((x) => x.trim()).filter(Boolean);
    if (pl.length !== pairs.length || pl.some((x) => !NAME_RE.test(x))) throw new Error(`--library-per-pair needs one library name for each of the ${pairs.length} FASTQ pairs`);
    body.pair_libraries = pl;
  }
  if (t.kit_flag !== null) {
    if (!raw.kit || !(raw.kit in t.kits)) throw new Error(`${templateId} is a ${t.assay} template: --kit must be one of ${Object.keys(t.kits).sort().join(', ')}`);
    body.kit = raw.kit;
  } else if (raw.kit) throw new Error(`${templateId} is a ${t.assay} template: it takes no capture kit`);
  return body;
}

export function registerParabricksCommands(program: Command): void {
  const group = program
    .command('pbrun')
    .description('NVIDIA Parabricks (pbrun) tools as biofs verbs: inputs and outputs are biocids, jobs run on a GPU worker through biofs-node. See: biofs pbrun list');
  group.command('list')
    .description('Every pbrun tool, its family and whether its real run has been validated against an independent result')
    .option('--json', 'Emit JSON')
    .action((o: { json?: boolean }) => {
      const rows = Object.entries(registry.tools).map(([t, m]) => ({ tool: t, family: m.family, validation: m.validation.status, reads_fastq: m.fastq, aligns: m.align }));
      if (o.json) { console.log(JSON.stringify({ registry_sha256: REGISTRY_SHA256, docs_version: registry.docs_version, image_version: registry.image_version, tools: rows, already_a_verb: registry.already_a_verb }, null, 2)); return; }
      for (const r of rows) console.log(`${chalk.cyan(r.tool.padEnd(30))} ${r.family.padEnd(10)} ${r.validation === 'passed' ? chalk.green('validated') : chalk.yellow('untested ')}`);
      console.log(chalk.gray(`\nregistry ${REGISTRY_SHA256.slice(0, 12)} from NVIDIA Parabricks docs ${registry.docs_version} (image ${registry.image_version}). mutectcaller: use biofs somatic-mutect.`));
    });
  group.command('status <job>')
    .description('Show a pbrun job (only the signer who submitted it can read it)')
    .option('--wait', 'Poll until done or failed')
    .option('--json', 'Emit JSON')
    .action(async (id: string, o: { wait?: boolean; json?: boolean }) => { await neoantigenStatusCommand('parabricks' as any, id, o); });
  group.command('logs <job>')
    .description('The run log of a pbrun job (pbrun\'s own output), live with --follow')
    .option('--follow', 'Stream until the job ends')
    .option('--from <n>', 'Byte offset to start from (the next offset of the previous call)')
    .option('--json', 'Emit JSON lines')
    .action(async (id: string, o: { follow?: boolean; from?: string; json?: boolean }) => {
      try { await jobLogCommand(id, o); } catch (e: any) { Logger.error(`pbrun logs failed: ${e.message}`); process.exit(1); }
    });
  group.command('templates')
    .description('The frozen run templates biofs-node operates (tool, image digest, references, flags fixed by the node; you give only the per-run fields)')
    .option('--json', 'Emit JSON')
    .action((o: { json?: boolean }) => {
      const ts = registry.templates || {};
      if (o.json) { console.log(JSON.stringify({ registry_sha256: REGISTRY_SHA256, templates: ts, template_sha256: registry.template_sha256 || {}, template_validation: registry.template_validation || {} }, null, 2)); return; }
      for (const [id, t] of Object.entries(ts)) {
        console.log(`${chalk.cyan(id.padEnd(18))} ${t.assay.padEnd(4)} ${t.tool.padEnd(22)} ${(((registry.template_validation || {})[id] || {}).status || t.status).padEnd(20)} kits: ${Object.keys(t.kits).join(', ') || '-'}  sha ${((registry.template_sha256 || {})[id] || '').slice(0, 12)}`);
        console.log(chalk.gray(`  ${t.image}@${t.image_digest.slice(0, 19)}  flags ${Object.entries(t.flags).map(([f, v]) => (v === true ? f : `${f} ${v}`)).join(' ')}`));
      }
    });
  group.command('template <template> <caseId>')
    .description('Run a frozen template: biofs-node fixes the tool, image, reference genome, known sites, capture design, flags and outputs; this sends only the FASTQ pairs, names, kit, output stem and owner')
    .requiredOption('--in-fq <biocids...>', 'FASTQ pairs by biocid: R1 then R2 of each pair')
    .requiredOption('--sample-name <name>', 'Sample name (SM of every read group)')
    .requiredOption('--library <name>', 'Library name (LB; read-group ID and PU are <library>.<n>)')
    .option('--library-per-pair <names...>', 'One library name per FASTQ pair, when libraries are pooled')
    .option('--kit <name>', 'Capture kit of a WES template (e.g. agilent_v8)')
    .requiredOption('--out-name <stem>', 'Stem of every output file name')
    .option('--owner <biowallet>', 'Owner biowallet when an operator runs the job for a custodial biowallet (default: the signer)')
    .option('--check', 'Print the request and send nothing')
    .option('--wait', 'Poll until done or failed')
    .option('--json', 'Emit JSON')
    .action(async (templateId: string, caseId: string, o: TemplateRaw) => {
      try {
        if (o.check) { console.log(JSON.stringify(buildTemplateBody(templateId, caseId, o, '0x' + '0'.repeat(40), '<signature>'), null, 2)); return; }
        await parabricksSubmit((w, s) => buildTemplateBody(templateId, caseId, o, w, s), o as any);
      } catch (e: any) {
        Logger.error(`pbrun template ${templateId} failed: ${e.message}`);
        process.exit(1);
      }
    });
  for (const [tool, meta] of Object.entries(registry.tools)) {
    const cmd = group.command(`${tool} <caseId>`)
      .description(`pbrun ${tool} (${meta.family}${meta.validation.status === 'passed' ? ', validated' : ', untested: needs --acknowledge-untested'})`);
    addToolOptions(cmd, tool, meta);
    cmd.action(async (caseId: string) => {
      try {
        const raw = rawFromCommand(cmd, meta);
        if (raw.check) {
          console.log(JSON.stringify(buildParabricksBody(tool, caseId, raw, '0x' + '0'.repeat(40), '<signature>'), null, 2));
          return;
        }
        await parabricksSubmit((w, s) => buildParabricksBody(tool, caseId, raw, w, s), raw);
      } catch (e: any) {
        Logger.error(`pbrun ${tool} failed: ${e.message}`);
        process.exit(1);
      }
    });
  }
}
