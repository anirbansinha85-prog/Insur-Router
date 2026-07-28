import React, { useEffect } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { getApplicationId, getPushedFields, clearStore } from '@/store/ingest';
import { makeHistoryEntry, appendHistoryEntry } from '@/store/history';

export default function SuccessScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const applicationId = getApplicationId();

  const scale = useSharedValue(0);
  const opacity = useSharedValue(0);
  const cardOpacity = useSharedValue(0);

  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  const cardStyle = useAnimatedStyle(() => ({
    opacity: cardOpacity.value,
    transform: [{ translateY: (1 - cardOpacity.value) * 20 }],
  }));

  useEffect(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    scale.value = withSpring(1, { damping: 12, stiffness: 200 });
    opacity.value = withTiming(1, { duration: 300 });
    cardOpacity.value = withDelay(300, withTiming(1, { duration: 400 }));

    // Persist this capture to history using the post-edit fields actually pushed
    const pushedFields = getPushedFields();
    if (pushedFields) {
      const entry = makeHistoryEntry(pushedFields, applicationId);
      appendHistoryEntry(entry).catch(() => {
        // Non-fatal: history write failure should not affect UX
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCaptureAnother = () => {
    clearStore();
    router.replace('/');
  };

  const s = styles(colors, insets);

  return (
    <View style={s.root}>
      <View style={s.content}>
        {/* Check icon */}
        <Animated.View style={[s.iconWrap, iconStyle]}>
          <View style={[s.iconCircle, { backgroundColor: colors.accent }]}>
            <Ionicons name="checkmark" size={48} color={colors.primary} />
          </View>
        </Animated.View>

        <Animated.View style={[s.textBlock, cardStyle]}>
          <Text style={s.title}>Draft Created!</Text>
          <Text style={s.subtitle}>
            The RC book data has been pushed to InsurRouter successfully.
          </Text>

          {applicationId != null && (
            <View style={[s.idCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
              <Text style={s.idLabel}>Application ID</Text>
              <Text style={s.idValue}>#{applicationId}</Text>
            </View>
          )}

          <View style={[s.noteCard, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
            <Ionicons name="information-circle" size={16} color={colors.primary} />
            <Text style={s.noteText}>
              The draft is now in InsurRouter. Open the web dashboard to review and submit for insurance.
            </Text>
          </View>
        </Animated.View>
      </View>

      <Animated.View style={[s.btns, cardStyle]}>
        <Pressable style={s.primaryBtn} onPress={handleCaptureAnother} testID="capture-another-button">
          <Ionicons name="camera" size={18} color={colors.primaryForeground} />
          <Text style={s.primaryBtnText}>Capture Another</Text>
        </Pressable>
      </Animated.View>
    </View>
  );
}

const styles = (colors: ReturnType<typeof useColors>, insets: ReturnType<typeof useSafeAreaInsets>) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background,
      paddingTop: Platform.OS === 'web' ? 67 : insets.top,
      paddingBottom: Platform.OS === 'web' ? 34 : insets.bottom + 16,
    },
    content: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: 24,
      gap: 28,
    },
    iconWrap: {
      alignItems: 'center',
    },
    iconCircle: {
      width: 96,
      height: 96,
      borderRadius: 48,
      justifyContent: 'center',
      alignItems: 'center',
    },
    textBlock: {
      alignItems: 'center',
      width: '100%',
      gap: 12,
    },
    title: {
      fontSize: 28,
      fontWeight: '700' as const,
      color: colors.foreground,
      fontFamily: 'Inter_700Bold',
      textAlign: 'center',
    },
    subtitle: {
      fontSize: 15,
      color: colors.mutedForeground,
      textAlign: 'center',
      fontFamily: 'Inter_400Regular',
      lineHeight: 22,
    },
    idCard: {
      width: '100%',
      borderWidth: 1,
      borderRadius: 10,
      padding: 16,
      alignItems: 'center',
      gap: 4,
      marginTop: 4,
    },
    idLabel: {
      fontSize: 11,
      fontWeight: '600' as const,
      textTransform: 'uppercase',
      letterSpacing: 0.8,
      color: colors.mutedForeground,
      fontFamily: 'Inter_600SemiBold',
    },
    idValue: {
      fontSize: 32,
      fontWeight: '700' as const,
      color: colors.primary,
      fontFamily: 'Inter_700Bold',
    },
    noteCard: {
      width: '100%',
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
      borderWidth: 1,
      borderRadius: 10,
      padding: 14,
    },
    noteText: {
      flex: 1,
      fontSize: 13,
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
      lineHeight: 19,
    },
    btns: {
      paddingHorizontal: 24,
      gap: 12,
    },
    primaryBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingVertical: 16,
      shadowColor: colors.primary,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 8,
      elevation: 4,
    },
    primaryBtnText: {
      fontSize: 16,
      fontWeight: '600' as const,
      color: colors.primaryForeground,
      fontFamily: 'Inter_600SemiBold',
    },
  });
