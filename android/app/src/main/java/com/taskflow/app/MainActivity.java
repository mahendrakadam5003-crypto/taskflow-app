package com.taskflow.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
	@Override
	public void onCreate(Bundle savedInstanceState) {
		registerPlugin(ActivityRecognitionPlugin.class);
		registerPlugin(AppDevicePlugin.class);
		super.onCreate(savedInstanceState);
	}
}
