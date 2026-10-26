import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:url_launcher/url_launcher.dart';
import 'app.dart';
import 'controller.dart';

Future<void> openLink(String? value) async {
  final uri = value == null ? null : Uri.tryParse(value);
  if (uri != null && ['http', 'https'].contains(uri.scheme)) {
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }
}

Future<void> showCreateTask(BuildContext context, TaskController c) async {
  final title = TextEditingController(), description = TextEditingController();
  String agentId = '';
  bool saving = false;
  String? error;
  final form = GlobalKey<FormState>();
  await showDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (dialog) => StatefulBuilder(
      builder: (context, set) => AlertDialog(
        title: const Text('Create Task'),
        content: SizedBox(
          width: 480,
          child: Form(
            key: form,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (error != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Text(
                        error!,
                        style: const TextStyle(color: Colors.redAccent),
                      ),
                    ),
                  TextFormField(
                    key: const Key('new-task-title'),
                    controller: title,
                    autofocus: true,
                    maxLength: 500,
                    decoration: const InputDecoration(labelText: 'Title'),
                    validator: (v) => v == null || v.trim().isEmpty
                        ? 'Title is required'
                        : null,
                  ),
                  const SizedBox(height: 12),
                  TextField(
                    controller: description,
                    minLines: 3,
                    maxLines: 7,
                    decoration: const InputDecoration(labelText: 'Description'),
                  ),
                  const SizedBox(height: 16),
                  DropdownButtonFormField<String>(
                    key: const Key('new-task-agent'),
                    initialValue: agentId,
                    decoration: const InputDecoration(
                      labelText: 'Agent (optional)',
                    ),
                    items: [
                      const DropdownMenuItem(
                        value: '',
                        child: Text('No Agent'),
                      ),
                      for (final a in c.agents.where((a) => a.enabled))
                        DropdownMenuItem(
                          value: a.id,
                          child: Text('${a.emoji} ${a.name}'),
                        ),
                    ],
                    onChanged: saving ? null : (v) => set(() => agentId = v!),
                  ),
                ],
              ),
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: saving ? null : () => Navigator.pop(dialog),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: saving
                ? null
                : () async {
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
                      if (dialog.mounted) Navigator.pop(dialog);
                    } catch (e) {
                      if (dialog.mounted) {
                        set(() {
                          error = e.toString();
                          saving = false;
                        });
                      }
                    }
                  },
            child: Text(
              saving
                  ? 'Creating…'
                  : agentId.isEmpty
                  ? 'Create Task'
                  : 'Create and assign',
            ),
          ),
        ],
      ),
    ),
  );
  // Text fields may still be mounted for the dialog's exit animation.
}

Future<void> showDetails(BuildContext context, TaskController c) =>
    showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      builder: (context) => FractionallySizedBox(
        heightFactor: .92,
        child: AnimatedBuilder(
          animation: c,
          builder: (context, _) => TaskDetails(controller: c),
        ),
      ),
    );

class TaskDetails extends StatelessWidget {
  final TaskController controller;
  const TaskDetails({super.key, required this.controller});
  @override
  Widget build(BuildContext context) {
    final c = controller, t = controller.task;
    if (t == null) return const SizedBox.shrink();
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  'Task details',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
              ),
              IconButton(
                tooltip: 'Edit Task',
                onPressed: c.online ? () => showEditTask(context, c) : null,
                icon: const Icon(Icons.edit_outlined),
              ),
            ],
          ),
          const SizedBox(height: 16),
          SelectableText(
            t.key,
            style: const TextStyle(color: Color(0xffb5a9ff)),
          ),
          const SizedBox(height: 6),
          Text(t.title, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 20),
          DropdownButtonFormField<String>(
            key: ValueKey('${t.id}:${t.statusId}'),
            initialValue: t.statusId,
            decoration: const InputDecoration(labelText: 'Status'),
            items: c.statuses
                .map((s) => DropdownMenuItem(value: s.id, child: Text(s.name)))
                .toList(),
            onChanged: c.online
                ? (v) => perform(context, () => c.updateTask({'statusId': v}))
                : null,
          ),
          const SizedBox(height: 16),
          DropdownButtonFormField<String>(
            key: ValueKey('${t.id}:${t.priority}'),
            initialValue: t.priority,
            decoration: const InputDecoration(labelText: 'Priority'),
            items: [
              'urgent',
              'high',
              'normal',
              'low',
              'none',
            ].map((s) => DropdownMenuItem(value: s, child: Text(s))).toList(),
            onChanged: c.online
                ? (v) => perform(context, () => c.updateTask({'priority': v}))
                : null,
          ),
          const SizedBox(height: 16),
          DropdownButtonFormField<String>(
            key: ValueKey('${t.id}:${t.agentId}'),
            initialValue: t.agentId ?? '',
            decoration: const InputDecoration(labelText: 'Agent'),
            items: [
              const DropdownMenuItem(value: '', child: Text('No Agent')),
              for (final a in c.agents)
                DropdownMenuItem(
                  value: a.id,
                  child: Text('${a.emoji} ${a.name}'),
                ),
            ],
            onChanged: c.online
                ? (v) => perform(
                    context,
                    () => c.updateTask({'agentId': v!.isEmpty ? null : v}),
                  )
                : null,
          ),
          const SizedBox(height: 24),
          Text('Description', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 8),
          MarkdownBody(
            data: t.description.isEmpty ? '_No description_' : t.description,
            selectable: true,
            onTapLink: (_, href, _) => openLink(href),
          ),
          const SizedBox(height: 24),
          Text('Tags', style: Theme.of(context).textTheme.titleSmall),
          Wrap(
            spacing: 6,
            children: [
              for (final tag in c.tags.where(
                (l) => t.tagIds.contains(l.id),
              ))
                Chip(label: Text(tag.name)),
            ],
          ),
          const SizedBox(height: 16),
          Text('User assignees', style: Theme.of(context).textTheme.titleSmall),
          Wrap(
            spacing: 6,
            children: [
              for (final user in c.users.where(
                (u) => t.assigneeIds.contains(u.id),
              ))
                Chip(
                  avatar: const Icon(Icons.person_outline, size: 16),
                  label: Text(user.displayName),
                ),
            ],
          ),
          if (t.branchName != null) ...[
            const SizedBox(height: 20),
            TextButton.icon(
              onPressed: () => openLink(t.branchUrl),
              icon: const Icon(Icons.account_tree_outlined),
              label: Text(t.branchName!),
            ),
          ],
          if (t.pullRequestUrl != null)
            TextButton.icon(
              onPressed: () => openLink(t.pullRequestUrl),
              icon: const Icon(Icons.merge_outlined),
              label: const Text('Open Pull Request'),
            ),
          const SizedBox(height: 20),
          Text(c.push.status, style: Theme.of(context).textTheme.bodySmall),
        ],
      ),
    );
  }
}

Future<void> showEditTask(BuildContext context, TaskController c) async {
  final task = c.task!,
      title = TextEditingController(text: c.task!.title),
      description = TextEditingController(text: c.task!.description);
  final tagIds = task.tagIds.toSet(),
      assigneeIds = task.assigneeIds.toSet();
  bool saving = false;
  String? error;
  await showDialog<void>(
    context: context,
    builder: (dialog) => StatefulBuilder(
      builder: (context, set) => AlertDialog(
        title: const Text('Edit Task'),
        content: SizedBox(
          width: 520,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (error != null)
                  Text(error!, style: const TextStyle(color: Colors.redAccent)),
                TextField(
                  controller: title,
                  maxLength: 500,
                  decoration: const InputDecoration(labelText: 'Title'),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: description,
                  minLines: 4,
                  maxLines: 10,
                  decoration: const InputDecoration(labelText: 'Description'),
                ),
                const SizedBox(height: 16),
                const Text('Tags'),
                Wrap(
                  spacing: 6,
                  children: [
                    for (final l in c.tags)
                      FilterChip(
                        label: Text(l.name),
                        selected: tagIds.contains(l.id),
                        onSelected: (v) => set(() {
                          if (v) {
                            tagIds.add(l.id);
                          } else {
                            tagIds.remove(l.id);
                          }
                        }),
                      ),
                  ],
                ),
                const SizedBox(height: 16),
                const Text('User assignees'),
                Wrap(
                  spacing: 6,
                  children: [
                    for (final u in c.users)
                      FilterChip(
                        label: Text(u.displayName),
                        selected: assigneeIds.contains(u.id),
                        onSelected: (v) => set(() {
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
          ),
        ),
        actions: [
          TextButton(
            onPressed: saving ? null : () => Navigator.pop(dialog),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: saving || title.text.trim().isEmpty
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
                      if (dialog.mounted) Navigator.pop(dialog);
                    } catch (e) {
                      if (dialog.mounted) {
                        set(() {
                          error =
                              '$e\nRefresh the Task before retrying a conflicting edit.';
                          saving = false;
                        });
                      }
                    }
                  },
            child: const Text('Save'),
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
  final accepted = await showDialog<bool>(
    context: context,
    builder: (dialog) => AlertDialog(
      title: const Text('Delete Task?'),
      content: const Text(
        'This removes the Task and its conversation permanently.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(dialog, false),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(dialog, true),
          child: const Text('Delete'),
        ),
      ],
    ),
  );
  if (accepted == true && context.mounted) {
    await perform(context, controller.deleteTask);
  }
}
