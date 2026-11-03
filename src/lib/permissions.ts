import * as Battery from 'expo-battery';
import * as Location from 'expo-location';
import { Platform } from 'react-native';

export type PermissionStep = 'foreground' | 'background' | 'battery' | 'done';

/** First missing step of the permission flow. */
export async function nextPermissionStep(): Promise<PermissionStep> {
  if (!(await Location.getForegroundPermissionsAsync()).granted) return 'foreground';
  if (!(await Location.getBackgroundPermissionsAsync()).granted) return 'background';
  if (Platform.OS === 'android' && (await Battery.isBatteryOptimizationEnabledAsync())) return 'battery';
  return 'done';
}
