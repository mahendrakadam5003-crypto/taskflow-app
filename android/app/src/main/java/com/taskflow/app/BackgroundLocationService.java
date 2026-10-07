package com.taskflow.app;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.IBinder;
import android.os.Looper;
import android.os.ResultReceiver;
import android.webkit.CookieManager;
import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;
import com.google.android.gms.location.FusedLocationProviderClient;
import com.google.android.gms.location.LocationCallback;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationResult;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.Priority;
import java.io.BufferedReader;
import java.io.OutputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.TimeZone;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class BackgroundLocationService extends Service {
    public static final String ACTION_START = "com.taskflow.app.BACKGROUND_LOCATION_START";
    public static final String ACTION_STOP = "com.taskflow.app.BACKGROUND_LOCATION_STOP";
    private static final String CHANNEL_ID = "taskflow-shift-tracking";
    private static final int NOTIFICATION_ID = 7301;
    private static final String PREFS = "taskflow_background_location";
    private static final String QUEUE_KEY = "queued_points";
    private static final String STATUS_QUEUE_KEY = "queued_tracking_states";
    private final ExecutorService networkExecutor = Executors.newSingleThreadExecutor();
    private FusedLocationProviderClient locationClient;
    private LocationCallback locationCallback;
    private SharedPreferences preferences;
    private String serverUrl;
    private String deviceId;
    private String deviceModel;
    private String shiftDate;
    private String sessionCookie;
    private String lastReportedState;
    private boolean stopping;
    private ResultReceiver pendingStopReceiver;

    @Override
    public void onCreate() {
        super.onCreate();
        preferences = getSharedPreferences(PREFS, MODE_PRIVATE);
        locationClient = LocationServices.getFusedLocationProviderClient(this);
        createNotificationChannel();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            serverUrl = preferences.getString("server_url", null);
            deviceId = preferences.getString("device_id", null);
            deviceModel = preferences.getString("device_model", null);
            shiftDate = preferences.getString("shift_date", null);
            String currentCookie = CookieManager.getInstance().getCookie(serverUrl == null ? "" : serverUrl);
            if (currentCookie != null && !currentCookie.isEmpty()) sessionCookie = currentCookie;
            pendingStopReceiver = intent.getParcelableExtra("stop_callback");
            stopTracking();
            return START_NOT_STICKY;
        }
        if (intent != null && ACTION_START.equals(intent.getAction())) {
            serverUrl = intent.getStringExtra("server_url");
            deviceId = intent.getStringExtra("device_id");
            deviceModel = intent.getStringExtra("device_model");
            shiftDate = intent.getStringExtra("shift_date");
            sessionCookie = intent.getStringExtra("session_cookie");
            preferences.edit()
                .putString("server_url", serverUrl)
                .putString("device_id", deviceId)
                .putString("device_model", deviceModel)
                .putString("shift_date", shiftDate)
                .putBoolean("tracking_active", true)
                .apply();
        } else {
            if (!preferences.getBoolean("tracking_active", false)) {
                stopSelf();
                return START_NOT_STICKY;
            }
            serverUrl = preferences.getString("server_url", null);
            deviceId = preferences.getString("device_id", null);
            deviceModel = preferences.getString("device_model", null);
            shiftDate = preferences.getString("shift_date", null);
            sessionCookie = CookieManager.getInstance().getCookie(serverUrl == null ? "" : serverUrl);
        }
        if (serverUrl == null || deviceId == null || shiftDate == null || sessionCookie == null) {
            preferences.edit().putBoolean("tracking_active", false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }

        startForeground(NOTIFICATION_ID, trackingNotification());
        if (!hasBackgroundLocationPermission()) {
            reportState("location_denied");
            preferences.edit().putBoolean("tracking_active", false).apply();
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!isLocationEnabled()) reportState("gps_off");
        else if (!isNetworkAvailable()) reportState("offline");
        else reportState("restored");
        networkExecutor.execute(() -> {
            try {
                if (!serverShiftIsActive()) {
                    stopTracking();
                    return;
                }
            } catch (Exception error) {
                reportState("offline");
            }
            if (preferences.getBoolean("tracking_active", false)) startLocationUpdates();
        });
        return START_STICKY;
    }

    private void startLocationUpdates() {
        if (locationCallback != null || !hasBackgroundLocationPermission()) return;
        LocationRequest request = new LocationRequest.Builder(Priority.PRIORITY_BALANCED_POWER_ACCURACY, 5 * 60_000L)
            .setMinUpdateIntervalMillis(2 * 60_000L)
            .setMinUpdateDistanceMeters(0)
            .build();
        locationCallback = new LocationCallback() {
            @Override
            public void onLocationResult(LocationResult result) {
                Location location = result.getLastLocation();
                if (location == null) return;
                networkExecutor.execute(() -> {
                    if (!preferences.getBoolean("tracking_active", false)) return;
                    try {
                        if (!serverShiftIsActive()) {
                            stopTracking();
                            return;
                        }
                    } catch (Exception error) {
                        reportState("offline");
                    }
                    if (!preferences.getBoolean("tracking_active", false)) return;
                    queuePoint(location);
                    if (!isNetworkAvailable()) reportState("offline");
                    else {
                        reportState("restored");
                        flushQueuedPoints();
                    }
                });
            }
        };
        try {
            locationClient.requestLocationUpdates(request, locationCallback, Looper.getMainLooper())
                .addOnFailureListener(error -> {
                    reportState("location_denied");
                    preferences.edit().putBoolean("tracking_active", false).apply();
                    stopSelf();
                });
        } catch (SecurityException error) {
            reportState("location_denied");
            preferences.edit().putBoolean("tracking_active", false).apply();
            stopSelf();
        }
    }

    private void queuePoint(Location location) {
        try {
            JSONArray queue = new JSONArray(preferences.getString(QUEUE_KEY, "[]"));
            if (queue.length() >= 1000) {
                reportState("offline_queue_full");
                return;
            }
            SharedPreferences activity = getSharedPreferences("taskflow_activity_recognition", MODE_PRIVATE);
            long activityAge = System.currentTimeMillis() - activity.getLong("updated_at", 0);
            boolean activityFresh = activityAge >= 0 && activityAge <= 10 * 60_000L;
            JSONObject point = new JSONObject();
            point.put("client_point_id", UUID.randomUUID().toString());
            point.put("shift_date", shiftDate);
            point.put("recorded_at", timestamp(location.getTime()));
            point.put("lat", location.getLatitude());
            point.put("lng", location.getLongitude());
            point.put("activity_type", activityFresh ? activity.getString("type", "unknown") : "unknown");
            point.put("activity_confidence", activityFresh ? activity.getInt("confidence", 0) : 0);
            queue.put(point);
            preferences.edit().putString(QUEUE_KEY, queue.toString()).apply();
        } catch (JSONException error) {
            reportState("location_denied");
        }
    }

    private boolean flushQueuedPoints() {
        while (true) {
            try {
                JSONArray queue = new JSONArray(preferences.getString(QUEUE_KEY, "[]"));
                if (queue.length() == 0) return true;
                String batchDate = queue.optJSONObject(0) == null
                    ? shiftDate
                    : queue.optJSONObject(0).optString("shift_date", shiftDate);
                JSONArray batch = new JSONArray();
                Set<String> uploadedIds = new HashSet<>();
                for (int i = 0; i < queue.length() && batch.length() < 100; i++) {
                    JSONObject point = queue.optJSONObject(i);
                    if (point == null || !batchDate.equals(point.optString("shift_date", shiftDate))) continue;
                    JSONObject requestPoint = new JSONObject(point.toString());
                    requestPoint.remove("shift_date");
                    batch.put(requestPoint);
                    uploadedIds.add(point.optString("client_point_id"));
                }
                if (batch.length() == 0) return false;
                JSONObject payload = new JSONObject();
                payload.put("device_id", deviceId);
                payload.put("device_model", deviceModel);
                payload.put("shift_date", batchDate);
                payload.put("points", batch);
                JSONObject response = postJson("/api/attendance/location-updates", payload);
                if (!response.optBoolean("ok")) return false;

                JSONArray remaining = new JSONArray();
                JSONArray currentQueue = new JSONArray(preferences.getString(QUEUE_KEY, "[]"));
                for (int i = 0; i < currentQueue.length(); i++) {
                    JSONObject point = currentQueue.optJSONObject(i);
                    if (point == null || !uploadedIds.contains(point.optString("client_point_id"))) {
                        if (point != null) remaining.put(point);
                    }
                }
                preferences.edit().putString(QUEUE_KEY, remaining.toString()).commit();
            } catch (Exception error) {
                reportState("offline");
                return false;
            }
        }
    }

    private void reportState(String state) {
        if (state.equals(lastReportedState)) return;
        lastReportedState = state;
        try {
            JSONArray queue = new JSONArray(preferences.getString(STATUS_QUEUE_KEY, "[]"));
            JSONObject event = new JSONObject();
            event.put("state", state);
            event.put("at", timestamp(System.currentTimeMillis()));
            queue.put(event);
            while (queue.length() > 50) {
                JSONArray trimmed = new JSONArray();
                for (int i = queue.length() - 50; i < queue.length(); i++) trimmed.put(queue.getJSONObject(i));
                queue = trimmed;
            }
            preferences.edit().putString(STATUS_QUEUE_KEY, queue.toString()).commit();
            networkExecutor.execute(this::flushQueuedTrackingStates);
        } catch (JSONException error) {
            lastReportedState = null;
            android.util.Log.e("TaskFlowTracking", "Unable to queue tracking status.", error);
        }
    }

    private void flushQueuedTrackingStates() {
        while (true) {
            try {
                JSONArray queue = new JSONArray(preferences.getString(STATUS_QUEUE_KEY, "[]"));
                if (queue.length() == 0) return;
                JSONObject event = queue.getJSONObject(0);
                try {
                    postJson("/api/attendance/tracking-status", event);
                } catch (Exception error) {
                    if (error.getMessage() == null || !error.getMessage().contains("HTTP 400")) return;
                }
                JSONArray currentQueue = new JSONArray(preferences.getString(STATUS_QUEUE_KEY, "[]"));
                if (currentQueue.length() > 0
                    && event.optString("at").equals(currentQueue.getJSONObject(0).optString("at"))) {
                    JSONArray remaining = new JSONArray();
                    for (int i = 1; i < currentQueue.length(); i++) remaining.put(currentQueue.getJSONObject(i));
                    preferences.edit().putString(STATUS_QUEUE_KEY, remaining.toString()).commit();
                }
            } catch (Exception error) {
                android.util.Log.e("TaskFlowTracking", "Unable to upload queued tracking status.", error);
                return;
            }
        }
    }

    private JSONObject postJson(String path, JSONObject payload) throws Exception {
        String cookie = CookieManager.getInstance().getCookie(serverUrl);
        if (cookie != null && !cookie.isEmpty()) sessionCookie = cookie;
        if (sessionCookie == null || sessionCookie.isEmpty()) throw new IllegalStateException("TaskFlow session is unavailable.");
        HttpURLConnection connection = (HttpURLConnection) new URL(serverUrl + path).openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(15_000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Content-Type", "application/json");
        connection.setRequestProperty("Cookie", sessionCookie);
        connection.setRequestProperty("User-Agent", "TaskFlowNative/1");
        byte[] body = payload.toString().getBytes(StandardCharsets.UTF_8);
        try (OutputStream output = connection.getOutputStream()) {
            output.write(body);
        }
        int status = connection.getResponseCode();
        BufferedReader reader = new BufferedReader(new InputStreamReader(
            status >= 400 ? connection.getErrorStream() : connection.getInputStream(), StandardCharsets.UTF_8));
        StringBuilder response = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) response.append(line);
        reader.close();
        connection.disconnect();
        if (status == 401 || status == 403) {
            stopTracking();
            throw new IllegalStateException("TaskFlow session is no longer authorized for tracking.");
        }
        if (status < 200 || status >= 300) throw new IllegalStateException("Tracking server returned HTTP " + status);
        return new JSONObject(response.toString());
    }

    private boolean serverShiftIsActive() throws Exception {
        JSONObject status = getJson("/api/attendance/today");
        return shiftDate != null
            && shiftDate.equals(status.optString("date"))
            && !status.isNull("punch_in")
            && status.isNull("punch_out");
    }

    private JSONObject getJson(String path) throws Exception {
        String cookie = CookieManager.getInstance().getCookie(serverUrl);
        if (cookie != null && !cookie.isEmpty()) sessionCookie = cookie;
        if (sessionCookie == null || sessionCookie.isEmpty()) throw new IllegalStateException("TaskFlow session is unavailable.");
        HttpURLConnection connection = (HttpURLConnection) new URL(serverUrl + path).openConnection();
        connection.setRequestMethod("GET");
        connection.setConnectTimeout(10_000);
        connection.setReadTimeout(15_000);
        connection.setRequestProperty("Cookie", sessionCookie);
        connection.setRequestProperty("User-Agent", "TaskFlowNative/1");
        int status = connection.getResponseCode();
        if (status == 401 || status == 403) {
            connection.disconnect();
            stopTracking();
            throw new IllegalStateException("TaskFlow session is no longer authorized for tracking.");
        }
        BufferedReader reader = new BufferedReader(new InputStreamReader(
            status >= 400 ? connection.getErrorStream() : connection.getInputStream(), StandardCharsets.UTF_8));
        StringBuilder response = new StringBuilder();
        String line;
        while ((line = reader.readLine()) != null) response.append(line);
        reader.close();
        connection.disconnect();
        if (status < 200 || status >= 300) throw new IllegalStateException("Tracking server returned HTTP " + status);
        if ("null".equals(response.toString().trim())) return new JSONObject();
        return new JSONObject(response.toString());
    }

    private boolean hasBackgroundLocationPermission() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isLocationEnabled() {
        LocationManager manager = (LocationManager) getSystemService(LOCATION_SERVICE);
        return manager != null && manager.isLocationEnabled();
    }

    private boolean isNetworkAvailable() {
        ConnectivityManager manager = (ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
        if (manager == null) return false;
        android.net.Network network = manager.getActiveNetwork();
        NetworkCapabilities capabilities = network == null ? null : manager.getNetworkCapabilities(network);
        return capabilities != null && capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET);
    }

    private Notification trackingNotification() {
        Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pendingIntent = PendingIntent.getActivity(this, 0, launch,
            PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0));
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("TaskFlow shift tracking is on")
            .setContentText("Location is recorded only during your active shift. Punch out to stop.")
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Active shift tracking", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Visible while TaskFlow records location during an active attendance shift.");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private String timestamp(long milliseconds) {
        SimpleDateFormat format = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        format.setTimeZone(TimeZone.getTimeZone("UTC"));
        return format.format(new Date(milliseconds));
    }

    private void stopTracking() {
        if (stopping) return;
        stopping = true;
        if (locationCallback != null) {
            locationClient.removeLocationUpdates(locationCallback);
            locationCallback = null;
        }
        preferences.edit().putBoolean("tracking_active", false).commit();
        networkExecutor.execute(() -> {
            boolean flushed = flushQueuedPoints();
            flushQueuedTrackingStates();
            android.os.Handler mainHandler = new android.os.Handler(Looper.getMainLooper());
            mainHandler.post(() -> {
                if (pendingStopReceiver != null) {
                    android.os.Bundle result = new android.os.Bundle();
                    result.putBoolean("flushed", flushed);
                    pendingStopReceiver.send(0, result);
                    pendingStopReceiver = null;
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
                else stopForeground(true);
                stopSelf();
            });
        });
    }

    @Override
    public void onDestroy() {
        if (locationCallback != null) locationClient.removeLocationUpdates(locationCallback);
        networkExecutor.shutdown();
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
