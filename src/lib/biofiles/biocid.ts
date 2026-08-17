import { BioCID } from '../../types/biofiles';
import { detectFileType } from './filetype';

export class BioCIDParser {
  /**
   * Canonical: biocid://<lab>/<wallet>/<type>/<dataset>
   * Legacy:    biocid://<wallet>/<type>/<identifier>
   */
  static parse(biocid: string): BioCID | null {
    if (!biocid) return null;
    let s = String(biocid).trim();
    // Registry sometimes stores "Biocid:lab/wallet/type/file" without "//".
    if (/^biocid:/i.test(s) && !/^biocid:\/\//i.test(s)) {
      s = 'biocid://' + s.replace(/^biocid:/i, '').replace(/^\/+/, '');
    }
    const four = /^biocid:\/\/([^/]+)\/(0x[a-fA-F0-9]{40})\/([^/]+)\/(.+)$/i;
    const three = /^biocid:\/\/(0x[a-fA-F0-9]{40})\/([^/]+)\/(.+)$/i;
    let m = s.match(four);
    if (m) {
      return {
        lab: m[1].toLowerCase(),
        wallet: m[2].toLowerCase(),
        type: m[3].toLowerCase(),
        identifier: m[4],
        fullCID: s,
      };
    }
    m = s.match(three);
    if (m) {
      return {
        wallet: m[1].toLowerCase(),
        type: m[2].toLowerCase(),
        identifier: m[3],
        fullCID: s,
      };
    }
    return null;
  }

  /**
   * Build a canonical BioCID.
   *
   * Prefer 4-part `biocid://<lab>/<wallet>/<type>/<filename>` when a lab/bioagent
   * is known. Refuse unknown origins (never emit `unknown`).
   */
  static generate(origin: string, filename: string, lab?: string): string {
    const type = detectFileType(filename);
    const safe =
      typeof origin === 'string' &&
      /^0x[a-fA-F0-9]{40}$/.test(origin)
        ? origin.toLowerCase()
        : `resolver_err/${origin || 'missing-origin'}`;
    if (lab && /^[a-z0-9._-]+$/i.test(lab)) {
      return `biocid://${lab.toLowerCase()}/${safe}/${type}/${filename}`;
    }
    return `biocid://${safe}/${type}/${filename}`;
  }

  static detectFileType(filename: string): string {
    return detectFileType(filename);
  }

  static isValidBioCID(biocid: string): boolean {
    return this.parse(biocid) !== null;
  }
}
