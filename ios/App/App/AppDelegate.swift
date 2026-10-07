import UIKit
import Capacitor
import Darwin
import CoreMotion
import CoreLocation
import WebKit
import Security
import CoreFoundation

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        true
    }

    func applicationWillResignActive(_ application: UIApplication) {}
    func applicationDidEnterBackground(_ application: UIApplication) {}
    func applicationWillEnterForeground(_ application: UIApplication) {}
    func applicationDidBecomeActive(_ application: UIApplication) {}
    func applicationWillTerminate(_ application: UIApplication) {}

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }
}

class TaskFlowBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AppDevicePlugin())
        bridge?.registerPluginInstance(ActivityRecognitionPlugin())
        bridge?.registerPluginInstance(BackgroundLocationPlugin())
    }
}

@objc(AppDevicePlugin)
public class AppDevicePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppDevicePlugin"
    public let jsName = "AppDevice"
    public let pluginMethods = [CAPPluginMethod(name: "getIdentity", returnType: CAPPluginReturnPromise)]

    @objc public func getIdentity(_ call: CAPPluginCall) {
        guard let deviceId = UIDevice.current.identifierForVendor?.uuidString else {
            call.reject("Unable to identify this Apple device.")
            return
        }
        var systemInfo = utsname()
        uname(&systemInfo)
        let model = withUnsafePointer(to: &systemInfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: MemoryLayout.size(ofValue: systemInfo.machine)) {
                String(cString: $0)
            }
        }
        call.resolve(["device_id": deviceId, "manufacturer": "Apple", "model": model])
    }
}

@objc(ActivityRecognitionPlugin)
public class ActivityRecognitionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ActivityRecognitionPlugin"
    public let jsName = "ActivityRecognition"
    public let pluginMethods = [
        CAPPluginMethod(name: "startUpdates", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentActivity", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopUpdates", returnType: CAPPluginReturnPromise)
    ]

    private let activityManager = CMMotionActivityManager()
    private var latestActivity: [String: Any]?

    @objc public func startUpdates(_ call: CAPPluginCall) {
        guard CMMotionActivityManager.isActivityAvailable() else {
            call.reject("Physical activity recognition is unavailable on this device.")
            return
        }
        activityManager.startActivityUpdates(to: OperationQueue.main) { [weak self] activity in
            guard let self, let activity else { return }
            let payload = self.activityPayload(activity)
            self.latestActivity = payload
            UserDefaults.standard.set(payload["type"], forKey: "taskflow_latest_activity_type")
            UserDefaults.standard.set(payload["confidence"], forKey: "taskflow_latest_activity_confidence")
            UserDefaults.standard.set(payload["updated_at"], forKey: "taskflow_latest_activity_updated_at")
        }
        call.resolve(latestActivity ?? unknownActivity())
    }

    @objc public func getCurrentActivity(_ call: CAPPluginCall) {
        call.resolve(latestActivity ?? unknownActivity())
    }

    @objc public func stopUpdates(_ call: CAPPluginCall) {
        activityManager.stopActivityUpdates()
        call.resolve()
    }

    private func activityPayload(_ activity: CMMotionActivity) -> [String: Any] {
        let type: String
        if activity.automotive { type = "in_vehicle" }
        else if activity.cycling { type = "on_bicycle" }
        else if activity.running { type = "running" }
        else if activity.walking { type = "walking" }
        else if activity.stationary { type = "still" }
        else { type = "unknown" }

        let confidence: Int
        switch activity.confidence {
        case .low: confidence = 25
        case .medium: confidence = 60
        case .high: confidence = 90
        @unknown default: confidence = 0
        }
        return ["type": type, "confidence": confidence, "updated_at": Int64(Date().timeIntervalSince1970 * 1000)]
    }

    private func unknownActivity() -> [String: Any] {
        ["type": "unknown", "confidence": 0, "updated_at": 0]
    }
}

@objc(BackgroundLocationPlugin)
public class BackgroundLocationPlugin: CAPPlugin, CAPBridgedPlugin, CLLocationManagerDelegate {
    public let identifier = "BackgroundLocationPlugin"
    public let jsName = "BackgroundLocation"
    public let pluginMethods = [
        CAPPluginMethod(name: "requestBackgroundPermission", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getPermissionStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startTracking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopTracking", returnType: CAPPluginReturnPromise)
    ]

    private let manager = CLLocationManager()
    private let defaults = UserDefaults.standard
    private let keychainService = "com.taskflow.app.background-location"
    private var permissionCall: CAPPluginCall?
    private let trackingStatusLock = NSLock()
    private var trackingStatusUploadInFlight = false
    private var serverShiftCheckInFlight = false
    private var lastReportedTrackingState: String?

    public override func load() {
        super.load()
        manager.delegate = self
        resumeSavedShiftIfNeeded()
    }

    @objc public func requestBackgroundPermission(_ call: CAPPluginCall) {
        guard CLLocationManager.locationServicesEnabled() else {
            call.resolve(["always": false, "gps_enabled": false])
            return
        }
        switch manager.authorizationStatus {
        case .authorizedAlways:
            call.resolve(["always": true, "gps_enabled": true])
        case .notDetermined:
            permissionCall = call
            manager.requestWhenInUseAuthorization()
        case .authorizedWhenInUse:
            permissionCall = call
            manager.requestAlwaysAuthorization()
        default:
            call.resolve(["always": false, "gps_enabled": true])
        }
    }

    @objc public func getPermissionStatus(_ call: CAPPluginCall) {
        let authorization = manager.authorizationStatus
        call.resolve([
            "always": authorization == .authorizedAlways,
            "location": authorization == .authorizedAlways || authorization == .authorizedWhenInUse,
            "gps_enabled": CLLocationManager.locationServicesEnabled(),
            "active": defaults.bool(forKey: "taskflow_background_tracking_active"),
            "queued_points": (defaults.array(forKey: "taskflow_background_location_queue") as? [[String: Any]] ?? []).count,
            "accuracy": manager.accuracyAuthorization == .fullAccuracy ? "precise" : "approximate",
            "notifications_enabled": true,
            "activity_enabled": CMMotionActivityManager.authorizationStatus() == .authorized
        ])
    }

    @objc public func openAppSettings(_ call: CAPPluginCall) {
        guard let url = URL(string: UIApplication.openSettingsURLString) else {
            call.reject("Unable to open TaskFlow settings.")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url) { opened in
                if opened { call.resolve() }
                else { call.reject("Unable to open TaskFlow settings.") }
            }
        }
    }

    @objc public func startTracking(_ call: CAPPluginCall) {
        guard manager.authorizationStatus == .authorizedAlways else {
            call.reject("Allow TaskFlow location access all the time in app settings to enable background shift tracking.", "BACKGROUND_LOCATION_REQUIRED")
            return
        }
        guard CLLocationManager.locationServicesEnabled() else {
            call.reject("Turn on Location Services to record your active shift.")
            return
        }
        guard let serverUrl = call.getString("server_url"),
              let deviceId = call.getString("device_id"),
              let shiftDate = call.getString("shift_date"),
              let model = call.getString("device_model"),
              isAllowedServerURL(serverUrl),
              shiftDate.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
            call.reject("Background tracking setup is incomplete. Reopen TaskFlow and try again.")
            return
        }
        guard let webView = bridge?.webView else {
            call.reject("TaskFlow's secure web session is unavailable. Reopen the app.")
            return
        }
        webView.configuration.websiteDataStore.httpCookieStore.getAllCookies { [weak self] cookies in
            guard let self else {
                call.reject("Background tracking is unavailable.")
                return
            }
            let host = URL(string: serverUrl)?.host
            let cookieHeader = cookies.filter { cookie in
                guard let host else { return false }
                let domain = cookie.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))
                let domainMatches = host == domain || host.hasSuffix("." + domain)
                return domainMatches && (cookie.expiresDate == nil || cookie.expiresDate! > Date())
            }.map { "\($0.name)=\($0.value)" }.joined(separator: "; ")
            guard !cookieHeader.isEmpty else {
                call.reject("Your TaskFlow session is unavailable. Sign in again before starting shift tracking.")
                return
            }
            guard self.saveCookie(cookieHeader) else {
                call.reject("Unable to securely prepare background tracking.")
                return
            }
            self.defaults.set(serverUrl, forKey: "taskflow_background_server_url")
            self.defaults.set(deviceId, forKey: "taskflow_background_device_id")
            self.defaults.set(model, forKey: "taskflow_background_device_model")
            self.defaults.set(shiftDate, forKey: "taskflow_background_shift_date")
            self.defaults.set(true, forKey: "taskflow_background_tracking_active")
            DispatchQueue.main.async {
                self.configureAndStartLocationUpdates()
                call.resolve(["active": true])
            }
        }
    }

    @objc public func stopTracking(_ call: CAPPluginCall) {
        manager.stopUpdatingLocation()
        manager.stopMonitoringSignificantLocationChanges()
        manager.allowsBackgroundLocationUpdates = false
        defaults.set(false, forKey: "taskflow_background_tracking_active")
        flushQueuedLocations {
            DispatchQueue.main.async {
                let remaining = self.defaults.array(forKey: "taskflow_background_location_queue") as? [[String: Any]] ?? []
                call.resolve(["ok": true, "flushed": remaining.isEmpty])
            }
        }
    }

    public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        guard let call = permissionCall else { return }
        if manager.authorizationStatus == .authorizedWhenInUse {
            manager.requestAlwaysAuthorization()
            return
        }
        guard manager.authorizationStatus != .notDetermined else { return }
        permissionCall = nil
        call.resolve([
            "always": manager.authorizationStatus == .authorizedAlways,
            "gps_enabled": CLLocationManager.locationServicesEnabled()
        ])
    }

    public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard defaults.bool(forKey: "taskflow_background_tracking_active") else { return }
        guard !serverShiftCheckInFlight,
              Date().timeIntervalSince1970 - defaults.double(forKey: "taskflow_background_last_sample_at") >= 5 * 60,
              let latestLocation = locations.last else { return }
        serverShiftCheckInFlight = true
        defaults.set(Date().timeIntervalSince1970, forKey: "taskflow_background_last_sample_at")
        verifyServerShift { [weak self] active in
            DispatchQueue.main.async {
                guard let self else { return }
                self.serverShiftCheckInFlight = false
                guard self.defaults.bool(forKey: "taskflow_background_tracking_active") else { return }
                if active == false {
                    self.manager.stopUpdatingLocation()
                    self.manager.stopMonitoringSignificantLocationChanges()
                    self.manager.allowsBackgroundLocationUpdates = false
                    self.defaults.set(false, forKey: "taskflow_background_tracking_active")
                    self.flushQueuedLocations()
                    return
                }
                if latestLocation.horizontalAccuracy >= 0 {
                    self.queueLocation(latestLocation)
                }
                self.flushQueuedLocations()
                self.reportTrackingState(active == nil ? "offline" : "restored")
            }
        }
    }

    public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if (error as? CLError)?.code == .denied {
            reportTrackingState("location_denied")
        } else {
            NSLog("TaskFlow background location update failed: %@", error.localizedDescription)
        }
    }

    private func isAllowedServerURL(_ serverUrl: String) -> Bool {
        guard let requested = URL(string: serverUrl),
              let loaded = bridge?.webView?.url,
              requested.scheme == "https",
              requested.host?.lowercased() == loaded.host?.lowercased(),
              requested.port == loaded.port,
              requested.user == nil,
              requested.password == nil,
              requested.query == nil,
              requested.fragment == nil,
              requested.path.isEmpty || requested.path == "/" else { return false }
        return true
    }

    private func configureAndStartLocationUpdates() {
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.distanceFilter = kCLDistanceFilterNone
        manager.activityType = .otherNavigation
        manager.pausesLocationUpdatesAutomatically = false
        manager.allowsBackgroundLocationUpdates = true
        manager.showsBackgroundLocationIndicator = true
        manager.startUpdatingLocation()
        manager.startMonitoringSignificantLocationChanges()
        flushQueuedLocations()
    }

    private func resumeSavedShiftIfNeeded() {
        guard defaults.bool(forKey: "taskflow_background_tracking_active") else { return }
        guard manager.authorizationStatus == .authorizedAlways,
              CLLocationManager.locationServicesEnabled(),
              loadCookie() != nil else {
            defaults.set(false, forKey: "taskflow_background_tracking_active")
            return
        }
        verifyServerShift { [weak self] active in
            guard let self, self.defaults.bool(forKey: "taskflow_background_tracking_active") else { return }
            if active == false {
                self.defaults.set(false, forKey: "taskflow_background_tracking_active")
                self.flushQueuedLocations()
            } else {
                DispatchQueue.main.async { self.configureAndStartLocationUpdates() }
            }
        }
    }

    private func verifyServerShift(completion: @escaping (Bool?) -> Void) {
        guard let serverUrl = defaults.string(forKey: "taskflow_background_server_url"),
              let shiftDate = defaults.string(forKey: "taskflow_background_shift_date"),
              let cookie = loadCookie(),
              let url = URL(string: "\(serverUrl)/api/attendance/today") else {
            completion(nil)
            return
        }
        var request = URLRequest(url: url)
        request.setValue(cookie, forHTTPHeaderField: "Cookie")
        request.setValue("TaskFlowNative/1", forHTTPHeaderField: "User-Agent")
        URLSession.shared.dataTask(with: request) { data, response, error in
            guard error == nil, let response = response as? HTTPURLResponse else {
                completion(nil)
                return
            }
            if response.statusCode == 401 || response.statusCode == 403 {
                completion(false)
                return
            }
            guard (200..<300).contains(response.statusCode), let data,
                  let decoded = try? JSONSerialization.jsonObject(with: data) else {
                completion(nil)
                return
            }
            if decoded is NSNull {
                completion(false)
                return
            }
            guard let status = decoded as? [String: Any] else {
                completion(nil)
                return
            }
            let active = status["date"] as? String == shiftDate
                && status["punch_in"] is String
                && (status["punch_out"] == nil || status["punch_out"] is NSNull)
            completion(active)
        }.resume()
    }

    private func queueLocation(_ location: CLLocation) {
        guard let date = defaults.string(forKey: "taskflow_background_shift_date") else { return }
        let activityUpdatedAt = defaults.double(forKey: "taskflow_latest_activity_updated_at") / 1000
        let activityAge = Date().timeIntervalSince1970 - activityUpdatedAt
        let activityIsFresh = activityAge >= 0 && activityAge <= 10 * 60
        let point: [String: Any] = [
            "client_point_id": UUID().uuidString,
            "shift_date": date,
            "recorded_at": ISO8601DateFormatter().string(from: location.timestamp),
            "lat": location.coordinate.latitude,
            "lng": location.coordinate.longitude,
            "activity_type": activityIsFresh ? defaults.string(forKey: "taskflow_latest_activity_type") ?? "unknown" : "unknown",
            "activity_confidence": activityIsFresh ? defaults.integer(forKey: "taskflow_latest_activity_confidence") : 0
        ]
        var queue = defaults.array(forKey: "taskflow_background_location_queue") as? [[String: Any]] ?? []
        if queue.count >= 1000 {
            reportTrackingState("offline_queue_full")
            return
        }
        queue.append(point)
        defaults.set(queue, forKey: "taskflow_background_location_queue")
    }

    private func flushQueuedLocations(completion: (() -> Void)? = nil) {
        guard let serverUrl = defaults.string(forKey: "taskflow_background_server_url"),
              let deviceId = defaults.string(forKey: "taskflow_background_device_id"),
              let model = defaults.string(forKey: "taskflow_background_device_model"),
              let cookie = loadCookie() else {
            completion?()
            return
        }
        let queue = defaults.array(forKey: "taskflow_background_location_queue") as? [[String: Any]] ?? []
        guard let first = queue.first, let date = first["shift_date"] as? String else {
            completion?()
            return
        }
        let batch = Array(queue.filter { $0["shift_date"] as? String == date }.prefix(100))
        let points = batch.map { point -> [String: Any] in
            var copy = point
            copy.removeValue(forKey: "shift_date")
            return copy
        }
        guard let url = URL(string: "\(serverUrl)/api/attendance/location-updates") else {
            completion?()
            return
        }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(cookie, forHTTPHeaderField: "Cookie")
        request.setValue("TaskFlowNative/1", forHTTPHeaderField: "User-Agent")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "device_id": deviceId,
            "device_model": model,
            "shift_date": date,
            "points": points
        ])
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            guard let self else {
                completion?()
                return
            }
            guard error == nil, let response = response as? HTTPURLResponse,
                  (200..<300).contains(response.statusCode) else {
                NSLog("TaskFlow background location upload failed: %@", error?.localizedDescription ?? "server rejected queued points")
                self.reportTrackingState("offline")
                completion?()
                return
            }
            let uploadedIDs = Set(batch.compactMap { $0["client_point_id"] as? String })
            let current = self.defaults.array(forKey: "taskflow_background_location_queue") as? [[String: Any]] ?? []
            self.defaults.set(current.filter { !uploadedIDs.contains($0["client_point_id"] as? String ?? "") },
                              forKey: "taskflow_background_location_queue")
            self.reportTrackingState("restored")
            self.flushQueuedLocations(completion: completion)
        }.resume()
    }

    private func reportTrackingState(_ state: String) {
        trackingStatusLock.lock()
        guard lastReportedTrackingState != state else {
            trackingStatusLock.unlock()
            return
        }
        lastReportedTrackingState = state
        var queue = defaults.array(forKey: "taskflow_background_tracking_status_queue") as? [[String: String]] ?? []
        queue.append(["state": state, "at": ISO8601DateFormatter().string(from: Date())])
        defaults.set(Array(queue.suffix(20)), forKey: "taskflow_background_tracking_status_queue")
        trackingStatusLock.unlock()
        flushQueuedTrackingStates()
    }

    private func flushQueuedTrackingStates() {
        guard let serverUrl = defaults.string(forKey: "taskflow_background_server_url"),
              let cookie = loadCookie(),
              let url = URL(string: "\(serverUrl)/api/attendance/tracking-status"),
              let first = (defaults.array(forKey: "taskflow_background_tracking_status_queue") as? [[String: String]])?.first else { return }
        trackingStatusLock.lock()
        guard !trackingStatusUploadInFlight else {
            trackingStatusLock.unlock()
            return
        }
        trackingStatusUploadInFlight = true
        trackingStatusLock.unlock()
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(cookie, forHTTPHeaderField: "Cookie")
        request.setValue("TaskFlowNative/1", forHTTPHeaderField: "User-Agent")
        request.httpBody = try? JSONSerialization.data(withJSONObject: first)
        URLSession.shared.dataTask(with: request) { [weak self] _, response, error in
            guard let self else { return }
            let statusCode = (response as? HTTPURLResponse)?.statusCode
            let succeeded = error == nil && statusCode.map { (200..<300).contains($0) } == true
            let rejectedForShift = statusCode == 400
            self.trackingStatusLock.lock()
            var queue = self.defaults.array(forKey: "taskflow_background_tracking_status_queue") as? [[String: String]] ?? []
            if (succeeded || rejectedForShift)
                && queue.first?["at"] == first["at"] && queue.first?["state"] == first["state"] {
                queue.removeFirst()
                self.defaults.set(queue, forKey: "taskflow_background_tracking_status_queue")
            }
            self.trackingStatusUploadInFlight = false
            self.trackingStatusLock.unlock()
            if (succeeded || rejectedForShift) && !queue.isEmpty { self.flushQueuedTrackingStates() }
            else if !succeeded { NSLog("TaskFlow background tracking status upload failed.") }
        }.resume()
    }

    private func saveCookie(_ cookie: String) -> Bool {
        let data = Data(cookie.utf8)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: "session-cookie"
        ]
        SecItemDelete(query as CFDictionary)
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(item as CFDictionary, nil) == errSecSuccess
    }

    private func loadCookie() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecAttrAccount as String: "session-cookie",
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
