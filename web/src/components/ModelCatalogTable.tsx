import type { ModelInfo } from '../../../shared/types.ts';

function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return '';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value % 1_000 === 0 ? 0 : 1)}K`;
  return String(value);
}

/** The model list shared by the provider page; capability tags stay data, not decoration. */
export function ModelCatalogTable({ models }: { models: ModelInfo[] }) {
  return (
    <div className="models-catalog-scroll">
      <div className="table-wrap">
        <table className="model-catalog-table">
          <colgroup>
            <col className="col-id" />
            <col className="col-group" />
            <col className="col-num" />
            <col className="col-num" />
            <col className="col-effort" />
            <col className="col-caps" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">ID / 名称</th>
              <th scope="col">分组</th>
              <th scope="col">上下文</th>
              <th scope="col">输出</th>
              <th scope="col">推理强度</th>
              <th scope="col">其他能力</th>
            </tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <tr key={model.id} className="model-catalog-row">
                <td className="model-catalog-id">
                  <code>{model.id}</code>
                  <span className="model-catalog-name">{model.name !== model.id ? model.name : ''}</span>
                </td>
                <td className="model-catalog-group">
                  <span className="model-group-badge">
                    {model.group === 'default' ? '默认' : model.group}
                  </span>
                </td>
                <td className="model-catalog-num">{formatTokens(model.contextWindow) || '—'}</td>
                <td className="model-catalog-num">{formatTokens(model.maxOutputTokens) || '—'}</td>
                <td className="model-catalog-effort">
                  <div className="model-cap-row">
                    {model.effort && model.effortLevels?.length ? (
                      model.effortLevels.map((level) => (
                        <span key={level} className="model-cap model-cap--effort">
                          {level}
                        </span>
                      ))
                    ) : model.effort ? (
                      <span className="model-cap model-cap--effort">effort</span>
                    ) : (
                      <span className="model-cap model-cap--none">—</span>
                    )}
                  </div>
                </td>
                <td className="model-catalog-caps">
                  <div className="model-cap-row">
                    {model.thinking && <span className="model-cap model-cap--thinking">thinking</span>}
                    {model.imageInput && <span className="model-cap model-cap--image">图片</span>}
                    {model.pdfInput && <span className="model-cap model-cap--pdf">PDF</span>}
                    {!model.thinking && !model.imageInput && !model.pdfInput && (
                      <span className="model-cap model-cap--none">—</span>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {models.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  没有匹配的模型。
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
