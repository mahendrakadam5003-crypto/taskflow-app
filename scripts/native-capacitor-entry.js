import { Capacitor, registerPlugin } from '@capacitor/core';
import { AndroidBiometryStrength, BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { Geolocation } from '@capacitor/geolocation';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Haptics } from '@capacitor/haptics';
import { App } from '@capacitor/app';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Browser } from '@capacitor/browser';
import { PushNotifications } from '@capacitor/push-notifications';

const ActivityRecognition = registerPlugin('ActivityRecognition');
const AppDevice = registerPlugin('AppDevice');
const BackgroundLocation = registerPlugin('BackgroundLocation');

window.TaskFlowBiometricAuth = BiometricAuth;
window.TaskFlowAndroidBiometryStrength = AndroidBiometryStrength;
window.TaskFlowGeolocation = Geolocation;
window.TaskFlowCamera = Camera;
window.TaskFlowCameraResultType = CameraResultType;
window.TaskFlowCameraSource = CameraSource;
window.TaskFlowHaptics = Haptics;
window.TaskFlowApp = App;
window.TaskFlowLocalNotifications = LocalNotifications;
window.TaskFlowBrowser = Browser;
window.TaskFlowPushNotifications = PushNotifications;
window.TaskFlowActivityRecognition = ActivityRecognition;
window.TaskFlowAppDevice = AppDevice;
window.TaskFlowBackgroundLocation = BackgroundLocation;
window.Capacitor = Capacitor;