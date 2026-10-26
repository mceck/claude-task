import 'package:flutter/material.dart';
import '../models.dart';
import 'theme.dart';
import 'widgets.dart';

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
      // Above the composer, like the web's command popover.
      return FadeSlideIn(
        offset: const Offset(0, .06),
        duration: Motion.fast,
        child: Container(
          margin: const EdgeInsets.only(bottom: 8),
          constraints: const BoxConstraints(maxHeight: 220),
          decoration: BoxDecoration(
            color: Palette.raised,
            borderRadius: BorderRadius.circular(Radii.md),
            border: Border.all(color: Palette.borderStrong),
            boxShadow: const [
              BoxShadow(
                color: Color(0x66000000),
                blurRadius: 24,
                offset: Offset(0, 8),
              ),
            ],
          ),
          child: ListView(
            shrinkWrap: true,
            padding: const EdgeInsets.all(4),
            children: [
              for (final skill in suggestions)
                Pressable(
                  key: ValueKey('skill-command:${skill.name}'),
                  pressedScale: .99,
                  borderRadius: BorderRadius.circular(Radii.sm),
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 8,
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Text(
                            '/${skill.name}',
                            style: const TextStyle(
                              fontSize: 14,
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          const SizedBox(width: 8),
                          Pill(
                            label: skill.kind == 'skill'
                                ? 'Skill'
                                : skill.kind == 'mcp'
                                ? 'MCP'
                                : 'Claude',
                            color: skill.kind == 'skill'
                                ? Palette.primary
                                : skill.kind == 'mcp'
                                ? Palette.info
                                : Palette.violet,
                          ),
                        ],
                      ),
                      if (skill.description.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            skill.description,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 12,
                              color: Palette.fgMuted,
                            ),
                          ),
                        ),
                    ],
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
