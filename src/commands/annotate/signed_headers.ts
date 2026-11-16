// The headers biofs-node v0.4 reads on a GET (pickRequestSignature): the caller's wallet and its signature of the standing message.
export function signedHeaders(credentials: { wallet_address: string; user_signature: string } | null | undefined): Record<string, string> {
  if (!credentials) throw new Error('Not authenticated. Run: biofs login');
  return { 'X-Biofs-Wallet': credentials.wallet_address, 'X-Biofs-Signature': credentials.user_signature };
}
