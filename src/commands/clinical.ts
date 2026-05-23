/**
 * biofs clinical
 *
 * Phenotype-driven, multi-exome ACMG/AMP 2015 + ClinGen-SVI 2024 clinical
 * variant classifier. Server-side; no genomic bytes touch the laptop.
 *
 * Flow:
 *   1. Local wallet signature; serials passed as a list.
 *   2. Server resolves each serial → OpenCRAVAT sqlite via bioroutes.inventory
 *      (or accepts a sqlite path override via --sqlite-path for the operator).
 *   3. Server maps phenotype text → HPO codes via local HPOA annotations,
 *      OR accepts explicit --hpo codes, OR (if --photo + face2gene-key)
 *      runs a Face2Gene-style syndrome predictor and folds into HPO.
 *   4. Server filters variants to the (panel ∪ HPO-curated) gene set, applies
 *      ACMG criteria (PVS1/PS/PM/PP/BA1/BS/BP) per Pejaver-2022 calibrated
 *      thresholds, and returns a joint ranked list with HTML + JSON.
 *   5. Client writes both files under the operator's output dir, keyed on a
 *      privacy-safe case label (no proper names; biowallet or label only).
 *
 * Usage:
 *   biofs clinical 55052008714014 \
 *     --serials 55052008714014,55052008714060,55052008713972,55052008714008 \
 *     --phenotype "skeletal disability, bone fractures, under development, wheelchair" \
 *     --panel skeletal_dysplasia \
 *     --case-label proband-0x01a2D260 \
 *     --output ./clinical_reports/
 *
 *   biofs clinical 55052008714014 \
 *     --hpo HP:0000924,HP:0002659,HP:0001263 \
 *     --photo ./patient.jpg
 *
 * Privacy: Per CLAUDE.md, never use proper names. Use --case-label for
 * audit/display, biowallet address otherwise.
 */

import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import { CredentialsManager } from '../lib/auth/credentials';
import { API_CONFIG } from '../lib/config/constants';

export interface ClinicalOptions {
  serials?: string;        // comma-separated additional serials for joint analysis
  hpo?: string;            // comma-separated HP:#### codes
  phenotype?: string;      // free-text phenotype
  photo?: string;          // path to patient photo (optional)
  panel?: string;          // 'skeletal_dysplasia' | 'none' | future panels
  maxAf?: string;          // gnomAD AF ceiling, default 0.01
  output?: string;         // output dir
  caseLabel?: string;      // anonymous case label (privacy-safe)
  format?: string;         // json | html | both (default both)
  quiet?: boolean;
  debug?: boolean;
}

interface ClinicalServerResponse {
  case_label: string;
  exomes: Array<{ path: string; label: string }>;
  hpo_codes: string[];
  n_hpo_genes_curated: number;
  panel_used: string;
  photo_phenotyping: { status: string; syndromes?: any[]; note?: string };
  summary: {
    total_variants_classified: number;
    by_class: Record<string, number>;
  };
  variants: any[];
  methodology: string;
  generated_at: string;
  html?: string;          // optional inline HTML render from server
}

function parseSerials(primary: string, listOpt?: string): string[] {
  const set = new Set<string>();
  if (primary) set.add(primary.trim());
  if (listOpt) for (const s of listOpt.split(',')) {
    const t = s.trim();
    if (t) set.add(t);
  }
  return Array.from(set);
}

export async function clinicalCommand(
  biosample: string,
  options: ClinicalOptions
): Promise<void> {
  if (!biosample) {
    console.error(chalk.red('Usage: biofs clinical <biosample_serial> [--serials list] --phenotype "..."'));
    process.exit(1);
  }

  if (!options.hpo && !options.phenotype) {
    console.error(chalk.red('Provide at least one of --phenotype "<text>" or --hpo HP:0001,HP:0002'));
    process.exit(1);
  }

  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    console.error(chalk.red('Not authenticated. Run: biofs login'));
    process.exit(1);
  }

  const serials = parseSerials(biosample, options.serials);
  const outDir = path.resolve(options.output || './clinical_reports/');
  const caseLabel = options.caseLabel || `proband-${creds.wallet_address.slice(0, 10)}`;
  const panel = options.panel || 'skeletal_dysplasia';
  const maxAf = options.maxAf || '0.01';
  const format = (options.format || 'both').toLowerCase();

  fs.mkdirSync(outDir, { recursive: true });

  // Optional photo → base64 (graceful fallback if photo missing or no API key on server)
  let photoB64: string | undefined;
  if (options.photo) {
    if (!fs.existsSync(options.photo)) {
      console.warn(chalk.yellow(`Photo not found at ${options.photo} — continuing with phenotype-text/HPO only`));
    } else {
      const buf = fs.readFileSync(options.photo);
      photoB64 = buf.toString('base64');
      if (!options.quiet) {
        console.log(chalk.cyan(`Photo loaded (${buf.length} bytes) — server will attempt syndrome match if Face2Gene key configured.`));
      }
    }
  }

  if (!options.quiet) {
    console.log(chalk.bold.cyan('\nbiofs clinical — Phenotype-driven ACMG variant classifier'));
    console.log(`Case label:   ${chalk.bold(caseLabel)}  ${chalk.gray('(privacy-safe; no proper names)')}`);
    console.log(`Exomes:       ${serials.length} ${serials.length === 1 ? 'serial' : 'serials (joint pass)'}`);
    serials.forEach(s => console.log(`  - ${s}`));
    if (options.hpo)        console.log(`HPO codes:    ${options.hpo}`);
    if (options.phenotype)  console.log(`Phenotype:    "${options.phenotype}"`);
    console.log(`Panel:        ${panel}`);
    console.log(`Max gnomAD AF: ${maxAf}`);
    console.log(`Photo:        ${options.photo ? options.photo : '(none)'}`);
    console.log(`Output:       ${outDir}\n`);
  }

  const spinner = options.quiet ? null : ora('Submitting to /api_biofs_fuse/clinical_acmg ...').start();

  const baseUrl = `${API_CONFIG.base}${API_CONFIG.fuse}`;
  const payload = {
    serials,
    hpo: options.hpo || '',
    phenotype: options.phenotype || '',
    panel,
    max_af: maxAf,
    photo_b64: photoB64 || '',
    case_label: caseLabel,
    wallet: creds.wallet_address,
    signature: creds.user_signature,
  };

  let resp: ClinicalServerResponse;
  try {
    const r = await axios.post(`${baseUrl}/clinical_acmg`, payload, {
      timeout: 60 * 60_000,  // 1 hr — large joint passes can be slow
      maxContentLength: 200 * 1024 * 1024,
    });
    resp = r.data;
  } catch (err: any) {
    spinner?.fail('clinical_acmg API call failed');
    const serverMsg = err?.response?.data?.error || err?.message;
    console.error(chalk.red(`Error: ${serverMsg}`));
    if (options.debug) console.error(err?.response?.data || err);
    process.exit(1);
  }
  spinner?.succeed(`classified ${resp.summary.total_variants_classified} variants across ${resp.exomes.length} exome(s)`);

  // Render summary table
  const by = resp.summary.by_class || {};
  console.log('\n' + chalk.bold('Classification summary:'));
  console.log(`  ${chalk.red.bold(by['Pathogenic']||0)} Pathogenic`);
  console.log(`  ${chalk.hex('#cc5500').bold(by['Likely Pathogenic']||0)} Likely Pathogenic`);
  console.log(`  ${chalk.gray(by['VUS']||0)} VUS`);
  console.log(`  ${chalk.green(by['Likely Benign']||0)} Likely Benign`);
  console.log(`  ${chalk.green.bold(by['Benign']||0)} Benign`);

  // Print P + LP variants
  const top = (resp.variants || []).filter(v =>
    v.classification === 'Pathogenic' || v.classification === 'Likely Pathogenic'
  );
  if (top.length > 0) {
    console.log('\n' + chalk.bold('Diagnostic candidates (P / LP):'));
    for (const v of top) {
      const tag = v.classification === 'Pathogenic' ? chalk.red.bold('  [P] ') : chalk.hex('#cc5500').bold(' [LP] ');
      const hpoMatch = (v.phenotype_hpo_matched || []).length;
      console.log(
        `${tag} ${chalk.bold(v.gene)}  chr${v.chrom}:${v.pos} ${v.ref}>${v.alt}  ` +
        `${v.cchange||''} ${v.achange||''}  ` +
        chalk.gray(`(${(v.so||'').toLowerCase()}; HPO=${hpoMatch}; ` +
                   `AM=${fmt(v.am_path)} REVEL=${fmt(v.revel)} SpliceAI=${fmt(v.spliceai_max)})`)
      );
      if (v.clinvar_disease) {
        console.log(`         ${chalk.gray('ClinVar: ' + (v.clinvar_sig||'') + ' — ' + (v.clinvar_disease||'').slice(0,120))}`);
      }
    }
  }

  // Write outputs
  if (format === 'json' || format === 'both') {
    const jsonPath = path.join(outDir, `${caseLabel}__clinical_acmg.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(resp, null, 2));
    if (!options.quiet) console.log(chalk.green(`\n✓ JSON report: ${jsonPath}`));
  }
  if (format === 'html' || format === 'both') {
    const htmlPath = path.join(outDir, `${caseLabel}__clinical_acmg.html`);
    if (resp.html) {
      fs.writeFileSync(htmlPath, resp.html);
    } else {
      fs.writeFileSync(htmlPath, renderClientFallbackHtml(resp));
    }
    if (!options.quiet) console.log(chalk.green(`✓ HTML report: ${htmlPath}`));
  }
}

function fmt(v: any): string {
  if (v == null) return '·';
  if (typeof v === 'number') return v.toFixed(2);
  return String(v);
}

function renderClientFallbackHtml(r: ClinicalServerResponse): string {
  // Fallback HTML render if server didn't include r.html. Mirrors server output
  // style — light theme, no dark backgrounds, per Daniel's preference.
  const variants = r.variants || [];
  const rows = variants.map(v => {
    const cls = v.classification.replace(' ', '-');
    return `<tr class="${cls}">
      <td><strong>${v.gene||''}</strong>${v.panel_member ? ' <span class="badge">PANEL</span>' : ''}</td>
      <td>chr${v.chrom}:${v.pos} ${v.ref}&gt;${v.alt}</td>
      <td>${v.so||''}<br><span class="small">${v.cchange||''} ${v.achange||''}</span></td>
      <td><strong>${v.classification}</strong></td>
      <td>AM=${fmt(v.am_path)}<br>REVEL=${fmt(v.revel)}<br>CADD=${fmt(v.cadd)}<br>SpliceAI=${fmt(v.spliceai_max)}</td>
      <td>${v.gnomad_af==null?'absent':v.gnomad_af}</td>
      <td>${v.clinvar_sig||''}<br><span class="small">${(v.clinvar_disease||'').slice(0,80)}</span></td>
      <td>${v.zygosity||''}<br><span class="small">${v.sqlite_source||''}</span></td>
      <td>${v.phenotype_score||0}<br><span class="small">${(v.phenotype_hpo_matched||[]).join(',').slice(0,40)}</span></td>
    </tr>`;
  }).join('');
  const css = `
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
           background: #ffffff; color: #212529; margin: 24px; max-width: 1200px; }
    h1, h2 { color: #1a3550; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; font-size: 13px; }
    th, td { padding: 6px 10px; border: 1px solid #dee2e6; text-align: left; vertical-align: top; }
    th { background: #f5f8fb; }
    .Pathogenic { background: #fde8e8; }
    .Likely-Pathogenic { background: #fff4e0; }
    .VUS { background: #f7f7f7; }
    .badge { display: inline-block; padding: 1px 7px; border-radius: 9px; font-size: 11px;
             background: #1a3550; color: #fff; }
    .small { color: #6c757d; font-size: 11px; }
    code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; }
  `;
  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>Clinical ACMG — ${r.case_label}</title><style>${css}</style></head><body>
<h1>Clinical ACMG Report</h1>
<p><strong>Case:</strong> <code>${r.case_label}</code><br>
<strong>Generated:</strong> ${r.generated_at}<br>
<strong>Exomes:</strong> ${r.exomes.length} &nbsp; <strong>HPO:</strong> ${r.hpo_codes.join(', ')}<br>
<strong>Panel:</strong> ${r.panel_used} (${r.n_hpo_genes_curated} HPO-curated genes) &nbsp;
<strong>Photo:</strong> ${r.photo_phenotyping?.status||'none'}
</p>
<h2>Summary</h2>
<p>${Object.entries(r.summary.by_class).map(([k,v])=>`${k}: <strong>${v}</strong>`).join(' &nbsp; · &nbsp; ')}</p>
<h2>Variants</h2>
<table>
<thead><tr><th>Gene</th><th>Locus</th><th>HGVS</th><th>Class</th><th>In-silico</th><th>gnomAD</th><th>ClinVar</th><th>Zygosity / exome</th><th>Phenotype</th></tr></thead>
<tbody>${rows}</tbody></table>
<p class="small">${r.methodology}</p>
</body></html>`;
}
