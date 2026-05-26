/**
 * biofs rrm-train <gene>
 *
 * Train an XGBoost ensemble combining Cosic-RRM spectral features (from
 * `biofs rrm-distribution`) with deep-learning pathogenicity predictors
 * (AlphaMissense, REVEL, PrimateAI from MyVariant.info / dbNSFP).
 *
 * Hypothesis: Cosic-RRM features add incremental signal beyond AlphaMissense
 * alone, especially for rare-disease genes where AM under-performs.
 *
 * Pipeline:
 *   1. Load cached ClinVar distribution + Cosic features for <gene>.
 *   2. Batch-fetch AM/REVEL/PrimateAI/EVE scores from MyVariant.info using
 *      hgvs_genomic notation.
 *   3. Build feature matrix; binary label P+LP=1, B+LB=0 (drop VUS / conflicting).
 *   4. Stratified k-fold CV with three model families:
 *        a. AM-only baseline
 *        b. Cosic-only
 *        c. Full ensemble (AM + REVEL + PrimateAI + Cosic features)
 *   5. Report AUC + feature importance for each.
 *   6. If --predict <hgvs,...> is passed, apply the full ensemble model to
 *      those patient variants.
 */

import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import ora from 'ora';

const RRM_CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'rrm');
const UNIPROT_CACHE_DIR = path.join(os.homedir(), '.biofs', 'cache', 'uniprot');

import { GENE_TO_UNIPROT } from '../lib/gene-map';

export interface RrmTrainOptions {
  refresh?: boolean;            // re-fetch MyVariant.info scores
  predict?: string;             // comma-separated HGVS protein changes to predict
  folds?: string;               // CV folds (default 5)
  plot?: string;                // PNG path for ROC + feature importance
  quiet?: boolean;
  includePredictions?: boolean; // persist per-variant CV predictions for stacking analysis
}

const PY_TRAIN = `
import json, sys, os, urllib.request, time, traceback
import numpy as np
try:
    from sklearn.ensemble import GradientBoostingClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import StratifiedKFold, cross_val_score
    from sklearn.metrics import roc_auc_score, roc_curve, average_precision_score
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import Pipeline
    from sklearn.impute import SimpleImputer
except Exception as e:
    print(json.dumps({'error': f'sklearn not available: {e}. Install: python3 -m pip install scikit-learn'}))
    sys.exit(2)

cfg = json.loads(sys.stdin.read())
variants = cfg['variants']
predict_targets = cfg.get('predict_targets', [])
n_folds = int(cfg.get('folds', 5))
plot_path = cfg.get('plot_path')
gene = cfg['gene']
include_predictions = bool(cfg.get('include_predictions', False))

# Fetch AM/REVEL/PrimateAI etc. via MyVariant.info batch using dbSNP rsIDs.
# rsID-based queries return scalar dbnsfp.<predictor> values directly;
# the HGVS-genomic endpoint uses hg19 not hg38 so we avoid it.
def fetch_mv_batch(rsid_list):
    if not rsid_list:
        return {}
    fields = 'dbnsfp.alphamissense,dbnsfp.revel,dbnsfp.primateai,dbnsfp.eve,dbnsfp.esm1b,dbnsfp.cadd,dbnsfp.metarnn,dbnsfp.bayesdel,dbnsfp.clinpred'
    out = {}
    for i in range(0, len(rsid_list), 100):
        chunk = rsid_list[i:i+100]
        body = f'ids={",".join(chunk)}&fields={fields}&dotfield=true'.encode()
        req = urllib.request.Request(
            'https://myvariant.info/v1/variant',
            data=body,
            headers={'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'biofs/3.2.0'},
        )
        for attempt in range(3):
            try:
                resp = urllib.request.urlopen(req, timeout=60)
                results = json.loads(resp.read())
                if not isinstance(results, list):
                    results = [results]
                for r in results:
                    qid = r.get('query') or ''
                    if qid:
                        # Multiple transcript hits for same rsID may return as list;
                        # keep the first valid response per rsID.
                        if qid not in out or out[qid].get('notfound'):
                            out[qid] = r
                break
            except Exception as e:
                if attempt == 2:
                    print(f'  MyVariant.info batch failed for chunk {i//100}: {e}', file=sys.stderr)
                else:
                    time.sleep(1 + attempt * 2)
        time.sleep(0.15)  # polite
    return out

rsid_to_variant = {v['dbsnp_rsid']: v for v in variants if v.get('dbsnp_rsid')}
rsid_list = list(rsid_to_variant.keys())
print(f'  Fetching MyVariant.info scores via {len(rsid_list)} dbSNP rsIDs ({len(variants) - len(rsid_list)} variants have no rsID, will be imputed)...', file=sys.stderr)
mv_results = fetch_mv_batch(rsid_list)
print(f'  Got responses for {sum(1 for v in mv_results.values() if not v.get("notfound"))} / {len(rsid_list)} rsIDs', file=sys.stderr)

def get_score(mv, fields):
    """Try a list of field paths (with dotfield=true on MyVariant.info, scores
    arrive flat like 'dbnsfp.alphamissense.score' or 'dbnsfp.alphamissense' if scalar)."""
    if not mv or mv.get('notfound'):
        return None
    for fp in fields:
        if fp in mv:
            v = mv[fp]
            if v is None: continue
            if isinstance(v, list):
                nums = [x for x in v if isinstance(x, (int, float))]
                if nums:
                    return float(np.mean(nums))
                continue
            try:
                return float(v)
            except (TypeError, ValueError):
                continue
    return None

# Build feature matrix
feature_names = [
    'alphamissense', 'revel', 'primateai', 'eve', 'esm1b', 'cadd', 'metarnn',
    'cosic_full_l1', 'cosic_win_sum_dfdc', 'cosic_fc_ratio',
    'cosic_weighted_agg_de', 'cosic_total_de_pct',
]
positive = {'pathogenic', 'likely_pathogenic'}
negative = {'benign', 'likely_benign'}

X_all = []
y_all = []
groups = []  # for later analysis
mv_field_paths = {
    'alphamissense': ['dbnsfp.alphamissense.score', 'dbnsfp.alphamissense'],
    'revel': ['dbnsfp.revel.score', 'dbnsfp.revel'],
    'primateai': ['dbnsfp.primateai.score', 'dbnsfp.primateai'],
    'eve': ['dbnsfp.eve.score', 'dbnsfp.eve'],
    'esm1b': ['dbnsfp.esm1b.score', 'dbnsfp.esm1b'],
    'cadd': ['dbnsfp.cadd.phred', 'dbnsfp.cadd'],
    'metarnn': ['dbnsfp.metarnn.score', 'dbnsfp.metarnn'],
}
cosic_fields = {
    'cosic_full_l1': 'fullSpectrumL1',
    'cosic_win_sum_dfdc': 'windowedSumAbsDFDc',
    'cosic_fc_ratio': 'fcRatio',
    'cosic_weighted_agg_de': 'weightedAggregateDeltaEPct',
    'cosic_total_de_pct': 'totalEnergyChangePct',
}

dropped_no_label = 0
dropped_no_features = 0

variant_records = []
for v in variants:
    cls = v.get('classification_simple', '')
    if cls in positive:
        y = 1
    elif cls in negative:
        y = 0
    else:
        dropped_no_label += 1
        continue
    rsid = v.get('dbsnp_rsid') or ''
    hgvs = v.get('hgvs_genomic') or ''
    mv = mv_results.get(rsid, {}) if rsid else {}
    row = {}
    has_any = False
    for fn in feature_names:
        if fn in mv_field_paths:
            val = get_score(mv, mv_field_paths[fn])
        else:
            val = v.get(cosic_fields.get(fn, ''))
        row[fn] = val
        if val is not None:
            has_any = True
    if not has_any:
        dropped_no_features += 1
        continue
    X_all.append([row[fn] if row[fn] is not None else np.nan for fn in feature_names])
    y_all.append(y)
    variant_records.append({
        'hgvs_protein': v.get('hgvs_protein', ''),
        'hgvs_genomic': hgvs,
        'classification': v.get('classification_simple', ''),
        'features': row,
    })

X = np.array(X_all, dtype=float)
y = np.array(y_all, dtype=int)

n_pos = int(y.sum())
n_neg = int(len(y) - n_pos)

print(f'  Training set: {len(y)} variants ({n_pos} pathogenic+LP, {n_neg} benign+LB)', file=sys.stderr)
print(f'  Dropped: {dropped_no_label} no-label, {dropped_no_features} no-features', file=sys.stderr)

if n_pos < 5 or n_neg < 3:
    print(json.dumps({
        'error': f'Insufficient class balance for training: {n_pos} positive, {n_neg} negative',
        'feature_coverage': {fn: int(np.sum(~np.isnan(X[:, i]))) for i, fn in enumerate(feature_names)},
        'n_train': len(y),
    }))
    sys.exit(0)

def auc_with_imputed(X, y, feature_idx, n_folds, seed=42):
    Xs = X[:, feature_idx]
    if Xs.ndim == 1:
        Xs = Xs.reshape(-1, 1)
    pipe = Pipeline([
        ('impute', SimpleImputer(strategy='median')),
        ('clf', GradientBoostingClassifier(n_estimators=200, max_depth=3, learning_rate=0.05, random_state=seed)),
    ])
    skf = StratifiedKFold(n_splits=min(n_folds, n_pos, n_neg), shuffle=True, random_state=seed)
    aucs = []
    all_probs = np.zeros(len(y))
    fold_idx = 0
    for tr, te in skf.split(Xs, y):
        try:
            pipe.fit(Xs[tr], y[tr])
            probs = pipe.predict_proba(Xs[te])[:, 1]
            if len(np.unique(y[te])) > 1:
                aucs.append(roc_auc_score(y[te], probs))
            all_probs[te] = probs
            fold_idx += 1
        except Exception as e:
            print(f'  fold {fold_idx} failed: {e}', file=sys.stderr)
    def _safe(x):
        return float(x) if (x is not None and np.isfinite(x)) else None
    return {
        'n_folds': fold_idx,
        'auc_mean': _safe(np.mean(aucs)) if aucs else None,
        'auc_std': _safe(np.std(aucs)) if aucs else None,
        'aucs': [float(a) for a in aucs],
        'all_probs': all_probs.tolist(),
        'avg_precision': _safe(average_precision_score(y, all_probs)) if len(set(y)) > 1 else None,
    }

# Models to compare
am_idx = [feature_names.index('alphamissense')]
revel_idx = [feature_names.index('revel')]
cosic_idx = [feature_names.index(n) for n in feature_names if n.startswith('cosic_')]
dl_idx = [feature_names.index(n) for n in ['alphamissense', 'revel', 'primateai', 'eve', 'esm1b', 'cadd', 'metarnn']]
all_idx = list(range(len(feature_names)))

print(f'  Training models...', file=sys.stderr)
results = {
    'AM_alone': auc_with_imputed(X, y, am_idx, n_folds),
    'REVEL_alone': auc_with_imputed(X, y, revel_idx, n_folds),
    'Cosic_alone': auc_with_imputed(X, y, cosic_idx, n_folds),
    'DL_only (AM+REVEL+PAI+EVE+ESM+CADD+MetaRNN)': auc_with_imputed(X, y, dl_idx, n_folds),
    'Full_ensemble (DL + Cosic)': auc_with_imputed(X, y, all_idx, n_folds),
}

# Feature importance from full ensemble trained on all data
full_pipe = Pipeline([
    ('impute', SimpleImputer(strategy='median')),
    ('clf', GradientBoostingClassifier(n_estimators=200, max_depth=3, learning_rate=0.05, random_state=42)),
])
full_pipe.fit(X, y)
feature_importance = full_pipe.named_steps['clf'].feature_importances_.tolist()

# Predict on patient variants if requested
predictions = []
for ptv in predict_targets:
    rsid = ptv.get('dbsnp_rsid')
    if rsid:
        mv = fetch_mv_batch([rsid])
        mv_one = mv.get(rsid, {})
    else:
        mv_one = {}
    row = []
    for fn in feature_names:
        if fn in mv_field_paths:
            val = get_score(mv_one, mv_field_paths[fn])
        else:
            val = ptv.get(cosic_fields.get(fn, ''))
        row.append(val if val is not None else np.nan)
    Xp = np.array([row], dtype=float)
    Xp_imp = full_pipe.named_steps['impute'].transform(Xp)
    p = float(full_pipe.named_steps['clf'].predict_proba(Xp_imp)[0, 1])
    predictions.append({
        'label': ptv.get('label', ''),
        'hgvs_genomic': ptv.get('hgvs_genomic'),
        'dbsnp_rsid': rsid,
        'P_path': p,
        'features': {fn: (row[i] if not np.isnan(row[i]) else None) for i, fn in enumerate(feature_names)},
    })

# Bonus: AUC of just AlphaMissense raw score (no model, threshold-free)
am_col = X[:, am_idx[0]]
mask = ~np.isnan(am_col)
if mask.sum() > 5 and len(set(y[mask])) > 1:
    raw_am_auc = float(roc_auc_score(y[mask], am_col[mask]))
else:
    raw_am_auc = None

# Plot ROC curves if requested
if plot_path:
    try:
        import matplotlib
        matplotlib.use('Agg')
        import matplotlib.pyplot as plt
        fig, (ax_roc, ax_imp) = plt.subplots(1, 2, figsize=(14, 6))
        for label, res in results.items():
            if not np.isfinite(res['auc_mean']):
                continue
            fpr, tpr, _ = roc_curve(y, np.array(res['all_probs']))
            ax_roc.plot(fpr, tpr, linewidth=1.6, label=f"{label}  AUC={res['auc_mean']:.3f}±{res['auc_std']:.3f}")
        ax_roc.plot([0, 1], [0, 1], 'k--', alpha=0.4)
        ax_roc.set_xlabel('False Positive Rate')
        ax_roc.set_ylabel('True Positive Rate')
        ax_roc.set_title(f"ROC: Cosic-RRM ensemble vs baselines  |  {gene}  |  n={len(y)} ({n_pos} P+LP, {n_neg} B+LB)")
        ax_roc.legend(loc='lower right', fontsize=9)
        ax_roc.grid(True, alpha=0.3)

        order = np.argsort(feature_importance)[::-1]
        names_sorted = [feature_names[i] for i in order]
        vals_sorted = [feature_importance[i] for i in order]
        colors = ['#1f77b4' if 'cosic' in n else '#d62728' for n in names_sorted]
        ax_imp.barh(range(len(names_sorted)), vals_sorted, color=colors)
        ax_imp.set_yticks(range(len(names_sorted)))
        ax_imp.set_yticklabels(names_sorted)
        ax_imp.invert_yaxis()
        ax_imp.set_xlabel('Gradient-boosting feature importance')
        ax_imp.set_title(f'Feature importance, full ensemble  |  {gene}')
        ax_imp.grid(True, axis='x', alpha=0.3)

        fig.suptitle(f'biofs rrm-train  |  {gene}  |  ensemble validation', y=1.0)
        fig.tight_layout()
        fig.savefig(plot_path, dpi=150, bbox_inches='tight')
        print(f'  Saved plot to {plot_path}', file=sys.stderr)
    except Exception as e:
        print(f'  plot failed: {e}', file=sys.stderr)

out = {
    'gene': gene,
    'n_train': int(len(y)),
    'n_positive': n_pos,
    'n_negative': n_neg,
    'feature_names': feature_names,
    'feature_coverage': {fn: int(np.sum(~np.isnan(X[:, i]))) for i, fn in enumerate(feature_names)},
    'feature_importance': feature_importance,
    'results': (
        # When stacking analysis is requested, keep per-variant CV predictions
        # so downstream callers can fit a meta-learner without re-training.
        results if include_predictions
        else {k: {kk: vv for kk, vv in v.items() if kk != 'all_probs'} for k, v in results.items()}
    ),
    'raw_alphamissense_auc': raw_am_auc,
    'predictions': predictions,
}
if include_predictions:
    # The all_probs arrays are indexed by training-set order; emit the
    # variant identifiers and true labels so downstream stacking knows which
    # row corresponds to which variant.
    out['stacking_inputs'] = {
        'variants': [{'hgvs_protein': r['hgvs_protein'], 'hgvs_genomic': r['hgvs_genomic'], 'classification_simple': r['classification']} for r in variant_records],
        'y_true': y.tolist(),
        'feature_names': feature_names,
    }
print(json.dumps(out, indent=2))
`;

export async function rrmTrainCommand(gene: string, opts: RrmTrainOptions): Promise<void> {
  const upper = gene.toUpperCase();
  const uniprot = GENE_TO_UNIPROT[upper];
  if (!uniprot) throw new Error(`No UniProt mapping for ${upper}. Run biofs rrm-distribution ${upper} first.`);

  const distPath = path.join(RRM_CACHE_DIR, `${upper}-distribution.json`);
  if (!fs.existsSync(distPath)) {
    throw new Error(`No distribution cached for ${upper}. Run first: biofs rrm-distribution ${upper}`);
  }
  const dist = JSON.parse(fs.readFileSync(distPath, 'utf8'));

  // Parse --predict argument into HGVS protein + compute Cosic features for each
  const predictTargets: any[] = [];
  if (opts.predict) {
    // Need patient variant Cosic features. We can re-use the same Python by passing the
    // protein HGVS + computed Cosic values we have from rrm-distribution batch.
    // For simplicity, we pre-compute their Cosic features here using rrm-distribution's
    // batch script, then pass results in.
    const consensusPath = path.join(RRM_CACHE_DIR, `${upper}.json`);
    if (!fs.existsSync(consensusPath)) {
      throw new Error(`No consensus cached for ${upper}. Run biofs rrm-consensus ${upper} first.`);
    }
    const cons = JSON.parse(fs.readFileSync(consensusPath, 'utf8'));
    const seqPath = path.join(UNIPROT_CACHE_DIR, `${uniprot}.fasta`);
    const seq = fs.readFileSync(seqPath, 'utf8').split('\n').slice(1).join('').replace(/\s/g, '').toUpperCase();

    const HGVS_3_TO_1: Record<string, string> = {
      Ala: 'A', Arg: 'R', Asn: 'N', Asp: 'D', Cys: 'C',
      Glu: 'E', Gln: 'Q', Gly: 'G', His: 'H', Ile: 'I',
      Leu: 'L', Lys: 'K', Met: 'M', Phe: 'F', Pro: 'P',
      Ser: 'S', Thr: 'T', Trp: 'W', Tyr: 'Y', Val: 'V',
    };

    for (const raw of opts.predict.split(',').map(s => s.trim()).filter(Boolean)) {
      const m = raw.match(/p\.([A-Z][a-z]{2})(\d+)([A-Z][a-z]{2})/);
      if (!m) {
        console.error(chalk.yellow(`  warning: could not parse ${raw}, skipping`));
        continue;
      }
      const ref = HGVS_3_TO_1[m[1]];
      const alt = HGVS_3_TO_1[m[3]];
      const pos = parseInt(m[2], 10);
      // Find the matching ClinVar variant in cached distribution to grab hgvs_genomic
      const match = (dist.variants || []).find((v: any) =>
        v.position === pos && v.ref === ref && v.alt === alt
      );
      // Also fetch Cosic features via the existing rrm-distribution batch script
      // (we'll just pull them inline from the variants matching position/ref/alt)
      let cosicFeatures: any = {};
      if (match) {
        cosicFeatures = {
          fullSpectrumL1: match.fullSpectrumL1,
          windowedSumAbsDFDc: match.windowedSumAbsDFDc,
          fcRatio: match.fcRatio,
          weightedAggregateDeltaEPct: match.weightedAggregateDeltaEPct,
          totalEnergyChangePct: match.totalEnergyChangePct,
        };
      }
      predictTargets.push({
        label: raw,
        hgvs_genomic: match?.hgvs_genomic,
        dbsnp_rsid: match?.dbsnp_rsid,
        position: pos,
        ref,
        alt,
        ...cosicFeatures,
      });
    }
  }

  if (!opts.quiet) {
    console.error(chalk.cyan(`\n🧠 biofs rrm-train  ${upper}`));
    console.error(chalk.gray(`   training corpus: ${dist.variants.length} ClinVar variants`));
    console.error(chalk.gray(`   predict targets: ${predictTargets.length}`));
    console.error('');
  }

  const py = spawnSync('python3', ['-c', PY_TRAIN], {
    encoding: 'utf8',
    input: JSON.stringify({
      gene: upper,
      variants: dist.variants,
      predict_targets: predictTargets,
      folds: opts.folds || '5',
      plot_path: opts.plot || '',
      include_predictions: opts.includePredictions === true,
    }),
    maxBuffer: 500 * 1024 * 1024,
    timeout: 900_000,
  });
  if (py.status !== 0) {
    console.error(py.stderr);
    throw new Error(`Training failed: ${py.stderr || py.stdout}`);
  }
  // The Python script writes status to stderr; only the final JSON is on stdout.
  if (!opts.quiet) {
    process.stderr.write(py.stderr);
  }
  // Find the first valid JSON object at the start of a line
  const jsonStart = py.stdout.indexOf('{');
  const out = JSON.parse(py.stdout.slice(jsonStart));

  // Always cache the structured result so cohort-train and other callers can
  // parse it without subprocess-stdout gymnastics.
  try {
    const trainCachePath = path.join(RRM_CACHE_DIR, `${upper}-train.json`);
    fs.writeFileSync(trainCachePath, JSON.stringify(out, null, 2));
  } catch (e) {
    // non-fatal
  }

  if (out.error) {
    console.error(chalk.yellow(`\n⚠️  ${out.error}`));
    if (out.feature_coverage) {
      console.error(chalk.gray('Feature coverage:'));
      for (const [k, v] of Object.entries(out.feature_coverage)) {
        console.error(`  ${k.padEnd(28)} ${v}`);
      }
    }
    return;
  }

  // Render results
  console.log(chalk.cyan('\n📊 Ensemble training results  ' + upper));
  console.log(chalk.cyan('━'.repeat(96)));
  console.log(`  Training set: ${out.n_train} variants (${out.n_positive} P+LP, ${out.n_negative} B+LB)`);
  console.log(chalk.cyan('━'.repeat(96)));
  console.log(chalk.bold(`  Feature coverage:`));
  for (const fn of out.feature_names) {
    const cov = out.feature_coverage[fn];
    const pct = (cov / out.n_train * 100).toFixed(0);
    const bar = '█'.repeat(Math.min(20, Math.round(cov / out.n_train * 20)));
    const color = cov / out.n_train > 0.7 ? chalk.green : cov / out.n_train > 0.3 ? chalk.yellow : chalk.red;
    console.log(`    ${fn.padEnd(28)} ${color(bar.padEnd(20))} ${cov}/${out.n_train} (${pct}%)`);
  }
  console.log('');
  console.log(chalk.bold(`  Cross-validation AUC by model:`));
  console.log(`    ${'model'.padEnd(40)} ${'AUC'.padEnd(20)} ${'avg precision'.padEnd(16)}`);
  console.log('    ' + '-'.repeat(76));
  for (const [name, r] of Object.entries(out.results as any) as any) {
    const auc = Number.isFinite(r.auc_mean) ? `${r.auc_mean.toFixed(3)} ± ${r.auc_std.toFixed(3)}` : 'n/a';
    const ap = Number.isFinite(r.avg_precision) ? r.avg_precision.toFixed(3) : 'n/a';
    const color = r.auc_mean > 0.8 ? chalk.green : r.auc_mean > 0.65 ? chalk.yellow : chalk.gray;
    console.log(`    ${name.padEnd(40)} ${color(auc.padEnd(20))} ${ap.padEnd(16)}`);
  }
  console.log('');
  console.log(`  Raw AlphaMissense AUC (no model, threshold-free): ${Number.isFinite(out.raw_alphamissense_auc) ? out.raw_alphamissense_auc.toFixed(3) : 'n/a'}`);
  console.log('');

  if (out.predictions && out.predictions.length) {
    console.log(chalk.cyan('━'.repeat(96)));
    console.log(chalk.bold(`  Patient variant predictions (full ensemble P_path):`));
    for (const p of out.predictions) {
      const color = p.P_path > 0.85 ? chalk.red : p.P_path > 0.5 ? chalk.yellow : chalk.green;
      console.log(`    ${p.label.padEnd(28)} → P_path = ${color((p.P_path * 100).toFixed(1) + '%')}`);
    }
    console.log('');
  }
}
