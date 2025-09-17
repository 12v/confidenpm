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
      lastProcessed: new Date().toISOString(),
      processedPackages: new Set<string>()
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
      processedPackages: Array.from(this.state.processedPackages)
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

          // Skip if we've already processed this package
          if (this.state.processedPackages.has(packageId)) {
            console.log(`Skipping already processed package: ${change.id}`);
            continue;
          }

          console.log(`Processing package: ${change.id}`);

          // Fetch package info
          const packageInfo = await this.fetchPackageInfo(change.id);
          if (packageInfo) {
            const fullPackageId = `${packageInfo.name}@${packageInfo.version}`;

            if (!this.state.processedPackages.has(fullPackageId)) {
              packagesToProcess.set(fullPackageId, packageInfo);
              this.state.processedPackages.add(fullPackageId);

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
      this.state.lastProcessed = new Date().toISOString();
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

  async getRecentVersions(hours: number = 1): Promise<PackageInfo[]> {
    await this.loadState();

    const packages: PackageInfo[] = [];
    const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);

    try {
      // Use search API to find recently updated packages
      const response = await axios.get('https://registry.npmjs.org/-/v1/search', {
        params: {
          text: 'not:deprecated',
          size: 100,
          quality: 0.1,
          popularity: 0.1,
          maintenance: 0.8
        },
        timeout: 30000
      });

      if (response.data.objects) {
        for (const pkg of response.data.objects) {
          const packageName = pkg.package.name;
          const packageVersion = pkg.package.version;
          const packageId = `${packageName}@${packageVersion}`;

          if (!this.state.processedPackages.has(packageId)) {
            const publishDate = new Date(pkg.package.date);

            if (publishDate >= cutoffTime) {
              const packageInfo: PackageInfo = {
                name: packageName,
                version: packageVersion,
                publishedAt: pkg.package.date,
                publisher: pkg.package.publisher?.username,
                description: pkg.package.description,
                repository: pkg.package.links?.repository,
                dependencies: {},
                devDependencies: {}
              };

              packages.push(packageInfo);
              this.state.processedPackages.add(packageId);

              if (packages.length >= MAX_PACKAGES_PER_RUN) {
                break;
              }
            }
          }
        }
      }

      await this.saveState();
    } catch (error) {
      console.error('Error fetching recent versions:', error);
    }

    return packages;
  }
}