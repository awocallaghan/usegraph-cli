import { formatDate, parseDate } from '@acme/utils';

export function processDate(raw: string) {
  const formatted = formatDate(new Date(raw));
  const parsed = parseDate('2024-01-15', 'YYYY-MM-DD');
  return { formatted, parsed };
}
