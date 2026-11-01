import 'dart:convert';
import 'dart:typed_data';

import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/api.dart' as api;
import 'package:claude_task_mobile/src/ui/markdown.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/settings.dart';
import 'package:claude_task_mobile/src/task_forms.dart';
import 'package:claude_task_mobile/src/ui/widgets.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

final class _PickedFile extends PlatformFile {
  @override
  final String name;
  final int size;
  _PickedFile(this.name, {this.size = 20});
  @override
  Uri get uri => Uri.file('/test/$name');
  @override
  get xFile => throw UnimplementedError();
  @override
  int lengthSync() => size;
  @override
  Future<int> length() async => size;
  @override
  Future<Uint8List> readAsBytes() async => Uint8List(size);
  @override
  Stream<Uint8List> readAsByteStream() => Stream.fromFuture(readAsBytes());
}

class _Picker extends FilePickerPlatform {
  List<PlatformFile> files = [_PickedFile('logo.png')];
  FileType? lastType;
  @override
  Future<List<PlatformFile>> pickFiles({
    String? dialogTitle,
    String? initialDirectory,
    FileType type = FileType.any,
    List<String>? allowedExtensions,
    Function(FilePickerStatus)? onFileLoading,
    int compressionQuality = 0,
    AndroidOptions androidOptions = const AndroidOptions(),
    DarwinOptions darwinOptions = const DarwinOptions(),
    WindowsOptions windowsOptions = const WindowsOptions(),
    LinuxOptions linuxOptions = const LinuxOptions(),
    WebOptions webOptions = const WebOptions(),
  }) async {
    lastType = type;
    return files;
  }

  @override
  Future<PlatformFile?> pickFile({
    String? dialogTitle,
    String? initialDirectory,
    FileType type = FileType.any,
    List<String>? allowedExtensions,
    Function(FilePickerStatus)? onFileLoading,
    int compressionQuality = 0,
    AndroidOptions androidOptions = const AndroidOptions(),
    DarwinOptions darwinOptions = const DarwinOptions(),
    WindowsOptions windowsOptions = const WindowsOptions(),
    LinuxOptions linuxOptions = const LinuxOptions(),
    WebOptions webOptions = const WebOptions(),
  }) async {
    lastType = type;
    return files.firstOrNull;
  }
}

class _UploadApi extends FakeApi {
  Json project = {...projectData};
  Json agent = {
    'id': 'agent-1',
    'name': 'Ada Bot',
    'enabled': true,
    'avatarEmoji': '🤖',
  };
  final writes = <(String, String, List<DraftFile>)>[];
  bool failUpload = false;
  int revision = 0;

  @override
  Future<Json> request(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  }) async {
    if (method != 'GET') writes.add((method, path, files));
    if (path == '/projects') {
      return {
        'projects': [project],
      };
    }
    if (path == '/projects/project-1') {
      return {
        ...await super.request(method, path, body: body),
        'project': project,
      };
    }
    if (path == '/agents') {
      return {
        'agents': [agent],
      };
    }
    if (path == '/credentials') {
      return {
        'credentials': [
          {'id': 'credential-1', 'name': 'Claude'},
        ],
      };
    }
    if (path == '/skills') return {'skills': <Json>[]};
    if (path == '/mcp-servers') return {'mcpServers': <Json>[]};
    if (path == '/plugins') return {'plugins': <Json>[]};
    if (path == '/projects/project-1/logo') {
      if (failUpload) throw StateError('Upload failed');
      project = {
        ...project,
        'logoUrl': method == 'DELETE'
            ? null
            : '/api/v1/projects/project-1/logo?v=${++revision}',
      };
      return {'project': project};
    }
    if (path == '/agents/agent-1/avatar') {
      if (failUpload) throw StateError('Upload failed');
      agent = {
        ...agent,
        'avatarImageUrl': method == 'DELETE'
            ? null
            : '/api/v1/agents/agent-1/avatar?v=${++revision}',
      };
      return {'agent': agent};
    }
    if (path == '/tasks/task-1/attachments') {
      if (failUpload) throw StateError('Upload failed');
      return {
        'attachments': [
          for (final file in files)
            {
              'id': file.name,
              'filename': file.name,
              'contentType': file.name.endsWith('.png')
                  ? 'image/png'
                  : 'application/pdf',
              'url': '/api/v1/attachments/${file.name}',
            },
        ],
      };
    }
    return super.request(method, path, body: body, files: files);
  }

  @override
  Future<Uint8List> download(String path) async => base64Decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5YkAAAAASUVORK5CYII=',
  );
}

void main() {
  late _Picker picker;
  setUp(() {
    final previous = FilePickerPlatform.instance;
    picker = _Picker();
    FilePickerPlatform.instance = picker;
    addTearDown(() => FilePickerPlatform.instance = previous);
  });

  Future<Harness> mount(WidgetTester tester, {bool admin = false}) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final api = _UploadApi()
      ..user = {...userData, 'role': admin ? 'admin' : 'member'};
    final h = Harness(api: api);
    addTearDown(h.dispose);
    await h.login();
    await tester.pumpWidget(TaskApp(controller: h.controller));
    await tester.pumpAndSettle();
    return h;
  }

  testWidgets(
    'a Member uploads, replaces and removes a Project logo from settings',
    (tester) async {
      final h = await mount(tester);
      final api = h.api as _UploadApi;
      showProjectSettings(
        tester.element(find.byType(Scaffold).first),
        h.controller,
        h.controller.projects.single,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Upload logo'));
      await tester.pumpAndSettle();
      expect(h.controller.projects.single.logoUrl, endsWith('v=1'));
      expect(api.writes.last.$1, 'PUT');
      expect(api.writes.last.$2, '/projects/project-1/logo');
      expect(api.writes.last.$3.single.name, 'logo.png');
      final first = api.project['logoUrl'];
      await tester.tap(find.text('Replace logo'));
      await tester.pumpAndSettle();
      expect(api.project['logoUrl'], isNot(first));
      api.failUpload = true;
      await tester.tap(find.text('Replace logo'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Upload failed'), findsOneWidget);
      expect(h.controller.projects.single.logoUrl, endsWith('v=2'));
      api.failUpload = false;
      await tester.tap(find.text('Remove logo'));
      await tester.pumpAndSettle();
      expect(h.controller.projects.single.logoUrl, isNull);
      expect(find.text('Upload logo'), findsOneWidget);
      final archive = find.widgetWithText(AppButton, 'Archive');
      await tester.scrollUntilVisible(archive, 300);
      expect(tester.widget<AppButton>(archive).tone, Tone.danger);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'invalid image selections and cancellation leave the Project unchanged',
    (tester) async {
      final h = await mount(tester);
      final api = h.api as _UploadApi;
      showProjectSettings(
        tester.element(find.byType(Scaffold).first),
        h.controller,
        h.controller.projects.single,
      );
      await tester.pumpAndSettle();
      for (final file in [
        _PickedFile('large.png', size: 3 * 1024 * 1024),
        _PickedFile('unsafe.svg'),
      ]) {
        picker.files = [file];
        await tester.tap(find.text('Upload logo'));
        await tester.pumpAndSettle();
        expect(api.project['logoUrl'], isNull);
      }
      picker.files = [];
      final writes = api.writes.length;
      await tester.tap(find.text('Upload logo'));
      await tester.pumpAndSettle();
      expect(api.writes, hasLength(writes));
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'an Admin changes the Agent image while preserving unsaved form edits',
    (tester) async {
      final h = await mount(tester, admin: true);
      final api = h.api as _UploadApi;
      showAgentsSettings(
        tester.element(find.byType(Scaffold).first),
        h.controller,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Ada Bot'));
      await tester.pumpAndSettle();
      await tester.ensureVisible(find.byType(TextField).first);
      await tester.enterText(
        find.byType(TextField).first,
        'My pending Agent name',
      );
      await tester.ensureVisible(find.text('Upload image'));
      await tester.tap(find.text('Upload image'));
      await tester.pumpAndSettle();
      expect(h.controller.agents.single.avatarImageUrl, endsWith('v=1'));
      expect(find.text('My pending Agent name'), findsOneWidget);
      await tester.tap(find.text('Remove image'));
      await tester.pumpAndSettle();
      expect(h.controller.agents.single.avatarImageUrl, isNull);
      expect(find.text('My pending Agent name'), findsOneWidget);
      expect(api.writes.where((write) => write.$1 == 'PATCH'), isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'picks several files into a Draft and uploads them only on send',
    (tester) async {
      final h = await mount(tester);
      await h.openTask();
      await tester.pumpAndSettle();
      expect(find.text('Archive'), findsNothing);
      picker.files = [_PickedFile('diagram.png'), _PickedFile('notes.pdf')];
      await tester.tap(find.byTooltip('Attach local files'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Files'));
      await tester.pumpAndSettle();
      expect(picker.lastType, FileType.any);
      expect(h.controller.draft.files.map((file) => file.name), [
        'diagram.png',
        'notes.pdf',
      ]);
      expect(h.api.sendCount, 0);
      await tester.tap(find.byKey(const Key('send-comment')));
      await tester.pumpAndSettle();
      final upload = (h.api as _UploadApi).writes.lastWhere(
        (write) => write.$2 == '/tasks/task-1/comments',
      );
      expect(upload.$3.map((file) => file.name), ['diagram.png', 'notes.pdf']);
      expect(h.controller.draft.files, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'file limits preserve the existing Draft and Members cannot edit Agent images',
    (tester) async {
      final h = await mount(tester);
      await h.openTask();
      await h.controller.setDraft(
        const Draft(
          text: 'Keep this draft',
          files: [DraftFile('/test/existing.pdf', 'existing.pdf')],
        ),
      );
      await tester.pumpAndSettle();
      for (final selection in [
        [_PickedFile('large.pdf', size: 26 * 1024 * 1024)],
        List.generate(10, (i) => _PickedFile('file-$i.pdf')),
      ]) {
        picker.files = selection;
        await tester.tap(find.byTooltip('Attach local files'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Files'));
        await tester.pumpAndSettle();
        expect(h.controller.draft.text, 'Keep this draft');
        expect(h.controller.draft.files.single.name, 'existing.pdf');
        expect(h.api.sendCount, 0);
        await tester.pump(const Duration(seconds: 5));
        await tester.pumpAndSettle();
      }
      showAgentsSettings(
        tester.element(find.byType(Scaffold).first),
        h.controller,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Ada Bot'));
      await tester.pumpAndSettle();
      expect(find.text('Upload image'), findsNothing);
      expect(find.text('Edit agent'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'Project image changes are disabled when the connection goes offline',
    (tester) async {
      final h = await mount(tester);
      showProjectSettings(
        tester.element(find.byType(Scaffold).first),
        h.controller,
        h.controller.projects.single,
      );
      await tester.pumpAndSettle();
      h.live.stateController.add(api.ConnectionState.offline);
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<AppButton>(find.widgetWithText(AppButton, 'Upload logo'))
            .onPressed,
        isNull,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'failed description uploads keep the original description and allow saving',
    (tester) async {
      final h = await mount(tester);
      await h.openTask();
      await tester.pumpAndSettle();
      final original = h.api.currentTask['description'];
      (h.api as _UploadApi).failUpload = true;
      showEditTask(tester.element(find.byType(Scaffold).first), h.controller);
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Attach images or files'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Files'));
      await tester.pumpAndSettle();
      expect(find.textContaining('Upload failed'), findsOneWidget);
      await tester.tap(find.text('Save').last);
      await tester.pumpAndSettle();
      expect(h.api.currentTask['description'], original);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'description links route uploaded files and images to authenticated downloads',
    (tester) async {
      final opened = <(String, String)>[];
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: Md(
              '[notes.pdf](/api/v1/attachments/document)\n\n![diagram.png](/api/v1/attachments/image)',
              onAttachment: (url, name) => opened.add((url, name)),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('notes.pdf'));
      await tester.tap(find.text('diagram.png'));
      expect(opened, [
        ('/api/v1/attachments/document', 'notes.pdf'),
        ('/api/v1/attachments/image', 'diagram.png'),
      ]);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('uploads images and files into the existing Task description', (
    tester,
  ) async {
    final h = await mount(tester);
    await h.openTask();
    await tester.pumpAndSettle();
    showEditTask(tester.element(find.byType(Scaffold).first), h.controller);
    await tester.pumpAndSettle();
    picker.files = [_PickedFile('diagram.png'), _PickedFile('notes.pdf')];
    await tester.tap(find.byTooltip('Attach images or files'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Images'));
    await tester.pumpAndSettle();
    expect(picker.lastType, FileType.image);
    await tester.tap(find.text('Save').last);
    await tester.pumpAndSettle();
    expect(
      h.api.currentTask['description'],
      contains('![diagram.png](/api/v1/attachments/diagram.png)'),
    );
    expect(
      h.api.currentTask['description'],
      contains('[notes.pdf](/api/v1/attachments/notes.pdf)'),
    );
    expect(tester.takeException(), isNull);
  });
}
