#!/usr/bin/env node

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { NpmChangesFeed } from './discovery/npm-changes';
import { SafePackageHandler } from './scanners/sandbox';
import { VulnerabilityScanner } from './scanners/vulnerability';
import { StaticAnalysisScanner } from './scanners/static-analysis';
import { SecretsScanner } from './scanners/secrets';
import { GitHubIssueCreator } from './reporting/issue-creator';
import { RiskScorer } from './reporting/risk-scorer';
import { PackageInfo, ScanResult } from './types';

class NPMSecurityScanner {
  private issueCreator?: GitHubIssueCreator;

  constructor() {
    const githubToken = process.env.GITHUB_TOKEN;
    const repoOwner = process.env.GITHUB_REPOSITORY_OWNER || process.env.GITHUB_ACTOR;
    const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1];

    if (githubToken && repoOwner && repoName) {
      this.issueCreator = new GitHubIssueCreator(githubToken, repoOwner, repoName);
    }
  }

  async discover(): Promise<void> {
    console.log('🔍 Discovering new npm packages...');

    const changesFeed = new NpmChangesFeed();
    const packages = await changesFeed.getLatestChanges();

    console.log(`Found ${packages.length} packages to scan`);

    for (const pkg of packages) {
      console.log(`- ${pkg.name}@${pkg.version} (published: ${pkg.publishedAt})`);
    }

    if (packages.length === 0) {
      console.log('No new packages found');
      return;
    }

    console.log(`\nScheduling scans for ${packages.length} packages...`);
  }

  async scanPackage(packageName: string, version?: string): Promise<void> {
    console.log(`🔎 Scanning package: ${packageName}${version ? `@${version}` : ''}`);

    const changesFeed = new NpmChangesFeed();
    const packageInfo = await changesFeed.fetchPackageInfo(packageName);

    if (!packageInfo) {
      console.error(`Package not found: ${packageName}`);
      return;
    }

    if (version && packageInfo.version !== version) {
      console.error(`Version mismatch: expected ${version}, got ${packageInfo.version}`);
      return;
    }

    const sandbox = new SafePackageHandler();

    try {
      const result = await this.performScan(packageInfo, sandbox);
      await this.processResults(result);
    } catch (error) {
      console.error(`Error scanning package ${packageName}:`, error);
    } finally {
      await sandbox.cleanup();
    }
  }

  async scanBatch(packages: PackageInfo[]): Promise<void> {
    console.log(`🔎 Scanning batch of ${packages.length} packages...`);

    for (const pkg of packages) {
      const sandbox = new SafePackageHandler();

      try {
        console.log(`\nScanning ${pkg.name}@${pkg.version}...`);
        const result = await this.performScan(pkg, sandbox);
        await this.processResults(result);
      } catch (error) {
        console.error(`Error scanning ${pkg.name}@${pkg.version}:`, error);
      } finally {
        await sandbox.cleanup();
      }
    }
  }

  private async performScan(packageInfo: PackageInfo, sandbox: SafePackageHandler): Promise<ScanResult> {
    const tarballPath = await sandbox.downloadPackage(packageInfo);
    const extractDir = await sandbox.extractPackage(tarballPath);
    await sandbox.createPackageJson(packageInfo, extractDir);

    const vulnerabilityScanner = new VulnerabilityScanner(sandbox);
    const staticAnalysisScanner = new StaticAnalysisScanner(sandbox);
    const secretsScanner = new SecretsScanner(sandbox);

    const [vulnerabilities, codeIssues, secrets] = await Promise.all([
      vulnerabilityScanner.scan(extractDir),
      staticAnalysisScanner.scan(extractDir),
      secretsScanner.scan(extractDir)
    ]);

    const metadataIssues = this.analyzeMetadata(packageInfo);

    const riskScore = RiskScorer.calculateRiskScore(
      vulnerabilities,
      codeIssues,
      secrets,
      metadataIssues
    );

    return {
      package: packageInfo,
      timestamp: new Date().toISOString(),
      vulnerabilities,
      codeIssues,
      secrets,
      metadataIssues,
      riskScore
    };
  }

  private analyzeMetadata(packageInfo: PackageInfo): any[] {
    const issues = [];

    if (!packageInfo.description || packageInfo.description.length < 10) {
      issues.push({
        type: 'missing-description',
        severity: 'LOW',
        message: 'Package has no or minimal description'
      });
    }

    if (!packageInfo.repository) {
      issues.push({
        type: 'missing-repository',
        severity: 'MEDIUM',
        message: 'Package has no repository URL'
      });
    }

    const hasScripts = Object.keys(packageInfo.dependencies || {}).some(dep =>
      dep.includes('install') || dep.includes('preinstall') || dep.includes('postinstall')
    );

    if (hasScripts) {
      issues.push({
        type: 'install-scripts',
        severity: 'HIGH',
        message: 'Package may contain install scripts that run automatically'
      });
    }

    return issues;
  }

  private async processResults(result: ScanResult): Promise<void> {
    console.log(`\n📊 Scan Results for ${result.package.name}@${result.package.version}`);
    console.log(`Risk Level: ${result.riskScore.overall}`);
    console.log(`Vulnerabilities: ${result.vulnerabilities.length}`);
    console.log(`Code Issues: ${result.codeIssues.length}`);
    console.log(`Secrets: ${result.secrets.length}`);
    console.log(`Metadata Issues: ${result.metadataIssues.length}`);

    if (RiskScorer.shouldCreateIssue(result.riskScore)) {
      if (this.issueCreator) {
        console.log('📝 Creating GitHub issue...');
        await this.issueCreator.createIssueForScanResult(result);
      } else {
        console.log('⚠️ GitHub token not configured, skipping issue creation');
      }
    } else {
      console.log('✅ Risk level too low, not creating issue');
    }
  }
}

async function main() {
  await yargs(hideBin(process.argv))
    .version(false)
    .command('discover', 'Discover new packages from npm registry', {}, async () => {
      const scanner = new NPMSecurityScanner();
      await scanner.discover();
    })
    .command('scan <package>', 'Scan a specific package',
      (yargs) => {
        return yargs
          .positional('package', {
            describe: 'Package name to scan',
            type: 'string'
          })
          .option('version', {
            alias: 'v',
            describe: 'Specific version to scan',
            type: 'string'
          });
      },
      async (argv) => {
        const scanner = new NPMSecurityScanner();
        await scanner.scanPackage(argv.package as string, argv.version as string);
      }
    )
    .command('scan-pending', 'Scan packages that have been discovered but not yet scanned',
      {},
      async () => {
        const scanner = new NPMSecurityScanner();
        const changesFeed = new NpmChangesFeed();
        const packages = await changesFeed.getPendingScans();

        if (packages.length > 0) {
          await scanner.scanBatch(packages);
          // Mark these packages as scanned
          await changesFeed.markPackagesScanned(packages);
        } else {
          console.log('No pending packages to scan');
        }
      }
    )
    .demandCommand(1, 'You need to specify a command')
    .help()
    .argv;
}

if (require.main === module) {
  main().catch(console.error);
}

export { NPMSecurityScanner };