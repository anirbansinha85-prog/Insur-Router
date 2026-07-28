import React, { useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { setIngestResult } from '@/store/ingest';
import { useIngestOcr } from '@workspace/api-client-react';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export default function CaptureScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<'idle' | 'processing'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const ocrMutation = useIngestOcr();

  const buttonScale = useSharedValue(1);
  const buttonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: buttonScale.value }],
  }));

  const handleCapture = async () => {
    setErrorMsg(null);

    // Request permissions
    if (Platform.OS !== 'web') {
      const { status: camStatus } = await ImagePicker.requestCameraPermissionsAsync();
      if (camStatus !== 'granted') {
        setErrorMsg('Camera permission is required to capture RC books.');
        return;
      }
    }

    let imageBase64: string | undefined;
    let mimeType = 'image/jpeg';

    try {
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images'],
        quality: 0.8,
        base64: true,
        allowsEditing: false,
      });

      if (result.canceled || !result.assets?.[0]) return;

      const asset = result.assets[0];
      imageBase64 = asset.base64 ?? undefined;
      if (asset.mimeType) mimeType = asset.mimeType;
    } catch {
      // On web, fall back to image picker
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        quality: 0.8,
        base64: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      imageBase64 = asset.base64 ?? undefined;
      if (asset.mimeType) mimeType = asset.mimeType;
    }

    if (!imageBase64) {
      setErrorMsg('Could not read image data. Please try again.');
      return;
    }

    setStatus('processing');
    await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    ocrMutation.mutate(
      { data: { imageBase64, mimeType, model: 'stub' } },
      {
        onSuccess: (data) => {
          setIngestResult(data);
          setStatus('idle');
          router.push('/review');
        },
        onError: (err) => {
          setStatus('idle');
          const msg = err instanceof Error ? err.message : 'OCR failed. Please try again.';
          setErrorMsg(msg);
        },
      },
    );
  };

  const onPressIn = () => {
    buttonScale.value = withSpring(0.93, { damping: 15 });
  };
  const onPressOut = () => {
    buttonScale.value = withSpring(1, { damping: 15 });
  };

  const s = styles(colors, insets);

  return (
    <View style={s.root}>
      {/* Header */}
      <View style={s.header}>
        <View style={s.logoRow}>
          <Ionicons name="document-text" size={28} color={colors.primary} />
          <Text style={s.logoText}>RC Capture</Text>
        </View>
        <Text style={s.subtitle}>Photograph RC books &amp; dealer invoices</Text>
      </View>

      {/* Viewfinder graphic */}
      <View style={s.viewfinderArea}>
        <View style={s.viewfinder}>
          <View style={[s.corner, s.cornerTL]} />
          <View style={[s.corner, s.cornerTR]} />
          <View style={[s.corner, s.cornerBL]} />
          <View style={[s.corner, s.cornerBR]} />
          {status === 'processing' ? (
            <View style={s.processingOverlay}>
              <ActivityIndicator size="large" color={colors.primary} />
              <Text style={s.processingText}>Extracting fields…</Text>
            </View>
          ) : (
            <View style={s.viewfinderHint}>
              <Ionicons name="scan-outline" size={48} color={colors.primary} style={{ opacity: 0.6 }} />
              <Text style={s.hintText}>Align the RC book within the frame</Text>
            </View>
          )}
        </View>
      </View>

      {/* Tips */}
      <View style={s.tipsRow}>
        {[
          { icon: 'sunny-outline' as const, label: 'Good lighting' },
          { icon: 'hand-left-outline' as const, label: 'Hold steady' },
          { icon: 'text-outline' as const, label: 'All text visible' },
        ].map(({ icon, label }) => (
          <View key={label} style={s.tip}>
            <Ionicons name={icon} size={16} color={colors.mutedForeground} />
            <Text style={s.tipLabel}>{label}</Text>
          </View>
        ))}
      </View>

      {/* Error */}
      {errorMsg && (
        <View style={s.errorBanner}>
          <Ionicons name="alert-circle" size={16} color={colors.destructive} />
          <Text style={s.errorText}>{errorMsg}</Text>
        </View>
      )}

      {/* Capture button */}
      <View style={s.captureRow}>
        <AnimatedPressable
          style={[s.captureBtn, buttonStyle, status === 'processing' && s.captureBtnDisabled]}
          onPress={handleCapture}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          disabled={status === 'processing'}
          testID="capture-button"
        >
          {status === 'processing' ? (
            <ActivityIndicator color={colors.primaryForeground} />
          ) : (
            <Ionicons name="camera" size={32} color={colors.primaryForeground} />
          )}
        </AnimatedPressable>
        {Platform.OS === 'web' && (
          <Text style={s.webNote}>On web: pick an image from your library</Text>
        )}
      </View>
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
    header: {
      paddingHorizontal: 24,
      paddingTop: 20,
      paddingBottom: 12,
    },
    logoRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginBottom: 4,
    },
    logoText: {
      fontSize: 24,
      fontWeight: '700' as const,
      color: colors.foreground,
      fontFamily: 'Inter_700Bold',
    },
    subtitle: {
      fontSize: 14,
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
    },
    viewfinderArea: {
      flex: 1,
      paddingHorizontal: 24,
      paddingVertical: 16,
      justifyContent: 'center',
    },
    viewfinder: {
      aspectRatio: 1.4,
      borderRadius: 12,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      overflow: 'hidden',
      justifyContent: 'center',
      alignItems: 'center',
      position: 'relative',
    },
    corner: {
      position: 'absolute',
      width: 24,
      height: 24,
      borderColor: colors.primary,
      borderWidth: 3,
    },
    cornerTL: { top: 12, left: 12, borderBottomWidth: 0, borderRightWidth: 0, borderTopLeftRadius: 4 },
    cornerTR: { top: 12, right: 12, borderBottomWidth: 0, borderLeftWidth: 0, borderTopRightRadius: 4 },
    cornerBL: { bottom: 12, left: 12, borderTopWidth: 0, borderRightWidth: 0, borderBottomLeftRadius: 4 },
    cornerBR: { bottom: 12, right: 12, borderTopWidth: 0, borderLeftWidth: 0, borderBottomRightRadius: 4 },
    viewfinderHint: {
      alignItems: 'center',
      gap: 12,
    },
    hintText: {
      fontSize: 14,
      color: colors.mutedForeground,
      textAlign: 'center',
      fontFamily: 'Inter_400Regular',
    },
    processingOverlay: {
      alignItems: 'center',
      gap: 12,
    },
    processingText: {
      fontSize: 14,
      color: colors.primary,
      fontFamily: 'Inter_500Medium',
    },
    tipsRow: {
      flexDirection: 'row',
      justifyContent: 'center',
      gap: 24,
      paddingHorizontal: 24,
      paddingBottom: 20,
    },
    tip: {
      alignItems: 'center',
      gap: 4,
    },
    tipLabel: {
      fontSize: 11,
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
    },
    errorBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginHorizontal: 24,
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
    captureRow: {
      alignItems: 'center',
      paddingHorizontal: 24,
      gap: 8,
    },
    captureBtn: {
      width: 72,
      height: 72,
      borderRadius: 36,
      backgroundColor: colors.primary,
      justifyContent: 'center',
      alignItems: 'center',
      shadowColor: colors.primary,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.35,
      shadowRadius: 12,
      elevation: 6,
    },
    captureBtnDisabled: {
      opacity: 0.6,
    },
    webNote: {
      fontSize: 12,
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
      textAlign: 'center',
    },
  });
