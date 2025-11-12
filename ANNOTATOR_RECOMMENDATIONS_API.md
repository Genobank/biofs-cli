# OpenCRAVAT Annotator Recommendations API

## Overview

The BioOS API now provides intelligent annotator recommendations based on phenotype or analysis type. Claude API can query these endpoints to recommend the most appropriate OpenCRAVAT annotators for any given research job.

## API Endpoints

### 1. Get Annotator Recommendations

**Endpoint**: `GET /api_bioos/annotator_recommendations`

Get recommended OpenCRAVAT annotators based on phenotype or analysis type.

**Query Parameters**:
- `phenotype` (optional): Phenotype category
  - `cancer`
  - `cardiovascular`
  - `hereditary_cancer`
  - `rare_disease`
  - `pharmacogenomics`
  - `autism`
  - `developmental_delay`

- `analysis_type` (optional): Analysis type
  - `rare_coding`
  - `splicing`
  - `regulatory`
  - `de_novo`

**Examples**:

```bash
# Get recommendations for cancer analysis
curl "https://genobank.app/api_bioos/annotator_recommendations?phenotype=cancer"

# Get recommendations for splicing analysis
curl "https://genobank.app/api_bioos/annotator_recommendations?analysis_type=splicing"

# List all available options
curl "https://genobank.app/api_bioos/annotator_recommendations"
```

**Response Example** (phenotype=cancer):
```json
{
  "status": "Success",
  "status_details": {
    "data": {
      "phenotype": "cancer",
      "description": "Cancer-related analysis",
      "recommended_annotators": [
        "clinvar",
        "cosmic",
        "cancer_genome_interpreter",
        "cancer_hotspots",
        "civic",
        "oncokb",
        "chasmplus",
        "gnomad",
        "alphamissense",
        "revel"
      ],
      "annotator_details": [
        {
          "name": "clinvar",
          "title": "ClinVar",
          "description": "ClinVar is an archive of reports of the relationships among human variations and phenotypes...",
          "tags": ["mendelian disease", "variants"],
          "level": "variant",
          "version": "2025.09.01",
          "developer": "NCBI",
          "citation": "...",
          "website": "https://www.ncbi.nlm.nih.gov/clinvar/"
        },
        ...
      ]
    }
  }
}
```

**Response Example** (no parameters):
```json
{
  "status": "Success",
  "status_details": {
    "data": {
      "available_phenotypes": [
        "cancer",
        "cardiovascular",
        "hereditary_cancer",
        "rare_disease",
        "pharmacogenomics",
        "autism",
        "developmental_delay"
      ],
      "available_analysis_types": [
        "rare_coding",
        "splicing",
        "regulatory",
        "de_novo"
      ],
      "message": "Specify phenotype or analysis_type parameter for recommendations"
    }
  }
}
```

---

### 2. Get Annotator Dictionary

**Endpoint**: `GET /api_bioos/annotator_dictionary`

Browse the complete OpenCRAVAT annotator dictionary with 146 annotators.

**Query Parameters**:
- `category` (optional): Filter by category
  - `clinical_significance`
  - `cancer`
  - `population_frequency`
  - `variant_effect_prediction`
  - `pharmacogenomics`
  - `mendelian_disease`
  - `splicing`
  - `regulatory`
  - `conservation`
  - `pathways`
  - `protein_function`
  - `other`

- `name` (optional): Get specific annotator by name (e.g., `clinvar`, `gnomad`, `alphamissense`)

**Examples**:

```bash
# Get full dictionary
curl "https://genobank.app/api_bioos/annotator_dictionary"

# Get cancer-related annotators
curl "https://genobank.app/api_bioos/annotator_dictionary?category=cancer"

# Get specific annotator details
curl "https://genobank.app/api_bioos/annotator_dictionary?name=clinvar"
```

**Response Example** (full dictionary):
```json
{
  "status": "Success",
  "status_details": {
    "data": {
      "version": "1.0.0",
      "total_annotators": 146,
      "last_updated": "2025-10-07",
      "annotators": [
        {
          "name": "clinvar",
          "title": "ClinVar",
          "description": "...",
          "tags": ["mendelian disease", "variants"],
          "level": "variant",
          "version": "2025.09.01",
          "developer": "NCBI",
          "citation": "...",
          "website": "..."
        },
        ...
      ],
      "categories": {
        "clinical_significance": ["clinvar", "clinvar_acmg", "omim"],
        "cancer": ["cosmic", "oncokb", "civic", ...],
        ...
      },
      "recommendations": {
        "phenotypes": {
          "cancer": {
            "description": "Cancer-related analysis",
            "recommended_annotators": [...]
          },
          ...
        },
        "analysis_types": {
          "rare_coding": {
            "description": "Rare coding variant analysis",
            "recommended_annotators": [...]
          },
          ...
        }
      }
    }
  }
}
```

**Response Example** (name=alphamissense):
```json
{
  "status": "Success",
  "status_details": {
    "data": {
      "name": "alphamissense",
      "title": "AlphaMissense",
      "description": "Variant pathogenicity scores from AlphaMissense",
      "tags": ["variant effect prediction", "variants", "clinical relevance"],
      "level": "variant",
      "version": "1.1.1",
      "developer": "Google DeepMind",
      "citation": "J. Cheng et al., Science 381, eadg7492 (2023). DOI: 10.1126/science.adg7492",
      "website": ""
    }
  }
}
```

---

## Phenotype-Based Recommendations

### Cancer
**Description**: Cancer-related analysis

**Recommended Annotators**:
- `clinvar` - Clinical significance
- `cosmic` - Catalogue of Somatic Mutations in Cancer
- `cancer_genome_interpreter` - Oncogenic alterations and drug biomarkers
- `cancer_hotspots` - Statistically significant mutations
- `civic` - Clinical interpretations of variants in cancer
- `oncokb` - Precision oncology knowledge base
- `chasmplus` - Machine learning for cancer driver mutations
- `gnomad` - Population frequency
- `alphamissense` - AI pathogenicity prediction
- `revel` - Ensemble pathogenicity score

### Cardiovascular
**Description**: Cardiovascular disease analysis

**Recommended Annotators**:
- `clinvar` - Clinical significance
- `cardioboost` - Pathogenicity for cardiac conditions
- `cvdkp` - Cardiovascular Disease Knowledge Portal
- `gnomad` - Population frequency
- `alphamissense` - AI pathogenicity prediction
- `sift` - Protein function prediction
- `polyphen2` - Protein structure-based prediction

### Hereditary Cancer
**Description**: Hereditary cancer predisposition

**Recommended Annotators**:
- `clinvar` - Clinical significance
- `brca1_func_assay` - BRCA1 saturation genome editing scores
- `cgc` - Cancer Gene Census
- `cosmic` - Somatic mutations in cancer
- `gnomad` - Population frequency
- `alphamissense` - AI pathogenicity prediction
- `revel` - Ensemble pathogenicity score

### Rare Disease
**Description**: Rare Mendelian disease

**Recommended Annotators**:
- `clinvar` - Clinical significance with ACMG guidelines
- `clinvar_acmg` - ACMG PS1 and PM5 predictions
- `omim` - Online Mendelian Inheritance in Man
- `hpo` - Human Phenotype Ontology
- `gnomad` - Population frequency
- `alphamissense` - AI pathogenicity prediction
- `cadd` - Combined annotation dependent depletion
- `sift` - Protein function prediction
- `polyphen2` - Protein structure-based prediction
- `spliceai` - Deep learning splice prediction

### Pharmacogenomics
**Description**: Drug response prediction

**Recommended Annotators**:
- `pharmgkb` - PharmGKB clinical annotations
- `dgi` - Drug-gene interaction database
- `clinvar` - Clinical significance
- `gnomad` - Population frequency

### Autism
**Description**: Autism spectrum disorder

**Recommended Annotators**:
- `clinvar` - Clinical significance
- `omim` - Disease-gene associations
- `hpo` - Phenotype ontology
- `gnomad` - Population frequency
- `denovo` - De novo mutation annotations
- `alphamissense` - AI pathogenicity prediction
- `cadd` - Combined annotation

### Developmental Delay
**Description**: Developmental delay and intellectual disability

**Recommended Annotators**:
- `clinvar` - Clinical significance
- `omim` - Disease-gene associations
- `hpo` - Phenotype ontology
- `gnomad` - Population frequency
- `denovo` - De novo mutations
- `alphamissense` - AI pathogenicity prediction
- `spliceai` - Splice site predictions

---

## Analysis Type Recommendations

### Rare Coding
**Description**: Rare coding variant analysis

**Recommended Annotators**:
- `clinvar` - Clinical significance
- `gnomad` - Population frequency filtering
- `alphamissense` - AI pathogenicity
- `revel` - Ensemble score
- `cadd` - Deleteriousness score
- `sift` - Function prediction
- `polyphen2` - Structure-based prediction
- `vest` - Ensemble predictor

### Splicing
**Description**: Splicing variant analysis

**Recommended Annotators**:
- `clinvar` - Clinical significance
- `spliceai` - Deep learning splice prediction
- `dbscsnv` - Splice consensus regions
- `gnomad` - Population frequency

### Regulatory
**Description**: Regulatory variant analysis

**Recommended Annotators**:
- `encode_tfbs` - Transcription factor binding sites
- `ensembl_regulatory_build` - Regulatory features
- `regulomedb` - Regulatory elements
- `vista_enhancer` - Validated enhancers
- `gnomad` - Population frequency

### De Novo
**Description**: De novo variant analysis

**Recommended Annotators**:
- `clinvar` - Clinical significance
- `denovo` - De novo mutation database
- `gnomad` - Population frequency (should be absent)
- `alphamissense` - AI pathogenicity
- `cadd` - Deleteriousness score

---

## Claude API Integration

### Usage in Job Creation

When a user creates a BioOS job with `biofs job create`, Claude API should:

1. **Parse the prompt** to identify phenotype or analysis type
2. **Query annotator_recommendations** endpoint
3. **Generate annotator list** for OpenCRAVAT pipeline

**Example Flow**:

```python
# User prompt
prompt = "Annotate VCF for hereditary cancer predisposition"

# Claude API extracts phenotype
phenotype = "hereditary_cancer"

# Query recommendations
response = requests.get(
    "https://genobank.app/api_bioos/annotator_recommendations",
    params={"phenotype": phenotype}
)

recommended = response.json()["status_details"]["data"]["recommended_annotators"]
# ['clinvar', 'brca1_func_assay', 'cgc', 'cosmic', 'gnomad', 'alphamissense', 'revel']

# Create job with recommended annotators
job_data = {
    "prompt": prompt,
    "input_files": [...],
    "pipeline": {
        "steps": [{
            "service": "vcf_annotator",
            "action": "annotate",
            "params": {
                "annotators": recommended
            }
        }]
    }
}
```

### Natural Language Mapping

Claude API should map user prompts to phenotypes/analysis types:

| User Keywords | Maps To |
|---------------|---------|
| "cancer", "tumor", "oncology" | `phenotype=cancer` |
| "heart", "cardiac", "cardiovascular" | `phenotype=cardiovascular` |
| "BRCA", "hereditary cancer" | `phenotype=hereditary_cancer` |
| "rare disease", "Mendelian" | `phenotype=rare_disease` |
| "drug", "medication", "pharmacogenomics" | `phenotype=pharmacogenomics` |
| "autism", "ASD" | `phenotype=autism` |
| "developmental delay", "intellectual disability" | `phenotype=developmental_delay` |
| "rare coding" | `analysis_type=rare_coding` |
| "splice", "splicing" | `analysis_type=splicing` |
| "regulatory", "non-coding" | `analysis_type=regulatory` |
| "de novo", "trio" | `analysis_type=de_novo` |

---

## Testing

```bash
# Test annotator recommendations
curl "https://genobank.app/api_bioos/annotator_recommendations?phenotype=cancer" | jq

# Test dictionary browsing
curl "https://genobank.app/api_bioos/annotator_dictionary?category=cancer" | jq

# Test specific annotator
curl "https://genobank.app/api_bioos/annotator_dictionary?name=alphamissense" | jq

# List all options
curl "https://genobank.app/api_bioos/annotator_recommendations" | jq
```

---

## Benefits

1. **Intelligent Recommendations**: Claude API provides context-aware annotator selection
2. **Comprehensive Coverage**: 146 OpenCRAVAT annotators categorized and documented
3. **Phenotype-Driven**: Recommendations based on clinical context
4. **Analysis-Driven**: Recommendations based on variant type
5. **Flexible Queries**: Browse by category, name, or get full dictionary
6. **Up-to-date**: Annotator versions and citations included

---

## Example Conversations

### User: "Annotate my VCF for autism genes"

**Claude API**:
1. Extracts phenotype: `autism`
2. Queries: `/api_bioos/annotator_recommendations?phenotype=autism`
3. Receives recommended annotators: `['clinvar', 'omim', 'hpo', 'gnomad', 'denovo', 'alphamissense', 'cadd']`
4. Creates job with recommended annotator pipeline

### User: "Find pathogenic splicing variants"

**Claude API**:
1. Extracts analysis type: `splicing`
2. Queries: `/api_bioos/annotator_recommendations?analysis_type=splicing`
3. Receives recommended annotators: `['clinvar', 'spliceai', 'dbscsnv', 'gnomad']`
4. Creates job with splicing-focused annotators

### User: "What annotators are available for cancer?"

**Claude API**:
1. Queries: `/api_bioos/annotator_dictionary?category=cancer`
2. Returns 26 cancer-related annotators with full details
3. User can browse and select specific ones

---

## Next Steps

1. ✅ Dictionary built with 146 annotators
2. ✅ API endpoints created
3. ⏳ Restart production API to load endpoints
4. ⏳ Test endpoints with curl
5. ⏳ Integrate with Claude API for intelligent recommendations
6. ⏳ Update CLI documentation

---

**Version**: 1.0.0
**Last Updated**: 2025-10-07
**Total Annotators**: 146
**API Base**: `https://genobank.app/api_bioos/`
