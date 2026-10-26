import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'app.dart';
import 'controller.dart';
import 'models.dart';
import 'ui/markdown.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';

Future<void> openLink(String? value) async {
  final uri = value == null ? null : Uri.tryParse(value);
  if (uri != null && ['http', 'https'].contains(uri.scheme)) {
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }
}

const priorities = ['urgent', 'high', 'normal', 'low', 'none'];

String priorityLabel(String p) =>
    p == 'none' ? 'No priority' : '${p[0].toUpperCase()}${p.substring(1)}';

IconData priorityIcon(String p) => switch (p) {
  'urgent' => Icons.priority_high_rounded,
  'high' => Icons.keyboard_double_arrow_up_rounded,
  'normal' => Icons.drag_handle_rounded,
  'low' => Icons.keyboard_arrow_down_rounded,
  _ => Icons.remove_rounded,
};

Color priorityColor(String p) => switch (p) {
  'urgent' => Palette.danger,
  'high' => const Color(0xfff59e0b),
  'normal' => Palette.info,
  'low' => Palette.fgMuted,
  _ => Palette.fgSubtle,
};

Widget _agentAvatar(Agent? agent, {double size = 28}) => agent == null
    ? Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          border: Border.all(color: Palette.borderStrong),
        ),
        child: Icon(
          Icons.block_rounded,
          size: size * .5,
          color: Palette.fgSubtle,
        ),
      )
    : Avatar(label: agent.name, emoji: agent.emoji, size: size);

Future<String?> _pickAgent(
  BuildContext context,
  List<Agent> agents,
  String selected,
) => showPicker<String>(
  context,
  title: 'Agent',
  selected: selected,
  options: [
    PickerOption('', 'No Agent', leading: _agentAvatar(null)),
    for (final a in agents)
      PickerOption(
        a.id,
        a.name,
        detail: a.enabled ? null : 'Disabled',
        leading: _agentAvatar(a),
      ),
  ],
);

/// A tappable field that shows its value and opens a picker.
class _SelectField extends StatelessWidget {
  final Widget leading;
  final String label;
  final VoidCallback? onTap;
  const _SelectField({
    super.key,
    required this.leading,
    required this.label,
    this.onTap,
  });
  @override
  Widget build(BuildContext context) => Pressable(
    onTap: onTap,
    pressedScale: .99,
    color: Palette.surface,
    border: Border.all(color: Palette.border),
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    child: Row(
      children: [
        leading,
        const SizedBox(width: 12),
        Expanded(child: Text(label, style: const TextStyle(fontSize: 14.5))),
        const Icon(Icons.unfold_more_rounded, size: 18),
      ],
    ),
  );
}

Future<void> showCreateTask(BuildContext context, TaskController c) async {
  final title = TextEditingController(), description = TextEditingController();
  String agentId = '';
  bool saving = false;
  String? error;
  final form = GlobalKey<FormState>();
  final agents = c.agents.where((a) => a.enabled).toList();
  await showAppSheet<void>(
    context,
    dismissible: false,
    builder: (sheet) => StatefulBuilder(
      builder: (context, set) {
        final agent = agents.where((a) => a.id == agentId).firstOrNull;
        return SheetScaffold(
          title: 'New Task',
          subtitle: c.project?.name,
          body: Form(
            key: form,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (error != null)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 14),
                    child: Notice(
                      message: error!,
                      color: Palette.danger,
                      icon: Icons.error_outline_rounded,
                    ),
                  ),
                const FieldLabel('Title'),
                TextFormField(
                  key: const Key('new-task-title'),
                  controller: title,
                  autofocus: true,
                  maxLength: 500,
                  textCapitalization: TextCapitalization.sentences,
                  decoration: const InputDecoration(
                    hintText: 'What needs to be done?',
                    counterText: '',
                  ),
                  validator: (v) => v == null || v.trim().isEmpty
                      ? 'Title is required'
                      : null,
                ),
                const SizedBox(height: 16),
                const FieldLabel('Description', hint: 'Markdown'),
                TextField(
                  controller: description,
                  minLines: 3,
                  maxLines: 7,
                  textCapitalization: TextCapitalization.sentences,
                  decoration: const InputDecoration(
                    hintText: 'Add context, acceptance criteria, links…',
                  ),
                ),
                const SizedBox(height: 16),
                const FieldLabel('Agent', hint: 'optional'),
                _SelectField(
                  key: const Key('new-task-agent'),
                  leading: _agentAvatar(agent, size: 26),
                  label: agent?.name ?? 'No Agent',
                  onTap: saving
                      ? null
                      : () async {
                          final picked = await _pickAgent(
                            context,
                            agents,
                            agentId,
                          );
                          if (picked != null) set(() => agentId = picked);
                        },
                ),
                if (agent != null)
                  const Padding(
                    padding: EdgeInsets.only(top: 8, left: 2),
                    child: Text(
                      'The Agent starts working on your first Comment.',
                      style: TextStyle(fontSize: 12.5, color: Palette.fgSubtle),
                    ),
                  ),
              ],
            ),
          ),
          actions: [
            AppButton(
              label: 'Cancel',
              tone: Tone.secondary,
              onPressed: saving ? null : () => Navigator.pop(sheet),
            ),
            AppButton(
              label: agentId.isEmpty ? 'Create Task' : 'Create and assign',
              busy: saving,
              onPressed: () async {
                if (!form.currentState!.validate()) return;
                set(() {
                  saving = true;
                  error = null;
                });
                try {
                  await c.createTask(
                    title: title.text.trim(),
                    description: description.text,
                    agentId: agentId.isEmpty ? null : agentId,
                  );
                  if (sheet.mounted) Navigator.pop(sheet);
                } catch (e) {
                  if (sheet.mounted) {
                    set(() {
                      error = e.toString();
                      saving = false;
                    });
                  }
                }
              },
            ),
          ],
        );
      },
    ),
  );
  // Text fields may still be mounted for the sheet's exit animation.
}

Future<void> showDetails(BuildContext context, TaskController c) =>
    showAppSheet<void>(
      context,
      builder: (context) => AnimatedBuilder(
        animation: c,
        builder: (context, _) => TaskDetails(controller: c, inSheet: true),
      ),
    );

class TaskDetails extends StatelessWidget {
  final TaskController controller;
  final bool inSheet;
  const TaskDetails({
    super.key,
    required this.controller,
    this.inSheet = false,
  });
  @override
  Widget build(BuildContext context) {
    final c = controller, t = controller.task;
    if (t == null) return const SizedBox.shrink();
    final status = c.statuses.where((s) => s.id == t.statusId).firstOrNull;
    final agent = c.agents.where((a) => a.id == t.agentId).firstOrNull;
    final tags = c.tags.where((l) => t.tagIds.contains(l.id)).toList();
    final assignees = c.users.where((u) => t.assigneeIds.contains(u.id));
    return SingleChildScrollView(
      padding: EdgeInsets.fromLTRB(20, inSheet ? 12 : 18, 20, 28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (inSheet && isCompact(context))
            Center(
              child: Container(
                margin: const EdgeInsets.only(bottom: 10),
                width: 38,
                height: 4,
                decoration: BoxDecoration(
                  color: Palette.borderStrong,
                  borderRadius: BorderRadius.circular(4),
                ),
              ),
            ),
          Row(
            children: [
              const Expanded(
                child: Text(
                  'Task details',
                  style: TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: Palette.fgMuted,
                  ),
                ),
              ),
              IconAction(
                icon: Icons.edit_outlined,
                tooltip: 'Edit Task',
                size: 34,
                onPressed: c.online ? () => showEditTask(context, c) : null,
              ),
              if (inSheet)
                IconAction(
                  icon: Icons.close_rounded,
                  tooltip: 'Close',
                  size: 34,
                  onPressed: () => Navigator.maybePop(context),
                ),
            ],
          ),
          const SizedBox(height: 10),
          SelectableText(
            t.key,
            style: const TextStyle(
              fontFamily: mono,
              fontSize: 12.5,
              color: Palette.primarySoft,
            ),
          ),
          const SizedBox(height: 4),
          Text(t.title, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 20),
          Container(
            decoration: BoxDecoration(
              color: Palette.surface,
              borderRadius: BorderRadius.circular(Radii.lg),
              border: Border.all(color: Palette.border),
            ),
            padding: const EdgeInsets.all(4),
            child: Column(
              children: [
                _Property(
                  label: 'Status',
                  icon: Icons.radio_button_checked_rounded,
                  value: Row(
                    children: [
                      Dot(color: hexColor(status?.color ?? '#888888'), size: 9),
                      const SizedBox(width: 8),
                      Flexible(child: Text(status?.name ?? '—')),
                    ],
                  ),
                  onTap: c.online
                      ? () async {
                          final v = await showPicker<String>(
                            context,
                            title: 'Status',
                            selected: t.statusId,
                            options: [
                              for (final s in c.statuses)
                                PickerOption(
                                  s.id,
                                  s.name,
                                  leading: Dot(
                                    color: hexColor(s.color),
                                    size: 10,
                                  ),
                                ),
                            ],
                          );
                          if (v != null && v != t.statusId && context.mounted) {
                            await perform(
                              context,
                              () => c.updateTask({'statusId': v}),
                            );
                          }
                        }
                      : null,
                ),
                _Property(
                  label: 'Priority',
                  icon: Icons.flag_outlined,
                  value: Row(
                    children: [
                      Icon(
                        priorityIcon(t.priority),
                        size: 16,
                        color: priorityColor(t.priority),
                      ),
                      const SizedBox(width: 6),
                      Text(priorityLabel(t.priority)),
                    ],
                  ),
                  onTap: c.online
                      ? () async {
                          final v = await showPicker<String>(
                            context,
                            title: 'Priority',
                            selected: t.priority,
                            options: [
                              for (final p in priorities)
                                PickerOption(
                                  p,
                                  priorityLabel(p),
                                  leading: Icon(
                                    priorityIcon(p),
                                    size: 18,
                                    color: priorityColor(p),
                                  ),
                                ),
                            ],
                          );
                          if (v != null && v != t.priority && context.mounted) {
                            await perform(
                              context,
                              () => c.updateTask({'priority': v}),
                            );
                          }
                        }
                      : null,
                ),
                _Property(
                  label: 'Agent',
                  icon: Icons.smart_toy_outlined,
                  value: Row(
                    children: [
                      if (agent != null) ...[
                        _agentAvatar(agent, size: 20),
                        const SizedBox(width: 8),
                      ],
                      Flexible(
                        child: Text(
                          agent?.name ?? 'No Agent',
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: agent == null ? Palette.fgSubtle : null,
                          ),
                        ),
                      ),
                    ],
                  ),
                  onTap: c.online
                      ? () async {
                          final v = await _pickAgent(
                            context,
                            c.agents,
                            t.agentId ?? '',
                          );
                          if (v != null &&
                              v != (t.agentId ?? '') &&
                              context.mounted) {
                            await perform(
                              context,
                              () => c.updateTask({
                                'agentId': v.isEmpty ? null : v,
                              }),
                            );
                          }
                        }
                      : null,
                ),
              ],
            ),
          ),
          const SizedBox(height: 26),
          const SectionLabel('Description'),
          t.description.isEmpty
              ? const Text(
                  'No description',
                  style: TextStyle(
                    color: Palette.fgSubtle,
                    fontStyle: FontStyle.italic,
                  ),
                )
              : Md(t.description, onLink: openLink),
          const SizedBox(height: 26),
          const SectionLabel('Tags'),
          tags.isEmpty
              ? const _None()
              : Wrap(
                  spacing: 6,
                  runSpacing: 6,
                  children: [
                    for (final tag in tags)
                      Pill(
                        label: tag.name,
                        color: tint(tag.name),
                        leading: Dot(color: tint(tag.name), size: 6),
                      ),
                  ],
                ),
          const SizedBox(height: 22),
          const SectionLabel('User assignees'),
          assignees.isEmpty
              ? const _None()
              : Column(
                  children: [
                    for (final user in assignees)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Row(
                          children: [
                            Avatar(label: user.displayName, size: 26),
                            const SizedBox(width: 10),
                            Text(
                              user.displayName,
                              style: const TextStyle(fontSize: 14),
                            ),
                          ],
                        ),
                      ),
                  ],
                ),
          if (t.branchName != null || t.pullRequestUrl != null) ...[
            const SizedBox(height: 22),
            const SectionLabel('Git'),
            if (t.branchName != null)
              _LinkCard(
                icon: Icons.account_tree_outlined,
                label: t.branchName!,
                monospace: true,
                onTap: () => openLink(t.branchUrl),
              ),
            if (t.pullRequestUrl != null)
              _LinkCard(
                icon: Icons.merge_rounded,
                label: 'Open Pull Request',
                color: Palette.success,
                onTap: () => openLink(t.pullRequestUrl),
              ),
          ],
          const SizedBox(height: 26),
          Row(
            children: [
              const Icon(
                Icons.notifications_none_rounded,
                size: 15,
                color: Palette.fgSubtle,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  c.push.status,
                  style: const TextStyle(fontSize: 12, color: Palette.fgSubtle),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _None extends StatelessWidget {
  const _None();
  @override
  Widget build(BuildContext context) => const Text(
    'None',
    style: TextStyle(color: Palette.fgSubtle, fontSize: 13.5),
  );
}

class _Property extends StatelessWidget {
  final String label;
  final IconData icon;
  final Widget value;
  final VoidCallback? onTap;
  const _Property({
    required this.label,
    required this.icon,
    required this.value,
    this.onTap,
  });
  @override
  Widget build(BuildContext context) => Pressable(
    onTap: onTap,
    pressedScale: .99,
    borderRadius: BorderRadius.circular(Radii.md),
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
    child: Row(
      children: [
        Icon(icon, size: 16, color: Palette.fgSubtle),
        const SizedBox(width: 10),
        SizedBox(
          width: 72,
          child: Text(
            label,
            style: const TextStyle(fontSize: 13, color: Palette.fgMuted),
          ),
        ),
        Expanded(
          child: DefaultTextStyle.merge(
            style: const TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
            child: value,
          ),
        ),
        if (onTap != null)
          const Icon(
            Icons.chevron_right_rounded,
            size: 18,
            color: Palette.fgSubtle,
          ),
      ],
    ),
  );
}

class _LinkCard extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  final bool monospace;
  final Color color;
  const _LinkCard({
    required this.icon,
    required this.label,
    required this.onTap,
    this.monospace = false,
    this.color = Palette.primarySoft,
  });
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 8),
    child: Pressable(
      onTap: onTap,
      color: Palette.surface,
      border: Border.all(color: Palette.border),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 11),
      child: Row(
        children: [
          Icon(icon, size: 17, color: color),
          const SizedBox(width: 10),
          Expanded(
            child: Text(
              label,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                fontSize: 13.5,
                fontFamily: monospace ? mono : null,
              ),
            ),
          ),
          const Icon(
            Icons.open_in_new_rounded,
            size: 15,
            color: Palette.fgSubtle,
          ),
        ],
      ),
    ),
  );
}

Future<void> showEditTask(BuildContext context, TaskController c) async {
  final task = c.task!,
      title = TextEditingController(text: c.task!.title),
      description = TextEditingController(text: c.task!.description);
  final tagIds = task.tagIds.toSet(), assigneeIds = task.assigneeIds.toSet();
  bool saving = false;
  String? error;
  await showAppSheet<void>(
    context,
    builder: (sheet) => StatefulBuilder(
      builder: (context, set) => SheetScaffold(
        title: 'Edit Task',
        subtitle: task.key,
        body: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 14),
                child: Notice(
                  message: error!,
                  color: Palette.danger,
                  icon: Icons.error_outline_rounded,
                ),
              ),
            const FieldLabel('Title'),
            TextField(
              controller: title,
              maxLength: 500,
              decoration: const InputDecoration(counterText: ''),
              onChanged: (_) => set(() {}),
            ),
            const SizedBox(height: 16),
            const FieldLabel('Description', hint: 'Markdown'),
            TextField(controller: description, minLines: 4, maxLines: 10),
            if (c.tags.isNotEmpty) ...[
              const SizedBox(height: 22),
              const SectionLabel('Tags'),
              Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final l in c.tags)
                    ChoiceChipX(
                      label: l.name,
                      leading: Dot(color: tint(l.name), size: 7),
                      selected: tagIds.contains(l.id),
                      onChanged: (v) => set(() {
                        if (v) {
                          tagIds.add(l.id);
                        } else {
                          tagIds.remove(l.id);
                        }
                      }),
                    ),
                ],
              ),
            ],
            const SizedBox(height: 22),
            const SectionLabel('User assignees'),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final u in c.users)
                  ChoiceChipX(
                    label: u.displayName,
                    leading: Avatar(label: u.displayName, size: 18),
                    selected: assigneeIds.contains(u.id),
                    onChanged: (v) => set(() {
                      if (v) {
                        assigneeIds.add(u.id);
                      } else {
                        assigneeIds.remove(u.id);
                      }
                    }),
                  ),
              ],
            ),
          ],
        ),
        actions: [
          AppButton(
            label: 'Cancel',
            tone: Tone.secondary,
            onPressed: saving ? null : () => Navigator.pop(sheet),
          ),
          AppButton(
            label: 'Save',
            busy: saving,
            onPressed: title.text.trim().isEmpty
                ? null
                : () async {
                    set(() => saving = true);
                    try {
                      await c.updateTask({
                        'title': title.text.trim(),
                        'description': description.text,
                        'tagIds': tagIds.toList(),
                        'assigneeIds': assigneeIds.toList(),
                      });
                      if (sheet.mounted) Navigator.pop(sheet);
                    } catch (e) {
                      if (sheet.mounted) {
                        set(() {
                          error =
                              '$e\nRefresh the Task before retrying a conflicting edit.';
                          saving = false;
                        });
                      }
                    }
                  },
          ),
        ],
      ),
    ),
  );
}

Future<void> confirmDeleteTask(
  BuildContext context,
  TaskController controller,
) async {
  final accepted = await confirm(
    context,
    title: 'Delete Task?',
    message: 'This removes the Task and its conversation permanently.',
    confirmLabel: 'Delete',
  );
  if (accepted && context.mounted) {
    await perform(context, controller.deleteTask);
  }
}
