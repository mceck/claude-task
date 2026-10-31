import 'package:claude_task_mobile/src/api.dart';
import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/controller.dart';
import 'package:claude_task_mobile/src/models.dart';
import 'package:claude_task_mobile/src/settings.dart';
import 'package:claude_task_mobile/src/ui/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

import 'support.dart';

class InfrastructureApi extends FakeApi {
  final writes = <(String, String, Json?)>[];
  final requestedPaths = <String>[];
  final skills = <Json>[
    {
      'id': 'skill-1',
      'name': 'review',
      'description': 'Review code',
      'source': 'team/skills',
      'fileCount': 2,
      'userInvocable': true,
    },
  ];
  final plugins = <Json>[
    {
      'id': 'plugin-1',
      'name': 'tools@team',
      'source': '',
      'description': 'Team tools',
    },
  ];
  final servers = <Json>[
    {
      'id': 'mcp-1',
      'name': 'search',
      'description': 'Search docs',
      'type': 'http',
      'url': 'https://mcp.example.com',
      'command': '',
      'args': <String>[],
      'env': <String, dynamic>{},
      'headers': {
        'Authorization': {'value': null, 'secret': true, 'last4': 'abcd'},
        'X-Team': {'value': 'Engineering', 'secret': false, 'last4': null},
      },
    },
  ];
  final connections = <Json>[
    {
      'id': 'connection-1',
      'provider': 'gitlab',
      'name': 'Team GitLab',
      'host': 'gitlab.example.com',
      'source': 'database',
      'baseUrl': 'https://gitlab.example.com',
      'appId': null,
      'secretLast4': '1234',
      'expiresAt': '2027-01-01',
      'access': <Json>[],
      'health': {'state': 'ok'},
      'linkedProjects': 1,
    },
    {
      'id': 'env-github',
      'provider': 'github',
      'name': 'Environment GitHub',
      'host': 'github.com',
      'source': 'environment',
      'appId': '42',
      'secretLast4': null,
      'access': <Json>[],
      'health': {'state': 'error', 'message': 'Provider unavailable'},
      'linkedProjects': 0,
    },
  ];
  Json agent = {
    'id': 'agent-1',
    'name': 'Ada Bot',
    'enabled': true,
    'avatarEmoji': '🤖',
    'state': 'idle',
    'containerState': 'running',
    'runnerConnected': true,
    'recreatePending': false,
    'skillIds': ['skill-1'],
    'mcpServerIds': ['mcp-1'],
    'pluginIds': <String>[],
    'extensionsPending': true,
    'extensionsError': 'Marketplace unavailable',
  };
  Json repository = {
    'connectionId': 'connection-1',
    'providerRepoId': '7',
    'provider': 'gitlab',
    'owner': 'team',
    'name': 'api',
    'defaultBranch': 'main',
    'baseBranch': 'main',
    'webUrl': 'https://gitlab.example.com/team/api',
    'protection': {
      'protected': true,
      'details': 'Maintainers only',
      'checkedAt': '2026-10-27T10:00:00Z',
      'settingsUrl': 'https://gitlab.example.com/team/api/settings',
    },
  };
  bool locked = false,
      failList = false,
      failSave = false,
      missingCurrent = false;

  @override
  Future<Json> request(
    String method,
    String path, {
    Json? body,
    List<DraftFile> files = const [],
  }) async {
    requestedPaths.add('$method $path');
    if (path == '/agents' && method == 'GET') {
      return {
        'agents': [agent],
      };
    }
    if (path == '/credentials') return {'credentials': <Json>[]};
    if (method != 'GET' &&
        (path.startsWith('/skills') ||
            path.startsWith('/plugins') ||
            path.startsWith('/mcp-servers') ||
            path.startsWith('/git/') ||
            path.startsWith('/agents/') ||
            path.contains('/repository'))) {
      writes.add((method, path, body));
      if (failSave) {
        throw const ApiException(
          409,
          'conflict',
          'Unassign this Extension from all Agents before deleting it',
        );
      }
      if (path == '/agents/agent-1') agent = {...agent, ...body!};
      if (path == '/plugins' && method == 'POST') {
        plugins.add({'id': 'plugin-new', ...body!});
      }
      if (path == '/plugins/plugin-1' && method == 'PUT') {
        plugins[0] = {...plugins[0], ...body!};
      }
      if (path.startsWith('/plugins/') && method == 'DELETE') {
        plugins.removeWhere((p) => path == '/plugins/${p['id']}');
      }
      if (path == '/mcp-servers/mcp-1') servers[0] = {...servers[0], ...body!};
      if (path == '/git/connections/connection-1' && method == 'PATCH') {
        connections[0] = {...connections[0], ...body!};
      }
      if (path == '/projects/project-1/repository' && method == 'PUT') {
        repository = {...repository, ...body!};
      }
      if (path == '/projects/project-1/repository/check-protection') {
        repository = {
          ...repository,
          'protection': {
            ...repository['protection'] as Json,
            'checkedAt': '2026-10-27T10:30:00Z',
          },
        };
      }
      if (path.contains('/repository')) {
        return {'repository': repository, 'hasOpenSessions': locked};
      }
      return {};
    }
    if (path == '/skills') {
      if (failList) {
        throw const ApiException(503, 'unavailable', 'Catalog unavailable');
      }
      return {'skills': skills};
    }
    if (path == '/plugins') return {'plugins': plugins};
    if (path == '/mcp-servers') return {'mcpServers': servers};
    if (path == '/git/connections') return {'connections': connections};
    if (path == '/projects/project-1/repository') {
      return {'repository': repository, 'hasOpenSessions': locked};
    }
    if (path == '/git/repositories') {
      return {
        'groups': [
          {
            'connection': {
              'id': 'connection-1',
              'name': 'Team GitLab',
              'host': 'gitlab.example.com',
            },
            'repositories': missingCurrent ? <Json>[] : [repository],
            'error': missingCurrent ? 'GitLab unavailable' : null,
          },
          {
            'connection': {
              'id': 'connection-2',
              'name': 'Other connection',
              'host': 'github.com',
            },
            'repositories': [
              {
                ...repository,
                'connectionId': 'connection-2',
                'owner': 'other',
                'name': 'service',
                'defaultBranch': 'develop',
              },
            ],
            'error': null,
          },
        ],
      };
    }
    return super.request(method, path, body: body, files: files);
  }
}

Future<Harness> openSettings(
  WidgetTester tester,
  InfrastructureApi api,
  Future<void> Function(BuildContext, TaskController) open, {
  bool admin = true,
  Size size = const Size(800, 2000),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  api.user = {...userData, 'role': admin ? 'admin' : 'member'};
  final h = Harness(api: api);
  addTearDown(h.dispose);
  await h.login();
  await tester.pumpWidget(TaskApp(controller: h.controller));
  await tester.pumpAndSettle();
  open(tester.element(find.byType(Scaffold).first), h.controller);
  await tester.pumpAndSettle();
  return h;
}

Future<void> tap(WidgetTester tester, Finder finder) async {
  await tester.pump();
  await tester.ensureVisible(finder.last);
  await tester.tap(finder.last);
  await tester.pumpAndSettle();
}

/// The text field labelled [label], above it or inside it.
Finder input(String label) {
  final labelled = find.descendant(
    of: find.ancestor(of: find.text(label), matching: find.byType(LabeledField)),
    matching: find.byType(TextField),
  );
  if (labelled.evaluate().isNotEmpty) return labelled;
  return find.byWidgetPredicate(
    (w) =>
        w is TextField &&
        (w.decoration?.labelText == label || w.decoration?.hintText == label),
  );
}

void expectWrite(
  (String, String, Json?) actual,
  (String, String, Json) expected,
) {
  expect(actual.$1, expected.$1);
  expect(actual.$2, expected.$2);
  expect(actual.$3, expected.$3);
}

void main() {
  testWidgets(
    're-checking protection preserves unsaved Repository and Base Branch edits',
    (tester) async {
      final api = InfrastructureApi();
      await openSettings(tester, api, showProjectsSettings, admin: false);
      await tap(tester, find.text('Payments'));
      await tap(tester, find.text('Repository'));
      await tap(tester, find.text('other/service'));
      await tester.enterText(find.byType(TextField).last, 'release-candidate');
      await tap(tester, find.text('Re-check protection'));
      expect(find.text('Checked 2026-10-27T10:30:00Z'), findsOneWidget);
      expect(
        tester.widget<TextField>(find.byType(TextField).last).controller!.text,
        'release-candidate',
      );
      await tap(tester, find.text('Save repository'));
      expect(api.writes.last.$3, {
        'connectionId': 'connection-2',
        'providerRepoId': '7',
        'baseBranch': 'release-candidate',
      });
    },
  );

  testWidgets(
    'renaming a saved MCP secret requires a replacement and reverting preserves the secret',
    (tester) async {
      final api = InfrastructureApi();
      await openSettings(tester, api, showExtensionsSettings);
      await tap(tester, find.text('Edit').last);
      await tester.enterText(input('Headers name 1'), 'New-Authorization');
      await tap(tester, find.text('Save MCP Server'));
      expect(api.writes, isEmpty);
      expect(find.textContaining('Enter a replacement secret'), findsOneWidget);
      await tester.enterText(input('Headers name 1'), 'Authorization');
      await tap(tester, find.text('Save MCP Server'));
      expect(api.writes.single.$3!['headers']['Authorization'], {
        'value': null,
        'secret': true,
      });
    },
  );

  testWidgets('Admin creates, edits, updates and deletes catalog Plugins', (
    tester,
  ) async {
    final api = InfrastructureApi();
    await openSettings(tester, api, showExtensionsSettings);
    await tap(tester, find.byTooltip('Add Plugin'));
    await tester.enterText(input('Plugin name'), 'helper@team');
    await tester.enterText(input('Description'), 'More tools');
    await tap(tester, find.text('Save Plugin'));
    expect(api.writes.single.$3, {
      'name': 'helper@team',
      'source': '',
      'description': 'More tools',
    });
    expect(find.text('helper@team'), findsOneWidget);

    await tap(tester, find.text('Edit').first);
    await tester.enterText(input('Description'), 'Updated tools');
    await tap(tester, find.text('Save Plugin'));
    expect(api.writes.last.$1, 'PUT');
    expect(api.writes.last.$2, '/plugins/plugin-1');
    expect(find.textContaining('Updated tools'), findsOneWidget);
    await tap(tester, find.text('Update').first);
    expect(api.writes.last.$2, '/plugins/plugin-1/update');
    await tap(tester, find.text('Delete').at(1));
    await tap(tester, find.text('Delete Extension'));
    expect(api.writes.last.$1, 'DELETE');
    expect(api.writes.last.$2, '/plugins/plugin-1');
    expect(find.text('tools@team'), findsNothing);
  });

  testWidgets('MCP rejects duplicate header names without losing the form', (
    tester,
  ) async {
    final api = InfrastructureApi();
    await openSettings(tester, api, showExtensionsSettings);
    await tap(tester, find.text('Edit').last);
    await tester.enterText(input('Headers name 2'), 'Authorization');
    await tap(tester, find.text('Save MCP Server'));
    expect(api.writes, isEmpty);
    expect(
      find.textContaining('Duplicate variable or header name'),
      findsOneWidget,
    );
    expect(find.text('Edit MCP Server'), findsOneWidget);
  });

  testWidgets('Admin imports all Skills and reimports an existing Skill', (
    tester,
  ) async {
    final api = InfrastructureApi();
    await openSettings(tester, api, showExtensionsSettings);
    await tap(tester, find.byTooltip('Import Skills'));
    await tester.enterText(find.byType(TextField).first, 'team/new-skills');
    await tester.pump();
    await tap(tester, find.text('Import Skills'));
    expectWrite(api.writes.single, (
      'POST',
      '/skills/import',
      {
        'source': 'team/new-skills',
        'skills': ['*'],
      },
    ));
    await tap(tester, find.text('Reimport'));
    expect(api.writes.last.$3, {
      'source': 'team/skills',
      'skills': ['review'],
    });
    expect(find.text('/review'), findsOneWidget);
  });

  testWidgets('MCP edits preserve saved secrets and plain header values', (
    tester,
  ) async {
    final api = InfrastructureApi();
    final h = await openSettings(tester, api, showExtensionsSettings);
    await tap(tester, find.text('Edit').last);
    expect(find.text('Saved secret …abcd (unchanged)'), findsOneWidget);
    await tester.enterText(find.byType(TextField).at(1), 'Updated description');
    await tap(tester, find.text('Save MCP Server'));
    final body = api.writes.single.$3!;
    expect(body['headers'], {
      'Authorization': {'value': null, 'secret': true},
      'X-Team': {'value': 'Engineering', 'secret': false},
    });
    expect(body['description'], 'Updated description');
    expect(h.storage.data.toString(), isNot(contains('Authorization')));
  });

  testWidgets(
    'MCP header removal keeps remaining rows and supports secret replacement',
    (tester) async {
      final api = InfrastructureApi();
      await openSettings(tester, api, showExtensionsSettings);
      await tap(tester, find.text('Edit').last);
      await tap(tester, find.byTooltip('Remove Headers 1'));
      expect(input('Headers name 1'), findsOneWidget);
      expect(find.text('Engineering'), findsOneWidget);
      await tester.enterText(input('Headers value 1'), 'new-secret');
      await tap(tester, find.byType(Switch));
      await tap(tester, find.text('Save MCP Server'));
      expect(api.writes.single.$3!['headers'], {
        'X-Team': {'value': 'new-secret', 'secret': true},
      });
    },
  );

  testWidgets(
    'stdio MCP uses arguments and environment instead of HTTP fields',
    (tester) async {
      final api = InfrastructureApi();
      await openSettings(
        tester,
        api,
        showExtensionsSettings,
        size: const Size(390, 844),
      );
      await tap(tester, find.byTooltip('Add MCP Server'));
      await tester.enterText(find.byType(TextField).first, 'local-tools');
      await tap(tester, find.text('stdio'));
      await tester.enterText(find.byType(TextField).at(2), 'npx');
      await tester.enterText(
        find.byType(TextField).at(3),
        'server\nargument with spaces',
      );
      await tap(tester, find.text('Add Environment variables'));
      await tester.enterText(
        input('Environment variables name 1'),
        'API_TOKEN',
      );
      await tester.enterText(
        input('Environment variables value 1'),
        'new-token',
      );
      await tap(tester, find.byType(Switch));
      await tap(tester, find.text('Save MCP Server'));
      expect(api.writes.single.$3, {
        'name': 'local-tools',
        'description': '',
        'type': 'stdio',
        'url': '',
        'command': 'npx',
        'args': ['server', 'argument with spaces'],
        'headers': <String, dynamic>{},
        'env': {
          'API_TOKEN': {'value': 'new-token', 'secret': true},
        },
      });
    },
  );

  testWidgets(
    'catalog failures retry and deletion conflicts keep the entry visible',
    (tester) async {
      final api = InfrastructureApi()..failList = true;
      await openSettings(tester, api, showExtensionsSettings);
      expect(find.text('Catalog unavailable'), findsOneWidget);
      api.failList = false;
      await tap(tester, find.text('Retry'));
      expect(find.text('/review'), findsOneWidget);
      api.failSave = true;
      await tap(tester, find.text('Delete').first);
      await tap(tester, find.text('Delete Extension'));
      expect(find.text('/review'), findsOneWidget);
      expect(
        find.text('Unassign this Extension from all Agents before deleting it'),
        findsOneWidget,
      );
    },
  );

  testWidgets(
    'Agent selections preserve unchanged assignments and show live sync errors',
    (tester) async {
      final api = InfrastructureApi();
      final h = await openSettings(tester, api, showAgentsSettings);
      expect(find.textContaining('Marketplace unavailable'), findsOneWidget);
      await tap(tester, find.text('Ada Bot'));
      await tap(tester, find.text('tools@team'));
      await tap(tester, find.text('Save agent'));
      final body = api.writes.single.$3!;
      expect(body['pluginIds'], ['plugin-1']);
      expect(body.containsKey('skillIds'), isFalse);
      expect(body.containsKey('mcpServerIds'), isFalse);
      api.agent = {
        ...api.agent,
        'extensionsPending': false,
        'extensionsError': null,
      };
      h.live.eventController.add({'type': 'agent.updated', 'agent': api.agent});
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pumpAndSettle();
      expect(find.textContaining('Marketplace unavailable'), findsNothing);
      expect(find.textContaining('Extension changes apply'), findsNothing);
    },
  );

  testWidgets('Admins rebuild and recreate an Agent container', (tester) async {
    final api = InfrastructureApi();
    await openSettings(tester, api, showAgentsSettings);
    await tap(tester, find.text('Ada Bot'));
    expect(find.text('running · Runner connected'), findsOneWidget);

    api.agent = {...api.agent, 'recreatePending': true};
    await tap(tester, find.text('Rebuild image'));
    expect(api.writes.last.$1, 'POST');
    expect(api.writes.last.$2, '/agents/agent-1/rebuild');
    expect(
      find.text(
        'Container recreation is waiting for the current Job to finish.',
      ),
      findsOneWidget,
    );

    await tap(tester, find.text('Recreate when idle'));
    expect(api.writes.last.$2, '/agents/agent-1/recreate');
    expect(api.writes.last.$3, isNull);
  });

  testWidgets(
    'Restart and Force recreate confirm before interrupting the Job',
    (tester) async {
      final api = InfrastructureApi();
      await openSettings(tester, api, showAgentsSettings);
      await tap(tester, find.text('Ada Bot'));

      await tap(tester, find.text('Restart'));
      expect(find.text('Restart this container?'), findsOneWidget);
      await tap(tester, find.text('Cancel'));
      expect(api.writes, isEmpty);

      await tap(tester, find.text('Restart'));
      await tap(tester, find.text('Restart').last);
      expect(api.writes.last.$2, '/agents/agent-1/restart');

      await tap(tester, find.text('Force recreate'));
      expect(find.text('Force recreate this container?'), findsOneWidget);
      await tap(tester, find.text('Force recreate').last);
      expect(api.writes.last.$2, '/agents/agent-1/recreate');
      expect(api.writes.last.$3, {'force': true});
    },
  );

  testWidgets(
    'Git connections keep environment entries read-only and omit unchanged secrets',
    (tester) async {
      final api = InfrastructureApi();
      final h = await openSettings(tester, api, showGitSettings);
      expect(find.textContaining('Environment · read-only'), findsOneWidget);
      expect(find.textContaining('Provider unavailable'), findsOneWidget);
      expect(find.text('Edit / rotate'), findsOneWidget);
      expect(find.text('Delete connection'), findsNothing);
      await tap(tester, find.text('Edit / rotate'));
      await tester.enterText(
        find.byType(TextField).first,
        'Renamed connection',
      );
      await tap(tester, find.text('Save connection'));
      expectWrite(api.writes.single, (
        'PATCH',
        '/git/connections/connection-1',
        {'name': 'Renamed connection'},
      ));
      await tap(tester, find.text('Edit / rotate'));
      await tester.enterText(find.byType(TextField).last, 'replacement-token');
      await tap(tester, find.text('Save connection'));
      expect(api.writes.last.$3!['token'], 'replacement-token');
      expect(h.storage.data.toString(), isNot(contains('replacement-token')));
    },
  );

  testWidgets(
    'Admin creates GitLab and GitHub connections with provider-specific secrets',
    (tester) async {
      final api = InfrastructureApi();
      await openSettings(
        tester,
        api,
        showGitSettings,
        size: const Size(390, 844),
      );
      await tap(tester, find.byTooltip('Add connection'));
      await tap(tester, find.text('GitLab'));
      await tester.enterText(find.byType(TextField).first, 'New GitLab');
      await tester.enterText(find.byType(TextField).last, 'gitlab-secret');
      await tap(tester, find.text('Save connection'));
      expect(api.writes.single.$3, {
        'name': 'New GitLab',
        'provider': 'gitlab',
        'baseUrl': 'https://gitlab.com',
        'token': 'gitlab-secret',
      });
      await tap(tester, find.byTooltip('Add connection'));
      await tester.enterText(find.byType(TextField).at(0), 'New GitHub');
      await tester.enterText(find.byType(TextField).at(1), '123');
      await tester.enterText(find.byType(TextField).at(2), 'PEM\nkey\n');
      await tap(tester, find.text('Save connection'));
      expect(api.writes.last.$3, {
        'name': 'New GitHub',
        'provider': 'github',
        'appId': '123',
        'privateKey': 'PEM\nkey',
      });
    },
  );

  testWidgets(
    'Member can link a Repository from another connection with the same provider id',
    (tester) async {
      final api = InfrastructureApi();
      await openSettings(tester, api, showProjectsSettings, admin: false);
      await tap(tester, find.text('Payments'));
      await tap(tester, find.text('Repository'));
      await tap(tester, find.text('other/service'));
      expect(
        tester.widget<TextField>(find.byType(TextField).last).controller!.text,
        'develop',
      );
      await tap(tester, find.text('Save repository'));
      expectWrite(api.writes.single, (
        'PUT',
        '/projects/project-1/repository',
        {
          'connectionId': 'connection-2',
          'providerRepoId': '7',
          'baseBranch': 'develop',
        },
      ));
    },
  );

  testWidgets(
    'open Sessions lock Repository changes while unavailable connections allow Base Branch edits',
    (tester) async {
      final api = InfrastructureApi()
        ..locked = true
        ..missingCurrent = true;
      await openSettings(tester, api, showProjectsSettings, admin: false);
      await tap(tester, find.text('Payments'));
      await tap(tester, find.text('Repository'));
      expect(find.text('GitLab unavailable'), findsOneWidget);
      expect(find.text('team/api'), findsOneWidget);
      await tap(tester, find.text('other/service'));
      await tester.enterText(find.byType(TextField).last, 'release');
      await tap(tester, find.text('Save repository'));
      expect(api.writes.single.$3, {
        'connectionId': 'connection-1',
        'providerRepoId': '7',
        'baseBranch': 'release',
      });
      await tap(tester, find.text('Re-check protection'));
      expect(
        api.writes.last.$2,
        '/projects/project-1/repository/check-protection',
      );
      expect(find.text('Protected · release'), findsOneWidget);
    },
  );

  testWidgets('phone Settings expose administration to Admins', (tester) async {
    await openSettings(
      tester,
      InfrastructureApi(),
      showSettings,
      size: const Size(390, 844),
    );
    expect(find.text('Extensions'), findsOneWidget);
    await tap(tester, find.text('Git Connections'));
    expect(find.text('Team GitLab'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'Members see no administration entries and direct routes require Admin access',
    (tester) async {
      final api = InfrastructureApi();
      final h = await openSettings(tester, api, showSettings, admin: false);
      expect(find.text('Extensions'), findsNothing);
      expect(find.text('Git Connections'), findsNothing);
      showExtensionsSettings(
        tester.element(find.byType(Scaffold).last),
        h.controller,
      );
      await tester.pumpAndSettle();
      expect(find.text('Admin access required.'), findsOneWidget);
      expect(api.requestedPaths, isNot(contains('GET /mcp-servers')));
      showGitSettings(tester.element(find.byType(Scaffold).last), h.controller);
      await tester.pumpAndSettle();
      expect(find.text('Admin access required.'), findsOneWidget);
      expect(api.requestedPaths, isNot(contains('GET /git/connections')));
    },
  );
}
