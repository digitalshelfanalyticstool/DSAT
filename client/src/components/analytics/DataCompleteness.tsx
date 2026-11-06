'use client';

import React from 'react';
import { ChartCard } from '@/components/ui/ChartCard';

interface DataCompletenessProps {
  completeness: Record<string, number>;
}

const FIELD_LABELS: Record<string, string> = {
  upc: 'UPC',
  selling_price: 'Selling Price',
  list_price: 'List Price',
  inventory: 'Inventory',
  item_number: 'Item Number',
};

function getBarColor(pct: number): string {
  if (pct >= 90) return 'bg-emerald-500';
  if (pct >= 70) return 'bg-accent-500';
  if (pct >= 50) return 'bg-amber-500';
  return 'bg-red-500';
}

function getTextColor(pct: number): string {
  if (pct >= 90) return 'text-emerald-700';
  if (pct >= 70) return 'text-accent';
  if (pct >= 50) return 'text-amber-700';
  return 'text-red-700';
}

const ORDERED_FIELDS = ['upc', 'selling_price', 'list_price', 'inventory', 'item_number'];
const TOOLTIP_TEXT = 'Percentage of variants in this job that have a non-null value for the given field.';
const TITLE_CLASS = 'flex items-center gap-1 text-sm font-semibold text-ink mb-3';

export const DataCompleteness: React.FC<DataCompletenessProps> = ({ completeness }) => {
  const orderedMatches = ORDERED_FIELDS.filter((f) => f in completeness);
  const fields = orderedMatches.length > 0 ? orderedMatches : Object.keys(completeness);

  const avg =
    fields.length > 0
      ? fields.reduce((sum, f) => sum + (completeness[f] ?? 0), 0) / fields.length
      : 0;

  return (
    <ChartCard
      title="Data Completeness"
      tooltip={TOOLTIP_TEXT}
      titleClassName={TITLE_CLASS}
      isEmpty={fields.length === 0}
      emptyMessage="No completeness data available"
      summary={
        <>
          Bar chart of {fields.length} field-completeness percentages (avg {Math.round(avg)}%).
        </>
      }
      tableContent={
        <>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Completeness</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => {
              const pct = Math.round(completeness[field] ?? 0);
              const label = FIELD_LABELS[field] ?? field;
              return (
                <tr key={field}>
                  <td>{label}</td>
                  <td>{pct}%</td>
                </tr>
              );
            })}
          </tbody>
        </>
      }
    >
      <div className="space-y-3">
        {fields.map((field) => {
          const pct = Math.round(completeness[field] ?? 0);
          const label = FIELD_LABELS[field] ?? field;
          return (
            <div key={field}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm text-ink-muted">{label}</span>
                <span className={`text-sm font-semibold ${getTextColor(pct)}`}>
                  {pct}%
                </span>
              </div>
              <div className="w-full bg-surface-tertiary rounded-full h-2 overflow-hidden">
                <div
                  className={`h-2 rounded-full transition-all duration-300 ${getBarColor(pct)}`}
                  style={{ width: `${Math.min(pct, 100)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </ChartCard>
  );
};
