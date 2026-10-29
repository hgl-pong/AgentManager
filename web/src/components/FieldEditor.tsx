import { useEffect, useId, useState } from 'react';
import type { ModelInfo, SettingsField } from '../../../shared/types.ts';
import {
  clone,
  deleteAt,
  getAt,
  isRecord,
  isSecretKey,
  isSetValue,
  pathLabel,
  setAt,
  shortValue,
  typeMismatch,
  type JsonEntry,
  type JsonObject,
} from '../lib/settings.ts';

export interface FieldApi {  fileId: string;
  data: JsonObject;
  json: Record<string, JsonEntry>;
  errors: Map<string, string>;
  showUnset: boolean;
  /** Lower-case search text. Empty means no filtering. */
  query: string;
  expandAll: boolean;
  disabled: boolean;
  setValue: (path: string[], value: unknown | undefined) => void;
  clearValue: (path: string[]) => void;
  setJsonText: (
    label: string,
    text: string,
    apply: (data: JsonObject, value: unknown | undefined) => void,
  ) => void;
  jsonText: (label: string, value: unknown) => string;
  /** Models fetched from the local OpenAI-compatible endpoint. */
  modelOptions: ModelInfo[];
  /** Field paths (dot notation) that should offer the model list. */
  modelPaths: ReadonlySet<string>;
}

function matchText(field: SettingsField, basePath: readonly string[]): string {
  return `${pathLabel([...basePath, field.key])} ${field.description ?? ''}`.toLowerCase();
}

function ModelOptions({ models }: { models: ModelInfo[] }) {
  const groups = new Map<string, ModelInfo[]>();
  for (const model of models) {
    const list = groups.get(model.group) ?? [];
    list.push(model);
    groups.set(model.group, list);
  }
  return (
    <>
      {[...groups.entries()].map(([group, list]) => (
        <optgroup key={group} label={group === 'default' ? '模型' : group}>
          {list.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
              {model.thinking ? ' · thinking' : ''}
            </option>
          ))}
        </optgroup>
      ))}
    </>
  );
}

export function fieldMatches(
  field: SettingsField,
  basePath: readonly string[],
  query: string,
): boolean {
  if (query === '') return true;
  if (matchText(field, basePath).includes(query)) return true;
  const path = [...basePath, field.key];
  return field.fields?.some((child) => fieldMatches(child, path, query)) ?? false;
}

export function FieldList({
  fields,
  basePath,
  api,
  forceShow = false,
}: {
  fields: SettingsField[];
  basePath: string[];
  api: FieldApi;
  forceShow?: boolean;
}) {
  const query = forceShow ? '' : api.query;
  return (
    <div className="field-list">
      {fields.map((field) => (
        <FieldRow
          key={pathLabel([...basePath, field.key])}
          field={field}
          basePath={basePath}
          api={api}
          forceShow={forceShow}
          query={query}
        />
      ))}
    </div>
  );
}

function FieldRow({
  field,
  basePath,
  api,
  forceShow,
  query,
}: {
  field: SettingsField;
  basePath: string[];
  api: FieldApi;
  forceShow: boolean;
  query: string;
}) {
  const controlId = useId();
  const path = [...basePath, field.key];
  const value = getAt(api.data, path);
  const set = isSetValue(value);
  const selfMatches = query === '' || matchText(field, basePath).includes(query);
  const childMatches =
    query === '' ||
    (field.fields?.some((child) => fieldMatches(child, path, query)) ?? false);

  if (field.hidden) return null;
  if (query !== '' && !selfMatches && !childMatches) return null;
  if (!api.showUnset && !set && !forceShow) return null;

  const status = set
    ? '已设置'
    : field.default !== undefined
      ? `默认 ${shortValue(field.default)}`
      : '未设置';
  const statusClass = set ? 'is-set' : field.default !== undefined ? 'is-default' : 'is-unset';
  const error = api.errors.get(pathLabel(path));
  const mismatch = typeMismatch(field, value);
  const placeholder = placeholderFor(field);
  const container = field.type === 'object';

  return (
    <div
      className={`field${container ? ' field-object' : ''}${field.executable ? ' field-executable' : ''}`}
      data-set={set ? 'true' : 'false'}
    >
      <div className="field-head">
        {container ? (
          <span className="field-label">{field.key}</span>
        ) : (
          <label className="field-label" htmlFor={controlId}>
            {field.key}
          </label>
        )}
        {field.deprecated && <span className="tag">已弃用</span>}
        {field.sensitive && <span className="tag tag-sensitive">敏感</span>}
        {field.managedOnly && (
          <span className="tag tag-managed" title="该键只在组织托管配置里生效">
            仅托管生效
          </span>
        )}
        {field.executable && (
          <span className="tag tag-executable" title="该值会被 agent 当作命令执行">
            可执行
          </span>
        )}
        <span className={`field-status ${statusClass}`} title={placeholder}>
          {status}
        </span>
        {set && (
          <button
            type="button"
            className="link-button field-clear"
            disabled={api.disabled}
            aria-label={`清除 ${field.key}（不设置）`}
            onClick={() => api.clearValue(path)}
          >
            清除
          </button>
        )}
      </div>

      <div
        className="field-control"
        role={container ? 'group' : undefined}
        aria-label={container ? field.key : undefined}
      >
        {field.type === 'object' ? (
          <ObjectControl
            field={field}
            value={value}
            path={path}
            api={api}
            placeholder={placeholder}
            query={query}
          />
        ) : field.type === 'array' ? (
          <ArrayControl field={field} value={value} path={path} api={api} placeholder={placeholder} />
        ) : field.type === 'json' ? (
          <JsonControl
            id={controlId}
            label={jsonLabel(api.fileId, path)}
            value={value}
            api={api}
            rows={5}
            placeholder={placeholder}
            disabled={api.disabled}
            apply={(data, next) => {
              if (next === undefined) deleteAt(data, path);
              else setAt(data, path, next);
            }}
          />
        ) : field.type === 'boolean' ? (
          <BooleanControl id={controlId} field={field} value={value} path={path} api={api} />
        ) : field.type === 'number' || field.type === 'integer' ? (
          <NumberControl
            id={controlId}
            field={field}
            value={value}
            path={path}
            api={api}
            placeholder={placeholder}
          />
        ) : (
          <StringControl
            id={controlId}
            field={field}
            value={value}
            path={path}
            api={api}
            placeholder={placeholder}
          />
        )}
      </div>

      {mismatch && <p className="field-warning">当前磁盘值的类型与 schema 不一致，修改后会按 schema 类型写入。</p>}
      {field.managedOnly && (
        <p className="field-note-managed">写入用户配置文件通常不会生效；该键只在组织托管配置中生效。</p>
      )}
      {field.executable && (
        <p className="field-note-executable">该值会被 agent 当作命令执行；保存前会再次确认。</p>
      )}
      {field.description && (
        <p className="field-desc" title={field.description}>
          {field.description}
        </p>
      )}
      {error && <p className="field-error">{error}</p>}
    </div>
  );
}

function placeholderFor(field: SettingsField): string {
  if (field.default !== undefined) return `默认：${shortValue(field.default)}`;
  if (field.description) return field.description.slice(0, 100);
  return '未设置';
}

function jsonLabel(fileId: string, path: readonly string[]): string {
  return `j:${fileId}:${pathLabel(path)}`;
}

function StringControl({
  id,
  field,
  value,
  path,
  api,
  placeholder,
}: {
  id: string;
  field: SettingsField;
  value: unknown;
  path: string[];
  api: FieldApi;
  placeholder: string;
}) {
  const [visible, setVisible] = useState(false);

  if (field.enum && field.enum.length > 0) {
    const current =
      value === undefined ? '' : JSON.stringify(value);
    return (
      <select
        id={id}
        className="control"
        value={current}
        disabled={api.disabled}
        aria-invalid={api.errors.has(pathLabel(path))}
        onChange={(event) => {
          if (event.target.value === '') {
            api.setValue(path, undefined);
            return;
          }
          try {
            api.setValue(path, JSON.parse(event.target.value));
          } catch {
            api.setValue(path, event.target.value);
          }
        }}
      >
        <option value="">
          未设置{field.default !== undefined ? `（默认 ${String(field.default)}）` : ''}
        </option>
        {field.enum.map((entry) => (
          <option key={JSON.stringify(entry)} value={JSON.stringify(entry)}>
            {String(entry)}
          </option>
        ))}
      </select>
    );
  }

  const text = typeof value === 'string' ? value : value === undefined ? '' : String(value);
  const modelOptions = api.modelPaths.has(pathLabel(path)) ? api.modelOptions : [];
  const modelListId = modelOptions.length > 0 ? `${id}-models` : undefined;
  const suggestionsId = field.suggestions && field.suggestions.length > 0 ? `${id}-suggestions` : undefined;
  const listId = modelListId ?? suggestionsId;

  if (field.sensitive) {
    return (
      <span className="secret-input">
        <input
          id={id}
          className="control"
          type={visible ? 'text' : 'password'}
          value={text}
          disabled={api.disabled}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={api.errors.has(pathLabel(path))}
          onChange={(event) => api.setValue(path, event.target.value === '' ? undefined : event.target.value)}
        />
        <button
          type="button"
          className="secret-toggle"
          aria-pressed={visible}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? '隐藏' : '显示'}
        </button>
      </span>
    );
  }

  if (field.long) {
    return (
      <textarea
        id={id}
        className="control mono-input"
        rows={4}
        value={text}
        disabled={api.disabled}
        placeholder={placeholder}
        spellCheck={false}
        aria-invalid={api.errors.has(pathLabel(path))}
        onChange={(event) => api.setValue(path, event.target.value === '' ? undefined : event.target.value)}
      />
    );
  }

  return (
    <>
      <input
        id={id}
        className="control"
        type="text"
        value={text}
        disabled={api.disabled}
        placeholder={placeholder}
        list={listId}
        spellCheck={false}
        aria-invalid={api.errors.has(pathLabel(path))}
        onChange={(event) => api.setValue(path, event.target.value === '' ? undefined : event.target.value)}
      />
      {modelListId && (
        <datalist id={modelListId}>
          <ModelOptions models={modelOptions} />
        </datalist>
      )}
      {suggestionsId && !modelListId && (
        <datalist id={suggestionsId}>
          {field.suggestions?.map((entry) => (
            <option key={String(entry)} value={String(entry)} />
          ))}
        </datalist>
      )}
    </>
  );
}

function NumberControl({
  id,
  field,
  value,
  path,
  api,
  placeholder,
}: {
  id: string;
  field: SettingsField;
  value: unknown;
  path: string[];
  api: FieldApi;
  placeholder: string;
}) {
  const text = typeof value === 'number' && !Number.isNaN(value) ? String(value) : '';
  return (
    <input
      id={id}
      className="control control-number"
      type="number"
      step={field.type === 'integer' ? 1 : 'any'}
      min={field.minimum}
      max={field.maximum}
      value={text}
      disabled={api.disabled}
      placeholder={placeholder}
      inputMode={field.type === 'integer' ? 'numeric' : 'decimal'}
      aria-invalid={api.errors.has(pathLabel(path))}
      onChange={(event) => {
        const raw = event.target.value;
        if (raw.trim() === '') {
          api.setValue(path, undefined);
          return;
        }
        const number = Number(raw);
        if (Number.isFinite(number)) api.setValue(path, number);
      }}
    />
  );
}

function BooleanControl({
  id,
  field,
  value,
  path,
  api,
}: {
  id: string;
  field: SettingsField;
  value: unknown;
  path: string[];
  api: FieldApi;
}) {
  const current = value === true ? 'true' : value === false ? 'false' : '';
  return (
    <select
      id={id}
      className="control"
      value={current}
      disabled={api.disabled}
      aria-invalid={api.errors.has(pathLabel(path))}
      onChange={(event) => {
        if (event.target.value === '') api.setValue(path, undefined);
        else api.setValue(path, event.target.value === 'true');
      }}
    >
      <option value="">
        未设置{field.default !== undefined ? `（默认 ${String(field.default)}）` : ''}
      </option>
      <option value="true">true</option>
      <option value="false">false</option>
    </select>
  );
}

function JsonControl({
  label,
  value,
  api,
  rows,
  placeholder,
  disabled,
  apply,
  id,
}: {
  label: string;
  value: unknown;
  api: FieldApi;
  rows: number;
  placeholder?: string;
  disabled: boolean;
  apply: (data: JsonObject, value: unknown | undefined) => void;
  id?: string;
}) {
  const entry = api.json[label];
  const text = entry?.text ?? (value === undefined ? '' : JSON.stringify(value, null, 2));
  return (
    <>
      <textarea
        id={id}
        className="control mono-input json-input"
        rows={rows}
        value={text}
        disabled={disabled}
        placeholder={placeholder ?? 'JSON；留空表示未设置'}
        spellCheck={false}
        aria-invalid={entry?.error ? true : undefined}
        onChange={(event) => api.setJsonText(label, event.target.value, apply)}
      />
      {entry?.error && <p className="field-error">JSON 无效：{entry.error}</p>}
    </>
  );
}

function ArrayControl({
  field,
  value,
  path,
  api,
  placeholder,
}: {
  field: SettingsField;
  value: unknown;
  path: string[];
  api: FieldApi;
  placeholder: string;
}) {
  const items = Array.isArray(value) ? value : [];
  const itemField = field.items ?? { key: 'item', type: 'string' as const };

  const update = (next: unknown[]) => {
    if (next.length === 0) api.setValue(path, undefined);
    else api.setValue(path, next);
  };

  return (
    <div className="collection">
      {value !== undefined && !Array.isArray(value) && (
        <p className="field-warning">当前值不是数组，修改后会替换成数组。</p>
      )}
      {items.length === 0 && <p className="collection-empty">空列表按未设置处理。</p>}
      <ul className="array-list">
        {items.map((item, index) => {
          const itemPath = [...path, `[${index}]`];
          const error = api.errors.get(pathLabel(itemPath));
          const jsonLike = itemField.type === 'object' || itemField.type === 'json';
          return (
            <li key={index} className="array-item">
              <span className="array-index" aria-hidden="true">
                {index + 1}
              </span>
              {jsonLike ? (
                <JsonControl
                  label={`a:${api.fileId}:${pathLabel(path)}:${index}`}
                  value={item}
                  api={api}
                  rows={3}
                  disabled={api.disabled}
                  apply={(data, next) => {
                    const current = getAt(data, path);
                    const list = Array.isArray(current) ? clone(current) : [];
                    if (next === undefined) list.splice(index, 1);
                    else list[index] = next;
                    if (list.length === 0) deleteAt(data, path);
                    else setAt(data, path, list);
                  }}
                />
              ) : (
                <ScalarInput
                  field={itemField}
                  value={item}
                  disabled={api.disabled}
                  placeholder={itemField.key}
                  ariaLabel={`${field.key} 第 ${index + 1} 项`}
                  onChange={(next) => {
                    const list = [...items];
                    if (next === undefined) list.splice(index, 1);
                    else list[index] = next;
                    update(list);
                  }}
                />
              )}
              <button
                type="button"
                className="icon-button"
                disabled={api.disabled}
                aria-label={`删除第 ${index + 1} 项`}
                onClick={() => {
                  const list = [...items];
                  list.splice(index, 1);
                  update(list);
                }}
              >
                删除
              </button>
              {error && <p className="field-error">{error}</p>}
            </li>
          );
        })}
      </ul>
      <div className="collection-actions">
        <button
          type="button"
          className="secondary"
          disabled={api.disabled}
          onClick={() => update([...items, defaultItem(itemField)])}
        >
          + 添加{field.additionalLabel ?? '条目'}
        </button>
        {items.length === 0 && placeholder && <span className="hint">{placeholder}</span>}
      </div>
    </div>
  );
}

function defaultItem(field: SettingsField): unknown {
  if (field.default !== undefined) return clone(field.default);
  if (field.enum && field.enum.length > 0) return clone(field.enum[0]);
  switch (field.type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'object':
      return {};
    case 'json':
      return null;
    case 'array':
      return [];
    default:
      return '';
  }
}

/** Inline scalar editor shared by arrays and free-form maps. */
function ScalarInput({
  field,
  value,
  disabled,
  placeholder,
  onChange,
  id,
  sensitive = false,
  ariaLabel,
  listId,
}: {
  field: SettingsField;
  value: unknown;
  disabled: boolean;
  placeholder: string;
  onChange: (value: unknown | undefined) => void;
  id?: string;
  sensitive?: boolean;
  ariaLabel?: string;
  listId?: string;
}) {
  const [visible, setVisible] = useState(false);
  if (field.enum && field.enum.length > 0) {
    const current = value === undefined ? '' : JSON.stringify(value);
    return (
      <select
        id={id}
        className="control"
        value={current}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => {
          if (event.target.value === '') onChange(undefined);
          else {
            try {
              onChange(JSON.parse(event.target.value));
            } catch {
              onChange(event.target.value);
            }
          }
        }}
      >
        <option value="">未设置</option>
        {field.enum.map((entry) => (
          <option key={JSON.stringify(entry)} value={JSON.stringify(entry)}>
            {String(entry)}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === 'boolean') {
    const current = value === true ? 'true' : value === false ? 'false' : '';
    return (
      <select
        id={id}
        className="control"
        value={current}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(event) => {
          if (event.target.value === '') onChange(undefined);
          else onChange(event.target.value === 'true');
        }}
      >
        <option value="">未设置</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (field.type === 'number' || field.type === 'integer') {
    return (
      <input
        id={id}
        className="control control-number"
        type="number"
        step={field.type === 'integer' ? 1 : 'any'}
        min={field.minimum}
        max={field.maximum}
        value={typeof value === 'number' && !Number.isNaN(value) ? String(value) : ''}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw.trim() === '') onChange(undefined);
          else if (Number.isFinite(Number(raw))) onChange(Number(raw));
        }}
      />
    );
  }
  return (
    <span className={sensitive ? 'secret-input' : undefined}>
      <input
        id={id}
        className="control"
        type={sensitive && !visible ? 'password' : 'text'}
        value={typeof value === 'string' ? value : value === undefined ? '' : String(value)}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-label={ariaLabel}
        list={listId}
        onChange={(event) => onChange(event.target.value)}
      />
      {sensitive && (
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
  );
}

function ObjectControl({
  field,
  value,
  path,
  api,
  placeholder,
  query,
}: {
  field: SettingsField;
  value: unknown;
  path: string[];
  api: FieldApi;
  placeholder: string;
  query: string;
}) {
  const collapsed =
    !field.map && Boolean(field.fields && field.fields.length > 12) && query === '' && !api.expandAll;
  const [open, setOpen] = useState(!collapsed);

  useEffect(() => {
    setOpen(!collapsed);
  }, [collapsed]);

  if (field.map) {
    return (
      <MapControl
        field={field}
        value={value}
        path={path}
        api={api}
        placeholder={placeholder}
      />
    );
  }
  if (!field.fields || field.fields.length === 0) {
    return (
      <JsonControl
        label={jsonLabel(api.fileId, path)}
        value={value}
        api={api}
        rows={5}
        placeholder={placeholder}
        disabled={api.disabled}
        apply={(data, next) => {
          if (next === undefined) deleteAt(data, path);
          else setAt(data, path, next);
        }}
      />
    );
  }

  const record = isRecord(value) ? value : {};
  const known = new Set(field.fields.map((child) => child.key));
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  const setChildren = field.fields.filter((child) => isSetValue(getAt(record, [child.key]))).length;
  const selfMatch = query !== '' && matchText(field, path.slice(0, -1)).includes(query);

  return (
    <details
      className="object-group"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="object-name">{field.key}</span>
        <span className="hint">
          {setChildren}/{field.fields.length} 项已设置
          {unknown.length > 0 ? ` · ${unknown.length} 个额外键` : ''}
        </span>
      </summary>
      <FieldList
        fields={field.fields}
        basePath={path}
        api={{ ...api, query: selfMatch ? '' : query }}
        forceShow={selfMatch}
      />
      {unknown.length > 0 && <UnknownKeysBlock api={api} path={path} known={known} />}
    </details>
  );
}

function MapControl({
  field,
  value,
  path,
  api,
  placeholder,
}: {
  field: SettingsField;
  value: unknown;
  path: string[];
  api: FieldApi;
  placeholder: string;
}) {
  const record = isRecord(value) ? value : {};
  const entries = Object.entries(record);
  const valueField = field.mapValue ?? { key: 'value', type: 'string' as const };
  const knownKeys = field.knownKeys ?? [];
  const listId = `${api.fileId}-${pathLabel(path).replace(/[^A-Za-z0-9_-]/g, '-')}-keys`;
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const setMap = (next: JsonObject) => {
    if (Object.keys(next).length === 0) api.setValue(path, undefined);
    else api.setValue(path, next);
  };

  const remove = (key: string) => {
    const next = { ...record };
    delete next[key];
    setMap(next);
  };

  function commitNew() {
    const key = newKey.trim();
    if (key === '') {
      setAddError('键不能为空');
      return;
    }
    if (Object.hasOwn(record, key)) {
      setAddError('键已存在');
      return;
    }
    let parsed: unknown;
    if (valueField.type === 'boolean') {
      parsed = newValue === 'false' ? false : true;
    } else if (valueField.type === 'number' || valueField.type === 'integer') {
      if (newValue.trim() === '' || !Number.isFinite(Number(newValue))) {
        setAddError('值必须是数字');
        return;
      }
      parsed = Number(newValue);
    } else if (valueField.type === 'json' || valueField.type === 'object' || valueField.type === 'array') {
      if (newValue.trim() === '') {
        setAddError('值不能为空（空值等于删除该键）');
        return;
      }
      try {
        parsed = JSON.parse(newValue);
      } catch (error) {
        setAddError(`JSON 无效：${error instanceof Error ? error.message : String(error)}`);
        return;
      }
    } else {
      if (newValue === '') {
        setAddError('值不能为空（空值等于删除该键）');
        return;
      }
      parsed = newValue;
    }
    setMap({ ...record, [key]: parsed });
    setNewKey('');
    setNewValue(valueField.type === 'boolean' ? 'true' : '');
    setAddError(null);
  }

  return (
    <div className="collection">
      {value !== undefined && !isRecord(value) && (
        <p className="field-warning">当前值不是对象映射，修改后会替换成映射。</p>
      )}
      {entries.length === 0 && <p className="collection-empty">空映射按未设置处理。</p>}
      <ul className="map-list">
        {entries.map(([key, item]) => (
          <MapRow
            key={key}
            mapKey={key}
            item={item}
            valueField={valueField}
            record={record}
            path={path}
            api={api}
            listId={listId}
            disabled={api.disabled}
            onRename={(nextKey) => {
              const next: JsonObject = {};
              for (const [entryKey, entryValue] of Object.entries(record)) {
                next[entryKey === key ? nextKey : entryKey] = entryValue;
              }
              setMap(next);
            }}
            onValue={(next) => {
              if (next === undefined || next === '') remove(key);
              else setMap({ ...record, [key]: next });
            }}
            onRemove={() => remove(key)}
          />
        ))}
      </ul>

      <div className="map-add">
        <input
          className="control"
          type="text"
          value={newKey}
          placeholder="新键名"
          list={listId}
          disabled={api.disabled}
          aria-label="新键名"
          onChange={(event) => {
            setNewKey(event.target.value);
            setAddError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commitNew();
            }
          }}
        />
        <datalist id={listId}>
          {knownKeys
            .filter((entry) => !Object.hasOwn(record, entry.key))
            .map((entry) => (
              <option key={entry.key} value={entry.key}>
                {entry.description ?? entry.key}
              </option>
            ))}
        </datalist>
        {valueField.type === 'boolean' ? (
          <select
            className="control"
            value={newValue === 'false' ? 'false' : 'true'}
            disabled={api.disabled}
            aria-label="新值"
            onChange={(event) => setNewValue(event.target.value)}
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : valueField.type === 'json' || valueField.type === 'object' || valueField.type === 'array' ? (
          <textarea
            className="control mono-input"
            rows={2}
            value={newValue}
            placeholder="JSON 值"
            disabled={api.disabled}
            aria-label="新值（JSON）"
            onChange={(event) => setNewValue(event.target.value)}
          />
        ) : (
          <input
            className="control"
            type={valueField.type === 'number' || valueField.type === 'integer' ? 'number' : 'text'}
            step={valueField.type === 'integer' ? 1 : undefined}
            value={newValue}
            placeholder="值"
            disabled={api.disabled}
            aria-label="新值"
            onChange={(event) => setNewValue(event.target.value)}
          />
        )}
        <button
          type="button"
          className="secondary"
          disabled={api.disabled}
          onClick={commitNew}
        >
          + 添加
        </button>
      </div>
      {addError && <p className="field-error">{addError}</p>}
      {knownKeys.length > 0 && entries.length === 0 && (
        <p className="hint">可从 {knownKeys.length} 个已知键中选择，也可以输入自定义键。</p>
      )}
      {placeholder && entries.length === 0 && <span className="sr-only">{placeholder}</span>}
    </div>
  );
}

function MapRow({
  mapKey,
  item,
  valueField,
  record,
  path,
  api,
  listId,
  disabled,
  onRename,
  onValue,
  onRemove,
}: {
  mapKey: string;
  item: unknown;
  valueField: SettingsField;
  record: JsonObject;
  path: string[];
  api: FieldApi;
  listId: string;
  disabled: boolean;
  onRename: (nextKey: string) => void;
  onValue: (value: unknown | undefined) => void;
  onRemove: () => void;
}) {
  const [keyText, setKeyText] = useState(mapKey);
  const [keyError, setKeyError] = useState<string | null>(null);
  const id = useId();
  const sensitive = valueField.sensitive === true || isSecretKey(mapKey);
  const modelOptions = /MODEL$/i.test(mapKey) ? api.modelOptions : [];
  const modelListId = modelOptions.length > 0 ? `${id}-models` : undefined;
  const jsonLike =
    valueField.type === 'json' ||
    valueField.type === 'object' ||
    valueField.type === 'array';
  const valueError = api.errors.get(pathLabel([...path, mapKey]));

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
    if (Object.hasOwn(record, next)) {
      setKeyError('键已存在');
      return;
    }
    setKeyError(null);
    onRename(next);
  }

  return (
    <li className="map-row">
      <input
        id={`${id}-key`}
        className="control map-key"
        type="text"
        value={keyText}
        list={listId}
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
      {jsonLike ? (
        <JsonControl
          label={`m:${api.fileId}:${pathLabel(path)}:${mapKey}`}
          value={item}
          api={api}
          rows={2}
          disabled={disabled}
          apply={(data, next) => {
            const current = getAt(data, path);
            if (!isRecord(current)) return;
            if (next === undefined) delete current[mapKey];
            else current[mapKey] = next;
          }}
        />
      ) : (
        <>
          <ScalarInput
            id={`${id}-value`}
            field={valueField}
            value={item}
            disabled={disabled}
            placeholder="值"
            sensitive={sensitive}
            ariaLabel={`${mapKey} 的值`}
            onChange={onValue}
            listId={modelListId}
          />
          {modelListId && (
            <datalist id={modelListId}>
              <ModelOptions models={modelOptions} />
            </datalist>
          )}
        </>
      )}
      <button
        type="button"
        className="icon-button"
        disabled={disabled}
        aria-label={`删除键 ${mapKey}`}
        onClick={onRemove}
      >
        删除
      </button>
      {keyError && <p className="field-error">{keyError}</p>}
      {valueError && <p className="field-error">{valueError}</p>}
    </li>
  );
}

export function UnknownKeysBlock({
  api,
  path,
  known,
  title = '未在 schema 中的键',
}: {
  api: FieldApi;
  path: string[];
  known: ReadonlySet<string>;
  title?: string;
}) {
  const record = getAt(api.data, path);
  if (!isRecord(record)) return null;
  const unknown = Object.keys(record).filter((key) => !known.has(key));
  if (unknown.length === 0) return null;

  return (
    <details className="unknown-keys" open>
      <summary>
        {title}（{unknown.length}）
      </summary>
      <p className="hint">这些键会原样保留；可以编辑 JSON 值或删除。</p>
      <ul className="unknown-list">
        {unknown.map((key) => {
          const value = record[key];
          const label = `u:${api.fileId}:${pathLabel([...path, key])}`;
          return (
            <li key={key}>
              <div className="unknown-head">
                <code>{pathLabel([...path, key])}</code>
                <button
                  type="button"
                  className="icon-button"
                  disabled={api.disabled}
                  aria-label={`删除键 ${key}`}
                  onClick={() => api.clearValue([...path, key])}
                >
                  删除
                </button>
              </div>
              <JsonControl
                label={label}
                value={value}
                api={api}
                rows={2}
                disabled={api.disabled}
                apply={(data, next) => {
                  if (next === undefined) deleteAt(data, [...path, key]);
                  else setAt(data, [...path, key], next);
                }}
              />
            </li>
          );
        })}
      </ul>
    </details>
  );
}

export function CustomKeyPanel({ api }: { api: FieldApi }) {
  const [pathText, setPathText] = useState('');
  const [valueText, setValueText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  function add() {
    setError(null);
    setNotice(null);
    const parts = pathText
      .split('.')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (parts.length === 0) {
      setError('请输入键路径，例如 sandbox.network');
      return;
    }
    if (valueText.trim() === '') {
      setError('请输入 JSON 值');
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(valueText);
    } catch (reason) {
      setError(`JSON 无效：${reason instanceof Error ? reason.message : String(reason)}`);
      return;
    }
    if (getAt(api.data, parts) !== undefined) {
      if (!window.confirm(`键 ${parts.join('.')} 已存在，覆盖它的值？`)) return;
    }
    api.setValue(parts, parsed);
    setNotice(`已写入草稿：${parts.join('.')}（仍需点击保存全部）`);
    setPathText('');
    setValueText('');
  }

  return (
    <details className="custom-keys">
      <summary>添加自定义键</summary>
      <p className="hint">用于设置 schema 未覆盖的键。路径用点号分隔，值必须是合法 JSON。</p>
      <div className="custom-form">
        <label>
          <span>键路径</span>
          <input
            className="control"
            type="text"
            value={pathText}
            placeholder="例如 sandbox.network.allowedDomains"
            disabled={api.disabled}
            onChange={(event) => setPathText(event.target.value)}
          />
        </label>
        <label>
          <span>JSON 值</span>
          <textarea
            className="control mono-input"
            rows={3}
            value={valueText}
            placeholder='例如 ["example.com"] 或 {"enabled":true}'
            disabled={api.disabled}
            onChange={(event) => setValueText(event.target.value)}
          />
        </label>
        <button type="button" className="secondary" disabled={api.disabled} onClick={add}>
          写入草稿
        </button>
      </div>
      {error && <p className="field-error">{error}</p>}
      {notice && <p className="notice inline">{notice}</p>}
    </details>
  );
}
