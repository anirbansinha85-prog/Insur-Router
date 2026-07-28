import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useColors } from '@/hooks/useColors';

export type TabName = 'capture' | 'history';

interface Props {
  active: TabName;
}

const TABS: { name: TabName; label: string; icon: keyof typeof Ionicons.glyphMap; iconActive: keyof typeof Ionicons.glyphMap }[] = [
  { name: 'capture', label: 'Capture', icon: 'camera-outline', iconActive: 'camera' },
  { name: 'history', label: 'History', icon: 'time-outline', iconActive: 'time' },
];

export function BottomTabBar({ active }: Props) {
  const colors = useColors();
  const insets = useSafeAreaInsets();

  const handlePress = (tab: TabName) => {
    if (tab === active) return;
    if (tab === 'capture') {
      router.replace('/');
    } else {
      router.replace('/history');
    }
  };

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: colors.card,
          borderTopColor: colors.border,
          paddingBottom: Platform.OS === 'web' ? 8 : insets.bottom,
        },
      ]}
    >
      {TABS.map((tab) => {
        const isActive = tab.name === active;
        return (
          <Pressable
            key={tab.name}
            style={styles.tab}
            onPress={() => handlePress(tab.name)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
          >
            <Ionicons
              name={isActive ? tab.iconActive : tab.icon}
              size={22}
              color={isActive ? colors.primary : colors.mutedForeground}
            />
            <Text
              style={[
                styles.label,
                {
                  color: isActive ? colors.primary : colors.mutedForeground,
                  fontFamily: isActive ? 'Inter_600SemiBold' : 'Inter_400Regular',
                },
              ]}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    paddingTop: 8,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    gap: 3,
    paddingVertical: 4,
  },
  label: {
    fontSize: 11,
  },
});
