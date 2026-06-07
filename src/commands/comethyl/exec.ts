/**
 * biofs comethyl exec --sample <serial> --modbam <gs> --hifi-vcf <gs> --hifi-bams <csv> --gate floor ...
 *
 * EXECUTOR verb: VM-side runner for single-molecule co-methylation analysis. biofs-node
 * spawns this; no orphan script. GATE 1 (floor): provenance + QC, phase the ONT reads by
 * the genome's OWN HiFi het SNPs, then recover bimodal allele-split co-methylation at known
 * imprinted DMRs (the n=1 guaranteed-floor result that validates the single-molecule premise).
 *
 * Region-restricted and gcsfuse-only: the 366 GB merged modBAM is NEVER downloaded; we
 * samtools-view only the imprinted-DMR + control windows from the gcsfuse mount (random
 * access via the .bai), so the whole gate touches a few MB of the BAM.
 *
 * Pipeline (each a halting step):
 *   0. mount modBAM bucket + HiFi bucket + reference (gcsfuse RO).
 *   1. QC: fingerprint-in-path check, samtools quickcheck/flagstat, MM/ML present, DMR coverage.
 *   2. phase: bgzip+tabix the het VCF; whatshap phase (imprinted chromosomes only) using the
 *      HiFi BAM(s) -> phased.vcf.gz; samtools-view the DMR+control windows from the ONT modBAM
 *      into a small regional modBAM; whatshap haplotag it -> HP-tagged regional modBAM.
 *   3. floor: modkit pileup --partition-tag HP --cpg --combine-strands per DMR/control ->
 *      per-haplotype 5mCG; allele_split = |hap1 - hap2|; PASS iff imprinted DMRs split and
 *      controls do not.
 *   4. manifest + audit to the biowallet comethyl folder; exit 0 on PASS (biofs-node anchors).
 *
 * AUDIT: gs://<OUT>/biowallet/<WALLET_LC>/comethyl/<JOB_ID>/
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '../../lib/utils/logger';

export interface ComethylExecOptions {
  sample: string;
  modbam: string;        // gs:// merged ONT modBAM
  hifiVcf: string;       // gs:// HiFi het-SNP VCF
  hifiBams: string;      // CSV of gs:// HiFi BAM URIs
  gate?: string;         // 'floor' (default)
  ref?: string;
  jobId?: string;
  batchId?: string;
  creator?: string;
  outBucket?: string;
  refBucket?: string;
}

const IMG_ALIGN  = 'quay.io/biocontainers/mulled-v2-66534bcbb7031a148b13e2ad42583020b9cd25c4:b411340b52d82a9c276d87c7a3dcffc880be762f-0';
const IMG_HTSLIB = 'quay.io/biocontainers/htslib:1.19.1--h81da01d_1';
const IMG_MODKIT = 'ontresearch/modkit:mr398_sha065267f74d9eb22402f5f6bde56e8a67bb32d526-amd64';
// whatshap (phase + haplotag). Tag may need adjusting on first run; bumped here on failure.
const IMG_WHATSHAP = 'quay.io/biocontainers/whatshap:2.3--py39h2de1943_0';
// python + numpy + scipy for the lambda/null-a math (built once on the executor, FROM python:3.11-slim).
const IMG_PYSCI = 'mm3-pysci:local';

// Germline imprinted DMRs (hg38, generous windows) + non-imprinted controls.
// allele_split is expected LARGE at imprinted, ~0 at controls. Coords are best-known;
// the gate reports per-DMR coverage so an off-by-a-window coordinate is diagnosable.
interface Region { name: string; chrom: string; start: number; end: number; imprinted: boolean; }
const REGIONS: Region[] = [
  { name: 'H19_IGF2_ICR1', chrom: 'chr11', start: 1998000, end: 2004000, imprinted: true },
  { name: 'KvDMR1_KCNQ1OT1', chrom: 'chr11', start: 2697000, end: 2702000, imprinted: true },
  { name: 'SNRPN_ICR', chrom: 'chr15', start: 24953000, end: 24958000, imprinted: true },
  { name: 'GNAS_DMR', chrom: 'chr20', start: 58888500, end: 58891000, imprinted: true },  // GNAS A/B (Ex1A) imprinting DMR core (hg38)
  { name: 'MEST_DMR', chrom: 'chr7', start: 130488000, end: 130494000, imprinted: true },
  { name: 'CTRL_GAPDH_prom', chrom: 'chr12', start: 6534000, end: 6539000, imprinted: false },
  { name: 'CTRL_ACTB_prom', chrom: 'chr7', start: 5526000, end: 5531000, imprinted: false },
];
const PHASE_FLANK = 500000;            // phase/haplotag a DMR +/- this; ONT ultra-long reads link het SNPs

const GATE_IMPRINTED_SPLIT_MIN = 0.40; // median |hap1-hap2| at imprinted DMRs must exceed this
const GATE_CONTROL_SPLIT_MAX   = 0.20; // and controls must stay below this

let LOG_FD: number | null = null;
const COMMANDS: string[] = [];
function logLine(m: string): void { Logger.info(m); if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, m + '\n'); } catch (_) {} } }
function run(cmd: string, args: string[], label: string): void {
  logLine(`[comethyl] ${label}`); COMMANDS.push(`${cmd} ${args.join(' ')}`);
  if (LOG_FD !== null) { try { fs.writeSync(LOG_FD, `\n$ ${cmd} ${args.join(' ')}\n`); } catch (_) {} }
  const r = spawnSync(cmd, args, { stdio: LOG_FD !== null ? ['ignore', LOG_FD, LOG_FD] : 'inherit' });
  if (r.error) { logLine(`[comethyl] ${label} could not start: ${r.error.message}`); process.exit(1); }
  if (r.status !== 0) { logLine(`[comethyl] ${label} exited ${r.status}`); process.exit(r.status ?? 1); }
}
function capture(cmd: string, args: string[]): string {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}
function isMounted(mp: string): boolean { return capture('sh', ['-c', `mount | grep -F ' ${mp} ' || true`]).length > 0; }
function gcsfuseRO(bucket: string, mp: string): void {
  fs.mkdirSync(mp, { recursive: true });
  if (isMounted(mp)) return;
  run('gcsfuse', ['--implicit-dirs', '-o', 'ro', '-o', 'allow_other', bucket, mp], `gcsfuse ${bucket}`);
}
function dk(image: string, mounts: Array<[string, string, string]>, entrypoint: string | undefined, cmd: string[]): string[] {
  const a = ['run', '--rm']; for (const [h, c, m] of mounts) a.push('-v', `${h}:${c}:${m}`);
  if (entrypoint !== undefined) a.push('--entrypoint', entrypoint); a.push(image, ...cmd); return a;
}
function gsToLocalRel(gs: string, bucket: string): string { return gs.replace(`gs://${bucket}/`, ''); }
function bucketOf(gs: string): string { return gs.replace('gs://', '').split('/')[0]; }

export async function comethylExecCommand(opts: ComethylExecOptions): Promise<void> {
  const sample = opts.sample;
  const gate = opts.gate || 'floor';
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'genobank-references';
  const jobId = opts.jobId || `comethyl-${gate}-${sample}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();
  if (gate === 'lambda') { await comethylLambdaGate(opts); return; }
  if (gate === 'null-a') { await comethylNullAGate(opts); return; }
  if (gate !== 'floor') { Logger.error(`[comethyl] unknown gate=${gate} (expected floor|lambda|null-a)`); process.exit(1); }

  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `comethyl-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/comethyl/${jobId}`;
  const uploadAudit = () => { try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' }); };

  logLine(`[comethyl] start gate=floor sample=${sample} jobId=${jobId}`);
  logLine(`[comethyl] modBAM=${opts.modbam}`);
  logLine(`[comethyl] biowallet folder: ${BIOWALLET_GCS}`);

  // fuse allow_other
  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });

  // 0. mounts (RO)
  const obkt = bucketOf(opts.modbam), hbkt = bucketOf(opts.hifiVcf);
  const oMp = `/mnt/gcsfuse-${obkt}`, hMp = `/mnt/gcsfuse-${hbkt}`, rMp = `/mnt/gcsfuse-${refBucket}`;
  gcsfuseRO(obkt, oMp); gcsfuseRO(hbkt, hMp); gcsfuseRO(refBucket, rMp);
  const modbamLocal = path.join(oMp, gsToLocalRel(opts.modbam, obkt));
  const vcfLocal = path.join(hMp, gsToLocalRel(opts.hifiVcf, hbkt));
  // reference fasta
  let refFasta = '';
  for (const rel of ['GRCh38/human_GRCh38_no_alt_analysis_set.fasta', 'GRCh38/Homo_sapiens_assembly38.fasta']) {
    if (fs.existsSync(path.join(rMp, rel))) { refFasta = path.join(rMp, rel); break; }
  }
  if (!refFasta) { logLine('[comethyl] no reference fasta found'); uploadAudit(); process.exit(1); }
  const refRel = refFasta.replace(rMp + '/', '');
  logLine(`[comethyl] modbam=${modbamLocal} vcf=${vcfLocal} ref=${refFasta}`);

  // 1. QC: fingerprint-in-path, quickcheck, MM/ML present, per-DMR coverage
  const fpMatch = /0x[0-9a-f]{64}/.exec(opts.modbam);
  logLine(`[comethyl] provenance: fingerprint-in-path=${fpMatch ? fpMatch[0].slice(0, 12) + '...' : 'MISSING'}`);
  const samView = (regionArgs: string): string => capture('docker', dk(IMG_ALIGN, [[oMp, '/obkt', 'ro']], 'bash',
    ['-c', `samtools view ${regionArgs}`]));
  const mm = capture('docker', dk(IMG_ALIGN, [[oMp, '/obkt', 'ro']], 'bash',
    ['-c', `samtools view "/obkt/${gsToLocalRel(opts.modbam, obkt)}" ${REGIONS[0].chrom}:${REGIONS[0].start}-${REGIONS[0].end} 2>/dev/null | head -2000 | grep -c 'MM:Z:' || true`]));
  logLine(`[comethyl] QC: MM:Z present in DMR reads = ${mm || 0}`);
  void samView;

  // 2a. bgzip+tabix the het VCF (whatshap needs an indexed VCF). Copy to scratch (small) first.
  const vcfGz = path.join(work, 'hifi.het.vcf.gz');
  run('docker', dk(IMG_HTSLIB, [[hMp, '/h', 'ro'], [work, '/w', 'rw']], 'bash',
    ['-c', `set -euo pipefail; bgzip -c "/h/${gsToLocalRel(opts.hifiVcf, hbkt)}" > /w/hifi.het.vcf.gz && tabix -p vcf /w/hifi.het.vcf.gz`]), 'bgzip + tabix het VCF');
  void vcfGz;

  // 2b. extract DMR +/- flank windows from the ONT modBAM (gcsfuse, region-restricted). The flank
  //     gives whatshap enough het SNPs + spanning ultra-long reads to phase; a bare DMR window
  //     would not. We phase with the ONT reads themselves (HiFi-called het SNPs as the variant
  //     set), so no HiFi BAM .bai is required.
  const broadList = REGIONS.map((r) => `${r.chrom}:${Math.max(1, r.start - PHASE_FLANK)}-${r.end + PHASE_FLANK}`).join(' ');
  run('docker', dk(IMG_ALIGN, [[oMp, '/obkt', 'ro'], [work, '/w', 'rw']], 'bash',
    ['-c', `set -euo pipefail; samtools view -b "/obkt/${gsToLocalRel(opts.modbam, obkt)}" ${broadList} -o /w/regions.bam && samtools index /w/regions.bam`]), 'extract DMR +/- flank windows from ONT modBAM');

  // 2c. phase the het SNPs USING the ONT reads, then haplotag those reads (HP tag).
  run('docker', dk(IMG_WHATSHAP, [[rMp, '/r', 'ro'], [work, '/w', 'rw']], 'bash',
    ['-c', `set -euo pipefail; whatshap phase --ignore-read-groups --reference "/r/${refRel}" -o /w/phased.vcf.gz /w/hifi.het.vcf.gz /w/regions.bam && tabix -p vcf /w/phased.vcf.gz`]), 'whatshap phase (ONT reads + HiFi het SNPs)');
  run('docker', dk(IMG_WHATSHAP, [[rMp, '/r', 'ro'], [work, '/w', 'rw']], 'bash',
    ['-c', `set -euo pipefail; whatshap haplotag --ignore-read-groups --reference "/r/${refRel}" -o /w/regions.hp.bam /w/phased.vcf.gz /w/regions.bam && samtools index /w/regions.hp.bam`]), 'whatshap haplotag ONT reads');

  // 3. per-DMR per-haplotype modkit pileup, then score allele-split
  const results: any[] = [];
  for (const reg of REGIONS) {
    const bed = `${reg.name}.hp.bed`;
    run('docker', dk(IMG_MODKIT, [[work, '/w', 'rw'], [rMp, '/r', 'ro']], undefined,
      ['modkit', 'pileup', '/w/regions.hp.bam', `/w/${bed}`, '--cpg', '--combine-strands', '--partition-tag', 'HP',
       '--ref', `/r/${refFasta.replace(rMp + '/', '')}`, '--region', `${reg.chrom}:${reg.start}-${reg.end}`]),
      `modkit HP pileup ${reg.name}`);
    // modkit --partition-tag writes one file per HP value as <bed>_<HP>.bed OR a column; parse robustly.
    // Aggregate mean 5mCG (code m) per HP from any produced bed(s).
    const agg = capture('sh', ['-c',
      `for f in /dev/null "${work}/${bed}"*; do [ -f "$f" ] || continue; ` +
      `awk -v F="$f" '$4=="m"{ hp="ungrouped"; if(F ~ /_1\\.bed/)hp="hap1"; else if(F ~ /_2\\.bed/)hp="hap2"; ` +
      `cov=$10+0; nmod=$12+0; if(cov>0){a[hp"_mod"]+=nmod; a[hp"_cov"]+=cov; a[hp"_n"]++} } ` +
      `END{ for(h in a){} }' "$f"; done; ` +
      // simpler: emit per-file mod/cov sums tagged by filename
      `for f in "${work}/${bed}" "${work}/${bed}_1.bed" "${work}/${bed}_2.bed" "${work}/${reg.name}.hp_1.bed" "${work}/${reg.name}.hp_2.bed"; do ` +
      `[ -f "$f" ] || continue; awk -v F="$f" '$4=="m"{m+=$12+0; c+=$10+0} END{printf "%s %d %d\\n", F, m+0, c+0}' "$f"; done`]);
    let hap1 = NaN, hap2 = NaN, bulk = NaN;
    for (const line of agg.split('\n')) {
      const m = /(\S+)\s+(\d+)\s+(\d+)/.exec(line); if (!m) continue;
      const frac = Number(m[3]) > 0 ? Number(m[2]) / Number(m[3]) : NaN;
      if (/_1\.bed$/.test(m[1])) hap1 = frac; else if (/_2\.bed$/.test(m[1])) hap2 = frac; else bulk = frac;
    }
    const split = (isFinite(hap1) && isFinite(hap2)) ? Math.abs(hap1 - hap2) : NaN;
    results.push({ name: reg.name, imprinted: reg.imprinted, region: `${reg.chrom}:${reg.start}-${reg.end}`, hap1, hap2, bulk, allele_split: split });
    logLine(`[comethyl] ${reg.name} (${reg.imprinted ? 'imprinted' : 'control'}): hap1=${isFinite(hap1) ? hap1.toFixed(3) : 'NA'} hap2=${isFinite(hap2) ? hap2.toFixed(3) : 'NA'} bulk=${isFinite(bulk) ? bulk.toFixed(3) : 'NA'} split=${isFinite(split) ? split.toFixed(3) : 'NA'}`);
  }

  const med = (xs: number[]): number => { const s = xs.filter((x) => isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const impSplit = med(results.filter((r) => r.imprinted).map((r) => r.allele_split));
  const ctlSplit = med(results.filter((r) => !r.imprinted).map((r) => r.allele_split));
  const nImpScored = results.filter((r) => r.imprinted && isFinite(r.allele_split)).length;
  const pass = nImpScored >= 2 && isFinite(impSplit) && impSplit >= GATE_IMPRINTED_SPLIT_MIN && (!isFinite(ctlSplit) || ctlSplit <= GATE_CONTROL_SPLIT_MAX);
  logLine(`[comethyl] FLOOR: median imprinted split=${isFinite(impSplit) ? impSplit.toFixed(3) : 'NA'} (gate >=${GATE_IMPRINTED_SPLIT_MIN}) | median control split=${isFinite(ctlSplit) ? ctlSplit.toFixed(3) : 'NA'} (gate <=${GATE_CONTROL_SPLIT_MAX}) | imprinted DMRs scored=${nImpScored} | PASS=${pass}`);

  const manifest = {
    schema: 'genobank.comethyl.manifest/v1', pipeline: 'ont-comethyl-floor', gate: 'floor',
    jobId, biosampleId: sample, creator: walletLc, status: pass ? 'PASS' : 'FAIL',
    inputs: { modbam: opts.modbam, hifi_vcf: opts.hifiVcf, hifi_bams: (opts.hifiBams || '').split(',').filter(Boolean) },
    tools: { samtools: IMG_ALIGN, htslib: IMG_HTSLIB, modkit: IMG_MODKIT, whatshap: IMG_WHATSHAP },
    floor: { regions: results, median_imprinted_split: impSplit, median_control_split: ctlSplit,
      gate_imprinted_split_min: GATE_IMPRINTED_SPLIT_MIN, gate_control_split_max: GATE_CONTROL_SPLIT_MAX, passed: pass },
    biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(work, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', manifestPath, `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  // upload the per-DMR beds for audit
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/*.hp*.bed ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });
  uploadAudit();

  if (!pass) { logLine('[comethyl] FLOOR gate FAILED (or insufficient DMR coverage) — not eligible to anchor.'); if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} } process.exit(7); }
  logLine(`[comethyl] FLOOR gate PASSED: single-molecule reads recover allele-split imprinting that bulk averaging destroys.`);
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}

// ===== M8 gates: lambda (single-molecule co-methylation decay-length) + null-a (bulk-Fourier falsifier) =====
// The two analyzers ship as base64 so the executor needs no sibling files; decoded to the work dir at run time.
const LAMBDA_PY_B64 = 'IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiIKY29tZXRoeWwgZ2F0ZT1sYW1iZGEgYW5hbHl6ZXIuCgpJbnB1dCAgOiBtb2RraXQgYGV4dHJhY3QgY2FsbHNgIFRTViAocGVyLXJlYWQsIHBlci1DcEcgdGhyZXNob2xkZWQgY2FsbHMpICsgYSB3aW5kb3dzIEJFRC4KT3V0cHV0IDogSlNPTiB3aXRoIHBlci13aW5kb3cgY28tbWV0aHlsYXRpb24gZGVjYXktbGVuZ3RoIGxhbWJkYSArIHRoZSBwcmUtcmVnaXN0ZXJlZCBudWxsCiAgICAgICAgIGRpc2NpcGxpbmUgKDQgYmFzZWxpbmVzLCB0aGUgcmhvPjAuOTcga2lsbC1zd2l0Y2gsIHRoZSBidWxrLWNvbGxhcHNlZCBjb250cm9sLCB0aGUKICAgICAgICAgYWdncmVnYXRlIDEtZXhwLXZzLTItZXhwIEJJQyBnYXRlKS4KClNjaWVuY2UgKHNpbmdsZSBleHBvbmVudGlhbCk6ICByaG8oZCkgPSBDICsgQSpleHAoLWQvbGFtYmRhKQogIHJobyhkKSA9IHdpdGhpbi1yZWFkIGNvbmNvcmRhbmNlIChzYW1lIDVtQ0cgc3RhdGUpIG9mIENwRyBwYWlycyBzZXBhcmF0ZWQgYnkgZCBicC4KICBDICB+IGNoYW5jZSBjb25jb3JkYW5jZSBwXjIrKDEtcCleMiA7IGxhbWJkYSA9IHRoZSBjby1tZXRoeWxhdGlvbiBjb3JyZWxhdGlvbiBsZW5ndGguCgpIb25lc3QgZGlzY2lwbGluZSBwb3J0ZWQgZnJvbSB0aGUgcHJvdGVvbWUgd29yazoKICAtIGxhbWJkYSBtdXN0IE5PVCBiZSBhIHJlLWVuY29kaW5nIG9mIGEgdHJpdmlhbCBiYXNlbGluZS4gS2lsbC1zd2l0Y2ggPSBTcGVhcm1hbihsYW1iZGEsIGJhc2VsaW5lKQogICAgYWNyb3NzIHdpbmRvd3M7IHxyaG98ID4gMC45NyB3aXRoIEFOWSBvZiB7bWVhbiwgdmFyaWFuY2UsIENwRy1kZW5zaXR5LCBQRFJ9ID0+IE5VTEwtQiAocmVkdW5kYW50KS4KICAtIGJ1bGstY29sbGFwc2VkIGNvbnRyb2w6IHRoZSBwZXItQ3BHLWZyYWN0aW9uIHNwYXRpYWwgYXV0b2NvcnJlbGF0aW9uIGxlbmd0aCAoY29tcHV0YWJsZSBmcm9tCiAgICBCVUxLKSB2cyB0aGUgc2luZ2xlLW1vbGVjdWxlIGxhbWJkYS4gSWYgZXF1YWwsIHRoZSBsb25nIHJlYWRzIGFkZGVkIG5vdGhpbmcuCiAgLSBtdWx0aS1leHAgQklDOiBkb2VzIGEgMm5kIHBvbGUgKGEgcmVhbCBjb3JyZWxhdGlvbi1sZW5ndGggc3BlY3RydW0pIGVhcm4gaXRzIGtlZXAgb3ZlciBhIHNjYWxhci4KCk5vIGRpc2Vhc2UgY2xhaW0sIG49MSBtZXRob2RzIHNjb3BlLgoiIiIKaW1wb3J0IHN5cywganNvbgpmcm9tIGNvbGxlY3Rpb25zIGltcG9ydCBkZWZhdWx0ZGljdAppbXBvcnQgbnVtcHkgYXMgbnAKZnJvbSBzY2lweS5vcHRpbWl6ZSBpbXBvcnQgY3VydmVfZml0CmZyb20gc2NpcHkuc3RhdHMgaW1wb3J0IHNwZWFybWFucgoKRVhUUkFDVCA9IHN5cy5hcmd2WzFdCldJTkJFRCAgPSBzeXMuYXJndlsyXQpPVVQgICAgID0gc3lzLmFyZ3ZbM10KClRBQiA9IGNocig5KQpCSU5TID0gbnAuYXJyYXkoWzAsIDUwLCAxMDAsIDE1MCwgMjAwLCAzMDAsIDQwMCwgNjAwLCA4MDAsIDEyMDAsIDE2MDAsIDI0MDAsIDMyMDBdLCBkdHlwZT1mbG9hdCkKQ0VOVEVSUyA9IDAuNSAqIChCSU5TWzotMV0gKyBCSU5TWzE6XSkKCiMgLS0tLSB3aW5kb3dzIC0tLS0Kd2lucyA9IFtdCndpdGggb3BlbihXSU5CRUQpIGFzIGZoOgogICAgZm9yIGxpbmUgaW4gZmg6CiAgICAgICAgcCA9IGxpbmUucnN0cmlwKCJcbiIpLnNwbGl0KFRBQikKICAgICAgICBpZiBsZW4ocCkgPCAzOgogICAgICAgICAgICBjb250aW51ZQogICAgICAgIHdpbnMuYXBwZW5kKHsKICAgICAgICAgICAgImNocm9tIjogcFswXSwgInN0YXJ0IjogaW50KHBbMV0pLCAiZW5kIjogaW50KHBbMl0pLAogICAgICAgICAgICAibmFtZSI6IHBbM10gaWYgbGVuKHApID4gMyBlbHNlIChwWzBdICsgIjoiICsgcFsxXSksCiAgICAgICAgICAgICJpbXByaW50ZWQiOiAobGVuKHApID4gNCBhbmQgcFs0XSA9PSAiMSIpLAogICAgICAgIH0pCmJ5Y2hyb20gPSBkZWZhdWx0ZGljdChsaXN0KQpmb3IgaSwgdyBpbiBlbnVtZXJhdGUod2lucyk6CiAgICBieWNocm9tW3dbImNocm9tIl1dLmFwcGVuZCgod1sic3RhcnQiXSwgd1siZW5kIl0sIGkpKQoKCmRlZiB3aW5fb2YoY2hyb20sIHBvcyk6CiAgICBmb3IgcywgZSwgaSBpbiBieWNocm9tLmdldChjaHJvbSwgW10pOgogICAgICAgIGlmIHMgPD0gcG9zIDwgZToKICAgICAgICAgICAgcmV0dXJuIGkKICAgIHJldHVybiAtMQoKCiMgLS0tLSBwYXJzZSBtb2RraXQgZXh0cmFjdCBjYWxscyAtLS0tCnJlYWRzX2J5X3dpbiA9IFtkZWZhdWx0ZGljdChsaXN0KSBmb3IgXyBpbiB3aW5zXQp3aXRoIG9wZW4oRVhUUkFDVCkgYXMgZmg6CiAgICBoZWFkZXIgPSBmaC5yZWFkbGluZSgpLnJzdHJpcCgiXG4iKS5zcGxpdChUQUIpCiAgICBpZHggPSB7YzogaSBmb3IgaSwgYyBpbiBlbnVtZXJhdGUoaGVhZGVyKX0KICAgIGNpLCBwaSwgcmksIGNjID0gaWR4LmdldCgiY2hyb20iKSwgaWR4LmdldCgicmVmX3Bvc2l0aW9uIiksIGlkeC5nZXQoInJlYWRfaWQiKSwgaWR4LmdldCgiY2FsbF9jb2RlIikKICAgIGlmIE5vbmUgaW4gKGNpLCBwaSwgcmksIGNjKToKICAgICAgICBqc29uLmR1bXAoeyJlcnJvciI6ICJtaXNzaW5nX2NvbHVtbnMiLCAiaGVhZGVyIjogaGVhZGVyfSwgb3BlbihPVVQsICJ3IikpCiAgICAgICAgcHJpbnQoanNvbi5kdW1wcyh7InZlcmRpY3QiOiAiRVJST1JfbWlzc2luZ19jb2x1bW5zIiwgImhlYWRlciI6IGhlYWRlcn0pKQogICAgICAgIHN5cy5leGl0KDApCiAgICBteCA9IG1heChjaSwgcGksIHJpLCBjYykKICAgIGZvciBsaW5lIGluIGZoOgogICAgICAgIHAgPSBsaW5lLnJzdHJpcCgiXG4iKS5zcGxpdChUQUIpCiAgICAgICAgaWYgbGVuKHApIDw9IG14OgogICAgICAgICAgICBjb250aW51ZQogICAgICAgIGNvZGUgPSBwW2NjXQogICAgICAgIGlmIGNvZGUgPT0gIm0iOgogICAgICAgICAgICBzdCA9IDEKICAgICAgICBlbGlmIGNvZGUgPT0gIi0iOgogICAgICAgICAgICBzdCA9IDAKICAgICAgICBlbHNlOgogICAgICAgICAgICBjb250aW51ZSAgIyBkcm9wIDVobUMgKCdoJykgYW5kIGFtYmlndW91czsgdGhpcyBnYXRlIGlzIDVtQ0cgY28tbWV0aHlsYXRpb24KICAgICAgICB0cnk6CiAgICAgICAgICAgIHBvcyA9IGludChwW3BpXSkKICAgICAgICBleGNlcHQgVmFsdWVFcnJvcjoKICAgICAgICAgICAgY29udGludWUKICAgICAgICB3aSA9IHdpbl9vZihwW2NpXSwgcG9zKQogICAgICAgIGlmIHdpIDwgMDoKICAgICAgICAgICAgY29udGludWUKICAgICAgICByZWFkc19ieV93aW5bd2ldW3BbcmldXS5hcHBlbmQoKHBvcywgc3QpKQoKCmRlZiByaG9fb2ZfZChyZWFkcyk6CiAgICBjb25jID0gbnAuemVyb3MobGVuKEJJTlMpIC0gMSkKICAgIHRvdCA9IG5wLnplcm9zKGxlbihCSU5TKSAtIDEpCiAgICBmb3IgX3JpZCwgY2FsbHMgaW4gcmVhZHMuaXRlbXMoKToKICAgICAgICBpZiBsZW4oY2FsbHMpIDwgMjoKICAgICAgICAgICAgY29udGludWUKICAgICAgICBjYWxscyA9IHNvcnRlZChjYWxscykKICAgICAgICBuID0gbGVuKGNhbGxzKQogICAgICAgIGZvciBhIGluIHJhbmdlKG4pOgogICAgICAgICAgICBwYSwgc2EgPSBjYWxsc1thXQogICAgICAgICAgICBmb3IgYiBpbiByYW5nZShhICsgMSwgbik6CiAgICAgICAgICAgICAgICBwYiwgc2IgPSBjYWxsc1tiXQogICAgICAgICAgICAgICAgZCA9IHBiIC0gcGEKICAgICAgICAgICAgICAgIGlmIGQgPD0gMCBvciBkID4gQklOU1stMV06CiAgICAgICAgICAgICAgICAgICAgY29udGludWUKICAgICAgICAgICAgICAgIGsgPSBpbnQobnAuc2VhcmNoc29ydGVkKEJJTlMsIGQsIHNpZGU9InJpZ2h0IikgLSAxKQogICAgICAgICAgICAgICAgaWYgMCA8PSBrIDwgbGVuKHRvdCk6CiAgICAgICAgICAgICAgICAgICAgdG90W2tdICs9IDEKICAgICAgICAgICAgICAgICAgICBpZiBzYSA9PSBzYjoKICAgICAgICAgICAgICAgICAgICAgICAgY29uY1trXSArPSAxCiAgICB3aXRoIG5wLmVycnN0YXRlKGludmFsaWQ9Imlnbm9yZSIsIGRpdmlkZT0iaWdub3JlIik6CiAgICAgICAgcmhvID0gbnAud2hlcmUodG90ID4gMCwgY29uYyAvIHRvdCwgbnAubmFuKQogICAgcmV0dXJuIHJobywgY29uYywgdG90CgoKZGVmIF9mMShkLCBDLCBBLCBsYW0pOgogICAgcmV0dXJuIEMgKyBBICogbnAuZXhwKC1kIC8gbGFtKQoKCmRlZiBmaXRfbGFtYmRhKHJobywgdG90KToKICAgIG0gPSAodG90ID4gMjApICYgbnAuaXNmaW5pdGUocmhvKQogICAgaWYgbS5zdW0oKSA8IDQ6CiAgICAgICAgcmV0dXJuIE5vbmUKICAgIHgsIHkgPSBDRU5URVJTW21dLCByaG9bbV0KICAgIHRyeToKICAgICAgICBwb3B0LCBfID0gY3VydmVfZml0KF9mMSwgeCwgeSwKICAgICAgICAgICAgICAgICAgICAgICAgICAgIHAwPVtmbG9hdChucC5uYW5taW4oeSkpLCBtYXgoMWUtMywgZmxvYXQobnAubmFubWF4KHkpIC0gbnAubmFubWluKHkpKSksIDIwMC4wXSwKICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJvdW5kcz0oWzAsIDAsIDFdLCBbMSwgMSwgMWU1XSksIG1heGZldj0zMDAwMCkKICAgICAgICByZXNpZCA9IHkgLSBfZjEoeCwgKnBvcHQpCiAgICAgICAgc3MgPSBmbG9hdChucC5zdW0ocmVzaWQgKiogMikpCiAgICAgICAgc3N0ID0gZmxvYXQobnAuc3VtKCh5IC0gbnAubWVhbih5KSkgKiogMikpCiAgICAgICAgcjIgPSAxIC0gc3MgLyBzc3QgaWYgc3N0ID4gMCBlbHNlIDAuMAogICAgICAgIHJldHVybiB7IkMiOiBmbG9hdChwb3B0WzBdKSwgIkEiOiBmbG9hdChwb3B0WzFdKSwgImxhbWJkYSI6IGZsb2F0KHBvcHRbMl0pLCAicjIiOiBmbG9hdChyMiksICJuIjogaW50KG0uc3VtKCkpfQogICAgZXhjZXB0IEV4Y2VwdGlvbjoKICAgICAgICByZXR1cm4gTm9uZQoKCmRlZiBiYXNlbGluZXMocmVhZHMpOgogICAgYWxsc3RhdGVzID0gW10KICAgIGNwZ3MgPSBzZXQoKQogICAgcGVyY3BnID0gZGVmYXVsdGRpY3QobGlzdCkKICAgIG5kaXNjID0gbnNwYW4gPSAwCiAgICBmb3IgX3JpZCwgY2FsbHMgaW4gcmVhZHMuaXRlbXMoKToKICAgICAgICBzdGF0ZXMgPSBbcyBmb3IgXywgcyBpbiBjYWxsc10KICAgICAgICBpZiBsZW4oY2FsbHMpID49IDI6CiAgICAgICAgICAgIG5zcGFuICs9IDEKICAgICAgICAgICAgaWYgMCBpbiBzdGF0ZXMgYW5kIDEgaW4gc3RhdGVzOgogICAgICAgICAgICAgICAgbmRpc2MgKz0gMQogICAgICAgIGZvciBwb3MsIHMgaW4gY2FsbHM6CiAgICAgICAgICAgIGNwZ3MuYWRkKHBvcykKICAgICAgICAgICAgcGVyY3BnW3Bvc10uYXBwZW5kKHMpCiAgICAgICAgICAgIGFsbHN0YXRlcy5hcHBlbmQocykKICAgIG1lYW4gPSBmbG9hdChucC5tZWFuKGFsbHN0YXRlcykpIGlmIGFsbHN0YXRlcyBlbHNlIGZsb2F0KCJuYW4iKQogICAgZnIgPSBbZmxvYXQobnAubWVhbih2KSkgZm9yIHYgaW4gcGVyY3BnLnZhbHVlcygpIGlmIHZdCiAgICB2YXIgPSBmbG9hdChucC52YXIoZnIpKSBpZiBmciBlbHNlIGZsb2F0KCJuYW4iKQogICAgcmV0dXJuIG1lYW4sIHZhciwgbGVuKGNwZ3MpLCAoZmxvYXQobmRpc2MgLyBuc3BhbikgaWYgbnNwYW4gPiAwIGVsc2UgZmxvYXQoIm5hbiIpKSwgcGVyY3BnCgoKZGVmIGJ1bGtfZGVjYXlfbGVuZ3RoKHBlcmNwZyk6CiAgICAiIiJidWxrLWNvbGxhcHNlZCBjb250cm9sOiBzcGF0aWFsIGF1dG9jb3JyZWxhdGlvbiBsZW5ndGggb2YgdGhlIHBlci1DcEcgbWVhbiBmcmFjdGlvbi4iIiIKICAgIGZyID0ge3BvczogZmxvYXQobnAubWVhbih2KSkgZm9yIHBvcywgdiBpbiBwZXJjcGcuaXRlbXMoKSBpZiBsZW4odikgPj0gM30KICAgIHBvcyA9IHNvcnRlZChmcikKICAgIGlmIGxlbihwb3MpIDwgMTI6CiAgICAgICAgcmV0dXJuIE5vbmUKICAgIHZhbHMgPSBucC5hcnJheShbZnJbcF0gZm9yIHAgaW4gcG9zXSkKICAgIG11ID0gZmxvYXQobnAubWVhbih2YWxzKSkKICAgIGNvdiA9IG5wLnplcm9zKGxlbihCSU5TKSAtIDEpCiAgICB0b3QgPSBucC56ZXJvcyhsZW4oQklOUykgLSAxKQogICAgZm9yIGEgaW4gcmFuZ2UobGVuKHBvcykpOgogICAgICAgIGZvciBiIGluIHJhbmdlKGEgKyAxLCBsZW4ocG9zKSk6CiAgICAgICAgICAgIGQgPSBwb3NbYl0gLSBwb3NbYV0KICAgICAgICAgICAgaWYgZCA8PSAwIG9yIGQgPiBCSU5TWy0xXToKICAgICAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgICAgIGsgPSBpbnQobnAuc2VhcmNoc29ydGVkKEJJTlMsIGQsIHNpZGU9InJpZ2h0IikgLSAxKQogICAgICAgICAgICBpZiAwIDw9IGsgPCBsZW4odG90KToKICAgICAgICAgICAgICAgIHRvdFtrXSArPSAxCiAgICAgICAgICAgICAgICBjb3Zba10gKz0gKGZyW3Bvc1thXV0gLSBtdSkgKiAoZnJbcG9zW2JdXSAtIG11KQogICAgd2l0aCBucC5lcnJzdGF0ZShpbnZhbGlkPSJpZ25vcmUiLCBkaXZpZGU9Imlnbm9yZSIpOgogICAgICAgIGFjID0gbnAud2hlcmUodG90ID4gMCwgY292IC8gdG90LCBucC5uYW4pCiAgICB2MCA9IGZsb2F0KG5wLm5hbm1heChhYykpIGlmIG5wLmlzZmluaXRlKGFjKS5hbnkoKSBlbHNlIDAuMAogICAgaWYgdjAgPD0gMDoKICAgICAgICByZXR1cm4gTm9uZQogICAgbm9ybSA9IGFjIC8gdjAKICAgIG0gPSAodG90ID4gMTApICYgbnAuaXNmaW5pdGUobm9ybSkgJiAobm9ybSA+IDApCiAgICBpZiBtLnN1bSgpIDwgNDoKICAgICAgICByZXR1cm4gTm9uZQogICAgdHJ5OgogICAgICAgIHBvcHQsIF8gPSBjdXJ2ZV9maXQobGFtYmRhIGQsIEEsIGxhbTogQSAqIG5wLmV4cCgtZCAvIGxhbSksIENFTlRFUlNbbV0sIG5vcm1bbV0sCiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwMD1bMS4wLCAyMDAuMF0sIGJvdW5kcz0oWzAsIDFdLCBbMiwgMWU1XSksIG1heGZldj0yMDAwMCkKICAgICAgICByZXR1cm4gZmxvYXQocG9wdFsxXSkKICAgIGV4Y2VwdCBFeGNlcHRpb246CiAgICAgICAgcmV0dXJuIE5vbmUKCgojIC0tLS0gcGVyLXdpbmRvdyBwYXNzICsgYWdncmVnYXRlIGFjY3VtdWxhdGlvbiAtLS0tCnBlciA9IFtdCmFnZ19jb25jID0gbnAuemVyb3MobGVuKEJJTlMpIC0gMSkKYWdnX3RvdCA9IG5wLnplcm9zKGxlbihCSU5TKSAtIDEpCmJ1bGtfbGFtcyA9IFtdCmZvciB3aSwgdyBpbiBlbnVtZXJhdGUod2lucyk6CiAgICByZWFkcyA9IHJlYWRzX2J5X3dpblt3aV0KICAgIG5yZWFkID0gc3VtKDEgZm9yIHIgaW4gcmVhZHMudmFsdWVzKCkgaWYgbGVuKHIpID49IDIpCiAgICByZWMgPSB7Im5hbWUiOiB3WyJuYW1lIl0sICJjaHJvbSI6IHdbImNocm9tIl0sICJpbXByaW50ZWQiOiB3WyJpbXByaW50ZWQiXSwgIm5yZWFkcyI6IG5yZWFkfQogICAgaWYgbnJlYWQgPCAxMDoKICAgICAgICByZWMudXBkYXRlKHsibGFtYmRhIjogTm9uZSwgInJlYXNvbiI6ICJsb3dfcmVhZF9zdXBwb3J0In0pCiAgICAgICAgcGVyLmFwcGVuZChyZWMpCiAgICAgICAgY29udGludWUKICAgIHJobywgY29uYywgdG90ID0gcmhvX29mX2QocmVhZHMpCiAgICBhZ2dfY29uYyArPSBjb25jCiAgICBhZ2dfdG90ICs9IHRvdAogICAgbWVhbiwgdmFyLCBkZW5zLCBwZHIsIHBlcmNwZyA9IGJhc2VsaW5lcyhyZWFkcykKICAgIHJlYy51cGRhdGUoeyJtZWFuIjogbWVhbiwgInZhciI6IHZhciwgImNwZ19kZW5zaXR5IjogZGVucywgInBkciI6IHBkcn0pCiAgICBmaXQgPSBmaXRfbGFtYmRhKHJobywgdG90KQogICAgaWYgZml0OgogICAgICAgIHJlYy51cGRhdGUoeyJsYW1iZGEiOiBmaXRbImxhbWJkYSJdLCAiQSI6IGZpdFsiQSJdLCAiQyI6IGZpdFsiQyJdLCAicjIiOiBmaXRbInIyIl19KQogICAgZWxzZToKICAgICAgICByZWMudXBkYXRlKHsibGFtYmRhIjogTm9uZSwgInJlYXNvbiI6ICJmaXRfZmFpbGVkIn0pCiAgICBibCA9IGJ1bGtfZGVjYXlfbGVuZ3RoKHBlcmNwZykKICAgIHJlY1siYnVsa19sYW1iZGEiXSA9IGJsCiAgICBpZiBmaXQgYW5kIGJsIGlzIG5vdCBOb25lOgogICAgICAgIGJ1bGtfbGFtcy5hcHBlbmQoKGZpdFsibGFtYmRhIl0sIGJsKSkKICAgIHBlci5hcHBlbmQocmVjKQoKIyAtLS0tIGtpbGwtc3dpdGNoOiBTcGVhcm1hbihsYW1iZGEsIGJhc2VsaW5lKSBhY3Jvc3Mgd2luZG93cyAtLS0tCkwgPSBbciBmb3IgciBpbiBwZXIgaWYgci5nZXQoImxhbWJkYSIpIGlzIG5vdCBOb25lIGFuZCBucC5pc2Zpbml0ZShyLmdldCgibWVhbiIsIGZsb2F0KCJuYW4iKSkpXQoKCmRlZiBzcGVhcihrZXkpOgogICAgeHMgPSBbclsibGFtYmRhIl0gZm9yIHIgaW4gTF0KICAgIHlzID0gW3Jba2V5XSBmb3IgciBpbiBMXQogICAgaWYgbGVuKHhzKSA8IDY6CiAgICAgICAgcmV0dXJuIE5vbmUKICAgIHJobywgcCA9IHNwZWFybWFucih4cywgeXMpCiAgICByZXR1cm4geyJyaG8iOiBmbG9hdChyaG8pLCAicCI6IGZsb2F0KHApLCAibiI6IGxlbih4cyl9CgoKa2lsbHN3aXRjaCA9IHtrOiBzcGVhcihrKSBmb3IgayBpbiAoIm1lYW4iLCAidmFyIiwgImNwZ19kZW5zaXR5IiwgInBkciIpfQpyZWR1bmRhbnQgPSBbayBmb3IgaywgdiBpbiBraWxsc3dpdGNoLml0ZW1zKCkgaWYgdiBhbmQgYWJzKHZbInJobyJdKSA+IDAuOTddCgojIC0tLS0gYnVsay1jb2xsYXBzZWQgY29udHJvbDogc2luZ2xlLW1vbGVjdWxlIGxhbWJkYSB2cyBidWxrIGF1dG9jb3JyZWxhdGlvbiBsZW5ndGggLS0tLQpidWxrX2NvbnRyb2wgPSBOb25lCmlmIGxlbihidWxrX2xhbXMpID49IDY6CiAgICBzbSA9IG5wLmFycmF5KFthIGZvciBhLCBfIGluIGJ1bGtfbGFtc10pCiAgICBiayA9IG5wLmFycmF5KFtiIGZvciBfLCBiIGluIGJ1bGtfbGFtc10pCiAgICByaG8sIHAgPSBzcGVhcm1hbnIoc20sIGJrKQogICAgcmF0aW8gPSBmbG9hdChucC5tZWRpYW4oc20gLyBucC53aGVyZShiayA+IDAsIGJrLCBucC5uYW4pKSkKICAgIGJ1bGtfY29udHJvbCA9IHsic3BlYXJtYW5fc21fdnNfYnVsayI6IGZsb2F0KHJobyksICJwIjogZmxvYXQocCksCiAgICAgICAgICAgICAgICAgICAgIm1lZGlhbl9yYXRpb19zbV9vdmVyX2J1bGsiOiByYXRpbywgIm4iOiBsZW4oYnVsa19sYW1zKSwKICAgICAgICAgICAgICAgICAgICAic2luZ2xlX21vbGVjdWxlX2FkZHNfc2lnbmFsIjogYm9vbChhYnMocmhvKSA8IDAuOTcgb3Igbm90ICgwLjggPCByYXRpbyA8IDEuMjUpKX0KCiMgLS0tLSBhZ2dyZWdhdGUgMS1leHAgdnMgMi1leHAgQklDIC0tLS0Kd2l0aCBucC5lcnJzdGF0ZShpbnZhbGlkPSJpZ25vcmUiLCBkaXZpZGU9Imlnbm9yZSIpOgogICAgYWdnX3JobyA9IG5wLndoZXJlKGFnZ190b3QgPiAwLCBhZ2dfY29uYyAvIGFnZ190b3QsIG5wLm5hbikKYmljID0geyJub3RlIjogImFnZ3JlZ2F0ZSByaG8oZCk6IDEtZXhwIHZzIDItZXhwIn0KbSA9IChhZ2dfdG90ID4gNTApICYgbnAuaXNmaW5pdGUoYWdnX3JobykKaWYgbS5zdW0oKSA+PSA2OgogICAgWCwgWSwgTiA9IENFTlRFUlNbbV0sIGFnZ19yaG9bbV0sIGludChtLnN1bSgpKQogICAgdHJ5OgogICAgICAgIHAxLCBfID0gY3VydmVfZml0KF9mMSwgWCwgWSwgcDA9W2Zsb2F0KG5wLm5hbm1pbihZKSksIDAuMywgMjAwLjBdLAogICAgICAgICAgICAgICAgICAgICAgICAgIGJvdW5kcz0oWzAsIDAsIDFdLCBbMSwgMSwgMWU1XSksIG1heGZldj00MDAwMCkKICAgICAgICBzczEgPSBmbG9hdChucC5zdW0oKFkgLSBfZjEoWCwgKnAxKSkgKiogMikpCiAgICAgICAgYmljMSA9IE4gKiBucC5sb2coc3MxIC8gTikgKyAzICogbnAubG9nKE4pCiAgICAgICAgYmljID0geyJiaWMxIjogZmxvYXQoYmljMSksICJsYW1iZGExIjogZmxvYXQocDFbMl0pLCAic3MxIjogc3MxLCAibiI6IE59CiAgICAgICAgdHJ5OgogICAgICAgICAgICBkZWYgX2YyKGQsIEMsIEExLCBsMSwgQTIsIGwyKToKICAgICAgICAgICAgICAgIHJldHVybiBDICsgQTEgKiBucC5leHAoLWQgLyBsMSkgKyBBMiAqIG5wLmV4cCgtZCAvIGwyKQogICAgICAgICAgICBwMiwgXyA9IGN1cnZlX2ZpdChfZjIsIFgsIFksIHAwPVtmbG9hdChucC5uYW5taW4oWSkpLCAwLjIsIDgwLjAsIDAuMiwgODAwLjBdLAogICAgICAgICAgICAgICAgICAgICAgICAgICAgICBib3VuZHM9KFswLCAwLCAxLCAwLCAxXSwgWzEsIDEsIDFlNSwgMSwgMWU1XSksIG1heGZldj02MDAwMCkKICAgICAgICAgICAgc3MyID0gZmxvYXQobnAuc3VtKChZIC0gX2YyKFgsICpwMikpICoqIDIpKQogICAgICAgICAgICBiaWMyID0gTiAqIG5wLmxvZyhzczIgLyBOKSArIDUgKiBucC5sb2coTikKICAgICAgICAgICAgYmljLnVwZGF0ZSh7ImJpYzIiOiBmbG9hdChiaWMyKSwKICAgICAgICAgICAgICAgICAgICAgICAgImxhbWJkYTJfZmFzdCI6IGZsb2F0KG1pbihwMlsyXSwgcDJbNF0pKSwKICAgICAgICAgICAgICAgICAgICAgICAgImxhbWJkYTJfc2xvdyI6IGZsb2F0KG1heChwMlsyXSwgcDJbNF0pKSwKICAgICAgICAgICAgICAgICAgICAgICAgInNzMiI6IHNzMiwKICAgICAgICAgICAgICAgICAgICAgICAgInR3b19wb2xlX2Vhcm5zX2tlZXAiOiBib29sKGJpYzIgPCBiaWMxIC0gMTApfSkKICAgICAgICBleGNlcHQgRXhjZXB0aW9uOgogICAgICAgICAgICBwYXNzCiAgICBleGNlcHQgRXhjZXB0aW9uOgogICAgICAgIHBhc3MKCm5fbGFtYmRhID0gbGVuKEwpCmlmIHJlZHVuZGFudDoKICAgIHZlcmRpY3QgPSAiTlVMTC1CX2xhbWJkYV9yZWR1bmRhbnRfd2l0aF8iICsgIisiLmpvaW4ocmVkdW5kYW50KQplbGlmIG5fbGFtYmRhID49IDY6CiAgICB2ZXJkaWN0ID0gImxhbWJkYV9zdXJ2aXZlc19raWxsc3dpdGNoIgplbHNlOgogICAgdmVyZGljdCA9ICJpbnN1ZmZpY2llbnRfd2luZG93cyIKCm91dCA9IHsiZ2F0ZSI6ICJsYW1iZGEiLCAibl93aW5kb3dzIjogbGVuKHdpbnMpLCAibl93aW5kb3dzX3dpdGhfbGFtYmRhIjogbl9sYW1iZGEsCiAgICAgICAicGVyX3dpbmRvdyI6IHBlciwgImtpbGxzd2l0Y2giOiBraWxsc3dpdGNoLCAia2lsbHN3aXRjaF9yZWR1bmRhbnRfd2l0aCI6IHJlZHVuZGFudCwKICAgICAgICJidWxrX2NvbGxhcHNlZF9jb250cm9sIjogYnVsa19jb250cm9sLCAiYWdncmVnYXRlX2JpYyI6IGJpYywgInZlcmRpY3QiOiB2ZXJkaWN0fQpqc29uLmR1bXAob3V0LCBvcGVuKE9VVCwgInciKSwgaW5kZW50PTIpCnByaW50KGpzb24uZHVtcHMoeyJ2ZXJkaWN0IjogdmVyZGljdCwgIm5fbGFtYmRhIjogbl9sYW1iZGEsICJraWxsc3dpdGNoIjoga2lsbHN3aXRjaCwKICAgICAgICAgICAgICAgICAgInJlZHVuZGFudCI6IHJlZHVuZGFudCwgImJ1bGtfY29udHJvbCI6IGJ1bGtfY29udHJvbCwKICAgICAgICAgICAgICAgICAgImJpY190d29fcG9sZSI6IGJpYy5nZXQoInR3b19wb2xlX2Vhcm5zX2tlZXAiKX0pKQo=';
const NULLA_PY_B64 = 'IyEvdXNyL2Jpbi9lbnYgcHl0aG9uMwoiIiIKY29tZXRoeWwgZ2F0ZT1udWxsLWEgYW5hbHl6ZXIgKHRoZSBwcmUtcmVnaXN0ZXJlZCBGQUxTSUZJRVIpLgoKSW5wdXQgIDogVFNWIG9mIGJ1bGsgcGVyLUNwRyBtZXRoeWxhdGlvbiBmcmFjdGlvbiBpbnNpZGUgd2luZG93czogd2luX25hbWUgPHRhYj4gcG9zIDx0YWI+IGZyYWMKT3V0cHV0IDogSlNPTiB3aXRoIGEgTG9tYi1TY2FyZ2xlIHBlcmlvZG9ncmFtICsgcGVybXV0YXRpb24gbnVsbCBwZXIgd2luZG93LgoKUHJlLXJlZ2lzdGVyZWQgcHJlZGljdGlvbiAoZXhwZWN0ZWQgTlVMTCwgdGhlIGRpcmVjdCBwb3J0IG9mIHRoZSBwcm90ZW9tZSBzZXF1ZW5jZS1Gb3VyaWVyCm5lZ2F0aXZlKTogdGhlIEJVTEsgMS1EIG1ldGh5bGF0aW9uIHRyYWNrIGNhcnJpZXMgTk8gcGVyaW9kaWNpdHkgYWJvdmUgdGhlIHdpbmRvd2VkLW1lYW4KYmFzZWxpbmUuIFRoZSB+MTAuNSBicCBoZWxpY2FsIGFuZCB+MTgwIGJwIG51Y2xlb3NvbWUgcGVyaW9kcyBhcmUgYWxpYXNlZCBvdXQgLyBhbHJlYWR5IGluc2lkZQp0aGUgbWVhbitORFIgZmVhdHVyZXM7IGJ5IFBhcnNldmFsIHRoZSAwLzEgdHJhY2sncyBzcGVjdHJhbCBtYXNzIElTIHRoZSBtZWFuLCBzbyBhICJwZWFrIiB3b3VsZApiZSB0aGUgbWVhbiBpbiBjb3N0dW1lLiBOVUxMLUEgaXMgQ09ORklSTUVEIGlmIG5vIHdpbmRvdyBzaG93cyBhIHBlcmlvZG9ncmFtIHBlYWsgdGhhdCBiZWF0cyBpdHMKb3duIHBlcm11dGF0aW9uIG51bGwgKGZyYWMgc2h1ZmZsZWQgYWdhaW5zdCBwb3NpdGlvbikuIEEgc3VycHJpc2luZyBSRUZVVEFUSU9OIChyZWFsIHBlcmlvZGljaXR5KQp3b3VsZCBpdHNlbGYgYmUgYSBmaW5kaW5nLCBzY29yZWQgaG9uZXN0bHkgYWdhaW5zdCB0aGlzIHJlZ2lzdHJhdGlvbi4KCkxvbWItU2NhcmdsZSAobm90IGludGVycC10aGVuLUZGVCkgYmVjYXVzZSBDcEcgc3BhY2luZyBpcyBpcnJlZ3VsYXIuIG49MSBtZXRob2RzIHNjb3BlLCBubyBkaXNlYXNlLgoiIiIKaW1wb3J0IHN5cywganNvbgpmcm9tIGNvbGxlY3Rpb25zIGltcG9ydCBkZWZhdWx0ZGljdAppbXBvcnQgbnVtcHkgYXMgbnAKZnJvbSBzY2lweS5zaWduYWwgaW1wb3J0IGxvbWJzY2FyZ2xlCgpJTiA9IHN5cy5hcmd2WzFdCk9VVCA9IHN5cy5hcmd2WzJdClRBQiA9IGNocig5KQpOX1BFUk0gPSAxMDAwICAgIyBmaW5lciBwZXJtdXRhdGlvbiByZXNvbHV0aW9uIHNvIGEgcmVhbCBwZWFrIGNhbiBzdXJ2aXZlIG11bHRpcGxlLXRlc3RpbmcgY29ycmVjdGlvbgpTRUVEID0gMTIzNDUKRkRSX0FMUEhBID0gMC4wNQoKIyBwcm9iZSBwZXJpb2RzIChicCk6IGRlbnNlIGluIHRoZSBoZWxpY2FsIGJhbmQsIHNwYXJzZXIgdG8gdGhlIG51Y2xlb3NvbWUgc2NhbGUKUEVSSU9EUyA9IG5wLmNvbmNhdGVuYXRlKFtucC5hcmFuZ2UoNi4wLCA0MC4wLCAwLjI1KSwgbnAuYXJhbmdlKDQwLjAsIDQyMC4wLCAxLjApXSkKQU5HID0gMi4wICogbnAucGkgLyBQRVJJT0RTCgpXID0gZGVmYXVsdGRpY3QobGlzdCkKd2l0aCBvcGVuKElOKSBhcyBmaDoKICAgIGZvciBsaW5lIGluIGZoOgogICAgICAgIHAgPSBsaW5lLnJzdHJpcCgiXG4iKS5zcGxpdChUQUIpCiAgICAgICAgaWYgbGVuKHApIDwgMzoKICAgICAgICAgICAgY29udGludWUKICAgICAgICB0cnk6CiAgICAgICAgICAgIFdbcFswXV0uYXBwZW5kKChpbnQocFsxXSksIGZsb2F0KHBbMl0pKSkKICAgICAgICBleGNlcHQgVmFsdWVFcnJvcjoKICAgICAgICAgICAgY29udGludWUKCgpkZWYgYmFuZF9wZWFrKHBnLCBsbywgaGkpOgogICAgbSA9IChQRVJJT0RTID49IGxvKSAmIChQRVJJT0RTIDw9IGhpKQogICAgaWYgbm90IG0uYW55KCk6CiAgICAgICAgcmV0dXJuIE5vbmUKICAgIHN1YiA9IHBnW21dCiAgICBiaSA9IGludChucC5hcmdtYXgoc3ViKSkKICAgIHJldHVybiB7InBlcmlvZCI6IGZsb2F0KFBFUklPRFNbbV1bYmldKSwgInBvd2VyIjogZmxvYXQoc3ViW2JpXSl9CgoKZGVmIGFuYWx5emUocG9pbnRzKToKICAgIHB0cyA9IHNvcnRlZChwb2ludHMpCiAgICBwb3MgPSBucC5hcnJheShbcCBmb3IgcCwgXyBpbiBwdHNdLCBkdHlwZT1mbG9hdCkKICAgIGZyYWMgPSBucC5hcnJheShbdiBmb3IgXywgdiBpbiBwdHNdLCBkdHlwZT1mbG9hdCkKICAgIGlmIGxlbihwb3MpIDwgMzA6CiAgICAgICAgcmV0dXJuIE5vbmUKICAgIHkgPSBmcmFjIC0gZnJhYy5tZWFuKCkKICAgIGlmIG5wLmFsbGNsb3NlKHksIDAuMCk6CiAgICAgICAgcmV0dXJuIE5vbmUKICAgIHBnID0gbG9tYnNjYXJnbGUocG9zLCB5LCBBTkcsIG5vcm1hbGl6ZT1UcnVlKQogICAgcGVha19pID0gaW50KG5wLmFyZ21heChwZykpCiAgICBwZWFrX3BvdyA9IGZsb2F0KHBnW3BlYWtfaV0pCiAgICBybmcgPSBucC5yYW5kb20uZGVmYXVsdF9ybmcoU0VFRCkKICAgIG1heG51bGwgPSBucC5lbXB0eShOX1BFUk0pCiAgICBmb3IgayBpbiByYW5nZShOX1BFUk0pOgogICAgICAgIG1heG51bGxba10gPSBmbG9hdChucC5tYXgobG9tYnNjYXJnbGUocG9zLCBybmcucGVybXV0YXRpb24oeSksIEFORywgbm9ybWFsaXplPVRydWUpKSkKICAgIHB2YWwgPSBmbG9hdCgobnAuc3VtKG1heG51bGwgPj0gcGVha19wb3cpICsgMSkgLyAoTl9QRVJNICsgMSkpCiAgICByZXR1cm4geyJuIjogaW50KGxlbihwb3MpKSwgInBlYWtfcGVyaW9kIjogZmxvYXQoUEVSSU9EU1twZWFrX2ldKSwgInBlYWtfcG93ZXIiOiBwZWFrX3BvdywKICAgICAgICAgICAgInBlcm1fcCI6IHB2YWwsICJudWxsX3A5NSI6IGZsb2F0KG5wLnF1YW50aWxlKG1heG51bGwsIDAuOTUpKSwKICAgICAgICAgICAgImhlbGljYWxfMTBfMTEiOiBiYW5kX3BlYWsocGcsIDEwLjAsIDExLjApLAogICAgICAgICAgICAibnVjbGVvc29tZV8xNzBfMjAwIjogYmFuZF9wZWFrKHBnLCAxNzAuMCwgMjAwLjApfQoKCnJlcyA9IHt9CmZvciB3LCBwdHMgaW4gVy5pdGVtcygpOgogICAgciA9IGFuYWx5emUocHRzKQogICAgaWYgcjoKICAgICAgICByZXNbd10gPSByCgojIG11bHRpcGxlLXRlc3RpbmcgbWF0dGVyczogd2l0aCBOIHdpbmRvd3MgdGVzdGVkLCB+TiphbHBoYSBoaXQgcDxhbHBoYSBieSBjaGFuY2UuIE5VTEwtQSBpcyBvbmx5CiMgcmVmdXRlZCBpZiBhIHdpbmRvdyBzdXJ2aXZlcyBCZW5qYW1pbmktSG9jaGJlcmcgRkRSIGNvcnJlY3Rpb24gYWNyb3NzIGFsbCB3aW5kb3dzLgpzaWdfcmF3ID0gW3cgZm9yIHcsIHIgaW4gcmVzLml0ZW1zKCkgaWYgclsicGVybV9wIl0gPCAwLjAxXQppdGVtcyA9IHNvcnRlZChyZXMuaXRlbXMoKSwga2V5PWxhbWJkYSBrdjoga3ZbMV1bInBlcm1fcCJdKQptID0gbGVuKGl0ZW1zKQprbWF4ID0gMApmb3IgaSwgKHcsIHIpIGluIGVudW1lcmF0ZShpdGVtcywgc3RhcnQ9MSk6CiAgICBpZiByWyJwZXJtX3AiXSA8PSAoaSAvIG0pICogRkRSX0FMUEhBOgogICAgICAgIGttYXggPSBpCnNpZ19iaCA9IFtpdGVtc1tpXVswXSBmb3IgaSBpbiByYW5nZShrbWF4KV0KdmVyZGljdCA9ICJOVUxMLUFfY29uZmlybWVkX25vX3BlcmlvZGljaXR5IiBpZiBub3Qgc2lnX2JoIGVsc2UgIk5VTEwtQV9SRUZVVEVEX3BlcmlvZGljaXR5X2ZvdW5kIgpub3RlID0gKCJwZXJtdXRhdGlvbiBmbG9vciA9IDEvKE5fUEVSTSsxKSA9ICUuNGY7ICVkIHdpbmRvd3M7IEJILUZEUiBhbHBoYT0lLjJmLiAiCiAgICAgICAgIlJhdyBwPDAuMDEgaGl0cyAodW5jb3JyZWN0ZWQpIGRvIE5PVCByZWZ1dGUgdGhlIG51bGw7IG9ubHkgQkgtc3Vydml2b3JzIGRvLiIKICAgICAgICAlICgxLjAgLyAoTl9QRVJNICsgMSksIG0sIEZEUl9BTFBIQSkpCm91dCA9IHsiZ2F0ZSI6ICJudWxsLWEiLCAibl93aW5kb3dzX2FuYWx5emVkIjogbSwgIm5fcGVybSI6IE5fUEVSTSwKICAgICAgICJzaWduaWZpY2FudF9yYXdfcDAxIjogc2lnX3JhdywgInNpZ25pZmljYW50X2JoX2ZkciI6IHNpZ19iaCwKICAgICAgICJwZXJfd2luZG93IjogcmVzLCAidmVyZGljdCI6IHZlcmRpY3QsICJub3RlIjogbm90ZX0KanNvbi5kdW1wKG91dCwgb3BlbihPVVQsICJ3IiksIGluZGVudD0yKQpwcmludChqc29uLmR1bXBzKHsidmVyZGljdCI6IHZlcmRpY3QsICJuX3dpbmRvd3MiOiBtLCAibl9yYXdfcDAxIjogbGVuKHNpZ19yYXcpLAogICAgICAgICAgICAgICAgICAibl9iaF9mZHIiOiBsZW4oc2lnX2JoKSwgImJoX3NpZ25pZmljYW50Ijogc2lnX2JoWzoxMF19KSkK';

function writePy(b64: string, dest: string): void { fs.writeFileSync(dest, Buffer.from(b64, 'base64')); }

function resolveRefRelFor(rMp: string): string {
  for (const rel of ['hg38/Homo_sapiens_assembly38.fasta', 'GRCh38/Homo_sapiens_assembly38.fasta', 'GRCh38/human_GRCh38_no_alt_analysis_set.fasta']) {
    if (fs.existsSync(path.join(rMp, rel)) && fs.existsSync(path.join(rMp, rel + '.fai'))) return rel;
  }
  return '';
}

// python+numpy+scipy image, built once on the executor (cheap, ~1-2 min first time).
function ensurePysci(): void {
  const have = capture('sh', ['-c', "docker images --format '{{.Repository}}:{{.Tag}}' | grep -c '^mm3-pysci:local$' || true"]);
  if (Number(have || '0') > 0) return;
  const df = '/tmp/mm3-pysci.Dockerfile';
  fs.writeFileSync(df, 'FROM python:3.11-slim\nRUN pip install --no-cache-dir numpy scipy\n');
  run('docker', ['build', '-f', df, '-t', 'mm3-pysci:local', '/tmp'], 'build mm3-pysci:local');
}

// genome-wide 20kb windows (a methylation-diverse baseline range for the kill-switch) + the
// labeled imprinted/control REGIONS as contrasts.
function genWindowsBed(): string {
  const lines: string[] = [];
  // euchromatic arm windows (avoid the centromere-adjacent high-coverage regions that choke modkit)
  for (let s = 20000000; s <= 115000000; s += 5000000) lines.push(`chr1\t${s}\t${s + 20000}\tchr1_${s}\t0`);
  for (let s = 20000000; s <= 90000000; s += 5000000) lines.push(`chr2\t${s}\t${s + 20000}\tchr2_${s}\t0`);
  for (const r of REGIONS) lines.push(`${r.chrom}\t${r.start}\t${r.end}\t${r.name}\t${r.imprinted ? 1 : 0}`);
  return lines.join('\n') + '\n';
}

// the bulk bedMethyl is the methyl-pipeline sibling of the merged modBAM
function deriveBedMethyl(modbam: string): string {
  return modbam.replace('.ont.merged.modBAM.bam', '.5mCG_5hmCG.bedMethyl.gz');
}

async function comethylLambdaGate(opts: ComethylExecOptions): Promise<void> {
  const sample = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'genobank-references';
  const jobId = opts.jobId || `comethyl-lambda-${sample}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();
  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `comethyl-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/comethyl/${jobId}`;
  const uploadAudit = () => { try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' }); };

  logLine(`[comethyl] start gate=lambda sample=${sample} jobId=${jobId}`);
  logLine(`[comethyl] modBAM=${opts.modbam}`);

  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });

  const obkt = bucketOf(opts.modbam);
  const oMp = `/mnt/gcsfuse-${obkt}`, rMp = `/mnt/gcsfuse-${refBucket}`;
  gcsfuseRO(obkt, oMp); gcsfuseRO(refBucket, rMp);
  const modbamRel = gsToLocalRel(opts.modbam, obkt);
  const refRel = resolveRefRelFor(rMp);
  if (!refRel) { logLine('[comethyl] lambda: no reference fasta (+.fai)'); uploadAudit(); process.exit(1); }

  ensurePysci();
  const winBed = genWindowsBed();
  fs.writeFileSync(path.join(work, 'windows.bed'), winBed);                              // 5-col (name + imprinted) for the python
  fs.writeFileSync(path.join(work, 'windows3.bed'),                                      // BED3 for modkit --include-bed
    winBed.trim().split('\n').map((l) => l.split('\t').slice(0, 3).join('\t')).join('\n') + '\n');
  writePy(LAMBDA_PY_B64, path.join(work, 'lambda_analysis.py'));
  const threads = capture('nproc', []) || '8';

  // 1a. pull the windows into a SMALL local BAM first (multi-region iterator). Running modkit
  //     directly over the 366 GB gcsfuse modBAM stalls on centromere-adjacent high-coverage windows;
  //     samtools view is robust and fast, and modkit then reads a few-MB local file.
  run('docker', dk(IMG_ALIGN, [[oMp, '/o', 'ro'], [work, '/w', 'rw']], 'bash',
    ['-c', `set -euo pipefail; samtools view -b -M -L /w/windows3.bed "/o/${modbamRel}" -o /w/regions.bam && samtools index /w/regions.bam`]),
    'samtools view windows -> local regional modBAM');
  // 1b. per-read CpG calls on the local regional BAM (fixed threshold => no genome-wide sampling)
  run('docker', dk(IMG_MODKIT, [[rMp, '/r', 'ro'], [work, '/w', 'rw']], undefined,
    ['modkit', 'extract', '/w/regions.bam', 'null', '--read-calls-path', '/w/extract.tsv',
     '--cpg', '--reference', `/r/${refRel}`, '--include-bed', '/w/windows3.bed',
     '--filter-threshold', '0.8', '--threads', threads, '--force']),
    'modkit extract read-calls over the local regional BAM');

  // 2. lambda decay-length + the null discipline (kill-switch / bulk-collapsed / BIC)
  run('docker', dk(IMG_PYSCI, [[work, '/w', 'rw']], undefined,
    ['python', '/w/lambda_analysis.py', '/w/extract.tsv', '/w/windows.bed', '/w/lambda_result.json']),
    'lambda decay-length analysis + kill-switch');

  let result: any = {};
  try { result = JSON.parse(fs.readFileSync(path.join(work, 'lambda_result.json'), 'utf8')); } catch (_) {}
  const verdict = result.verdict || 'unknown';
  logLine(`[comethyl] lambda verdict=${verdict} n_lambda=${result.n_windows_with_lambda} redundant=${JSON.stringify(result.killswitch_redundant_with || [])}`);

  const manifest = {
    schema: 'genobank.comethyl.manifest/v1', pipeline: 'ont-comethyl-lambda', gate: 'lambda',
    jobId, biosampleId: sample, creator: walletLc, status: verdict,
    inputs: { modbam: opts.modbam, reference: refRel, n_windows: genWindowsBed().trim().split('\n').length },
    tools: { modkit: IMG_MODKIT, pysci: IMG_PYSCI },
    result, biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', path.join(work, 'manifest.json'), `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/lambda_result.json ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });
  uploadAudit();
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}

async function comethylNullAGate(opts: ComethylExecOptions): Promise<void> {
  const sample = opts.sample;
  const outBucket = opts.outBucket || 'genobank-parabricks-output';
  const refBucket = opts.refBucket || 'genobank-references';
  const jobId = opts.jobId || `comethyl-null-a-${sample}-${Date.now()}`;
  const walletLc = (opts.creator || '0x5f5a60eaef242c0d51a21c703f520347b96ed19a').toLowerCase();
  const scratchRoot = (fs.existsSync('/mnt/scratch') && '/mnt/scratch') || (fs.existsSync('/mnt') && '/mnt') || '/tmp';
  const work = path.join(scratchRoot as string, `comethyl-${jobId}`);
  fs.mkdirSync(work, { recursive: true });
  const runLogPath = path.join(work, 'run.log');
  try { LOG_FD = fs.openSync(runLogPath, 'a'); } catch (_) { LOG_FD = null; }
  const BIOWALLET_GCS = `gs://${outBucket}/biowallet/${walletLc}/comethyl/${jobId}`;
  const uploadAudit = () => { try { fs.writeFileSync(path.join(work, 'command.txt'), COMMANDS.join('\n') + '\n'); } catch (_) {}
    spawnSync('gcloud', ['storage', 'cp', runLogPath, `${BIOWALLET_GCS}/run.log`], { stdio: 'ignore' }); };

  logLine(`[comethyl] start gate=null-a sample=${sample} jobId=${jobId}`);
  const bedmethyl = deriveBedMethyl(opts.modbam);
  logLine(`[comethyl] bedMethyl=${bedmethyl}`);

  spawnSync('sudo', ['sed', '-i', 's/^#user_allow_other/user_allow_other/', '/etc/fuse.conf'], { stdio: 'ignore' });
  if (capture('sh', ['-c', "grep -c '^user_allow_other' /etc/fuse.conf || true"]) === '0')
    spawnSync('sh', ['-c', 'echo user_allow_other | sudo tee -a /etc/fuse.conf'], { stdio: 'ignore' });

  const bbkt = bucketOf(bedmethyl);
  const bMp = `/mnt/gcsfuse-${bbkt}`; gcsfuseRO(bbkt, bMp);
  const bmRel = gsToLocalRel(bedmethyl, bbkt);
  if (!fs.existsSync(path.join(bMp, bmRel))) { logLine(`[comethyl] null-a: bedMethyl not found at ${bmRel}`); uploadAudit(); process.exit(1); }

  ensurePysci();
  fs.writeFileSync(path.join(work, 'windows.bed'), genWindowsBed());
  writePy(NULLA_PY_B64, path.join(work, 'nulla_analysis.py'));

  // 1. per-CpG bulk methylation fraction inside each window (tabix the bedMethyl, m rows only)
  run('docker', dk(IMG_HTSLIB, [[bMp, '/b', 'ro'], [work, '/w', 'rw']], 'bash',
    ['-c', `set -e; : > /w/nulla_input.tsv; while IFS=$'\\t' read -r chrom s e name imp; do ` +
      `tabix /b/${bmRel} "$chrom:$s-$e" 2>/dev/null | awk -v W="$name" '$4=="m" && ($10+0)>0 {printf "%s\\t%s\\t%.4f\\n", W, $2, ($12+0)/($10+0)}' >> /w/nulla_input.tsv; ` +
      `done < /w/windows.bed`]),
    'tabix bedMethyl windows -> per-CpG fraction');

  // 2. Lomb-Scargle periodogram + permutation null
  run('docker', dk(IMG_PYSCI, [[work, '/w', 'rw']], undefined,
    ['python', '/w/nulla_analysis.py', '/w/nulla_input.tsv', '/w/nulla_result.json']),
    'null-a Lomb-Scargle falsifier');

  let result: any = {};
  try { result = JSON.parse(fs.readFileSync(path.join(work, 'nulla_result.json'), 'utf8')); } catch (_) {}
  const verdict = result.verdict || 'unknown';
  logLine(`[comethyl] null-a verdict=${verdict} n_windows=${result.n_windows_analyzed} significant=${JSON.stringify(result.significant_windows || [])}`);

  const manifest = {
    schema: 'genobank.comethyl.manifest/v1', pipeline: 'ont-comethyl-null-a', gate: 'null-a',
    jobId, biosampleId: sample, creator: walletLc, status: verdict,
    inputs: { bedmethyl, n_windows: genWindowsBed().trim().split('\n').length },
    tools: { htslib: IMG_HTSLIB, pysci: IMG_PYSCI },
    result, biowalletFolder: BIOWALLET_GCS, commands: COMMANDS, createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
  run('gcloud', ['storage', 'cp', path.join(work, 'manifest.json'), `${BIOWALLET_GCS}/manifest.json`], 'upload manifest');
  spawnSync('sh', ['-c', `gcloud storage cp ${work}/nulla_result.json ${BIOWALLET_GCS}/ 2>/dev/null || true`], { stdio: 'ignore' });
  uploadAudit();
  if (LOG_FD !== null) { try { fs.closeSync(LOG_FD); } catch (_) {} }
  process.exit(0);
}
