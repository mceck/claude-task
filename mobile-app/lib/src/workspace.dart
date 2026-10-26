import 'package:flutter/material.dart';
import 'app.dart';
import 'controller.dart';
import 'conversation.dart';
import 'task_forms.dart';

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
          children: [
            SizedBox(width: 78, child: ProjectList(controller: c, rail: true)),
            const VerticalDivider(width: 1),
            SizedBox(
              width: 300,
              child: c.project == null
                  ? const Center(child: Text('Select a Project'))
                  : TaskList(controller: c),
            ),
            const VerticalDivider(width: 1),
            Expanded(
              child: c.task == null
                  ? const Center(
                      child: Text('Select a Task to join the conversation'),
                    )
                  : Conversation(key: ValueKey(c.task!.id), controller: c),
            ),
            if (box.maxWidth >= 1500 && c.task != null) ...[
              const VerticalDivider(width: 1),
              SizedBox(width: 320, child: TaskDetails(controller: c)),
            ],
          ],
        );
      }
      if (c.task != null) {
        return Conversation(
          key: ValueKey(c.task!.id),
          controller: c,
          onBack: () => c.backToTasks(),
        );
      }
      if (c.project != null) {
        return TaskList(controller: c, onBack: () => c.backToProjects());
      }
      return ProjectList(controller: c);
    },
  );
}

class ProjectList extends StatelessWidget {
  final TaskController controller;
  final bool rail;
  const ProjectList({super.key, required this.controller, this.rail = false});
  @override
  Widget build(BuildContext context) => ColoredBox(
    color: const Color(0xff14151b),
    child: Column(
      children: [
        Padding(
          padding: const EdgeInsets.symmetric(vertical: 20),
          child: rail
              ? const Icon(Icons.forum_rounded, color: Color(0xffb5a9ff))
              : Text(
                  'Projects',
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
        ),
        Expanded(
          child: controller.projects.isEmpty
              ? const Center(child: Text('No Projects'))
              : ListView(
                  children: [
                    for (final p in controller.projects)
                      rail
                          ? Padding(
                              padding: const EdgeInsets.symmetric(
                                vertical: 7,
                                horizontal: 10,
                              ),
                              child: Tooltip(
                                message: p.name,
                                child: InkWell(
                                  borderRadius: BorderRadius.circular(16),
                                  onTap: () => controller.selectProject(p),
                                  child: Container(
                                    height: 52,
                                    decoration: BoxDecoration(
                                      color: controller.project?.id == p.id
                                          ? const Color(0xff7662ce)
                                          : const Color(0xff2c2e38),
                                      borderRadius: BorderRadius.circular(16),
                                    ),
                                    alignment: Alignment.center,
                                    child: Text(
                                      p.key,
                                      style: const TextStyle(
                                        fontWeight: FontWeight.bold,
                                        fontSize: 12,
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            )
                          : ListTile(
                              leading: CircleAvatar(child: Text(p.key)),
                              title: Text(p.name),
                              subtitle: Text(p.key),
                              onTap: () => controller.selectProject(p),
                            ),
                  ],
                ),
        ),
        PopupMenuButton<String>(
          tooltip: 'Profile',
          icon: const Icon(Icons.account_circle_outlined),
          onSelected: (value) {
            perform(
              context,
              value == 'logout'
                  ? controller.logout
                  : controller.enableNotifications,
            );
          },
          itemBuilder: (_) => [
            PopupMenuItem(
              enabled: false,
              child: Text(controller.user!.displayName),
            ),
            PopupMenuItem(enabled: false, child: Text(controller.push.status)),
            const PopupMenuItem(
              value: 'notifications',
              child: Text('Enable notifications'),
            ),
            const PopupMenuItem(value: 'logout', child: Text('Log out')),
          ],
        ),
        const SizedBox(height: 12),
      ],
    ),
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
  String _search = '', _priority = '', _tag = '', _assignee = '';
  @override
  Widget build(BuildContext context) {
    final c = widget.controller;
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
    return ColoredBox(
      color: const Color(0xff21222b),
      child: Column(
        children: [
          SizedBox(
            height: 64,
            child: Row(
              children: [
                if (widget.onBack != null)
                  IconButton(
                    onPressed: widget.onBack,
                    icon: const Icon(Icons.arrow_back),
                  ),
                const SizedBox(width: 16),
                Expanded(
                  child: Text(
                    c.project!.name,
                    style: Theme.of(context).textTheme.titleLarge,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                IconButton(
                  tooltip: 'Create Task',
                  onPressed: c.online ? () => showCreateTask(context, c) : null,
                  icon: const Icon(Icons.add),
                ),
                if (widget.onBack != null)
                  PopupMenuButton<String>(
                    onSelected: (v) => perform(
                      context,
                      v == 'logout' ? c.logout : c.enableNotifications,
                    ),
                    itemBuilder: (_) => [
                      const PopupMenuItem(
                        value: 'notifications',
                        child: Text('Enable notifications'),
                      ),
                      const PopupMenuItem(
                        value: 'logout',
                        child: Text('Log out'),
                      ),
                    ],
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: TextField(
              key: const Key('task-search'),
              decoration: const InputDecoration(
                hintText: 'Search Tasks',
                prefixIcon: Icon(Icons.search),
                isDense: true,
              ),
              onChanged: (v) => setState(() => _search = v),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(
              children: [
                FilterChip(
                  label: const Text('Archive'),
                  selected: c.includeClosed,
                  onSelected: (v) => setState(() => c.includeClosed = v),
                ),
                const Spacer(),
                IconButton(
                  tooltip: 'Task filters',
                  icon: Icon(
                    Icons.filter_list,
                    color:
                        _priority.isNotEmpty ||
                            _tag.isNotEmpty ||
                            _assignee.isNotEmpty
                        ? const Color(0xffb5a9ff)
                        : null,
                  ),
                  onPressed: () async {
                    await showDialog<void>(
                      context: context,
                      builder: (context) => StatefulBuilder(
                        builder: (context, set) => AlertDialog(
                          title: const Text('Task filters'),
                          content: SizedBox(
                            width: 320,
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                DropdownButtonFormField<String>(
                                  initialValue: _priority,
                                  decoration: const InputDecoration(
                                    labelText: 'Priority',
                                  ),
                                  items:
                                      [
                                            '',
                                            'urgent',
                                            'high',
                                            'normal',
                                            'low',
                                            'none',
                                          ]
                                          .map(
                                            (v) => DropdownMenuItem(
                                              value: v,
                                              child: Text(
                                                v.isEmpty
                                                    ? 'All priorities'
                                                    : v,
                                              ),
                                            ),
                                          )
                                          .toList(),
                                  onChanged: (v) => set(() => _priority = v!),
                                ),
                                const SizedBox(height: 12),
                                DropdownButtonFormField<String>(
                                  initialValue: _tag,
                                  decoration: const InputDecoration(
                                    labelText: 'Label',
                                  ),
                                  items: [
                                    const DropdownMenuItem(
                                      value: '',
                                      child: Text('All Tags'),
                                    ),
                                    for (final l in c.tags)
                                      DropdownMenuItem(
                                        value: l.id,
                                        child: Text(l.name),
                                      ),
                                  ],
                                  onChanged: (v) => set(() => _tag = v!),
                                ),
                                const SizedBox(height: 12),
                                DropdownButtonFormField<String>(
                                  initialValue: _assignee,
                                  decoration: const InputDecoration(
                                    labelText: 'User',
                                  ),
                                  items: [
                                    const DropdownMenuItem(
                                      value: '',
                                      child: Text('All Users'),
                                    ),
                                    const DropdownMenuItem(
                                      value: 'none',
                                      child: Text('Unassigned'),
                                    ),
                                    for (final u in c.users)
                                      DropdownMenuItem(
                                        value: u.id,
                                        child: Text(u.displayName),
                                      ),
                                  ],
                                  onChanged: (v) => set(() => _assignee = v!),
                                ),
                              ],
                            ),
                          ),
                          actions: [
                            TextButton(
                              onPressed: () => Navigator.pop(context),
                              child: const Text('Apply'),
                            ),
                          ],
                        ),
                      ),
                    );
                    if (mounted) setState(() {});
                  },
                ),
              ],
            ),
          ),
          Expanded(
            child: ListView(
              children: [
                for (final status in c.statuses.where(
                  (s) => c.includeClosed || s.category != 'closed',
                )) ...[
                  Padding(
                    padding: const EdgeInsets.fromLTRB(18, 22, 12, 6),
                    child: Row(
                      children: [
                        Icon(
                          Icons.expand_more,
                          size: 16,
                          color: _color(status.color),
                        ),
                        const SizedBox(width: 6),
                        Text(
                          status.name.toUpperCase(),
                          style: const TextStyle(
                            fontSize: 11,
                            fontWeight: FontWeight.w700,
                            letterSpacing: 1,
                          ),
                        ),
                      ],
                    ),
                  ),
                  for (final task in filtered.where(
                    (t) => t.statusId == status.id,
                  ))
                    ListTile(
                      dense: true,
                      selected: c.task?.id == task.id,
                      leading: Icon(
                        Icons.tag,
                        color: c.preferences[task.id]?.unread == true
                            ? const Color(0xffc6bbff)
                            : Colors.grey,
                        size: 22,
                      ),
                      title: Text(
                        task.title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontWeight: c.preferences[task.id]?.unread == true
                              ? FontWeight.bold
                              : FontWeight.normal,
                        ),
                      ),
                      subtitle: Text(
                        task.key,
                        style: const TextStyle(fontSize: 11),
                      ),
                      trailing: c.preferences[task.id]?.muted == true
                          ? const Icon(
                              Icons.notifications_off_outlined,
                              size: 16,
                            )
                          : task.agentId != null
                          ? const Icon(Icons.smart_toy_outlined, size: 16)
                          : null,
                      onTap: () => c.selectTask(task),
                    ),
                ],
                if (filtered.isEmpty)
                  const Padding(
                    padding: EdgeInsets.all(24),
                    child: Text('No matching Tasks'),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Color _color(String hex) =>
      Color(int.tryParse(hex.replaceFirst('#', 'ff'), radix: 16) ?? 0xffaaaaaa);
}
