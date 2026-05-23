/**
 * `biofs bionft status <tokenId>` — quick one-line on-chain status.
 * For full detail use `biofs bionft view <tokenId>`.
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

export async function bionftStatusCommand(tokenIdStr: string): Promise<void> {
  const tokenId = BigInt(tokenIdStr);
  const category = categoryOf(tokenId);
  const client = createBioNFTClient({ readOnly: true });

  if (category === 'RENT_AGREEMENT') {
    const r = await getRentAgreement(client, tokenId);
    const active = await client.creds.isRentAgreementActive(tokenId);
    console.log(
      `#${tokenId} RENT_AGREEMENT · ` +
      (active ? chalk.green('ACTIVE') : chalk.gray('INACTIVE')) +
      ` · patient=${r.patient.slice(0, 10)}… custodian=${r.custodian.slice(0, 10)}… ` +
      `expires=${new Date(Number(r.expiresAt) * 1000).toISOString().slice(0, 10)}`,
    );
  } else if (category === 'INGEST_TICKET') {
    const t = await getIngestTicket(client, tokenId);
    const color: any = { ISSUED: chalk.blue, CONSUMED: chalk.green, BURNED: chalk.gray, QUARANTINED: chalk.red };
    console.log(
      `#${tokenId} INGEST_TICKET · ` + (color[t.status] || chalk.white)(t.status) + ` · ` +
      `rent=${t.rentAgreementTokenId} size=${t.actualSize || t.expectedSize}B ` +
      (t.dataFileTokenId > 0n ? `→ DATA_FILE_CHILD #${t.dataFileTokenId}` : ''),
    );
  } else if (category === 'DATA_FILE_CHILD') {
    const c = await getChildBioAsset(client, tokenId);
    console.log(
      `#${tokenId} DATA_FILE_CHILD · ` +
      (c.active ? chalk.green('ACTIVE') : chalk.gray('DEACTIVATED')) +
      ` · parent=${c.parentTokenId} type=${c.fileType} size=${c.fileSize}B`,
    );
  } else {
    const p = await getParentBioAsset(client, tokenId);
    console.log(
      `#${tokenId} BIOSAMPLE_PARENT · ` +
      (p.active ? chalk.green('ACTIVE') : chalk.gray('DEACTIVATED')) +
      ` · biosample=${p.biosampleSerial} owner=${p.assetOwner.slice(0, 10)}…`,
    );
  }
}
