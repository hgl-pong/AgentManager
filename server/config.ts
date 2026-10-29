import { readFileSync, statSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';

import type {
  ConfigFileReport,
  ConfigFileSpec,
  ConfigKey,
  ConfigReport,
  McpCell,
  McpRow,
} from '../shared/types.ts';

export type {
  ConfigFileReport,
  ConfigFileSpec,
  ConfigFormat,
  ConfigKey,
  ConfigReport,
  McpCell,
  McpRow,
} from '../shared/types.ts';

const SECRET_KEY = /(key|token|secret|password|auth)/i;
const SECRET_FLAG = /^--?(?:api[-_]?key|token|secret|password|auth|access[-_]?token|bearer)$/i;
const TOKEN_PREFIX = /^(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|glpat|xox[baprs]|AKIA)[-_A-Za-z0-9]{6,}$/;

/** Values that look like minted credentials rather than paths or words. */
function looksLikeToken(value: string): boolean {
  if (TOKEN_PREFIX.test(value)) return true;
  return (
    value.length >= 24 &&
    /^[A-Za-z0-9_.=+-]+$/.test(value) &&
    /[0-9]/.test(value) &&
    /[A-Za-z]/.test(value)
  );
}

function summarize(value: unknown, key: string): string {
  if (typeof value === 'string') {
    if (SECRET_KEY.test(key)) return '••••••';
    return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length} 项]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).length} 个键}`;
  return String(value);
}

/** Drops the user:password part a server URL may embed. */
function summarizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^/@\s]*@/, '//');
  }
}

/** Masks credential flags (`--api-key secret`, `--token=x`) and token-shaped arguments. */
function summarizeArguments(args: string[]): string[] {
  const masked: string[] = [];
  let redactNext = false;
  for (const argument of args) {
    if (redactNext) {
      masked.push('••••••');
      redactNext = false;
      continue;
    }
    const separator = argument.indexOf('=');
    if (argument.startsWith('-') && separator > 0) {
      const flag = argument.slice(0, separator);
      if (SECRET_FLAG.test(flag)) {
        masked.push(`${flag}=••••••`);
        continue;
      }
    }
    if (SECRET_FLAG.test(argument)) {
      masked.push(argument);
      redactNext = true;
      continue;
    }
    masked.push(looksLikeToken(argument) ? '••••••' : argument);
  }
  return masked;
}

function summarizeServer(server: unknown): string {
  if (!server || typeof server !== 'object') return String(server);
  const record = server as Record<string, unknown>;
  if (typeof record.url === 'string') return summarizeUrl(record.url);
  const command = typeof record.command === 'string' ? record.command : '';
  const args = Array.isArray(record.args) ? record.args.map(String) : [];
  return [command, ...summarizeArguments(args)].filter(Boolean).join(' ');
}

function readConfigFile(spec: ConfigFileSpec): { data?: Record<string, unknown>; report: ConfigFileReport } {
  const base: ConfigFileReport = { ...spec, exists: false, keys: [], mcpKeys: [] };

  let text: string;
  try {
    const stat = statSync(spec.path);
    base.exists = true;
    base.bytes = stat.size;
    text = readFileSync(spec.path, 'utf8');
  } catch (error) {
    // Only a genuinely absent file is "not exists"; every other failure must surface as an error.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      base.error = error instanceof Error ? error.message : String(error);
    }
    return { report: base };
  }

  try {
    const data = (spec.format === 'toml' ? parseToml(text) : JSON.parse(text)) as Record<string, unknown>;
    const mcp = (data.mcpServers ?? data.mcp_servers) as Record<string, unknown> | undefined;
    base.keys = spec.listKeys === false ? [] : Object.entries(data).map(([key, value]) => ({ key, preview: summarize(value, key) }));
    base.mcpKeys = mcp && typeof mcp === 'object' ? Object.keys(mcp) : [];
    return { data, report: base };
  } catch (error) {
    base.error = error instanceof Error ? error.message : String(error);
    return { report: base };
  }
}

/** Reads every agent config file and builds the MCP matrix. Read-only by construction. */
export function scanConfig(files: ConfigFileSpec[]): ConfigReport {
  const reports: ConfigFileReport[] = [];
  const servers = new Map<string, McpRow>();

  for (const spec of files) {
    const { data, report } = readConfigFile(spec);
    reports.push(report);

    const mcp = (data?.mcpServers ?? data?.mcp_servers) as Record<string, unknown> | undefined;
    if (!mcp || typeof mcp !== 'object') continue;

    for (const [name, server] of Object.entries(mcp)) {
      const row = servers.get(name) ?? { name, byAgent: {} as Record<string, McpCell[]> };
      (row.byAgent[spec.agent] ??= []).push({ file: spec.path, summary: summarizeServer(server) });
      servers.set(name, row);
    }
  }

  return {
    files: reports,
    servers: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}
