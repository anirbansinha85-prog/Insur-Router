import React, { useCallback, useState } from 'react';
import {
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useFocusEffect } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { loadHistory, type HistoryEntry } from '@/store/history';
import { BottomTabBar } from '@/components/BottomTabBar';

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

interface EntryCardProps {
  entry: HistoryEntry;
  colors: ReturnType<typeof useColors>;
}

function EntryCard({ entry, colors }: EntryCardProps) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.card,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          opacity: pressed ? 0.75 : 1,
        },
      ]}
      onPress={() => router.push({ pathname: '/history-detail', params: { id: entry.id } })}
      accessibilityRole="button"
      accessibilityLabel={`${entry.vehicleMake} ${entry.vehicleModel}, captured ${formatDate(entry.timestamp)}`}
    >
      <View style={styles.cardMain}>
        <View style={styles.vehicleRow}>
          <Ionicons name="car-outline" size={18} color={colors.primary} />
          <Text style={[styles.vehicleName, { color: colors.foreground }]}>
            {entry.vehicleMake} {entry.vehicleModel}
          </Text>
        </View>

        <View style={styles.metaRow}>
          <View style={styles.metaItem}>
            <Ionicons name="calendar-outline" size={13} color={colors.mutedForeground} />
            <Text style={[styles.metaText, { color: colors.mutedForeground }]}>
              {formatDate(entry.timestamp)} · {formatTime(entry.timestamp)}
            </Text>
          </View>
          {entry.applicationId != null && (
            <View style={[styles.idBadge, { backgroundColor: colors.accent, borderColor: colors.border }]}>
              <Text style={[styles.idBadgeText, { color: colors.accentForeground }]}>
                #{entry.applicationId}
              </Text>
            </View>
          )}
        </View>
      </View>

      <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} />
    </Pressable>
  );
}

export default function HistoryScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Reload every time the screen comes into focus (e.g. after a new capture)
  useFocusEffect(
    useCallback(() => {
      let active = true;
      loadHistory().then((data) => {
        if (active) {
          setEntries(data);
          setLoading(false);
        }
      });
      return () => { active = false; };
    }, []),
  );

  return (
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      {/* Header */}
      <View
        style={[
          styles.header,
          { paddingTop: Platform.OS === 'web' ? 67 : insets.top + 12 },
        ]}
      >
        <Text style={[styles.title, { color: colors.foreground }]}>History</Text>
        <Text style={[styles.subtitle, { color: colors.mutedForeground }]}>
          Past RC captures sent to InsurRouter
        </Text>
      </View>

      {/* List */}
      {loading ? null : entries.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="time-outline" size={48} color={colors.border} />
          <Text style={[styles.emptyTitle, { color: colors.foreground }]}>No captures yet</Text>
          <Text style={[styles.emptySubtitle, { color: colors.mutedForeground }]}>
            Captures sent to InsurRouter will appear here.
          </Text>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => <EntryCard entry={item} colors={colors} />}
          showsVerticalScrollIndicator={false}
        />
      )}

      <BottomTabBar active="history" />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 24,
    paddingBottom: 16,
  },
  title: {
    fontSize: 26,
    fontWeight: '700' as const,
    fontFamily: 'Inter_700Bold',
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
  },
  list: {
    paddingHorizontal: 16,
    paddingBottom: 16,
    gap: 10,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 10,
    padding: 14,
    gap: 12,
  },
  cardMain: {
    flex: 1,
    gap: 6,
  },
  vehicleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  vehicleName: {
    fontSize: 15,
    fontWeight: '600' as const,
    fontFamily: 'Inter_600SemiBold',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  metaItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  metaText: {
    fontSize: 12,
    fontFamily: 'Inter_400Regular',
  },
  idBadge: {
    borderWidth: 1,
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  idBadgeText: {
    fontSize: 11,
    fontWeight: '600' as const,
    fontFamily: 'Inter_600SemiBold',
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 32,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600' as const,
    fontFamily: 'Inter_600SemiBold',
  },
  emptySubtitle: {
    fontSize: 14,
    fontFamily: 'Inter_400Regular',
    textAlign: 'center',
    lineHeight: 20,
  },
});
