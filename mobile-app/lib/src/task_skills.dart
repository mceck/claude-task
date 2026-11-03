import 'package:material_ui/material_ui.dart';

import 'api.dart';
import 'models.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';

/// The Skills sheet of a Task: every Skill of its Session and who activated it
/// (docs/specs/agents.md).
Future<void> showTaskSkills(BuildContext context, TaskApi api, String taskId) =>
    showAppSheet<void>(
      context,
      maxWidth: 640,
      builder: (_) => _TaskSkills(api: api, taskId: taskId),
    );

class _TaskSkills extends StatefulWidget {
  final TaskApi api;
  final String taskId;
  const _TaskSkills({required this.api, required this.taskId});

  @override
  State<_TaskSkills> createState() => _TaskSkillsState();
}

class _TaskSkillsState extends State<_TaskSkills> {
  List<Json> _skills = const [];
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    try {
      final body = await widget.api.request(
        'GET',
        '/tasks/${widget.taskId}/skills',
      );
      if (!mounted) return;
      setState(() {
        _skills = [
          for (final s in (body['skills'] as List?) ?? const [])
            (s as Map).cast<String, dynamic>(),
        ];
        _loading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _error = err is ApiException ? err.message : '$err';
        _loading = false;
      });
    }
  }

  static bool _used(Json skill) =>
      (skill['usedBy'] as List?)?.isNotEmpty == true;

  @override
  Widget build(BuildContext context) {
    final used = _skills.where(_used).length;
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Text(
            'Skills',
            style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 4),
          const Text(
            'Every skill available in this session. A filled dot marks the ones that were used.',
            style: TextStyle(fontSize: 12, color: Palette.fgSubtle),
          ),
          const SizedBox(height: 14),
          if (_loading)
            const Padding(
              padding: EdgeInsets.all(24),
              child: Center(child: Spinner()),
            )
          else if (_error != null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text(
                _error!,
                style: const TextStyle(fontSize: 13, color: Palette.fgMuted),
              ),
            )
          else if (_skills.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 12),
              child: Text(
                'No skills are available in this session.',
                style: TextStyle(fontSize: 13, color: Palette.fgMuted),
              ),
            )
          else ...[
            Flexible(
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.sizeOf(context).height * .55,
                ),
                child: SingleChildScrollView(
                  child: LayoutBuilder(
                    builder: (context, constraints) {
                      final width = (constraints.maxWidth - 8) / 2;
                      return Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          for (final skill in _skills)
                            _SkillCard(skill: skill, width: width),
                        ],
                      );
                    },
                  ),
                ),
              ),
            ),
            const SizedBox(height: 10),
            Text(
              '$used of ${_skills.length} used',
              style: const TextStyle(fontSize: 11, color: Palette.fgSubtle),
            ),
          ],
        ],
      ),
    );
  }
}

class _SkillCard extends StatelessWidget {
  final Json skill;
  final double width;
  const _SkillCard({required this.skill, required this.width});

  @override
  Widget build(BuildContext context) {
    final used = (skill['usedBy'] as List?)?.isNotEmpty == true;
    final usedBy = (skill['usedBy'] as List?) ?? const [];
    final who = usedBy.length == 2
        ? 'Used by you and the agent'
        : usedBy.contains('agent')
        ? 'Used by the agent'
        : usedBy.contains('user')
        ? 'Used by you'
        : 'Not used yet';
    final description = skill['description'] as String? ?? '';
    return Container(
      width: width,
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: used ? Palette.primary.withValues(alpha: .05) : null,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(
          color: used ? Palette.primary.withValues(alpha: .4) : Palette.border,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Tooltip(
                message: who,
                child: Container(
                  key: ValueKey('skill-dot:${skill['name']}'),
                  width: 8,
                  height: 8,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: used ? Palette.primary : null,
                    border: used
                        ? null
                        : Border.all(color: Palette.fgSubtle, width: 1),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  skill['name'] as String? ?? '',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
            ],
          ),
          if (description.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(left: 16, top: 4),
              child: Text(
                description,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 11, color: Palette.fgSubtle),
              ),
            ),
        ],
      ),
    );
  }
}
