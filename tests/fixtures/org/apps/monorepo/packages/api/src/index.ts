import { formatDate, formatCurrency, debounce } from '@acme/utils';

export interface Report {
  id: string;
  title: string;
  total: number;
  generatedAt: Date;
}

export function formatReport(report: Report): string {
  const date = formatDate(report.generatedAt, 'short');
  const amount = formatCurrency(report.total);
  return `[${report.id}] ${report.title} — ${amount} (${date})`;
}

export function createDebouncedSearch(onSearch: (q: string) => void, delayMs = 300) {
  return debounce(onSearch, delayMs);
}
