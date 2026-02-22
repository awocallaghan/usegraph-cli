import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { formatCurrency, formatDate, useLocalStorage } from '@acme/utils';

const TRANSACTIONS = [
  { id: 'tx-001', label: 'Subscription renewal', amount: 9900,  date: '2024-02-28' },
  { id: 'tx-002', label: 'Add-on seats',          amount: 4500,  date: '2024-02-15' },
  { id: 'tx-003', label: 'Enterprise upgrade',    amount: 49000, date: '2024-01-31' },
  { id: 'tx-004', label: 'Overage charge',        amount: 1200,  date: '2024-01-20' },
];

export default function AccountScreen() {
  const [currency] = useLocalStorage('preferred_currency', 'USD');

  const total = TRANSACTIONS.reduce((sum, tx) => sum + tx.amount, 0);

  return (
    <ScrollView style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Account Activity</Text>
        <Text style={styles.total}>
          Total: {formatCurrency(total, currency)}
        </Text>
      </View>

      {TRANSACTIONS.map(tx => (
        <View key={tx.id} style={styles.row}>
          <View style={styles.rowLeft}>
            <Text style={styles.label}>{tx.label}</Text>
            <Text style={styles.date}>{formatDate(new Date(tx.date))}</Text>
          </View>
          <Text style={styles.amount}>{formatCurrency(tx.amount, currency)}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#f9f9f9',
  },
  header: {
    padding: 20,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
    marginBottom: 12,
  },
  title: {
    fontSize: 22,
    fontWeight: '700',
    marginBottom: 4,
  },
  total: {
    fontSize: 16,
    color: '#0066ff',
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 14,
    backgroundColor: '#fff',
    marginBottom: 1,
  },
  rowLeft: {
    flex: 1,
  },
  label: {
    fontSize: 15,
    color: '#222',
  },
  date: {
    fontSize: 12,
    color: '#999',
    marginTop: 2,
  },
  amount: {
    fontSize: 15,
    fontWeight: '600',
    color: '#333',
  },
});
