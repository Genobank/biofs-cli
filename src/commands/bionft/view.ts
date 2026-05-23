/**
 * `biofs bionft view <tokenId>` — read any BioNFT category from Sequentia
 * and display its on-chain state + metadata URI. Works on all four categories:
 * BIOSAMPLE_PARENT, DATA_FILE_CHILD, RENT_AGREEMENT, INGEST_TICKET.
 */
import chalk from 'chalk';
import {
  createBioNFTClient,
  categoryOf,
  getRentAgreement,
  getIngestTicket,
  getChildBioAsset,
  getParentBioAsset,
  INGEST_STATUS,
} from '../../lib/bionft/client';

const CATEGORY_COLOR: Record<string, (s: string) => string> = {
  BIOSAMPLE_PARENT: chalk.magenta,
  DATA_FILE_CHILD: chalk.cyan,
  RENT_AGREEMENT: chalk.blue,
  INGEST_TICKET: chalk.yellow,
};

const STATUS_COLOR: Record<string, (s: string) => string> = {
  ISSUED: chalk.blue,
  CONSUMED: chalk.green,
  BURNED: chalk.gray,
  QUARANTINED: chalk.red,
  ACTIVE: chalk.green,
  REVOKED: chalk.gray,
  EXPIRED: chalk.gray,
};

const FILE_KIND_NAMES = ['BAM', 'VCF', 'FASTQ', 'SQLITE', 'CRAM', 'BED', 'GVCF', 'FASTQ_R1', 'FASTQ_R2'];

export interface BionftViewOptions {
  json?: boolean;
}

export async function bionftViewCommand(tokenIdStr: string, options: BionftViewOptions): Promise<void> {
  const tokenId = BigInt(tokenIdStr);
  const category = categoryOf(tokenId);
  const client = createBioNFTClient({ readOnly: true });

  const row = (k: string, v: any) => console.log(chalk.gray(`  ${k.padEnd(28)}`), v);
  const tsToIso = (s: bigint | number) => {
    const n = typeof s === 'bigint' ? Number(s) : s;
    return n > 0 ? new Date(n * 1000).toISOString().slice(0, 19) + 'Z' : chalk.gray('—');
  };

  if (category === 'RENT_AGREEMENT') {
    const r = await getRentAgreement(client, tokenId);
    if (options.json) { console.log(JSON.stringify({ category, ...serialize(r) }, null, 2)); return; }
    console.log(chalk.cyan('═'.repeat(68)));
    console.log(chalk.bold(`  BioNFT #${tokenId}  ${CATEGORY_COLOR[category]('RENT_AGREEMENT')}`));
    console.log(chalk.cyan('═'.repeat(68)));
    row('biosample tokenId', r.biosampleTokenId.toString());
    row('patient wallet', r.patient);
    row('custodian (lab wallet)', r.custodian);
    row('issued at', tsToIso(r.issuedAt));
    row('expires at', tsToIso(r.expiresAt));
    row('active', r.active ? STATUS_COLOR.ACTIVE('yes') : STATUS_COLOR.REVOKED('no'));
    row('metadata URI', r.metadataURI);
    console.log(chalk.cyan('═'.repeat(68)));
  } else if (category === 'INGEST_TICKET') {
    const t = await getIngestTicket(client, tokenId);
    if (options.json) { console.log(JSON.stringify({ category, ...serialize(t) }, null, 2)); return; }
    console.log(chalk.cyan('═'.repeat(68)));
    console.log(chalk.bold(`  BioNFT #${tokenId}  ${CATEGORY_COLOR[category]('INGEST_TICKET')}`));
    console.log(chalk.cyan('═'.repeat(68)));
    row('rent agreement tokenId', t.rentAgreementTokenId.toString());
    row('patient wallet', t.patient);
    row('custodian (lab wallet)', t.custodian);
    row('file kind', FILE_KIND_NAMES[t.fileKind] ?? `unknown(${t.fileKind})`);
    row('expected size', t.expectedSize.toString() + ' bytes');
    row('actual size', t.actualSize.toString() + (t.actualSize > 0n ? ' bytes' : ' (not uploaded)'));
    row('sha256 claimed', t.sha256Claimed);
    row('sha256 computed', t.sha256Computed === '0x0000000000000000000000000000000000000000000000000000000000000000'
      ? chalk.gray('pending') : t.sha256Computed);
    row('object path hash', t.objectPathHash);
    row('data file tokenId', t.dataFileTokenId > 0n ? t.dataFileTokenId.toString() : chalk.gray('not yet minted'));
    row('issued at', tsToIso(t.issuedAt));
    row('finalized at', tsToIso(t.finalizedAt));
    row('status', (STATUS_COLOR[t.status] || chalk.white)(t.status));
    row('metadata URI', t.metadataURI);
    console.log(chalk.cyan('═'.repeat(68)));
  } else if (category === 'DATA_FILE_CHILD') {
    const c = await getChildBioAsset(client, tokenId);
    if (options.json) { console.log(JSON.stringify({ category, ...serialize(c) }, null, 2)); return; }
    console.log(chalk.cyan('═'.repeat(68)));
    console.log(chalk.bold(`  BioNFT #${tokenId}  ${CATEGORY_COLOR[category]('DATA_FILE_CHILD')}`));
    console.log(chalk.cyan('═'.repeat(68)));
    row('parent biosample tokenId', c.parentTokenId.toString());
    row('file type', FILE_KIND_NAMES[c.fileType] ?? `unknown(${c.fileType})`);
    row('file size', c.fileSize.toString() + ' bytes');
    row('reference genome', c.referenceGenome);
    row('variant count', c.variantCount.toString());
    row('annotator count', c.annotatorCount.toString());
    row('content SHA256', c.contentHash);
    row('pipeline', c.pipeline);
    row('active', c.active ? STATUS_COLOR.ACTIVE('yes') : chalk.gray('deactivated'));
    console.log(chalk.cyan('═'.repeat(68)));
  } else {
    const p = await getParentBioAsset(client, tokenId);
    if (options.json) { console.log(JSON.stringify({ category, ...serialize(p) }, null, 2)); return; }
    console.log(chalk.cyan('═'.repeat(68)));
    console.log(chalk.bold(`  BioNFT #${tokenId}  ${CATEGORY_COLOR[category]('BIOSAMPLE_PARENT')}`));
    console.log(chalk.cyan('═'.repeat(68)));
    row('biosample serial', p.biosampleSerial.toString());
    row('asset owner (patient)', p.assetOwner);
    row('total biodata value', p.totalBiodataValue.toString());
    row('active', p.active ? STATUS_COLOR.ACTIVE('yes') : chalk.gray('deactivated'));
    console.log(chalk.cyan('═'.repeat(68)));
  }
}

function serialize(obj: any): any {
  const out: any = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    out[k] = typeof v === 'bigint' ? v.toString() : v;
  }
  return out;
}
