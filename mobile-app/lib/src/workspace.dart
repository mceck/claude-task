import 'package:material_ui/material_ui.dart';

import 'app.dart';
import 'controller.dart';
import 'conversation.dart';
import 'models.dart';
import 'task_forms.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';

class Workspace extends StatelessWidget {
  final TaskController controller;
  const Workspace({super.key, required this.controller});
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final c = controller, wide = box.maxWidth >= 1000;
      c.conversationVisible = c.task != null;
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
              child: AnimatedSwitcher(
                duration: Motion.medium,
                switchInCurve: Motion.enter,
                switchOutCurve: Motion.exit,
                child: c.project == null
                    ? const EmptyState(
                        icon: Icons.folder_open_rounded,
                        title: 'Select a Project',
                        message:
                            'Pick a Project from the rail to see its Tasks.',
                      )
                    : TaskList(key: ValueKey(c.project!.id), controller: c),
              ),
            ),
            Expanded(
              child: AnimatedSwitcher(
                duration: Motion.medium,
                switchInCurve: Motion.enter,
                switchOutCurve: Motion.exit,
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
        child: AnimatedSwitcher(
          duration: const Duration(milliseconds: 280),
          switchInCurve: Motion.enter,
          switchOutCurve: Motion.exit,
          transitionBuilder: (child, animation) => FadeTransition(
            opacity: animation,
            child: SlideTransition(
              position: Tween(
                begin: const Offset(.05, 0),
                end: Offset.zero,
              ).animate(animation),
              child: child,
            ),
          ),
          child: page,
        ),
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
                      selected: c.project?.id == p.id,
                      onTap: () => c.selectProject(p),
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
                child: Avatar(
                  label: c.user!.displayName,
                  seed: c.user!.id,
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
  final bool selected;
  final VoidCallback onTap;
  const _RailItem({
    required this.project,
    required this.selected,
    required this.onTap,
  });
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 5),
    child: Stack(
      alignment: Alignment.centerLeft,
      children: [
        AnimatedContainer(
          duration: Motion.medium,
          curve: Motion.pop,
          width: 4,
          height: selected ? 32 : 0,
          decoration: const BoxDecoration(
            color: Palette.primary,
            borderRadius: BorderRadius.horizontal(right: Radius.circular(4)),
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
                child: Avatar(
                  label: project.key,
                  seed: project.name,
                  size: 48,
                  circle: false,
                  initials: false,
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
    final intro = c.projects.isNotEmpty && firstIntro('projects');
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 18, 14, 6),
          child: Row(
            children: [
              const FadeSlideIn(
                scale: .7,
                offset: Offset.zero,
                child: BrandMark(size: 36),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'Projects',
                      style: Theme.of(context).textTheme.headlineSmall,
                    ),
                    Text(
                      'Hi ${c.user!.displayName.split(' ').first} · ${c.projects.length} ${c.projects.length == 1 ? 'board' : 'boards'}',
                      style: const TextStyle(
                        fontSize: 12.5,
                        color: Palette.fgSubtle,
                      ),
                    ),
                  ],
                ),
              ),
              Tooltip(
                message: 'Profile',
                child: Pressable(
                  onTap: () => showProfile(context, c),
                  borderRadius: BorderRadius.circular(99),
                  semanticLabel: 'Profile',
                  child: Avatar(
                    label: c.user!.displayName,
                    seed: c.user!.id,
                    size: 36,
                  ),
                ),
              ),
            ],
          ),
        ),
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
                    padding: const EdgeInsets.fromLTRB(16, 14, 16, 24),
                    physics: const AlwaysScrollableScrollPhysics(),
                    itemCount: c.projects.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 10),
                    itemBuilder: (context, i) => FadeSlideIn.staggered(
                      index: i,
                      enabled: intro,
                      child: _ProjectCard(
                        project: c.projects[i],
                        onTap: () => c.selectProject(c.projects[i]),
                      ),
                    ),
                  ),
                ),
        ),
      ],
    );
  }
}

class _ProjectCard extends StatelessWidget {
  final Project project;
  final VoidCallback onTap;
  const _ProjectCard({required this.project, required this.onTap});
  @override
  Widget build(BuildContext context) {
    final p = project, total = p.taskTotal;
    final finished =
        (p.taskCounts['done'] ?? 0) + (p.taskCounts['closed'] ?? 0);
    return Pressable(
      onTap: onTap,
      color: Palette.surface,
      hoverColor: const Color(0x08ffffff),
      border: Border.all(color: Palette.border),
      borderRadius: BorderRadius.circular(Radii.lg),
      pressedScale: .98,
      padding: const EdgeInsets.all(14),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Avatar(
                label: p.key,
                seed: p.name,
                size: 46,
                circle: false,
                initials: false,
                selected: true,
              ),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      p.name,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      p.description.isEmpty ? p.key : p.description,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontFamily: p.description.isEmpty ? mono : null,
                        fontSize: 12.5,
                        color: Palette.fgSubtle,
                      ),
                    ),
                  ],
                ),
              ),
              const Icon(Icons.chevron_right_rounded, color: Palette.fgSubtle),
            ],
          ),
          if (total > 0) ...[
            const SizedBox(height: 14),
            ClipRRect(
              borderRadius: BorderRadius.circular(99),
              child: SizedBox(
                height: 5,
                child: TweenAnimationBuilder<double>(
                  tween: Tween(begin: 0, end: 1),
                  duration: Motion.slow,
                  curve: Motion.enter,
                  builder: (context, t, _) => Row(
                    children: [
                      for (final entry in categoryColors.entries)
                        if ((p.taskCounts[entry.key] ?? 0) > 0)
                          Expanded(
                            flex: p.taskCounts[entry.key]!,
                            child: FractionallySizedBox(
                              alignment: Alignment.centerLeft,
                              widthFactor: t,
                              child: ColoredBox(color: entry.value),
                            ),
                          ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(height: 8),
            Row(
              children: [
                Text(
                  '$total ${total == 1 ? 'Task' : 'Tasks'}',
                  style: const TextStyle(
                    fontSize: 11.5,
                    color: Palette.fgMuted,
                  ),
                ),
                const Spacer(),
                Text(
                  '${(finished / total * 100).round()}% done',
                  style: const TextStyle(
                    fontSize: 11.5,
                    color: Palette.fgSubtle,
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

Future<void> showProfile(BuildContext context, TaskController c) =>
    showAppSheet<void>(
      context,
      maxWidth: 400,
      builder: (sheet) => SheetScaffold(
        title: 'Profile',
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                Avatar(
                  label: c.user!.displayName,
                  seed: c.user!.id,
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
      ),
    );

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
                Avatar(
                  label: c.project!.key,
                  seed: c.project!.name,
                  size: 32,
                  circle: false,
                  initials: false,
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
                      leading: Avatar(
                        label: u.displayName,
                        seed: u.id,
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
    padding: const EdgeInsets.only(top: 14, bottom: 4),
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
          Text(
            status.name.toUpperCase(),
            style: const TextStyle(
              fontSize: 11,
              fontWeight: FontWeight.w600,
              letterSpacing: .9,
              color: Palette.fgMuted,
            ),
          ),
          const SizedBox(width: 8),
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
            decoration: BoxDecoration(
              color: Palette.muted,
              borderRadius: BorderRadius.circular(6),
            ),
            child: Text(
              '$count',
              style: const TextStyle(
                fontFamily: mono,
                fontSize: 10.5,
                color: Palette.fgSubtle,
              ),
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
    return Padding(
      padding: const EdgeInsets.only(bottom: 4),
      child: Stack(
        children: [
          Pressable(
            onTap: () => c.selectTask(task),
            pressedScale: .985,
            color: selected
                ? Palette.hover
                : Palette.surface.withValues(alpha: .55),
            border: Border.all(
              color: selected
                  ? Palette.primary.withValues(alpha: .45)
                  : Palette.border,
            ),
            borderRadius: BorderRadius.circular(Radii.md),
            padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      priorityIcon(task.priority),
                      size: 13,
                      color: priorityColor(task.priority),
                    ),
                    const SizedBox(width: 6),
                    Text(
                      task.key,
                      style: const TextStyle(
                        fontFamily: mono,
                        fontSize: 11,
                        color: Palette.fgSubtle,
                      ),
                    ),
                    if (pref?.muted == true) ...[
                      const SizedBox(width: 6),
                      const Icon(
                        Icons.notifications_off_outlined,
                        size: 12,
                        color: Palette.fgSubtle,
                      ),
                    ],
                    const Spacer(),
                    AnimatedScale(
                      scale: unread ? 1 : 0,
                      duration: Motion.medium,
                      curve: Motion.pop,
                      child: const Dot(
                        color: Palette.primary,
                        size: 7,
                        glow: true,
                      ),
                    ),
                    if (assignees.isNotEmpty) ...[
                      const SizedBox(width: 8),
                      for (final (i, u) in assignees.take(3).indexed)
                        Align(
                          widthFactor: i == 0 ? 1 : .7,
                          child: DecoratedBox(
                            decoration: const BoxDecoration(
                              shape: BoxShape.circle,
                              boxShadow: [
                                BoxShadow(color: Palette.bg, spreadRadius: 1.5),
                              ],
                            ),
                            child: Avatar(
                              label: u.displayName,
                              seed: u.id,
                              size: 18,
                            ),
                          ),
                        ),
                    ],
                    if (task.agentId != null) ...[
                      const SizedBox(width: 8),
                      AgentBadge(
                        agent: agent,
                        state: task.sessionState,
                        queuePosition: task.queuePosition,
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 5),
                Text(
                  task.title,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 14,
                    height: 1.35,
                    fontWeight: unread || selected
                        ? FontWeight.w600
                        : FontWeight.w500,
                    color: unread || selected
                        ? Palette.fg
                        : Palette.fg.withValues(alpha: .86),
                  ),
                ),
                if (tags.isNotEmpty || task.commentCount > 0) ...[
                  const SizedBox(height: 8),
                  Row(
                    children: [
                      Expanded(
                        child: Wrap(
                          spacing: 4,
                          runSpacing: 4,
                          children: [
                            for (final tag in tags)
                              TagChip(tag: tag, dense: true),
                          ],
                        ),
                      ),
                      if (task.commentCount > 0) ...[
                        const Icon(
                          Icons.chat_bubble_outline_rounded,
                          size: 12,
                          color: Palette.fgSubtle,
                        ),
                        const SizedBox(width: 4),
                        Text(
                          '${task.commentCount}',
                          style: const TextStyle(
                            fontSize: 11,
                            color: Palette.fgSubtle,
                          ),
                        ),
                      ],
                    ],
                  ),
                ],
              ],
            ),
          ),
          Positioned(
            left: 0,
            top: 12,
            bottom: 12,
            child: AnimatedContainer(
              duration: Motion.medium,
              curve: Motion.pop,
              width: selected ? 3 : 0,
              decoration: const BoxDecoration(
                color: Palette.primary,
                borderRadius: BorderRadius.horizontal(
                  right: Radius.circular(3),
                ),
              ),
            ),
          ),
        ],
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
