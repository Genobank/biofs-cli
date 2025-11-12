# BioFS v1.2.7 - Published to npm ✅

## 🎉 Successfully Published!

**Package**: `@genobank/biofs@1.2.7`
**npm Registry**: https://www.npmjs.com/package/@genobank/biofs
**Published**: October 7, 2025
**Package Size**: 154.4 KB
**Unpacked Size**: 714.2 KB
**Total Files**: 192

## Installation

### Quick Install (Recommended)

```bash
npm install -g @genobank/biofs@1.2.7
```

### Verify Installation

```bash
biofs --version  # Should show: 1.2.7
```

## What's New in v1.2.7

### 🧬 OpenCRAVAT Annotator Intelligence (NEW!)

**Complete Dictionary System**:
- **146 annotators** catalogued and categorized
- **12 categories**: clinical_significance, cancer, population_frequency, variant_effect_prediction, pharmacogenomics, mendelian_disease, splicing, regulatory, conservation, pathways, protein_function, other
- **7 phenotype recommendations**: cancer, cardiovascular, hereditary_cancer, rare_disease, pharmacogenomics, autism, developmental_delay
- **4 analysis type recommendations**: rare_coding, splicing, regulatory, de_novo

**API Endpoints Added**:
1. `GET /api_bioos/annotator_recommendations?phenotype={type}` - Smart recommendations
2. `GET /api_bioos/annotator_dictionary?category={cat}` - Browse all annotators

**Example Usage**:
```bash
# Get cancer-specific annotators
curl "https://genobank.app/api_bioos/annotator_recommendations?phenotype=cancer"
# Returns: clinvar, cosmic, cancer_genome_interpreter, cancer_hotspots, civic, oncokb, chasmplus, gnomad, alphamissense, revel

# Get rare disease annotators
curl "https://genobank.app/api_bioos/annotator_recommendations?phenotype=rare_disease"
# Returns: clinvar, clinvar_acmg, omim, hpo, gnomad, alphamissense, cadd, sift, polyphen2, spliceai

# Get splicing-specific annotators
curl "https://genobank.app/api_bioos/annotator_recommendations?analysis_type=splicing"
# Returns: clinvar, spliceai, dbscsnv, gnomad

# Look up specific annotator
curl "https://genobank.app/api_bioos/annotator_dictionary?name=alphamissense"
```

**Natural Language Mapping for Claude API**:

| User Says | Claude Maps To | Annotators Selected |
|-----------|----------------|---------------------|
| "find cancer variants" | `phenotype=cancer` | cosmic, civic, oncokb, chasmplus |
| "rare coding variants" | `analysis_type=rare_coding` | gnomad, alphamissense, revel, cadd |
| "splice site mutations" | `analysis_type=splicing` | spliceai, dbscsnv |
| "autism spectrum disorder" | `phenotype=autism` | clinvar, omim, hpo, denovo |

### 🔬 BioOS Job Management (from v1.2.6)

- Natural language job creation: `biofs job create "Annotate VCF with rare coding variants" sample.vcf`
- Real-time monitoring: `biofs job status <job_id> --watch`
- Pipeline templates: `biofs job pipelines`
- Story Protocol IP lineage tracking
- Presigned S3 download URLs
- SHA256 file verification

### 🎨 Enhanced User Experience

- Progress bars for job execution
- Color-coded status indicators
- Formatted tables for data display
- JSON output for all commands

## Available Commands

### Authentication
```bash
biofs login                    # Web3 wallet authentication
biofs logout                   # Clear credentials
biofs whoami                   # Show current wallet
```

### File Management
```bash
biofs files                    # List your BioFiles
biofs download <file>          # Download files
biofs upload <file>            # Upload files
biofs tokenize <file>          # Tokenize as BioIP NFT
```

### BioOS Job Management
```bash
biofs job pipelines                        # List available templates
biofs job create "prompt" <file>           # Create research job
biofs job status <job_id> [--watch]        # Check status
biofs job results <job_id>                 # Get results
biofs job list [--status <status>]         # List all jobs
```

### Access Control
```bash
biofs access request <biocid>              # Request access
biofs access grant <biocid> <wallet>       # Grant access (owner)
biofs access revoke <biocid> <wallet>      # Revoke access (owner)
biofs access list [biocid]                 # List permissions
biofs access check <biocid>                # Check your access
```

## Testing the New Features

### Test Annotator Intelligence

```bash
# Get recommendations for cancer analysis
curl "https://genobank.app/api_bioos/annotator_recommendations?phenotype=cancer"

# Get recommendations for rare disease
curl "https://genobank.app/api_bioos/annotator_recommendations?phenotype=rare_disease"

# Browse all 146 annotators
curl "https://genobank.app/api_bioos/annotator_dictionary"

# Look up AlphaMissense
curl "https://genobank.app/api_bioos/annotator_dictionary?name=alphamissense"
```

### Create a Job with Smart Annotator Selection

```bash
# Natural language - Claude API picks annotators
biofs job create "Find pathogenic variants in BRCA1/BRCA2" sample.vcf
# Claude uses: phenotype=hereditary_cancer
# Selects: clinvar, brca1_func_assay, cosmic, alphamissense

# Specific analysis type
biofs job create "Analyze splice variants" sample.vcf
# Claude uses: analysis_type=splicing
# Selects: clinvar, spliceai, dbscsnv, gnomad
```

## Documentation Included

1. **OPENCRAVAT_ANNOTATORS_REFERENCE.md** - All 146 annotators categorized
2. **ANNOTATOR_RECOMMENDATIONS_API.md** - API documentation
3. **OPENCRAVAT_ANNOTATOR_INTELLIGENCE_COMPLETE.md** - Implementation guide
4. **BIOOS_JOB_MANAGEMENT.md** - Job management guide
5. **INSTALL_V1.2.7_ON_MAC.md** - Installation instructions

## Files Included in Package

### Core CLI (TypeScript compiled to JavaScript)
- Complete authentication flow
- BioFiles management
- BioIP tokenization
- BioOS job orchestration
- Access control

### Annotator Intelligence
- `opencravat_annotators_dictionary.json` - 146 annotators
- `scripts/build_annotator_dictionary.py` - Dictionary builder

### Test Files
- `test.vcf` - Sample VCF
- `test_23andme.txt` - Sample 23andMe data
- `test-complete-flow.sh` - Integration test

## Troubleshooting

### Update from Previous Version

```bash
# Uninstall old version
npm uninstall -g @genobank/biofs

# Install new version
npm install -g @genobank/biofs@1.2.7

# Verify
biofs --version  # Should show 1.2.7
```

### Permission Errors

```bash
# Use sudo on Mac
sudo npm install -g @genobank/biofs@1.2.7
```

### Clear Cache if Needed

```bash
npm cache clean --force
npm install -g @genobank/biofs@1.2.7
```

## API Infrastructure

### Production API Endpoints
- **Base URL**: https://genobank.app/api_bioos/
- **annotator_recommendations** - Smart annotator selection
- **annotator_dictionary** - Browse all annotators
- **create_job** - Create research job
- **job_status** - Check job progress
- **job_results** - Get results
- **pipeline_list** - List templates
- **user_jobs** - List user jobs

### Files Modified in Production
1. `/home/ubuntu/Genobank_APIs/production_api/plugins/bioos/api_bioos.py` - Added 2 endpoints
2. `/home/ubuntu/Genobank_APIs/production_api/plugins/bioos/opencravat_annotators_dictionary.json` - 146 annotators

## Impact & Benefits

### For Researchers
- **Context-aware analysis**: Claude API selects the right annotators automatically
- **146 annotators available**: Complete OpenCRAVAT catalog
- **Clinical relevance**: Phenotype-driven recommendations
- **Time savings**: No manual annotator selection

### For Developers
- **REST API access**: Programmatic annotator recommendations
- **Natural language processing**: Map user intent → annotators
- **Complete metadata**: Citations, versions, descriptions
- **Educational**: Learn what each annotator does

### For Claude API
- **Intelligent selection**: Recommend annotators based on phenotype/analysis type
- **Quick reference**: Browse 146 annotators instantly
- **Flexible queries**: By category, name, phenotype, or analysis type
- **Up-to-date**: Versions and citations included

## Example Workflows

### Cancer Analysis
```bash
# User creates job
biofs job create "Find pathogenic variants in cancer genes" tumor.vcf

# Claude API queries
GET /api_bioos/annotator_recommendations?phenotype=cancer

# Claude receives
{
  "recommended_annotators": [
    "clinvar", "cosmic", "cancer_genome_interpreter",
    "cancer_hotspots", "civic", "oncokb", "chasmplus",
    "gnomad", "alphamissense", "revel"
  ]
}

# Job created with these annotators
```

### Rare Disease Analysis
```bash
# User creates job
biofs job create "Analyze for rare Mendelian disease" proband.vcf

# Claude API queries
GET /api_bioos/annotator_recommendations?phenotype=rare_disease

# Claude receives comprehensive rare disease panel
{
  "recommended_annotators": [
    "clinvar", "clinvar_acmg", "omim", "hpo",
    "gnomad", "alphamissense", "cadd",
    "sift", "polyphen2", "spliceai"
  ]
}
```

### Splicing Analysis
```bash
# User creates job
biofs job create "Find splice site variants" patient.vcf

# Claude API queries
GET /api_bioos/annotator_recommendations?analysis_type=splicing

# Focused splicing panel returned
{
  "recommended_annotators": [
    "clinvar", "spliceai", "dbscsnv", "gnomad"
  ]
}
```

## Version History

- **v1.2.7** (Oct 7, 2025): Added OpenCRAVAT annotator intelligence
- **v1.2.6** (Oct 5, 2025): Added BioOS job management
- **v1.2.4** (Sep 2025): Initial BioIP tokenization support

## Support

- **npm Package**: https://www.npmjs.com/package/@genobank/biofs
- **Installation Guide**: See `INSTALL_V1.2.7_ON_MAC.md`
- **API Documentation**: See `ANNOTATOR_RECOMMENDATIONS_API.md`
- **GitHub**: https://github.com/Genobank/genobank-cli
- **Support**: support@genobank.io

---

**Package**: @genobank/biofs@1.2.7
**Published**: October 7, 2025
**Status**: ✅ Live on npm registry
**Total Annotators**: 146
**API Endpoints**: 7 (5 from v1.2.6 + 2 new in v1.2.7)
