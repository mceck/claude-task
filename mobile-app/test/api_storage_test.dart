import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:claude_task_mobile/src/api.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/storage.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'Skill imports allow the backend fetch timeout while ordinary requests time out after 30 seconds',
    (tester) async {
      final responses = <Completer<http.Response>>[];
      final api = HttpTaskApi(
        Uri.parse('https://tasks.example.com'),
        client: MockClient((_) {
          final response = Completer<http.Response>();
          responses.add(response);
          return response.future;
        }),
      );
      addTearDown(api.close);
      final imported = api.request(
        'POST',
        '/skills/import',
        body: {'source': 'team/skills'},
      );
      await tester.pump();
      await tester.pump(const Duration(seconds: 120));
      responses.first.complete(http.Response('{"skills": []}', 201));
      await tester.pump();
      expect(await imported, {'skills': <dynamic>[]});

      final ordinary = expectLater(
        api.request('GET', '/git/connections'),
        throwsA(isA<TimeoutException>()),
      );
      await tester.pump();
      await tester.pump(const Duration(seconds: 31));
      await ordinary;
      responses.last.complete(http.Response('{}', 200));
      await tester.pump();
    },
  );
  test(
    'native HTTP keeps HttpOnly cookies and sends authentication plus CSRF headers',
    () async {
      var calls = 0;
      final api = HttpTaskApi(
        Uri.parse('https://tasks.example.com'),
        client: MockClient((request) async {
          calls++;
          expect(request.headers['x-claude-task'], '1');
          if (calls == 1) {
            return http.Response(
              '{"user": {}}',
              200,
              headers: {
                'set-cookie':
                    'ct_login=native-secret; Path=/; HttpOnly; Secure; SameSite=Lax',
              },
            );
          }
          expect(request.headers['cookie'], 'ct_login=native-secret');
          expect(jsonDecode(request.body)['body'], 'hello');
          return http.Response('{"comment": {}}', 201);
        }),
      );
      addTearDown(api.close);
      await api.request(
        'POST',
        '/auth/login',
        body: {'email': 'ada@example.com', 'password': 'password'},
      );
      expect(api.cookie, 'ct_login=native-secret');
      await api.request(
        'POST',
        '/tasks/task/comments',
        body: {'body': 'hello'},
      );
      await expectLater(
        api.download('https://attacker.example.com/api/v1/attachments/id'),
        throwsFormatException,
      );
    },
  );
  test(
    'multipart sends local attachment bytes only as part of a manual Comment request',
    () async {
      final directory = await Directory.systemTemp.createTemp(
        'ct-attachment-test-',
      );
      addTearDown(() => directory.delete(recursive: true));
      final file = File('${directory.path}/example.txt');
      await file.writeAsString('local file content');
      final api = HttpTaskApi(
        Uri.parse('https://tasks.example.com'),
        cookie: 'ct_login=secret',
        client: MockClient((request) async {
          expect(
            request.headers['content-type'],
            startsWith('multipart/form-data'),
          );
          expect(request.body, contains('local file content'));
          expect(request.body, contains('name="internal"'));
          expect(request.body, contains('true'));
          return http.Response('{"comment": {}}', 201);
        }),
      );
      addTearDown(api.close);
      await api.request(
        'POST',
        '/tasks/task/comments',
        body: {'body': 'hello', 'internal': true},
        files: [DraftFile(file.path, 'example.txt')],
      );
    },
  );
  test(
    'installation validation rejects embedded credentials and URL paths',
    () {
      for (final value in [
        'https://user:password@tasks.example.com',
        'file:///tmp/cache',
        'https://example.com/api',
        'https://example.com?token=secret',
      ]) {
        expect(() => installationUrl(value), throwsFormatException);
      }
      expect(
        installationUrl('http://localhost:3000/').toString(),
        'http://localhost:3000',
      );
    },
  );
  test(
    'native cache isolates installations and Users, serializes writes and deletes profile data on logout',
    () async {
      FlutterSecureStorage.setMockInitialValues({});
      final directory = await Directory.systemTemp.createTemp('ct-cache-test-');
      addTearDown(() => directory.delete(recursive: true));
      final storage = NativeStorage(supportDirectory: () async => directory);
      await storage.open('https://one.example.com', 'user-a');
      await Future.wait([
        storage.write('draft:task', {'text': 'older'}),
        storage.write('draft:task', {'text': 'newest'}),
      ]);
      final attachment = await storage.attachment(
        'attachment-id',
        '../../secrets.png',
      );
      await attachment.writeAsString('cached bytes');
      expect(attachment.path, isNot(contains('/../')));
      await storage.writeLogin({
        'url': 'https://one.example.com',
        'cookie': 'ct_login=secret',
      });
      await storage.open('https://one.example.com', 'user-b');
      expect(storage.read('draft:task'), isNull);
      await storage.open('https://two.example.com', 'user-a');
      expect(storage.read('draft:task'), isNull);
      await storage.open('https://one.example.com', 'user-a');
      expect(storage.read('draft:task')!['text'], 'newest');
      await storage.clear();
      expect(await attachment.exists(), false);
      expect(await storage.readLogin(), isNull);
      await storage.open('https://one.example.com', 'user-a');
      expect(storage.read('draft:task'), isNull);
    },
  );
}
