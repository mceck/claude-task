import 'dart:async';
import 'dart:io';
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';

@pragma('vm:entry-point')
Future<void> backgroundMessage(RemoteMessage message) async {
  // Alert payloads are displayed by Android/APNs; no authenticated work here.
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
}

class FirebasePhonePush implements PhonePush {
  final _opens = StreamController<String>.broadcast();
  final _tokens = StreamController<String>.broadcast();
  String? _initialTask;
  @override
  String status = 'Phone push is not configured';
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
      FirebaseMessaging.onMessageOpenedApp.listen((message) {
        final id = message.data['taskId'];
        if (id != null) _opens.add(id);
      });
      _initialTask = (await FirebaseMessaging.instance.getInitialMessage())
          ?.data['taskId'];
      FirebaseMessaging.instance.onTokenRefresh.listen(_tokens.add);
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
}
