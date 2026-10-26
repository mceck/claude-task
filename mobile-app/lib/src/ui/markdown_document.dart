import 'package:markdown/markdown.dart' as md;
import 'package:parchment/parchment.dart';

/// The editable subset of Markdown. Unsupported structures open in source mode
/// instead of being flattened on the next edit. The API always receives Markdown.
abstract final class MarkdownDocument {
  static const blockType = 'task-markdown';

  static ParchmentDocument decode(String source) {
    final nodes = md.Document(
      extensionSet: md.ExtensionSet.gitHubFlavored,
      encodeHtml: false,
    ).parse(source);
    final delta = Delta();
    for (final node in nodes) {
      _block(node, delta);
    }
    final operations = delta.toList();
    if (operations.length > 1 &&
        operations[operations.length - 2].data is Map) {
      delta.insert('\n');
    }
    if (delta.isEmpty) delta.insert('\n');
    return ParchmentDocument.fromDelta(delta);
  }

  static Never _unsupported() =>
      throw const FormatException('Use Markdown mode for this formatting.');

  static void _line(Delta delta, Map<String, dynamic> style) =>
      delta.insert('\n', style.isEmpty ? null : style);

  static void _block(md.Node node, Delta delta) {
    if (node is! md.Element) _unsupported();
    final children = node.children ?? [];
    switch (node.tag) {
      case 'p':
        if (children.length == 1 &&
            children.single is md.Element &&
            (children.single as md.Element).tag == 'img') {
          final image = children.single as md.Element;
          delta.insert(
            BlockEmbed.image(
              image.attributes['src'] ?? '',
              data: {
                'alt': image.attributes['alt'] ?? '',
                'title': image.attributes['title'] ?? '',
              },
            ).toJson(),
          );
        } else {
          _inline(children, delta);
        }
        _line(delta, {});
      case 'h1' || 'h2' || 'h3' || 'h4' || 'h5' || 'h6':
        _inline(children, delta);
        _line(
          delta,
          ParchmentAttribute.heading
              .withValue(int.parse(node.tag.substring(1)))
              .toJson(),
        );
      case 'ul' || 'ol':
        _list(node, delta, 0);
      case 'blockquote':
        if (children.length != 1) _unsupported();
        for (final child in children) {
          if (child is! md.Element || child.tag != 'p') _unsupported();
          _inline(child.children ?? [], delta);
          _line(delta, ParchmentAttribute.bq.toJson());
        }
      case 'pre':
        if (children.length != 1 || children.single is! md.Element) {
          _unsupported();
        }
        final code = children.single as md.Element;
        final language = (code.attributes['class'] ?? '').replaceFirst(
          'language-',
          '',
        );
        delta.insert(codeBlock(code.textContent, language).toJson());
        _line(delta, {});
      case 'table':
        delta.insert(markdownBlock(_table(node), 'table').toJson());
        _line(delta, {});
      case 'hr':
        delta.insert(BlockEmbed.horizontalRule.toJson());
        _line(delta, {});
      default:
        _unsupported();
    }
  }

  static void _list(md.Element list, Delta delta, int depth) {
    // Parchment numbers lists from one. Keep other starts in source mode.
    if (list.attributes['start'] != null && list.attributes['start'] != '1') {
      _unsupported();
    }
    if (depth > 5) _unsupported();
    for (final item in list.children ?? <md.Node>[]) {
      if (item is! md.Element || item.tag != 'li') _unsupported();
      final content = <md.Node>[];
      final nested = <md.Element>[];
      bool? checked;
      for (final child in item.children ?? <md.Node>[]) {
        if (child is md.Element && (child.tag == 'ul' || child.tag == 'ol')) {
          nested.add(child);
        } else if (child is md.Element && child.tag == 'input') {
          checked = child.attributes.containsKey('checked');
        } else if (child is md.Element && child.tag == 'p') {
          // Loose/multi-paragraph items need more structure than a rich line.
          _unsupported();
        } else {
          if (nested.isNotEmpty) _unsupported();
          content.add(child);
        }
      }
      _inline(content, delta, trimCheckboxSpace: checked != null);
      _line(delta, {
        ...switch (checked) {
          null =>
            list.tag == 'ol'
                ? ParchmentAttribute.ol.toJson()
                : ParchmentAttribute.ul.toJson(),
          _ => ParchmentAttribute.cl.toJson(),
        },
        if (checked == true) ...ParchmentAttribute.checked.toJson(),
        if (depth > 0) ...ParchmentAttribute.indent.withLevel(depth).toJson(),
      });
      for (final sublist in nested) {
        _list(sublist, delta, depth + 1);
      }
    }
  }

  static void _inline(
    List<md.Node> nodes,
    Delta delta, {
    Map<String, dynamic> style = const {},
    bool trimCheckboxSpace = false,
  }) {
    for (final node in nodes) {
      if (node is md.Text) {
        var text = node.text.replaceAll('\n', ' ');
        if (trimCheckboxSpace) text = text.replaceFirst(RegExp(r'^ '), '');
        trimCheckboxSpace = false;
        if (text.isNotEmpty) delta.insert(text, style.isEmpty ? null : style);
        continue;
      }
      if (node is! md.Element) _unsupported();
      final attribute = switch (node.tag) {
        'strong' => ParchmentAttribute.bold.toJson(),
        'em' => ParchmentAttribute.italic.toJson(),
        'del' => ParchmentAttribute.strikethrough.toJson(),
        'code' => ParchmentAttribute.inlineCode.toJson(),
        'a' =>
          ParchmentAttribute.link
              .fromString(node.attributes['href'] ?? '')
              .toJson(),
        _ => _unsupported(),
      };
      // Link titles have no equivalent in a rich text link.
      if (node.attributes.containsKey('title')) _unsupported();
      if (node.tag == 'code') {
        delta.insert(node.textContent, {...style, ...attribute});
      } else {
        _inline(node.children ?? [], delta, style: {...style, ...attribute});
      }
    }
  }

  static BlockEmbed markdownBlock(String source, String kind) =>
      BlockEmbed(blockType, data: {'markdown': source, 'kind': kind});

  static BlockEmbed codeBlock(String code, String language) => BlockEmbed(
    blockType,
    data: {
      'markdown': fencedCode(code, language),
      'kind': 'code',
      'code': code,
      'language': language,
    },
  );

  static String fencedCode(String text, [String language = '']) {
    final longest = RegExp(r'`+')
        .allMatches(text)
        .fold<int>(
          2,
          (length, match) =>
              match[0]!.length > length ? match[0]!.length : length,
        );
    final fence = '`' * (longest + 1);
    return '$fence${language.replaceAll(RegExp(r'[\r\n`]'), '')}\n'
        '$text${text.endsWith('\n') || text.isEmpty ? '' : '\n'}$fence';
  }

  static String _table(md.Element table) {
    final rows = <md.Element>[];
    void collect(md.Element element) {
      if (element.tag == 'tr') {
        rows.add(element);
      } else {
        for (final child in element.children ?? <md.Node>[]) {
          if (child is md.Element) collect(child);
        }
      }
    }

    collect(table);
    final lines = <String>[];
    for (final row in rows) {
      final cells = row.children!.cast<md.Element>();
      lines.add(
        '| ${cells.map((cell) {
          final delta = Delta();
          _inline(cell.children ?? [], delta);
          return _spans(delta.toList()).replaceAll('|', r'\|');
        }).join(' | ')} |',
      );
      if (lines.length == 1) {
        lines.add(
          '| ${cells.map((cell) => switch (cell.attributes['align']) {
            'left' => ':---',
            'right' => '---:',
            'center' => ':---:',
            _ => '---',
          }).join(' | ')} |',
        );
      }
    }
    return lines.join('\n');
  }

  static String encode(ParchmentDocument document) {
    final lines = <LineNode>[];
    for (final node in document.root.children) {
      if (node is LineNode) lines.add(node);
      if (node is BlockNode) lines.addAll(node.children.cast<LineNode>());
    }
    final result = StringBuffer();
    String? previousBlock;
    var previousDepth = 0;
    var code = <String>[];
    void flushCode() {
      if (code.isNotEmpty) {
        result.write('${fencedCode(code.join('\n'))}\n\n');
        code = [];
      }
    }

    for (var index = 0; index < lines.length; index++) {
      final line = lines[index];
      final block = line.style.value(ParchmentAttribute.block);
      if (block == ParchmentAttribute.code.value) {
        code.add(line.toPlainText().replaceFirst(RegExp(r'\n$'), ''));
        previousBlock = block;
        continue;
      }
      flushCode();
      if (line.hasBlockEmbed) {
        final embed = (line.children.single as EmbedNode).value;
        final content = switch (embed.type) {
          'hr' => '---',
          'image' =>
            '![${_escape(embed.data['alt'] as String? ?? '')}]'
                '(${_destination(embed.data['source'] as String? ?? '')}'
                '${(embed.data['title'] as String? ?? '').isEmpty ? '' : ' "${(embed.data['title'] as String).replaceAll('"', r'\"')}"'})',
          blockType => embed.data['markdown'] as String,
          _ => throw StateError('Unknown Markdown embed: ${embed.type}'),
        };
        result.write('$content\n\n');
        previousBlock = null;
        continue;
      }
      final text = _spans(line.toDelta().toList());
      // A final empty paragraph lets users type after a block embed.
      if (index == lines.length - 1 && text.isEmpty && block == null) continue;
      final depth = line.style.value(ParchmentAttribute.indent) ?? 0;
      final heading = line.style.value(ParchmentAttribute.heading);
      final prefix = switch (block) {
        'ul' => '${'    ' * depth}- ',
        'ol' => '${'    ' * depth}1. ',
        'cl' =>
          '${'    ' * depth}- [${line.style.containsSame(ParchmentAttribute.checked) ? 'x' : ' '}] ',
        'quote' => '> ',
        _ => heading == null ? '' : '${'#' * heading} ',
      };
      if (previousBlock != null &&
          previousBlock != block &&
          previousDepth == depth &&
          !result.toString().endsWith('\n\n')) {
        result.write('\n');
      }
      result.write('$prefix$text\n');
      final nextBlock = index + 1 < lines.length
          ? lines[index + 1].style.value(ParchmentAttribute.block)
          : null;
      if (block == null || nextBlock == null) result.write('\n');
      previousBlock = block;
      previousDepth = depth;
    }
    flushCode();
    return result.toString().trimRight();
  }

  static String _spans(List<Operation> operations) {
    final runs = <(String, Map<String, dynamic>)>[];
    for (final operation in operations) {
      if (operation.data is! String) continue;
      final text = (operation.data as String).replaceFirst(RegExp(r'\n$'), '');
      if (text.isNotEmpty) runs.add((text, operation.attributes ?? {}));
    }
    final keys = [
      ParchmentAttribute.link.key,
      ParchmentAttribute.bold.key,
      ParchmentAttribute.italic.key,
      ParchmentAttribute.strikethrough.key,
      ParchmentAttribute.inlineCode.key,
    ];
    String render(int start, int end, Set<String> excluded) {
      final output = StringBuffer();
      for (var i = start; i < end;) {
        String? chosen;
        var until = i;
        for (final key in keys) {
          if (excluded.contains(key) || runs[i].$2[key] == null) continue;
          // Code cannot contain emphasis; render emphasis around code instead.
          if (key == ParchmentAttribute.inlineCode.key && chosen != null) {
            continue;
          }
          var next = i + 1;
          while (next < end && runs[next].$2[key] == runs[i].$2[key]) {
            next++;
          }
          if (next > until) {
            chosen = key;
            until = next;
          }
        }
        if (chosen == null) {
          output.write(_escape(runs[i].$1));
          i++;
          continue;
        }
        if (chosen == ParchmentAttribute.inlineCode.key) {
          final text = runs.sublist(i, until).map((run) => run.$1).join();
          final longest = RegExp(r'`+')
              .allMatches(text)
              .fold<int>(
                0,
                (length, match) =>
                    match[0]!.length > length ? match[0]!.length : length,
              );
          final fence = '`' * (longest + 1);
          final pad =
              text.startsWith('`') ||
                  text.endsWith('`') ||
                  (text.startsWith(' ') &&
                      text.endsWith(' ') &&
                      text.trim().isNotEmpty)
              ? ' '
              : '';
          output.write('$fence$pad$text$pad$fence');
        } else {
          final content = render(i, until, {...excluded, chosen});
          if (chosen == ParchmentAttribute.link.key) {
            output.write(
              '[$content](${_destination(runs[i].$2[chosen] as String)})',
            );
          } else {
            final marker = chosen == ParchmentAttribute.bold.key
                ? '**'
                : chosen == ParchmentAttribute.italic.key
                ? '*'
                : '~~';
            final match = RegExp(
              r'^(\s*)([\s\S]*?)(\s*)$',
            ).firstMatch(content)!;
            output.write(
              match[2]!.isEmpty
                  ? content
                  : '${match[1]}$marker${match[2]}$marker${match[3]}',
            );
          }
        }
        i = until;
      }
      return output.toString();
    }

    return render(0, runs.length, {});
  }

  static String _escape(String text) {
    final escaped = text.replaceAllMapped(
      RegExp(r'[\\`*_{}\[\]<>~]'),
      (match) => '\\${match[0]}',
    );
    // Protect block markers while leaving punctuation in prose readable.
    return escaped.replaceAllMapped(
      RegExp(
        r'(^|\n)([ \t]*)(#{1,6}(?=\s|$)|[-+](?=\s|$)|-{3,}(?=$)|\d+[.)](?=\s))',
      ),
      (match) {
        final marker = match[3]!;
        return '${match[1]}${match[2]}${marker.substring(0, marker.length - 1)}\\${marker[marker.length - 1]}';
      },
    );
  }

  static String _destination(String url) =>
      '<${url.replaceAll('<', '%3C').replaceAll('>', '%3E').replaceAll('\n', '%0A')}>';
}
