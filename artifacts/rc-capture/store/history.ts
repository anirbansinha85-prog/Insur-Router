/**
 * Persistent history of completed RC captures.
 * Records are stored in AsyncStorage and survive app restarts.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MsaFields } from './ingest';

export interface HistoryEntry {
  id: string;
  timestamp: string; // ISO 8601
  vehicleMake: string;
  vehicleModel: string;
  applicationId: number | null;
  fields: MsaFields;
}

const STORAGE_KEY = '@rc_capture_history_v1';

export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as HistoryEntry[];
  } catch {
    return [];
  }
}

export async function appendHistoryEntry(entry: HistoryEntry): Promise<void> {
  const existing = await loadHistory();
  // Prepend so newest is first
  const updated = [entry, ...existing];
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
}

export function makeHistoryEntry(
  fields: MsaFields,
  applicationId: number | null,
): HistoryEntry {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    vehicleMake: fields.vehicleMake,
    vehicleModel: fields.vehicleModel,
    applicationId,
    fields,
  };
}
