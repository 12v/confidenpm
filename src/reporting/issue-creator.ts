import { Octokit } from '@octokit/rest';
import { ScanResult } from '../types';

export class GitHubIssueCreator {
  private octokit: Octokit;
  private owner: string;
  private repo: string;

  constructor(token: string, owner: string, repo: string) {
    this.octokit = new Octokit({ auth: token });
    this.owner = owner;
    this.repo = repo;
  }

  async createIssueForScanResult(result: ScanResult): Promise<void> {
    const title = this.generateTitle(result);
    const body = this.generateBody(result);
    const labels = this.generateLabels(result);

    try {
      const existing = await this.findExistingIssue(result.package.name, result.package.version);

      if (existing) {
        await this.updateExistingIssue(existing.number, body);
        console.log(`Updated existing issue #${existing.number} for ${result.package.name}@${result.package.version}`);
      } else {
        const issue = await this.octokit.issues.create({
          owner: this.owner,
          repo: this.repo,
          title,
          body,
          labels
        });
        console.log(`Created issue #${issue.data.number} for ${result.package.name}@${result.package.version}`);
      }
    } catch (error) {
      console.error('Error creating/updating GitHub issue:', error);
    }
  }

  private generateTitle(result: ScanResult): string {
    const riskLevel = result.riskScore.overall;
    const packageName = result.package.name;
    const version = result.package.version;

    return `[${riskLevel}] Security scan: ${packageName}@${version}`;
  }

  private generateBody(result: ScanResult): string {
    const { package: pkg, vulnerabilities, codeIssues, secrets, metadataIssues, riskScore } = result;

    let body = `# Security Scan Report\n\n`;

    body += `**Package:** \`${pkg.name}@${pkg.version}\`\n`;
    body += `**Scan Date:** ${new Date(result.timestamp).toLocaleString()}\n`;
    body += `**Risk Score:** ${riskScore.overall}\n\n`;

    if (pkg.description) {
      body += `**Description:** ${pkg.description}\n\n`;
    }

    if (pkg.repository) {
      body += `**Repository:** ${pkg.repository}\n\n`;
    }

    body += `## Risk Summary\n\n`;
    body += `| Category | Count | Risk Level |\n`;
    body += `|----------|-------|------------|\n`;
    body += `| Vulnerabilities | ${vulnerabilities.length} | ${this.getHighestSeverity(vulnerabilities.map(v => v.severity))} |\n`;
    body += `| Code Issues | ${codeIssues.length} | ${this.getHighestSeverity(codeIssues.map(c => c.severity))} |\n`;
    body += `| Secrets | ${secrets.length} | ${this.getHighestSeverity(secrets.map(s => s.confidence))} |\n`;
    body += `| Metadata Issues | ${metadataIssues.length} | ${this.getHighestSeverity(metadataIssues.map(m => m.severity))} |\n\n`;

    if (vulnerabilities.length > 0) {
      body += `## 🔴 Vulnerabilities (${vulnerabilities.length})\n\n`;

      const critical = vulnerabilities.filter(v => v.severity === 'CRITICAL');
      const high = vulnerabilities.filter(v => v.severity === 'HIGH');
      const medium = vulnerabilities.filter(v => v.severity === 'MEDIUM');
      const low = vulnerabilities.filter(v => v.severity === 'LOW');

      if (critical.length > 0) {
        body += `### Critical (${critical.length})\n`;
        critical.forEach(vuln => {
          body += `- **${vuln.title}** (${vuln.cve || 'No CVE'})\n`;
          body += `  - Package: \`${vuln.affectedPackage}\`\n`;
          body += `  - Description: ${vuln.description}\n`;
          if (vuln.fixedVersion) {
            body += `  - Fixed in: ${vuln.fixedVersion}\n`;
          }
          body += `\n`;
        });
      }

      if (high.length > 0) {
        body += `### High (${high.length})\n`;
        high.slice(0, 5).forEach(vuln => {
          body += `- **${vuln.title}** (${vuln.cve || 'No CVE'}) - ${vuln.affectedPackage}\n`;
        });
        if (high.length > 5) {
          body += `- ... and ${high.length - 5} more high severity issues\n`;
        }
        body += `\n`;
      }

      if (medium.length > 0 || low.length > 0) {
        body += `<details><summary>Medium/Low Severity Issues (${medium.length + low.length})</summary>\n\n`;
        [...medium, ...low].slice(0, 10).forEach(vuln => {
          body += `- **${vuln.severity}**: ${vuln.title} - ${vuln.affectedPackage}\n`;
        });
        body += `\n</details>\n\n`;
      }
    }

    if (codeIssues.length > 0) {
      body += `## ⚠️ Code Issues (${codeIssues.length})\n\n`;

      const highIssues = codeIssues.filter(c => c.severity === 'HIGH');

      if (highIssues.length > 0) {
        body += `### High Severity Issues\n`;
        highIssues.forEach(issue => {
          body += `- **${issue.rule}**: ${issue.message}\n`;
          body += `  - File: \`${issue.file}\`${issue.line ? ` (Line ${issue.line})` : ''}\n`;
          if (issue.pattern) {
            body += `  - Code: \`${issue.pattern.substring(0, 100)}\`\n`;
          }
          body += `\n`;
        });
      }

      const otherIssues = codeIssues.filter(c => c.severity !== 'HIGH');
      if (otherIssues.length > 0) {
        body += `<details><summary>Other Issues (${otherIssues.length})</summary>\n\n`;
        otherIssues.slice(0, 10).forEach(issue => {
          body += `- **${issue.severity}**: ${issue.rule} - ${issue.file}\n`;
        });
        body += `\n</details>\n\n`;
      }
    }

    if (secrets.length > 0) {
      body += `## 🔑 Secrets Found (${secrets.length})\n\n`;

      const highConfidence = secrets.filter(s => s.confidence === 'HIGH');

      if (highConfidence.length > 0) {
        body += `### High Confidence\n`;
        highConfidence.forEach(secret => {
          body += `- **${secret.type}** in \`${secret.file}\`${secret.line ? ` (Line ${secret.line})` : ''}\n`;
          body += `  - Match: \`${secret.match}\`\n\n`;
        });
      }

      const otherSecrets = secrets.filter(s => s.confidence !== 'HIGH');
      if (otherSecrets.length > 0) {
        body += `<details><summary>Lower Confidence Secrets (${otherSecrets.length})</summary>\n\n`;
        otherSecrets.slice(0, 5).forEach(secret => {
          body += `- **${secret.confidence}**: ${secret.type} - ${secret.file}\n`;
        });
        body += `\n</details>\n\n`;
      }
    }

    if (metadataIssues.length > 0) {
      body += `## 📊 Metadata Issues (${metadataIssues.length})\n\n`;
      metadataIssues.forEach(issue => {
        body += `- **${issue.severity}**: ${issue.message}\n`;
      });
      body += `\n`;
    }

    body += `---\n`;
    body += `*This issue was automatically generated by the NPM Security Scanner*\n`;
    body += `*Scan timestamp: ${result.timestamp}*`;

    return body;
  }

  private generateLabels(result: ScanResult): string[] {
    const labels = ['security-scan', 'auto-generated'];

    labels.push(`risk-${result.riskScore.overall.toLowerCase()}`);

    if (result.vulnerabilities.length > 0) {
      labels.push('vulnerabilities');
    }

    if (result.secrets.length > 0) {
      labels.push('secrets');
    }

    if (result.codeIssues.some(c => c.severity === 'HIGH')) {
      labels.push('code-issues');
    }

    return labels;
  }

  private async findExistingIssue(packageName: string, version: string): Promise<any> {
    try {
      const searchQuery = `repo:${this.owner}/${this.repo} is:issue "${packageName}@${version}" in:title`;

      const response = await this.octokit.search.issuesAndPullRequests({
        q: searchQuery
      });

      return response.data.items.length > 0 ? response.data.items[0] : null;
    } catch (error) {
      console.error('Error searching for existing issue:', error);
      return null;
    }
  }

  private async updateExistingIssue(issueNumber: number, body: string): Promise<void> {
    await this.octokit.issues.update({
      owner: this.owner,
      repo: this.repo,
      issue_number: issueNumber,
      body
    });
  }

  private getHighestSeverity(severities: string[]): string {
    if (severities.includes('CRITICAL')) return 'CRITICAL';
    if (severities.includes('HIGH')) return 'HIGH';
    if (severities.includes('MEDIUM')) return 'MEDIUM';
    if (severities.includes('LOW')) return 'LOW';
    return 'NONE';
  }
}