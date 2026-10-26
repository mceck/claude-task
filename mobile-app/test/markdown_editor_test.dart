import 'package:claude_task_mobile/src/app.dart';
import 'package:claude_task_mobile/src/task_forms.dart';
import 'package:claude_task_mobile/src/ui/markdown_editor.dart';
import 'package:claude_task_mobile/src/ui/theme.dart';
import 'package:fleather/fleather.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'support.dart';

Future<void> mount(
  WidgetTester tester,
  TextEditingController controller, {
  bool enabled = true,
}) => tester.pumpWidget(
  MaterialApp(
    theme: buildTheme(),
    localizationsDelegates: const [FleatherLocalizations.delegate],
    home: Scaffold(
      body: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: MarkdownEditor(controller: controller, enabled: enabled),
        ),
      ),
    ),
  ),
);

FleatherController rich(WidgetTester tester) =>
    tester.widget<FleatherEditor>(find.byType(FleatherEditor)).controller;

void main() {
  testWidgets(
    'typing Markdown inside code stays literal, and block shortcuts respect existing lists',
    (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await mount(tester, controller);
      await tester.pumpAndSettle();
      final editor = rich(tester);
      editor.formatSelection(ParchmentAttribute.code);
      const text = '**literal** # heading';
      for (var i = 0; i < text.length; i++) {
        editor.replaceText(
          i,
          0,
          text[i],
          selection: TextSelection.collapsed(offset: i + 1),
        );
      }
      await tester.pumpAndSettle();
      expect(controller.text, '```\n$text\n```');
      controller.text = '- Item';
      await tester.pumpAndSettle();
      rich(tester).replaceText(
        0,
        0,
        '#',
        selection: const TextSelection.collapsed(offset: 1),
      );
      rich(tester).replaceText(
        1,
        0,
        ' ',
        selection: const TextSelection.collapsed(offset: 2),
      );
      await tester.pumpAndSettle();
      expect(controller.text, r'- \# Item');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'block formats replace incompatible styles and unsupported shortcuts do not add invisible formatting',
    (tester) async {
      final controller = TextEditingController(text: '- Item');
      addTearDown(controller.dispose);
      await mount(tester, controller);
      await tester.pumpAndSettle();
      rich(tester).formatSelection(ParchmentAttribute.h2);
      await tester.pumpAndSettle();
      expect(controller.text, '## Item');
      rich(tester).formatSelection(ParchmentAttribute.bq);
      await tester.pumpAndSettle();
      expect(controller.text, '> Item');
      rich(tester).formatSelection(ParchmentAttribute.indent.withLevel(1));
      rich(tester).formatText(0, 4, ParchmentAttribute.underline);
      await tester.pumpAndSettle();
      expect(controller.text, '> Item');
      expect(
        rich(
          tester,
        ).document.collectStyle(0, 4).contains(ParchmentAttribute.underline),
        isFalse,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'linked images retain metadata and render in Preview without fetching the image',
    (tester) async {
      final controller = TextEditingController(
        text: 'Before\n\n![Example image](https://example.com/a.png "Title")',
      );
      addTearDown(controller.dispose);
      await mount(tester, controller);
      await tester.pumpAndSettle();
      rich(tester).replaceText(0, 6, 'Changed');
      await tester.pumpAndSettle();
      expect(
        controller.text,
        contains('![Example image](<https://example.com/a.png> "Title")'),
      );
      await tester.tap(find.text('Preview'));
      await tester.pumpAndSettle();
      expect(find.text('Example image'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a caret inside an existing link edits and removes the whole link',
    (tester) async {
      final controller = TextEditingController(
        text: 'Open [the **docs**](https://example.com) now',
      );
      addTearDown(controller.dispose);
      await mount(tester, controller);
      await tester.pumpAndSettle();
      rich(tester).updateSelection(const TextSelection.collapsed(offset: 10));
      await tester.pump();
      await tester.tap(find.byTooltip('Insert link'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextFormField), 'https://example.org');
      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();
      expect(controller.text, 'Open [the **docs**](<https://example.org>) now');
      rich(tester).updateSelection(const TextSelection.collapsed(offset: 10));
      await tester.pump();
      await tester.tap(find.byTooltip('Insert link'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextFormField), '');
      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();
      expect(controller.text, 'Open the **docs** now');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'code dialog inserts and edits fenced code without parsing its contents',
    (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await mount(tester, controller);
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Insert block'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Code block'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.widgetWithText(TextField, 'dart, typescript, sql…'),
        'dart',
      );
      await tester.enterText(
        find.byKey(const Key('description-code')),
        'final text = "**literal**";',
      );
      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();
      expect(controller.text, '```dart\nfinal text = "**literal**";\n```');
      await tester.tap(find.text('Edit code'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('description-code')),
        'print("```");',
      );
      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();
      expect(controller.text, '````dart\nprint("```");\n````');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'opening, selection and mode changes preserve the original source exactly',
    (tester) async {
      const source = '## Heading\n\n* a\n* b\n\nA **bold** word.\n';
      final controller = TextEditingController(text: source);
      addTearDown(controller.dispose);
      await mount(tester, controller);
      await tester.pumpAndSettle();
      rich(tester).updateSelection(const TextSelection.collapsed(offset: 2));
      await tester.pump();
      await tester.tap(find.text('Preview'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Markdown'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Write'));
      await tester.pumpAndSettle();
      expect(controller.text, source);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('formatting and undo/redo synchronize Markdown immediately', (
    tester,
  ) async {
    final controller = TextEditingController(text: 'Acceptance criteria');
    addTearDown(controller.dispose);
    await mount(tester, controller);
    await tester.pumpAndSettle();
    rich(
      tester,
    ).updateSelection(const TextSelection(baseOffset: 0, extentOffset: 10));
    await tester.pump();
    await tester.tap(find.byTooltip('Bold'));
    expect(controller.text, '**Acceptance** criteria');
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<IconButton>(
            find.ancestor(
              of: find.byTooltip('Bold'),
              matching: find.byType(IconButton),
            ),
          )
          .isSelected,
      isTrue,
    );
    await tester.pump(const Duration(milliseconds: 600));
    await tester.tap(find.byTooltip('Undo'));
    await tester.pumpAndSettle();
    expect(controller.text, 'Acceptance criteria');
    await tester.tap(find.byTooltip('Redo'));
    await tester.pumpAndSettle();
    expect(controller.text, '**Acceptance** criteria');
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'source edits rebuild the visual document, including an empty description',
    (tester) async {
      final controller = TextEditingController(text: 'Old');
      addTearDown(controller.dispose);
      await mount(tester, controller);
      await tester.tap(find.text('Markdown'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('description-markdown-source')),
        '# New\n\n**Text**',
      );
      await tester.tap(find.text('Write'));
      await tester.pumpAndSettle();
      expect(rich(tester).document.toPlainText(), 'New\nText\n');
      await tester.tap(find.text('Markdown'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('description-markdown-source')),
        '',
      );
      await tester.tap(find.text('Write'));
      await tester.pumpAndSettle();
      expect(rich(tester).document.toPlainText(), '\n');
      expect(controller.text, '');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'advanced Markdown stays editable in source with a working preview',
    (tester) async {
      const source = '> - Nested list\n>   - Child\n';
      final controller = TextEditingController(text: source);
      addTearDown(controller.dispose);
      await mount(tester, controller);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('description-markdown-source')),
        findsOneWidget,
      );
      await tester.tap(find.text('Write'));
      await tester.pumpAndSettle();
      expect(controller.text, source);
      await tester.tap(find.text('Preview'));
      await tester.pumpAndSettle();
      expect(find.text('Nested list'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'phone toolbar scrolls and the editor survives an open keyboard',
    (tester) async {
      tester.view.physicalSize = const Size(360, 720);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await mount(tester, controller);
      await tester.pumpAndSettle();
      await tester.tap(find.byType(FleatherEditor));
      await tester.pump();
      final input = tester.state<RawEditorState>(find.byType(RawEditor));
      input.updateEditingValueWithDeltas([
        const TextEditingDeltaInsertion(
          oldText: '\n',
          textInserted: 'A task description',
          insertionOffset: 0,
          selection: TextSelection.collapsed(offset: 18),
          composing: TextRange.empty,
        ),
      ]);
      await tester.pumpAndSettle();
      expect(controller.text, 'A task description');
      await tester.drag(find.byTooltip('Bold'), const Offset(-500, 0));
      await tester.pumpAndSettle();
      expect(find.byTooltip('Insert block').hitTestable(), findsOneWidget);
      await tester.tap(find.byTooltip('Insert block'));
      await tester.pumpAndSettle();
      expect(find.text('Code block'), findsOneWidget);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('code and tables keep their source when surrounding text changes', (
    tester,
  ) async {
    final controller = TextEditingController(
      text:
          'Before\n\n```dart\nfinal x = 1;\n```\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nAfter',
    );
    addTearDown(controller.dispose);
    await mount(tester, controller);
    await tester.pumpAndSettle();
    rich(tester).replaceText(0, 6, 'Changed');
    await tester.pumpAndSettle();
    expect(controller.text, contains('```dart\nfinal x = 1;\n```'));
    expect(controller.text, contains('| A | B |'));
    expect(controller.text, startsWith('Changed'));
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'link dialog preserves selection, rejects unsafe URLs and applies the link',
    (tester) async {
      final controller = TextEditingController(text: 'Open docs');
      addTearDown(controller.dispose);
      await mount(tester, controller);
      await tester.pumpAndSettle();
      rich(
        tester,
      ).updateSelection(const TextSelection(baseOffset: 5, extentOffset: 9));
      await tester.pump();
      await tester.tap(find.byTooltip('Insert link'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byType(TextFormField), 'javascript:alert(1)');
      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();
      expect(find.text('Enter a valid link.'), findsOneWidget);
      await tester.enterText(find.byType(TextFormField), 'https://example.com');
      await tester.tap(find.text('Apply'));
      await tester.pumpAndSettle();
      expect(controller.text, 'Open [docs](<https://example.com>)');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'create and edit forms save Markdown and cancel leaves the task unchanged',
    (tester) async {
      tester.view.physicalSize = const Size(900, 1100);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final h = Harness();
      addTearDown(h.dispose);
      await h.login();
      await h.controller.selectProject(h.controller.projects.first);
      await tester.pumpWidget(TaskApp(controller: h.controller));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Create Task'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('new-task-title')),
        'Markdown task',
      );
      rich(tester).replaceText(0, 0, 'Criteria');
      rich(
        tester,
      ).updateSelection(const TextSelection(baseOffset: 0, extentOffset: 8));
      await tester.pump();
      await tester.tap(find.byTooltip('Bold'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Create Task').last);
      await tester.pumpAndSettle();
      expect(h.api.currentTask['description'], '**Criteria**');
      await h.controller.selectTask(h.controller.tasks.first);
      await tester.pumpAndSettle();
      final context = tester.element(find.byType(Scaffold).first);
      // The form uses the same production route as Task details → Edit.
      final editing = showEditTask(context, h.controller);
      await tester.pumpAndSettle();
      rich(tester).replaceText(0, 8, 'Updated');
      await tester.pumpAndSettle();
      await tester.tap(find.text('Save').last);
      await tester.pumpAndSettle();
      await editing;
      expect(h.api.currentTask['description'], contains('Updated'));
      final saved = h.api.currentTask['description'];
      final cancelling = showEditTask(context, h.controller);
      await tester.pumpAndSettle();
      rich(tester).replaceText(0, 0, 'Discard me');
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cancel').last);
      await tester.pumpAndSettle();
      await cancelling;
      expect(h.api.currentTask['description'], saved);
      expect(tester.takeException(), isNull);
    },
  );
}
