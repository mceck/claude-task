import 'dart:async';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

import 'alerts.dart';
import 'phone_alerts.dart';

@pragma('vm:entry-point')
Future<void> backgroundMessage(RemoteMessage message) async {
  // Android receives data only and draws the Alert; APNs shows iOS alerts.
  // Nothing authenticated happens here.
  if (!Platform.isAndroid) return;
  final alert = PushAlertData.fromData(message.data);
  if (alert != null) await PhoneAlerts.instance.show(alert);
}

abstract class PhonePush {
  String get status;
  Stream<String> get taskOpens;
  Stream<String> get tokens;
  Future<void> initialize();
  Future<String?> enable();
  Future<String?> currentToken();
  Future<void> disable();
  String? takeInitialTask();

  /// Whether the User is looking at a Task's conversation right now, so its
  /// Alerts stay quiet in the foreground.
  set watching(bool Function(String taskId)? value);

  /// Removes a Task's notifications from this phone.
  Future<void> clearTask(String taskId);
}

class FirebasePhonePush implements PhonePush {
  final _opens = StreamController<String>.broadcast();
  final _tokens = StreamController<String>.broadcast();
  String? _initialTask;
  @override
  String status = 'Phone push is not configured';
  @override
  bool Function(String taskId)? watching;
  bool _ready = false;
  static const projectId = String.fromEnvironment('FIREBASE_PROJECT_ID');
  @override
  Stream<String> get taskOpens => _opens.stream;
  @override
  Stream<String> get tokens => _tokens.stream;
  @override
  String? takeInitialTask() {
    final id = _initialTask;
    _initialTask = null;
    return id;
  }

  @override
  Future<void> initialize() async {
    if (!Platform.isIOS && !Platform.isAndroid) {
      status = 'Live updates and unread indicators enabled';
      return;
    }
    if (projectId.isEmpty) return;
    try {
      await Firebase.initializeApp(
        options: const FirebaseOptions(
          apiKey: String.fromEnvironment('FIREBASE_API_KEY'),
          appId: String.fromEnvironment('FIREBASE_APP_ID'),
          messagingSenderId: String.fromEnvironment('FIREBASE_SENDER_ID'),
          projectId: projectId,
          iosBundleId: String.fromEnvironment('FIREBASE_IOS_BUNDLE_ID'),
        ),
      );
      FirebaseMessaging.onBackgroundMessage(backgroundMessage);
      await PhoneAlerts.instance.initialize(onOpen: _opens.add);
      FirebaseMessaging.onMessage.listen(_foreground);
      FirebaseMessaging.onMessageOpenedApp.listen((message) {
        final id = message.data['taskId'];
        if (id is String && id.isNotEmpty) _opens.add(id);
      });
      final remote = (await FirebaseMessaging.instance.getInitialMessage())
          ?.data['taskId'];
      _initialTask = remote is String && remote.isNotEmpty
          ? remote
          : await PhoneAlerts.instance.launchTask();
      FirebaseMessaging.instance.onTokenRefresh.listen(_tokens.add);
      // The app shows foreground Alerts itself, so iOS never presents the
      // remote copy as well.
      await FirebaseMessaging.instance
          .setForegroundNotificationPresentationOptions(
            alert: false,
            badge: false,
            sound: false,
          );
      _ready = true;
      status = 'Phone notifications available';
    } catch (_) {
      status = 'Phone push configuration failed';
    }
  }

  @override
  Future<String?> enable() async {
    if (!_ready) return null;
    final permission = await FirebaseMessaging.instance.requestPermission();
    if (permission.authorizationStatus == AuthorizationStatus.denied) {
      status = 'Notifications declined; unread indicators remain available';
      return null;
    }
    if (Platform.isIOS &&
        await FirebaseMessaging.instance.getAPNSToken() == null) {
      status = 'Waiting for APNs registration; try again after device setup';
      return null;
    }
    final token = await FirebaseMessaging.instance.getToken();
    status = token == null
        ? 'Waiting for phone token'
        : 'Phone notifications enabled';
    return token;
  }

  @override
  Future<String?> currentToken() async {
    if (!_ready) return null;
    final settings = await FirebaseMessaging.instance.getNotificationSettings();
    if (settings.authorizationStatus != AuthorizationStatus.authorized &&
        settings.authorizationStatus != AuthorizationStatus.provisional) {
      return null;
    }
    if (Platform.isIOS &&
        await FirebaseMessaging.instance.getAPNSToken() == null) {
      return null;
    }
    return FirebaseMessaging.instance.getToken();
  }

  @override
  Future<void> disable() async {
    if (_ready) await FirebaseMessaging.instance.deleteToken();
  }

  void _foreground(RemoteMessage message) {
    final alert = PushAlertData.fromData(message.data);
    if (alert == null || !showInForeground(alert.taskId, watching: watching)) {
      return;
    }
    unawaited(PhoneAlerts.instance.show(alert).catchError((Object _) {}));
  }

  @override
  Future<void> clearTask(String taskId) async {
    if (!_ready) return;
    try {
      await PhoneAlerts.instance.clear(taskId);
    } catch (_) {
      // A notification left on screen is harmless.
    }
  }
}
