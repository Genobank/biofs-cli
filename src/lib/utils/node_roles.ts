/**
 * Who am I to the node, and what to do when it says no. Pure helpers, no I/O, so they are unit tested.
 *
 * The node answers 403 in two ways when a wallet that is not a node operator tries an operator action:
 *   "node operators only"                 (operator routes such as inventory-register)
 *   "signature does not match wallet"     (a job asserting another wallet with --owner)
 * Both mean the same thing for the user: sign as the node operator, for example with BIOFS_PROFILE=operator.
 */

export interface NodeRoles {
  wallet: string;
  node_admin: boolean;
  admin_hint?: string;      // first and last characters of the node's operator wallet, so the user knows which wallet to sign with
}

export function nodeErrorMessage(status: number, error: string | undefined, owner?: string): string {
  const e = String(error || 'unknown');
  if (status === 403 && /node operators only/i.test(e)) {
    return '403: this wallet is not a node operator. Sign as the node operator, for example: BIOFS_PROFILE=operator biofs <same command>. Check with: biofs whoami --roles';
  }
  if (status === 403 && /signature does not match wallet/i.test(e) && owner) {
    return `403: this wallet is not a node operator, so it cannot run a job for ${owner}. Sign as the node operator, for example: BIOFS_PROFILE=operator biofs <same command> --owner ${owner}. Check with: biofs whoami --roles`;
  }
  return `${status}: ${e}`;
}

export function rolesText(r: NodeRoles, profile: string): string[] {
  const lines = [
    `Signer wallet : ${r.wallet}`,
    `Profile       : ${profile}`,
    `Node operator : ${r.node_admin ? 'YES (may run jobs for a data owner with --owner, and use operator verbs such as inventory-register)' : 'NO'}`,
  ];
  if (!r.node_admin) {
    lines.push(`Fix           : sign as the node operator${r.admin_hint ? ` (${r.admin_hint})` : ''}, for example: BIOFS_PROFILE=operator biofs <command>`);
  }
  return lines;
}
