import { Capacitor } from '@capacitor/core';
import { AndroidBiometryStrength, BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { Geolocation } from '@capacitor/geolocation';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Haptics } from '@capacitor/haptics';

window.TaskFlowBiometricAuth = BiometricAuth;
window.TaskFlowAndroidBiometryStrength = AndroidBiometryStrength;
window.TaskFlowGeolocation = Geolocation;
window.TaskFlowCamera = Camera;
window.TaskFlowCameraResultType = CameraResultType;
window.TaskFlowCameraSource = CameraSource;
window.TaskFlowHaptics = Haptics;
window.Capacitor = Capacitor;