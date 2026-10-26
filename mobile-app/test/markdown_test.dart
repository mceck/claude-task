import 'package:claude_task_mobile/src/ui/markdown.dart';
import 'package:claude_task_mobile/src/ui/theme.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:material_ui/material_ui.dart';

void main() {
  testWidgets(
    'Markdown inherits the migrated theme and keeps links interactive',
    (tester) async {
      String? opened;
      Future<void> mount(Color color) => tester.pumpWidget(
        MaterialApp(
          theme: buildTheme().copyWith(
            textTheme: buildTheme().textTheme.copyWith(
              bodyLarge: TextStyle(fontFamily: 'Geist', color: color),
            ),
          ),
          home: Scaffold(
            body: Md(
              '###### Small heading\n\n[Reference](https://example.com)',
              selectable: false,
              onLink: (href) => opened = href,
            ),
          ),
        ),
      );

      TextStyle? headingStyle() {
        final heading = tester.widget<RichText>(
          find.byWidgetPredicate(
            (widget) =>
                widget is RichText &&
                widget.text.toPlainText() == 'Small heading',
          ),
        );
        TextStyle? style;
        heading.text.visitChildren((span) {
          if (span is TextSpan && span.text == 'Small heading') {
            style = span.style;
          }
          return true;
        });
        return style;
      }

      await mount(Palette.primarySoft);
      await tester.pumpAndSettle();
      expect(headingStyle()?.fontFamily, 'Geist');
      expect(headingStyle()?.color, Palette.primarySoft);
      await tester.tap(find.text('Reference', findRichText: true));
      expect(opened, 'https://example.com');

      await mount(Palette.violet);
      await tester.pumpAndSettle();
      expect(headingStyle()?.color, Palette.violet);
      expect(tester.takeException(), isNull);
    },
  );
}
