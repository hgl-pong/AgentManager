import { useEffect, useId, useState } from 'react';
import type { JsonObject } from '../lib/settings.ts';
import { useConfirmDialog } from '../lib/confirm.tsx';
import {
  clone,
  isRecord,
  mcpSummary,
  mcpTransport,
  newMcpServer,
  type McpTransport,
} from '../lib/settings.ts';

const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse'];

function transportsFor(agentKey: string): McpTransport[] {
  return agentKey === 'claude' ? TRANSPORTS : ['stdio', 'http'];
}

function headersKey(agentKey: string): string {
  return agentKey === 'codex' ? 'http_headers' : 'headers';
}

function isEmptyPatch(value: unknown): boolean {
  return (
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0) ||
    (isRecord(value) && Object.keys(value).length === 0)
  );
}

function patchServer(
  server: JsonObject,
  changes: Record<string, unknown>,
): JsonObject {
  const next = clone(server);
  for (const [key, value] of Object.entries(changes)) {
    if (isEmptyPatch(value)) delete next[key];
    else next[key] = value;
  }
  return next;
}

export function McpEditor({
  agentKey,
  map,
  errors,
  disabled,
  query = '',
  onChange,
}: {
  agentKey: string;
  map: JsonObject;
  errors: Map<string, string>;
  disabled: boolean;
  query?: string;
  onChange: (map: JsonObject) => void;
}) {
  const entries = Object.entries(map);
  const needle = query.trim().toLowerCase();
  const visibleEntries = needle
    ? entries.filter(([name, server]) =>
        `${name} ${mcpTransport(server)} ${mcpSummary(server)}`.toLowerCase().includes(needle),
      )
    : entries;
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [ask, confirmNode] = useConfirmDialog();

  function updateServer(name: string, next: JsonObject) {
    onChange({ ...map, [name]: next });
  }

  async function removeServer(name: string) {
    const proceed = await ask({
      title: `删除 ${name}`,
      message: '会从当前草稿里移除这个 MCP server，需要点保存全部才会写入配置文件。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!proceed) return;
    const next = { ...map };
    delete next[name];
    if (editing === name) setEditing(null);
    onChange(next);
  }

  const transportOptions = transportsFor(agentKey);

  return (
    <div className="mcp-editor">
      <div className="mcp-toolbar">
        <p className="meta">
          共 {entries.length} 个 server
          {needle !== '' ? `（匹配 ${visibleEntries.length}）` : ''} · 传输方式：
          {transportOptions.join(' / ')}
          {agentKey === 'codex' ? ' · 额外支持 bearer_token_env_var / env_http_headers / enabled' : ''}
        </p>
        <button
          type="button"
          className="primary"
          disabled={disabled || adding}
          onClick={() => setAdding(true)}
        >
          + 新增 server
        </button>
      </div>

      {adding && (
        <NewServerForm
          agentKey={agentKey}
          existing={map}
          disabled={disabled}
          onCancel={() => setAdding(false)}
          onAdd={(name, transport) => {
            onChange({ ...map, [name]: newMcpServer(agentKey, transport) });
            setEditing(name);
            setAdding(false);
          }}
        />
      )}

      {entries.length === 0 ? (
        <p className="muted">还没有配置任何 MCP server。</p>
      ) : visibleEntries.length === 0 ? (
        <p className="muted">没有匹配的 server。</p>
      ) : (
        <ul className="mcp-list">
          {visibleEntries.map(([name, rawServer]) => {
            const server = isRecord(rawServer) ? rawServer : {};
            const transport = mcpTransport(rawServer);
            const error = errors.get(name);
            const enabled = server.enabled === false ? false : undefined;
            return (
              <li key={name} className={`mcp-item${error ? ' has-error' : ''}`}>
                <div className="mcp-head">
                  <div className="mcp-title">
                    <strong>{name}</strong>
                    <span className="tag">{transport}</span>
                    {enabled === false && <span className="tag">已禁用</span>}
                    {!isRecord(rawServer) && <span className="tag tag-sensitive">定义不是对象</span>}
                  </div>
                  <div className="confirm-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={disabled}
                      aria-expanded={editing === name}
                      onClick={() => setEditing(editing === name ? null : name)}
                    >
                      {editing === name ? '收起' : '编辑'}
                    </button>
                    <button
                      type="button"
                      className="danger"
                      disabled={disabled}
                      onClick={() => void removeServer(name)}
                    >
                      删除
                    </button>
                  </div>
                </div>
                <p className="mcp-summary">
                  <code>{mcpSummary(rawServer)}</code>
                </p>
                {error && <p className="field-error">{error}</p>}
                {editing === name && isRecord(rawServer) && (
                  <ServerFields
                    agentKey={agentKey}
                    server={server}
                    disabled={disabled}
                    onChange={(next) => updateServer(name, next)}
                  />
                )}
                {editing === name && !isRecord(rawServer) && (
                  <p className="field-error">这个 server 的定义不是对象，请先在原始文件里修正。</p>
                )}
                {editing === name && isRecord(rawServer) && (
                  <AdvancedJson
                    server={server}
                    disabled={disabled}
                    onApply={(next) => updateServer(name, next)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {confirmNode}
    </div>
  );
}

function NewServerForm({
  agentKey,
  existing,
  disabled,
  onAdd,
  onCancel,
}: {
  agentKey: string;
  existing: JsonObject;
  disabled: boolean;
  onAdd: (name: string, transport: McpTransport) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<McpTransport>('stdio');
  const [error, setError] = useState<string | null>(null);
  const id = useId();

  function submit() {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError('请输入 server 名称');
      return;
    }
    if (trimmed.includes('/') || trimmed.includes('\\')) {
      setError('名称不能包含 / 或 \\');
      return;
    }
    if (Object.hasOwn(existing, trimmed)) {
      setError('同名 server 已存在');
      return;
    }
    onAdd(trimmed, transport);
  }

  return (
    <div className="mcp-add">
      <label htmlFor={`${id}-name`}>名称</label>
      <input
        id={`${id}-name`}
        className="control"
        type="text"
        value={name}
        placeholder="例如 filesystem"
        disabled={disabled}
        onChange={(event) => {
          setName(event.target.value);
          setError(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
      />
      <label htmlFor={`${id}-transport`}>传输</label>
      <select
        id={`${id}-transport`}
        className="control"
        value={transport}
        disabled={disabled}
        onChange={(event) => setTransport(event.target.value as McpTransport)}
      >
        {transportsFor(agentKey).map((entry) => (
          <option key={entry} value={entry}>
            {entry}
          </option>
        ))}
      </select>
      <button type="button" className="primary" disabled={disabled} onClick={submit}>
        添加
      </button>
      <button type="button" className="secondary" disabled={disabled} onClick={onCancel}>
        取消
      </button>
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

function ServerFields({
  agentKey,
  server,
  disabled,
  onChange,
}: {
  agentKey: string;
  server: JsonObject;
  disabled: boolean;
  onChange: (server: JsonObject) => void;
}) {
  const transport = mcpTransport(server);
  const id = useId();
  const headers = headersKey(agentKey);
  const isCodex = agentKey === 'codex';

  function patch(changes: Record<string, unknown>) {
    onChange(patchServer(server, changes));
  }

  function changeTransport(nextTransport: McpTransport) {
    const next = clone(server);
    if (agentKey === 'codex') delete next.type;
    else next.type = nextTransport;
    if (nextTransport === 'stdio') {
      delete next.url;
      if (agentKey === 'codex') {
        delete next.http_headers;
        delete next.env_http_headers;
        delete next.bearer_token_env_var;
        if (typeof next.command !== 'string') next.command = '';
      } else {
        delete next.headers;
      }
    } else {
      delete next.command;
      delete next.args;
      delete next.cwd;
      delete next.env;
      if (agentKey === 'codex' && typeof next.url !== 'string') next.url = '';
    }
    onChange(next);
  }

  const argsText = Array.isArray(server.args)
    ? server.args.filter((item): item is string => typeof item === 'string').join('\n')
    : '';

  return (
    <div className="server-form">
      <div className="form-grid">
        <label className="form-field" htmlFor={`${id}-transport`}>
          <span>传输方式</span>
          <select
            id={`${id}-transport`}
            className="control"
            value={transport}
            disabled={disabled}
            onChange={(event) => changeTransport(event.target.value as McpTransport)}
          >
            {transportsFor(agentKey).map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>

        {transport === 'stdio' ? (
          <>
            <label className="form-field" htmlFor={`${id}-command`}>
              <span>
                command <span className="required">必填</span>
              </span>
              <input
                id={`${id}-command`}
                className="control"
                type="text"
                value={typeof server.command === 'string' ? server.command : ''}
                placeholder="例如 npx"
                disabled={disabled}
                aria-required="true"
                onChange={(event) => patch({ command: event.target.value })}
              />
            </label>
            <label className="form-field form-wide" htmlFor={`${id}-args`}>
              <span>args（每行一个）</span>
              <textarea
                id={`${id}-args`}
                className="control mono-input"
                rows={4}
                value={argsText}
                placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\data'}
                disabled={disabled}
                spellCheck={false}
                onChange={(event) =>
                  patch({
                    args: event.target.value
                      .split(/\r?\n/)
                      .filter((line) => line.trim() !== ''),
                  })
                }
              />
            </label>
            <label className="form-field" htmlFor={`${id}-cwd`}>
              <span>cwd</span>
              <input
                id={`${id}-cwd`}
                className="control"
                type="text"
                value={typeof server.cwd === 'string' ? server.cwd : ''}
                placeholder="留空不写入"
                disabled={disabled}
                onChange={(event) => patch({ cwd: event.target.value })}
              />
            </label>
            <div className="form-wide">
              <StringMapEditor
                label="env"
                value={isRecord(server.env) ? server.env : {}}
                disabled={disabled}
                secretValues
                onChange={(next) => patch({ env: next })}
              />
            </div>
          </>
        ) : (
          <>
            <label className="form-field form-wide" htmlFor={`${id}-url`}>
              <span>
                url <span className="required">必填</span>
              </span>
              <input
                id={`${id}-url`}
                className="control"
                type="text"
                value={typeof server.url === 'string' ? server.url : ''}
                placeholder="https://example.com/mcp"
                disabled={disabled}
                aria-required="true"
                onChange={(event) => patch({ url: event.target.value })}
              />
            </label>
            <div className="form-wide">
              <StringMapEditor
                label={headers}
                value={isRecord(server[headers]) ? (server[headers] as JsonObject) : {}}
                disabled={disabled}
                secretValues
                onChange={(next) => patch({ [headers]: next })}
              />
            </div>
            {isCodex && (
              <>
                <label className="form-field" htmlFor={`${id}-bearer`}>
                  <span>bearer_token_env_var</span>
                  <input
                    id={`${id}-bearer`}
                    className="control"
                    type="text"
                    value={
                      typeof server.bearer_token_env_var === 'string'
                        ? server.bearer_token_env_var
                        : ''
                    }
                    placeholder="例如 MCP_TOKEN"
                    disabled={disabled}
                    onChange={(event) => patch({ bearer_token_env_var: event.target.value })}
                  />
                </label>
                <div className="form-wide">
                  <StringMapEditor
                    label="env_http_headers"
                    value={isRecord(server.env_http_headers) ? server.env_http_headers : {}}
                    disabled={disabled}
                    onChange={(next) => patch({ env_http_headers: next })}
                  />
                </div>
              </>
            )}
          </>
        )}

        {isCodex && (
          <label className="form-field" htmlFor={`${id}-enabled`}>
            <span>enabled</span>
            <select
              id={`${id}-enabled`}
              className="control"
              value={server.enabled === true ? 'true' : server.enabled === false ? 'false' : ''}
              disabled={disabled}
              onChange={(event) => {
                if (event.target.value === '') patch({ enabled: undefined });
                else patch({ enabled: event.target.value === 'true' });
              }}
            >
              <option value="">未设置</option>
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </label>
        )}
      </div>
      <p className="hint">
        {transport === 'stdio'
          ? 'stdio server 必须有 command；留空的字段不会写入文件。'
          : `${transport} server 必须有 url；留空的字段不会写入文件。`}
      </p>
    </div>
  );
}

function StringMapEditor({
  label,
  value,
  disabled,
  secretValues = false,
  onChange,
}: {
  label: string;
  value: JsonObject;
  disabled: boolean;
  secretValues?: boolean;
  onChange: (value: JsonObject) => void;
}) {
  const entries = Object.entries(value);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const listId = useId();

  function setMap(next: JsonObject) {
    onChange(next);
  }

  function add() {
    const key = newKey.trim();
    if (key === '') {
      setError('键不能为空');
      return;
    }
    if (Object.hasOwn(value, key)) {
      setError('键已存在');
      return;
    }
    if (newValue === '') {
      setError('值不能为空（空值等于删除该键）');
      return;
    }
    setMap({ ...value, [key]: newValue });
    setNewKey('');
    setNewValue('');
    setError(null);
  }

  return (
    <fieldset className="string-map">
      <legend>{label}</legend>
      {entries.length === 0 && <p className="collection-empty">空映射不写入。</p>}
      <ul className="map-list">
        {entries.map(([key, item]) => (
          <KvRow
            key={key}
            mapKey={key}
            value={typeof item === 'string' ? item : String(item)}
            secret={secretValues}
            disabled={disabled}
            existing={value}
            onRename={(nextKey) => {
              const next: JsonObject = {};
              for (const [entryKey, entryValue] of Object.entries(value)) {
                next[entryKey === key ? nextKey : entryKey] = entryValue;
              }
              setMap(next);
            }}
            onValue={(next) => {
              if (next === '') {
                const copy = { ...value };
                delete copy[key];
                setMap(copy);
              } else {
                setMap({ ...value, [key]: next });
              }
            }}
            onRemove={() => {
              const copy = { ...value };
              delete copy[key];
              setMap(copy);
            }}
          />
        ))}
      </ul>
      <div className="map-add">
        <input
          className="control"
          type="text"
          value={newKey}
          placeholder="键"
          list={listId}
          disabled={disabled}
          aria-label={`${label} 新键`}
          onChange={(event) => {
            setNewKey(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <input
          className="control"
          type={secretValues ? 'password' : 'text'}
          value={newValue}
          placeholder="值"
          disabled={disabled}
          autoComplete="off"
          aria-label={`${label} 新值`}
          onChange={(event) => setNewValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
        />
        <datalist id={listId} />
        <button type="button" className="secondary" disabled={disabled} onClick={add}>
          + 添加
        </button>
      </div>
      {error && <p className="field-error">{error}</p>}
    </fieldset>
  );
}

function KvRow({
  mapKey,
  value,
  secret,
  disabled,
  existing,
  onRename,
  onValue,
  onRemove,
}: {
  mapKey: string;
  value: string;
  secret: boolean;
  disabled: boolean;
  existing: JsonObject;
  onRename: (nextKey: string) => void;
  onValue: (next: string) => void;
  onRemove: () => void;
}) {
  const [keyText, setKeyText] = useState(mapKey);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    setKeyText(mapKey);
    setKeyError(null);
  }, [mapKey]);

  function commitKey() {
    const next = keyText.trim();
    if (next === mapKey) {
      setKeyError(null);
      return;
    }
    if (next === '') {
      setKeyText(mapKey);
      setKeyError(null);
      return;
    }
    if (Object.hasOwn(existing, next)) {
      setKeyError('键已存在');
      return;
    }
    setKeyError(null);
    onRename(next);
  }

  return (
    <li className="map-row">
      <input
        className="control map-key"
        type="text"
        value={keyText}
        disabled={disabled}
        aria-label={`键 ${mapKey}`}
        onChange={(event) => setKeyText(event.target.value)}
        onBlur={commitKey}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitKey();
          }
        }}
      />
      <span className="map-equals" aria-hidden="true">
        :
      </span>
      <span className={secret ? 'secret-input' : undefined}>
        <input
          className="control"
          type={secret && !visible ? 'password' : 'text'}
          value={value}
          disabled={disabled}
          autoComplete="off"
          aria-label={`值 ${mapKey}`}
          onChange={(event) => onValue(event.target.value)}
        />
        {secret && (
          <button
            type="button"
            className="secret-toggle"
            aria-pressed={visible}
            onClick={() => setVisible((current) => !current)}
          >
            {visible ? '隐藏' : '显示'}
          </button>
        )}
      </span>
      <button
        type="button"
        className="icon-button"
        disabled={disabled}
        aria-label={`删除 ${mapKey}`}
        onClick={onRemove}
      >
        删除
      </button>
      {keyError && <p className="field-error">{keyError}</p>}
    </li>
  );
}

function AdvancedJson({
  server,
  disabled,
  onApply,
}: {
  server: JsonObject;
  disabled: boolean;
  onApply: (server: JsonObject) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(server, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setText(JSON.stringify(server, null, 2));
    setError(null);
    setNotice(null);
  }, [server]);

  function apply() {
    setNotice(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (reason) {
      setError(`JSON 无效：${reason instanceof Error ? reason.message : String(reason)}`);
      return;
    }
    if (!isRecord(parsed)) {
      setError('server 定义必须是 JSON 对象');
      return;
    }
    setError(null);
    onApply(parsed);
    setNotice('已写入草稿（仍需保存全部）');
  }

  return (
    <details className="advanced-json">
      <summary>高级 JSON（编辑整个 server 对象）</summary>
      <p className="hint">未知字段会原样保留；应用后表单会同步更新。</p>
      <textarea
        className="control mono-input"
        rows={8}
        value={text}
        disabled={disabled}
        spellCheck={false}
        aria-label="server JSON"
        onChange={(event) => {
          setText(event.target.value);
          setError(null);
          setNotice(null);
        }}
      />
      <div className="confirm-actions">
        <button type="button" className="secondary" disabled={disabled} onClick={apply}>
          应用 JSON
        </button>
        <button
          type="button"
          className="link-button"
          disabled={disabled}
          onClick={() => {
            setText(JSON.stringify(server, null, 2));
            setError(null);
            setNotice(null);
          }}
        >
          重置为当前值
        </button>
      </div>
      {error && <p className="field-error">{error}</p>}
      {notice && <p className="notice inline">{notice}</p>}
    </details>
  );
}
