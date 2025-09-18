import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PackageInfo, StateData } from '../types';
const STATE_FILE = path.join(process.cwd(), 'data', 'state.json');
const MAX_PACKAGES_PER_RUN = 10000;

export class NpmChangesFeed {
  private state: StateData;

  constructor() {
    this.state = {
      lastSequence: 0,
      discoveredPackages: new Set<string>(),
      scannedPackages: new Set<string>()
    };
  }

  async loadState(): Promise<void> {
    try {
      const stateData = await fs.readFile(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(stateData);
      this.state = {
        lastSequence: parsed.lastSequence || 0,
        discoveredPackages: new Set(parsed.discoveredPackages || []),
        scannedPackages: new Set(parsed.scannedPackages || [])
      };
    } catch (error) {
      console.log('No existing state found, starting fresh');
    }
  }

  async saveState(): Promise<void> {
    const stateToSave = {
      ...this.state,
      discoveredPackages: Array.from(this.state.discoveredPackages),
      scannedPackages: Array.from(this.state.scannedPackages)
    };
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(stateToSave, null, 2));
  }

  async getLatestChanges(): Promise<PackageInfo[]> {
    await this.loadState();

    const packages: PackageInfo[] = [];
    const packagesToProcess = new Map<string, PackageInfo>();

    try {
      console.log(`Starting changes feed request...`);

      const params: any = {
        limit: 10000
      };

      // Include 'since' parameter if we have a lastSequence
      if (this.state.lastSequence > 0) {
        params.since = this.state.lastSequence;
      }

      const response = await axios.get('https://replicate.npmjs.com/registry/_changes', {
        params,
        headers: {
          'npm-replication-opt-in': 'true',
          'User-Agent': 'npm-security-scanner/1.0'
        },
        timeout: 30000
      });

      console.log(`Got ${response.data.results?.length || 0} changes`);

      if (response.data.results && response.data.results.length > 0) {
        for (const change of response.data.results) {
          // Skip deleted packages and design docs
          if (change.deleted) {
            console.log(`Skipping deleted package: ${change.id}`);
            continue;
          }

          if (!change.id || change.id.startsWith('_design/')) {
            console.log(`Skipping design doc: ${change.id}`);
            continue;
          }

          const packageId = `${change.id}@latest`;

          // Skip if we've already discovered this package
          if (this.state.discoveredPackages.has(packageId)) {
            console.log(`Skipping already discovered package: ${change.id}`);
            continue;
          }

          console.log(`Discovering package: ${change.id}`);

          // Fetch package info
          const packageInfo = await this.fetchPackageInfo(change.id);
          if (packageInfo) {
            const fullPackageId = `${packageInfo.name}@${packageInfo.version}`;

            if (!this.state.discoveredPackages.has(fullPackageId)) {
              packagesToProcess.set(fullPackageId, packageInfo);
              this.state.discoveredPackages.add(fullPackageId);

              if (packagesToProcess.size >= MAX_PACKAGES_PER_RUN) {
                break;
              }
            }
          }

          // Update sequence number
          this.state.lastSequence = Math.max(this.state.lastSequence, change.seq);
        }

        // If we got results, update the last sequence
        if (response.data.last_seq) {
          this.state.lastSequence = response.data.last_seq;
        }
      }

      packages.push(...packagesToProcess.values());
      await this.saveState();

      console.log(`Found ${packages.length} new packages to scan`);

    } catch (error: any) {
      console.error('Error fetching changes feed:', error);
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      }
    }

    return packages;
  }


  async fetchPackageInfo(packageName: string): Promise<PackageInfo | null> {
    try {
      const response = await axios.get(
        `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
        { timeout: 10000 }
      );

      const data = response.data;

      return {
        name: data.name,
        version: data.version,
        publishedAt: data.time?.[data.version],
        publisher: data._npmUser?.name || data.maintainers?.[0]?.name,
        description: data.description,
        repository: data.repository?.url,
        dependencies: data.dependencies || {},
        devDependencies: data.devDependencies || {}
      };
    } catch (error) {
      console.error(`Error fetching package info for ${packageName}:`, error);
      return null;
    }
  }

  async getPendingScans(): Promise<PackageInfo[]> {
    await this.loadState();
    const packages: PackageInfo[] = [];
    const pendingPackages = new Set([...this.state.discoveredPackages].filter(pkg => !this.state.scannedPackages.has(pkg)));

    console.log(`Found ${pendingPackages.size} packages pending scan`);

    for (const packageId of pendingPackages) {
      const [name] = packageId.split('@');
      const packageInfo = await this.fetchPackageInfo(name);
      if (packageInfo) {
        packages.push(packageInfo);
        if (packages.length >= MAX_PACKAGES_PER_RUN) {
          break;
        }
      }
    }

    return packages;
  }

  async markPackagesScanned(packages: PackageInfo[]): Promise<void> {
    await this.loadState();
    for (const pkg of packages) {
      const fullPackageId = `${pkg.name}@${pkg.version}`;
      this.state.scannedPackages.add(fullPackageId);
    }
    await this.saveState();
  }

  async markPackagesScannedWithRetry(packages: PackageInfo[], maxRetries: number = 3): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.markPackagesScanned(packages);
        return;
      } catch (error) {
        console.error(`Attempt ${attempt}/${maxRetries} failed to update state:`, error);
        if (attempt === maxRetries) {
          throw error;
        }
        // Exponential backoff with jitter
        const delay = Math.random() * 1000 * Math.pow(2, attempt);
        console.log(`Retrying in ${Math.round(delay)}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

}