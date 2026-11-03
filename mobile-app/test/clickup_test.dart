import 'package:claude_task_mobile/src/models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'a Task imported from ClickUp keeps its title managed until unlinked',
    () {
      final base = {
        'id': 't1',
        'projectId': 'p1',
        'key': 'CU-1',
        'title': 'From ClickUp',
        'statusId': 's1',
      };
      final linked = Task.fromJson({
        ...base,
        'clickup': {
          'url': 'https://app.clickup.com/t/a1',
          'linked': true,
          'descriptionDetached': true,
          'pushPending': false,
          'error': null,
        },
      });
      expect(linked.titleManagedByClickUp, isTrue);
      expect(linked.clickup!['descriptionDetached'], isTrue);
      expect(Task.movedTo(linked, 's2').clickup, linked.clickup);

      final unlinked = Task.fromJson({
        ...base,
        'clickup': {'url': null, 'linked': false},
      });
      expect(unlinked.titleManagedByClickUp, isFalse);
      expect(Task.fromJson(base).clickup, isNull);
    },
  );

  test('a Project exposes its ClickUp Link', () {
    final project = Project.fromJson({
      'id': 'p1',
      'key': 'CU',
      'name': 'Mirrored',
      'clickup': {'sourceType': 'list', 'sourceId': 'L1', 'lastError': null},
    });
    expect(project.clickup!['sourceId'], 'L1');
    expect(
      Project.fromJson({'id': 'p2', 'key': 'AB', 'name': 'Plain'}).clickup,
      isNull,
    );
  });
}
