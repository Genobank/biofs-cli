#!/usr/bin/env python3
"""Build the validation benchmark for biofs protein-impact from PUBLIC data only.

Inputs (downloaded once, kept with the benchmark so the build is reproducible):
  clinvar_esummary_<GENE>.json   NCBI ClinVar esummary records for the gene's missense variants
  gnomad_<GENE>.json             gnomAD v4 gene variants (GraphQL), canonical transcript
  domains.json                   structural domains in HGVS numbering (CATH of 3FCS)

Rules, fixed before any model was run (see docs/PROTEIN_IMPACT.md):
  label 1 (damaging)  ClinVar Pathogenic or Likely pathogenic, review status 2 stars or more
                      (expert panel, practice guideline, or multiple submitters without conflict)
  label 0 (tolerated) tier B: ClinVar Benign or Likely benign, 2 stars or more
                      tier C: gnomAD v4 missense with no ClinVar Pathogenic or Likely pathogenic record at any
                      review level, and either (a) total allele frequency >= 0.001, the largest a fully
                      penetrant recessive variant could have for a disorder with a prevalence near 1 in
                      1,000,000, or (b) seen homozygous in at least 1 person with at least 20 alleles, the
                      ACMG BS2 logic for a severe recessive disorder (needed because the beta-propeller
                      carries almost no common variants); (b) is not used when ClinVar classifications of
                      the change conflict.
  excluded            uncertain significance, conflicting, single submitter only, non-missense, no p. change,
                      an amino acid change that carries both labels
One row per amino acid change. Nothing about any sample is read or written here.

Usage: build_benchmark.py <raw_dir> <domains.json> <out_dir> [<benchmark.json for the CLI>]
"""
import hashlib
import json
import os
import re
import sys
from collections import Counter, OrderedDict

AA3 = {'Ala': 'A', 'Arg': 'R', 'Asn': 'N', 'Asp': 'D', 'Cys': 'C', 'Gln': 'Q', 'Glu': 'E', 'Gly': 'G', 'His': 'H', 'Ile': 'I',
       'Leu': 'L', 'Lys': 'K', 'Met': 'M', 'Phe': 'F', 'Pro': 'P', 'Ser': 'S', 'Thr': 'T', 'Trp': 'W', 'Tyr': 'Y', 'Val': 'V'}
SIGNAL = {'ITGA2B': 31, 'ITGB3': 26}
LENGTH = {'ITGA2B': 1039, 'ITGB3': 788}
PLP = {'Pathogenic', 'Likely pathogenic', 'Pathogenic/Likely pathogenic'}
BLB = {'Benign', 'Likely benign', 'Benign/Likely benign'}
TWO_STARS = {'reviewed by expert panel', 'practice guideline', 'criteria provided, multiple submitters, no conflicts'}
AF_FLOOR = 0.001
HOM_MIN_AC = 20
P_TITLE = re.compile(r'\(p\.([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2})\)')
P_GNOMAD = re.compile(r'^p\.([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2})$')
C_TITLE = re.compile(r':(c\.[^ ]+)')


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def domain_lookup(domains):
    def lookup(gene, pos):
        for r in domains['genes'][gene]:
            if r['start'] <= pos <= r['end']:
                return r['domain']
        raise ValueError('%s %d outside the domain table' % (gene, pos))
    return lookup


def main(raw_dir, domains_path, out_dir, json_out=None):
    domains = json.load(open(domains_path))
    domain_of = domain_lookup(domains)
    rows = OrderedDict()
    seen_clinvar = {}
    dropped = Counter()
    inputs = {}

    for gene in ('ITGA2B', 'ITGB3'):
        cv_path = os.path.join(raw_dir, 'esummary_%s.json' % gene)
        gn_path = os.path.join(raw_dir, 'gnomad_%s.json' % gene)
        inputs[os.path.basename(cv_path)] = sha256_file(cv_path)
        inputs[os.path.basename(gn_path)] = sha256_file(gn_path)

        # --- ClinVar
        per_change = {}
        for uid, r in json.load(open(cv_path)).items():
            m = P_TITLE.search(r.get('title', ''))
            if not m or m.group(1) not in AA3 or m.group(3) not in AA3:
                dropped['clinvar: no missense p. change'] += 1
                continue
            ref, pos, alt = AA3[m.group(1)], int(m.group(2)), AA3[m.group(3)]
            gc = r.get('germline_classification') or {}
            cls, rev = gc.get('description', ''), gc.get('review_status', '')
            c = C_TITLE.search(r.get('title', ''))
            key = (gene, pos, ref, alt)
            per_change.setdefault(key, []).append({'acc': r.get('accession', uid), 'cls': cls, 'rev': rev, 'cdna': c.group(1) if c else ''})
        for key, recs in per_change.items():
            seen_clinvar[key] = recs

        # --- gnomAD
        agg = {}
        gene_doc = json.load(open(gn_path))['data']['gene']
        canonical = gene_doc['canonical_transcript_id']
        for v in gene_doc['variants']:
            # the API also returns variants annotated on other transcripts, whose protein numbering differs
            if v.get('transcript_id') != canonical:
                dropped['gnomad: annotated on a non-canonical transcript'] += 1
                continue
            if v.get('consequence') != 'missense_variant' or not v.get('hgvsp'):
                continue
            m = P_GNOMAD.match(v['hgvsp'])
            if not m or m.group(1) not in AA3 or m.group(3) not in AA3:
                continue
            ac = hom = an = 0
            for part in ('exome', 'genome'):
                e = v.get(part)
                if e:
                    ac += e['ac']; an += e['an']; hom += e.get('ac_hom') or 0
            key = (gene, int(m.group(2)), AA3[m.group(1)], AA3[m.group(3)])
            a = agg.setdefault(key, {'ac': 0, 'an': 0, 'hom': 0})
            a['ac'] += ac; a['hom'] += hom; a['an'] = max(a['an'], an)
        af = {k: (a['ac'] / a['an'] if a['an'] else 0.0, a['hom'], a['ac']) for k, a in agg.items()}

        # --- labels
        for key, recs in per_change.items():
            plp = [x for x in recs if x['cls'] in PLP and x['rev'] in TWO_STARS]
            blb = [x for x in recs if x['cls'] in BLB and x['rev'] in TWO_STARS]
            if plp and blb:
                dropped['clinvar: both labels for one amino acid change'] += 1
                continue
            if plp:
                rows[key] = dict(label=1, tier='B', evidence='clinvar_plp', rec=plp[0])
            elif blb:
                rows[key] = dict(label=0, tier='B', evidence='clinvar_blb', rec=blb[0])
        for key, (f, hom, ac) in af.items():
            common = f >= AF_FLOOR
            homozygous = hom >= 1 and ac >= HOM_MIN_AC
            if not (common or homozygous):
                continue
            if not common and any(x['cls'].startswith('Conflicting') for x in per_change.get(key, [])):
                dropped['gnomad: homozygous but ClinVar classifications conflict'] += 1
                continue
            any_plp = any(x['cls'] in PLP for x in per_change.get(key, []))
            if any_plp:
                dropped['gnomad: common but ClinVar pathogenic at some level'] += 1
                continue
            if key in rows:
                if rows[key]['label'] == 0:
                    rows[key]['evidence'] += '+gnomad'
                continue
            rows[key] = dict(label=0, tier='C', evidence='gnomad_af' if common else 'gnomad_hom', rec=(per_change.get(key) or [{}])[0])
        # attach AF to every kept row of this gene
        for key in list(rows):
            if key[0] == gene:
                rows[key]['af'] = af.get(key, (None, None, None))[:2]

    out = []
    for key in sorted(rows, key=lambda k: (k[0], k[1], k[3])):
        gene, pos, ref, alt = key
        if pos <= SIGNAL[gene]:
            dropped['signal peptide (not part of the mature chain the verb scores)'] += 1
            continue
        r = rows[key]
        a, hom = r.get('af', (None, None))
        out.append([
            '%s:p.%s%d%s' % (gene, ref, pos, alt), gene, pos, ref, alt, pos - SIGNAL[gene], domain_of(gene, pos),
            r['label'], r['tier'], r['evidence'], r['rec'].get('acc', ''), r['rec'].get('cls', ''), r['rec'].get('rev', ''),
            r['rec'].get('cdna', ''), '' if a is None else '%.6g' % a, '' if hom is None else hom,
        ])
    header = ['variant_id', 'gene', 'hgvs_pos', 'ref', 'alt', 'mature_pos', 'domain', 'label', 'tier', 'evidence',
              'clinvar_vcv', 'clinvar_class', 'clinvar_review', 'cdna', 'gnomad_af', 'gnomad_hom']
    os.makedirs(out_dir, exist_ok=True)
    tsv = os.path.join(out_dir, 'gt_benchmark_v1.tsv')
    with open(tsv, 'w') as f:
        f.write('\t'.join(header) + '\n')
        for r in out:
            f.write('\t'.join(str(x) for x in r) + '\n')

    counts = Counter((r[1], r[7]) for r in out)
    by_domain = Counter((r[6], r[7]) for r in out)
    prov = OrderedDict([
        ('schema', 'genobank.protein-impact.benchmark/v1'),
        ('file', 'gt_benchmark_v1.tsv'),
        ('sha256', sha256_file(tsv)),
        ('rows', len(out)),
        ('damaging', sum(1 for r in out if r[7] == 1)),
        ('tolerated', sum(1 for r in out if r[7] == 0)),
        ('by_gene_label', {'%s:%d' % k: v for k, v in sorted(counts.items())}),
        ('by_domain_label', {'%s:%d' % k: v for k, v in sorted(by_domain.items())}),
        ('af_floor', AF_FLOOR),
        ('hom_min_alleles', HOM_MIN_AC),
        ('inputs_sha256', inputs),
        ('domains_sha256', sha256_file(domains_path)),
        ('script_sha256', sha256_file(os.path.abspath(__file__))),
        ('dropped', dict(dropped)),
    ])
    with open(os.path.join(out_dir, 'gt_benchmark_v1.provenance.json'), 'w') as f:
        json.dump(prov, f, indent=2)
        f.write('\n')
    if json_out:
        # compact copy the CLI bundles; the gate document pins sha256 of its canonical form
        cols = ['variant_id', 'gene', 'hgvs_pos', 'ref', 'alt', 'domain', 'label', 'tier', 'evidence', 'clinvar_vcv', 'gnomad_af', 'gnomad_hom']
        idx = [header.index(c) for c in cols]
        def num(x):
            return None if x == '' else float(x)
        bundle = OrderedDict([
            ('schema', 'genobank.protein-impact.benchmark/v1'),
            ('name', 'gt_benchmark_v1'),
            ('tsv_sha256', prov['sha256']),
            ('rules', OrderedDict([('clinvar_min_stars', 2), ('af_floor', AF_FLOOR), ('hom_min_alleles', HOM_MIN_AC)])),
            ('columns', cols),
            ('rows', [[(r[i] if cols[k] not in ('gnomad_af', 'gnomad_hom') else num(str(r[i]))) for k, i in enumerate(idx)] for r in out]),
        ])
        with open(json_out, 'w') as f:
            json.dump(bundle, f, separators=(',', ':'))
            f.write('\n')
    print(json.dumps(prov, indent=2))


if __name__ == '__main__':
    if len(sys.argv) not in (4, 5):
        sys.exit(__doc__)
    main(*sys.argv[1:])
