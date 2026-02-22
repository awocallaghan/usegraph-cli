import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { formatDate, useLocalStorage } from '@acme/utils';

export default function App() {
  const [lastVisit, setLastVisit] = useLocalStorage('last_visit', null);

  function handleVisit() {
    setLastVisit(new Date().toISOString());
  }

  const today = new Date('2024-03-01');

  return (
    <View style={styles.container}>
      <Text style={styles.heading}>Acme Mobile</Text>

      <Text style={styles.date}>Today: {formatDate(today)}</Text>

      {lastVisit ? (
        <Text style={styles.info}>
          Last visit: {formatDate(new Date(lastVisit))}
        </Text>
      ) : (
        <Text style={styles.info}>First time here!</Text>
      )}

      <TouchableOpacity style={styles.button} onPress={handleVisit}>
        <Text style={styles.buttonText}>Check In</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    backgroundColor: '#fff',
  },
  heading: {
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 16,
  },
  date: {
    fontSize: 16,
    color: '#555',
    marginBottom: 8,
  },
  info: {
    fontSize: 14,
    color: '#888',
    marginBottom: 24,
  },
  button: {
    backgroundColor: '#0066ff',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonText: {
    color: '#fff',
    fontWeight: '600',
    fontSize: 16,
  },
});
