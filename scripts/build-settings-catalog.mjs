// Generates server/settings-catalog.ts from the vendored official schemas.
// Run: npm run build:catalog
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SECRET_KEY = /(key|token|secret|password|passwd|credential|auth|cookie)/i;

// Keys that only take effect from organization-managed settings. They stay visible so they can
// be inspected and copied, but the UI must warn that writing them to a user file is a no-op.
const MANAGED_ONLY = new Set([
  'allowAllClaudeAiMcps', 'allowClaudeInChromeWithManagedMcp', 'allowedChannelPlugins', 'allowedProviders',
  'allowManagedHooksOnly', 'allowManagedMcpServersOnly', 'allowManagedPermissionRulesOnly', 'availableModelsMatch',
  'blockedMarketplaces', 'browserExternalPageTools', 'channelsEnabled', 'claudeMd', 'deniedModels',
  'disableBrowserExternalNavigation', 'disableCommandPluginSources', 'disableDesktopLocalSessions',
  'disableMobileSimulatorTools', 'disableSideloadFlags', 'forceRemoteSettingsRefresh', 'gatewayInternalNetworks',
  'managedMcpServers', 'managedSourcesBehavior', 'modelPricing', 'parentSettingsBehavior',
  'pluginSuggestionMarketplaces', 'pluginTrustMessage', 'policyHelper', 'requiredMaximumVersion',
  'requiredMinimumVersion', 'sandbox.bwrapPath', 'sandbox.socatPath', 'sshHostAllowlist',
  'strictKnownMarketplaces', 'strictPluginOnlyCustomization', 'wslInheritsWindowsSettings',
]);

// Keys that execute a command as the user when the agent runs.
const EXECUTABLE = new Set([
  'hooks', 'statusLine', 'subagentStatusLine', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport',
  'gcpAuthRefresh', 'otelHeadersHelper', 'fileSuggestion', 'processWrapper',
]);

const CLAUDE_GROUPS = {
  模型与推理: [
    'model', 'availableModels', 'fallbackModel', 'modelOverrides', 'effortLevel', 'alwaysThinkingEnabled',
    'showThinkingSummaries', 'advisorModel', 'fastMode', 'fastModePerSessionOptIn', 'outputStyle', 'language',
    'ultracode', 'enforceAvailableModels', 'switchModelsOnFlag', 'modelPicker', 'modelSettings',
    'promptCacheTtl', 'subagentPromptCacheTtl', 'autoCompactEnabled', 'autoCompactWindow', 'idleCompaction',
  ],
  权限与安全: [
    'permissions', 'sandbox', 'hooks', 'disableAllHooks', 'disableAutoMode', 'autoMode',
    'skipAutoPermissionPrompt', 'skipDangerousModePermissionPrompt', 'useAutoModeDuringPlan', 'disableSideloadFlags',
  ],
  环境与上下文: [
    'env', 'autoMemoryEnabled', 'autoMemoryDirectory', 'claudeMdExcludes', 'plansDirectory', 'respectGitignore',
    'fileCheckpointingEnabled', 'cleanupPeriodDays', 'skillListingBudgetFraction', 'skillListingMaxDescChars',
  ],
  界面与交互: [
    'theme', 'editorMode', 'tui', 'viewMode', 'verbose', 'statusLine', 'subagentStatusLine', 'spinnerTipsEnabled',
    'spinnerTipsOverride', 'spinnerVerbs', 'terminalProgressBarEnabled', 'showTurnDuration', 'prefersReducedMotion',
    'autoScrollEnabled', 'syntaxHighlightingDisabled', 'emojiCompletionEnabled', 'showClearContextOnPlanAccept',
    'wheelScrollAccelerationEnabled', 'defaultShell', 'maxProseWidth', 'askUserQuestionTimeout', 'voice',
    'voiceEnabled', 'axScreenReader', 'vimInsertModeRemaps', 'companyAnnouncements', 'fileSuggestion',
    'footerLinksRegexes', 'respondToBashCommands',
  ],
  提示词与技能: [
    'agent', 'claudeMd', 'disableBundledSkills', 'disableSkillShellExecution', 'skillOverrides',
  ],
  'Git 与署名': ['includeCoAuthoredBy', 'includeGitInstructions', 'attribution', 'prUrlTemplate'],
  插件与市场: [
    'enabledPlugins', 'extraKnownMarketplaces', 'strictKnownMarketplaces', 'skippedMarketplaces', 'skippedPlugins',
    'pluginConfigs', 'pluginSuggestionMarketplaces', 'blockedMarketplaces', 'allowedChannelPlugins', 'channelsEnabled',
    'pluginTrustMessage', 'syncClaudeAiPlugins', 'syncClaudeAiSkills', 'appendPlugins', 'prependPlugins',
    'strictPluginOnlyCustomization',
  ],
  MCP: [
    'enableAllProjectMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'allowedMcpServers',
    'deniedMcpServers', 'disableClaudeAiConnectors', 'allowAllClaudeAiMcps', 'allowManagedMcpServersOnly',
    'managedMcpServers',
  ],
  网络与认证: [
    'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'gcpAuthRefresh', 'otelHeadersHelper',
    'forceLoginMethod', 'forceLoginOrgUUID', 'forceLoginGatewayUrl', 'allowedHttpHookUrls', 'httpHookAllowedEnvVars',
    'skipWebFetchPreflight', 'disableDeepLinkRegistration',
  ],
  通知与远程: [
    'preferredNotifChannel', 'inputNeededNotifEnabled', 'agentPushNotifEnabled', 'awaySummaryEnabled',
    'autoContinueAtUsageLimit', 'remoteControlAtStartup', 'disableRemoteControl', 'teammateMode', 'disableAgentView',
    'crossSessionInbound', 'isolatePeerMachines',
  ],
  工作流与代理: [
    'enableWorkflows', 'disableWorkflows', 'workflowKeywordTriggerEnabled', 'workflowSizeGuideline', 'worktree',
    'processWrapper', 'sshConfigs', 'sshHostCommands', 'sshHostAllowlist', 'browserExternalPageTools',
    'disableBrowserExternalNavigation', 'disableMobileSimulatorTools', 'autoConnectIde', 'autoInstallIdeExtension',
    'diffTool', 'externalEditorContext', 'permissionExplainerEnabled', 'teammateDefaultModel',
  ],
  更新与隐私: [
    'autoUpdatesChannel', 'minimumVersion', 'requiredMinimumVersion', 'requiredMaximumVersion', 'feedbackSurveyRate',
    'feedbackDrafts', 'desktopSessionCleanupPeriodDays', 'disableArtifact', 'enableArtifact',
  ],
  企业托管: [
    'parentSettingsBehavior', 'policyHelper', 'forceRemoteSettingsRefresh', 'wslInheritsWindowsSettings',
    'allowManagedHooksOnly', 'allowManagedPermissionRulesOnly', 'requireCoworkFullVmSandbox',
  ],
};

const CODEX_GROUPS = {
  模型与推理: [
    'model', 'review_model', 'model_provider', 'model_providers', 'model_reasoning_effort',
    'plan_mode_reasoning_effort', 'model_reasoning_summary', 'model_verbosity', 'model_context_window',
    'model_auto_compact_token_limit', 'model_auto_compact_token_limit_scope', 'model_instructions_file',
    'model_catalog_json', 'personality', 'hide_agent_reasoning', 'show_raw_agent_reasoning', 'service_tier',
    'responses_api_metadata', 'openai_base_url', 'chatgpt_base_url', 'oss_provider', 'profile',
  ],
  审批与沙箱: [
    'approval_policy', 'approvals_reviewer', 'sandbox_mode', 'sandbox_workspace_write', 'permissions',
    'default_permissions', 'auto_review', 'allow_login_shell', 'allow_symlinked_codex_home',
  ],
  工具与网络: [
    'tools', 'web_search', 'browser_use', 'computer_use', 'apps', 'apps_mcp_product_sku', 'plugins', 'skills',
    'features', 'orchestrator', 'goals', 'marketplaces', 'tool_suggest', 'tool_output_token_limit', 'agents', 'hooks',
  ],
  MCP: [
    'mcp_servers', 'mcp_oauth_callback_port', 'mcp_oauth_callback_url', 'mcp_oauth_credentials_store',
    'mcp_enterprise_managed_auth', 'mcp_optional_startup_grace_ms',
  ],
  上下文与历史: [
    'history', 'memories', 'project_doc_max_bytes', 'project_doc_fallback_filenames', 'project_root_markers',
    'compact_prompt', 'experimental_compact_prompt_file', 'experimental_thread_store', 'sqlite_home',
    'thread_unload_delay_secs', 'instructions', 'developer_instructions', 'include_apps_instructions',
    'include_collaboration_mode_instructions', 'include_environment_context', 'include_environment_context_time',
    'include_permissions_instructions', 'background_terminal_max_timeout', 'ghost_snapshot',
  ],
  界面与通知: [
    'tui', 'notify', 'notice', 'file_opener', 'disable_paste_burst', 'feedback', 'analytics',
    'check_for_update_on_startup', 'suppress_unstable_features_warning', 'windows', 'desktop', 'daybreak', 'log_dir',
  ],
  项目与信任: ['projects'],
  Profiles: ['profiles'],
  'Shell 环境': ['shell_environment_policy'],
  实验与高级: [
    'realtime', 'audio', 'cloud', 'app', 'apps_mcp_product_sku', 'experimental_realtime_start_instructions',
    'experimental_realtime_webrtc_call_base_url', 'experimental_realtime_ws_backend_prompt',
    'experimental_realtime_ws_base_url', 'experimental_realtime_ws_model', 'experimental_realtime_ws_startup_context',
    'experimental_use_unified_exec_tool',
  ],
};

const PI_GROUPS = {
  模型与思考: [
    'defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'modelThinkingLevels', 'thinkingBudgets',
    'enabledModels', 'hideThinkingBlock', 'showCacheMissNotices', 'cacheWarming',
  ],
  交互: [
    'steeringMode', 'followUpMode', 'externalEditor', 'doubleEscapeAction', 'treeFilterMode', 'defaultProjectTrust',
    'queueMode',
  ],
  工具: ['defaultTools', 'codemode'],
  会话与上下文: ['sessionDir', 'sessionShareDestination', 'compaction', 'branchSummary'],
  终端与显示: [
    'theme', 'quietStartup', 'tuiMode', 'fullscreenExitOutput', 'fullscreenScrollbar', 'fullscreenCopyOnSelect',
    'fullscreenWheelScrollLines', 'editorPaddingX', 'outputPad', 'autocompleteMaxVisible', 'showHardwareCursor',
    'terminal', 'images', 'markdown',
  ],
  网络与重试: [
    'transport', 'httpProxy', 'httpIdleTimeoutMs', 'websocketConnectTimeoutMs', 'retry', 'websockets',
  ],
  Shell: ['shellPath', 'shellCommandPrefix', 'npmCommand'],
  资源与包: ['packages', 'extensions', 'skills', 'prompts', 'themes', 'enableSkillCommands'],
  更新与遥测: ['collapseChangelog', 'enableInstallTelemetry', 'enableAnalytics', 'warnings'],
};

const AGENTS = [
  {
    key: 'claude',
    label: 'Claude Code',
    schema: 'schemas/claude-settings.json',
    schemaUrl: 'https://json.schemastore.org/claude-code-settings.json',
    groups: CLAUDE_GROUPS,
    common: ['model', 'effortLevel', 'permissions', 'env', 'theme', 'statusLine', 'enabledPlugins', 'sandbox', 'autoUpdatesChannel'],
    exclude: ['$schema', 'autoConnectIde', 'autoInstallIdeExtension', 'diffTool', 'externalEditorContext', 'permissionExplainerEnabled', 'teammateDefaultModel', 'copyFullResponse', 'copyOnSelect', 'defaultToAgentsView', 'leftArrowOpensAgents', 'prStatusFooterEnabled', 'claudeInChromeDefaultEnabled'],
    jsonKeys: ['hooks', 'statusLine', 'subagentStatusLine', 'fileSuggestion', 'spinnerTipsOverride', 'spinnerVerbs', 'voice', 'vimInsertModeRemaps', 'footerLinksRegexes', 'sshConfigs', 'sshHostCommands', 'worktree', 'policyHelper', 'processWrapper', 'pluginConfigs', 'strictPluginOnlyCustomization', 'autoMode', 'attribution', 'sandbox'],
  },
  {
    key: 'codex',
    label: 'Codex',
    schema: 'schemas/codex-config.json',
    schemaUrl: 'https://raw.githubusercontent.com/openai/codex/main/codex-rs/core/config.schema.json',
    groups: CODEX_GROUPS,
    common: ['model', 'model_provider', 'model_reasoning_effort', 'approval_policy', 'sandbox_mode', 'web_search', 'model_context_window', 'notify', 'history', 'tui', 'shell_environment_policy', 'features', 'personality'],
    exclude: [],
    jsonKeys: [
      'mcp_servers', 'model_providers', 'profiles', 'projects', 'tools', 'features', 'apps', 'desktop', 'windows',
      'memories', 'marketplaces', 'plugins', 'goals', 'agents', 'orchestrator', 'realtime', 'audio', 'cloud',
      'computer_use', 'browser_use', 'hooks', 'notify', 'history', 'tui', 'shell_environment_policy',
      'sandbox_workspace_write', 'permissions', 'permissions', 'otel', 'analytics', 'feedback', 'notice', 'statsig',
      'skills',
    ],
    hiddenMcp: true,
  },
  {
    key: 'pi',
    label: 'pi',
    schema: 'schemas/pi-settings.json',
    schemaUrl: 'https://pi.dev/schemas/settings.schema.json',
    groups: PI_GROUPS,
    common: ['defaultProvider', 'defaultModel', 'defaultThinkingLevel', 'theme', 'compaction', 'retry', 'shellPath', 'tuiMode', 'defaultTools'],
    exclude: ['$schema', 'lastChangelogVersion', 'trackingId', 'deviceId'],
    jsonKeys: ['packages', 'extensions', 'skills', 'prompts', 'themes'],
  },
];

function resolveRef(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported $ref ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    node = node?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (!node) throw new Error(`unresolved $ref ${ref}`);
  return node;
}

function nodeType(node) {
  if (!node || typeof node !== 'object') return 'json';
  if (node.$ref) {
    const target = resolveRef(node.__root, node.$ref);
    target.__root = node.__root;
    return nodeType(target);
  }
  if (node.const !== undefined) return typeof node.const === 'boolean' ? 'boolean' : 'string';
  if (Array.isArray(node.enum)) {
    const types = new Set(node.enum.map((value) => typeof value));
    return types.size === 1 ? [...types][0] : 'json';
  }
  const raw = Array.isArray(node.type) ? node.type.filter((type) => type !== 'null') : node.type;
  if (Array.isArray(raw)) return raw.length === 1 ? raw[0] : 'json';
  if (raw) return raw;
  if (node.anyOf || node.oneOf) {
    const variants = (node.anyOf ?? node.oneOf).filter((variant) => !(variant && variant.not));
    if (variants.length === 1) return nodeType(variants[0]);
    const types = new Set(variants.map((variant) => nodeType(variant)));
    return types.size === 1 ? [...types][0] : 'json';
  }
  if (node.properties || node.additionalProperties) return 'object';
  if (node.items) return 'array';
  return 'json';
}

function constValues(node) {
  const values = [];
  if (node.const !== undefined) values.push(node.const);
  if (Array.isArray(node.enum)) values.push(...node.enum);
  for (const variant of node.anyOf ?? node.oneOf ?? []) {
    if (Array.isArray(variant.enum)) values.push(...variant.enum);
    if (variant.const !== undefined) values.push(variant.const);
  }
  return [...new Set(values)];
}

function simplify(node, root, depth, key, forceJson, path = key) {
  const field = { key, path, type: 'json' };
  if (!node || typeof node !== 'object') return field;

  if (node.$ref) {
    const target = resolveRef(root, node.$ref);
    target.__root = root;
    const simplified = simplify(target, root, depth, key, forceJson, path);
    for (const meta of ['description', 'deprecated', 'default']) {
      if (node[meta] !== undefined) simplified[meta] = node[meta];
    }
    return simplified;
  }

  if (node.allOf?.length === 1 && node.allOf[0].$ref) return simplify({ ...node.allOf[0], description: node.description ?? node.allOf[0].description }, root, depth, key, forceJson, path);

  const inferred = forceJson ? 'json' : nodeType(node);
  const values = constValues(node);

  if (inferred === 'boolean') {
    field.type = 'boolean';
  } else if (inferred === 'integer' || inferred === 'number') {
    field.type = inferred;
    if (typeof node.minimum === 'number') field.minimum = node.minimum;
    if (typeof node.maximum === 'number') field.maximum = node.maximum;
  } else if (inferred === 'string') {
    field.type = 'string';
    const variants = node.anyOf ?? node.oneOf ?? [node];
    const allEnum = variants.every((variant) => Array.isArray(variant.enum) || variant.const !== undefined);
    if (values.length > 0 && allEnum) field.enum = values;
    else if (values.length > 0) field.suggestions = values;
    if (typeof node.pattern === 'string' && !field.enum) field.pattern = node.pattern;
  } else if (inferred === 'array') {
    const item = { ...(node.items ?? {}), __root: root };
    const itemType = nodeType(item);
    if (itemType === 'string' || itemType === 'number' || itemType === 'integer' || itemType === 'boolean') {
      field.type = 'array';
      field.items = { key: 'item', type: itemType };
      if (Array.isArray(item.enum)) field.items.enum = item.enum;
    } else {
      field.type = 'json';
    }
  } else if (inferred === 'object') {
    const properties = node.properties && typeof node.properties === 'object' ? node.properties : null;
    const additional = node.additionalProperties;
    const propCount = properties ? Object.keys(properties).length : 0;
    const mapLike = Boolean(additional) && (propCount === 0 || propCount > 40 || key === 'env');
    if (mapLike) {
      field.type = 'object';
      field.map = true;
      const valueNode = additional === true ? {} : { ...additional, __root: root };
      const valueType = nodeType(valueNode);
      field.mapValue = { key: 'value', path: `${path}.*`, type: ['string', 'number', 'integer', 'boolean'].includes(valueType) ? valueType : 'json' };
      const valueEnum = constValues(valueNode);
      if (valueEnum.length > 0) field.mapValue.enum = valueEnum;
      if (properties && propCount > 0) {
        field.knownKeys = Object.entries(properties)
          .slice(0, 120)
          .map(([knownKey, knownNode]) => ({
            key: knownKey,
            ...(knownNode?.description ? { description: String(knownNode.description).replace(/\s+/g, ' ').slice(0, 300) } : {}),
          }));
      }
    } else if (properties && depth < 2 && propCount <= 40 && !forceJson) {
      field.type = 'object';
      field.fields = Object.entries(properties).map(([childKey, childNode]) => {
        childNode.__root = root;
        return simplify(childNode, root, depth + 1, childKey, false, `${path}.${childKey}`);
      });
      if (additional && additional !== true) {
        field.map = true;
        const valueNode = { ...additional, __root: root };
        const valueType = nodeType(valueNode);
        field.mapValue = { key: 'value', path: `${path}.*`, type: ['string', 'number', 'integer', 'boolean'].includes(valueType) ? valueType : 'json' };
        field.additionalLabel = '其他键';
      }
      if (propCount > 12) field.long = true;
    } else if (!properties) {
      field.type = 'object';
      field.map = true;
      field.mapValue = { key: 'value', path: `${path}.*`, type: 'string' };
    } else {
      field.type = 'json';
    }
  }

  if (node.description && typeof node.description === 'string') {
    field.description = node.description.replace(/\s+/g, ' ').trim().slice(0, 600);
  }
  if (node.default !== undefined && !field.enum) field.default = node.default;
  if (node.deprecated) field.deprecated = true;
  if (SECRET_KEY.test(key)) field.sensitive = true;
  return field;
}

function buildAgent(spec) {
  const root = JSON.parse(readFileSync(join(ROOT, spec.schema), 'utf8'));
  const zhPath = join(ROOT, 'schemas', 'descriptions.zh.json');
  const zh = existsSync(zhPath) ? JSON.parse(readFileSync(zhPath, 'utf8')) : {};
  const applyChinese = (field) => {
    const translated = zh[`${spec.key}:${field.path}`];
    if (typeof translated === 'string' && translated.length > 0) field.description = translated;
    for (const child of field.fields ?? []) applyChinese(child);
    if (field.mapValue) {
      const mapTranslated = zh[`${spec.key}:${field.path}.*`];
      if (typeof mapTranslated === 'string' && mapTranslated.length > 0) field.mapValue.description = mapTranslated;
    }
  };
  const properties = root.properties ?? {};
  const exclude = new Set(spec.exclude ?? []);
  const jsonKeys = new Set(spec.jsonKeys ?? []);
  const groupFor = new Map();
  for (const [group, keys] of Object.entries(spec.groups)) {
    for (const key of keys) groupFor.set(key, group);
  }

  const fields = [];
  for (const [key, rawNode] of Object.entries(properties)) {
    if (exclude.has(key)) continue;
    const node = { ...rawNode, __root: root };
    const forceJson = jsonKeys.has(key);
    const field = simplify(node, root, 0, key, forceJson);
    field.group = groupFor.get(key) ?? '其他';
    if (MANAGED_ONLY.has(key)) field.managedOnly = true;
    if (EXECUTABLE.has(key)) field.executable = true;
    if (spec.key === 'codex' && key === 'mcp_servers') field.hidden = true;
    applyChinese(field);
    fields.push(field);
  }

  const groupOrder = [...Object.keys(spec.groups), '其他'];
  const sections = [];
  for (const group of groupOrder) {
    const groupFields = fields.filter((field) => field.group === group && !field.hidden);
    if (groupFields.length === 0) continue;
    sections.push({ key: group, label: group, fields: groupFields });
  }

  return {
    key: spec.key,
    label: spec.label,
    schemaUrl: spec.schemaUrl,
    common: spec.common.filter((key) => fields.some((field) => field.key === key && !field.hidden)),
    sections,
    mcp: spec.key === 'claude' ? { fileId: 'claude-mcp', key: 'mcpServers' } : spec.key === 'pi' ? { fileId: 'pi-mcp', key: 'mcpServers' } : { fileId: 'codex-config', key: 'mcp_servers' },
  };
}

const catalog = { agents: AGENTS.map(buildAgent) };

let zhCovered = 0;
let zhMissing = 0;
for (const agent of catalog.agents) {
  const walk = (field) => {
    if (field.description) {
      if (/[一-鿿]/.test(field.description)) zhCovered += 1;
      else zhMissing += 1;
    }
    for (const child of field.fields ?? []) walk(child);
  };
  for (const section of agent.sections) for (const field of section.fields) walk(field);
}

const out = join(ROOT, 'server', 'settings-catalog.ts');
writeFileSync(
  out,
  `// Generated by scripts/build-settings-catalog.mjs from the vendored schemas in schemas/.\n` +
    `// Do not edit by hand; run \`npm run build:catalog\` after updating a schema.\n` +
    `import type { SettingsCatalog } from '../shared/types.ts';\n\n` +
    `export const SETTINGS_CATALOG: SettingsCatalog = ${JSON.stringify(catalog, null, 2)};\n`,
);
const bytes = readFileSync(out).length;
const counts = catalog.agents.map((agent) => `${agent.key}:${agent.sections.reduce((sum, section) => sum + section.fields.length, 0)}`).join(' ');
console.log(
  `[build-catalog] ${out} (${Math.round(bytes / 1024)} KB, ${counts}; 中文描述 ${zhCovered} 条，未翻译 ${zhMissing} 条)`,
);
