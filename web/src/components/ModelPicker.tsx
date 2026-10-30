import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ModelInfo } from '../../../shared/types.ts';

export interface ModelPickerProps {
  value: string;
  models: readonly ModelInfo[];
  label: string;
  /** id of the trigger button, so an external <label htmlFor> can point at it. */
  buttonId?: string;
  placeholder?: string;
  disabled?: boolean;
  /** Free text is allowed (the agent will just fail to resolve an unknown id). */
  allowCustom?: boolean;
  onChange: (value: string) => void;
}

interface Group {
  name: string;
  start: number;
  models: ModelInfo[];
}

function formatTokens(value: number | undefined): string {
  if (!value || value <= 0) return '';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
  if (value >= 1000) return `${Math.round(value / 1000)}K`;
  return String(value);
}

function groupOf(model: ModelInfo): string {
  return model.group === 'default' ? '默认' : model.group;
}

/**
 * A searchable model picker: a button showing the current choice plus a filterable list panel.
 * A native <datalist> was unusable here — 100+ grouped options, no way to see context window or
 * capabilities, and the browser renders them in an opaque OS popup.
 *
 * Keyboard: ↓/↑ move through the list, Enter picks, Escape closes, and the active option is kept
 * scrolled into view so arrow keys never move the highlight off screen.
 */
export function ModelPicker({
  value,
  models,
  label,
  buttonId,
  placeholder = '选择模型',
  disabled = false,
  allowCustom = true,
  onChange,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const optionId = (index: number) => `${baseId}-option-${index}`;

  const selected = useMemo(() => models.find((model) => model.id === value), [models, value]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle === '') return models;
    return models.filter((model) =>
      `${model.id} ${model.name} ${model.group}`.toLowerCase().includes(needle),
    );
  }, [models, query]);

  // Grouping keeps the declaration order, and `start` lets each row know its flat index in O(1).
  const groups = useMemo<Group[]>(() => {
    const byName = new Map<string, Group>();
    filtered.forEach((model, index) => {
      const name = groupOf(model);
      const group = byName.get(name);
      if (group) group.models.push(model);
      else byName.set(name, { name, start: index, models: [model] });
    });
    return [...byName.values()];
  }, [filtered]);

  const flat = useMemo(() => groups.flatMap((group) => group.models), [groups]);
  const active = flat[cursor];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    const index = models.findIndex((model) => model.id === value);
    setCursor(index < 0 ? 0 : index);
    // Focus after the panel mounts so the caret lands in the filter box.
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open, models, value]);

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [cursor, open]);

  function choose(model: ModelInfo) {
    onChange(model.id);
    setOpen(false);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      setOpen(false);
      return;
    }
    if (!open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (flat.length === 0) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setCursor((current) => (current + delta + flat.length) % flat.length);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (active) choose(active);
      else if (allowCustom && query.trim() !== '') {
        onChange(query.trim());
        setOpen(false);
      }
    }
  }

  const trimmedQuery = query.trim();
  const exactMatch = flat.some((model) => model.id === trimmedQuery);

  return (
    <div className={`model-picker${open ? ' is-open' : ''}`} ref={rootRef} onKeyDown={onKeyDown}>
      <button
        type="button"
        id={buttonId}
        className="model-picker-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {value === '' ? (
          <span className="model-picker-empty">{placeholder}</span>
        ) : (
          <span className="model-picker-current">
            <strong>{selected?.name ?? value}</strong>
            {selected && selected.name !== selected.id && <code>{selected.id}</code>}
          </span>
        )}
        <span className="model-picker-chevron" aria-hidden="true">
          ⌄
        </span>
      </button>

      {selected && (
        <p className="model-picker-meta">
          <span className="model-picker-group">{groupOf(selected)}</span>
          {selected.contextWindow ? <span>上下文 {formatTokens(selected.contextWindow)}</span> : null}
          {selected.maxOutputTokens ? <span>输出 {formatTokens(selected.maxOutputTokens)}</span> : null}
          {selected.thinking ? <span className="model-cap model-cap--thinking">thinking</span> : null}
          {selected.effort ? (
            <span className="model-cap model-cap--effort">
              {selected.effortLevels?.length ? selected.effortLevels.join('/') : 'effort'}
            </span>
          ) : null}
          {selected.imageInput ? <span className="model-cap model-cap--image">图片</span> : null}
          {selected.pdfInput ? <span className="model-cap model-cap--pdf">PDF</span> : null}
        </p>
      )}
      {!selected && value !== '' && <p className="model-picker-meta hint">不在当前模型列表里，按原样写入。</p>}

      {open && (
        <div className="model-picker-panel">
          <input
            ref={searchRef}
            className="control model-picker-search"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={active ? optionId(cursor) : undefined}
            aria-label={`筛选${label}`}
            value={query}
            placeholder={`筛选 ${models.length} 个模型…`}
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
          />
          <div className="model-picker-list" id={listId} role="listbox" aria-label={label} ref={listRef}>
            {groups.length === 0 && (
              <p className="model-picker-none">
                {models.length === 0 ? '没有可用的模型列表，先在上面读取模型源。' : '没有匹配的模型。'}
              </p>
            )}
            {groups.map((group) => (
              <div className="model-picker-group-block" key={group.name} role="group" aria-label={group.name}>
                <p className="model-picker-group-head" aria-hidden="true">
                  {group.name}
                </p>
                {group.models.map((model, offset) => {
                  const index = group.start + offset;
                  const isActive = index === cursor;
                  const isSelected = model.id === value;
                  return (
                    <button
                      type="button"
                      role="option"
                      id={optionId(index)}
                      data-index={index}
                      aria-selected={isSelected}
                      tabIndex={-1}
                      key={model.id}
                      className={`model-picker-option${isActive ? ' is-active' : ''}${
                        isSelected ? ' is-selected' : ''
                      }`}
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => choose(model)}
                    >
                      <span className="model-picker-option-main">
                        <strong>{model.name}</strong>
                        {model.name !== model.id && <code>{model.id}</code>}
                      </span>
                      <span className="model-picker-option-meta">
                        {model.contextWindow ? formatTokens(model.contextWindow) : ''}
                        {model.thinking ? ' · thinking' : ''}
                        {model.effort ? ' · effort' : ''}
                        {model.imageInput ? ' · 图片' : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {allowCustom && trimmedQuery !== '' && !exactMatch && (
            <button
              type="button"
              className="model-picker-custom"
              onClick={() => {
                onChange(trimmedQuery);
                setOpen(false);
              }}
            >
              使用自定义 ID <code>{trimmedQuery}</code>
            </button>
          )}
          {value !== '' && (
            <button
              type="button"
              className="model-picker-custom"
              onClick={() => {
                onChange('');
                setOpen(false);
              }}
            >
              清除选择（沿用 agent 自己的默认值）
            </button>
          )}
        </div>
      )}
    </div>
  );
}
