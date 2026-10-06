package com.taskflow.app;

import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "AppDevice")
public class AppDevicePlugin extends Plugin {
    @PluginMethod
    public void getIdentity(PluginCall call) {
        String deviceId = Settings.Secure.getString(
            getContext().getContentResolver(),
            Settings.Secure.ANDROID_ID
        );
        if (deviceId == null || deviceId.trim().isEmpty()) {
            call.reject("Unable to identify this Android device.");
            return;
        }

        JSObject identity = new JSObject();
        identity.put("device_id", deviceId);
        identity.put("manufacturer", Build.MANUFACTURER == null ? "Android" : Build.MANUFACTURER.trim());
        identity.put("model", Build.MODEL == null ? "Device" : Build.MODEL.trim());
        call.resolve(identity);
    }
}