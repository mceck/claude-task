import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/services.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:material_ui/material_ui.dart' show Color, Offset, TextStyle;
import 'package:path_provider/path_provider.dart';

import 'alerts.dart';
import 'ui/theme.dart' show tint;

const _channel = AndroidNotificationChannel(
  'task-updates',
  'Task updates',
  description: 'Agent outcomes and mentions on the Tasks you follow',
  importance: Importance.high,
);
const _group = 'claude-task';
const _summaryId = 0;

/// The iOS side of removing a Task's delivered notifications (AppDelegate).
const _darwin = MethodChannel('claude_task/notifications');

/// Draws Alerts on the phone: one conversation notification per Task on
/// Android, and the foreground copy of an iOS alert.
class PhoneAlerts {
  PhoneAlerts._();
  static final instance = PhoneAlerts._();

  final _plugin = FlutterLocalNotificationsPlugin();
  final lines = AlertLines(
    () async =>
        File('${(await getApplicationSupportDirectory()).path}/alerts.json'),
  );
  Future<void>? _ready;

  Future<void> initialize({
    void Function(String taskId)? onOpen,
  }) => _ready ??= () async {
    await _plugin.initialize(
      settings: const InitializationSettings(
        android: AndroidInitializationSettings('ic_notification'),
        iOS: DarwinInitializationSettings(
          // Firebase Messaging asks for permission on "Enable notifications".
          requestAlertPermission: false,
          requestBadgePermission: false,
          requestSoundPermission: false,
        ),
      ),
      onDidReceiveNotificationResponse: (response) {
        final id = response.payload;
        if (id != null && id.isNotEmpty) onOpen?.call(id);
      },
    );
    await _plugin
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >()
        ?.createNotificationChannel(_channel);
  }();

  /// The Task whose local notification launched the app, if any.
  Future<String?> launchTask() async {
    final details = await _plugin.getNotificationAppLaunchDetails();
    final id = details?.didNotificationLaunchApp == true
        ? details!.notificationResponse?.payload
        : null;
    return id == null || id.isEmpty ? null : id;
  }

  Future<void> show(PushAlertData alert) async {
    await initialize();
    if (Platform.isAndroid) {
      await _showConversation(alert);
    } else if (Platform.isIOS) {
      await _plugin.show(
        id: alertNotificationId(alert.eventId),
        title: alert.title,
        body: alert.body,
        payload: alert.taskId,
        notificationDetails: NotificationDetails(
          iOS: DarwinNotificationDetails(
            threadIdentifier: alert.thread,
            presentAlert: true,
            presentBanner: true,
            presentList: true,
            presentSound: true,
          ),
        ),
      );
    }
  }

  Future<void> _showConversation(PushAlertData alert) async {
    final id = alertNotificationId(alert.thread);
    // A notification the User dismissed starts its conversation over.
    final active = await _plugin.getActiveNotifications();
    final onScreen = active.any((n) => n.id == id);
    final conversation = await lines.add(alert, fresh: !onScreen);
    final people = <String, Person>{};
    Future<Person> person(AlertLine line) async {
      final name = line.sender ?? 'Claude Task';
      return people[name] ??= Person(
        key: name,
        name: name,
        bot: line.fromAgent,
        icon: ByteArrayAndroidIcon(await _initialsIcon(name)),
      );
    }

    final messages = <Message>[
      for (final line in conversation.lines)
        Message(line.text, line.at, await person(line)),
    ];
    await _plugin.show(
      id: id,
      title: conversation.title,
      body: alert.body,
      payload: alert.taskId,
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          _channel.id,
          _channel.name,
          channelDescription: _channel.description,
          importance: Importance.high,
          priority: Priority.high,
          icon: 'ic_notification',
          category: AndroidNotificationCategory.message,
          visibility: NotificationVisibility.public,
          groupKey: _group,
          styleInformation: MessagingStyleInformation(
            const Person(name: 'You', key: 'you'),
            conversationTitle: conversation.title,
            groupConversation: true,
            messages: messages,
          ),
        ),
      ),
    );
    await _plugin.show(
      id: _summaryId,
      title: 'Claude Task',
      notificationDetails: NotificationDetails(
        android: AndroidNotificationDetails(
          _channel.id,
          _channel.name,
          icon: 'ic_notification',
          groupKey: _group,
          setAsGroupSummary: true,
          visibility: NotificationVisibility.public,
          onlyAlertOnce: true,
        ),
      ),
    );
  }

  /// Removes a Task's notifications from this phone and forgets its lines.
  Future<void> clear(String taskId) async {
    await lines.clear(taskId);
    if (Platform.isAndroid) {
      await initialize();
      await _plugin.cancel(id: alertNotificationId(taskId));
      final rest = await _plugin.getActiveNotifications();
      if (!rest.any((n) => n.id != null && n.id != _summaryId)) {
        await _plugin.cancel(id: _summaryId);
      }
    } else if (Platform.isIOS) {
      try {
        await _darwin.invokeMethod<void>('removeThread', taskId);
      } on MissingPluginException {
        // Older builds without the channel keep their notifications.
      }
    }
  }
}

/// The sender's initials on the colour the app gives that name.
Future<Uint8List> _initialsIcon(String name) async {
  const size = 96.0;
  final recorder = ui.PictureRecorder();
  final canvas = ui.Canvas(recorder);
  canvas.drawCircle(
    const Offset(size / 2, size / 2),
    size / 2,
    ui.Paint()..color = tint(name),
  );
  final builder =
      ui.ParagraphBuilder(
          ui.ParagraphStyle(textAlign: ui.TextAlign.center, maxLines: 1),
        )
        ..pushStyle(
          const TextStyle(
            color: Color(0xff101010),
            fontSize: 40,
            fontWeight: ui.FontWeight.w700,
          ).getTextStyle(),
        )
        ..addText(initials(name));
  final paragraph = builder.build()
    ..layout(const ui.ParagraphConstraints(width: size));
  canvas.drawParagraph(paragraph, Offset(0, (size - paragraph.height) / 2));
  final image = await recorder.endRecording().toImage(
    size.toInt(),
    size.toInt(),
  );
  final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
  return bytes!.buffer.asUint8List();
}
