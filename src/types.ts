export interface PackageInfo {
  name: string;
  version: string;
  publishedAt?: string;
  publisher?: string;
  description?: string;
  repository?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface ScanResult {
  package: PackageInfo;
  timestamp: string;
  vulnerabilities: VulnerabilityResult[];
  codeIssues: CodeIssue[];
  secrets: SecretFinding[];
  metadataIssues: MetadataIssue[];
  riskScore: RiskScore;
}

export interface VulnerabilityResult {
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  cve?: string;
  title: string;
  description: string;
  fixedVersion?: string;
  affectedPackage: string;
}

export interface CodeIssue {
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  rule: string;
  message: string;
  file: string;
  line?: number;
  pattern?: string;
}

export interface SecretFinding {
  type: string;
  file: string;
  line?: number;
  match: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
}

export interface MetadataIssue {
  type: string;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  message: string;
}

export interface RiskScore {
  overall: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  vulnerabilities: number;
  codeIssues: number;
  secrets: number;
  metadataIssues: number;
}

export interface ChangesFeedEntry {
  seq: number;
  id: string;
  changes: Array<{ rev: string }>;
  deleted?: boolean;
}

export interface StateData {
  lastSequence: number;
  lastDiscovered: string;
  lastScanned: string;
  discoveredPackages: Set<string>;
  scannedPackages: Set<string>;
}