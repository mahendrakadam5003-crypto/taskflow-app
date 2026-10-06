package com.taskflow.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import com.google.android.gms.location.ActivityRecognitionResult;
import com.google.android.gms.location.DetectedActivity;

public class ActivityRecognitionReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ActivityRecognitionResult.hasResult(intent)) return;
        DetectedActivity activity = ActivityRecognitionResult.extractResult(intent).getMostProbableActivity();
        if (activity == null) return;
        SharedPreferences preferences = context.getSharedPreferences("taskflow_activity_recognition", 0);
        preferences.edit()
            .putString("type", activityName(activity.getType()))
            .putInt("confidence", activity.getConfidence())
            .putLong("updated_at", System.currentTimeMillis())
            .apply();
    }

    private String activityName(int type) {
        switch (type) {
            case DetectedActivity.IN_VEHICLE: return "in_vehicle";
            case DetectedActivity.ON_BICYCLE: return "on_bicycle";
            case DetectedActivity.WALKING: return "walking";
            case DetectedActivity.RUNNING: return "running";
            case DetectedActivity.ON_FOOT: return "on_foot";
            case DetectedActivity.STILL: return "still";
            case DetectedActivity.TILTING: return "tilting";
            default: return "unknown";
        }
    }
}