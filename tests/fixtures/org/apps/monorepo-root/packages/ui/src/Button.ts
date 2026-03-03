import { formatDate } from '@acme/utils';

export function Button({ label, date }: { label: string; date?: Date }) {
  return `<button>${label}${date ? ` - ${formatDate(date)}` : ''}</button>`;
}
