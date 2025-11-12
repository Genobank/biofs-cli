#!/usr/bin/env python3
"""
Build OpenCRAVAT Annotator Dictionary
Creates a comprehensive JSON dictionary of all available annotators for Claude API
"""

import os
import yaml
import json
from pathlib import Path

MODULES_DIR = "/apps/opencravat_modules/annotators"

def extract_annotator_metadata(annotator_name):
    """Extract metadata from annotator YAML file"""
    yml_path = Path(MODULES_DIR) / annotator_name / f"{annotator_name}.yml"

    if not yml_path.exists():
        return None

    try:
        with open(yml_path, 'r') as f:
            data = yaml.safe_load(f)

        # Extract key metadata
        metadata = {
            "name": annotator_name,
            "title": data.get("title", annotator_name),
            "description": data.get("description", ""),
            "tags": data.get("tags", []),
            "level": data.get("level", "variant"),
            "version": data.get("version", ""),
            "developer": data.get("developer", {}).get("organization", ""),
            "citation": data.get("developer", {}).get("citation", ""),
            "website": data.get("developer", {}).get("website", "")
        }

        return metadata
    except Exception as e:
        print(f"Error processing {annotator_name}: {e}")
        return None

def categorize_by_tags(annotators):
    """Categorize annotators by their tags"""
    categories = {
        "clinical_significance": [],
        "cancer": [],
        "population_frequency": [],
        "variant_effect_prediction": [],
        "pharmacogenomics": [],
        "mendelian_disease": [],
        "splicing": [],
        "regulatory": [],
        "conservation": [],
        "pathways": [],
        "protein_function": [],
        "other": []
    }

    for ann in annotators:
        tags = [t.lower().replace(" ", "_") for t in ann.get("tags", [])]

        categorized = False

        # Clinical significance
        if any(t in tags for t in ["clinical_relevance", "mendelian_disease", "variants"]):
            if "clinvar" in ann["name"] or "omim" in ann["name"] or "acmg" in ann["name"]:
                categories["clinical_significance"].append(ann)
                categorized = True

        # Cancer
        if "cancer" in tags or "cosmic" in ann["name"] or "oncokb" in ann["name"]:
            categories["cancer"].append(ann)
            categorized = True

        # Population frequency
        if "allele_frequency" in tags or any(x in ann["name"] for x in ["gnomad", "exac", "esp", "1000g", "thousandgenomes"]):
            categories["population_frequency"].append(ann)
            categorized = True

        # Variant effect prediction
        if "variant_effect_prediction" in tags or any(x in ann["name"] for x in ["sift", "polyphen", "cadd", "revel", "vest", "chasm", "alpha"]):
            categories["variant_effect_prediction"].append(ann)
            categorized = True

        # Pharmacogenomics
        if "drugs" in tags or "pharmgkb" in ann["name"] or "dgi" in ann["name"]:
            categories["pharmacogenomics"].append(ann)
            categorized = True

        # Mendelian disease
        if "mendelian_disease" in tags or "omim" in ann["name"] or "hpo" in ann["name"]:
            categories["mendelian_disease"].append(ann)
            categorized = True

        # Splicing
        if any(x in ann["name"] for x in ["splice", "dbscsnv"]):
            categories["splicing"].append(ann)
            categorized = True

        # Regulatory
        if any(x in tags for x in ["regulation", "regulatory"]) or any(x in ann["name"] for x in ["encode", "regulome", "enhancer"]):
            categories["regulatory"].append(ann)
            categorized = True

        # Conservation
        if any(x in ann["name"] for x in ["gerp", "phylop", "phastcons", "siphy"]):
            categories["conservation"].append(ann)
            categorized = True

        # Pathways
        if "pathways" in tags or any(x in ann["name"] for x in ["kegg", "reactome", "biogrid", "intact"]):
            categories["pathways"].append(ann)
            categorized = True

        # Protein function
        if any(x in ann["name"] for x in ["uniprot", "pfam", "interpro", "swissprot"]):
            categories["protein_function"].append(ann)
            categorized = True

        if not categorized:
            categories["other"].append(ann)

    return categories

def build_recommendations():
    """Build recommendation rules for Claude API"""
    recommendations = {
        "phenotypes": {
            "cancer": {
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
                ]
            },
            "cardiovascular": {
                "description": "Cardiovascular disease analysis",
                "recommended_annotators": [
                    "clinvar",
                    "cardioboost",
                    "cvdkp",
                    "gnomad",
                    "alphamissense",
                    "sift",
                    "polyphen2"
                ]
            },
            "hereditary_cancer": {
                "description": "Hereditary cancer predisposition",
                "recommended_annotators": [
                    "clinvar",
                    "brca1_func_assay",
                    "cgc",
                    "cosmic",
                    "gnomad",
                    "alphamissense",
                    "revel"
                ]
            },
            "rare_disease": {
                "description": "Rare Mendelian disease",
                "recommended_annotators": [
                    "clinvar",
                    "clinvar_acmg",
                    "omim",
                    "hpo",
                    "gnomad",
                    "alphamissense",
                    "cadd",
                    "sift",
                    "polyphen2",
                    "spliceai"
                ]
            },
            "pharmacogenomics": {
                "description": "Drug response prediction",
                "recommended_annotators": [
                    "pharmgkb",
                    "dgi",
                    "clinvar",
                    "gnomad"
                ]
            },
            "autism": {
                "description": "Autism spectrum disorder",
                "recommended_annotators": [
                    "clinvar",
                    "omim",
                    "hpo",
                    "gnomad",
                    "denovo",
                    "alphamissense",
                    "cadd"
                ]
            },
            "developmental_delay": {
                "description": "Developmental delay and intellectual disability",
                "recommended_annotators": [
                    "clinvar",
                    "omim",
                    "hpo",
                    "gnomad",
                    "denovo",
                    "alphamissense",
                    "spliceai"
                ]
            }
        },
        "analysis_types": {
            "rare_coding": {
                "description": "Rare coding variant analysis",
                "recommended_annotators": [
                    "clinvar",
                    "gnomad",
                    "alphamissense",
                    "revel",
                    "cadd",
                    "sift",
                    "polyphen2",
                    "vest"
                ]
            },
            "splicing": {
                "description": "Splicing variant analysis",
                "recommended_annotators": [
                    "clinvar",
                    "spliceai",
                    "dbscsnv",
                    "gnomad"
                ]
            },
            "regulatory": {
                "description": "Regulatory variant analysis",
                "recommended_annotators": [
                    "encode_tfbs",
                    "ensembl_regulatory_build",
                    "regulomedb",
                    "vista_enhancer",
                    "gnomad"
                ]
            },
            "de_novo": {
                "description": "De novo variant analysis",
                "recommended_annotators": [
                    "clinvar",
                    "denovo",
                    "gnomad",
                    "alphamissense",
                    "cadd"
                ]
            }
        }
    }

    return recommendations

def main():
    # Get all annotators
    annotator_dirs = [d for d in os.listdir(MODULES_DIR)
                     if os.path.isdir(os.path.join(MODULES_DIR, d))]

    print(f"Found {len(annotator_dirs)} annotators")

    # Extract metadata
    annotators = []
    for name in sorted(annotator_dirs):
        metadata = extract_annotator_metadata(name)
        if metadata:
            annotators.append(metadata)

    print(f"Successfully parsed {len(annotators)} annotators")

    # Categorize
    categories = categorize_by_tags(annotators)

    # Build recommendations
    recommendations = build_recommendations()

    # Create final dictionary
    categories_names = {k: [a["name"] for a in v] for k, v in categories.items()}
    dictionary = {
        "version": "1.0.0",
        "total_annotators": len(annotators),
        "last_updated": "2025-10-07",
        "annotators": annotators,
        "categories": categories_names,
        "recommendations": recommendations
    }

    # Save to JSON
    output_path = "/home/ubuntu/genobank-cli/opencravat_annotators_dictionary.json"
    with open(output_path, 'w') as f:
        json.dump(dictionary, f, indent=2)

    print(f"\n✅ Dictionary saved to: {output_path}")
    print(f"\nCategory breakdown:")
    for category, annotators_list in categories.items():
        print(f"  {category}: {len(annotators_list)} annotators")

    # Create a quick reference markdown
    create_markdown_reference(dictionary, categories_names)

def create_markdown_reference(dictionary, categories):
    """Create a markdown quick reference"""
    md_path = "/home/ubuntu/genobank-cli/OPENCRAVAT_ANNOTATORS_REFERENCE.md"

    with open(md_path, 'w') as f:
        f.write("# OpenCRAVAT Annotators Quick Reference\n\n")
        f.write(f"**Total Annotators**: {dictionary['total_annotators']}\n")
        f.write(f"**Last Updated**: {dictionary['last_updated']}\n\n")

        f.write("## Categories\n\n")
        for category, annotator_names in categories.items():
            if annotator_names:
                f.write(f"### {category.replace('_', ' ').title()} ({len(annotator_names)})\n\n")
                for name in sorted(annotator_names):
                    ann = next((a for a in dictionary['annotators'] if a['name'] == name), None)
                    if ann:
                        f.write(f"- **{ann['title']}** (`{ann['name']}`): {ann['description'][:100]}...\n")
                f.write("\n")

        f.write("## Phenotype-Based Recommendations\n\n")
        for phenotype, info in dictionary['recommendations']['phenotypes'].items():
            f.write(f"### {phenotype.replace('_', ' ').title()}\n")
            f.write(f"{info['description']}\n\n")
            f.write("**Recommended annotators**:\n")
            for ann_name in info['recommended_annotators']:
                f.write(f"- `{ann_name}`\n")
            f.write("\n")

        f.write("## Analysis Type Recommendations\n\n")
        for analysis_type, info in dictionary['recommendations']['analysis_types'].items():
            f.write(f"### {analysis_type.replace('_', ' ').title()}\n")
            f.write(f"{info['description']}\n\n")
            f.write("**Recommended annotators**:\n")
            for ann_name in info['recommended_annotators']:
                f.write(f"- `{ann_name}`\n")
            f.write("\n")

    print(f"✅ Markdown reference saved to: {md_path}")

if __name__ == "__main__":
    main()
