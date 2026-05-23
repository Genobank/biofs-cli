/**
 * biofs annotate submit <biosample_serial>
 *
 * Submits a VCF file to OpenCRAVAT for annotation with all 146 annotators.
 * Uses GenoBank API's /api_vcf_annotator/annotate_vcf_using_gift_code endpoint.
 *
 * Flow:
 * 1. Find VCF file via GenoBank API
 * 2. Submit annotation job via GenoBank VCF Annotator API
 * 3. GenoBank handles OpenCRAVAT authentication internally
 */

import chalk from 'chalk';
import ora from 'ora';
import axios from 'axios';
import * as path from 'path';
import { getCredentials } from '../../lib/auth/credentials';
import { Logger } from '../../lib/utils/logger';

export interface AnnotateSubmitOptions {
  vcfPath?: string;
  vcfUri?: string;        // gs:// or s3:// URI for a freshly-minted VCF
                          // (skips _find_vcf_across_all_sources discovery)
  annotators?: string;
  assembly?: string;
  quiet?: boolean;
  json?: boolean;
  wait?: boolean;
  package?: string;       // rare_coding | hereditary_cancer | wes_default | wgs_default | ...
  phenotype?: string;
}

const GENOBANK_API = process.env.GENOBANK_API_URL || 'https://genobank.app';

const BIOFS_GIFT_CODE = 'DANI-MAST-CODE-2025';

// Pipeline-default 19-annotator preset for WES/WGS pipelines. Mirrors the
// _background_cravat_job() set on the production VCF Annotator. Used by
// `biofs pipeline run-wes` so every Digital Twin gets a consistent panel.
const WES_DEFAULT_ANNOTATORS = [
  'clinvar', 'cadd', 'gnomad3', 'sift', 'polyphen2', 'alphamissense',
  'revel', 'omim', 'hpo', 'vest', 'gerp', 'eve', 'regeneron', 'allofus250k',
  'cosmic', 'spliceai', 'pharmgkb', 'clingen', 'loftool',
];

// All 146 annotators available in OpenCRAVAT
const ALL_ANNOTATORS = [
  'abraom', 'alfa', 'allofus250k', 'aloft', 'alphamissense', 'arrvars', 'bayesdel', 'biogrid',
  'brca1_func_assay', 'cadd', 'cadd_exome', 'cancer_genome_interpreter', 'cancer_hotspots',
  'cardioboost', 'ccr', 'ccre_screen', 'cedar', 'cgc', 'cgd', 'cgl', 'chasmplus',
  'chasmplus_READ', 'chasmplus_SKCM', 'chasmplus_TGCT', 'chasmplus_THYM', 'chasmplus_UCS',
  'chasmplus_UVM', 'civic', 'civic_gene', 'clingen', 'clingen_allele_registry', 'clinpred',
  'clinvar', 'clinvar_acmg', 'cosmic', 'cosmic_gene', 'cscape', 'cscape_coding', 'cvdkp',
  'dann', 'dann_coding', 'dbcid', 'dbscsnv', 'dbsnp', 'dbsnp_common', 'denovo', 'dgi',
  'encode_tfbs', 'ensembl_regulatory_build', 'esm1b', 'esp6500', 'ess_gene', 'eve',
  'exac_gene', 'fathmm', 'fathmm_mkl', 'fathmm_xf', 'fathmm_xf_coding', 'fitcons',
  'flank_seq', 'funseq2', 'genehancer', 'genocanyon', 'gerp', 'geuvadis', 'ghis', 'gmvp',
  'gnomad', 'gnomad3', 'gnomad3_counts', 'gnomad4', 'gnomad_gene', 'go', 'grasp', 'gtex',
  'gwas_catalog', 'hg19', 'hgdp', 'hpo', 'intact', 'interpro', 'javierre_promoters',
  'linsight', 'litvar', 'litvar_full', 'loftool', 'lrt', 'mavedb', 'metalr', 'metarnn',
  'metasvm', 'mirbase', 'mistic', 'mitomap', 'mupit', 'mutation_assessor', 'mutationtaster',
  'mutpanning', 'mutpred1', 'mutpred_indel', 'ncbigene', 'ncer', 'ncrna', 'ndex',
  'ndex_chd', 'ndex_signor', 'omim', 'oncokb', 'pangalodb', 'pharmgkb', 'phastcons',
  'phdsnpg', 'phi', 'phylop', 'polyphen2', 'prec', 'primateai', 'provean', 'pseudogene',
  'pubmed', 'regeneron', 'regulomedb', 'repeat', 'revel', 'rvis', 'segway', 'sift',
  'siphy', 'spliceai', 'swissprot_binding', 'swissprot_domains', 'swissprot_ptm', 'target',
  'thousandgenomes', 'thousandgenomes_ad_mixed_american', 'thousandgenomes_african',
  'thousandgenomes_east_asian', 'thousandgenomes_european', 'thousandgenomes_south_asian',
  'trinity', 'uk10k_cohort', 'uniprot', 'uniprot_domain', 'varity_r', 'vest', 'vista_enhancer'
];

export async function annotateSubmitCommand(
  biosampleSerial: string,
  options: AnnotateSubmitOptions = {}
): Promise<string | null> {
  const spinner = ora('Initializing OpenCRAVAT annotation...').start();

  try {
    // Get credentials
    const credentials = await getCredentials();
    if (!credentials) {
      throw new Error('Not authenticated. Please run "biofs login" first.');
    }

    const userWallet = credentials.wallet_address;
    const userSignature = credentials.user_signature;

    // Determine annotator count for display. Backend uses expert_curator_minimum
    // (19 annotators) for wes_default/wgs_default/rare_coding; "all" package uses 146.
    const pkg = options.package || 'rare_coding';
    const annotatorCount = options.annotators
      ? options.annotators.split(',').length
      : (pkg === 'all' ? ALL_ANNOTATORS.length : WES_DEFAULT_ANNOTATORS.length);

    if (!options.quiet) {
      spinner.stop();
      console.log(chalk.cyan('\n🧬 BioFS OpenCRAVAT Annotation'));
      console.log(chalk.gray('━'.repeat(50)));
      console.log(`\n🔬 Biosample: ${chalk.white(biosampleSerial)}`);
      console.log(`👤 Wallet: ${chalk.white(userWallet.substring(0, 10))}...`);
      console.log(`📊 Package: ${chalk.white(options.package || 'rare_coding')}`);
      console.log(`📊 Annotators: ${chalk.white(`${annotatorCount}${annotatorCount === ALL_ANNOTATORS.length ? ' (all available)' : ''}`)}\n`);
    }

    // Step 1: Determine VCF filename
    spinner.start('Step 1/3: Locating VCF file...');

    // --vcf-uri (gs://… or s3://…) wins over --vcf-path so a freshly-minted
    // pipeline VCF can be passed in directly without depending on the
    // backend's _find_vcf_across_all_sources discovery heuristic. Just pull
    // the basename and let the gift_code endpoint resolve via target_filename.
    let vcfFilename =
      (options.vcfUri ? options.vcfUri.split('/').pop() : '')
      || (options.vcfPath ? path.basename(options.vcfPath) : '');

    if (!vcfFilename) {
      // The backend's annotate_vcf_using_gift_code calls _find_vcf_across_all_sources
      // when target_filename is provided — it searches VCF registrations, Story IP
      // assets, GCS buckets, BioIP registry, and Clara output. We just need to give
      // it a reasonable filename to search for. Try patterns in priority order;
      // the backend will verify the file actually exists in GCS.
      const possibleFilenames = [
        `${biosampleSerial}.deepvariant.vcf`,
        `${biosampleSerial}.deepvariant.agilent_v8.vcf`,
        `${biosampleSerial}.deepvariant.g.vcf`,
        `${biosampleSerial}.vcf`
      ];

      // Pick the first one — the backend will search across all sources
      vcfFilename = possibleFilenames[0];

      // If the user registered a specific VCF, check the registration service
      try {
        const regResp = await axios.get(`${GENOBANK_API}/api_vcf_annotator/get_job_status`, {
          params: { user_signature: userSignature },
          timeout: 10000,
          validateStatus: () => true,
        });
        const regData = regResp.data?.status_details?.data || regResp.data;
        if (regData?.filename) {
          vcfFilename = regData.filename;
        }
      } catch {
        // Non-fatal — proceed with pattern-based filename
      }
    }

    spinner.succeed(`Step 1/3: VCF target: ${vcfFilename}`);

    // Step 2: Submit annotation job via GenoBank API
    spinner.start('Step 2/3: Submitting to GenoBank VCF Annotator...');

    // The backend's annotate_vcf_using_gift_code uses package_string to pick
    // annotators internally (expert_curator_minimum = 19 annotators for any
    // unrecognized package including wes_default/wgs_default). We only send
    // fields the backend actually reads: user_signature, gift_code,
    // package_string, phenotype, target_filename, assembly.
    const annotationData: Record<string, string> = {
      user_signature: userSignature,
      gift_code: BIOFS_GIFT_CODE,
      package_string: options.package || 'rare_coding',
      phenotype: options.phenotype || `BioFS annotation for biosample ${biosampleSerial}`,
      target_filename: vcfFilename,
      assembly: options.assembly || 'hg38',
    };

    const submitResponse = await axios.post(
      `${GENOBANK_API}/api_vcf_annotator/annotate_vcf_using_gift_code`,
      annotationData,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 120000
      }
    );

    // Parse response
    const responseData = submitResponse.data;
    let jobId: string | null = null;
    let openCravatJobId: string | null = null;

    if (responseData.status === 'already_running') {
      jobId = responseData.job_id;
      spinner.warn(`Step 2/3: Job already running: ${jobId}`);
      if (!options.quiet) {
        console.log(chalk.yellow(`\n  A ${options.package || 'rare_coding'} analysis is already in progress for this file.`));
        console.log(chalk.gray(`  Monitor it with: biofs annotate status ${jobId}\n`));
      }
      return jobId;
    }

    if (responseData.status === 'Success' || responseData.status_details?.data) {
      const data = responseData.status_details?.data || responseData;
      jobId = data.job_id || data.jobId;
      openCravatJobId = data.opencravat_job_id || data.openCravatJobId;
    } else if (typeof responseData === 'string') {
      jobId = responseData.trim();
    } else if (responseData.job_id) {
      jobId = responseData.job_id;
    }

    if (!jobId) {
      spinner.fail('Step 2/3: Failed to get job ID');
      Logger.debug(`Response: ${JSON.stringify(responseData)}`);
      throw new Error('Failed to submit annotation job - no job ID returned');
    }

    spinner.succeed(`Step 2/3: Job submitted: ${jobId}${openCravatJobId ? ` (OpenCRAVAT: ${openCravatJobId})` : ''}`);

    // Step 3: Confirm job status
    spinner.start('Step 3/3: Confirming job status...');

    // Give the job a moment to register
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Check job status (endpoint only uses user_signature)
    const statusResponse = await axios.get(`${GENOBANK_API}/api_vcf_annotator/get_job_status`, {
      params: {
        user_signature: userSignature
      },
      timeout: 30000
    });

    const statusData = statusResponse.data?.status_details?.data || statusResponse.data;
    const jobStatus = statusData?.status || 'pending';

    spinner.succeed(`Step 3/3: Job status: ${jobStatus}`);

    // Display results
    console.log(chalk.gray('\n' + '━'.repeat(50)));
    console.log(chalk.green.bold('🎉 Annotation Job Submitted!'));
    console.log(chalk.gray('━'.repeat(50) + '\n'));

    console.log(`${chalk.cyan('📋 Job ID:')}        ${chalk.white(jobId)}`);
    if (openCravatJobId) {
      console.log(`${chalk.cyan('🔬 OC Job ID:')}     ${chalk.white(openCravatJobId)}`);
    }
    console.log(`${chalk.cyan('🔬 Biosample:')}     ${chalk.white(biosampleSerial)}`);
    console.log(`${chalk.cyan('📁 VCF File:')}      ${chalk.gray(vcfFilename)}`);
    console.log(`${chalk.cyan('📊 Package:')}       ${chalk.white(options.package || 'rare_coding')}`);
    console.log(`${chalk.cyan('🧬 Assembly:')}      ${chalk.white(options.assembly || 'hg38')}`);
    console.log(`${chalk.cyan('📈 Status:')}        ${chalk.yellow(jobStatus)}`);

    console.log(chalk.gray('\n💡 Monitor job:'));
    console.log(chalk.gray(`   biofs annotate status ${jobId}`));

    // Optionally wait for completion
    if (options.wait) {
      console.log(chalk.yellow('\n⏳ Waiting for job to complete...'));
      const result = await waitForJobCompletion(jobId, userSignature);
      if (result.status === 'completed') {
        console.log(chalk.green('\n✅ Annotation completed successfully!'));
        console.log(chalk.gray(`   Results: ${GENOBANK_API}/api_vcf_annotator/get_results_folder?user_signature=...&job_id=${jobId}`));
      } else if (result.status === 'failed') {
        console.log(chalk.red(`\n❌ Annotation failed: ${result.message || 'Unknown error'}`));
      } else {
        console.log(chalk.yellow(`\n⏳ Job still running: ${result.status}`));
      }
    }

    if (options.json) {
      console.log(JSON.stringify({
        success: true,
        jobId,
        openCravatJobId,
        biosampleSerial,
        vcfFile: vcfFilename,
        package: options.package || 'rare_coding',
        assembly: options.assembly || 'hg38',
        status: jobStatus,
        statusUrl: `${GENOBANK_API}/api_vcf_annotator/get_job_status?job_id=${jobId}`
      }, null, 2));
    }

    return jobId;

  } catch (error: any) {
    spinner.fail(chalk.red('Annotation submission failed'));

    if (error.response) {
      const errorData = error.response.data;
      const errorMsg = errorData?.status_details?.description ||
                       errorData?.error ||
                       errorData?.message ||
                       JSON.stringify(errorData);
      Logger.error(`Server error (${error.response.status}): ${errorMsg}`);
    } else if (error.request) {
      Logger.error(`Cannot connect to GenoBank API`);
    } else {
      Logger.error(`Error: ${error.message}`);
    }

    throw error;
  }
}

async function waitForJobCompletion(
  jobId: string,
  userSignature: string,
  timeoutMs: number = 3600000 // 1 hour
): Promise<{ status: string; message?: string }> {
  const startTime = Date.now();
  const pollInterval = 30000; // 30 seconds

  while (Date.now() - startTime < timeoutMs) {
    try {
      const response = await axios.get(`${GENOBANK_API}/api_vcf_annotator/get_job_status`, {
        params: {
          user_signature: userSignature,
          job_id: jobId
        },
        timeout: 30000
      });

      const data = response.data?.status_details?.data || response.data;
      const status = data?.status || 'Unknown';
      process.stdout.write(`\r  Status: ${status}...                    `);

      if (status === 'completed') {
        return { status };
      } else if (status === 'failed' || status === 'error') {
        return { status: 'failed', message: data?.error || data?.message };
      }

      await new Promise(resolve => setTimeout(resolve, pollInterval));
    } catch {
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  return { status: 'Timeout', message: 'Job did not complete within timeout' };
}


