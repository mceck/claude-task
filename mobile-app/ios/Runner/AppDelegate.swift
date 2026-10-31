import Flutter
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // Foreground Alerts drawn by the app go through the notification center's delegate.
    UNUserNotificationCenter.current().delegate = self as? UNUserNotificationCenterDelegate
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    guard let registrar = engineBridge.pluginRegistry.registrar(forPlugin: "ClaudeTaskNotifications") else { return }
    // Opening a Task removes its delivered notifications, remote ones included.
    FlutterMethodChannel(name: "claude_task/notifications", binaryMessenger: registrar.messenger())
      .setMethodCallHandler { call, result in
        guard call.method == "removeThread", let thread = call.arguments as? String else {
          result(FlutterMethodNotImplemented)
          return
        }
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
          let ids = delivered.filter { $0.request.content.threadIdentifier == thread }.map { $0.request.identifier }
          center.removeDeliveredNotifications(withIdentifiers: ids)
          DispatchQueue.main.async { result(nil) }
        }
      }
  }
}
