import * as fs from 'fs/promises';
import * as path from 'path';
import * as tar from 'tar';
import * as crypto from 'crypto';
import axios from 'axios';
import { spawn } from 'child_process';
import { PackageInfo } from '../types';

export class SafePackageHandler {
  private tempDir: string;

  constructor() {
    this.tempDir = path.join(process.cwd(), 'temp', crypto.randomBytes(8).toString('hex'));
  }

  async downloadPackage(packageInfo: PackageInfo): Promise<string> {
    const tarballUrl = `https://registry.npmjs.org/${packageInfo.name}/-/${packageInfo.name}-${packageInfo.version}.tgz`;
    const tarballPath = path.join(this.tempDir, `${packageInfo.name}-${packageInfo.version}.tgz`);

    await fs.mkdir(this.tempDir, { recursive: true });

    try {
      const response = await axios.get(tarballUrl, {
        responseType: 'arraybuffer',
        timeout: 60000,
        maxContentLength: 100 * 1024 * 1024,
        headers: {
          'User-Agent': 'npm-security-scanner/1.0'
        }
      });

      await fs.writeFile(tarballPath, Buffer.from(response.data));
      return tarballPath;
    } catch (error) {
      throw new Error(`Failed to download package ${packageInfo.name}@${packageInfo.version}: ${error}`);
    }
  }

  async extractPackage(tarballPath: string): Promise<string> {
    const extractDir = path.join(this.tempDir, 'extracted');
    await fs.mkdir(extractDir, { recursive: true });

    try {
      await tar.extract({
        file: tarballPath,
        cwd: extractDir,
        strip: 1,
        filter: (path) => {
          const forbidden = [
            '.git',
            'node_modules',
            '.env',
            '.npmrc',
            '*.exe',
            '*.dll',
            '*.so',
            '*.dylib'
          ];
          return !forbidden.some(pattern => path.includes(pattern));
        }
      });

      return extractDir;
    } catch (error) {
      throw new Error(`Failed to extract package: ${error}`);
    }
  }

  async createPackageJson(packageInfo: PackageInfo, extractDir: string): Promise<void> {
    const packageJsonPath = path.join(extractDir, 'package.json');

    try {
      const existingContent = await fs.readFile(packageJsonPath, 'utf-8');
      const parsed = JSON.parse(existingContent);

      if (!parsed.name) parsed.name = packageInfo.name;
      if (!parsed.version) parsed.version = packageInfo.version;

      await fs.writeFile(packageJsonPath, JSON.stringify(parsed, null, 2));
    } catch {
      const minimalPackageJson = {
        name: packageInfo.name,
        version: packageInfo.version,
        dependencies: packageInfo.dependencies || {},
        devDependencies: packageInfo.devDependencies || {}
      };

      await fs.writeFile(packageJsonPath, JSON.stringify(minimalPackageJson, null, 2));
    }
  }

  async cleanup(): Promise<void> {
    try {
      if (this.tempDir && this.tempDir.includes('temp')) {
        // Recursively set permissions to allow deletion
        await this.makeWritable(this.tempDir);
        await fs.rm(this.tempDir, { recursive: true, force: true });
      }
    } catch (error) {
      console.error('Cleanup error:', error);
    }
  }

  private async makeWritable(dir: string): Promise<void> {
    try {
      await fs.chmod(dir, 0o755);
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await this.makeWritable(fullPath);
        } else {
          await fs.chmod(fullPath, 0o644).catch(() => {});
        }
      }
    } catch (error) {
      // Ignore permission errors during cleanup
    }
  }

  async runInSandbox(command: string, args: string[], extractDir: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: extractDir,
        env: {
          PATH: process.env.PATH,
          HOME: '/tmp',
          TMPDIR: this.tempDir
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
        detached: false
      });

      let output = '';
      let error = '';

      child.stdout?.on('data', (data) => {
        output += data.toString();
      });

      child.stderr?.on('data', (data) => {
        error += data.toString();
      });

      child.on('exit', (code) => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(`Command failed with code ${code}: ${error}`));
        }
      });

      child.on('error', reject);
    });
  }

  async scanWithDocker(command: string[], extractDir: string): Promise<string> {
    const dockerArgs = [
      'run',
      '--rm',
      '--network=none',
      '--read-only',
      '--security-opt=no-new-privileges',
      '--cap-drop=ALL',
      '--memory=512m',
      '--cpus=1',
      '-v', `${extractDir}:/scan:ro`,
      '-w', '/scan',
      ...command
    ];

    return this.runInSandbox('docker', dockerArgs, process.cwd());
  }
}