/**
 * biofs governance show | hash
 *
 * The Genome Governance Token for AI Agents is a BioNFT whose grant is a
 * hashed, versioned template (not a per-subject document). This verb prints
 * the four constraints and the keccak256 that ConsentGrant.termsRef must equal.
 */

import { ethers } from 'ethers';
import chalk from 'chalk';

export interface GovernanceOptions {
  json?: boolean;
}

/** Canonical template. termsRef = keccak256(utf8(id)). Do not put personal data here. */
export const GENOME_GOVERNANCE_TEMPLATE = {
  id: 'genobank:consent-template:genome-governance-ai-agent:v1',
  title: 'Genome Governance Token for AI Agents',
  issuer: 'GenoBank.io',
  bio_pil: 5,
  purpose_code: 1001,
  purpose_profile: 'genobank:purpose:research-not-care:v1',
  ops: ['READ', 'QUERY', 'DERIVE'],
  ttl_days_max: 30,
  output_license: 'CC BY 4.0',
  genome_license: 'gated-not-open',
  constraints: [
    {
      id: 'no-recontact',
      must: 'The agent shall not attempt to recontact the data subject, family members, or named points of contact.',
    },
    {
      id: 'delete-30-days',
      must: 'All copies of the underlying biodata shall be deleted within 30 days of programme close. Revocation is immediate. Erasure is biofs erase.',
    },
    {
      id: 'outputs-cc-by-4.0',
      must: 'Research outputs (code, methods, ranked variant lists, reports) are released under CC BY 4.0. The underlying genome, FASTQ, VCF, and BAM are not.',
    },
    {
      id: 'not-medical-care',
      must: 'This grant is not medical care, diagnosis, or treatment. Purpose code is research (1001), never clinical-use (1002). BioPIL 5 (gdpr-research), not BioPIL 7 (clinical-use).',
    },
  ],
} as const;

export const GOVERNANCE_DENIED_PURPOSES = [
  'recontact',
  'family_outreach',
  'clinical-care',
  'diagnosis',
  'treatment',
  'prescribe',
  'insurance_underwriting',
  'employer_screening',
  'forensic_identification',
  'sale',
];

export const GOVERNANCE_SKILLS_ALLOW = [
  'variant_annotation',
  'rare_disease_dx',
  'drug_repurposing_hypothesis',
  'alphagenome_interpret',
];

export const GOVERNANCE_SKILLS_DENY = [
  'recontact',
  'family_outreach',
  'patient_messaging',
  'clinical_care',
  'prescribe',
  'raw_sequence_export',
  'bulk_download',
  'reidentification',
  'federated_aggregation',
];

export function governanceRefs(): { termsRef: string; purposeRef: string } {
  return {
    termsRef: ethers.keccak256(ethers.toUtf8Bytes(GENOME_GOVERNANCE_TEMPLATE.id)),
    purposeRef: ethers.keccak256(ethers.toUtf8Bytes(GENOME_GOVERNANCE_TEMPLATE.purpose_profile)),
  };
}

export async function governanceShowCommand(opts: GovernanceOptions = {}): Promise<void> {
  const obj = GENOME_GOVERNANCE_TEMPLATE;
  const { termsRef, purposeRef } = governanceRefs();
  if (opts.json) {
    console.log(JSON.stringify({ ...obj, termsRef, purposeRef }, null, 2));
    return;
  }
  console.log('');
  console.log(chalk.bold('  Genome Governance Token for AI Agents'));
  console.log('  ' + obj.id);
  console.log('');
  console.log(`  ${chalk.bold('termsRef')}          ${termsRef}`);
  console.log(`  ${chalk.bold('purposeProfileRef')} ${purposeRef}`);
  console.log(`  ${chalk.bold('purposeCode')}       ${obj.purpose_code} (research, never 1002 clinical-use)`);
  console.log(`  ${chalk.bold('BioPIL')}            #${obj.bio_pil} gdpr-research (revocable)`);
  console.log(`  ${chalk.bold('ops')}               ${obj.ops.join(' | ')} (no EXPORT of the genome)`);
  console.log(`  ${chalk.bold('ttl_days_max')}      ${obj.ttl_days_max}`);
  console.log(`  ${chalk.bold('outputs')}           ${obj.output_license}; genome ${obj.genome_license}`);
  console.log('');
  for (const c of obj.constraints) {
    console.log(`  ${chalk.cyan(c.id)}`);
    console.log(`    ${c.must}`);
  }
  console.log('');
  console.log('  A BioFS read proceeds only if ConsentGrant.checkAccess holds for purpose 1001');
  console.log('  and the tool is not in deny_skills. The agent is revocable on its own.');
  console.log('');
}

export async function governanceHashCommand(opts: GovernanceOptions = {}): Promise<void> {
  const { termsRef, purposeRef } = governanceRefs();
  if (opts.json) {
    console.log(JSON.stringify({
      id: GENOME_GOVERNANCE_TEMPLATE.id,
      termsRef,
      purpose_profile: GENOME_GOVERNANCE_TEMPLATE.purpose_profile,
      purposeRef,
    }, null, 2));
    return;
  }
  console.log(termsRef);
}
