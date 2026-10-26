import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'theme.dart';

MarkdownStyleSheet markdownStyle(BuildContext context, {double size = 14.5}) {
  final base = TextStyle(fontSize: size, height: 1.55, color: Palette.fg);
  return MarkdownStyleSheet.fromTheme(Theme.of(context)).copyWith(
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
      color: const Color(0xffe3c7ff),
      backgroundColor: Colors.white.withValues(alpha: .06),
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
  const Md(
    this.data, {
    super.key,
    this.selectable = true,
    this.size = 14.5,
    this.onLink,
  });
  @override
  Widget build(BuildContext context) => MarkdownBody(
    data: data,
    selectable: selectable,
    styleSheet: markdownStyle(context, size: size),
    onTapLink: (_, href, _) => onLink?.call(href),
    imageBuilder: (uri, title, alt) => Text(
      alt ?? 'External image · open the link to view',
      style: const TextStyle(color: Palette.fgMuted, fontSize: 13),
    ),
  );
}
