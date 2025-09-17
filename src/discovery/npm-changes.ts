import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ChangesFeedEntry, PackageInfo, StateData } from '../types';

const CHANGES_FEED_URL = 'https://replicate.npmjs.com/registry/_changes';
const STATE_FILE = path.join(process.cwd(), 'data', 'state.json');
const BATCH_SIZE = 100;
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
      let currentSequence = this.state.lastSequence;
      let hasMore = true;

      while (hasMore && packagesToProcess.size < MAX_PACKAGES_PER_RUN) {
        const response = await axios.get(CHANGES_FEED_URL, {
          params: {
            since: currentSequence,
            limit: BATCH_SIZE,
            include_docs: false
          },
          headers: {
            'npm-replication-opt-in': 'true'
          },
          timeout: 30000
        });

        const results = response.data.results as ChangesFeedEntry[];

        if (results.length === 0) {
          hasMore = false;
          break;
        }

        for (const change of results) {
          if (!change.deleted && change.id && !change.id.startsWith('_design/')) {
            const packageId = `${change.id}@latest`;

            if (!this.state.processedPackages.has(packageId)) {
              const packageInfo = await this.fetchPackageInfo(change.id);
              if (packageInfo) {
                packagesToProcess.set(packageId, packageInfo);
                this.state.processedPackages.add(packageId);

                if (packagesToProcess.size >= MAX_PACKAGES_PER_RUN) {
                  hasMore = false;
                  break;
                }
              }
            }
          }
          currentSequence = change.seq;
        }

        this.state.lastSequence = currentSequence;

        if (results.length < BATCH_SIZE) {
          hasMore = false;
        }
      }

      packages.push(...packagesToProcess.values());
      this.state.lastProcessed = new Date().toISOString();
      await this.saveState();

    } catch (error) {
      console.error('Error fetching changes feed:', error);
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
      const response = await axios.get(CHANGES_FEED_URL, {
        params: {
          since: this.state.lastSequence,
          limit: 1000,
          include_docs: false
        },
        headers: {
          'npm-replication-opt-in': 'true'
        },
        timeout: 30000
      });

      const results = response.data.results as ChangesFeedEntry[];
      const packageNames = new Set<string>();

      for (const change of results) {
        if (!change.deleted && change.id && !change.id.startsWith('_design/')) {
          packageNames.add(change.id);
        }
        this.state.lastSequence = Math.max(this.state.lastSequence, change.seq);
      }

      for (const packageName of packageNames) {
        const packageInfo = await this.fetchPackageInfo(packageName);
        if (packageInfo && packageInfo.publishedAt) {
          const publishedDate = new Date(packageInfo.publishedAt);
          if (publishedDate >= cutoffTime) {
            const packageId = `${packageInfo.name}@${packageInfo.version}`;
            if (!this.state.processedPackages.has(packageId)) {
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