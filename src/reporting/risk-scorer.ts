import { ScanResult, RiskScore, VulnerabilityResult, CodeIssue, SecretFinding, MetadataIssue } from '../types';

export class RiskScorer {
  static calculateRiskScore(
    vulnerabilities: VulnerabilityResult[],
    codeIssues: CodeIssue[],
    secrets: SecretFinding[],
    metadataIssues: MetadataIssue[]
  ): RiskScore {
    let score = 0;

    score += this.scoreVulnerabilities(vulnerabilities);
    score += this.scoreCodeIssues(codeIssues);
    score += this.scoreSecrets(secrets);
    score += this.scoreMetadataIssues(metadataIssues);

    const overall = this.scoreToRiskLevel(score);

    return {
      overall,
      vulnerabilities: vulnerabilities.length,
      codeIssues: codeIssues.length,
      secrets: secrets.length,
      metadataIssues: metadataIssues.length
    };
  }

  private static scoreVulnerabilities(vulnerabilities: VulnerabilityResult[]): number {
    return vulnerabilities.reduce((score, vuln) => {
      switch (vuln.severity) {
        case 'CRITICAL':
          return score + 40;
        case 'HIGH':
          return score + 20;
        case 'MEDIUM':
          return score + 8;
        case 'LOW':
          return score + 2;
        default:
          return score;
      }
    }, 0);
  }

  private static scoreCodeIssues(codeIssues: CodeIssue[]): number {
    return codeIssues.reduce((score, issue) => {
      const baseScore = (() => {
        switch (issue.severity) {
          case 'HIGH':
            return 15;
          case 'MEDIUM':
            return 5;
          case 'LOW':
            return 1;
          default:
            return 0;
        }
      })();

      const multiplier = this.getIssueMultiplier(issue.rule);
      return score + (baseScore * multiplier);
    }, 0);
  }

  private static scoreSecrets(secrets: SecretFinding[]): number {
    return secrets.reduce((score, secret) => {
      const baseScore = (() => {
        switch (secret.confidence) {
          case 'HIGH':
            return 25;
          case 'MEDIUM':
            return 10;
          case 'LOW':
            return 3;
          default:
            return 0;
        }
      })();

      const multiplier = this.getSecretMultiplier(secret.type);
      return score + (baseScore * multiplier);
    }, 0);
  }

  private static scoreMetadataIssues(metadataIssues: MetadataIssue[]): number {
    return metadataIssues.reduce((score, issue) => {
      switch (issue.severity) {
        case 'HIGH':
          return score + 10;
        case 'MEDIUM':
          return score + 5;
        case 'LOW':
          return score + 1;
        default:
          return score;
      }
    }, 0);
  }

  private static getIssueMultiplier(rule: string): number {
    const highRiskPatterns = [
      'eval-usage',
      'child-process',
      'install-scripts',
      'crypto-mining'
    ];

    const mediumRiskPatterns = [
      'network-request',
      'fs-operations',
      'obfuscation'
    ];

    if (highRiskPatterns.some(pattern => rule.includes(pattern))) {
      return 2.0;
    }

    if (mediumRiskPatterns.some(pattern => rule.includes(pattern))) {
      return 1.5;
    }

    return 1.0;
  }

  private static getSecretMultiplier(secretType: string): number {
    const criticalSecrets = [
      'AWS Access Key',
      'Private Key',
      'NPM Token',
      'GitHub Token'
    ];

    const highRiskSecrets = [
      'Google API Key',
      'Slack Token',
      'Discord Bot Token',
      'Stripe Secret Key'
    ];

    if (criticalSecrets.includes(secretType)) {
      return 2.5;
    }

    if (highRiskSecrets.includes(secretType)) {
      return 2.0;
    }

    return 1.0;
  }

  private static scoreToRiskLevel(score: number): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
    if (score >= 80) {
      return 'CRITICAL';
    } else if (score >= 40) {
      return 'HIGH';
    } else if (score >= 15) {
      return 'MEDIUM';
    } else {
      return 'LOW';
    }
  }

  static shouldCreateIssue(riskScore: RiskScore): boolean {
    return riskScore.overall === 'CRITICAL' ||
           riskScore.overall === 'HIGH' ||
           (riskScore.overall === 'MEDIUM' && (
             riskScore.vulnerabilities > 0 ||
             riskScore.secrets > 0
           ));
  }
}