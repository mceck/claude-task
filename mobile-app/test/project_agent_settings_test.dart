import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:claude_task_mobile/src/api.dart';
import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/settings.dart';
import 'package:claude_task_mobile/src/ui/widgets.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

final class _PickedEnvFile extends PlatformFile {
  final String content;
  _PickedEnvFile(this.content);
  @override
  String get name => '.env';
  @override
  Uri get uri => Uri.file('/test/.env');
  @override
  get xFile => throw UnimplementedError();
  @override
  int lengthSync() => utf8.encode(content).length;
  @override
  Future<int> length() async => lengthSync();
  @override
  Future<Uint8List> readAsBytes() async =>
      Uint8List.fromList(utf8.encode(content));
  @override
  Stream<Uint8List> readAsByteStream() => Stream.fromFuture(readAsBytes());
}

class _EnvFilePicker extends FilePickerPlatform {
  final PlatformFile file;
  _EnvFilePicker(this.file);
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
  }) async => file;
}

class _ProjectAgentApi extends FakeApi {
  Json settings = {
    'setupScript': 'pnpm install',
    'agentInstructions': 'Run tests before review.',
    'defaultAgentId': 'agent-disabled',
    'env': <Json>[
      {
        'id': 'env-1',
        'name': 'API_URL',
        'value': 'https://api.example.com',
        'secret': false,
        'last4': null,
      },
      {
        'id': 'env-2',
        'name': 'TOKEN',
        'value': null,
        'secret': true,
        'last4': 'abcd',
      },
    ],
  };
  final writes = <(String, String, Json?)>[];
  bool failLoad = false, failSave = false;
  Completer<void>? holdSave;

  @override
  Future<Json> request(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  }) async {
    if (path == '/agents') {
      return {
        'agents': [
          {'id': 'agent-1', 'name': 'Ada Bot', 'enabled': true},
          {'id': 'agent-disabled', 'name': 'Previous Agent', 'enabled': false},
          {
            'id': 'agent-hidden',
            'name': 'Other disabled Agent',
            'enabled': false,
          },
        ],
      };
    }
    if (path == '/projects/project-1/agent-settings' && method == 'GET') {
      if (failLoad) {
        throw const ApiException(503, 'unavailable', 'Settings unavailable');
      }
      return {
        'settings': {...settings},
      };
    }
    if (path == '/projects/project-1/agent-settings' && method == 'PATCH' ||
        path.startsWith('/projects/project-1/env/')) {
      writes.add((method, path, body == null ? null : {...body}));
      if (failSave) {
        throw const ApiException(503, 'unavailable', 'Save unavailable');
      }
      if (method == 'PATCH') {
        await holdSave?.future;
        settings = {...settings, ...body!};
      } else if (method == 'PUT') {
        final name = Uri.decodeComponent(path.split('/').last);
        settings = {
          ...settings,
          'env': [
            ...objects(settings['env']).where((v) => v['name'] != name),
            {
              'id': 'env-$name',
              'name': name,
              'value': body!['secret'] == true ? null : body['value'],
              'secret': body['secret'],
              'last4': body['secret'] == true ? 'wxyz' : null,
            },
          ],
        };
      } else if (method == 'DELETE') {
        settings = {
          ...settings,
          'env': objects(settings['env'])
              .where((v) => v['name'] != path.split('/').last)
              .toList(),
        };
      } else if (method == 'POST') {
        settings = {
          ...settings,
          'env': [
            ...objects(settings['env']),
            {
              'id': 'imported',
              'name': 'IMPORTED',
              'value': null,
              'secret': true,
              'last4': null,
            },
          ],
        };
      }
      return {
        'settings': {...settings},
      };
    }
    return super.request(method, path, body: body, files: files);
  }
}

Finder _choice(String label) => find.descendant(
  of: find.ancestor(of: find.text(label), matching: find.byType(LabeledField)),
  matching: find.byType(SelectField),
);

Finder _field(String label) => find.descendant(
  of: find.ancestor(of: find.text(label), matching: find.byType(LabeledField)),
  matching: find.byType(TextField),
);

void _expectWrite(
  (String, String, Json?) actual,
  (String, String, Json) expected,
) {
  expect(actual.$1, expected.$1);
  expect(actual.$2, expected.$2);
  expect(actual.$3, expected.$3);
}

Future<void> _tap(WidgetTester tester, Finder finder) async {
  if (finder.evaluate().isEmpty) {
    await tester.scrollUntilVisible(
      finder,
      250,
      scrollable: find.byType(Scrollable).last,
    );
  }
  await tester.ensureVisible(finder.last);
  await tester.pumpAndSettle();
  await tester.tap(finder.last);
  await tester.pumpAndSettle();
}

Future<Harness> _open(
  WidgetTester tester,
  _ProjectAgentApi api, {
  bool admin = false,
  bool phone = false,
}) async {
  tester.view.physicalSize = phone
      ? const Size(390, 844)
      : const Size(800, 1800);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  api.user = {...userData, 'role': admin ? 'admin' : 'member'};
  final h = Harness(api: api);
  addTearDown(h.dispose);
  await h.login();
  await tester.pumpWidget(TaskApp(controller: h.controller));
  await tester.pumpAndSettle();
  unawaited(
    showProjectsSettings(
      tester.element(find.byType(Scaffold).first),
      h.controller,
    ),
  );
  await tester.pumpAndSettle();
  await _tap(tester, find.text('Payments'));
  await _tap(tester, find.text('Agent setup'));
  return h;
}

void main() {
  testWidgets('the Automatic resume at limit switch saves on its own', (
    tester,
  ) async {
    final api = _ProjectAgentApi();
    await _open(tester, api);
    await _tap(tester, find.text('Automatic resume at limit'));
    _expectWrite(api.writes.last, (
      'PATCH',
      '/projects/project-1/agent-settings',
      {'autoResume': true},
    ));
    expect(tester.widget<Switch>(find.byType(Switch).first).value, isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('phone Project settings selects and clears the default Agent', (
    tester,
  ) async {
    final api = _ProjectAgentApi();
    await _open(tester, api, phone: true);
    expect(find.text('Previous Agent (disabled)'), findsOneWidget);
    await _tap(tester, _choice('Default Agent'));
    expect(find.text('Previous Agent'), findsOneWidget);
    expect(find.text('Other disabled Agent'), findsNothing);
    await _tap(tester, find.text('Ada Bot'));
    _expectWrite(api.writes.last, (
      'PATCH',
      '/projects/project-1/agent-settings',
      {'defaultAgentId': 'agent-1'},
    ));
    await _tap(tester, _choice('Default Agent'));
    await _tap(tester, find.text('No Agent'));
    expect(api.writes.last.$3, {'defaultAgentId': null});
    expect(tester.takeException(), isNull);
  });

  testWidgets('Member autosaves only changed fields after 600 ms and on blur', (
    tester,
  ) async {
    final api = _ProjectAgentApi();
    await _open(tester, api);
    expect(
      tester
          .widget<TextField>(_field('Worktree Setup Script'))
          .controller!
          .text,
      'pnpm install',
    );
    await tester.enterText(_field('Worktree Setup Script'), 'pnpm ci');
    await tester.pump(const Duration(milliseconds: 599));
    expect(api.writes, isEmpty);
    await tester.pump(const Duration(milliseconds: 1));
    await tester.pumpAndSettle();
    expect(api.writes.single.$3, {'setupScript': 'pnpm ci'});
    await tester.enterText(_field('Agent Instructions'), 'Use Flutter.');
    await tester.tap(_field('Worktree Setup Script'));
    await tester.pumpAndSettle();
    expect(api.writes.last.$3, {'agentInstructions': 'Use Flutter.'});
    expect(find.text('Saved'), findsOneWidget);
    expect(find.byTooltip('Add variable'), findsNothing);
    expect(find.text('Import .env'), findsNothing);
    expect(find.byTooltip('Delete TOKEN'), findsNothing);
    expect(find.text('Secret · …abcd'), findsOneWidget);
  });

  testWidgets(
    'autosave serializes requests and preserves edits during a save',
    (tester) async {
      final api = _ProjectAgentApi()..holdSave = Completer<void>();
      await _open(tester, api);
      await tester.enterText(_field('Agent Instructions'), 'First edit');
      await tester.pump(const Duration(milliseconds: 600));
      expect(api.writes, hasLength(1));
      await tester.enterText(_field('Agent Instructions'), 'Second edit');
      await tester.pump(const Duration(milliseconds: 600));
      expect(api.writes, hasLength(1));
      api.holdSave!.complete();
      await tester.pumpAndSettle();
      expect(api.writes, hasLength(2));
      expect(api.writes.last.$3, {'agentInstructions': 'Second edit'});
      expect(api.settings['agentInstructions'], 'Second edit');
    },
  );

  testWidgets('save failure keeps edits and Retry saves them', (tester) async {
    final api = _ProjectAgentApi()..failSave = true;
    await _open(tester, api);
    await tester.enterText(_field('Agent Instructions'), 'Keep my changes');
    await tester.pump(const Duration(milliseconds: 600));
    await tester.pumpAndSettle();
    expect(find.textContaining('Save unavailable'), findsOneWidget);
    expect(
      tester.widget<TextField>(_field('Agent Instructions')).controller!.text,
      'Keep my changes',
    );
    api.failSave = false;
    await _tap(tester, find.text('Retry'));
    expect(api.settings['agentInstructions'], 'Keep my changes');
    expect(find.text('Saved'), findsOneWidget);
  });

  testWidgets(
    'Back flushes pending changes before leaving Project Agent setup',
    (tester) async {
      final api = _ProjectAgentApi();
      await _open(tester, api);
      await tester.enterText(_field('Agent Instructions'), 'Save on back');
      await tester.pump();
      await tester.tap(find.byTooltip('Back'));
      await tester.pumpAndSettle();
      expect(api.settings['agentInstructions'], 'Save on back');
      expect(find.text('Payments settings'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('load failure offers Retry', (tester) async {
    final api = _ProjectAgentApi()..failLoad = true;
    await _open(tester, api);
    expect(find.textContaining('Settings unavailable'), findsOneWidget);
    api.failLoad = false;
    await _tap(tester, find.text('Retry'));
    expect(_field('Worktree Setup Script'), findsOneWidget);
  });

  testWidgets('failed Back save leaves the screen open with its draft', (
    tester,
  ) async {
    final api = _ProjectAgentApi()..failSave = true;
    await _open(tester, api);
    await tester.enterText(_field('Agent Instructions'), 'Keep this draft');
    await tester.pump();
    await tester.tap(find.byTooltip('Back'));
    await tester.pumpAndSettle();
    expect(_field('Agent Instructions'), findsOneWidget);
    expect(
      tester.widget<TextField>(_field('Agent Instructions')).controller!.text,
      'Keep this draft',
    );
    expect(find.textContaining('Save unavailable'), findsOneWidget);
  });

  testWidgets('variable changes keep instruction edits made during autosave', (
    tester,
  ) async {
    final api = _ProjectAgentApi()..holdSave = Completer<void>();
    await _open(tester, api, admin: true);
    await tester.enterText(_field('Agent Instructions'), 'First draft');
    await tester.pump(const Duration(milliseconds: 600));
    await tester.enterText(_field('Agent Instructions'), 'Latest draft');
    await _tap(tester, find.byTooltip('Add variable'));
    await tester.enterText(_field('Variable name'), 'NEW_VAR');
    await tester.enterText(_field('Value'), 'value');
    await _tap(tester, find.text('Save variable'));
    expect(
      tester.widget<TextField>(_field('Agent Instructions')).controller!.text,
      'Latest draft',
    );
    api.holdSave!.complete();
    await tester.pumpAndSettle();
    expect(api.settings['agentInstructions'], 'Latest draft');
    expect(find.text('NEW_VAR'), findsOneWidget);
    expect(find.text('Saved'), findsOneWidget);
  });

  testWidgets('Admin adds and deletes Project variables', (tester) async {
    final api = _ProjectAgentApi();
    await _open(tester, api, admin: true);
    await _tap(tester, find.byTooltip('Add variable'));
    await tester.enterText(_field('Variable name'), 'SERVICE_URL');
    await tester.enterText(_field('Value'), 'https://service.example.com');
    await _tap(tester, find.text('Save variable'));
    _expectWrite(api.writes.last, (
      'PUT',
      '/projects/project-1/env/SERVICE_URL',
      {'value': 'https://service.example.com', 'secret': false},
    ));
    expect(find.text('SERVICE_URL'), findsOneWidget);
    await _tap(tester, find.byTooltip('Delete SERVICE_URL'));
    await _tap(tester, find.text('Delete variable'));
    expect(api.writes.last.$1, 'DELETE');
    expect(api.writes.last.$2, '/projects/project-1/env/SERVICE_URL');
    expect(find.text('SERVICE_URL'), findsNothing);
  });

  testWidgets(
    'secret replacement needs a new value and preserves drafts on failure',
    (tester) async {
      final api = _ProjectAgentApi();
      await _open(tester, api, admin: true);
      await _tap(tester, find.text('TOKEN'));
      expect(
        tester.widget<TextField>(_field('New value')).controller!.text,
        isEmpty,
      );
      expect(tester.widget<TextField>(_field('New value')).obscureText, isTrue);
      await _tap(tester, find.text('Save variable'));
      expect(api.writes, isEmpty);
      expect(find.text('Enter a new value.'), findsOneWidget);
      await tester.enterText(_field('New value'), 'replacement-secret');
      api.failSave = true;
      await _tap(tester, find.text('Save variable'));
      expect(find.textContaining('Save unavailable'), findsOneWidget);
      expect(
        tester.widget<TextField>(_field('New value')).controller!.text,
        'replacement-secret',
      );
      api.failSave = false;
      await _tap(tester, find.text('Save variable'));
      expect(api.writes.last.$3, {
        'value': 'replacement-secret',
        'secret': true,
      });
      expect(find.text('Secret · …wxyz'), findsOneWidget);
      expect(find.text('replacement-secret'), findsNothing);
    },
  );

  testWidgets('reserved names are rejected before sending', (tester) async {
    final api = _ProjectAgentApi();
    await _open(tester, api, admin: true);
    await _tap(tester, find.byTooltip('Add variable'));
    await tester.enterText(_field('Variable name'), 'ANTHROPIC_API_KEY');
    await tester.enterText(_field('Value'), 'key');
    await _tap(tester, find.text('Save variable'));
    expect(api.writes, isEmpty);
    expect(
      find.text('ANTHROPIC_API_KEY is set by the platform.'),
      findsOneWidget,
    );
  });

  testWidgets(
    'dotenv import previews overwritten names and submits secret mode',
    (tester) async {
      final api = _ProjectAgentApi();
      await _open(tester, api, admin: true);
      await _tap(tester, find.text('Import .env'));
      const content =
          'API_URL=https://new.example.com\nTOKEN=new-secret\nIMPORTED=yes';
      await tester.enterText(_field('.env content'), content);
      await tester.pumpAndSettle();
      expect(find.text('API_URL · overwrites'), findsOneWidget);
      expect(find.text('TOKEN · overwrites secret'), findsOneWidget);
      await tester.tap(find.byType(Switch).last);
      await _tap(tester, find.text('Import variables'));
      _expectWrite(api.writes.last, (
        'POST',
        '/projects/project-1/env/import',
        {'content': content, 'secret': true},
      ));
      expect(find.text('IMPORTED'), findsOneWidget);
    },
  );

  testWidgets('invalid dotenv input stays editable and cannot be imported', (
    tester,
  ) async {
    final api = _ProjectAgentApi();
    await _open(tester, api, admin: true);
    await _tap(tester, find.text('Import .env'));
    await tester.enterText(_field('.env content'), 'VALID=1\nbroken');
    await tester.pumpAndSettle();
    expect(find.textContaining('Line 2: expected NAME=value'), findsOneWidget);
    expect(
      tester
          .widget<AppButton>(find.widgetWithText(AppButton, 'Import variables'))
          .onPressed,
      isNull,
    );
    expect(api.writes, isEmpty);
  });

  testWidgets(
    'dotenv file selection loads a preview and imports its contents',
    (tester) async {
      final previousPicker = FilePickerPlatform.instance;
      const content = 'IMPORTED=from-file\nUNICODE=caffè';
      FilePickerPlatform.instance = _EnvFilePicker(_PickedEnvFile(content));
      addTearDown(() => FilePickerPlatform.instance = previousPicker);
      final api = _ProjectAgentApi();
      await _open(tester, api, admin: true);
      await _tap(tester, find.text('Import .env'));
      await _tap(tester, find.text('Choose file'));
      expect(
        tester.widget<TextField>(_field('.env content')).controller!.text,
        content,
      );
      expect(find.text('UNICODE'), findsOneWidget);
      await _tap(tester, find.text('Import variables'));
      _expectWrite(api.writes.last, (
        'POST',
        '/projects/project-1/env/import',
        {'content': content, 'secret': false},
      ));
    },
  );
}
