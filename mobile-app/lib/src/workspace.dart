import 'package:material_ui/material_ui.dart';
import 'package:file_picker/file_picker.dart';

import 'api.dart';
import 'app.dart';
import 'controller.dart';
import 'conversation.dart';
import 'models.dart';
import 'task_forms.dart';
import 'wiki.dart';
import 'ui/theme.dart';
import 'ui/project_logo.dart';
import 'ui/widgets.dart';
import 'ui/user_avatar.dart';

class Workspace extends StatelessWidget {
  final TaskController controller;
  const Workspace({super.key, required this.controller});
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final c = controller, wide = box.maxWidth >= 1000;
      c.conversationVisible = c.task != null;
      if (c.wikiSection) {
        if (wide) {
          return Row(
            children: [
              SizedBox(width: 76, child: ProjectRail(controller: c)),
              SizedBox(width: 340, child: WikiList(controller: c)),
              Expanded(
                child: c.task == null
                    ? const EmptyState(
                        icon: Icons.menu_book_outlined,
                        title: 'Select a Wiki',
                        message: 'Open a wiki to join its shared conversation.',
                      )
                    : Conversation(key: ValueKey(c.task!.id), controller: c),
              ),
            ],
          );
        }
        return PopScope(
          canPop: c.wiki == null,
          onPopInvokedWithResult: (popped, _) {
            if (!popped) c.showWikis();
          },
          child: c.task != null
              ? Conversation(
                  key: ValueKey(c.task!.id),
                  controller: c,
                  onBack: c.showWikis,
                )
              : WikiList(controller: c),
        );
      }
      if (wide) {
        return Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SizedBox(width: 76, child: ProjectRail(controller: c)),
            Container(
              width: 340,
              decoration: const BoxDecoration(
                color: Palette.sidebar,
                border: Border(
                  left: BorderSide(color: Palette.border),
                  right: BorderSide(color: Palette.border),
                ),
              ),
              child: c.project == null
                  ? const EmptyState(
                      icon: Icons.folder_open_rounded,
                      title: 'Select a Project',
                      message: 'Pick a Project from the rail to see its Tasks.',
                    )
                  : TaskList(key: ValueKey(c.project!.id), controller: c),
            ),
            Expanded(
              child: c.task == null
                  ? const EmptyState(
                      icon: Icons.forum_outlined,
                      title: 'Select a Task to join the conversation',
                      message: 'Tasks are grouped by Status. Open one to talk with its Agent.',
                    )
                  : Conversation(
                      key: ValueKey(c.task!.id),
                      controller: c,
                      showDetailsAction: box.maxWidth < 1500,
                    ),
            ),
            if (box.maxWidth >= 1500 && c.task != null)
              Container(
                width: 360,
                decoration: const BoxDecoration(
                  color: Palette.sidebar,
                  border: Border(left: BorderSide(color: Palette.border)),
                ),
                child: TaskDetails(
                  key: ValueKey('details:${c.task!.id}'),
                  controller: c,
                ),
              ),
          ],
        );
      }
      final depth = c.task != null
          ? 2
          : c.project != null
          ? 1
          : 0;
      final Widget page = depth == 2
          ? Conversation(
              key: ValueKey('task:${c.task!.id}'),
              controller: c,
              onBack: c.backToTasks,
              showDetailsAction: true,
            )
          : depth == 1
          ? TaskList(
              key: ValueKey('tasks:${c.project!.id}'),
              controller: c,
              onBack: c.backToProjects,
            )
          : ProjectList(key: const ValueKey('projects'), controller: c);
      return PopScope(
        canPop: depth == 0,
        onPopInvokedWithResult: (popped, _) {
          if (popped) return;
          depth == 2 ? c.backToTasks() : c.backToProjects();
        },
        child: page,
      );
    },
  );
}

class ProjectRail extends StatelessWidget {
  final TaskController controller;
  const ProjectRail({super.key, required this.controller});
  @override
  Widget build(BuildContext context) {
    final c = controller;
    final intro = c.projects.isNotEmpty && firstIntro('rail');
    return ColoredBox(
      color: Palette.sidebar,
      child: Column(
        children: [
          const SizedBox(height: 18),
          const FadeSlideIn(
            scale: .7,
            offset: Offset.zero,
            child: BrandMark(size: 40),
          ),
          Container(
            margin: const EdgeInsets.symmetric(vertical: 16),
            width: 28,
            height: 2,
            decoration: BoxDecoration(
              color: Palette.border,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
          IconAction(
            icon: Icons.menu_book_outlined,
            tooltip: 'Wiki',
            active: c.wikiSection,
            onPressed: c.showWikis,
          ),
          const SizedBox(height: 8),
          Expanded(
            child: ListView(
              padding: EdgeInsets.zero,
              children: [
                for (final (i, p) in c.projects.indexed)
                  FadeSlideIn.staggered(
                    index: i,
                    enabled: intro,
                    offset: const Offset(-.25, 0),
                    child: _RailItem(
                      project: p,
                      api: c.api,
                      selected: c.project?.id == p.id,
                      onTap: () {
                        if (c.project?.id != p.id) c.selectProject(p);
                      },
                    ),
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.only(bottom: 16, top: 8),
            child: Tooltip(
              message: 'Profile',
              child: Pressable(
                onTap: () => showProfile(context, c),
                borderRadius: BorderRadius.circular(99),
                semanticLabel: 'Profile',
                child: UserAvatar(
                  label: c.user!.displayName,
                  userId: c.user!.id,
                  imageUrl: c.user!.avatarImageUrl,
                  api: c.api,
                  size: 38,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _RailItem extends StatelessWidget {
  final Project project;
  final TaskApi? api;
  final bool selected;
  final VoidCallback onTap;
  const _RailItem({
    required this.project,
    required this.api,
    required this.selected,
    required this.onTap,
  });
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Stack(
      alignment: Alignment.centerLeft,
      children: [
        AnimatedOpacity(
          opacity: selected ? 1 : 0,
          duration: Motion.fast,
          child: Container(
            width: 3,
            height: 28,
            decoration: const BoxDecoration(
              color: Palette.primary,
              borderRadius: BorderRadius.horizontal(right: Radius.circular(3)),
            ),
          ),
        ),
        Center(
          child: Tooltip(
            message: project.name,
            preferBelow: false,
            child: Pressable(
              onTap: onTap,
              pressedScale: .92,
              borderRadius: BorderRadius.circular(16),
              child: AnimatedContainer(
                duration: Motion.medium,
                curve: Motion.enter,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(16),
                  boxShadow: selected
                      ? [
                          BoxShadow(
                            color: tint(project.name).withValues(alpha: .3),
                            blurRadius: 16,
                            offset: const Offset(0, 4),
                          ),
                        ]
                      : const [],
                ),
                child: ProjectLogo(
                  project: project,
                  api: api,
                  size: 48,
                  selected: selected,
                ),
              ),
            ),
          ),
        ),
      ],
    ),
  );
}

/// Status categories use the same semantic tones as the rest of the app.
const categoryColors = {
  'open': Palette.slate,
  'active': Palette.info,
  'review': Palette.violet,
  'done': Palette.success,
  'closed': Palette.fgSubtle,
};

class ProjectList extends StatelessWidget {
  final TaskController controller;
  const ProjectList({super.key, required this.controller});
  @override
  Widget build(BuildContext context) {
    final c = controller;
    final totalTasks = c.projects.fold(
      0,
      (total, project) => total + project.taskTotal,
    );
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 20, 20, 18),
          child: Row(
            children: [
              const BrandMark(size: 32),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text(
                      'Projects',
                      style: TextStyle(
                        fontSize: 22,
                        fontWeight: FontWeight.w600,
                        letterSpacing: -.6,
                      ),
                    ),
                    const SizedBox(height: 3),
                    Text(
                      '${c.projects.length} ${c.projects.length == 1 ? 'project' : 'projects'} · $totalTasks ${totalTasks == 1 ? 'task' : 'tasks'}',
                      style: const TextStyle(
                        fontSize: 12,
                        color: Palette.fgSubtle,
                      ),
                    ),
                  ],
                ),
              ),
              IconAction(
                icon: Icons.menu_book_outlined,
                tooltip: 'Wiki',
                onPressed: c.showWikis,
              ),
              Tooltip(
                message: 'Profile',
                child: Pressable(
                  onTap: () => showProfile(context, c),
                  borderRadius: BorderRadius.circular(99),
                  semanticLabel: 'Profile',
                  child: UserAvatar(
                    label: c.user!.displayName,
                    userId: c.user!.id,
                    imageUrl: c.user!.avatarImageUrl,
                    api: c.api,
                    size: 32,
                  ),
                ),
              ),
            ],
          ),
        ),
        const Divider(),
        Expanded(
          child: c.projects.isEmpty
              ? const EmptyState(
                  icon: Icons.folder_off_outlined,
                  title: 'No Projects',
                  message: 'Projects created on the web appear here.',
                )
              : RefreshIndicator(
                  color: Palette.primary,
                  backgroundColor: Palette.raised,
                  onRefresh: () => perform(context, c.refresh),
                  child: ListView.separated(
                    padding: const EdgeInsets.fromLTRB(8, 8, 8, 24),
                    physics: const AlwaysScrollableScrollPhysics(),
                    itemCount: c.projects.length,
                    separatorBuilder: (_, _) => const Padding(
                      padding: EdgeInsets.only(left: 64, right: 12),
                      child: Divider(),
                    ),
                    itemBuilder: (context, i) => _ProjectRow(
                      project: c.projects[i],
                      api: c.api,
                      onTap: () => c.selectProject(c.projects[i]),
                    ),
                  ),
                ),
        ),
      ],
    );
  }
}

class _ProjectRow extends StatelessWidget {
  final Project project;
  final VoidCallback onTap;
  final TaskApi? api;
  const _ProjectRow({
    required this.project,
    required this.api,
    required this.onTap,
  });
  @override
  Widget build(BuildContext context) {
    final p = project, total = p.taskTotal;
    final finished =
        (p.taskCounts['done'] ?? 0) + (p.taskCounts['closed'] ?? 0);
    final progress = total == 0 ? 0.0 : (finished / total).clamp(0.0, 1.0);
    final percent = (progress * 100).round();
    return Pressable(
      key: ValueKey('project-row:${p.id}'),
      onTap: onTap,
      semanticLabel: p.name,
      hoverColor: const Color(0x08ffffff),
      borderRadius: BorderRadius.circular(Radii.md),
      pressedScale: 1,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ProjectLogo(project: p, api: api),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Tooltip(
                        message: p.name,
                        child: Text(
                          p.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 15.5,
                            height: 1.3,
                            fontWeight: FontWeight.w600,
                            letterSpacing: -.2,
                          ),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    const Icon(
                      Icons.chevron_right_rounded,
                      size: 18,
                      color: Palette.fgSubtle,
                    ),
                  ],
                ),
                if (p.description.isNotEmpty) ...[
                  const SizedBox(height: 3),
                  Text(
                    p.description,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(
                      fontSize: 12,
                      height: 1.3,
                      color: Palette.fgMuted,
                    ),
                  ),
                ],
                const SizedBox(height: 3),
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        p.key,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontFamily: mono,
                          fontSize: 10.5,
                          height: 1.2,
                          color: Palette.fgSubtle,
                        ),
                      ),
                    ),
                    const Padding(
                      padding: EdgeInsets.symmetric(horizontal: 7),
                      child: Dot(color: Palette.borderStrong, size: 3),
                    ),
                    Text(
                      total == 0
                          ? 'No tasks yet'
                          : '$total ${total == 1 ? 'task' : 'tasks'}',
                      style: const TextStyle(
                        fontSize: 11.5,
                        height: 1.2,
                        color: Palette.fgMuted,
                      ),
                    ),
                  ],
                ),
                if (total > 0) ...[
                  const SizedBox(height: 7),
                  Row(
                    children: [
                      Expanded(
                        child: Semantics(
                          label: 'Task completion',
                          value: '$finished of $total completed',
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(99),
                            child: SizedBox(
                              height: 3,
                              child: Stack(
                                fit: StackFit.expand,
                                children: [
                                  const ColoredBox(color: Palette.muted),
                                  FractionallySizedBox(
                                    alignment: Alignment.centerLeft,
                                    widthFactor: progress,
                                    child: const ColoredBox(
                                      color: Palette.primary,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(width: 10),
                      Text(
                        '$percent% done',
                        style: const TextStyle(
                          fontSize: 10.5,
                          height: 1.2,
                          color: Palette.fgSubtle,
                        ),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ],
      ),
    );
  }
}

Future<void> showProfile(BuildContext context, TaskController c) =>
    showAppSheet<void>(
      context,
      maxWidth: 400,
      builder: (sheet) => _ProfileSheet(controller: c),
    );

class _ProfileSheet extends StatefulWidget {
  final TaskController controller;
  const _ProfileSheet({required this.controller});

  @override
  State<_ProfileSheet> createState() => _ProfileSheetState();
}

class _ProfileSheetState extends State<_ProfileSheet> {
  bool _saving = false;
  String? _error;

  Future<void> _changePhoto({bool remove = false}) async {
    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      DraftFile? file;
      if (!remove) {
        final picked = await FilePicker.pickFiles(
          type: FileType.custom,
          allowedExtensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'],
        );
        if (picked.isEmpty) return;
        final selected = picked.single;
        if ((await selected.length() ?? 0) > 2 * 1024 * 1024) {
          throw const FormatException('The avatar must be at most 2 MB');
        }
        if (selected.path == null) {
          throw const FormatException('The selected image is unavailable');
        }
        file = DraftFile(selected.path!, selected.name);
      }
      if (!mounted) return;
      await widget.controller.changeAvatar(file);
    } catch (e) {
      if (mounted) setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (sheet, _) {
      final c = widget.controller;
      if (c.user == null) return const SizedBox.shrink();
      return SheetScaffold(
        title: 'Profile',
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                UserAvatar(
                  label: c.user!.displayName,
                  userId: c.user!.id,
                  imageUrl: c.user!.avatarImageUrl,
                  api: c.api,
                  size: 52,
                  selected: true,
                ),
                const SizedBox(width: 14),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        c.user!.displayName,
                        style: Theme.of(sheet).textTheme.titleMedium,
                      ),
                      Text(
                        c.user!.email,
                        style: const TextStyle(
                          color: Palette.fgMuted,
                          fontSize: 13,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            AppButton(
              label: 'Change photo',
              icon: Icons.photo_camera_outlined,
              tone: Tone.secondary,
              onPressed: _saving || !c.online ? null : () => _changePhoto(),
            ),
            if (c.user!.avatarImageUrl != null) ...[
              const SizedBox(height: 8),
              AppButton(
                label: 'Remove photo',
                tone: Tone.secondary,
                onPressed: _saving || !c.online
                    ? null
                    : () => _changePhoto(remove: true),
              ),
            ],
            if (_saving)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Text('Saving photo…'),
              ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(top: 8),
                child: Text(
                  _error!,
                  style: const TextStyle(color: Palette.danger),
                ),
              ),
            const SizedBox(height: 20),
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: Palette.surface,
                borderRadius: BorderRadius.circular(Radii.md),
                border: Border.all(color: Palette.border),
              ),
              child: Row(
                children: [
                  Container(
                    width: 32,
                    height: 32,
                    decoration: BoxDecoration(
                      color: Palette.primary.withValues(alpha: .14),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: const Icon(
                      Icons.notifications_none_rounded,
                      size: 18,
                      color: Palette.primarySoft,
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      c.push.status,
                      style: const TextStyle(fontSize: 13.5),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          AppButton(
            label: 'Log out',
            icon: Icons.logout_rounded,
            tone: Tone.danger,
            onPressed: () {
              Navigator.pop(sheet);
              perform(context, c.logout);
            },
          ),
          AppButton(
            label: 'Enable notifications',
            tone: Tone.secondary,
            onPressed: () {
              Navigator.pop(sheet);
              perform(context, c.enableNotifications);
            },
          ),
        ],
      );
    },
  );
}

class TaskList extends StatefulWidget {
  final TaskController controller;
  final VoidCallback? onBack;
  const TaskList({super.key, required this.controller, this.onBack});
  @override
  State<TaskList> createState() => _TaskListState();
}

class _TaskListState extends State<TaskList> {
  final _searchField = TextEditingController();
  final _collapsed = <String>{};
  String _search = '', _priority = '', _tag = '', _assignee = '';
  int get _filterCount =>
      [_priority, _tag, _assignee].where((v) => v.isNotEmpty).length;

  /// Rows play their entrance only the first time this Project's list opens,
  /// never while searching, filtering or coming back from a conversation.
  late bool _intro = firstIntro('tasks:${widget.controller.project?.id}');

  @override
  void dispose() {
    _searchField.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
    if (c.project == null) return const SizedBox.shrink();
    final filtering = _search.isNotEmpty || _filterCount > 0;
    final filtered = c.tasks
        .where(
          (t) =>
              '${t.key} ${t.title}'.toLowerCase().contains(
                _search.toLowerCase(),
              ) &&
              (_priority.isEmpty || t.priority == _priority) &&
              (_tag.isEmpty || t.tagIds.contains(_tag)) &&
              (_assignee.isEmpty ||
                  (_assignee == 'none'
                      ? t.assigneeIds.isEmpty
                      : t.assigneeIds.contains(_assignee))),
        )
        .toList();
    final groups = [
      for (final status in c.statuses.where(
        (s) => c.includeClosed || s.category != 'closed',
      ))
        (status, filtered.where((t) => t.statusId == status.id).toList()),
    ].where((g) => !filtering || g.$2.isNotEmpty).toList();
    var row = 0;
    if (_intro && c.tasks.isNotEmpty) {
      WidgetsBinding.instance.addPostFrameCallback((_) => _intro = false);
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: EdgeInsets.fromLTRB(
            widget.onBack == null ? 18 : 6,
            12,
            12,
            10,
          ),
          child: Row(
            children: [
              if (widget.onBack != null)
                IconAction(
                  icon: Icons.arrow_back_ios_new_rounded,
                  tooltip: 'Back',
                  onPressed: widget.onBack,
                ),
              if (widget.onBack != null) ...[
                const SizedBox(width: 4),
                ProjectLogo(
                  project: c.project!,
                  api: c.api,
                  size: 32,
                  selected: true,
                ),
                const SizedBox(width: 10),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      c.project!.name,
                      style: Theme.of(context).textTheme.titleLarge,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    Text(
                      '${c.tasks.length} Tasks',
                      style: const TextStyle(
                        fontSize: 12,
                        color: Palette.fgSubtle,
                      ),
                    ),
                  ],
                ),
              ),
              IconAction(
                icon: Icons.add_rounded,
                tooltip: 'Create Task',
                filled: true,
                size: 36,
                onPressed: c.online ? () => showCreateTask(context, c) : null,
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: TextField(
            key: const Key('task-search'),
            controller: _searchField,
            decoration: InputDecoration(
              hintText: 'Search by title or key',
              prefixIcon: const Icon(Icons.search_rounded, size: 19),
              contentPadding: const EdgeInsets.symmetric(vertical: 10),
              suffixIcon: _search.isEmpty
                  ? null
                  : IconButton(
                      tooltip: 'Clear search',
                      icon: const Icon(Icons.close_rounded, size: 17),
                      onPressed: () => setState(() {
                        _searchField.clear();
                        _search = '';
                      }),
                    ),
            ),
            onChanged: (v) => setState(() => _search = v),
          ),
        ),
        SizedBox(
          height: 50,
          child: ListView(
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            children: [
              ChoiceChipX(
                label: 'Archive',
                icon: Icons.inventory_2_outlined,
                selected: c.includeClosed,
                onChanged: (v) => setState(() => c.includeClosed = v),
              ),
              const SizedBox(width: 8),
              ChoiceChipX(
                label: 'Filters',
                icon: Icons.tune_rounded,
                selected: _filterCount > 0,
                count: _filterCount,
                onChanged: (_) => _openFilters(context),
              ),
              if (_filterCount > 0) ...[
                const SizedBox(width: 4),
                FadeSlideIn(
                  offset: const Offset(-.2, 0),
                  child: AppButton(
                    label: 'Clear',
                    icon: Icons.close_rounded,
                    tone: Tone.ghost,
                    compact: true,
                    onPressed: () => setState(() {
                      _priority = '';
                      _tag = '';
                      _assignee = '';
                    }),
                  ),
                ),
              ],
            ],
          ),
        ),
        const Divider(),
        Expanded(
          child: filtered.isEmpty && filtering
              ? const EmptyState(
                  icon: Icons.search_off_rounded,
                  title: 'No matching Tasks',
                  message: 'Try another search or clear the filters.',
                )
              : RefreshIndicator(
                  color: Palette.primary,
                  backgroundColor: Palette.raised,
                  onRefresh: () => perform(context, c.refresh),
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(8, 2, 8, 24),
                    children: [
                      for (final (status, tasks) in groups) ...[
                        _GroupHeader(
                          status: status,
                          count: tasks.length,
                          collapsed: _collapsed.contains(status.id),
                          onTap: () => setState(() {
                            if (!_collapsed.remove(status.id)) {
                              _collapsed.add(status.id);
                            }
                          }),
                        ),
                        AnimatedSize(
                          duration: Motion.medium,
                          curve: Motion.enter,
                          alignment: Alignment.topCenter,
                          child: _collapsed.contains(status.id)
                              ? const SizedBox(width: double.infinity)
                              : Column(
                                  children: [
                                    for (final task in tasks)
                                      FadeSlideIn.staggered(
                                        key: ValueKey('row:${task.id}'),
                                        enabled: _intro,
                                        index: row++,
                                        child: _TaskRow(
                                          task: task,
                                          controller: c,
                                          selected: c.task?.id == task.id,
                                        ),
                                      ),
                                  ],
                                ),
                        ),
                      ],
                      if (c.tasks.isEmpty)
                        const Padding(
                          padding: EdgeInsets.only(top: 40),
                          child: EmptyState(
                            icon: Icons.task_alt_rounded,
                            title: 'No Tasks yet',
                            message: 'Create the first Task with the + button.',
                          ),
                        ),
                    ],
                  ),
                ),
        ),
      ],
    );
  }

  Future<void> _openFilters(BuildContext context) async {
    final c = widget.controller;
    await showAppSheet<void>(
      context,
      builder: (sheet) => StatefulBuilder(
        builder: (sheet, set) {
          void update(VoidCallback change) {
            setState(change);
            set(() {});
          }

          Widget group(String label, List<Widget> chips) => Padding(
            padding: const EdgeInsets.only(bottom: 20),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SectionLabel(label),
                Wrap(spacing: 8, runSpacing: 8, children: chips),
              ],
            ),
          );
          return SheetScaffold(
            title: 'Task filters',
            body: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                group('Priority', [
                  for (final p in ['', ...priorities])
                    ChoiceChipX(
                      label: p.isEmpty ? 'Any' : priorityLabel(p),
                      icon: p.isEmpty ? null : priorityIcon(p),
                      selected: _priority == p,
                      onChanged: (_) => update(() => _priority = p),
                    ),
                ]),
                if (c.tags.isNotEmpty)
                  group('Tag', [
                    ChoiceChipX(
                      label: 'Any',
                      selected: _tag.isEmpty,
                      onChanged: (_) => update(() => _tag = ''),
                    ),
                    for (final l in c.tags)
                      ChoiceChipX(
                        label: l.name,
                        leading: Dot(color: tagColor(l), size: 7),
                        selected: _tag == l.id,
                        onChanged: (_) => update(() => _tag = l.id),
                      ),
                  ]),
                group('User', [
                  ChoiceChipX(
                    label: 'Anyone',
                    selected: _assignee.isEmpty,
                    onChanged: (_) => update(() => _assignee = ''),
                  ),
                  ChoiceChipX(
                    label: 'Unassigned',
                    selected: _assignee == 'none',
                    onChanged: (_) => update(() => _assignee = 'none'),
                  ),
                  for (final u in c.users)
                    ChoiceChipX(
                      label: u.displayName,
                      leading: UserAvatar(
                        label: u.displayName,
                        userId: u.id,
                        imageUrl: u.avatarImageUrl,
                        api: c.api,
                        size: 18,
                      ),
                      selected: _assignee == u.id,
                      onChanged: (_) => update(() => _assignee = u.id),
                    ),
                ]),
              ],
            ),
            actions: [
              AppButton(
                label: 'Reset',
                tone: Tone.secondary,
                onPressed: () => update(() {
                  _priority = '';
                  _tag = '';
                  _assignee = '';
                }),
              ),
              AppButton(label: 'Apply', onPressed: () => Navigator.pop(sheet)),
            ],
          );
        },
      ),
    );
  }
}

class _GroupHeader extends StatelessWidget {
  final TaskStatus status;
  final int count;
  final bool collapsed;
  final VoidCallback onTap;
  const _GroupHeader({
    required this.status,
    required this.count,
    required this.collapsed,
    required this.onTap,
  });
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 8, bottom: 2),
    child: Pressable(
      onTap: onTap,
      pressedScale: 1,
      borderRadius: BorderRadius.circular(8),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Row(
        children: [
          AnimatedRotation(
            turns: collapsed ? -.25 : 0,
            duration: Motion.fast,
            curve: Motion.enter,
            child: const Icon(
              Icons.keyboard_arrow_down_rounded,
              size: 16,
              color: Palette.fgSubtle,
            ),
          ),
          const SizedBox(width: 6),
          StatusDot(color: hexColor(status.color), size: 8),
          const SizedBox(width: 9),
          Expanded(
            child: Text(
              status.name.toUpperCase(),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(
                fontSize: 10.5,
                fontWeight: FontWeight.w600,
                letterSpacing: .65,
                color: Palette.fgMuted,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            '$count',
            style: const TextStyle(
              fontFamily: mono,
              fontSize: 10.5,
              color: Palette.fgSubtle,
            ),
          ),
        ],
      ),
    ),
  );
}

class _TaskRow extends StatelessWidget {
  final Task task;
  final TaskController controller;
  final bool selected;
  const _TaskRow({
    required this.task,
    required this.controller,
    required this.selected,
  });
  @override
  Widget build(BuildContext context) {
    final c = controller, pref = c.preferences[task.id];
    final unread = pref?.unread == true;
    final agent = c.agents.byId(task.agentId);
    final tags = [for (final id in task.tagIds) ?c.tags.byId(id)];
    final assignees = [for (final id in task.assigneeIds) ?c.users.byId(id)];
    final tagNames = tags.map((tag) => tag.name).join(' · ');
    return Padding(
      padding: const EdgeInsets.only(left: 16, bottom: 2),
      child: Semantics(
        key: ValueKey('task-row:${task.id}'),
        selected: selected,
        child: Tooltip(
          message: task.title,
          child: Stack(
            children: [
              Pressable(
                onTap: () {
                  if (!selected) c.selectTask(task);
                },
                pressedScale: 1,
                color: selected ? Palette.surface : Colors.transparent,
                hoverColor: const Color(0x08ffffff),
                borderRadius: BorderRadius.circular(Radii.sm),
                padding: const EdgeInsets.symmetric(
                  horizontal: 10,
                  vertical: 9,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Text(
                            task.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: TextStyle(
                              fontSize: 13.5,
                              height: 1.35,
                              fontWeight: unread
                                  ? FontWeight.w600
                                  : FontWeight.w500,
                              color: Palette.fg,
                            ),
                          ),
                        ),
                        if (unread) ...[
                          const SizedBox(width: 8),
                          const Dot(color: Palette.primary, size: 5),
                        ],
                      ],
                    ),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Tooltip(
                          message: priorityLabel(task.priority),
                          child: Icon(
                            priorityIcon(task.priority),
                            size: 12,
                            color: priorityColor(task.priority),
                          ),
                        ),
                        const SizedBox(width: 5),
                        ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 88),
                          child: Text(
                            task.key,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontFamily: mono,
                              fontSize: 10.5,
                              color: Palette.fgSubtle,
                            ),
                          ),
                        ),
                        if (pref?.muted == true) ...[
                          const SizedBox(width: 5),
                          const Icon(
                            Icons.notifications_off_outlined,
                            size: 11,
                            color: Palette.fgSubtle,
                          ),
                        ],
                        const SizedBox(width: 8),
                        Expanded(
                          child: tags.isEmpty
                              ? const SizedBox.shrink()
                              : Tooltip(
                                  message: tagNames,
                                  child: Row(
                                    children: [
                                      Dot(color: tagColor(tags.first), size: 5),
                                      const SizedBox(width: 4),
                                      Expanded(
                                        child: Text(
                                          tagNames,
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                          style: const TextStyle(
                                            fontSize: 10.5,
                                            color: Palette.fgMuted,
                                          ),
                                        ),
                                      ),
                                    ],
                                  ),
                                ),
                        ),
                        for (final user in assignees.take(2))
                          Padding(
                            padding: const EdgeInsets.only(left: 4),
                            child: Tooltip(
                              message: user.displayName,
                              child: UserAvatar(
                                label: user.displayName,
                                userId: user.id,
                                imageUrl: user.avatarImageUrl,
                                api: c.api,
                                size: 16,
                              ),
                            ),
                          ),
                        if (task.agentId != null) ...[
                          const SizedBox(width: 6),
                          AgentBadge(
                            agent: agent,
                            state: task.sessionState,
                            queuePosition: task.queuePosition,
                            size: 18,
                          ),
                        ],
                        if (task.commentCount > 0) ...[
                          const SizedBox(width: 8),
                          const Icon(
                            Icons.chat_bubble_outline_rounded,
                            size: 11,
                            color: Palette.fgSubtle,
                          ),
                          const SizedBox(width: 3),
                          Text(
                            '${task.commentCount}',
                            style: const TextStyle(
                              fontSize: 10.5,
                              color: Palette.fgSubtle,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ],
                ),
              ),
              Positioned(
                left: 0,
                top: 12,
                bottom: 12,
                child: AnimatedOpacity(
                  opacity: selected ? 1 : 0,
                  duration: Motion.fast,
                  child: Container(
                    width: 2,
                    decoration: BoxDecoration(
                      color: Palette.primary,
                      borderRadius: BorderRadius.circular(2),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// An Agent's emoji with its Session state dot, like the web board card.
class AgentBadge extends StatelessWidget {
  final Agent? agent;
  final String? state;
  final int? queuePosition;
  final double size;
  const AgentBadge({
    super.key,
    this.agent,
    this.state,
    this.queuePosition,
    this.size = 22,
  });
  @override
  Widget build(BuildContext context) {
    final color = sessionColor(state, queued: queuePosition != null);
    return Tooltip(
      message:
          '${agent?.name ?? 'Agent'}: ${queuePosition != null ? 'queued #$queuePosition' : state ?? 'assigned'}',
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Stack(
            clipBehavior: Clip.none,
            children: [
              Avatar(
                label: agent?.name ?? 'Agent',
                emoji: agent?.emoji ?? '🤖',
                size: size,
                circle: false,
              ),
              if (state != null)
                Positioned(
                  right: -2,
                  bottom: -2,
                  child: Container(
                    padding: const EdgeInsets.all(1.5),
                    decoration: const BoxDecoration(
                      color: Palette.bg,
                      shape: BoxShape.circle,
                    ),
                    child: state == 'running'
                        ? PulseDot(color: color, size: 7)
                        : Dot(color: color, size: 7),
                  ),
                ),
            ],
          ),
          if (queuePosition != null) ...[
            const SizedBox(width: 3),
            Text(
              '#$queuePosition',
              style: const TextStyle(
                fontFamily: mono,
                fontSize: 10.5,
                color: Palette.info,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
