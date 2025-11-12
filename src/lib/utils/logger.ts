import chalk from 'chalk';
import boxen from 'boxen';
import ora, { Ora } from 'ora';

export class Logger {
  static success(message: string): void {
    console.log(chalk.green(`✅ ${message}`));
  }

  static error(message: string): void {
    console.log(chalk.red(`❌ ${message}`));
  }

  static warning(message: string): void {
    console.log(chalk.yellow(`⚠️  ${message}`));
  }

  static warn(message: string): void {
    console.log(chalk.yellow(`⚠️  ${message}`));
  }

  static info(message: string): void {
    console.log(chalk.blue(`ℹ️  ${message}`));
  }

  static debug(message: string): void {
    if (process.env.DEBUG) {
      console.log(chalk.gray(`🔍 ${message}`));
    }
  }

  static box(content: string, title?: string): void {
    console.log(
      boxen(content, {
        padding: 1,
        margin: 1,
        borderStyle: 'round',
        borderColor: 'green',
        title: title,
        titleAlignment: 'center'
      })
    );
  }

  static table(headers: string[], rows: string[][]): void {
    const Table = require('cli-table3');
    const table = new Table({
      head: headers.map(h => chalk.cyan(h)),
      style: {
        head: [],
        border: []
      }
    });

    rows.forEach(row => table.push(row));
    console.log(table.toString());
  }

  static spinner(text: string): Ora {
    return ora({
      text,
      spinner: 'dots'
    }).start();
  }

  static formatWallet(wallet: string): string {
    if (wallet.length <= 15) return wallet;
    return `${wallet.slice(0, 6)}...${wallet.slice(-4)}`;
  }

  static formatDate(date: string | Date): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toLocaleString();
  }

  static formatFileSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  static formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days} day${days !== 1 ? 's' : ''}`;
    if (hours > 0) return `${hours} hour${hours !== 1 ? 's' : ''}`;
    if (minutes > 0) return `${minutes} minute${minutes !== 1 ? 's' : ''}`;
    return `${seconds} second${seconds !== 1 ? 's' : ''}`;
  }
}