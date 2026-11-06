'use client';

import React from 'react';
import { InfoTooltip } from '@/components/ui/InfoTooltip';

interface VariantHeatmapProps {
  colors: string[];
  sizes: string[];
  matrix: number[][];
}

function getCellStyle(count: number): { backgroundColor: string; color: string } {
  if (count === 0) {
    return { backgroundColor: '#fee2e2', color: '#991b1b' }; // red-100 / red-800
  }
  if (count <= 2) {
    return { backgroundColor: '#fef9c3', color: '#854d0e' }; // yellow-100 / yellow-800
  }
  return { backgroundColor: '#dcfce7', color: '#166534' }; // green-100 / green-800
}

export const VariantHeatmap: React.FC<VariantHeatmapProps> = ({ colors, sizes, matrix }) => {
  if (!colors || colors.length === 0 || !sizes || sizes.length === 0) {
    return (
      <div className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm">
        <div className="flex items-center gap-1 text-sm font-semibold text-ink mb-3">
          Variant Heatmap
          <InfoTooltip text="Shows variant counts by color and size. Green = in stock, yellow = low stock, red = out of stock." />
        </div>
        <p className="text-sm text-ink-muted text-center py-8">No variant data available</p>
      </div>
    );
  }

  return (
    <div className="bg-surface rounded-xl p-4 border border-hairline/80 shadow-sm">
      <div className="flex items-center gap-1 text-sm font-semibold text-ink mb-3">
        Variant Heatmap
        <InfoTooltip text="Shows variant counts by color and size. Green = in stock, yellow = low stock, red = out of stock." />
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs border-collapse">
          <thead>
            <tr>
              <th className="text-left py-1 pr-3 text-ink-muted font-medium whitespace-nowrap">Color</th>
              {sizes.map((size) => (
                <th
                  key={size}
                  className="px-2 py-1 text-center text-ink-muted font-medium whitespace-nowrap min-w-[2.5rem]"
                >
                  {size}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {colors.map((color, rowIdx) => (
              <tr key={color}>
                <td className="py-1 pr-3 text-ink font-medium whitespace-nowrap max-w-[120px] truncate">
                  {color}
                </td>
                {sizes.map((size, colIdx) => {
                  const count = matrix[rowIdx]?.[colIdx] ?? 0;
                  const style = getCellStyle(count);
                  return (
                    <td
                      key={size}
                      className="px-2 py-1 text-center rounded font-semibold"
                      style={style}
                      title={`${color} / ${size}: ${count}`}
                    >
                      {count}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-4 mt-3 text-xs text-ink-muted">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: '#dcfce7' }} />{' '}
          High stock
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: '#fef9c3' }} />{' '}
          Low stock
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-3 rounded" style={{ backgroundColor: '#fee2e2' }} />{' '}
          Out of stock
        </span>
      </div>
    </div>
  );
};
