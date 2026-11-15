import { nodeErrorMessage, rolesText } from '../src/lib/utils/node_roles';

const OWNER = '0x01a2D260d2fE8cc13AE70b6868dEB4F3DdCDb797';

describe('nodeErrorMessage', () => {
  it('explains "node operators only" with the fix', () => {
    const m = nodeErrorMessage(403, 'node operators only');
    expect(m).toMatch(/not a node operator/);
    expect(m).toMatch(/BIOFS_PROFILE=operator/);
    expect(m).toMatch(/whoami --roles/);
  });
  it('explains a refused --owner job and names the owner', () => {
    const m = nodeErrorMessage(403, 'signature does not match wallet', OWNER);
    expect(m).toMatch(/cannot run a job for 0x01a2/);
    expect(m).toMatch(/--owner 0x01a2/);
  });
  it('leaves other errors as they were', () => {
    expect(nodeErrorMessage(400, 'biocids: 1 to 50 required')).toBe('400: biocids: 1 to 50 required');
    expect(nodeErrorMessage(403, 'signature does not match wallet')).toBe('403: signature does not match wallet');   // no --owner: the plain error stays
    expect(nodeErrorMessage(500, undefined)).toBe('500: unknown');
  });
});

describe('rolesText', () => {
  it('says YES for a node operator and gives no fix', () => {
    const t = rolesText({ wallet: '0xf54D', node_admin: true }, 'operator').join('\n');
    expect(t).toMatch(/Node operator : YES/);
    expect(t).not.toMatch(/Fix/);
  });
  it('says NO with the one-line fix, including the hint', () => {
    const t = rolesText({ wallet: '0x5f5a', node_admin: false, admin_hint: '0xf54D…7722' }, 'default').join('\n');
    expect(t).toMatch(/Node operator : NO/);
    expect(t).toMatch(/Fix.*0xf54D…7722.*BIOFS_PROFILE=operator/);
  });
});
