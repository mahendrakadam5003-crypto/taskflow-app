package com.taskflow.app;

import android.Manifest;
import android.content.Intent;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.ResultReceiver;
import android.provider.Settings;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "BackgroundLocation",
    permissions = @Permission(strings = { Manifest.permission.ACCESS_BACKGROUND_LOCATION }, alias = "backgroundLocation")
)
public class BackgroundLocationPlugin extends Plugin {
    @PluginMethod
    public void requestBackgroundPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || getPermissionState("backgroundLocation") == PermissionState.GRANTED) {
            call.resolve(permissionResult());
            return;
        }
        requestPermissionForAlias("backgroundLocation", call, "backgroundPermissionCallback");
    }

    @PermissionCallback
    private void backgroundPermissionCallback(PluginCall call) {
        call.resolve(permissionResult());
    }

    @PluginMethod
    public void getPermissionStatus(PluginCall call) {
        call.resolve(permissionResult());
    }

    @PluginMethod
    public void openAppSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject("Unable to open TaskFlow settings.", error);
        }
    }

    @PluginMethod
    public void startTracking(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            && getPermissionState("backgroundLocation") != PermissionState.GRANTED) {
            call.reject("Allow TaskFlow location access all the time in app settings to enable background shift tracking.", "BACKGROUND_LOCATION_REQUIRED");
            return;
        }
        String serverUrl = call.getString("server_url", "");
        String deviceId = call.getString("device_id", "");
        String deviceModel = call.getString("device_model", "Android device");
        String shiftDate = call.getString("shift_date", "");
        if (!isAllowedServerUrl(serverUrl) || deviceId.isEmpty()
            || !shiftDate.matches("\\d{4}-\\d{2}-\\d{2}")) {
            call.reject("Background tracking setup is incomplete. Reopen TaskFlow and try again.");
            return;
        }
        String cookie = android.webkit.CookieManager.getInstance().getCookie(serverUrl);
        if (cookie == null || cookie.isEmpty()) {
            call.reject("Your TaskFlow session is not available for background tracking. Reopen the app and sign in again.");
            return;
        }
        Intent service = new Intent(getContext(), BackgroundLocationService.class);
        service.setAction(BackgroundLocationService.ACTION_START);
        service.putExtra("server_url", serverUrl);
        service.putExtra("device_id", deviceId);
        service.putExtra("device_model", deviceModel);
        service.putExtra("shift_date", shiftDate);
        service.putExtra("session_cookie", cookie);
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) getContext().startForegroundService(service);
            else getContext().startService(service);
            call.resolve(new JSObject().put("active", true));
        } catch (Exception error) {
            call.reject("Unable to start shift location tracking.", error);
        }
    }

    @PluginMethod
    public void stopTracking(PluginCall call) {
        Intent service = new Intent(getContext(), BackgroundLocationService.class);
        service.setAction(BackgroundLocationService.ACTION_STOP);
        service.putExtra("stop_callback", new ResultReceiver(new Handler(Looper.getMainLooper())) {
            @Override
            protected void onReceiveResult(int resultCode, android.os.Bundle resultData) {
                call.resolve(new JSObject()
                    .put("ok", true)
                    .put("flushed", resultData != null && resultData.getBoolean("flushed", false)));
            }
        });
        try {
            getContext().startService(service);
        } catch (Exception error) {
            call.reject("Unable to stop background location tracking.", error);
        }
    }

    private JSObject permissionResult() {
        boolean granted = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || getPermissionState("backgroundLocation") == PermissionState.GRANTED;
        LocationManager locationManager = (LocationManager) getContext().getSystemService(android.content.Context.LOCATION_SERVICE);
        boolean gpsEnabled = locationManager != null && locationManager.isLocationEnabled();
        boolean active = getContext().getSharedPreferences("taskflow_background_location", android.content.Context.MODE_PRIVATE)
            .getBoolean("tracking_active", false);
        int queuedPoints;
        try {
            queuedPoints = new org.json.JSONArray(getContext()
                .getSharedPreferences("taskflow_background_location", android.content.Context.MODE_PRIVATE)
                .getString("queued_points", "[]")).length();
        } catch (org.json.JSONException error) {
            android.util.Log.e("TaskFlowTracking", "Unable to read queued attendance points.", error);
            queuedPoints = 1000;
        }
        boolean activityEnabled = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            || ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACTIVITY_RECOGNITION) == android.content.pm.PackageManager.PERMISSION_GRANTED;
        return new JSObject()
            .put("always", granted)
            .put("location", granted)
            .put("gps_enabled", gpsEnabled)
            .put("active", active)
            .put("queued_points", queuedPoints)
            .put("notifications_enabled", NotificationManagerCompat.from(getContext()).areNotificationsEnabled())
            .put("activity_enabled", activityEnabled);
    }

    private boolean isAllowedServerUrl(String serverUrl) {
        if (serverUrl == null || !serverUrl.startsWith("https://") || getBridge() == null
            || getBridge().getWebView() == null || getBridge().getWebView().getUrl() == null) return false;
        Uri requested = Uri.parse(serverUrl);
        Uri loaded = Uri.parse(getBridge().getWebView().getUrl());
        return "https".equals(requested.getScheme())
            && requested.getHost() != null
            && requested.getHost().equalsIgnoreCase(loaded.getHost())
            && requested.getPort() == loaded.getPort()
            && requested.getUserInfo() == null
            && requested.getQuery() == null
            && requested.getFragment() == null
            && (requested.getPath().isEmpty() || "/".equals(requested.getPath()));
    }
}
