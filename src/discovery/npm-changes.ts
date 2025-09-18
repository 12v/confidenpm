import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import { PackageInfo, StateData } from '../types';
const DISCOVERY_SEQUENCE_FILE = path.join(process.cwd(), 'data', 'last-sequence.txt');
const DISCOVERED_PACKAGES_FILE = path.join(process.cwd(), 'data', 'discovered-packages.txt');
const DISCOVERED_PACKAGES_NEW_FILE = path.join(process.cwd(), 'data', 'discovered-packages-new.txt');
const SCANNED_PACKAGES_FILE = path.join(process.cwd(), 'data', 'scanned-packages.txt');
const SCANNED_PACKAGES_NEW_FILE = path.join(process.cwd(), 'data', 'scanned-packages-new.txt');
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

  async loadDiscoveryState(): Promise<void> {
    const lastSequence = await this.loadLastSequence();
    const discoveredPackages = await this.loadDiscoveredPackages();

    this.state = {
      lastSequence,
      discoveredPackages,
      scannedPackages: new Set() // Discovery doesn't track scanned packages
    };

    if (lastSequence === 0) {
      console.log(`Initialized with current sequence: ${lastSequence}`);
    }
  }

  async loadLastSequence(): Promise<number> {
    try {
      const sequenceData = await fs.readFile(DISCOVERY_SEQUENCE_FILE, 'utf-8');
      return parseInt(sequenceData.trim(), 10) || 0;
    } catch (error) {
      console.log('No existing sequence file found, getting current sequence');
      const currentSequence = await this.getCurrentSequence();
      await this.saveLastSequence(currentSequence);
      return currentSequence;
    }
  }

  async loadDiscoveredPackages(): Promise<Set<string>> {
    try {
      const packagesData = await fs.readFile(DISCOVERED_PACKAGES_FILE, 'utf-8');
      const packages = packagesData.trim().split('\n').filter(line => line.trim());
      return new Set(packages);
    } catch (error) {
      console.log('No existing discovered packages file found');
      return new Set();
    }
  }

  async getCurrentSequence(): Promise<number> {
    try {
      const response = await axios.get('https://replicate.npmjs.com/registry/_changes', {
        params: { descending: true, limit: 1 },
        headers: {
          'npm-replication-opt-in': 'true',
          'User-Agent': 'npm-security-scanner/1.0'
        },
        timeout: 10000
      });

      return response.data.last_seq || 0;
    } catch (error) {
      console.error('Error fetching current sequence, defaulting to 0:', error);
      return 0;
    }
  }

  async loadScanningState(): Promise<Set<string>> {
    try {
      const stateData = await fs.readFile(SCANNED_PACKAGES_FILE, 'utf-8');
      const packages = stateData.trim().split('\n').filter(line => line.trim());
      return new Set(packages);
    } catch (error) {
      console.log('No existing scanned packages file found');
      return new Set();
    }
  }

  async saveDiscoveryState(): Promise<void> {
    await this.saveLastSequence(this.state.lastSequence);
  }

  async saveLastSequence(sequence: number): Promise<void> {
    await fs.mkdir(path.dirname(DISCOVERY_SEQUENCE_FILE), { recursive: true });
    await fs.writeFile(DISCOVERY_SEQUENCE_FILE, sequence.toString() + '\n');
  }

  async appendNewDiscoveredPackages(packages: string[]): Promise<void> {
    if (packages.length > 0) {
      await fs.mkdir(path.dirname(DISCOVERED_PACKAGES_NEW_FILE), { recursive: true });
      const content = packages.join('\n') + '\n';
      await fs.writeFile(DISCOVERED_PACKAGES_NEW_FILE, content);
    }
  }

  async saveScanningState(scannedPackages: Set<string>): Promise<void> {
    const packagesArray = Array.from(scannedPackages).sort();
    await fs.mkdir(path.dirname(SCANNED_PACKAGES_FILE), { recursive: true });
    await fs.writeFile(SCANNED_PACKAGES_FILE, packagesArray.join('\n') + '\n');
  }

  async getLatestChanges(): Promise<PackageInfo[]> {
    await this.loadDiscoveryState();

    const packages: PackageInfo[] = [];
    const packagesToProcess = new Map<string, PackageInfo>();
    const newDiscoveredPackages: string[] = [];

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

          console.log(`Discovering package: ${change.id}`);

          // Fetch package info to get actual name and version
          const packageInfo = await this.fetchPackageInfo(change.id);
          if (packageInfo && packageInfo.name && packageInfo.version) {
            const fullPackageId = `${packageInfo.name}@${packageInfo.version}`;

            // Validate the package ID is well-formed
            if (packageInfo.version === 'undefined' || !packageInfo.version) {
              console.warn(`Skipping package with invalid version: ${change.id} -> ${fullPackageId}`);
              continue;
            }

            // Skip if we've already discovered this exact version
            if (!this.state.discoveredPackages.has(fullPackageId)) {
              packagesToProcess.set(fullPackageId, packageInfo);
              this.state.discoveredPackages.add(fullPackageId);
              newDiscoveredPackages.push(fullPackageId);

              if (packagesToProcess.size >= MAX_PACKAGES_PER_RUN) {
                break;
              }
            } else {
              console.log(`Skipping already discovered package: ${fullPackageId}`);
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

      // Save both the sequence state and the new discovered packages
      await this.saveDiscoveryState();
      await this.appendNewDiscoveredPackages(newDiscoveredPackages);

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


  private parsePackageId(packageId: string): { name: string | null; version: string | null } {
    // Handle scoped packages (e.g., @scope/package@1.0.0)
    if (packageId.startsWith('@')) {
      const parts = packageId.split('@');
      if (parts.length >= 3) {
        // @scope/package@version
        const name = `@${parts[1]}`;
        const version = parts[2];
        return { name, version };
      } else if (parts.length === 2) {
        // @scope/package (no version)
        return { name: `@${parts[1]}`, version: null };
      }
    } else {
      // Regular packages (e.g., package@1.0.0)
      const lastAtIndex = packageId.lastIndexOf('@');
      if (lastAtIndex > 0) {
        const name = packageId.substring(0, lastAtIndex);
        const version = packageId.substring(lastAtIndex + 1);
        return { name, version };
      } else if (lastAtIndex === -1) {
        // No version specified
        return { name: packageId, version: null };
      }
    }

    return { name: null, version: null };
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
        publishedAt: data.time?.[data.version] || new Date().toISOString(),
        publisher: data._npmUser?.name || data.maintainers?.[0]?.name,
        description: data.description,
        repository: data.repository?.url,
        dependencies: data.dependencies || {},
        devDependencies: data.devDependencies || {}
      };
    } catch (error: any) {
      if (error.response?.status === 404) {
        console.log(`Package not available: ${packageName}`);
      } else {
        console.error(`Error fetching package info for ${packageName}:`, error);
      }
      return null;
    }
  }

  async getPendingScans(): Promise<PackageInfo[]> {
    await this.loadDiscoveryState();
    const scannedPackages = await this.loadScanningState();

    const packages: PackageInfo[] = [];
    const pendingPackages = new Set([...this.state.discoveredPackages].filter(pkg => !scannedPackages.has(pkg)));

    console.log(`Found ${pendingPackages.size} packages pending scan`);

    for (const packageId of pendingPackages) {
      // Parse package name and version from packageId
      const { name, version } = this.parsePackageId(packageId);

      if (!name || !version || version === 'undefined') {
        console.warn(`Skipping malformed package ID: ${packageId}`);
        continue;
      }

      // Create package info with the exact version from discovered packages
      const packageInfo: PackageInfo = {
        name,
        version,
        publishedAt: new Date().toISOString(), // We don't have this info from the text file
        publisher: undefined,
        description: undefined,
        repository: undefined,
        dependencies: {},
        devDependencies: {}
      };

      packages.push(packageInfo);
      if (packages.length >= MAX_PACKAGES_PER_RUN) {
        break;
      }
    }

    return packages;
  }

  async markPackagesScanned(packages: PackageInfo[]): Promise<void> {
    const newPackages: string[] = [];

    for (const pkg of packages) {
      const fullPackageId = `${pkg.name}@${pkg.version}`;
      newPackages.push(fullPackageId);
    }

    // Only append if we have new packages
    if (newPackages.length > 0) {
      await this.appendNewScannedPackages(newPackages);
    }
  }

  async appendNewScannedPackages(packages: string[]): Promise<void> {
    await fs.mkdir(path.dirname(SCANNED_PACKAGES_NEW_FILE), { recursive: true });
    const content = packages.join('\n') + '\n';
    await fs.writeFile(SCANNED_PACKAGES_NEW_FILE, content);
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