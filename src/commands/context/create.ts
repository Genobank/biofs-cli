/**
 * biofs context create <caseId>
 *
 * Build and EIP-712 sign a .bionft manifest. Reads the authenticated wallet's
 * files via the existing GenoBank API (getMyUploadedFilesUrls + getMyBioIPs +
 * getMyGrantedBioIPs), offers an interactive picker, and writes a signed pair
 * of files (.bionft + .bio.md).
 */

import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import * as fs from 'fs-extra';
import * as path from 'path';
import { ethers } from 'ethers';
import { CredentialsManager } from '../../lib/auth/credentials';
import { GenoBankAPIClient } from '../../lib/api/client';
import { Logger } from '../../lib/utils/logger';
import {
  buildManifest,
  BioAsset,
  BioContextInput,
  FileType,
} from '../../lib/context/manifest';

export interface ContextCreateOptions {
  kind?: string;
  pil?: string;
  commercial?: boolean;
  denyPurpose?: string;
  allowSkill?: string;
  denySkill?: string;
  deadline?: string;
  expires?: string;
  narrative?: string;
  output?: string;
  includeFiles?: string;
  privateKey?: string;
  yes?: boolean;
}

const DEFAULT_ALLOW_BY_KIND: Record<string, string[]> = {
  CancerDigitalTwin: [
    'variant_annotation', 'oncology_panel', 'trial_matching',
    'pharmgx', 'alphagenome_interpret',
  ],
  RareDiseaseDx: [
    'variant_annotation', 'rare_disease_dx', 'alphagenome_interpret', 'pharmgx',
  ],
  AncestryProfile: ['ancestry_pca', 'variant_annotation'],
};

const DEFAULT_DENY: string[] = [
  'raw_sequence_export',
  'reidentification',
  'federated_aggregation',
  'bulk_download',
];

const DEFAULT_DENIED_PURPOSES: string[] = [
  'insurance_underwriting',
  'employer_screening',
  'forensic_identification',
];

function parseDuration(s: string): number {
  const m = s.match(/^(\d+)([dwy])$/);
  if (!m) return parseInt(s, 10);
  const n = parseInt(m[1], 10);
  if (m[2] === 'd') return n * 86400;
  if (m[2] === 'w') return n * 7 * 86400;
  if (m[2] === 'y') return n * 365 * 86400;
  return 0;
}

function detectType(filename: string): FileType {
  const f = filename.toLowerCase();
  if (f.endsWith('.vcf') || f.endsWith('.vcf.gz')) return 'vcf';
  if (f.endsWith('.bam') || f.endsWith('.cram')) return 'bam';
  if (f.endsWith('.fastq') || f.endsWith('.fastq.gz') || f.endsWith('.fq.gz')) return 'fastq';
  if (f.endsWith('.sqlite') || f.endsWith('.db')) return 'sqlite';
  if (f.includes('fhir')) return 'fhir';
  if (f.match(/ghan|23andme|ancestry|dtc/)) return 'dtc-genotype';
  if (f.endsWith('.pdf')) return 'pdf';
  return 'clinical-report';
}

function humanSize(b: number): string {
  if (!b) return '0B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(1)}${u[i]}`;
}

export async function contextCreateCommand(
  caseId: string,
  options: ContextCreateOptions = {}
): Promise<void> {
  if (!/^[A-Z]{2}\d{2}-\d{6}$/.test(caseId)) {
    Logger.error(
      `Invalid caseId format. Expected like "TN25-336147" (pattern ^[A-Z]{2}\\d{2}-\\d{6}$)`
    );
    process.exit(1);
  }

  const spinner = ora('Loading credentials...').start();
  const creds = await CredentialsManager.getInstance().loadCredentials();
  if (!creds) {
    spinner.fail('Not authenticated. Run: biofs login');
    process.exit(1);
  }
  const owner = ethers.getAddress(creds.wallet_address);
  spinner.succeed(`Authenticated as ${chalk.cyan(owner)}`);

  spinner.start('Discovering BioFiles...');
  const api = GenoBankAPIClient.getInstance();
  const [uploads, bioips, granted] = await Promise.all([
    api.getMyUploadedFilesUrls().catch(() => []),
    api.getMyBioIPs().catch(() => []),
    api.getMyGrantedBioIPs().catch(() => []),
  ]);
  spinner.succeed(
    `Found ${uploads.length} uploads, ${bioips.length} BioIPs, ${granted.length} granted`
  );

  type Choice = {
    label: string;
    biocid: string;
    fileType: FileType;
    contentHash?: string;
    sizeBytes: number;
    labPermittee: string;
    streamOnly: boolean;
  };

  const mkBiocid = (type: string, filename: string) =>
    `Biocid:user/${owner}/${type}/${filename}`;

  const mkChoice = (obj: any, src: string): Choice | null => {
    const filename = obj.filename || obj.file_name || obj.name;
    if (!filename) return null;
    const fileType = detectType(filename);
    const size = obj.size || obj.file_size || 0;
    return {
      label: `${chalk.yellow(src.padEnd(9))} ${fileType.padEnd(8)} ${filename} ${chalk.gray(`(${humanSize(size)})`)}`,
      biocid: obj.biocid || mkBiocid(fileType, filename),
      fileType,
      contentHash: obj.file_hash || obj.sha256,
      sizeBytes: size,
      labPermittee: obj.lab_permittee || obj.owner || '',
      streamOnly: size > 100 * 1024 * 1024,
    };
  };

  const choices: Choice[] = [
    ...uploads.map((u: any) => mkChoice(u, 'upload')),
    ...bioips.map((b: any) => mkChoice(b, 'bioip')),
    ...granted.map((g: any) => mkChoice({ ...g, labPermittee: g.owner }, 'granted')),
  ].filter((c): c is Choice => c !== null);

  if (choices.length === 0) {
    Logger.error('No BioFiles found. Upload or request access first.');
    process.exit(1);
  }

  let selected: Choice[];
  if (options.includeFiles) {
    const wanted = new Set(options.includeFiles.split(','));
    selected = choices.filter(c => wanted.has(c.biocid));
  } else if (options.yes) {
    selected = choices;
  } else {
    const { picks } = await inquirer.prompt([
      {
        type: 'checkbox',
        name: 'picks',
        message: `Select BioFiles to include in ${caseId}:`,
        choices: choices.map(c => ({ name: c.label, value: c })),
        pageSize: 20,
      },
    ]);
    selected = picks;
  }

  if (selected.length === 0) {
    Logger.error('No files selected. Aborting.');
    process.exit(1);
  }

  spinner.start('Resolving content hashes...');
  for (const s of selected) {
    if (!s.contentHash) {
      s.contentHash =
        '0x' +
        ethers.keccak256(ethers.toUtf8Bytes(`${s.biocid}:${s.sizeBytes}`)).slice(2);
    }
  }
  spinner.succeed(`Hashed ${selected.length} assets`);

  let narrativeText = '';
  if (options.narrative && (await fs.pathExists(options.narrative))) {
    narrativeText = await fs.readFile(options.narrative, 'utf-8');
  } else {
    narrativeText = defaultNarrative(caseId, owner, selected);
  }

  const kind = options.kind || 'CancerDigitalTwin';
  const bioPilId = parseInt(options.pil || '5', 10);
  const commercial = options.commercial ?? (bioPilId === 6 || bioPilId === 8);
  const consentExpires =
    Math.floor(Date.now() / 1000) + parseDuration(options.expires || '365d');
  const manifestDeadline =
    Math.floor(Date.now() / 1000) + parseDuration(options.deadline || '30d');
  const deniedPurposes = options.denyPurpose
    ? options.denyPurpose.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_DENIED_PURPOSES;
  const skillsAllow = options.allowSkill
    ? options.allowSkill.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_ALLOW_BY_KIND[kind] || DEFAULT_ALLOW_BY_KIND.CancerDigitalTwin;
  const skillsDeny = options.denySkill
    ? options.denySkill.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_DENY;

  const input: BioContextInput = {
    caseId,
    kind,
    owner,
    agentId: `gc-${owner.slice(2, 10).toLowerCase()}`,
    consent: {
      bioPilId,
      commercial,
      expiresAt: consentExpires,
      deniedPurposes,
    },
    skillsAllow,
    skillsDeny,
    assets: selected.map(s => ({
      biocid: s.biocid,
      fileType: s.fileType,
      labPermittee: s.labPermittee,
      contentHash: s.contentHash!,
      sizeBytes: s.sizeBytes,
      streamOnly: s.streamOnly,
    })),
    narrativeText,
    nonce: Math.floor(Math.random() * 2 ** 32),
    deadline: manifestDeadline,
  };

  spinner.start('Signing manifest...');
  let signer: ethers.Signer;
  const keyEnv = process.env.BIOFS_SIGNING_KEY;
  if (options.privateKey) {
    signer = new ethers.Wallet(options.privateKey);
  } else if (keyEnv) {
    signer = new ethers.Wallet(keyEnv);
  } else {
    spinner.fail(
      'No signing key available. Pass --private-key or export BIOFS_SIGNING_KEY=0x...'
    );
    process.exit(1);
  }

  const signerAddr = await signer.getAddress();
  if (signerAddr.toLowerCase() !== owner.toLowerCase()) {
    spinner.fail(`Key ${signerAddr} does not match authenticated wallet ${owner}`);
    process.exit(1);
  }

  const manifest = await buildManifest(input, signer);
  spinner.succeed('Signed');

  const outDir = options.output ? path.dirname(options.output) : process.cwd();
  await fs.ensureDir(outDir);
  const bionftPath =
    options.output || path.join(outDir, `${caseId.toLowerCase()}.bionft`);
  const biomdPath = bionftPath.replace(/\.bionft$/, '.bio.md');

  await fs.writeFile(bionftPath, JSON.stringify(manifest, null, 2), 'utf-8');
  await fs.writeFile(biomdPath, narrativeText, 'utf-8');

  console.log('');
  Logger.success(`Wrote ${chalk.green(bionftPath)}`);
  Logger.success(`Wrote ${chalk.green(biomdPath)}`);
  console.log('');
  console.log(chalk.bold('Manifest summary:'));
  console.log(`  caseId:        ${chalk.cyan(caseId)}`);
  console.log(`  owner:         ${chalk.cyan(owner)}`);
  console.log(`  kind:          ${kind}`);
  console.log(
    `  consent:       BioPIL #${bioPilId}${commercial ? chalk.yellow(' COMMERCIAL') : ''}`
  );
  console.log(`  assets:        ${selected.length}`);
  console.log(
    `  manifest TTL:  ${options.deadline || '30d'}  →  ${new Date(manifestDeadline * 1000).toISOString()}`
  );
  console.log(
    `  consent TTL:   ${options.expires || '365d'}  →  ${new Date(consentExpires * 1000).toISOString()}`
  );
  console.log('');
  console.log(
    `Next: ${chalk.cyan(`biofs context publish ${bionftPath}`)}`
  );
}

function defaultNarrative(
  caseId: string,
  owner: string,
  selected: any[]
): string {
  return `# ${caseId} — BioContext Narrative

**Owner wallet:** \`${owner}\`
**Manifest:** \`${caseId.toLowerCase()}.bionft\`
**Loader:** https://biorouter.genobank.app/api_biorouter
**Chain:** Sequentia (id 15132025)

## What this is
A GenoBank.io BioContext manifest enumerating ${selected.length} genomic/clinical
assets belonging to the wallet above, with licensing terms (BioPIL) and an
allow/deny skill list an AI agent may use.

## Usage via MCP
\`\`\`
bio_discover({caseId: "${caseId}"})
bio_authenticate({user_signature: "0x..."})
bio_load_manifest({case_id: "${caseId}"})
bio_resolve({biocid: "...", purpose: "oncology_panel"})
bio_run_skill({skill: "oncology_panel", biocid: "..."})
\`\`\`

## Revocation (GDPR Article 17)
\`\`\`
biofs context revoke ${caseId}
\`\`\`
`;
}
