import { Capacitor } from '@capacitor/core';
import { BiometricAuth } from '@aparajita/capacitor-biometric-auth';
import { Geolocation } from '@capacitor/geolocation';

window.TaskFlowBiometricAuth = BiometricAuth;
window.TaskFlowGeolocation = Geolocation;
window.Capacitor = Capacitor;