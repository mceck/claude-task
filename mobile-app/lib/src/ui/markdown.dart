import 'package:flutter/material.dart' as legacy;
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:material_ui/material_ui.dart';

import 'theme.dart';

MarkdownStyleSheet markdownStyle(BuildContext context, {double size = 14.5}) {
  final base = TextStyle(fontSize: size, height: 1.55, color: Palette.fg);
  return MarkdownStyleSheet.fromTheme(legacy.Theme.of(context)).copyWith(
    p: base,
    listBullet: base,
    a: base.copyWith(
      color: Palette.primarySoft,
      decoration: TextDecoration.underline,
      decorationColor: Palette.primarySoft.withValues(alpha: .4),
    ),
    strong: const TextStyle(fontWeight: FontWeight.w600),
    h1: base.copyWith(fontSize: size + 6, fontWeight: FontWeight.w600),
    h2: base.copyWith(fontSize: size + 4, fontWeight: FontWeight.w600),
    h3: base.copyWith(fontSize: size + 2, fontWeight: FontWeight.w600),
    h4: base.copyWith(fontWeight: FontWeight.w600),
    code: TextStyle(
      fontFamily: mono,
      fontSize: size - 1.5,
      color: Palette.code,
      backgroundColor: Palette.muted,
    ),
    codeblockPadding: const EdgeInsets.all(14),
    codeblockDecoration: BoxDecoration(
      color: Palette.sidebar,
      borderRadius: BorderRadius.circular(Radii.md),
      border: Border.all(color: Palette.border),
    ),
    blockquote: base.copyWith(color: Palette.fgMuted),
    blockquotePadding: const EdgeInsets.fromLTRB(14, 4, 8, 4),
    blockquoteDecoration: const BoxDecoration(
      border: Border(left: BorderSide(color: Palette.borderStrong, width: 3)),
    ),
    horizontalRuleDecoration: const BoxDecoration(
      border: Border(top: BorderSide(color: Palette.border)),
    ),
    tableBorder: TableBorder.all(color: Palette.border),
    tableHead: base.copyWith(fontWeight: FontWeight.w600),
    tableBody: base,
    tableCellsPadding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
    blockSpacing: 10,
  );
}

class Md extends StatelessWidget {
  final String data;
  final bool selectable;
  final double size;
  final void Function(String? href)? onLink;
  final void Function(String href, String filename)? onAttachment;
  const Md(
    this.data, {
    super.key,
    this.selectable = true,
    this.size = 14.5,
    this.onLink,
    this.onAttachment,
  });

  void _open(String? href, String label) {
    if (href != null && RegExp(r'^/users/[0-9a-fA-F-]{36}$').hasMatch(href)) {
      return;
    }
    if (href != null &&
        onAttachment != null &&
        RegExp(r'^/api/v1/attachments/[^/?#]+$').hasMatch(href)) {
      onAttachment!(href, label);
    } else {
      onLink?.call(href);
    }
  }

  @override
  Widget build(BuildContext context) {
    // flutter_markdown_plus still uses the SDK's Material theme (for its
    // fallback styles and its code blocks' scrollbars; without selectable text
    // it needs no SDK localizations): give it the app's theme, mapped once, so
    // rebuilding a Comment never builds a theme or re-parses its Markdown.
    final body = legacy.Theme(
      data: _legacyTheme(context),
      child: Builder(
        builder: (context) => MarkdownBody(
          data: data,
          // One selection area for the whole text instead of a
          // SelectableText (an editable text field) per paragraph, which
          // made long Comments expensive to show while scrolling.
          selectable: false,
          styleSheet: _styleSheet(context, size),
          onTapLink: (text, href, _) => _open(href, text),
          imageBuilder: (uri, title, alt) => Semantics(
            link: true,
            child: InkWell(
              onTap: onLink == null && onAttachment == null
                  ? null
                  : () => _open(uri.toString(), alt ?? 'image'),
              borderRadius: BorderRadius.circular(Radii.sm),
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
                decoration: BoxDecoration(
                  color: Palette.sidebar,
                  borderRadius: BorderRadius.circular(Radii.sm),
                  border: Border.all(color: Palette.border),
                ),
                child: Row(
                  children: [
                    const Icon(
                      Icons.image_outlined,
                      size: 18,
                      color: Palette.primarySoft,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        alt == null || alt.isEmpty ? 'Linked image' : alt,
                        style: const TextStyle(
                          color: Palette.fgMuted,
                          fontSize: 13,
                        ),
                      ),
                    ),
                    const Icon(
                      Icons.open_in_new_rounded,
                      size: 14,
                      color: Palette.fgSubtle,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    return selectable ? SelectionArea(child: body) : body;
  }
}

/// The SDK Material theme mapped from each app theme, as
/// `MaterialUiCompatibilityBridge` maps it. The bridge builds a new one on
/// every build, so every rebuild of every Comment built a full theme and
/// style sheet and compared them field by field with the previous ones.
final _legacyThemes = Expando<legacy.ThemeData>();

legacy.ThemeData _legacyTheme(BuildContext context) =>
    _legacyThemes[Theme.of(context)] ??= _bridgedTheme(context);

legacy.ThemeData _bridgedTheme(BuildContext context) {
  // ignore: deprecated_member_use
  const bridge = MaterialUiCompatibilityBridge(child: SizedBox.shrink());
  final built = bridge.build(context);
  if (built is legacy.Theme) return built.data;
  throw StateError('MaterialUiCompatibilityBridge no longer builds a Theme');
}

/// One style sheet per theme and size: an identical style sheet is what lets
/// [MarkdownBody] keep its parsed tree across rebuilds.
final _styleSheets = Expando<Map<double, MarkdownStyleSheet>>();

MarkdownStyleSheet _styleSheet(BuildContext context, double size) =>
    (_styleSheets[legacy.Theme.of(context)] ??= {})[size] ??= markdownStyle(
      context,
      size: size,
    );
