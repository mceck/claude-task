import 'package:material_ui/material_ui.dart';

import 'app.dart';
import 'controller.dart';
import 'models.dart';
import 'task_forms.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';

class WikiList extends StatelessWidget {
  final TaskController controller;
  const WikiList({super.key, required this.controller});
  @override
  Widget build(BuildContext context) {
    final c = controller;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PageHeader(
          leading: const DrawerBrandMark(),
          title: 'Wiki',
          subtitle:
              '${c.wikis.length} ${c.wikis.length == 1 ? 'wiki' : 'wikis'}',
          actions: [
            IconAction(
              icon: Icons.add_rounded,
              tooltip: 'New wiki',
              filled: true,
              size: 36,
              onPressed: c.online ? () => showWikiForm(context, c) : null,
            ),
          ],
        ),
        Expanded(
          child: c.wikis.isEmpty
              ? EmptyState(
                  icon: Icons.menu_book_outlined,
                  title: 'No Wikis',
                  message:
                      'Create a wiki to work together on your Markdown documentation.',
                  action: AppButton(
                    label: 'New wiki',
                    icon: Icons.add_rounded,
                    onPressed: c.online ? () => showWikiForm(context, c) : null,
                  ),
                )
              : AppRefresh(
                  onRefresh: () => perform(context, c.refresh),
                  child: PageList(
                    children: [
                      for (final wiki in c.wikis)
                        AppTile(
                          key: ValueKey('wiki-row:${wiki.id}'),
                          leading: const IconBadge(
                            Icons.menu_book_outlined,
                            color: Palette.primary,
                          ),
                          title: wiki.name,
                          subtitle: [
                            wiki.repositoryName,
                            if (wiki.description.isNotEmpty) wiki.description,
                          ].join('\n'),
                          subtitleLines: 3,
                          selected: c.wiki?.id == wiki.id,
                          onTap: () => perform(
                            context,
                            () => c.selectWiki(
                              wiki,
                              openLatest: !isCompact(context),
                            ),
                          ),
                        ),
                    ],
                  ),
                ),
        ),
      ],
    );
  }
}

Future<void> showWikiForm(
  BuildContext context,
  TaskController c, {
  Wiki? wiki,
}) => showAppSheet<void>(
  context,
  maxWidth: 580,
  builder: (_) => _WikiForm(controller: c, wiki: wiki),
);

class _WikiForm extends StatefulWidget {
  final TaskController controller;
  final Wiki? wiki;
  const _WikiForm({required this.controller, this.wiki});
  @override
  State<_WikiForm> createState() => _WikiFormState();
}

class _WikiFormState extends State<_WikiForm> {
  late final name = TextEditingController(text: widget.wiki?.name ?? '');
  late final description = TextEditingController(
    text: widget.wiki?.description ?? '',
  );
  final base = TextEditingController();
  late String? agentId = widget.wiki?.agentId;
  List<Json> repositories = [];
  Json? repository;
  String? error;
  bool loading = true, saving = false;
  @override
  void initState() {
    super.initState();
    if (widget.wiki == null) {
      widget.controller
          .wikiRepositories()
          .then((value) {
            if (mounted) {
              setState(() {
                repositories = value;
                loading = false;
              });
            }
          })
          .catchError((Object e) {
            if (mounted) {
              setState(() {
                error = e.toString();
                loading = false;
              });
            }
          });
    } else {
      loading = false;
    }
  }

  @override
  void dispose() {
    name.dispose();
    description.dispose();
    base.dispose();
    super.dispose();
  }

  Future<void> _pickAgent() async {
    final c = widget.controller;
    final selected = await showPicker<String>(
      context,
      title: 'Agent',
      selected: agentId ?? '',
      options: [
        for (final agent in c.agents.where((a) => a.enabled || a.id == agentId))
          PickerOption(
            agent.id,
            agent.name,
            detail: agent.enabled ? null : 'Disabled',
            leading: agentAvatar(c.api, agent),
            trailing: agentStateDot(agent),
          ),
      ],
    );
    if (selected != null && mounted) setState(() => agentId = selected);
  }

  Future<void> _pickRepository() async {
    final selected = await showAppSheet<Json>(
      context,
      maxWidth: 580,
      builder: (sheet) => SheetScaffold(
        title: 'Repository',
        body: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            for (final r in repositories)
              AppTile(
                title: '${r['owner']}/${r['name']}',
                subtitle: r['defaultBranch'] as String?,
                selected: identical(r, repository),
                onTap: () => Navigator.pop(sheet, r),
              ),
          ],
        ),
      ),
    );
    if (selected != null && mounted) {
      setState(() {
        repository = selected;
        base.text = repository!['defaultBranch'] as String? ?? '';
      });
    }
  }

  Future<void> _save() async {
    setState(() {
      saving = true;
      error = null;
    });
    try {
      await widget.controller.saveWiki({
        'name': name.text.trim(),
        'description': description.text,
        'agentId': agentId,
        if (widget.wiki == null)
          'repository': {
            'connectionId': repository!['connectionId'],
            'providerRepoId': repository!['providerRepoId'],
            if (base.text.trim().isNotEmpty) 'baseBranch': base.text.trim(),
          },
      }, existing: widget.wiki);
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        setState(() {
          error = e.toString();
          saving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.controller, agent = c.agents.byId(agentId);
    return SheetScaffold(
      title: widget.wiki == null ? 'New wiki' : 'Wiki settings',
      subtitle:
          widget.wiki?.repositoryName ??
          'Markdown files and skills in a shared repository',
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          if (error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Notice.error(error!),
            ),
          LabeledField(
            label: 'Name',
            child: TextField(
              controller: name,
              maxLength: 200,
              enabled: !saving,
              decoration: const InputDecoration(counterText: ''),
              onChanged: (_) => setState(() {}),
            ),
          ),
          LabeledField(
            label: 'Description',
            hint: 'optional',
            child: TextField(
              controller: description,
              maxLines: 3,
              enabled: !saving,
            ),
          ),
          LabeledField(
            label: 'Agent',
            child: SelectField(
              key: const Key('wiki-agent'),
              leading: agent == null
                  ? null
                  : agentAvatar(c.api, agent, size: 26),
              label: agent?.name ?? 'Choose an Agent',
              placeholder: agent == null,
              onTap: saving ? null : _pickAgent,
            ),
          ),
          if (widget.wiki == null) ...[
            LabeledField(
              label: 'Repository',
              description: !loading && repositories.isEmpty
                  ? 'Add a Git Connection in Git settings on the web to select a repository.'
                  : null,
              child: loading
                  ? const Center(child: Spinner())
                  : SelectField(
                      label: repository == null
                          ? 'Choose a repository'
                          : '${repository!['owner']}/${repository!['name']}',
                      placeholder: repository == null,
                      onTap: saving || repositories.isEmpty
                          ? null
                          : _pickRepository,
                    ),
            ),
            LabeledField(
              label: 'Base branch',
              child: TextField(controller: base, enabled: !saving),
            ),
          ] else
            Section(
              title: 'Links',
              children: [
                AppTile(
                  leading: const IconBadge(
                    Icons.code_rounded,
                    color: Palette.info,
                  ),
                  title: 'Open repository',
                  trailing: externalMark,
                  onTap: () =>
                      openLink(widget.wiki!.repository['webUrl'] as String?),
                ),
                if (c.task?.branchUrl != null)
                  AppTile(
                    leading: const IconBadge(
                      Icons.account_tree_outlined,
                      color: Palette.primarySoft,
                    ),
                    title: 'Open wiki branch',
                    trailing: externalMark,
                    onTap: () => openLink(c.task!.branchUrl),
                  ),
                if (c.task?.pullRequestUrl != null)
                  AppTile(
                    leading: const IconBadge(
                      Icons.merge_rounded,
                      color: Palette.success,
                    ),
                    title: 'Open review',
                    trailing: externalMark,
                    onTap: () => openLink(c.task!.pullRequestUrl),
                  ),
              ],
            ),
        ],
      ),
      actions: [
        AppButton(
          label: 'Cancel',
          tone: Tone.secondary,
          onPressed: saving ? null : () => Navigator.pop(context),
        ),
        AppButton(
          label: widget.wiki == null ? 'Create wiki' : 'Save wiki',
          busy: saving,
          onPressed:
              saving ||
                  name.text.trim().isEmpty ||
                  agentId == null ||
                  (widget.wiki == null && repository == null)
              ? null
              : _save,
        ),
      ],
    );
  }
}

/// The Chats of the open Wiki, most recently active first.
class ChatList extends StatelessWidget {
  final TaskController controller;
  final VoidCallback? onBack;
  const ChatList({super.key, required this.controller, this.onBack});

  static String when(DateTime value, [DateTime? now]) {
    final d = value.toLocal(), today = (now ?? DateTime.now()).toLocal();
    if (d.year == today.year && d.month == today.month && d.day == today.day) {
      return '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
    }
    const months = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    final date = '${months[d.month - 1]} ${d.day}';
    return d.year == today.year ? date : '$date, ${d.year}';
  }

  @override
  Widget build(BuildContext context) {
    final c = controller, wiki = c.wiki!;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PageHeader(
          onBack: onBack,
          title: wiki.name,
          subtitle: wiki.repositoryName,
          actions: [
            IconAction(
              icon: Icons.add_rounded,
              tooltip: 'New chat',
              filled: true,
              size: 36,
              onPressed: c.online ? () => perform(context, c.newChat) : null,
            ),
          ],
        ),
        Expanded(
          child: c.chats.isEmpty
              ? const EmptyState(
                  icon: Icons.forum_outlined,
                  title: 'No chats yet',
                  message: 'Start a new chat to talk with the wiki\'s Agent.',
                )
              : AppRefresh(
                  onRefresh: () => perform(context, c.refresh),
                  child: PageList(
                    children: [
                      for (final chat in c.chats) _ChatRow(chat, controller: c),
                    ],
                  ),
                ),
        ),
      ],
    );
  }
}

class _ChatRow extends StatelessWidget {
  final WikiChat chat;
  final TaskController controller;
  const _ChatRow(this.chat, {required this.controller});
  @override
  Widget build(BuildContext context) {
    final c = controller, open = c.task?.id == chat.id;
    final unread = open
        ? (c.preferences[chat.id]?.unread ?? chat.unread)
        : chat.unread;
    return AppTile(
      key: ValueKey('chat-row:${chat.id}'),
      leading: chat.running
          ? const SizedBox.square(
              dimension: 32,
              child: Center(child: Spinner(size: 18)),
            )
          : const IconBadge(
              Icons.chat_bubble_outline_rounded,
              color: Palette.primary,
            ),
      title: chat.title,
      subtitle: ChatList.when(chat.lastActivityAt),
      selected: open,
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (unread)
            Container(
              key: ValueKey('chat-unread:${chat.id}'),
              width: 9,
              height: 9,
              margin: const EdgeInsets.only(right: 4),
              decoration: const BoxDecoration(
                color: Palette.primary,
                shape: BoxShape.circle,
              ),
            ),
          Builder(
            builder: (anchor) => IconAction(
              icon: Icons.more_horiz_rounded,
              tooltip: 'Chat actions',
              onPressed: () async {
                final action = await showActions<String>(anchor, [
                  ActionItem(
                    'rename',
                    'Rename',
                    Icons.edit_outlined,
                    enabled: c.online,
                  ),
                  ActionItem(
                    'delete',
                    'Delete chat',
                    Icons.delete_outline_rounded,
                    enabled: c.online,
                    destructive: true,
                  ),
                ], title: chat.title);
                if (action == null || !anchor.mounted) return;
                if (action == 'rename') {
                  await showChatRename(anchor, c, chat);
                } else {
                  await confirmDeleteChat(anchor, c, chat);
                }
              },
            ),
          ),
        ],
      ),
      onTap: () => perform(context, () => c.selectChat(chat)),
    );
  }
}

Future<void> showChatRename(
  BuildContext context,
  TaskController c,
  WikiChat chat,
) => showAppSheet<void>(
  context,
  maxWidth: 480,
  builder: (_) => _RenameChatForm(controller: c, chat: chat),
);

class _RenameChatForm extends StatefulWidget {
  final TaskController controller;
  final WikiChat chat;
  const _RenameChatForm({required this.controller, required this.chat});
  @override
  State<_RenameChatForm> createState() => _RenameChatFormState();
}

class _RenameChatFormState extends State<_RenameChatForm> {
  late final title = TextEditingController(text: widget.chat.title);
  String? error;
  bool saving = false;
  @override
  void dispose() {
    title.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    setState(() {
      saving = true;
      error = null;
    });
    try {
      await widget.controller.renameChat(widget.chat, title.text.trim());
      if (mounted) Navigator.pop(context);
    } catch (e) {
      if (mounted) {
        setState(() {
          error = e.toString();
          saving = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => SheetScaffold(
    title: 'Rename chat',
    body: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 12),
            child: Notice.error(error!),
          ),
        LabeledField(
          label: 'Title',
          child: TextField(
            key: const Key('chat-title'),
            controller: title,
            maxLength: 200,
            enabled: !saving,
            autofocus: true,
            decoration: const InputDecoration(counterText: ''),
            onChanged: (_) => setState(() {}),
            onSubmitted: (_) =>
                title.text.trim().isEmpty || saving ? null : _save(),
          ),
        ),
      ],
    ),
    actions: [
      AppButton(
        label: 'Cancel',
        tone: Tone.secondary,
        onPressed: saving ? null : () => Navigator.pop(context),
      ),
      AppButton(
        label: 'Rename',
        busy: saving,
        onPressed: saving || title.text.trim().isEmpty ? null : _save,
      ),
    ],
  );
}

Future<void> confirmDeleteChat(
  BuildContext context,
  TaskController c,
  WikiChat chat,
) async {
  if (await confirm(
    context,
    title: 'Delete chat?',
    message:
        'Delete this chat and everything in it for everyone. Wiki files are kept.',
    confirmLabel: 'Delete chat',
  )) {
    if (context.mounted) await perform(context, () => c.deleteChat(chat));
  }
}

Future<void> confirmDeleteWiki(BuildContext context, TaskController c) async {
  if (await confirm(
    context,
    title: 'Delete wiki?',
    message:
        'Delete the wiki and its chats from the app. The remote repository is kept.',
    confirmLabel: 'Delete wiki',
  )) {
    if (context.mounted) await perform(context, c.deleteWiki);
  }
}
