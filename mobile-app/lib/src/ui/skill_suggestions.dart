import 'package:flutter/material.dart';
import '../models.dart';

/// Completes the slash token at the caret without replacing the rest of the draft.
class SkillSuggestions extends StatelessWidget {
  final TextEditingController text;
  final List<SkillCommand> skills;
  final ValueChanged<String> onSelected;
  const SkillSuggestions({
    super.key,
    required this.text,
    required this.skills,
    required this.onSelected,
  });

  @override
  Widget build(
    BuildContext context,
  ) => ValueListenableBuilder<TextEditingValue>(
    valueListenable: text,
    builder: (context, value, _) {
      final caret = value.selection.baseOffset;
      if (caret < 0 ||
          caret > value.text.length ||
          !value.selection.isCollapsed) {
        return const SizedBox.shrink();
      }
      final match = RegExp(
        r'(?:^|\s)/([a-zA-Z0-9_:-]*)$',
      ).firstMatch(value.text.substring(0, caret));
      if (match == null) return const SizedBox.shrink();
      final query = match.group(1)!.toLowerCase();
      final tokenStart = caret - query.length - 1;
      final suggestions = skills
          .where(
            (s) =>
                s.name.toLowerCase().startsWith(query) &&
                (tokenStart == 0 || s.kind == 'skill'),
          )
          .toList();
      if (suggestions.isEmpty) return const SizedBox.shrink();
      return ConstrainedBox(
        constraints: const BoxConstraints(maxHeight: 200),
        child: Material(
          borderRadius: BorderRadius.circular(8),
          color: Theme.of(context).colorScheme.surfaceContainerHigh,
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.symmetric(vertical: 4),
            children: [
              for (final skill in suggestions)
                ListTile(
                  key: ValueKey('skill-command:${skill.name}'),
                  dense: true,
                  title: Text('/${skill.name}'),
                  subtitle: Text(
                    '${skill.kind == 'skill'
                        ? 'Skill'
                        : skill.kind == 'mcp'
                        ? 'MCP'
                        : 'Claude'} · ${skill.description}',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                  onTap: () {
                    final start = caret - query.length - 1;
                    final suffix = RegExp(
                      r'^[a-zA-Z0-9_:-]*',
                    ).firstMatch(value.text.substring(caret))!.end;
                    final next =
                        '${value.text.substring(0, start)}/${skill.name} ${value.text.substring(caret + suffix)}';
                    text.value = TextEditingValue(
                      text: next,
                      selection: TextSelection.collapsed(
                        offset: start + skill.name.length + 2,
                      ),
                    );
                    onSelected(next);
                  },
                ),
            ],
          ),
        ),
      );
    },
  );
}
