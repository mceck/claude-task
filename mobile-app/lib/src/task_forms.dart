import 'package:material_ui/material_ui.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:open_filex/open_filex.dart';

import 'api.dart';
import 'app.dart';
import 'controller.dart';
import 'ui/user_avatar.dart';
import 'models.dart';
import 'uploads.dart';
import 'ui/markdown.dart';
import 'ui/markdown_editor.dart';
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

/// Signal bars like the web board (`PRIORITY_STYLE`).
IconData priorityIcon(String p) => switch (p) {
  'urgent' => Icons.error_outline_rounded,
  'high' => Icons.signal_cellular_alt_rounded,
  'normal' => Icons.signal_cellular_alt_2_bar_rounded,
  'low' => Icons.signal_cellular_alt_1_bar_rounded,
  _ => Icons.remove_rounded,
};

Color priorityColor(String p) => switch (p) {
  'urgent' => Palette.danger,
  'high' => Palette.orange,
  'normal' => Palette.info,
  'low' => Palette.fgMuted,
  _ => Palette.fgSubtle,
};

/// The Tag's own color, as set on the web.
Color tagColor(Tag tag) =>
    tag.color == null ? tint(tag.name) : hexColor(tag.color!, tint(tag.name));

Widget agentAvatar(TaskApi? api, Agent? agent, {double size = 28}) =>
    agent == null
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
    : UserAvatar(
        label: agent.name,
        emoji: agent.emoji,
        imageUrl: agent.avatarImageUrl,
        api: api,
        size: size,
        circle: false,
      );

Future<String?> _pickAgent(
  BuildContext context,
  TaskApi? api,
  List<Agent> agents,
  String selected,
) => showPicker<String>(
  context,
  title: 'Agent',
  selected: selected,
  options: [
    PickerOption('', 'No Agent', leading: agentAvatar(api, null)),
    for (final a in agents)
      PickerOption(
        a.id,
        a.name,
        detail: a.enabled ? null : 'Disabled',
        leading: agentAvatar(api, a),
      ),
  ],
);

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
    maxWidth: 680,
    builder: (sheet) => StatefulBuilder(
      builder: (context, set) {
        final agent = agents.byId(agentId);
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
                    child: Notice.error(error!),
                  ),
                LabeledField(
                  label: 'Title',
                  child: TextFormField(
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
                ),
                LabeledField(
                  label: 'Description',
                  hint: 'Markdown',
                  child: MarkdownEditor(
                    controller: description,
                    enabled: !saving,
                  ),
                ),
                LabeledField(
                  label: 'Agent',
                  hint: 'optional',
                  description: agent == null
                      ? null
                      : 'The Agent starts working on your first Comment.',
                  child: SelectField(
                    key: const Key('new-task-agent'),
                    leading: agentAvatar(c.api, agent, size: 26),
                    label: agent?.name ?? 'No Agent',
                    placeholder: agent == null,
                    onTap: saving
                        ? null
                        : () async {
                            final picked = await _pickAgent(
                              context,
                              c.api,
                              agents,
                              agentId,
                            );
                            if (picked != null) set(() => agentId = picked);
                          },
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
    final status = c.statuses.byId(t.statusId);
    final agent = c.agents.byId(t.agentId);
    final tags = c.tags.where((l) => t.tagIds.contains(l.id)).toList();
    final assignees = c.users.where((u) => t.assigneeIds.contains(u.id));
    final edit = c.online ? () => showEditTask(context, c) : null;
    // The sheet or pane already animates in: sections stay put.
    Widget section(int index, Widget child) => child;
    final editAction = IconAction(
      icon: Icons.edit_outlined,
      tooltip: 'Edit Task',
      onPressed: edit,
    );
    final closedStatus = c.statuses
        .where((s) => s.category == 'closed')
        .firstOrNull;
    final closeAction = closedStatus == null || status?.category == 'closed'
        ? null
        : IconAction(
            icon: Icons.check_circle_outline_rounded,
            tooltip: 'Close Task',
            hoverColor: Palette.success,
            onPressed: c.online
                ? () => confirmCloseTask(context, c, closedStatus)
                : null,
          );
    final body = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        section(
          0,
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(
                    c.project?.name ?? '',
                    style: const TextStyle(
                      fontSize: 12,
                      color: Palette.fgSubtle,
                    ),
                  ),
                  const Padding(
                    padding: EdgeInsets.symmetric(horizontal: 6),
                    child: Text(
                      '/',
                      style: TextStyle(fontSize: 12, color: Palette.fgSubtle),
                    ),
                  ),
                  SelectableText(
                    t.key,
                    style: const TextStyle(
                      fontFamily: mono,
                      fontSize: 12,
                      fontWeight: FontWeight.w500,
                      color: Palette.primarySoft,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(t.title, style: Theme.of(context).textTheme.titleLarge),
            ],
          ),
        ),
        const SizedBox(height: 18),
        section(
          1,
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
                      StatusDot(color: hexColor(status?.color ?? '#888888')),
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
                                  leading: StatusDot(color: hexColor(s.color)),
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
                        agentAvatar(c.api, agent, size: 20),
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
                            c.api,
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
                _Property(
                  label: 'Assignees',
                  icon: Icons.person_outline_rounded,
                  value: assignees.isEmpty
                      ? const Text(
                          'Unassigned',
                          style: TextStyle(color: Palette.fgSubtle),
                        )
                      : Wrap(
                          spacing: 10,
                          runSpacing: 6,
                          children: [
                            for (final user in assignees)
                              Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  UserAvatar(
                                    label: user.displayName,
                                    userId: user.id,
                                    imageUrl: user.avatarImageUrl,
                                    api: c.api,
                                    size: 20,
                                  ),
                                  const SizedBox(width: 6),
                                  Text(user.displayName),
                                ],
                              ),
                          ],
                        ),
                  onTap: c.online
                      ? () => _pickInline(
                          context,
                          c,
                          field: 'assigneeIds',
                          title: 'Assignees',
                          current: t.assigneeIds,
                          empty: 'No Users to assign.',
                          options: [
                            for (final u in c.users)
                              if (u.active || t.assigneeIds.contains(u.id))
                                PickerOption(
                                  u.id,
                                  u.displayName,
                                  leading: UserAvatar(
                                    label: u.displayName,
                                    userId: u.id,
                                    imageUrl: u.avatarImageUrl,
                                    api: c.api,
                                    size: 24,
                                  ),
                                ),
                          ],
                        )
                      : null,
                ),
                _Property(
                  label: 'Tags',
                  icon: Icons.sell_outlined,
                  value: tags.isEmpty
                      ? const Text(
                          'No tags',
                          style: TextStyle(color: Palette.fgSubtle),
                        )
                      : Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: [for (final tag in tags) TagChip(tag: tag)],
                        ),
                  onTap: c.online
                      ? () => _pickInline(
                          context,
                          c,
                          field: 'tagIds',
                          title: 'Tags',
                          current: t.tagIds,
                          empty:
                              'This Project has no Tags yet. Type a name to create one.',
                          createNoun: 'tag',
                          onCreate: (name) async {
                            final tag = await c.createTag(name);
                            return PickerOption(
                              tag.id,
                              tag.name,
                              leading: Dot(color: tagColor(tag), size: 9),
                            );
                          },
                          options: [
                            for (final tag in c.tags)
                              PickerOption(
                                tag.id,
                                tag.name,
                                leading: Dot(color: tagColor(tag), size: 9),
                              ),
                          ],
                        )
                      : null,
                ),
              ],
            ),
          ),
        ),
        if (t.branchName != null || t.pullRequestUrl != null) ...[
          const SizedBox(height: 22),
          section(
            2,
            Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                const SectionLabel('Code'),
                if (t.branchName != null)
                  AppTile(
                    leading: const IconBadge(
                      Icons.account_tree_outlined,
                      color: Palette.primarySoft,
                      size: 28,
                    ),
                    title: t.branchName!,
                    monospace: true,
                    trailing: externalMark,
                    onTap: () => openLink(t.branchUrl),
                  ),
                if (t.pullRequestUrl != null)
                  AppTile(
                    leading: const IconBadge(
                      Icons.merge_rounded,
                      color: Palette.success,
                      size: 28,
                    ),
                    title: 'Open Pull Request',
                    trailing: externalMark,
                    onTap: () => openLink(t.pullRequestUrl),
                  ),
                if (t.canMergePullRequest && edit != null)
                  AppButton(
                    label: 'Merge ${t.pullRequestNoun}',
                    icon: Icons.merge_rounded,
                    tone: Tone.ghost,
                    onPressed: () =>
                        confirmMergePullRequest(context, controller),
                  ),
              ],
            ),
          ),
        ],
        const SizedBox(height: 22),
        section(
          3,
          Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              SectionLabel(
                'Description',
                trailing: edit == null
                    ? null
                    : AppButton(
                        label: 'Edit',
                        icon: Icons.edit_outlined,
                        tone: Tone.ghost,
                        compact: true,
                        onPressed: edit,
                      ),
              ),
              Container(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 14),
                decoration: BoxDecoration(
                  color: Palette.surface.withValues(alpha: .6),
                  borderRadius: BorderRadius.circular(Radii.lg),
                  border: Border.all(color: Palette.border),
                ),
                child: t.description.isEmpty
                    ? const Text(
                        'No description yet.',
                        style: TextStyle(
                          color: Palette.fgSubtle,
                          fontStyle: FontStyle.italic,
                        ),
                      )
                    : Md(
                        t.description,
                        onLink: openLink,
                        onAttachment: (url, filename) =>
                            perform(context, () async {
                              final file = await controller.downloadAttachment({
                                'id': Uri.parse(url).pathSegments.last,
                                'filename': filename,
                                'url': url,
                              });
                              await OpenFilex.open(file.path);
                            }),
                      ),
              ),
            ],
          ),
        ),
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
    );
    if (inSheet) {
      return SheetScaffold(
        title: 'Task details',
        headerActions: [?closeAction, editAction],
        body: body,
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PageHeader(title: 'Task details', actions: [?closeAction, editAction]),
        Expanded(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(Space.page, 16, Space.page, 28),
            child: body,
          ),
        ),
      ],
    );
  }
}

/// Changes one multi-value field of the open Task from a picker, saving it
/// right away when the selection changed.
Future<void> _pickInline(
  BuildContext context,
  TaskController c, {
  required String field,
  required String title,
  required List<String> current,
  required List<PickerOption<String>> options,
  required String empty,
  Future<PickerOption<String>> Function(String name)? onCreate,
  String createNoun = 'option',
}) async {
  final chosen = await showMultiPicker<String>(
    context,
    title: title,
    options: options,
    selected: current.toSet(),
    empty: empty,
    onCreate: onCreate,
    createNoun: createNoun,
  );
  if (chosen == null || !context.mounted) return;
  if (chosen.length == current.length && chosen.containsAll(current)) return;
  await perform(context, () => c.updateTask({field: chosen.toList()}));
}

/// A Tag as a rounded chip with its color dot, like the web `TagChip`.
class TagChip extends StatelessWidget {
  final Tag tag;
  final bool dense;
  const TagChip({super.key, required this.tag, this.dense = false});
  @override
  Widget build(BuildContext context) => Container(
    padding: EdgeInsets.symmetric(horizontal: dense ? 6 : 8, vertical: 2),
    decoration: BoxDecoration(
      borderRadius: BorderRadius.circular(99),
      border: Border.all(color: Palette.borderStrong),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Dot(color: tagColor(tag), size: 6),
        const SizedBox(width: 5),
        Text(
          tag.name,
          style: TextStyle(
            fontSize: dense ? 10.5 : 11.5,
            fontWeight: FontWeight.w500,
            color: Palette.fg.withValues(alpha: .82),
            height: 1.4,
          ),
        ),
      ],
    ),
  );
}

/// A Status color with a soft halo, like the web `StatusDot`.
class StatusDot extends StatelessWidget {
  final Color color;
  final double size;
  const StatusDot({super.key, required this.color, this.size = 9});
  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(
      color: color,
      shape: BoxShape.circle,
      boxShadow: [
        BoxShadow(color: color.withValues(alpha: .25), spreadRadius: 2.5),
      ],
    ),
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
          width: 80,
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

Future<void> showEditTask(BuildContext context, TaskController c) async {
  final task = c.task!,
      title = TextEditingController(text: c.task!.title),
      description = TextEditingController(text: c.task!.description);
  bool saving = false, uploading = false;
  String? error;
  await showAppSheet<void>(
    context,
    maxWidth: 680,
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
                child: Notice.error(error!),
              ),
            LabeledField(
              label: 'Title',
              child: TextField(
                controller: title,
                maxLength: 500,
                decoration: const InputDecoration(counterText: ''),
                onChanged: (_) => set(() {}),
              ),
            ),
            LabeledField(
              label: 'Description',
              hint: 'Markdown',
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  AppButton(
                    label: 'Upload images or files',
                    icon: Icons.attach_file_rounded,
                    tone: Tone.secondary,
                    busy: uploading,
                    onPressed: saving || uploading || !c.online
                        ? null
                        : () async {
                            set(() => error = null);
                            try {
                              final files = await pickAppAttachments(sheet);
                              if (files.isEmpty || !sheet.mounted) return;
                              set(() => uploading = true);
                              final uploaded = await c.uploadTaskFiles(
                                task.id,
                                files,
                              );
                              if (!sheet.mounted) return;
                              final links = uploaded
                                  .map(attachmentMarkdown)
                                  .join('\n\n');
                              final text = description.text;
                              final selection = description.selection;
                              final start = selection.isValid
                                  ? selection.start
                                  : text.length;
                              final end = selection.isValid
                                  ? selection.end
                                  : text.length;
                              final insertion = '\n\n$links\n\n';
                              description.value = TextEditingValue(
                                text: text.replaceRange(start, end, insertion),
                                selection: TextSelection.collapsed(
                                  offset: start + insertion.length,
                                ),
                              );
                            } catch (e) {
                              if (sheet.mounted) {
                                set(() => error = e.toString());
                              }
                            } finally {
                              if (sheet.mounted) set(() => uploading = false);
                            }
                          },
                  ),
                  const SizedBox(height: 8),
                  MarkdownEditor(
                    controller: description,
                    enabled: !saving && !uploading,
                  ),
                ],
              ),
            ),
          ],
        ),
        actions: [
          AppButton(
            label: 'Cancel',
            tone: Tone.secondary,
            onPressed: saving || uploading ? null : () => Navigator.pop(sheet),
          ),
          AppButton(
            label: 'Save',
            busy: saving,
            onPressed: saving || uploading || title.text.trim().isEmpty
                ? null
                : () async {
                    set(() => saving = true);
                    try {
                      await c.updateTask({
                        'title': title.text.trim(),
                        'description': description.text,
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

Future<void> confirmMergePullRequest(
  BuildContext context,
  TaskController controller,
) async {
  final noun = controller.task!.pullRequestNoun;
  final accepted = await confirm(
    context,
    title: 'Merge $noun?',
    message:
        'It is merged into the base branch with the provider\'s default merge method.',
    confirmLabel: 'Merge',
  );
  if (accepted && context.mounted) {
    await perform(context, controller.mergePullRequest);
  }
}

/// Moves the Task to [closed], ending its Session. Asks first only while the
/// Agent is working, since closing cancels that work.
Future<void> confirmCloseTask(
  BuildContext context,
  TaskController controller,
  TaskStatus closed,
) async {
  final task = controller.task!, session = controller.session;
  final working =
      session?['state'] == 'running' || session?['queuePosition'] != null;
  if (working &&
      !await confirm(
        context,
        title: 'Close ${task.key}?',
        message:
            'The Agent is working on it: closing stops its work and ends the Session. The Task moves to “${closed.name}”.',
        confirmLabel: 'Close Task',
        destructive: false,
      )) {
    return;
  }
  if (context.mounted) {
    await perform(
      context,
      () => controller.updateTask({'statusId': closed.id}),
    );
  }
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
