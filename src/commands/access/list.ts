import chalk from 'chalk';
import ora from 'ora';
import Table from 'cli-table3';
import { GenoBankAPIClient } from '../../lib/api/client';
import { Logger } from '../../lib/utils/logger';

export interface AccessListOptions {
  mine?: boolean;    // List assets I have permission to access
  status?: string;   // Filter by status: active, pending, revoked
  json?: boolean;    // JSON output format
}

export async function accessListCommand(
  biocidOrIpId?: string,
  options: AccessListOptions = {}
): Promise<void> {
  const spinner = ora('Fetching license tokens...').start();

  try {
    const api = GenoBankAPIClient.getInstance();

    if (options.mine) {
      // List assets I have license tokens for (researcher mode)
      spinner.text = 'Fetching your license tokens...';

      // Use legacy method for now (compatible with both old and new systems)
      const permissions = await api.getMyPermissions();

      spinner.stop();

      if (permissions.length === 0) {
        console.log(chalk.yellow('No assets found where you have license tokens.'));
        console.log(chalk.gray('Request license token: ') + chalk.cyan('biofs access request <biocid>'));
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(permissions, null, 2));
        return;
      }

      console.log(chalk.bold(`\n✓ Assets with license tokens: ${permissions.length}\n`));

      const table = new Table({
        head: [
          chalk.cyan('IP Asset ID'),
          chalk.cyan('Owner'),
          chalk.cyan('License Type'),
          chalk.cyan('Status')
        ],
        colWidths: [45, 45, 20, 12]
      });

      for (const perm of permissions) {
        const licenseType = perm.license_type || 'non-commercial';
        const licenseLabel = licenseType === 'non-commercial'
          ? 'GDPR Research'
          : 'Commercial';

        table.push([
          perm.ip_id || perm.biosample_serial || 'N/A',
          perm.owner_address || 'N/A',
          licenseLabel,
          perm.status === 'active' ? chalk.green('Active') : chalk.red(perm.status || 'Unknown')
        ]);
      }

      console.log(table.toString());
      console.log();

    } else if (biocidOrIpId) {
      // List license tokens for an asset I own (owner mode)
      let ipId: string;

      if (biocidOrIpId.startsWith('biocid://')) {
        spinner.text = 'Resolving BioCID...';
        const registrationId = biocidOrIpId.split('/bioip/')[1]?.split('/')[0] || '';
        if (!registrationId) {
          throw new Error('Invalid BioCID format');
        }

        const bioips = await api.getMyBioIPs();
        const bioip = bioips.find((b: any) => b.registration_id === registrationId);
        if (!bioip) {
          throw new Error('BioIP asset not found or you are not the owner');
        }
        ipId = bioip.ip_id;
      } else if (biocidOrIpId.startsWith('0x')) {
        ipId = biocidOrIpId;
      } else {
        throw new Error('Invalid format. Expected BioCID (biocid://...) or IP Asset ID (0x...)');
      }

      // Fetch pending requests using new PIL endpoint
      spinner.text = 'Fetching pending license token requests...';
      let pendingRequests = await api.getPendingLicenseRequests(ipId);

      // Fetch active/revoked tokens using new PIL endpoint
      spinner.text = 'Fetching license tokens...';
      let activeTokens = await api.getActiveLicenseTokens(ipId);

      // Combine pending requests and active tokens
      const combinedList = [
        ...pendingRequests.map((req: any) => ({
          wallet: req.requester,
          license_type: req.license_type,
          status: 'pending',
          created_at: req.createdAt,
          request_id: req._id,
          license_token_id: null,
          tx_hash: null
        })),
        ...activeTokens.map((token: any) => ({
          wallet: token.receiver,
          license_type: token.license_type || 'non-commercial',
          status: token.status || 'active',
          created_at: token.createdAt,
          request_id: null,
          license_token_id: token.license_token_id,
          tx_hash: token.tx_hash
        }))
      ];

      // Apply status filter if provided
      let filteredList = combinedList;
      if (options.status) {
        filteredList = combinedList.filter((item: any) =>
          item.status?.toLowerCase() === options.status?.toLowerCase()
        );
      }

      spinner.stop();

      if (filteredList.length === 0) {
        console.log(chalk.yellow(`No license tokens found${options.status ? ` with status: ${options.status}` : ''}.`));
        console.log(chalk.gray('Pending requests will appear here when researchers request access.'));
        return;
      }

      if (options.json) {
        console.log(JSON.stringify(filteredList, null, 2));
        return;
      }

      console.log(chalk.bold(`\n✓ License tokens for ${ipId}: ${filteredList.length}\n`));

      const table = new Table({
        head: [
          chalk.cyan('Researcher Wallet'),
          chalk.cyan('License Type'),
          chalk.cyan('Date'),
          chalk.cyan('Status'),
          chalk.cyan('Token ID')
        ],
        colWidths: [45, 20, 15, 12, 15]
      });

      for (const item of filteredList) {
        const status = item.status || 'unknown';
        let statusColor: (str: string) => string;

        if (status === 'active' || status === 'approved') {
          statusColor = chalk.green;
        } else if (status === 'pending') {
          statusColor = chalk.yellow;
        } else if (status === 'revoked' || status === 'rejected') {
          statusColor = chalk.red;
        } else {
          statusColor = chalk.gray;
        }

        const licenseType = item.license_type === 'non-commercial'
          ? 'GDPR Research'
          : 'Commercial';

        table.push([
          item.wallet || 'N/A',
          licenseType,
          item.created_at ? new Date(item.created_at).toLocaleDateString() : 'N/A',
          statusColor(status),
          item.license_token_id || (status === 'pending' ? 'Pending' : 'N/A')
        ]);
      }

      console.log(table.toString());
      console.log();

      // Show pending requests count
      const pendingCount = filteredList.filter((item: any) => item.status === 'pending').length;
      if (pendingCount > 0) {
        console.log(chalk.yellow(`⏳ ${pendingCount} pending license token request${pendingCount > 1 ? 's' : ''}`));
        console.log(chalk.gray('   Grant (mint license token): ') + chalk.cyan('biofs access grant <biocid> <wallet>'));
        console.log();
      }

      // Show active tokens count
      const activeCount = filteredList.filter((item: any) =>
        item.status === 'active' || item.status === 'approved'
      ).length;
      if (activeCount > 0) {
        console.log(chalk.green(`✓ ${activeCount} active license token${activeCount > 1 ? 's' : ''}`));
        console.log(chalk.gray('   Revoke (GDPR right to erasure): ') + chalk.cyan('biofs access revoke <biocid> <wallet> --yes'));
        console.log();
      }

    } else {
      throw new Error('Missing argument. Use --mine to list your license tokens, or provide a BioCID/IP ID to list permittees.');
    }

  } catch (error: any) {
    spinner.fail(chalk.red('✗ Failed to fetch license tokens'));
    Logger.error(`Error: ${error.message}`);
    process.exit(1);
  }
}
