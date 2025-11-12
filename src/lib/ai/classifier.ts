import { readFile } from 'fs/promises';
import { basename, extname } from 'path';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GEMINI_API_KEY } from '../config/constants';

// Use environment variable only - no fallback key for security
if (!GEMINI_API_KEY) {
  throw new Error('GEMINI_API_KEY environment variable is not set. AI classification is disabled.');
}
const API_KEY = GEMINI_API_KEY;

export interface ClassificationResult {
  description: string;
  category: string;
  suggestedTitle: string;
}

/**
 * Classify a genomic dataset using Gemini AI
 */
export async function classifyDataset(filePath: string): Promise<ClassificationResult> {
  try {
    // Initialize Gemini
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-pro' });

    // Read file sample (first 100 lines or 10KB, whichever is smaller)
    const fileContent = await readFile(filePath, { encoding: 'utf-8' });
    const lines = fileContent.split('\n');
    const sampleLines = lines.slice(0, 100);
    const sampleContent = sampleLines.join('\n').substring(0, 10000);

    // Get file info
    const fileName = basename(filePath);
    const fileExt = extname(filePath);

    // Create prompt
    const prompt = `You are a genomic data expert. Analyze this genomic dataset and provide:
1. A concise 2-3 sentence description suitable for NFT metadata
2. The category (must be one of: vcf, genomic, gwas, sequence, alignment, annotation, microarray, snp, dtc, medical_imaging, medical)
3. A suggested title (max 50 characters)

File: ${fileName}
File type: ${fileExt}
Sample content (first 100 lines):
${sampleContent}

IMPORTANT: Respond ONLY in valid JSON format with no additional text or markdown:
{
  "description": "...",
  "category": "...",
  "suggestedTitle": "..."
}`;

    // Get AI response
    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    // Parse JSON response
    // Clean the response (remove markdown if present)
    const cleanedText = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

    try {
      const parsed = JSON.parse(cleanedText);

      return {
        description: parsed.description || generateDefaultDescription(fileName, fileExt),
        category: validateCategory(parsed.category) || detectCategoryFromExtension(fileExt),
        suggestedTitle: parsed.suggestedTitle || generateDefaultTitle(fileName)
      };
    } catch (parseError) {
      // If JSON parsing fails, use defaults
      return generateDefaultClassification(fileName, fileExt);
    }

  } catch (error) {
    // If AI fails, use default classification
    return generateDefaultClassification(basename(filePath), extname(filePath));
  }
}

/**
 * Generate default classification if AI fails
 */
function generateDefaultClassification(fileName: string, fileExt: string): ClassificationResult {
  return {
    description: generateDefaultDescription(fileName, fileExt),
    category: detectCategoryFromExtension(fileExt),
    suggestedTitle: generateDefaultTitle(fileName)
  };
}

/**
 * Generate default description based on file type
 */
function generateDefaultDescription(fileName: string, fileExt: string): string {
  const extDescriptions: Record<string, string> = {
    '.vcf': 'Variant Call Format file containing genomic variant information from sequencing analysis.',
    '.bam': 'Binary Alignment Map file containing aligned sequencing reads mapped to a reference genome.',
    '.sam': 'Sequence Alignment Map file containing aligned sequencing reads in text format.',
    '.fastq': 'Raw sequencing reads with quality scores from high-throughput sequencing.',
    '.fasta': 'Nucleotide or protein sequences in FASTA format.',
    '.txt': 'Direct-to-consumer genetic testing results containing SNP genotype data.',
    '.csv': 'Genomic data in comma-separated values format, possibly GWAS or variant annotations.',
    '.bed': 'Browser Extensible Data format defining genomic regions and annotations.',
    '.gff': 'General Feature Format file containing genomic features and annotations.',
    '.dcm': 'DICOM medical imaging file containing radiological or medical scan data.'
  };

  const ext = fileExt.toLowerCase();
  return extDescriptions[ext] || `Genomic dataset file: ${fileName}. Contains biological sequence or variant data for analysis.`;
}

/**
 * Detect category from file extension
 */
function detectCategoryFromExtension(fileExt: string): string {
  const extCategories: Record<string, string> = {
    '.vcf': 'vcf',
    '.vcf.gz': 'vcf',
    '.bam': 'alignment',
    '.sam': 'alignment',
    '.fastq': 'sequence',
    '.fq': 'sequence',
    '.fastq.gz': 'sequence',
    '.fasta': 'sequence',
    '.fa': 'sequence',
    '.txt': 'dtc',
    '.csv': 'gwas',
    '.tsv': 'gwas',
    '.bed': 'annotation',
    '.gff': 'annotation',
    '.gtf': 'annotation',
    '.dcm': 'medical_imaging',
    '.dicom': 'medical_imaging'
  };

  const ext = fileExt.toLowerCase();
  return extCategories[ext] || 'genomic';
}

/**
 * Generate default title from filename
 */
function generateDefaultTitle(fileName: string): string {
  // Remove extension
  let title = fileName.replace(/\.[^/.]+$/, '');

  // Replace underscores and dashes with spaces
  title = title.replace(/[_-]/g, ' ');

  // Capitalize words
  title = title.split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');

  // Limit length
  if (title.length > 50) {
    title = title.substring(0, 47) + '...';
  }

  return title;
}

/**
 * Validate category returned by AI
 */
function validateCategory(category: string | undefined): string | null {
  if (!category) return null;

  const validCategories = [
    'vcf', 'genomic', 'gwas', 'sequence', 'alignment',
    'annotation', 'microarray', 'snp', 'dtc',
    'medical_imaging', 'medical'
  ];

  const normalized = category.toLowerCase().trim();
  return validCategories.includes(normalized) ? normalized : null;
}