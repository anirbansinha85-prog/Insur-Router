import React, { useState, useCallback } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';
import { getIngestResult, setApplicationId, MsaFields } from '@/store/ingest';
import { useIngestPush } from '@workspace/api-client-react';

const ID_PROOF_OPTIONS = ['AADHAR', 'PAN', 'PASSPORT', 'DRIVING_LICENSE', 'VOTER_ID'] as const;
type IdProofType = MsaFields['ownerIdProofType'];

interface FieldDef {
  key: keyof MsaFields;
  label: string;
  numeric?: boolean;
}

const VEHICLE_FIELDS: FieldDef[] = [
  { key: 'vehicleMake', label: 'Make' },
  { key: 'vehicleModel', label: 'Model' },
  { key: 'vehicleVariant', label: 'Variant' },
  { key: 'vehicleEngineNumber', label: 'Engine Number' },
  { key: 'vehicleChassisNumber', label: 'Chassis Number' },
  { key: 'vehicleExShowroomPrice', label: 'Ex-Showroom Price (₹)', numeric: true },
  { key: 'vehicleDateOfPurchase', label: 'Date of Purchase (YYYY-MM-DD)' },
];

const OWNER_FIELDS: FieldDef[] = [
  { key: 'ownerFullName', label: 'Full Name' },
  { key: 'ownerBillingAddress', label: 'Billing Address' },
  { key: 'ownerPincode', label: 'Pincode', numeric: true },
  { key: 'ownerPhoneNumber', label: 'Phone Number' },
  { key: 'ownerEmail', label: 'Email' },
  { key: 'ownerDateOfBirth', label: 'Date of Birth (YYYY-MM-DD)' },
  { key: 'ownerIdProofNumber', label: 'ID Proof Number' },
];

const RTO_FIELDS: FieldDef[] = [
  { key: 'rtoRegistrationCity', label: 'Registration City' },
  { key: 'rtoRegistrationState', label: 'Registration State' },
  { key: 'rtoCode', label: 'RTO Code' },
];

function FieldRow({
  fieldDef,
  value,
  confidence,
  onChangeText,
  colors,
}: {
  fieldDef: FieldDef;
  value: string;
  confidence: number;
  onChangeText: (v: string) => void;
  colors: ReturnType<typeof useColors>;
}) {
  const isLowConfidence = confidence < 0.7;
  const confidencePct = Math.round(confidence * 100);

  return (
    <View style={[
      rowStyles.row,
      {
        borderColor: isLowConfidence ? colors.amberBorder : colors.border,
        backgroundColor: isLowConfidence ? colors.amberBackground : colors.card,
      },
    ]}>
      <View style={rowStyles.labelRow}>
        <Text style={[rowStyles.label, { color: colors.mutedForeground }]}>{fieldDef.label}</Text>
        {isLowConfidence && (
          <View style={[rowStyles.badge, { backgroundColor: colors.amber }]}>
            <Ionicons name="warning" size={10} color={colors.amberForeground} />
            <Text style={[rowStyles.badgeText, { color: colors.amberForeground }]}>
              {confidencePct}%
            </Text>
          </View>
        )}
      </View>
      <TextInput
        style={[rowStyles.input, { color: colors.foreground, borderColor: isLowConfidence ? colors.amberBorder : colors.input }]}
        value={value}
        onChangeText={onChangeText}
        keyboardType={fieldDef.numeric ? 'numeric' : 'default'}
        placeholderTextColor={colors.mutedForeground}
        placeholder={`Enter ${fieldDef.label.toLowerCase()}`}
      />
    </View>
  );
}

function IdProofPicker({
  value,
  confidence,
  onSelect,
  colors,
}: {
  value: IdProofType;
  confidence: number;
  onSelect: (v: IdProofType) => void;
  colors: ReturnType<typeof useColors>;
}) {
  const isLow = confidence < 0.7;
  return (
    <View style={[
      rowStyles.row,
      {
        borderColor: isLow ? colors.amberBorder : colors.border,
        backgroundColor: isLow ? colors.amberBackground : colors.card,
      },
    ]}>
      <View style={rowStyles.labelRow}>
        <Text style={[rowStyles.label, { color: colors.mutedForeground }]}>ID Proof Type</Text>
        {isLow && (
          <View style={[rowStyles.badge, { backgroundColor: colors.amber }]}>
            <Ionicons name="warning" size={10} color={colors.amberForeground} />
            <Text style={[rowStyles.badgeText, { color: colors.amberForeground }]}>
              {Math.round(confidence * 100)}%
            </Text>
          </View>
        )}
      </View>
      <View style={rowStyles.pickerRow}>
        {ID_PROOF_OPTIONS.map((opt) => (
          <Pressable
            key={opt}
            style={[
              rowStyles.chip,
              {
                backgroundColor: value === opt ? colors.primary : colors.secondary,
                borderColor: value === opt ? colors.primary : colors.border,
              },
            ]}
            onPress={() => onSelect(opt)}
          >
            <Text style={[
              rowStyles.chipText,
              { color: value === opt ? colors.primaryForeground : colors.mutedForeground },
            ]}>
              {opt.replace('_', ' ')}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

const rowStyles = StyleSheet.create({
  row: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 8,
  },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 6,
  },
  label: {
    fontSize: 11,
    fontWeight: '600' as const,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    fontFamily: 'Inter_600SemiBold',
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  badgeText: {
    fontSize: 10,
    fontWeight: '600' as const,
    fontFamily: 'Inter_600SemiBold',
  },
  input: {
    fontSize: 14,
    borderWidth: 1,
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    fontFamily: 'Inter_400Regular',
  },
  pickerRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 6,
    borderWidth: 1,
  },
  chipText: {
    fontSize: 11,
    fontFamily: 'Inter_500Medium',
  },
});

export default function ReviewScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const pushMutation = useIngestPush();

  const ingestResult = getIngestResult();

  const [fields, setFields] = useState<MsaFields>(
    ingestResult?.fields ?? {
      vehicleMake: '', vehicleModel: '', vehicleVariant: '',
      vehicleEngineNumber: '', vehicleChassisNumber: '',
      vehicleExShowroomPrice: 0, vehicleDateOfPurchase: '',
      ownerFullName: '', ownerBillingAddress: '', ownerPincode: 0,
      ownerPhoneNumber: '', ownerEmail: '', ownerDateOfBirth: '',
      ownerIdProofType: 'AADHAR', ownerIdProofNumber: '',
      rtoRegistrationCity: '', rtoRegistrationState: '', rtoCode: '',
    }
  );

  const confidence = ingestResult?.confidence ?? {};

  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const lowCount = Object.entries(confidence).filter(([, v]) => v < 0.7).length;

  const updateField = useCallback(<K extends keyof MsaFields>(key: K, raw: string) => {
    setFields((prev) => {
      const numericKeys: (keyof MsaFields)[] = ['vehicleExShowroomPrice', 'ownerPincode'];
      if (numericKeys.includes(key)) {
        return { ...prev, [key]: raw === '' ? 0 : Number(raw) };
      }
      return { ...prev, [key]: raw };
    });
  }, []);

  const getConf = (key: keyof MsaFields) => confidence[key] ?? 1;

  const handlePush = async () => {
    setErrorMsg(null);
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    pushMutation.mutate(
      { data: { fields } },
      {
        onSuccess: (data) => {
          setApplicationId(data.applicationId);
          router.push('/success');
        },
        onError: (err) => {
          const msg = err instanceof Error ? err.message : 'Push failed. Please retry.';
          setErrorMsg(msg);
        },
      },
    );
  };

  const s = styles(colors, insets);

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <Pressable style={s.backBtn} onPress={() => router.back()}>
          <Ionicons name="arrow-back" size={20} color={colors.foreground} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Text style={s.headerTitle}>Review Fields</Text>
          {lowCount > 0 && (
            <Text style={s.headerSub}>
              <Ionicons name="warning" size={12} color={colors.amber} /> {lowCount} low-confidence field{lowCount !== 1 ? 's' : ''} need review
            </Text>
          )}
        </View>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={s.scrollContent}
        keyboardShouldPersistTaps="handled"
      >
        {/* Vehicle section */}
        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Ionicons name="car-sport" size={16} color={colors.primary} />
            <Text style={s.sectionTitle}>Vehicle Details</Text>
          </View>
          {VEHICLE_FIELDS.map((fd) => (
            <FieldRow
              key={fd.key}
              fieldDef={fd}
              value={String(fields[fd.key] ?? '')}
              confidence={getConf(fd.key)}
              onChangeText={(v) => updateField(fd.key, v)}
              colors={colors}
            />
          ))}
        </View>

        {/* Owner section */}
        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Ionicons name="person" size={16} color={colors.primary} />
            <Text style={s.sectionTitle}>Owner KYC</Text>
          </View>
          {OWNER_FIELDS.map((fd) => (
            <FieldRow
              key={fd.key}
              fieldDef={fd}
              value={String(fields[fd.key] ?? '')}
              confidence={getConf(fd.key)}
              onChangeText={(v) => updateField(fd.key, v)}
              colors={colors}
            />
          ))}
          <IdProofPicker
            value={fields.ownerIdProofType}
            confidence={getConf('ownerIdProofType')}
            onSelect={(v) => setFields((prev) => ({ ...prev, ownerIdProofType: v }))}
            colors={colors}
          />
        </View>

        {/* RTO section */}
        <View style={s.section}>
          <View style={s.sectionHeader}>
            <Ionicons name="location" size={16} color={colors.primary} />
            <Text style={s.sectionTitle}>RTO Details</Text>
          </View>
          {RTO_FIELDS.map((fd) => (
            <FieldRow
              key={fd.key}
              fieldDef={fd}
              value={String(fields[fd.key] ?? '')}
              confidence={getConf(fd.key)}
              onChangeText={(v) => updateField(fd.key, v)}
              colors={colors}
            />
          ))}
        </View>

        {errorMsg && (
          <View style={s.errorBanner}>
            <Ionicons name="alert-circle" size={16} color={colors.destructive} />
            <Text style={s.errorText}>{errorMsg}</Text>
          </View>
        )}

        {/* Push button */}
        <Pressable
          style={[s.pushBtn, pushMutation.isPending && s.pushBtnDisabled]}
          onPress={handlePush}
          disabled={pushMutation.isPending}
          testID="push-button"
        >
          {pushMutation.isPending ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <>
              <Ionicons name="send" size={18} color={colors.primaryForeground} />
              <Text style={s.pushBtnText}>Push to InsurRouter</Text>
            </>
          )}
        </Pressable>

        <View style={{ height: 24 }} />
      </ScrollView>
    </View>
  );
}

const styles = (colors: ReturnType<typeof useColors>, insets: ReturnType<typeof useSafeAreaInsets>) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background,
      paddingTop: Platform.OS === 'web' ? 67 : insets.top,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.border,
      backgroundColor: colors.card,
    },
    backBtn: {
      width: 36,
      height: 36,
      borderRadius: 18,
      justifyContent: 'center',
      alignItems: 'center',
      backgroundColor: colors.secondary,
    },
    headerTitle: {
      fontSize: 18,
      fontWeight: '700' as const,
      color: colors.foreground,
      fontFamily: 'Inter_700Bold',
    },
    headerSub: {
      fontSize: 12,
      color: colors.amber,
      fontFamily: 'Inter_400Regular',
      marginTop: 2,
    },
    scrollContent: {
      padding: 16,
    },
    section: {
      marginBottom: 20,
    },
    sectionHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      marginBottom: 10,
    },
    sectionTitle: {
      fontSize: 14,
      fontWeight: '600' as const,
      color: colors.foreground,
      fontFamily: 'Inter_600SemiBold',
    },
    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 12,
      padding: 12,
      backgroundColor: '#fef2f2',
      borderRadius: 8,
      borderWidth: 1,
      borderColor: '#fecaca',
    },
    errorText: {
      flex: 1,
      fontSize: 13,
      color: colors.destructive,
      fontFamily: 'Inter_400Regular',
    },
    pushBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingVertical: 16,
      marginTop: 8,
      shadowColor: colors.primary,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 8,
      elevation: 4,
    },
    pushBtnDisabled: {
      opacity: 0.6,
    },
    pushBtnText: {
      fontSize: 16,
      fontWeight: '600' as const,
      color: colors.primaryForeground,
      fontFamily: 'Inter_600SemiBold',
    },
  });
