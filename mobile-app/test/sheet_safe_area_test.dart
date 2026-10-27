import 'package:claude_task_mobile/src/ui/theme.dart';
import 'package:claude_task_mobile/src/ui/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

const _screenSize = Size(390, 844);

void _setInsets(
  WidgetTester tester, {
  double bottom = 48,
  double keyboard = 0,
}) {
  tester.view.viewPadding = FakeViewPadding(top: 24, bottom: bottom);
  tester.view.padding = FakeViewPadding(
    top: 24,
    bottom: keyboard > bottom ? 0 : bottom,
  );
  tester.view.viewInsets = FakeViewPadding(bottom: keyboard);
}

Future<void> _pumpHost(WidgetTester tester, WidgetBuilder builder) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: buildTheme(),
      home: Scaffold(
        // Real callers have already consumed the page's safe area. Modal
        // routes still need to apply the device insets to their own content.
        body: SafeArea(
          child: Builder(
            builder: (context) => TextButton(
              onPressed: () => showAppSheet<void>(context, builder: builder),
              child: const Text('Open sheet'),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Open sheet'));
  await tester.pumpAndSettle();
}

void main() {
  for (final bottom in [0.0, 24.0, 48.0]) {
    testWidgets('modal footer clears a $bottom px system navigation area', (
      tester,
    ) async {
      tester.view.physicalSize = _screenSize;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      _setInsets(tester, bottom: bottom);
      var saved = false;

      await _pumpHost(
        tester,
        (context) => SheetScaffold(
          title: 'Edit Task',
          body: const Text('Task fields'),
          actions: [
            AppButton(
              label: 'Save',
              onPressed: () {
                saved = true;
                Navigator.pop(context);
              },
            ),
          ],
        ),
      );

      expect(
        tester.getBottomRight(find.byType(SheetScaffold)).dy,
        _screenSize.height - bottom,
      );
      expect(
        tester.getBottomRight(find.widgetWithText(AppButton, 'Save')).dy,
        lessThanOrEqualTo(_screenSize.height - bottom - 22),
      );
      expect(
        tester.getBottomRight(find.byType(BottomSheet)).dy,
        _screenSize.height,
      );
      await tester.tap(find.text('Save'));
      await tester.pumpAndSettle();
      expect(saved, isTrue);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'long modal keeps actions above keyboard and restores safe area',
    (tester) async {
      tester.view.physicalSize = _screenSize;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      _setInsets(tester);
      var saved = false;

      await _pumpHost(
        tester,
        (context) => SheetScaffold(
          title: 'Edit Task',
          body: Column(
            children: [
              const TextField(),
              for (var i = 0; i < 30; i++)
                SizedBox(height: 48, child: Text('Field $i')),
            ],
          ),
          actions: [AppButton(label: 'Save', onPressed: () => saved = true)],
        ),
      );

      expect(
        tester.getTopLeft(find.byType(SheetScaffold)).dy,
        greaterThanOrEqualTo(24),
      );
      await tester.tap(find.byType(TextField));
      _setInsets(tester, keyboard: 280);
      await tester.pumpAndSettle();
      expect(
        tester.getBottomRight(find.byType(SheetScaffold)).dy,
        _screenSize.height - 280,
      );
      expect(
        tester.getBottomRight(find.widgetWithText(AppButton, 'Save')).dy,
        lessThanOrEqualTo(_screenSize.height - 280 - 22),
      );
      await tester.drag(
        find.byType(SingleChildScrollView),
        const Offset(0, -1600),
      );
      await tester.pumpAndSettle();
      expect(find.text('Field 29').hitTestable(), findsOneWidget);
      await tester.tap(find.text('Save'));
      expect(saved, isTrue);

      _setInsets(tester);
      await tester.pumpAndSettle();
      expect(
        tester.getBottomRight(find.byType(SheetScaffold)).dy,
        _screenSize.height - 48,
      );
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets('content SafeArea consumes the bottom inset only once', (
    tester,
  ) async {
    tester.view.physicalSize = _screenSize;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    _setInsets(tester);

    await _pumpHost(tester, (context) {
      expect(MediaQuery.paddingOf(context).bottom, 0);
      return const SafeArea(
        child: SheetScaffold(title: 'Details', body: Text('Task details')),
      );
    });

    expect(
      tester.getBottomRight(find.byType(SheetScaffold)).dy,
      _screenSize.height - 48,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('last picker option stays above system navigation and selects', (
    tester,
  ) async {
    tester.view.physicalSize = _screenSize;
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    _setInsets(tester);
    String? selected;

    await _pumpHost(
      tester,
      (context) => SheetScaffold(
        title: 'Edit Task',
        body: TextButton(
          onPressed: () async {
            selected = await showPicker<String>(
              context,
              title: 'Priority',
              selected: 'high',
              options: const [
                PickerOption('high', 'High'),
                PickerOption('low', 'Low'),
              ],
            );
          },
          child: const Text('Choose priority'),
        ),
      ),
    );
    await tester.tap(find.text('Choose priority'));
    await tester.pumpAndSettle();
    expect(
      tester.getBottomRight(find.byType(SheetScaffold).last).dy,
      _screenSize.height - 48,
    );
    await tester.tap(find.text('Low'));
    await tester.pumpAndSettle();
    expect(selected, 'low');
    expect(tester.takeException(), isNull);
  });
}
