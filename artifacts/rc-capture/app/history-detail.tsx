import React, { useEffect, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router, useLocalSearchParams } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { loadHistory, type HistoryEntry } from '@/store/history';
import type { MsaFields } from '@/store/ingest';

interface FieldRowProps {
  label: string;
  value: string | number;
  colors: ReturnType<typeof useColors>;
}

function FieldRow({ label, value, colors }: FieldRowProps) {
  return (
    <View style={[styles.fieldRow, { borderBottomColor: colors.border }]}>
      <Text style={[styles.fieldLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.fieldValue, { color: colors.foreground }]}>{String(value)}</Text>
    </View>
  );
}

interface SectionProps {
  title: string;
  children: React.ReactNode;
  colors: ReturnType<typeof useColors>;
}

function Section({ title, children, colors }: SectionProps) {
  return (
    <View style={[styles.section, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <Text style={[styles.sectionTitle, { color: colors.primary }]}>{title}</Text>
      {children}
    </View>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function HistoryDetailScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [entry, setEntry] = useState<HistoryEntry | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    loadHistory().then((entries) => {
      const found = entries.find((e) => e.id === id);
      if (found) {
        setEntry(found);
      } else {
        setNotFound(true);
      }
    });
  }, [id]);

  const f: MsaFields | undefined = entry?.fields;

  return (
    <View
      style={[
        styles.root,
        {
          backgroundColor: colors.background,
          paddingTop: Platform.OS === 'web' ? 67 : insets.top,
          paddingBottom: Platform.OS === 'web' ? 24 : insets.bottom + 8,
        },
      ]}
    >
      {/* Header */}
      <View style={styles.header}>
        <Pressable
          style={styles.backBtn}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
          <Text style={[styles.backText, { color: colors.primary }]}>History</Text>
        </Pressable>
      </View>

      {notFound && (
        <View style={styles.centered}>
          <Ionicons name="alert-circle-outline" size={48} color={colors.border} />
          <Text style={[styles.notFoundText, { color: colors.mutedForeground }]}>
            Record not found.
          </Text>
        </View>
      )}

      {entry && f && (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
          {/* Summary header */}
          <View style={styles.summaryBlock}>
            <Text style={[styles.vehicleName, { color: colors.foreground }]}>
              {f.vehicleMake} {f.vehicleModel}
            </Text>
            <Text style={[styles.capturedAt, { color: colors.mutedForeground }]}>
              Captured {formatTimestamp(entry.timestamp)}
            </Text>
            {entry.applicationId != null && (
              <View style={[styles.appIdRow, { backgroundColor: colors.accent, borderColor: colors.border }]}>
                <Text style={[styles.appIdLabel, { color: colors.accentForeground }]}>InsurRouter Application ID</Text>
                <Text style={[styles.appIdValue, { color: colors.accentForeground }]}>#{entry.applicationId}</Text>
              </View>
            )}
          </View>

          {/* Vehicle fields */}
          <Section title="Vehicle" colors={colors}>
            <FieldRow label="Make" value={f.vehicleMake} colors={colors} />
            <FieldRow label="Model" value={f.vehicleModel} colors={colors} />
            <FieldRow label="Variant" value={f.vehicleVariant} colors={colors} />
            <FieldRow label="Engine Number" value={f.vehicleEngineNumber} colors={colors} />
            <FieldRow label="Chassis Number" value={f.vehicleChassisNumber} colors={colors} />
            <FieldRow label="Ex-Showroom Price (₹)" value={f.vehicleExShowroomPrice} colors={colors} />
            <FieldRow label="Date of Purchase" value={f.vehicleDateOfPurchase} colors={colors} />
          </Section>

          {/* Owner fields */}
          <Section title="Owner" colors={colors}>
            <FieldRow label="Full Name" value={f.ownerFullName} colors={colors} />
            <FieldRow label="Billing Address" value={f.ownerBillingAddress} colors={colors} />
            <FieldRow label="Pincode" value={f.ownerPincode} colors={colors} />
            <FieldRow label="Phone Number" value={f.ownerPhoneNumber} colors={colors} />
            <FieldRow label="Email" value={f.ownerEmail} colors={colors} />
            <FieldRow label="Date of Birth" value={f.ownerDateOfBirth} colors={colors} />
            <FieldRow label="ID Proof Type" value={f.ownerIdProofType} colors={colors} />
            <FieldRow label="ID Proof Number" value={f.ownerIdProofNumber} colors={colors} />
          </Section>

          {/* RTO fields */}
          <Section title="RTO" colors={colors}>
            <FieldRow label="Registration City" value={f.rtoRegistrationCity} colors={colors} />
            <FieldRow label="Registration State" value={f.rtoRegistrationState} colors={colors} />
            <FieldRow label="RTO Code" value={f.rtoCode} colors={colors} />
          </Section>
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  backBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
  },
  backText: {
    fontSize: 16,
    fontFamily: 'Inter_500Medium',
  },
  scrollContent: {
    paddingHorizontal: 16,
    paddingBottom: 32,
    gap: 16,
  },
  summaryBlock: {
    gap: 6,
    paddingBottom: 8,
  },
  vehicleName: {
    fontSize: 22,
    fontWeight: '700' as const,
    fontFamily: 'Inter_700Bold',
  },
  capturedAt: {
    fontSize: 13,
    fontFamily: 'Inter_400Regular',
  },
  appIdRow: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginTop: 6,
    gap: 2,
  },
  appIdLabel: {
    fontSize: 11,
    fontWeight: '600' as const,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontFamily: 'Inter_600SemiBold',
  },
  appIdValue: {
    fontSize: 20,
    fontWeight: '700' as const,
    fontFamily: 'Inter_700Bold',
  },
  section: {
    borderWidth: 1,
    borderRadius: 10,
    overflow: 'hidden',
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '700' as const,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontFamily: 'Inter_700Bold',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 8,
  },
  fieldRow: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 2,
  },
  fieldLabel: {
    fontSize: 11,
    fontFamily: 'Inter_400Regular',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  fieldValue: {
    fontSize: 14,
    fontFamily: 'Inter_500Medium',
  },
  centered: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 12,
  },
  notFoundText: {
    fontSize: 16,
    fontFamily: 'Inter_400Regular',
  },
});
