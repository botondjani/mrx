import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import { notifyEvent, type GameEvent } from './notifications';
import { supabase } from './supabase';

const TASK = 'mrx-location';
const GAME_KEY = 'tracking.gameId';
const LOG_KEY = 'tracking.log';
const LOG_MAX = 300;

let logBuffer: string[] | null = null;
// GPS runs at the fast interval; reports are throttled to what the server asks for
// (restarting location updates from the background is not allowed on Android 12+).
let sendIntervalMs = 10_000;
let lastSentAt = 0;

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
  // Tolerance of half a fast GPS tick so a 10 s target does not slip to 12 s.
  if (Date.now() - lastSentAt < sendIntervalMs - 1500) return;
  lastSentAt = Date.now();

  await supabase.auth.getSession(); // refreshes an expired token
  const locations = data.locations.slice(-1).map((l) => ({
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
  const acc = Math.round(locations[0].accuracy ?? -1);
  const events: GameEvent[] = res?.events ?? [];
  if (res?.next_interval_ms) sendIntervalMs = res.next_interval_ms;
  await appendLog(`elküldve (±${acc} m)${events.length ? ' – ' + events.map((e) => e.kind).join(', ') : ''}`);
  for (const e of events) await notifyEvent(e);
  if (res?.game_status === 'finished') await stopTracking();
});

/** gpsIntervalMs: the fastest report interval the server may ask for. */
export async function startTracking(gameId: string, gpsIntervalMs: number, reportIntervalMs: number) {
  if ((await AsyncStorage.getItem(GAME_KEY)) === gameId && (await Location.hasStartedLocationUpdatesAsync(TASK))) return;
  sendIntervalMs = reportIntervalMs;
  await AsyncStorage.setItem(GAME_KEY, gameId);
  if (await Location.hasStartedLocationUpdatesAsync(TASK)) await Location.stopLocationUpdatesAsync(TASK);
  await Location.startLocationUpdatesAsync(TASK, {
    accuracy: Location.Accuracy.High,
    timeInterval: gpsIntervalMs,
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
  await appendLog(`követés indult (GPS ${gpsIntervalMs / 1000} s, küldés ${reportIntervalMs / 1000} s)`);
}

export async function stopTracking() {
  await AsyncStorage.removeItem(GAME_KEY);
  if (await Location.hasStartedLocationUpdatesAsync(TASK)) await Location.stopLocationUpdatesAsync(TASK);
  await appendLog('követés leállt');
}
