import 'package:material_ui/material_ui.dart';

import 'api.dart';
import 'models.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';

/// How one uncommitted file changed: the letter and colour the web app uses.
const _statusStyles = <String, (String, Color, String)>{
  'modified': ('M', Palette.orange, 'Modified'),
  'added': ('A', Palette.success, 'Added'),
  'deleted': ('D', Palette.danger, 'Deleted'),
  'renamed': ('R', Palette.info, 'Renamed'),
  'copied': ('C', Palette.info, 'Copied'),
  'type-changed': ('T', Palette.orange, 'Type changed'),
  'untracked': ('U', Palette.success, 'Untracked'),
  'conflicted': ('C', Palette.danger, 'Conflict'),
};

const _extensionColours = <String, Color>{
  'TS': Palette.info,
  'TSX': Palette.info,
  'JS': Palette.warning,
  'JSX': Palette.warning,
  'JSON': Palette.warning,
  'MD': Palette.slate,
  'CSS': Palette.violet,
  'GO': Palette.primary,
  'PY': Palette.success,
  'RS': Palette.orange,
  'YML': Palette.violet,
  'YAML': Palette.violet,
  'SH': Palette.success,
};

const _emptyStates = <String, String>{
  'no-session': 'This task has no agent session yet.',
  'no-repository':
      'This project has no repository, so its worktree has no git changes.',
  'no-worktree': 'The task has no worktree yet.',
  'no-runner': 'The task’s worker isn’t running, so the changes can’t be read right now.',
  'error': 'The changes couldn’t be read.',
};

/// The Changes sheet of a Task: the uncommitted files of its Worktree, read when it opens
/// (docs/specs/git-integration.md).
Future<void> showTaskChanges(
  BuildContext context,
  TaskApi api,
  String taskId,
) => showAppSheet<void>(
  context,
  builder: (_) => _TaskChanges(api: api, taskId: taskId),
);

class _TaskChanges extends StatefulWidget {
  final TaskApi api;
  final String taskId;
  const _TaskChanges({required this.api, required this.taskId});

  @override
  State<_TaskChanges> createState() => _TaskChangesState();
}

class _TaskChangesState extends State<_TaskChanges> {
  Json? _answer;
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
        '/tasks/${widget.taskId}/worktree-status',
      );
      if (!mounted) return;
      setState(() {
        _answer = (body['status'] as Map?)?.cast<String, dynamic>();
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

  @override
  Widget build(BuildContext context) {
    final status = (_answer?['status'] as Map?)?.cast<String, dynamic>();
    final files = (status?['files'] as List?) ?? const [];
    final total = status?['total'];
    return Padding(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 20),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Text(
                'Changes',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.w600),
              ),
              if (total is num) ...[
                const SizedBox(width: 8),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 8,
                    vertical: 2,
                  ),
                  decoration: BoxDecoration(
                    color: Palette.muted,
                    borderRadius: BorderRadius.circular(99),
                  ),
                  child: Text(
                    '$total',
                    style: const TextStyle(
                      fontSize: 11,
                      color: Palette.fgMuted,
                    ),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 4),
          const Text(
            'The uncommitted changes in this task’s worktree.',
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
          else if (status == null)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Text(
                _emptyStates[_answer?['reason'] as String? ?? 'error'] ??
                    _emptyStates['error']!,
                style: const TextStyle(fontSize: 13, color: Palette.fgMuted),
              ),
            )
          else if (files.isEmpty)
            const Padding(
              padding: EdgeInsets.symmetric(vertical: 12),
              child: Text(
                'No uncommitted changes.',
                style: TextStyle(fontSize: 13, color: Palette.fgMuted),
              ),
            )
          else ...[
            Flexible(
              child: ConstrainedBox(
                constraints: BoxConstraints(
                  maxHeight: MediaQuery.sizeOf(context).height * .55,
                ),
                child: ListView.separated(
                  shrinkWrap: true,
                  itemCount: files.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 2),
                  itemBuilder: (_, i) => _FileRow(
                    file:
                        (files[i] as Map?)?.cast<String, dynamic>() ?? const {},
                  ),
                ),
              ),
            ),
            const SizedBox(height: 10),
            Text(
              [
                if (status['truncated'] == true)
                  'Showing the first ${files.length} of $total changes.',
                if (_answer?['live'] == true)
                  'Read just now.'
                else
                  'Last read ${_when(status['capturedAt'] as String?)}${_answer?['reason'] == 'no-runner' ? ', with the worker stopped' : ''}.',
              ].join(' '),
              style: const TextStyle(fontSize: 11, color: Palette.fgSubtle),
            ),
          ],
        ],
      ),
    );
  }
}

class _FileRow extends StatelessWidget {
  final Json file;
  const _FileRow({required this.file});

  @override
  Widget build(BuildContext context) {
    final path = file['path'] as String? ?? '';
    final status = file['status'] as String? ?? 'modified';
    final (letter, colour, label) =
        _statusStyles[status] ?? _statusStyles['modified']!;
    final slash = path.lastIndexOf('/');
    final name = slash == -1 ? path : path.substring(slash + 1);
    final dir = slash == -1 ? '' : path.substring(0, slash);
    final dot = name.lastIndexOf('.');
    final extension = dot > 0 ? name.substring(dot + 1).toUpperCase() : '';
    final short = extension.length > 4 ? extension.substring(0, 4) : extension;
    return Tooltip(
      message: '$path · $label',
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
        decoration: BoxDecoration(borderRadius: BorderRadius.circular(6)),
        child: Row(
          children: [
            SizedBox(
              width: 28,
              child: short.isEmpty
                  ? const Icon(
                      Icons.description_outlined,
                      size: 14,
                      color: Palette.fgSubtle,
                    )
                  : Text(
                      short,
                      textAlign: TextAlign.center,
                      style: TextStyle(
                        fontFamily: mono,
                        fontSize: 9,
                        fontWeight: FontWeight.w700,
                        color: _extensionColours[short] ?? Palette.fgSubtle,
                      ),
                    ),
            ),
            Flexible(
              child: Text(
                name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 13),
              ),
            ),
            if (dir.isNotEmpty) ...[
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  dir,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  textAlign: TextAlign.right,
                  style: const TextStyle(fontSize: 11, color: Palette.fgSubtle),
                ),
              ),
            ] else
              const Spacer(),
            const SizedBox(width: 8),
            SizedBox(
              width: 14,
              child: Text(
                letter,
                textAlign: TextAlign.right,
                style: TextStyle(
                  fontFamily: mono,
                  fontSize: 12,
                  fontWeight: FontWeight.w700,
                  color: colour,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String _when(String? iso) {
  final date = DateTime.tryParse(iso ?? '');
  if (date == null) return 'just now';
  final diff = DateTime.now().difference(date.toLocal());
  if (diff.inMinutes < 1) return 'just now';
  if (diff.inHours < 1) return '${diff.inMinutes}m ago';
  if (diff.inDays < 1) return '${diff.inHours}h ago';
  if (diff.inDays < 7) return '${diff.inDays}d ago';
  return '${date.toLocal().year}-${date.toLocal().month.toString().padLeft(2, '0')}-${date.toLocal().day.toString().padLeft(2, '0')}';
}
