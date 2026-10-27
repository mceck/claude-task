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
                          onTap: () =>
                              perform(context, () => c.selectWiki(wiki)),
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

Future<void> confirmResetWiki(BuildContext context, TaskController c) async {
  if (await confirm(
    context,
    title: 'Reset chat?',
    message:
        'Delete all messages for everyone and start a fresh agent session. Wiki files are kept.',
    confirmLabel: 'Reset chat',
  )) {
    if (context.mounted) await perform(context, c.resetWiki);
  }
}

Future<void> confirmDeleteWiki(BuildContext context, TaskController c) async {
  if (await confirm(
    context,
    title: 'Delete wiki?',
    message:
        'Delete the wiki and its chat from the app. The remote repository is kept.',
    confirmLabel: 'Delete wiki',
  )) {
    if (context.mounted) await perform(context, c.deleteWiki);
  }
}
