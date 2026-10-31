import 'dart:convert';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart' as legacy;
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;
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

/// Wraps a subtree that renders many [Md] widgets, so they can share one
/// compatibility theme instead of each translating the modern theme on every
/// build. A scrolling Timeline is the important case.
class MarkdownScope extends StatelessWidget {
  final Widget child;
  const MarkdownScope({super.key, required this.child});

  @override
  Widget build(BuildContext context) {
    // flutter_markdown_plus still uses the SDK's Material theme and
    // localizations.
    // ignore: deprecated_member_use
    return MaterialUiCompatibilityBridge(child: _MarkdownScope(child: child));
  }
}

class _MarkdownScope extends InheritedWidget {
  const _MarkdownScope({required super.child});

  @override
  bool updateShouldNotify(_MarkdownScope oldWidget) => false;
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

  @override
  Widget build(BuildContext context) {
    final content = _MdContent(
      data: data,
      selectable: selectable,
      size: size,
      onLink: onLink,
      onAttachment: onAttachment,
    );
    // A Timeline wraps all its Markdown in one [MarkdownScope]; standalone
    // Markdown brings its own compatibility theme.
    if (context.dependOnInheritedWidgetOfExactType<_MarkdownScope>() != null) {
      return content;
    }
    // ignore: deprecated_member_use
    return MaterialUiCompatibilityBridge(child: content);
  }
}

/// Lives below the compatibility theme, so its stylesheet carries the app's
/// fonts and colors. It parses each source once and keeps the built widget
/// tree while that source is unchanged: a Timeline rebuilds its visible
/// Comments on every notification, and re-parsing them made that expensive.
class _MdContent extends StatefulWidget {
  final String data;
  final bool selectable;
  final double size;
  final void Function(String? href)? onLink;
  final void Function(String href, String filename)? onAttachment;
  const _MdContent({
    required this.data,
    required this.selectable,
    required this.size,
    this.onLink,
    this.onAttachment,
  });

  @override
  State<_MdContent> createState() => _MdContentState();
}

class _MdContentState extends State<_MdContent> {
  MarkdownStyleSheet? _styleSheet;
  legacy.ThemeData? _theme;
  double? _size;

  /// Parsed Markdown, shared across every [Md] in the session. A Comment
  /// leaves the viewport when it scrolls away and is parsed again when it
  /// comes back; the AST makes that second visit cheap.
  static final Map<String, List<md.Node>> _ast = {};
  static int _astChars = 0;
  static const _astLimit = 96, _astCharLimit = 1 << 20;

  /// Gesture recognizers of the tree built last time.
  final List<GestureRecognizer> _recognizers = [];

  /// The widget tree of the last build, kept while its source is unchanged:
  /// a Timeline rebuilds its visible Comments for every notification.
  List<Widget>? _built;
  String? _builtData;
  MarkdownStyleSheet? _builtStyle;
  bool? _builtSelectable, _builtCanOpen;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _refreshStyle();
  }

  @override
  void didUpdateWidget(_MdContent oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.size != oldWidget.size) _refreshStyle();
    if (widget.data != oldWidget.data ||
        widget.selectable != oldWidget.selectable) {
      _invalidate();
    }
  }

  @override
  void dispose() {
    _disposeRecognizers();
    super.dispose();
  }

  void _refreshStyle() {
    final theme = legacy.Theme.of(context);
    if (_styleSheet != null && theme == _theme && widget.size == _size) return;
    _theme = theme;
    _size = widget.size;
    _styleSheet = markdownStyle(context, size: widget.size);
    _invalidate();
  }

  void _invalidate() {
    _disposeRecognizers();
    _built = null;
  }

  List<md.Node> _nodes(String data) {
    final hit = _ast.remove(data);
    if (hit != null) {
      _ast[data] = hit;
      return hit;
    }
    final nodes = md.Document(
      extensionSet: md.ExtensionSet.gitHubFlavored,
      encodeHtml: false,
    ).parseLines(const LineSplitter().convert(data));
    _ast[data] = nodes;
    _astChars += data.length;
    while (_ast.length > _astLimit || _astChars > _astCharLimit) {
      final oldest = _ast.keys.first;
      _ast.remove(oldest);
      _astChars -= oldest.length;
    }
    return nodes;
  }

  void _disposeRecognizers() {
    if (_recognizers.isEmpty) return;
    for (final recognizer in List.of(_recognizers)) {
      recognizer.dispose();
    }
    _recognizers.clear();
  }

  void _open(String? href, String label) {
    if (href != null && RegExp(r'^/users/[0-9a-fA-F-]{36}$').hasMatch(href)) {
      return;
    }
    if (href != null &&
        widget.onAttachment != null &&
        RegExp(r'^/api/v1/attachments/[^/?#]+$').hasMatch(href)) {
      widget.onAttachment!(href, label);
    } else {
      widget.onLink?.call(href);
    }
  }

  Widget _image(Uri uri, String? title, String? alt) => Semantics(
    link: true,
    child: InkWell(
      onTap: widget.onLink == null && widget.onAttachment == null
          ? null
          : () => _open(uri.toString(), alt ?? 'image'),
      borderRadius: BorderRadius.circular(Radii.sm),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
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
                style: const TextStyle(color: Palette.fgMuted, fontSize: 13),
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
  );

  @override
  Widget build(BuildContext context) {
    final canOpen = widget.onLink != null || widget.onAttachment != null;
    if (_built == null ||
        _builtData != widget.data ||
        !identical(_builtStyle, _styleSheet) ||
        _builtSelectable != widget.selectable ||
        _builtCanOpen != canOpen) {
      _disposeRecognizers();
      final builder = MarkdownBuilder(
        delegate: _Delegate(
          context,
          _recognizers,
          (text, href, _) => _open(href, text),
        ),
        selectable: widget.selectable,
        styleSheet: _styleSheet!,
        imageDirectory: null,
        imageBuilder: _image,
        checkboxBuilder: null,
        bulletBuilder: null,
        builders: const {},
        paddingBuilders: const {},
        fitContent: true,
        listItemCrossAxisAlignment: MarkdownListItemCrossAxisAlignment.baseline,
      );
      _built = builder.build(_nodes(widget.data));
      _builtData = widget.data;
      _builtStyle = _styleSheet;
      _builtSelectable = widget.selectable;
      _builtCanOpen = canOpen;
    }
    final children = _built!;
    return children.length == 1
        ? children.single
        : Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: children,
          );
  }
}

class _Delegate implements MarkdownBuilderDelegate {
  @override
  final BuildContext context;
  final List<GestureRecognizer> recognizers;
  final void Function(String text, String? href, String? title) onTap;

  _Delegate(this.context, this.recognizers, this.onTap);

  @override
  GestureRecognizer createLink(String text, String? href, String title) {
    final recognizer = TapGestureRecognizer()
      ..onTap = () => onTap(text, href, title);
    recognizers.add(recognizer);
    return recognizer;
  }

  @override
  TextSpan formatText(MarkdownStyleSheet styleSheet, String code) => TextSpan(
    style: styleSheet.code,
    text: code.replaceAll(RegExp(r'\n$'), ''),
  );
}
