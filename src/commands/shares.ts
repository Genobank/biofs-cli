/**
 * Shares Command - Visualize BioNFT permission graph
 * Shows all sharing relationships: files you've shared and files shared with you
 */

import { CredentialsManager } from '../lib/auth/credentials';
import { GenoBankAPIClient } from '../lib/api/client';
import { Logger } from '../lib/utils/logger';
import chalk from 'chalk';
import ora from 'ora';

export interface SharesOptions {
  json?: boolean;
  graphql?: boolean;
  verbose?: boolean;
}

interface ShareNode {
  type: 'file' | 'person';
  id: string;
  label: string;
  metadata?: any;
}

interface ShareEdge {
  from: string;
  to: string;
  license: string;
  granted_at?: string;
  revocable: boolean;
}

interface PermissionGraph {
  nodes: ShareNode[];
  edges: ShareEdge[];
}

export async function sharesCommand(options: SharesOptions = {}): Promise<void> {
  const spinner = ora('Building permission graph...').start();

  try {
    // 1. Load authentication
    const credManager = CredentialsManager.getInstance();
    const creds = await credManager.loadCredentials();

    if (!creds) {
      spinner.fail('Not authenticated');
      Logger.error('Please run: biofs login');
      process.exit(1);
    }

    const { wallet_address: wallet, user_signature: signature } = creds;

    // 2. Get granted files (files shared WITH you)
    spinner.text = 'Discovering files shared with you (Story Protocol)...';
    const api = GenoBankAPIClient.getInstance();
    const grantedToYouStory = await api.getMyGrantedBioIPs();

    // 2b. Get Sequentia licenses
    spinner.text = 'Discovering files shared with you (Sequentia)...';
    const grantedToYouSequentia = await api.getSequentiaLicenses();

    // Merge both networks
    const grantedToYou = [...grantedToYouStory, ...grantedToYouSequentia];

    // 3. Get files you own (potential to share)
    spinner.text = 'Discovering your files...';
    // TODO: Need API endpoint to get files YOU'VE shared with others
    // For now, we'll focus on files shared TO you

    spinner.stop();

    // 4. Build permission graph
    const graph: PermissionGraph = {
      nodes: [],
      edges: []
    };

    // Add your wallet as root node
    graph.nodes.push({
      type: 'person',
      id: wallet,
      label: 'You',
      metadata: { wallet_address: wallet }
    });

    // Add files shared with you
    const sharedWithYou: any[] = [];
    for (const file of grantedToYou) {
      // Add file node
      const fileNodeId = file.ip_id || file.filename;
      graph.nodes.push({
        type: 'file',
        id: fileNodeId,
        label: file.filename,
        metadata: {
          ip_id: file.ip_id,
          category: file.category,
          license_type: file.license_type
        }
      });

      // Add owner node if not already present
      const ownerNodeId = file.owner;
      if (!graph.nodes.find(n => n.id === ownerNodeId)) {
        graph.nodes.push({
          type: 'person',
          id: ownerNodeId,
          label: ownerNodeId.substring(0, 10) + '...',
          metadata: { wallet_address: file.owner }
        });
      }

      // Add edge: owner -> file (ownership)
      graph.edges.push({
        from: ownerNodeId,
        to: fileNodeId,
        license: 'ownership',
        revocable: false
      });

      // Add edge: file -> you (license grant)
      graph.edges.push({
        from: fileNodeId,
        to: wallet,
        license: file.license_type || 'unknown',
        granted_at: file.granted_at,
        revocable: true
      });

      sharedWithYou.push({
        filename: file.filename,
        owner: file.owner,
        license: file.license_type,
        ip_id: file.ip_id,
        granted_at: file.granted_at
      });
    }

    // 5. Display results
    if (options.json) {
      console.log(JSON.stringify({ graph, sharedWithYou }, null, 2));
      return;
    }

    if (options.graphql) {
      displayGraphQL(graph, wallet);
      return;
    }

    // Default: Pretty display
    displayPermissionGraph(graph, wallet, sharedWithYou);

  } catch (error: any) {
    spinner.fail('Failed to build permission graph');
    Logger.error(error.message || error);
    process.exit(1);
  }
}

function displayPermissionGraph(
  graph: PermissionGraph,
  yourWallet: string,
  sharedWithYou: any[]
): void {
  console.log('\n' + chalk.cyan('╔════════════════════════════════════════════════════════════════╗'));
  console.log(chalk.cyan('║              BioNFT Permission Graph                           ║'));
  console.log(chalk.cyan('╚════════════════════════════════════════════════════════════════╝\n'));

  console.log(chalk.bold('👛 Your Wallet:'), chalk.cyan(yourWallet));
  console.log();

  // Section 1: Files Shared WITH You
  if (sharedWithYou.length > 0) {
    console.log(chalk.bold.green(`📥 Files Shared WITH You (${sharedWithYou.length}):`));
    console.log();

    for (let i = 0; i < sharedWithYou.length; i++) {
      const share = sharedWithYou[i];
      const num = chalk.gray(`${i + 1}.`);

      console.log(`${num} ${chalk.bold(share.filename)}`);
      console.log(`   ${chalk.gray('Owner:')} ${share.owner.substring(0, 12)}...${share.owner.substring(share.owner.length - 4)}`);
      console.log(`   ${chalk.gray('License:')} ${chalk.yellow(share.license || 'unknown')}`);
      if (share.ip_id) {
        console.log(`   ${chalk.gray('IP Asset:')} ${share.ip_id}`);
      }
      if (share.granted_at) {
        console.log(`   ${chalk.gray('Granted:')} ${new Date(share.granted_at).toLocaleDateString()}`);
      }

      // Visual connection
      console.log(`   ${chalk.gray('└─→')} ${chalk.green('You can access')}`);
      console.log();
    }
  } else {
    console.log(chalk.gray('📥 No files shared with you yet'));
    console.log(chalk.gray('   Request access with: ') + chalk.cyan('biofs access request <ip_id>'));
    console.log();
  }

  // Section 2: Files YOU'VE Shared (placeholder - needs API endpoint)
  console.log(chalk.bold.blue('📤 Files YOU\'VE Shared:'));
  console.log(chalk.gray('   Use GenoBank.io dashboard to manage outgoing shares'));
  console.log(chalk.gray('   Or use: ') + chalk.cyan('biofs share <file> <wallet> --license <type>'));
  console.log();

  // Section 3: Permission Graph Summary
  console.log(chalk.bold.magenta('📊 Permission Graph Summary:'));
  console.log(`   ${chalk.gray('Total Nodes:')} ${graph.nodes.length} (${graph.nodes.filter(n => n.type === 'person').length} people, ${graph.nodes.filter(n => n.type === 'file').length} files)`);
  console.log(`   ${chalk.gray('Total Edges:')} ${graph.edges.length} permission links`);
  console.log(`   ${chalk.gray('Your Access:')} ${sharedWithYou.length} file(s)`);
  console.log();

  console.log(chalk.bold('💡 Commands:'));
  console.log(chalk.gray('   • Download file: ') + chalk.cyan('biofs download <filename>'));
  console.log(chalk.gray('   • Mount all files: ') + chalk.cyan('biofs mount /tmp/biofiles'));
  console.log(chalk.gray('   • Revoke consent: ') + chalk.cyan('biofs access revoke-consent <ip_id>'));
  console.log(chalk.gray('   • Share your file: ') + chalk.cyan('biofs share <file> <wallet> --license <type>'));
  console.log();
}

function displayGraphQL(graph: PermissionGraph, yourWallet: string): void {
  console.log('\n' + chalk.cyan('# GraphQL Schema for BioNFT Permission Graph\n'));

  // GraphQL Type Definitions
  console.log(chalk.gray('type BioFile {'));
  console.log(chalk.gray('  id: ID!'));
  console.log(chalk.gray('  filename: String!'));
  console.log(chalk.gray('  ipAsset: String'));
  console.log(chalk.gray('  category: String'));
  console.log(chalk.gray('  owner: Person!'));
  console.log(chalk.gray('  sharedWith: [Permission!]!'));
  console.log(chalk.gray('}\n'));

  console.log(chalk.gray('type Person {'));
  console.log(chalk.gray('  id: ID!'));
  console.log(chalk.gray('  wallet: String!'));
  console.log(chalk.gray('  ownedFiles: [BioFile!]!'));
  console.log(chalk.gray('  grantedAccess: [Permission!]!'));
  console.log(chalk.gray('}\n'));

  console.log(chalk.gray('type Permission {'));
  console.log(chalk.gray('  from: BioFile!'));
  console.log(chalk.gray('  to: Person!'));
  console.log(chalk.gray('  license: String!'));
  console.log(chalk.gray('  grantedAt: String'));
  console.log(chalk.gray('  revocable: Boolean!'));
  console.log(chalk.gray('}\n'));

  // Sample Query
  console.log(chalk.cyan('# Query Example:\n'));
  console.log(chalk.yellow('query GetMyPermissions {'));
  console.log(chalk.yellow('  me {'));
  console.log(chalk.yellow('    wallet'));
  console.log(chalk.yellow('    grantedAccess {'));
  console.log(chalk.yellow('      from {'));
  console.log(chalk.yellow('        filename'));
  console.log(chalk.yellow('        ipAsset'));
  console.log(chalk.yellow('        owner { wallet }'));
  console.log(chalk.yellow('      }'));
  console.log(chalk.yellow('      license'));
  console.log(chalk.yellow('      grantedAt'));
  console.log(chalk.yellow('    }'));
  console.log(chalk.yellow('  }'));
  console.log(chalk.yellow('}\n'));

  // JSON export for graph visualization
  console.log(chalk.cyan('# Graph Data (JSON):\n'));
  console.log(chalk.gray(JSON.stringify(graph, null, 2)));
  console.log();

  console.log(chalk.bold('💡 Visualization:'));
  console.log(chalk.gray('   • Export: ') + chalk.cyan('biofs shares --json > graph.json'));
  console.log(chalk.gray('   • Use with D3.js, Cytoscape.js, or Neo4j'));
  console.log(chalk.gray('   • GraphQL endpoint: Coming soon!'));
  console.log();
}

