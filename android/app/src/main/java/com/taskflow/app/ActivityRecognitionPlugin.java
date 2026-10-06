package com.taskflow.app;

import android.Manifest;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.location.ActivityRecognition;
import com.google.android.gms.location.ActivityRecognitionClient;

@CapacitorPlugin(
    name = "ActivityRecognition",
    permissions = @Permission(strings = { Manifest.permission.ACTIVITY_RECOGNITION }, alias = "activityRecognition")
)
public class ActivityRecognitionPlugin extends Plugin {
    private static final long UPDATE_INTERVAL_MS = 60_000L;
    private static final String PREFERENCES = "taskflow_activity_recognition";
    private ActivityRecognitionClient client;

    @PluginMethod
    public void startUpdates(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            && getPermissionState("activityRecognition") != PermissionState.GRANTED) {
            requestPermissionForAlias("activityRecognition", call, "activityPermissionCallback");
            return;
        }
        requestActivityUpdates(call);
    }

    @PermissionCallback
    private void activityPermissionCallback(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
            && getPermissionState("activityRecognition") != PermissionState.GRANTED) {
            call.reject("Physical activity permission was not granted.");
            return;
        }
        requestActivityUpdates(call);
    }

    private void requestActivityUpdates(PluginCall call) {
        try {
            client = ActivityRecognition.getClient(getContext());
            client.requestActivityUpdates(UPDATE_INTERVAL_MS, activityPendingIntent())
                .addOnSuccessListener(ignored -> call.resolve(readLastActivity()))
                .addOnFailureListener(error -> call.reject("Unable to start physical activity recognition.", error));
        } catch (Exception error) {
            call.reject("Unable to start physical activity recognition.", error);
        }
    }

    @PluginMethod
    public void getCurrentActivity(PluginCall call) {
        call.resolve(readLastActivity());
    }

    @PluginMethod
    public void stopUpdates(PluginCall call) {
        try {
            if (client == null) client = ActivityRecognition.getClient(getContext());
            client.removeActivityUpdates(activityPendingIntent())
                .addOnSuccessListener(ignored -> call.resolve())
                .addOnFailureListener(error -> call.reject("Unable to stop physical activity recognition.", error));
        } catch (Exception error) {
            call.reject("Unable to stop physical activity recognition.", error);
        }
    }

    private PendingIntent activityPendingIntent() {
        Intent intent = new Intent(getContext(), ActivityRecognitionReceiver.class);
        intent.setAction(getContext().getPackageName() + ".ACTIVITY_RECOGNITION");
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags |= PendingIntent.FLAG_MUTABLE;
        return PendingIntent.getBroadcast(getContext(), 2107, intent, flags);
    }

    private JSObject readLastActivity() {
        SharedPreferences preferences = getContext().getSharedPreferences(PREFERENCES, 0);
        JSObject result = new JSObject();
        result.put("type", preferences.getString("type", "unknown"));
        result.put("confidence", preferences.getInt("confidence", 0));
        result.put("updated_at", preferences.getLong("updated_at", 0));
        return result;
    }
}