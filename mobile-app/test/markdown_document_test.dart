import 'package:claude_task_mobile/src/ui/markdown_document.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:markdown/markdown.dart' as md;
import 'package:parchment/parchment.dart';

String html(String source) => md
    .markdownToHtml(source, extensionSet: md.ExtensionSet.gitHubFlavored)
    // Nested emphasis has the same meaning in either order.
    .replaceAll('<strong><em>', '<em><strong>')
    .replaceAll('</em></strong>', '</strong></em>');

void main() {
  final examples = <String, String>{
    'headings and paragraphs':
        '# Title\n\nA paragraph.\n\n## Details\n\nAnother paragraph.',
    'inline formatting':
        'A **bold** and _italic_ and ~~removed~~ word, `some_code`.',
    'nested emphasis': '**Bold and _italic_ and bold** then _italic_.',
    'changing emphasis':
        '_Italic **and bold** italic_ and **bold _italic_ bold**.',
    'links': '[Example **site**](https://example.com/a_(b)?x=1&y=2)',
    'escaped Markdown':
        r'Literal \*stars\* and \[brackets\] and \# heading and 1\. item.',
    'literal HTML': 'Use < and > and {braces}.',
    'lists': '- First\n- Second\n\n1. First\n2. Second',
    'nested lists':
        '- Parent\n    - Child\n        1. Number\n    - Other child\n- Second',
    'checklists': '- [ ] Pending\n- [x] Done',
    'quotes': '> A **quote** with [a link](https://example.com).',
    'fenced code':
        '```dart\n// **literal**\nfinal x = "```";\n\nprint(x);\n```',
    'tilde fences': '~~~js\nconst value = 42;\n~~~',
    'inline backticks': 'Use `` `code` `` and `**literal**`.',
    'intraword emphasis': 'foo*bar*baz and foo**bar**baz.',
    'combined emphasis':
        '***Both*** and **bold *nested*** and *italic **nested***.',
    'space in code': '`  padded  ` and `a  b` and ` `',
    'table pipes':
        r'| Pattern | Code |'
        '\n'
        r'| --- | --- |'
        '\n'
        r'| a\|b | `x\|y` |',
    'autolinks': '<https://example.com> and https://example.com/page.',
    'divider': 'Before\n\n---\n\nAfter',
    'images': '![Example image](https://example.com/image.png "Image title")',
    'tables':
        '| Name | Status |\n| :--- | ---: |\n| **A** | `ready` |\n| B | [Link](https://example.com) |',
  };
  for (final entry in examples.entries) {
    test('preserves Markdown semantics: ${entry.key}', () {
      final document = MarkdownDocument.decode(entry.value);
      final encoded = MarkdownDocument.encode(document);
      expect(html(encoded), html(entry.value), reason: encoded);
      expect(
        html(MarkdownDocument.encode(MarkdownDocument.decode(encoded))),
        html(encoded),
      );
    });
  }

  test(
    'empty documents and a cleared description serialize as empty strings',
    () {
      expect(MarkdownDocument.encode(MarkdownDocument.decode('')), '');
      expect(MarkdownDocument.encode(ParchmentDocument()), '');
    },
  );

  test(
    'source-only structures are rejected before editing can flatten them',
    () {
      for (final source in [
        '> - Nested list in quote',
        '3. Starts at three',
        '- First paragraph\n\n  Another paragraph',
        'Text ![inline image](https://example.com/image.png) after',
        '[Titled link](https://example.com "Title")',
        'Hard break  \nnext line',
        '> First paragraph\n>\n> Second paragraph',
      ]) {
        expect(
          () => MarkdownDocument.decode(source),
          throwsFormatException,
          reason: source,
        );
      }
    },
  );

  test('new inline code with literal backticks uses a safe delimiter', () {
    final document = ParchmentDocument();
    document.insert(0, 'a `literal` token');
    document.format(0, 17, ParchmentAttribute.inlineCode);
    expect(
      html(MarkdownDocument.encode(document)),
      '<p><code>a `literal` token</code></p>\n',
    );
  });
}
