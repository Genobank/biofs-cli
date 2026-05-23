/**
 * Shared gene-to-UniProt and gene-to-Pfam mapping for the biofs-rrm pipeline.
 *
 * Previously each verb (rrm-consensus, rrm-distribution, rrm-train, fourier-score)
 * carried its own local copy of these maps, which led to drift and bugs where
 * cohort-train would call rrm-train against a gene that rrm-consensus knew
 * about but rrm-train did not. This module is the single source of truth.
 *
 * To add a new gene to the pipeline:
 *   1. Add an entry to GENE_TO_UNIPROT with the canonical UniProt accession.
 *   2. Add an entry to GENE_TO_PFAM with the most representative Pfam family
 *      ID (used by rrm-consensus for ortholog sequence retrieval).
 *   3. No other code changes required; all verbs will see the new gene.
 *
 * Sources:
 *   - UniProt accessions verified against https://www.uniprot.org
 *   - Pfam family IDs from InterPro / Pfam at https://www.ebi.ac.uk/interpro
 */

export const GENE_TO_UNIPROT: Record<string, string> = {
  // GT classifier base case (Case 1)
  ITGA2B:  'P08514',
  ITGB3:   'P05106',

  // Case 2 (adult male, skeletal dysplasia, oligogenic candidates)
  COL27A1: 'Q8IZC6',
  NRCAM:   'Q92823',
  TSPAN6:  'O43657',
  PGAP1:   'Q75T13',
  DCLK2:   'Q8N568',
  HSPB2:   'Q16082',
  SLC12A3: 'P55017',

  // Case 3 (female pediatric epilepsy)
  KMT5B:   'Q4FZB7',   // Histone-lysine N-methyltransferase KMT5B (SUV4-20H1)
  CHD2:    'O14647',   // Chromodomain-helicase-DNA-binding protein 2
  GRIN2A:  'Q12879',   // Glutamate receptor ionotropic, NMDA 2A

  // Case 4 (family vault fam_53a4ab0d299b — purine-pathway SCID carriers)
  ADA:     'P00813',   // Adenosine deaminase
  PNP:     'P00491',   // Purine nucleoside phosphorylase

  // Case 5 (family vault fam_a42767ead27a)
  AIRE:    'O43918',
  // F7 is splice-region in Case 5, no missense scoring needed

  // Cases 6, 8, 9
  PDE11A:  'Q9HCR9',   // Case 6
  SLC24A4: 'Q8NFF2',   // Case 6
  KDM5C:   'P41229',   // Case 9
  HERC1:   'Q15751',   // Case 9

  // Cohort benchmark: periodicity-rich arm
  COL1A1:  'P02452',
  COL3A1:  'P02461',
  COL7A1:  'Q02388',
  FBN1:    'P35555',
  TTN:     'Q8WZ42',
  NEB:     'P20929',

  // Cohort benchmark: compositional/structural arm
  BRCA1:   'P38398',
  BRCA2:   'P51587',
  TP53:    'P04637',
  MLH1:    'P40692',
  MSH2:    'P43246',
  CFTR:    'P13569',
  LDLR:    'P01130',

  // Case 1 son cross-reference (LCHAD candidate)
  HADHA:   'P40939',   // HADHA (alpha subunit MTP / LCHAD)
};

export const GENE_TO_PFAM: Record<string, string> = {
  ITGA2B:  'PF08441',  // Integrin_alpha
  ITGB3:   'PF00362',  // Integrin beta

  COL27A1: 'PF01391',  // Collagen
  NRCAM:   'PF00041',  // fn3
  TSPAN6:  'PF00335',  // Tetraspanin
  PGAP1:   'PF02230',  // Abhydro_lipase
  DCLK2:   'PF03607',  // DCX doublecortin
  HSPB2:   'PF00011',  // HSP20
  SLC12A3: 'PF03522',  // SLC12

  KMT5B:   'PF00856',  // SET
  CHD2:    'PF00271',  // Helicase_C
  GRIN2A:  'PF00060',  // Lig_chan

  ADA:     'PF00962',  // A_deaminase
  PNP:     'PF01048',  // PNP_UDP_1
  AIRE:    'PF00643',  // zf-B_box

  PDE11A:  'PF00233',  // PDEase_I
  SLC24A4: 'PF01699',  // Na_Ca_exchanger
  KDM5C:   'PF02373',  // JmjC
  HERC1:   'PF00400',  // WD40

  COL1A1:  'PF01391',  // Collagen
  COL3A1:  'PF01391',
  COL7A1:  'PF01391',
  FBN1:    'PF07645',  // EGF_CA
  TTN:     'PF00041',  // fn3
  NEB:     'PF00880',  // Nebulin

  BRCA1:   'PF00533',  // BRCT
  BRCA2:   'PF09104',  // BRCA-2_helical
  TP53:    'PF00870',  // P53
  MLH1:    'PF01119',  // DNA_mis_repair
  MSH2:    'PF01624',  // MutS_I
  CFTR:    'PF00664',  // ABC_membrane
  LDLR:    'PF00057',  // Ldl_recept_a

  HADHA:   'PF00378',  // ECH_1
};

export function getUniProt(gene: string): string | undefined {
  return GENE_TO_UNIPROT[gene.toUpperCase()];
}

export function getPfam(gene: string): string | undefined {
  return GENE_TO_PFAM[gene.toUpperCase()];
}

export function listKnownGenes(): string[] {
  return Object.keys(GENE_TO_UNIPROT).sort();
}
