import { CodeIssue } from '../types';
import { SafePackageHandler } from './sandbox';
import * as fs from 'fs/promises';
import * as path from 'path';

export class StaticAnalysisScanner {
  private sandbox: SafePackageHandler;

  constructor(sandbox: SafePackageHandler) {
    this.sandbox = sandbox;
  }

  async scan(extractDir: string): Promise<CodeIssue[]> {
    const issues: CodeIssue[] = [];

    try {
      const semgrepIssues = await this.runSemgrep(extractDir);
      issues.push(...semgrepIssues);

      const customPatterns = await this.scanForSuspiciousPatterns(extractDir);
      issues.push(...customPatterns);

    } catch (error) {
      console.error('Static analysis error:', error);
    }

    return issues;
  }

  private async runSemgrep(extractDir: string): Promise<CodeIssue[]> {
    const issues: CodeIssue[] = [];

    try {
      // Check if semgrep is available
      await this.sandbox.runInSandbox('which', ['semgrep'], extractDir);

      const output = await this.sandbox.runInSandbox(
        'semgrep',
        [
          '--config=auto',
          '--json',
          '--no-git-ignore',
          '--timeout=120',
          '--max-memory=1024',
          '--metrics=off',
          extractDir
        ],
        extractDir
      );

      const data = JSON.parse(output);

      if (data.results) {
        for (const result of data.results) {
          issues.push({
            severity: this.mapSemgrepSeverity(result.extra?.severity || 'INFO'),
            rule: result.check_id,
            message: result.extra?.message || result.check_id,
            file: result.path.replace(extractDir, ''),
            line: result.start?.line,
            pattern: result.extra?.lines
          });
        }
      }
    } catch (error) {
      console.log('Semgrep not available, skipping static analysis');
    }

    return issues;
  }

  private async scanForSuspiciousPatterns(extractDir: string): Promise<CodeIssue[]> {
    const issues: CodeIssue[] = [];
    const suspiciousPatterns = [
      {
        name: 'eval-usage',
        pattern: /eval\s*\(/gi,
        severity: 'HIGH' as const,
        message: 'Direct eval() usage detected - potential code injection risk'
      },
      {
        name: 'child-process',
        pattern: /child_process|exec\s*\(|spawn\s*\(/gi,
        severity: 'HIGH' as const,
        message: 'Child process execution detected - potential command injection'
      },
      {
        name: 'network-request',
        pattern: /https?:\/\/[^\s'"]+|fetch\s*\(|axios|request\s*\(/gi,
        severity: 'MEDIUM' as const,
        message: 'Network request detected - verify destination'
      },
      {
        name: 'fs-operations',
        pattern: /fs\.(write|unlink|rmdir|rename)|rimraf/gi,
        severity: 'MEDIUM' as const,
        message: 'File system write/delete operations detected'
      },
      {
        name: 'crypto-mining',
        pattern: /crypto-?miner|coinhive|cryptonight|monero/gi,
        severity: 'HIGH' as const,
        message: 'Potential cryptocurrency mining code detected'
      },
      {
        name: 'obfuscation',
        pattern: /\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|atob|btoa|Buffer\.from.*base64/gi,
        severity: 'MEDIUM' as const,
        message: 'Potential code obfuscation detected'
      },
      {
        name: 'install-scripts',
        pattern: /"(pre|post)install"\s*:/gi,
        severity: 'HIGH' as const,
        message: 'Package install scripts detected - these run automatically'
      },
      {
        name: 'env-access',
        pattern: /process\.env\.|NODE_ENV|npm_config_/gi,
        severity: 'LOW' as const,
        message: 'Environment variable access detected'
      }
    ];

    try {
      const files = await this.getAllFiles(extractDir);

      for (const file of files) {
        if (file.endsWith('.js') || file.endsWith('.ts') || file.endsWith('.json')) {
          const content = await fs.readFile(file, 'utf-8');
          const lines = content.split('\n');

          for (const pattern of suspiciousPatterns) {
            const matches = content.matchAll(pattern.pattern);

            for (const match of matches) {
              const lineNumber = this.getLineNumber(content, match.index || 0);

              issues.push({
                severity: pattern.severity,
                rule: pattern.name,
                message: pattern.message,
                file: file.replace(extractDir, ''),
                line: lineNumber,
                pattern: lines[lineNumber - 1]?.trim()
              });
            }
          }
        }
      }
    } catch (error) {
      console.error('Pattern scanning error:', error);
    }

    return issues;
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

  private getLineNumber(content: string, index: number): number {
    return content.substring(0, index).split('\n').length;
  }

  private mapSemgrepSeverity(severity: string): 'HIGH' | 'MEDIUM' | 'LOW' {
    switch (severity.toUpperCase()) {
      case 'ERROR':
      case 'HIGH':
        return 'HIGH';
      case 'WARNING':
      case 'MEDIUM':
        return 'MEDIUM';
      case 'INFO':
      case 'LOW':
      default:
        return 'LOW';
    }
  }
}