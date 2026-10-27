import 'dart:convert';
import 'dart:typed_data';

import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/ui/project_logo.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

class LogoApi extends FakeApi {
  final downloads = <String>[];
  bool failDownload = false;
  Uint8List image = base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5YkAAAAASUVORK5CYII=',
  );

  @override
  Future<Uint8List> download(String path) async {
    downloads.add(path);
    if (failDownload) throw StateError('Offline');
    return image;
  }
}

void main() {
  testWidgets('uses the project key when no logo is set', (tester) async {
    final api = LogoApi();
    await tester.pumpWidget(
      MaterialApp(
        home: ProjectLogo(project: Project.fromJson(projectData), api: api),
      ),
    );
    expect(find.text('API'), findsOneWidget);
    expect(api.downloads, isEmpty);
    expect(Project.fromJson(projectData).logoUrl, isNull);
  });

  testWidgets(
    'loads through the API, refreshes changed URLs and restores the key on removal',
    (tester) async {
      final api = LogoApi();
      Future<void> show(String? url) async {
        await tester.pumpWidget(
          MaterialApp(
            home: ProjectLogo(
              project: Project.fromJson({...projectData, 'logoUrl': url}),
              api: api,
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      await show('/api/v1/projects/project-1/logo?v=one');
      expect(find.byType(Image), findsOneWidget);
      expect(find.text('API'), findsNothing);
      expect(tester.takeException(), isNull);
      await show('/api/v1/projects/project-1/logo?v=one');
      expect(api.downloads, hasLength(1));
      await show('/api/v1/projects/project-1/logo?v=two');
      expect(api.downloads.last, endsWith('v=two'));
      expect(api.downloads, hasLength(2));
      await show(null);
      expect(find.text('API'), findsOneWidget);
      expect(find.byType(Image), findsNothing);
    },
  );

  testWidgets(
    'falls back to the project key after download and decoding failures',
    (tester) async {
      final api = LogoApi()..failDownload = true;
      await tester.pumpWidget(
        MaterialApp(
          home: ProjectLogo(
            project: Project.fromJson({
              ...projectData,
              'logoUrl': '/api/v1/projects/project-1/logo?v=one',
            }),
            api: api,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('API'), findsOneWidget);
      expect(tester.takeException(), isNull);

      api.failDownload = false;
      api.image = Uint8List.fromList([1, 2, 3]);
      await tester.pumpWidget(
        MaterialApp(
          home: ProjectLogo(
            project: Project.fromJson({
              ...projectData,
              'logoUrl': '/api/v1/projects/project-1/logo?v=two',
            }),
            api: api,
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('API'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );
}
