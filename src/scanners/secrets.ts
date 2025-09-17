import { SecretFinding } from '../types';
import { SafePackageHandler } from './sandbox';
import * as fs from 'fs/promises';
import * as path from 'path';

export class SecretsScanner {
  private sandbox: SafePackageHandler;

  constructor(sandbox: SafePackageHandler) {
    this.sandbox = sandbox;
  }

  async scan(extractDir: string): Promise<SecretFinding[]> {
    const secrets: SecretFinding[] = [];

    try {
      const truffleHogSecrets = await this.runTruffleHog(extractDir);
      secrets.push(...truffleHogSecrets);

      const regexSecrets = await this.scanWithRegexPatterns(extractDir);
      secrets.push(...regexSecrets);

    } catch (error) {
      console.error('Secrets scan error:', error);
    }

    return secrets;
  }

  private async runTruffleHog(extractDir: string): Promise<SecretFinding[]> {
    const secrets: SecretFinding[] = [];

    try {
      // Check if trufflehog is available
      await this.sandbox.runInSandbox('which', ['trufflehog'], extractDir);

      const output = await this.sandbox.runInSandbox(
        'trufflehog',
        [
          'filesystem',
          '--json',
          '--no-update',
          '--no-verification',
          extractDir
        ],
        extractDir
      );

      const lines = output.trim().split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const data = JSON.parse(line);

          if (data.DetectorName && data.Raw) {
            secrets.push({
              type: data.DetectorName,
              file: data.SourceMetadata?.Data?.Filesystem?.file || 'unknown',
              line: data.SourceMetadata?.Data?.Filesystem?.line,
              match: data.Raw.substring(0, 100),
              confidence: this.mapTruffleHogConfidence(data.Verified)
            });
          }
        } catch (parseError) {
          console.error('Error parsing TruffleHog line:', parseError);
        }
      }
    } catch (error) {
      console.log('TruffleHog not available, skipping external secrets scan');
    }

    return secrets;
  }

  private async scanWithRegexPatterns(extractDir: string): Promise<SecretFinding[]> {
    const secrets: SecretFinding[] = [];

    const secretPatterns = [
      {
        name: 'AWS Access Key',
        pattern: /AKIA[0-9A-Z]{16}/gi,
        confidence: 'HIGH' as const
      },
      {
        name: 'GitHub Token',
        pattern: /gh[pousr]_[A-Za-z0-9_]{36,251}/gi,
        confidence: 'HIGH' as const
      },
      {
        name: 'Google API Key',
        pattern: /AIza[0-9A-Za-z\\-_]{35}/gi,
        confidence: 'HIGH' as const
      },
      {
        name: 'Slack Token',
        pattern: /xox[baprs]-([0-9a-zA-Z]{10,48})/gi,
        confidence: 'HIGH' as const
      },
      {
        name: 'JWT Token',
        pattern: /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*/gi,
        confidence: 'MEDIUM' as const
      },
      {
        name: 'Discord Bot Token',
        pattern: /[MN][A-Za-z\d]{23}\.[\w-]{6}\.[\w-]{27}/gi,
        confidence: 'HIGH' as const
      },
      {
        name: 'Stripe Secret Key',
        pattern: /sk_live_[0-9a-zA-Z]{24}/gi,
        confidence: 'HIGH' as const
      },
      {
        name: 'NPM Token',
        pattern: /npm_[A-Za-z0-9]{36}/gi,
        confidence: 'HIGH' as const
      },
      {
        name: 'Private Key',
        pattern: /-----BEGIN[A-Z ]+PRIVATE KEY-----/gi,
        confidence: 'HIGH' as const
      },
      {
        name: 'Database URL',
        pattern: /(mongodb|mysql|postgres):\/\/[^\s'"]+/gi,
        confidence: 'MEDIUM' as const
      },
      {
        name: 'Generic Secret',
        pattern: /(secret|password|key|token)['"]?\s*[:=]\s*['"]?[A-Za-z0-9_-]{20,}/gi,
        confidence: 'LOW' as const
      }
    ];

    try {
      const files = await this.getAllFiles(extractDir);

      for (const file of files) {
        if (this.shouldScanFile(file)) {
          const content = await fs.readFile(file, 'utf-8');
          const lines = content.split('\n');

          for (const pattern of secretPatterns) {
            const matches = content.matchAll(pattern.pattern);

            for (const match of matches) {
              const lineNumber = this.getLineNumber(content, match.index || 0);
              const context = lines[lineNumber - 1]?.trim();

              if (!this.isFalsePositive(match[0], context)) {
                secrets.push({
                  type: pattern.name,
                  file: file.replace(extractDir, ''),
                  line: lineNumber,
                  match: this.maskSecret(match[0]),
                  confidence: pattern.confidence
                });
              }
            }
          }
        }
      }
    } catch (error) {
      console.error('Regex pattern scanning error:', error);
    }

    return secrets;
  }

  private async getAllFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          const subFiles = await this.getAllFiles(fullPath);
          files.push(...subFiles);
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      console.error('Error reading directory:', error);
    }

    return files;
  }

  private shouldScanFile(filePath: string): boolean {
    const textExtensions = ['.js', '.ts', '.json', '.md', '.txt', '.env', '.yml', '.yaml', '.xml', '.config'];
    const binaryExtensions = ['.jpg', '.png', '.gif', '.pdf', '.zip', '.tar', '.gz'];

    const ext = path.extname(filePath).toLowerCase();

    if (binaryExtensions.includes(ext)) {
      return false;
    }

    if (textExtensions.includes(ext)) {
      return true;
    }

    const basename = path.basename(filePath);
    return !basename.includes('.min.') && !basename.includes('.bundle.');
  }

  private isFalsePositive(secret: string, context: string): boolean {
    const falsePositivePatterns = [
      /example|sample|test|demo|placeholder|fake|mock/i,
      /your_key_here|insert_key|api_key_here/i,
      /\$\{.*\}|\{\{.*\}\}|%.*%/,
      /console\.log|logger\.|debug/i
    ];

    const fullContext = context + ' ' + secret;

    return falsePositivePatterns.some(pattern => pattern.test(fullContext));
  }

  private maskSecret(secret: string): string {
    if (secret.length <= 8) {
      return '*'.repeat(secret.length);
    }

    const start = secret.substring(0, 4);
    const end = secret.substring(secret.length - 4);
    const middle = '*'.repeat(Math.min(secret.length - 8, 10));

    return start + middle + end;
  }

  private getLineNumber(content: string, index: number): number {
    return content.substring(0, index).split('\n').length;
  }

  private mapTruffleHogConfidence(verified: boolean): 'HIGH' | 'MEDIUM' | 'LOW' {
    return verified ? 'HIGH' : 'MEDIUM';
  }
}