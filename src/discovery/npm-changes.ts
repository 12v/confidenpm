import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PackageInfo, StateData } from '../types';
const STATE_FILE = path.join(process.cwd(), 'data', 'state.json');
const MAX_PACKAGES_PER_RUN = 20;

export class NpmChangesFeed {
  private state: StateData;

  constructor() {
    this.state = {
      lastSequence: 0,
      lastDiscovered: new Date().toISOString(),
      lastScanned: new Date().toISOString(),
      discoveredPackages: new Set<string>(),
      scannedPackages: new Set<string>()
    };
  }

  async loadState(): Promise<void> {
    try {
      const stateData = await fs.readFile(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(stateData);
      this.state = {
        ...parsed,
        processedPackages: new Set(parsed.processedPackages || [])
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

      // For first run, don't include 'since' parameter to get recent changes
      const params: any = {
        limit: 20
      };

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
      this.state.lastDiscovered = new Date().toISOString();
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
    this.state.lastScanned = new Date().toISOString();
    await this.saveState();
  }

  // This method is now deprecated and should be removed after updating the workflows
  async getRecentVersions(hours: number = 1): Promise<PackageInfo[]> {
    console.log(`Looking for packages from the last ${hours} hours...`);

    const packages: PackageInfo[] = [];
    const packagesToProcess = new Map<string, PackageInfo>();
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);

    try {
      // For longer time periods, we need to fetch more changes
      const limit = Math.min(1000, Math.max(50, hours * 10)); // Scale limit with hours
      console.log(`Fetching up to ${limit} changes...`);

      const params: any = { limit };

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
        let deletedCount = 0;
        let processedCount = 0;
        let tooOldCount = 0;
        let noDateCount = 0;

        for (const change of response.data.results) {
          // Skip deleted packages and design docs
          if (change.deleted) {
            deletedCount++;
            continue;
          }

          if (!change.id || change.id.startsWith('_design/')) {
            continue;
          }

          processedCount++;

          // Fetch package info to check publish date
          const packageInfo = await this.fetchPackageInfo(change.id);
          if (packageInfo) {
            if (!packageInfo.publishedAt) {
              noDateCount++;
              if (noDateCount <= 2) {
                console.log(`Package ${packageInfo.name}@${packageInfo.version} has no publishedAt date, treating as recent`);
              }
              // If no publish date, treat as recent (could be a new package)
              const fullPackageId = `${packageInfo.name}@${packageInfo.version}`;
              if (!packagesToProcess.has(fullPackageId)) {
                packagesToProcess.set(fullPackageId, packageInfo);
                if (packagesToProcess.size >= MAX_PACKAGES_PER_RUN) {
                  break;
                }
              }
              continue;
            }

            const publishDate = new Date(packageInfo.publishedAt);
            const hoursAgo = (Date.now() - publishDate.getTime()) / (1000 * 60 * 60);

            if (publishDate >= cutoffTime) {
              const fullPackageId = `${packageInfo.name}@${packageInfo.version}`;

              if (!packagesToProcess.has(fullPackageId)) {
                console.log(`Found recent package: ${packageInfo.name}@${packageInfo.version} (${hoursAgo.toFixed(1)}h ago)`);
                packagesToProcess.set(fullPackageId, packageInfo);

                if (packagesToProcess.size >= MAX_PACKAGES_PER_RUN) {
                  break;
                }
              }
            } else {
              tooOldCount++;
              if (tooOldCount <= 3) {
                console.log(`Package ${packageInfo.name}@${packageInfo.version} is too old: ${hoursAgo.toFixed(1)}h ago`);
              }
            }
          }

          // Only check first 50 packages to avoid too much API spam
          if (processedCount >= 50) {
            break;
          }
        }

        console.log(`Summary: ${deletedCount} deleted, ${processedCount} processed, ${tooOldCount} too old, ${noDateCount} no date`);
      }

      packages.push(...packagesToProcess.values());

    } catch (error) {
      console.error('Error fetching recent versions:', error);
    }

    console.log(`Found ${packages.length} packages from the last ${hours} hours`);
    return packages;
  }
}