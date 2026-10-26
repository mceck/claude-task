import 'dart:io';
import 'package:claude_task_mobile/src/api.dart' as api_types;
import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/controller.dart';
import 'package:claude_task_mobile/src/storage.dart';
import 'package:material_ui/material_ui.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import '../test/support.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native plugins, login, conversation and offline draft persistence',
    (tester) async {
      final root = await Directory.systemTemp.createTemp(
        'claude-task-native-smoke-',
      );
      final api = FakeApi(), live = FakeLive();
      final storage = NativeStorage(
        secure: const FlutterSecureStorage(
          mOptions: MacOsOptions(
            accountName: 'claude-task-native-smoke',
            usesDataProtectionKeychain: false,
          ),
          iOptions: IOSOptions(accountName: 'claude-task-native-smoke'),
        ),
        supportDirectory: () async => root,
      );
      final controller = TaskController(
        storage: storage,
        push: FakePush(),
        apiFactory: (uri, cookie) {
          api.installation = uri;
          api.cookie = cookie;
          return api;
        },
        socketFactory: (_) => live,
      );
      await controller.initialize();
      await tester.pumpWidget(TaskApp(controller: controller));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('installation-url')),
        'https://tasks.example.com',
      );
      await tester.enterText(find.byKey(const Key('email')), 'ada@example.com');
      await tester.enterText(find.byKey(const Key('password')), 'password');
      await tester.tap(find.text('Sign in'));
      await tester.pumpAndSettle();
      expect((await storage.readLogin())!['cookie'], 'ct_login=secret');
      controller.connection = api_types.ConnectionState.connected;
      await controller.selectProject(controller.projects.first);
      await controller.selectTask(controller.tasks.first);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('comment-composer')), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('comment-composer')),
        'Native offline draft',
      );
      await tester.pumpAndSettle();
      final restored = NativeStorage(supportDirectory: () async => root);
      await restored.open('https://tasks.example.com', 'user-1');
      expect(restored.read('draft:task-1')!['text'], 'Native offline draft');
      await controller.logout();
      await tester.pumpAndSettle();
      expect(await storage.readLogin(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
      controller.dispose();
      await root.delete(recursive: true);
    },
  );
}
