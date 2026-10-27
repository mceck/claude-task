import 'dart:convert';
import 'dart:typed_data';

import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/ui/user_avatar.dart';
import 'package:claude_task_mobile/src/workspace.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

class AvatarApi extends FakeApi {
  final downloads = <String>[];
  bool failDownload = false, failUpload = false;
  Uint8List image = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5YkAAAAASUVORK5CYII=',
  );
  List<DraftFile> uploaded = [];

  @override
  Future<Uint8List> download(String path) async {
    downloads.add(path);
    if (failDownload) throw StateError('Offline');
    return image;
  }

  @override
  Future<Json> request(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  }) async {
    if (path == '/users/user-1/avatar') {
      if (failUpload) throw StateError('Upload failed');
      uploaded = files;
      user = {
        ...user,
        'avatarImageUrl': method == 'DELETE'
            ? null
            : '/api/v1/users/user-1/avatar?v=new',
      };
      return {'user': user};
    }
    return super.request(method, path, body: body, files: files);
  }
}

void main() {
  testWidgets(
    'shares repeated avatar downloads within a Login and isolates API clients',
    (tester) async {
      final first = AvatarApi(), second = AvatarApi();
      const url = '/api/v1/users/user-1/avatar?v=shared';
      await tester.pumpWidget(
        MaterialApp(
          home: Row(
            children: [
              UserAvatar(label: 'Ada', api: first, imageUrl: url),
              UserAvatar(label: 'Ada', api: first, imageUrl: url),
              UserAvatar(label: 'Ada', api: second, imageUrl: url),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byType(Image), findsNWidgets(3));
      expect(first.downloads, [url]);
      expect(second.downloads, [url]);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'loads a photo through the API, refreshes its URL and falls back after removal and failures',
    (tester) async {
      final api = AvatarApi();
      Future<void> show(String? url) async {
        await tester.pumpWidget(
          MaterialApp(
            home: UserAvatar(
              label: 'Ada Morgan',
              userId: 'user-1',
              imageUrl: url,
              api: api,
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      await show(null);
      expect(find.text('AM'), findsOneWidget);
      expect(api.downloads, isEmpty);
      await show('/api/v1/users/user-1/avatar?v=one');
      expect(find.byType(Image), findsOneWidget);
      expect(find.text('AM'), findsNothing);
      await show('/api/v1/users/user-1/avatar?v=one');
      expect(api.downloads, hasLength(1));
      await show('/api/v1/users/user-1/avatar?v=two');
      expect(api.downloads, hasLength(2));
      await show(null);
      expect(find.byType(Image), findsNothing);
      expect(find.text('AM'), findsOneWidget);
      api.failDownload = true;
      await show('/api/v1/users/user-1/avatar?v=offline');
      expect(find.text('AM'), findsOneWidget);
      api.failDownload = false;
      api.image = Uint8List.fromList([1, 2, 3]);
      await show('/api/v1/users/user-1/avatar?v=invalid');
      expect(find.text('AM'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  test('updates the current User, directory and persisted profile and preserves the image on failure', () async {
    final api = AvatarApi();
    final h = Harness(api: api);
    addTearDown(h.dispose);
    await h.login();
    const file = DraftFile('/tmp/photo.png', 'photo.png');
    await h.controller.changeAvatar(file);
    expect(api.uploaded, [file]);
    expect(h.controller.user!.avatarImageUrl, endsWith('v=new'));
    expect(h.controller.users.first.avatarImageUrl, endsWith('v=new'));
    expect(h.storage.login!['user']['avatarImageUrl'], endsWith('v=new'));
    expect(
      objects(h.storage.read('global')!['users']).first['avatarImageUrl'],
      endsWith('v=new'),
    );
    api.failUpload = true;
    await expectLater(h.controller.changeAvatar(file), throwsStateError);
    expect(h.controller.user!.avatarImageUrl, endsWith('v=new'));
    api.failUpload = false;
    await h.controller.changeAvatar();
    expect(h.controller.user!.avatarImageUrl, isNull);
    expect(h.controller.users.first.avatarImageUrl, isNull);
    expect(h.storage.login!['user']['avatarImageUrl'], isNull);
  });

  for (final internal in [false, true]) {
    testWidgets(
      'own ${internal ? 'Internal Notes' : 'Comments'} keep their original layout without an avatar',
      (tester) async {
        final api = AvatarApi();
        api.items = [
          commentData('first', 'First own comment', internal: internal),
          commentData(
            'second',
            'Second own comment',
            internal: internal,
            position: '2',
          ),
        ];
        final h = Harness(api: api);
        addTearDown(h.dispose);
        await h.login();
        await h.openTask();
        await h.controller.changeAvatar(
          const DraftFile('/tmp/photo.png', 'photo.png'),
        );
        await tester.pumpWidget(TaskApp(controller: h.controller));
        await tester.pumpAndSettle();
        final avatar = find.byKey(const ValueKey('comment-avatar:first'));
        expect(avatar, findsNothing);
        expect(
          find.byKey(const ValueKey('comment-avatar:second')),
          findsNothing,
        );
        expect(find.text('First own comment'), findsOneWidget);
        expect(find.text('Second own comment'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  }

  testWidgets(
    'the Profile sheet removes a photo and immediately restores initials',
    (tester) async {
      final api = AvatarApi();
      final h = Harness(api: api);
      addTearDown(h.dispose);
      await h.login();
      await h.controller.changeAvatar(
        const DraftFile('/tmp/photo.png', 'photo.png'),
      );
      await tester.pumpWidget(
        MaterialApp(
          home: Builder(
            builder: (context) => TextButton(
              onPressed: () => showProfile(context, h.controller),
              child: const Text('Open profile'),
            ),
          ),
        ),
      );
      await tester.tap(find.text('Open profile'));
      await tester.pumpAndSettle();
      expect(find.text('Change photo'), findsOneWidget);
      await tester.tap(find.text('Remove photo'));
      await tester.pumpAndSettle();
      expect(h.controller.user!.avatarImageUrl, isNull);
      expect(find.text('Remove photo'), findsNothing);
      expect(find.text('A'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
