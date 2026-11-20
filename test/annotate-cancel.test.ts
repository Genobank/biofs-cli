import { buildCancelRequest, describeCancel } from '../src/commands/annotate/cancel';

const CREDS = { wallet_address: '0x' + '1'.repeat(40), user_signature: '0xsig' };
const ID = 'oc-754b5345-45a7-42be-939d-6653bd163476';

describe('biofs annotate cancel', () => {
  it('sends the job id in the body and the signed wallet headers', () => {
    const r = buildCancelRequest(ID, CREDS);
    expect(r.body).toEqual({ oc_job_id: ID });
    expect(r.headers['X-Biofs-Wallet']).toBe(CREDS.wallet_address);
    expect(r.headers['X-Biofs-Signature']).toBe('0xsig');
    expect(r.headers['Content-Type']).toBe('application/json');
  });

  it('refuses anything that is not an annotation job id before any request is made', () => {
    expect(() => buildCancelRequest('neo-123', CREDS)).toThrow(/not an annotation job id/);
    expect(() => buildCancelRequest('oc-123', CREDS)).toThrow(/not an annotation job id/);
    expect(() => buildCancelRequest(`${ID}; rm -rf /`, CREDS)).toThrow(/not an annotation job id/);
  });

  it('says in one line what the node did', () => {
    expect(describeCancel({ oc_job_id: ID, ok: true, cancel: 'cancelling' })).toMatch(/container was stopped/);
    expect(describeCancel({ oc_job_id: ID, ok: true, cancel: 'not_running', status: 'done' })).toMatch(/already finished \(status done\)/);
    expect(describeCancel({ oc_job_id: ID, ok: true, cancel: 'no_container' })).toMatch(/no container was running/);
    expect(describeCancel({ oc_job_id: ID, ok: false, cancel: 'stop_failed' })).toMatch(/could not stop/);
  });
});
