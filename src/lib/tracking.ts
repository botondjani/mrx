import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { supabase } from './supabase';

const TASK = 'mrx-location';
const GAME_KEY = 'tracking.gameId';
const LOG_KEY = 'tracking.log';
const LOG_MAX = 300;

let logBuffer: string[] | null = null;

/** Device-side log (survives restarts) to verify background reporting. */
export async function appendLog(line: string) {
  if (!logBuffer) logBuffer = JSON.parse((await AsyncStorage.getItem(LOG_KEY)) ?? '[]') as string[];
  const entry = `${new Date().toLocaleTimeString('hu-HU')} ${line}`;
  console.log('[tracking]', entry);
  logBuffer.push(entry);
  if (logBuffer.length > LOG_MAX) logBuffer.splice(0, logBuffer.length - LOG_MAX);
  await AsyncStorage.setItem(LOG_KEY, JSON.stringify(logBuffer));
}

export async function readLog(): Promise<string[]> {
  return JSON.parse((await AsyncStorage.getItem(LOG_KEY)) ?? '[]');
}

TaskManager.defineTask<{ locations: Location.LocationObject[] }>(TASK, async ({ data, error }) => {
  if (error) return appendLog(`GPS hiba: ${error.message}`);
  const gameId = await AsyncStorage.getItem(GAME_KEY);
  if (!gameId || !data?.locations?.length) return;

  await supabase.auth.getSession(); // refreshes an expired token
  const locations = data.locations.map((l) => ({
    lat: l.coords.latitude,
    lng: l.coords.longitude,
    accuracy: l.coords.accuracy,
    speed: l.coords.speed,
    heading: l.coords.heading,
    timestamp: l.timestamp,
  }));
  const { data: res, error: fnError } = await supabase.functions.invoke('report_position', {
    body: { game_id: gameId, locations },
  });
  if (fnError) return appendLog(`küldés sikertelen: ${fnError.message}`);
  const acc = Math.round(locations[locations.length - 1].accuracy ?? -1);
  await appendLog(`elküldve ${locations.length} pozíció (±${acc} m)`);
  if (res?.game_status === 'finished') await stopTracking();
});

export async function startTracking(gameId: string, intervalMs: number) {
  await AsyncStorage.setItem(GAME_KEY, gameId);
  if (await Location.hasStartedLocationUpdatesAsync(TASK)) await Location.stopLocationUpdatesAsync(TASK);
  await Location.startLocationUpdatesAsync(TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: intervalMs,
    distanceInterval: 0,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    activityType: Location.ActivityType.Fitness,
    foregroundService: {
      notificationTitle: 'Játék folyamatban',
      notificationBody: 'Mr. X – a helyzeted megosztása aktív.',
      killServiceOnDestroy: false,
    },
  });
  await appendLog(`követés indult (${intervalMs / 1000} s)`);
}

export async function stopTracking() {
  await AsyncStorage.removeItem(GAME_KEY);
  if (await Location.hasStartedLocationUpdatesAsync(TASK)) await Location.stopLocationUpdatesAsync(TASK);
  await appendLog('követés leállt');
}
