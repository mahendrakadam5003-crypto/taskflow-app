import UIKit
import Capacitor
import Darwin
import CoreMotion

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Override point for customization after application launch.
        return true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

class TaskFlowBridgeViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(AppDevicePlugin())
        bridge?.registerPluginInstance(ActivityRecognitionPlugin())
    }
}

@objc(AppDevicePlugin)
public class AppDevicePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppDevicePlugin"
    public let jsName = "AppDevice"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getIdentity", returnType: CAPPluginReturnPromise)
    ]

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
        call.resolve([
            "device_id": deviceId,
            "manufacturer": "Apple",
            "model": model
        ])
    }
}

@objc(ActivityRecognitionPlugin)
public class ActivityRecognitionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ActivityRecognitionPlugin"
    public let jsName = "ActivityRecognition"
    public let pluginMethods: [CAPPluginMethod] = [
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
            guard let activity else { return }
            self?.latestActivity = self?.activityPayload(activity)
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

        return [
            "type": type,
            "confidence": confidence,
            "updated_at": Int64(Date().timeIntervalSince1970 * 1000)
        ]
    }

    private func unknownActivity() -> [String: Any] {
        return ["type": "unknown", "confidence": 0, "updated_at": 0]
    }
}
